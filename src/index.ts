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
import { startAutoSync } from './services/autosync.js';

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
  if (!match) {
    res.status(401).json(jsonRpcError(-32001, 'Authentification requise (Bearer token).'));
    return;
  }
  const provided = Buffer.from(match[1], 'utf8');
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
  const app = express();
  app.disable('x-powered-by');
  // 'loopback' : ne croire X-Forwarded-For que si la connexion vient de
  // 127.0.0.1 (nginx local) — une requête directe ne peut pas usurper une IP.
  if (config.http.trustProxy) app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '4mb' }));

  // Health check public (utile pour le reverse proxy / monitoring). Pas de secret.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'boxmail-mcp', version: '1.0.0' });
  });

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

      res
        .status(400)
        .json(jsonRpcError(-32000, 'Requête invalide : session inconnue ou init manquant.'));
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
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json(jsonRpcError(-32000, 'Session inconnue ou absente.'));
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
