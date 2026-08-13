import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { buildMcpServer } from './mcp/server.js';
import { imapService } from './services/imap.js';
import { buildAdminRouter } from './server/admin.js';
import { buildAccountingRouter } from './server/accounting.js';
import { startAutoSync } from './services/autosync.js';
import { runCapabilityBackfills } from './services/whatsnew.js';
import { startAutoBackup } from './services/backup.js';
import { startAutoUpdate } from './services/autoupdate.js';
import { ensureMigrationsApplied } from './db/migrate.js';
import { pendingBackfill, runBackfillAllAccounts, repairSnippets } from './services/snippets.js';
import { startJob, hasRunningJob } from './services/jobs.js';
import { existsSync, writeFileSync } from 'node:fs';

/**
 * Reprise du rattrapage des extraits après un redémarrage (C1).
 * Les jobs vivent en mémoire : une mise à jour — donc chaque nuit — tuait un
 * rattrapage de plusieurs heures, en silence. Le marqueur laissé sur disque
 * par la demande de l'utilisateur permet de reprendre là où on s'était arrêté.
 */
function resumeSnippetBackfill(): void {
  const pending = pendingBackfill();
  if (!pending || hasRunningJob('snippets')) return;
  logger.info('reprise du rattrapage des extraits', { scope: pending.scope });
  // Léger décalage : on laisse le serveur finir de se mettre en route.
  const timer = setTimeout(() => {
    startJob('snippets', async (progress, setMeta) => {
      setMeta({ scope: pending.scope, resumed: true });
      progress('Reprise automatique après redémarrage…');
      return runBackfillAllAccounts(pending.scope, progress);
    });
  }, 15_000);
  timer.unref();
}

/**
 * Réparation UNIQUE des extraits mojibake déjà en base (3 617 mesurés le
 * 30/07 : « Ã©chÃ©ance » au lieu de « échéance » — les moteurs ne les
 * lisaient pas). Les NOUVEAUX extraits sont réparés à la capture
 * (cleanSnippet) ; cette passe rattrape le stock. Marqueur sur disque pour ne
 * pas rebalayer ~20 000 lignes à chaque démarrage — la passe étant
 * idempotente, supprimer le marqueur suffit à la relancer.
 */
function repairMojibakeOnce(): void {
  const marker = resolve(process.cwd(), 'data', 'mojibake-repair.done');
  if (existsSync(marker)) return;
  const timer = setTimeout(() => {
    startJob('mojibake', async (progress) => {
      progress('Réparation des extraits illisibles (accents)…');
      const r = await repairSnippets(progress);
      writeFileSync(marker, JSON.stringify({ finishedAt: new Date().toISOString(), ...r }), 'utf8');
      return r;
    });
  }, 30_000);
  timer.unref();
}

/**
 * Bootstrap serveur HTTP + MCP (transport Streamable HTTP).
 *
 * Sécurité en profondeur :
 *  - bearer token statique obligatoire sur /mcp (comparaison à temps constant),
 *  - rate limiting basique par IP,
 *  - écoute par défaut sur 127.0.0.1 (le reverse proxy fait le TLS + HSTS).
 */

// --- Auth : bearer token à temps constant ------------------------------------
const EXPECTED_TOKEN = Buffer.from(config.auth.bearerToken, 'utf8');

function checkBearer(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);

  // Repli : jeton passé dans l'URL (`?token=…`).
  // POURQUOI : les « connecteurs personnalisés » de Claude ne savent envoyer
  // qu'un OAuth (identifiant + secret client) — leurs réglages avancés n'ont
  // aucun champ pour un en-tête Bearer. Sans ce repli, brancher le connecteur
  // imposerait d'implémenter un serveur OAuth complet (constaté le 29/07).
  // La liaison est chiffrée (HTTPS), mais le jeton apparaît dans les logs
  // d'accès nginx du serveur : il se change via MCP_BEARER_TOKEN dans .env.
  const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
  const supplied = match ? match[1] : queryToken;
  if (!supplied) {
    res.status(401).json(jsonRpcError(-32001, 'Authentification requise (Bearer token).'));
    return;
  }
  const provided = Buffer.from(supplied, 'utf8');
  const ok =
    provided.length === EXPECTED_TOKEN.length && timingSafeEqual(provided, EXPECTED_TOKEN);
  if (!ok) {
    res.status(403).json(jsonRpcError(-32003, 'Token invalide.'));
    return;
  }
  next();
}

// --- Rate limiting : fenêtre glissante en mémoire par IP ---------------------
const hits = new Map<string, number[]>();
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const windowStart = now - config.rateLimit.windowMs;
  const arr = (hits.get(ip) ?? []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(ip, arr);
  if (arr.length > config.rateLimit.max) {
    res.status(429).json(jsonRpcError(-32029, 'Trop de requêtes, réessayer plus tard.'));
    return;
  }
  next();
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

// --- Sessions MCP ------------------------------------------------------------
const transports = new Map<string, StreamableHTTPServerTransport>();

async function main() {
  // Migrations de la base AVANT d'ouvrir le service : c'est le seul moment où
  // personne ne tient le fichier SQLite. Une mise à jour qui migrerait pendant
  // que l'app tourne échouerait (« database is locked ») — voir db/migrate.ts.
  try {
    const { applied } = await ensureMigrationsApplied();
    if (applied.length > 0) {
      logger.info('base mise à jour au démarrage', { migrations: applied.length });
    }
  } catch (err) {
    // On démarre quand même : mieux vaut un serveur qui répond et explique le
    // problème (écran 🩺 État du système) qu'une boucle de redémarrages.
    logger.error('migrations au démarrage impossibles', { error: (err as Error).message });
  }

  const app = express();
  app.disable('x-powered-by');
  // 'loopback' : ne croire X-Forwarded-For que si la connexion vient de
  // 127.0.0.1 (nginx local) — une requête directe ne peut pas usurper une IP.
  if (config.http.trustProxy) app.set('trust proxy', 'loopback');
  // Les envois avec pièces jointes (base64) dépassent la limite globale de
  // 4 Mo : limite dédiée sur la SEULE route d'envoi (le contenu est ensuite
  // validé pièce par pièce — 10 Mo/pièce, 15 Mo au total). Le parseur global
  // saute les corps déjà lus.
  app.use(/^\/api\/accounts\/[^/]+\/send$/, express.json({ limit: '30mb' }));
  app.use(express.json({ limit: '4mb' }));

  // Health check public (utile pour le reverse proxy / monitoring). Pas de secret.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'boxmail-mcp', version: '1.0.0' });
  });

  // Connecteur Fiscal-Manager (V1) : 2 GET lecture seule, jeton dédié.
  // Monté AVANT /api : sinon le routeur admin capterait le chemin.
  app.use('/api/v1/accounting-candidates', rateLimit, buildAccountingRouter());

  // Interface web d'administration : API + fichiers statiques.
  app.use('/api', rateLimit, buildAdminRouter());
  app.use('/admin', express.static(resolve(process.cwd(), 'web')));
  app.get('/', (_req, res) => res.redirect('/admin/'));

  app.use('/mcp', rateLimit, checkBearer);

  // POST /mcp : initialisation ou message dans une session existante.
  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
            logger.info('session MCP initialisée', { sessionId: id });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
            logger.info('session MCP fermée', { sessionId: transport.sessionId });
          }
        };
        const server = buildMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // SESSION INCONNUE → 404, ET C'EST IMPORTANT (13/08).
      //
      // On répondait 400 : le client y voit une erreur définitive et abandonne.
      // Résultat, CHAQUE redémarrage du serveur cassait silencieusement les
      // analyses en cours — une session ouverte la veille se retrouvait avec
      // « session inconnue » sur chaque appel, sans moyen de repartir, et le
      // rattrapage s'arrêtait sans que personne ne le voie. Constaté ce matin
      // sur mon propre appel après le déploiement de la nuit.
      //
      // Le protocole prévoit exactement ce cas : 404 sur une session inconnue,
      // et le client relance une initialisation tout seul. C'est la différence
      // entre « ta session est morte, débrouille-toi » et « reconnecte-toi ».
      if (sessionId) {
        logger.info('session MCP inconnue — le client va se réinitialiser', { sessionId });
        res.status(404).json(jsonRpcError(-32001, 'Session inconnue : relance une initialisation.'));
        return;
      }
      res.status(400).json(jsonRpcError(-32000, "Requête invalide : initialisation manquante."));
    } catch (err) {
      logger.error('erreur POST /mcp', { error: (err as Error).message });
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Erreur interne.'));
      }
    }
  });

  // GET /mcp : flux SSE serveur→client pour une session existante.
  const sessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json(jsonRpcError(-32000, 'Session absente.'));
      return;
    }
    if (!transports.has(sessionId)) {
      // Même raison qu'au POST : 404 = « reconnecte-toi », pas « abandonne ».
      res.status(404).json(jsonRpcError(-32001, 'Session inconnue : relance une initialisation.'));
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
  };
  app.get('/mcp', sessionRequest);
  app.delete('/mcp', sessionRequest);

  const httpServer = app.listen(config.http.port, config.http.host, () => {
    logger.info('boxmail-mcp démarré', {
      host: config.http.host,
      port: config.http.port,
      smtpEnabled: config.smtp.enabled,
    });
    startAutoSync();
    startAutoBackup();
    startAutoUpdate();
    resumeSnippetBackfill();
    repairMojibakeOnce();
    // « Quoi de neuf » : rattrapage automatique des nouvelles capacités
    // (interne, réversible, journalisé), puis carte compte-rendu sur la
    // Vue du jour — l'utilisateur n'a jamais à « relancer une analyse ».
    runCapabilityBackfills();
  });

  // Arrêt propre.
  const shutdown = async (signal: string) => {
    logger.info('arrêt en cours', { signal });
    httpServer.close();
    for (const t of transports.values()) {
      try {
        await t.close();
      } catch {
        /* ignore */
      }
    }
    await imapService.closeAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('échec démarrage', { error: (err as Error).message });
  process.exit(1);
});
