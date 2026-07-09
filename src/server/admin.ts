import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { listAccountNames, getAccountRecord, resolveAccount } from '../services/accounts.js';
import { globalOverview, mailboxOverview, senderStatsFromIndex, isFolderIndexed } from '../services/index-stats.js';
import {
  getCleanupCandidates,
  previewSenderCleanup,
  executeSenderCleanup,
} from '../services/cleanup.js';
import { syncAccount } from '../services/sync.js';
import { startJob, getJob, hasRunningJob } from '../services/jobs.js';
import { readOperations } from '../services/oplog.js';
import { db, ensureDbReady } from '../db/client.js';

/**
 * API REST de l'interface web d'administration (/api/*).
 *
 * Sécurité :
 *  - désactivée entièrement si ADMIN_PASSWORD n'est pas configuré ;
 *  - login à comparaison en temps constant, tentatives limitées par IP ;
 *  - session par cookie httpOnly SameSite=Strict (jeton aléatoire en mémoire) ;
 *  - réutilise exactement les mêmes services que les tools MCP.
 */

const SESSION_COOKIE = 'bm_session';
const sessions = new Map<string, number>(); // token -> expiresAt

// Rate limit dédié au login : 10 tentatives / 15 min / IP.
const loginAttempts = new Map<string, number[]>();
function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (loginAttempts.get(ip) ?? []).filter((t) => t > now - 15 * 60_000);
  arr.push(now);
  loginAttempts.set(ip, arr);
  return arr.length > 10;
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionValid(req: Request): boolean {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  // Session glissante.
  sessions.set(token, Date.now() + config.admin.sessionTtlMs);
  return true;
}

function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!sessionValid(req)) {
    res.status(401).json({ error: 'Non authentifié.' });
    return;
  }
  next();
}

export function buildAdminRouter(): Router {
  const router = Router();

  // Si l'interface n'est pas configurée, tout renvoie 503 avec explication.
  if (!config.admin.password) {
    router.use((_req, res) => {
      res.status(503).json({
        error:
          "Interface désactivée : définir ADMIN_PASSWORD dans le .env puis redémarrer le serveur.",
      });
    });
    return router;
  }
  const adminPassword = Buffer.from(config.admin.password, 'utf8');

  // --- Auth ------------------------------------------------------------------
  router.post('/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (loginRateLimited(ip)) {
      res.status(429).json({ error: 'Trop de tentatives, réessayer dans 15 minutes.' });
      return;
    }
    const password = String(req.body?.password ?? '');
    const provided = Buffer.from(password, 'utf8');
    const ok =
      provided.length === adminPassword.length && timingSafeEqual(provided, adminPassword);
    if (!ok) {
      logger.warn('login admin refusé', { ip });
      res.status(403).json({ error: 'Mot de passe incorrect.' });
      return;
    }
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + config.admin.sessionTtlMs);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(
        config.admin.sessionTtlMs / 1000,
      )}`,
    );
    logger.info('login admin réussi', { ip });
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    res.json({ authenticated: sessionValid(req) });
  });

  // Tout le reste exige une session.
  router.use(requireSession);

  const guard =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response): void => {
      fn(req, res).catch((err) => {
        logger.warn('erreur API admin', { path: req.path, error: (err as Error).message });
        if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
      });
    };

  // --- Vue d'ensemble ----------------------------------------------------------
  router.get(
    '/overview',
    guard(async (_req, res) => {
      const enrolled = await listAccountNames();
      const enrolledInfo = [];
      for (const name of enrolled) {
        const rec = await getAccountRecord(name);
        if (rec) enrolledInfo.push({ account: name, username: rec.username });
      }
      let overview: Awaited<ReturnType<typeof globalOverview>> = {
        accounts: [],
        totals: { accounts: 0, indexedMessages: 0, unseenInbox: 0 },
      };
      try {
        await ensureDbReady();
        overview = await globalOverview();
      } catch {
        // Base non migrée : on renvoie une vue vide, le front l'explique.
      }
      const indexed = new Set(overview.accounts.map((a) => a.account));
      res.json({
        ...overview,
        enrolled: enrolledInfo,
        neverSynced: enrolled.filter((n) => !indexed.has(n)),
      });
    }),
  );

  router.get(
    '/accounts/:slug/overview',
    guard(async (req, res) => {
      res.json(await mailboxOverview(req.params.slug));
    }),
  );

  // --- Stats expéditeurs ---------------------------------------------------------
  router.get(
    '/accounts/:slug/stats',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const folder = String(req.query.folder ?? 'INBOX');
      const limit = Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 500);
      const since = req.query.since ? String(req.query.since) : undefined;
      if (!(await isFolderIndexed(slug, folder))) {
        res.status(409).json({
          error: `Le dossier "${folder}" n'est pas encore indexé — lancer une synchronisation.`,
          needsSync: true,
        });
        return;
      }
      const stats = await senderStatsFromIndex(slug, folder, limit, since);
      res.json({ account: slug, folder, ...stats });
    }),
  );

  // --- Dossiers (depuis l'index) ---------------------------------------------
  router.get(
    '/accounts/:slug/folders',
    guard(async (req, res) => {
      await ensureDbReady();
      const folders = await db.folder.findMany({
        where: { accountSlug: req.params.slug },
        orderBy: { path: 'asc' },
        select: {
          path: true,
          role: true,
          messageCount: true,
          unseenCount: true,
          lastSyncedAt: true,
        },
      });
      res.json({ folders });
    }),
  );

  // --- Nettoyage conseillé -----------------------------------------------------
  router.get(
    '/accounts/:slug/cleanup',
    guard(async (req, res) => {
      res.json(await getCleanupCandidates(req.params.slug));
    }),
  );

  // --- Nettoyage : aperçu puis exécution par lots ------------------------------
  router.post(
    '/accounts/:slug/cleanup/preview',
    guard(async (req, res) => {
      const sender = String(req.body?.sender ?? '').trim();
      const folder = String(req.body?.folder ?? 'INBOX');
      if (!sender) {
        res.status(400).json({ error: 'Paramètre "sender" requis.' });
        return;
      }
      res.json(await previewSenderCleanup(req.params.slug, folder, sender));
    }),
  );

  router.post(
    '/accounts/:slug/cleanup/execute',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const sender = String(req.body?.sender ?? '').trim();
      const folder = String(req.body?.folder ?? 'INBOX');
      if (!sender) {
        res.status(400).json({ error: 'Paramètre "sender" requis.' });
        return;
      }
      const kind = `cleanup:${slug}`;
      if (hasRunningJob(kind) || hasRunningJob(`sync:${slug}`)) {
        res.status(409).json({ error: 'Une opération est déjà en cours sur ce compte.' });
        return;
      }
      const rec = await resolveAccount(slug);
      const job = startJob(kind, (progress) =>
        executeSenderCleanup(rec, folder, sender, progress),
      );
      res.json({ jobId: job.id });
    }),
  );

  // --- Synchronisation (job asynchrone) ---------------------------------------
  router.post(
    '/accounts/:slug/sync',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const mode = req.body?.mode === 'full' ? 'full' : 'recent';
      const kind = `sync:${slug}`;
      if (hasRunningJob(kind)) {
        res.status(409).json({ error: 'Une synchronisation est déjà en cours pour ce compte.' });
        return;
      }
      const rec = await resolveAccount(slug);
      const job = startJob(kind, (progress) => syncAccount(rec, { mode, onProgress: progress }));
      res.json({ jobId: job.id });
    }),
  );

  router.get(
    '/jobs/:id',
    guard(async (req, res) => {
      const job = getJob(req.params.id);
      if (!job) {
        res.status(404).json({ error: 'Job inconnu.' });
        return;
      }
      res.json(job);
    }),
  );

  // --- Journal des opérations ---------------------------------------------------
  router.get(
    '/operations',
    guard(async (req, res) => {
      const limit = Math.min(Number.parseInt(String(req.query.limit ?? '30'), 10) || 30, 200);
      res.json({ operations: await readOperations(limit) });
    }),
  );

  return router;
}
