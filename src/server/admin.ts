import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  listAccountNames,
  getAccountRecord,
  resolveAccount,
  upsertAccount,
  renameAccount,
  removeAccount,
} from '../services/accounts.js';
import {
  enrollAccount,
  beginInteractiveEnroll,
  completeInteractiveEnroll,
} from '../services/oauth.js';
import { globalOverview, mailboxOverview, senderStatsFromIndex, isFolderIndexed } from '../services/index-stats.js';
import {
  getCleanupCandidates,
  previewSenderCleanup,
  executeSenderCleanup,
  listCleanupMessages,
} from '../services/cleanup.js';
import { syncAccount } from '../services/sync.js';
import {
  getUnansweredEmails,
  snoozeReply,
  dismissReply,
  restoreReply,
  snoozeFollowup,
  markFollowupDone,
  restoreFollowup,
} from '../services/attention.js';
import { getFollowupsDue } from '../services/followups.js';
import { getImportantEmails } from '../services/importance.js';
import {
  detectDeadlines,
  listDeadlines,
  confirmDeadline,
  dismissDeadline,
  completeDeadline,
  restoreDeadline,
  proposeDeadline,
  extractDeadlines,
  type DeadlineType,
} from '../services/deadlines.js';
import { explainImportance } from '../services/importance.js';
import {
  AUTO_SENDER_RE,
  detectRequestKind,
  stripQuotedText,
  REQUEST_KIND_LABELS,
} from '../services/attention.js';
import {
  searchIndex,
  indexedMessage,
  reflectActionInIndex,
  listFolderMessages,
  listUnifiedInbox,
  UNIFIED_ROLES,
  type UnifiedRole,
  validateUids,
  reflectBulkInIndex,
} from '../services/search.js';
import { generateBrief, latestBrief } from '../services/brief.js';
import {
  listTasks,
  createTask,
  completeTask,
  dismissTask,
  reopenTask,
  taskFromDeadline,
} from '../services/tasks.js';
import { imapService } from '../services/imap.js';
import { buildZip } from '../services/zip.js';
import { toVCard, toOutlookCsv } from '../services/export.js';
import { sendEmail, validateRecipients } from '../services/smtp.js';
import { startJob, getJob, hasRunningJob, listJobs } from '../services/jobs.js';
import { autoSyncStatus, startSyncAllJob } from '../services/autosync.js';
import { autoUpdateStatus } from '../services/autoupdate.js';
import { createBackup, listBackups, backupPath } from '../services/backup.js';
import { getHealth } from '../services/health.js';
import { exportAccounts, importAccounts } from '../services/portability.js';
import {
  listUnsubscribable,
  refreshUnsubscribeLinks,
  unsubscribeSender,
  markUnsubscribed,
} from '../services/unsubscribe.js';
import {
  suggestRules,
  listRules,
  previewRule,
  applyRule,
  updateRule,
  createRule,
  deleteRule,
} from '../services/rules.js';
import {
  categorizeAccount,
  setSenderCategory,
  setSenderPriority,
  SENDER_CATEGORIES,
  SENDER_PRIORITIES,
  MESSAGE_INTENTS,
  MESSAGE_INTENT_LABELS,
  type SenderCategory,
  type SenderPriority,
  type MessageIntent,
} from '../services/categorize.js';
import {
  analysisCoverage,
  requestBackfill,
  runBackfillAllAccounts,
  type BackfillScope,
} from '../services/snippets.js';
import { analysisProgress, analysisProgressByAccount } from '../services/analysis.js';
import { generateToday, listNoiseMessages, type NoiseBucket } from '../services/today.js';
import {
  listPolicies,
  previewPolicy,
  applyPolicy,
  updatePolicy,
} from '../services/retention.js';
import { generateMailboxReport, runGrandMenage } from '../services/report.js';
import { listSuggestions, dismissSuggestion, type DismissalKind } from '../services/learning.js';
import {
  getReviewSample,
  recordFeedback,
  feedbackStats,
  type ReviewEngine,
  type ReviewVerdict,
} from '../services/quality.js';
import { readOperations, recordOperation } from '../services/oplog.js';
import { db, ensureDbReady } from '../db/client.js';
import { version, checkUpdates, applyUpdate } from '../services/update.js';

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
// En prod (PUBLIC_BASE_URL en https), le cookie de session ne circule qu'en
// TLS ; en local (http://localhost) le flag Secure le rendrait inutilisable.
const COOKIE_SECURE = config.admin.publicBaseUrl.startsWith('https') ? '; Secure' : '';
const sessions = new Map<string, number>(); // token -> expiresAt

// PERSISTANCE des sessions (retour utilisateur 02/08 : « à chaque mise à
// jour, il faut que je me réidentifie »). Les sessions vivaient en mémoire :
// chaque redémarrage — donc chaque mise à jour — déconnectait l'utilisateur.
// Elles sont maintenant rechargées au boot depuis data/sessions.json (jetons
// aléatoires + expiration, rien d'autre) et sauvegardées avec un léger
// débounce (la session glissante toucherait le disque à chaque requête sinon).
try {
  const raw = JSON.parse(readFileSync(config.files.sessions, 'utf8')) as Record<string, number>;
  const now = Date.now();
  for (const [token, exp] of Object.entries(raw)) {
    if (typeof exp === 'number' && exp > now) sessions.set(token, exp);
  }
} catch {
  // Premier lancement (ou fichier illisible) : on repart de zéro.
}
let sessionSaveTimer: NodeJS.Timeout | null = null;
function persistSessions(): void {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    try {
      mkdirSync(dirname(config.files.sessions), { recursive: true });
      writeFileSync(config.files.sessions, JSON.stringify(Object.fromEntries(sessions)), {
        mode: 0o600,
      });
    } catch (err) {
      logger.warn('sessions non persistées', { error: (err as Error).message });
    }
  }, 1500);
  // Un débounce encore en vol ne doit pas retenir l'arrêt du processus
  // (l'update fait process.exit 2 s après — le flush passe, puis rien ne bloque).
  sessionSaveTimer.unref?.();
}

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
    if (token) {
      sessions.delete(token);
      persistSessions();
    }
    return false;
  }
  // Session glissante.
  sessions.set(token, Date.now() + config.admin.sessionTtlMs);
  persistSessions();
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
    persistSessions();
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${COOKIE_SECURE}; Max-Age=${Math.floor(
        config.admin.sessionTtlMs / 1000,
      )}`,
    );
    logger.info('login admin réussi', { ip });
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
      sessions.delete(token);
      persistSessions();
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/${COOKIE_SECURE}; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    res.json({ authenticated: sessionValid(req), smtpEnabled: config.smtp.enabled });
  });

  // Retour OAuth de l'enrôlement interactif. Arrive SANS cookie de session
  // (redirection cross-site + SameSite=Strict) : la sécurité repose sur le
  // `state` aléatoire à usage unique, créé par un admin authentifié (TTL 10 min).
  router.get('/enroll/callback', (req, res) => {
    void (async () => {
      const state = String(req.query.state ?? '');
      const code = String(req.query.code ?? '');
      if (req.query.error) {
        popupResult(res, {
          ok: false,
          error: `${req.query.error} — ${req.query.error_description ?? ''}`,
        });
        return;
      }
      if (!state || !code) {
        popupResult(res, { ok: false, error: 'Réponse Microsoft incomplète (state/code).' });
        return;
      }
      try {
        const { account, enrolled } = await completeInteractiveEnroll(state, code);
        let duplicateOf: string | null = null;
        for (const n of await listAccountNames()) {
          if (n === account) continue;
          const r = await getAccountRecord(n);
          if (r && r.username.toLowerCase() === enrolled.username.toLowerCase()) duplicateOf = n;
        }
        await upsertAccount(account, enrolled);
        logger.info('enrôlement interactif réussi', { account, username: enrolled.username });
        popupResult(res, { ok: true, account, username: enrolled.username, duplicateOf });
      } catch (err) {
        popupResult(res, { ok: false, error: (err as Error).message });
      }
    })();
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
      let overview: Awaited<ReturnType<typeof globalOverview>> = {
        accounts: [],
        totals: { accounts: 0, indexedMessages: 0, unseenInbox: 0 },
      };
      const colors = new Map<string, string | null>();
      const orders = new Map<string, number>();
      // Nouveaux mails reçus (INBOX, par date du mail) : aujourd'hui vs hier.
      let newMails = { today: 0, yesterday: 0 };
      try {
        await ensureDbReady();
        overview = await globalOverview();
        for (const a of await db.account.findMany({
          select: { slug: true, color: true, sortOrder: true },
        })) {
          colors.set(a.slug, a.color);
          orders.set(a.slug, a.sortOrder);
        }
        const startToday = new Date();
        startToday.setHours(0, 0, 0, 0);
        const startYesterday = new Date(startToday.getTime() - 86_400_000);
        const inboxWhere = { isDeleted: false, folder: { is: { role: 'inbox' } } };
        newMails = {
          today: await db.message.count({ where: { ...inboxWhere, date: { gte: startToday } } }),
          yesterday: await db.message.count({
            where: { ...inboxWhere, date: { gte: startYesterday, lt: startToday } },
          }),
        };
      } catch {
        // Base non migrée : on renvoie une vue vide, le front l'explique.
      }
      const enrolledInfo = [];
      for (const name of enrolled) {
        const rec = await getAccountRecord(name);
        if (rec)
          enrolledInfo.push({ account: name, username: rec.username, color: colors.get(name) ?? null });
      }
      // Ordre de préférence choisi dans Paramètres (jamais synchronisé = à la fin).
      enrolledInfo.sort(
        (a, b) =>
          (orders.get(a.account) ?? 999) - (orders.get(b.account) ?? 999) ||
          a.account.localeCompare(b.account),
      );
      const indexed = new Set(overview.accounts.map((a) => a.account));
      res.json({
        ...overview,
        enrolled: enrolledInfo,
        neverSynced: enrolled.filter((n) => !indexed.has(n)),
        newMails,
      });
    }),
  );

  // --- Règles de classement (L7) --------------------------------------------------
  // GARDE-FOU : suggestion ≠ application. L'application passe par un aperçu
  // puis une confirmation ; tout déplacement est journalisé.
  router.get(
    '/accounts/:slug/rules',
    guard(async (req, res) => {
      res.json({ rules: await listRules(req.params.slug) });
    }),
  );

  router.post(
    '/accounts/:slug/rules/suggest',
    guard(async (req, res) => {
      res.json(await suggestRules(req.params.slug));
    }),
  );

  router.post(
    '/accounts/:slug/rules',
    guard(async (req, res) => {
      const matchType = String(req.body?.matchType ?? '');
      if (!['sender', 'domain', 'subject'].includes(matchType)) {
        res.status(400).json({ error: 'Type de critère invalide (sender/domain/subject).' });
        return;
      }
      res.json(
        await createRule(req.params.slug, {
          matchType: matchType as 'sender' | 'domain' | 'subject',
          matchValue: String(req.body?.matchValue ?? ''),
          targetFolder: String(req.body?.targetFolder ?? ''),
        }),
      );
    }),
  );

  router.get(
    '/accounts/:slug/rules/:id/preview',
    guard(async (req, res) => {
      res.json(await previewRule(req.params.slug, Number.parseInt(req.params.id, 10)));
    }),
  );

  router.post(
    '/accounts/:slug/rules/:id/apply',
    guard(async (req, res) => {
      const rec = await resolveAccount(req.params.slug);
      res.json(await applyRule(rec, Number.parseInt(req.params.id, 10)));
    }),
  );

  router.patch(
    '/accounts/:slug/rules/:id',
    guard(async (req, res) => {
      const status = ['active', 'paused'].includes(String(req.body?.status ?? ''))
        ? (String(req.body.status) as 'active' | 'paused')
        : undefined;
      res.json(
        await updateRule(req.params.slug, Number.parseInt(req.params.id, 10), {
          status,
          autoApply:
            req.body?.autoApply === undefined ? undefined : Boolean(req.body.autoApply),
          targetFolder:
            req.body?.targetFolder === undefined ? undefined : String(req.body.targetFolder),
        }),
      );
    }),
  );

  router.delete(
    '/accounts/:slug/rules/:id',
    guard(async (req, res) => {
      await deleteRule(req.params.slug, Number.parseInt(req.params.id, 10));
      res.json({ ok: true });
    }),
  );

  // --- Paramètres des comptes (L5.8) --------------------------------------------
  // Couleur d'affichage : hex #rrggbb ou null (= couleur automatique).
  router.patch(
    '/accounts/:slug',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const rec = await getAccountRecord(slug);
      if (!rec) {
        res.status(404).json({ error: `Compte "${slug}" inconnu.` });
        return;
      }
      const raw = req.body?.color;
      const color = raw === null || raw === '' ? null : String(raw).trim().toLowerCase();
      if (color !== null && !/^#[0-9a-f]{6}$/.test(color)) {
        res.status(400).json({ error: 'Couleur invalide — format attendu : #rrggbb.' });
        return;
      }
      await ensureDbReady();
      await db.account.upsert({
        where: { slug },
        create: { slug, emailAddress: rec.username, color },
        update: { color },
      });
      await recordOperation({
        account: slug,
        tool: 'ui_account_color',
        params: { color },
        result: color ? `couleur ${color}` : 'couleur automatique',
      });
      res.json({ ok: true, color });
    }),
  );

  // Ordre d'affichage des comptes (retour utilisateur 01/08) : la liste
  // complète des slugs dans l'ordre voulu — chaque compte reçoit sa position.
  // Toutes les listes (barre latérale, tableaux, sélecteurs) suivent cet ordre.
  router.put(
    '/accounts/order',
    guard(async (req, res) => {
      const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : null;
      if (!order || order.length === 0) {
        res.status(400).json({ error: 'Liste de comptes attendue : { order: ["slug1", …] }.' });
        return;
      }
      await ensureDbReady();
      for (let i = 0; i < order.length; i++) {
        const slug = order[i];
        const rec = await getAccountRecord(slug);
        if (!rec) continue; // slug inconnu : ignoré plutôt que tout refuser
        await db.account.upsert({
          where: { slug },
          create: { slug, emailAddress: rec.username, sortOrder: i },
          update: { sortOrder: i },
        });
      }
      await recordOperation({
        account: '*',
        tool: 'ui_accounts_order',
        params: { order },
        result: `ordre d'affichage : ${order.join(' → ')}`,
      });
      res.json({ ok: true, order });
    }),
  );

  // Relecture du quota à la demande (retour utilisateur 01/08) : va interroger
  // le serveur IMAP MAINTENANT et stocke le résultat — ou la raison de l'échec
  // (quotaNote), pour que « quota inconnu » soit enfin explicable.
  router.post(
    '/accounts/:slug/quota/refresh',
    guard(async (req, res) => {
      const rec = await resolveAccount(req.params.slug);
      let quota: { usedBytes: number; limitBytes: number } | null = null;
      let note: string | null = null;
      try {
        const diag = await imapService.fetchQuotaDiagnostic(rec);
        quota = diag.quota;
        note = diag.note;
      } catch (err) {
        note = `lecture du quota en échec : ${(err as Error).message}`;
      }
      await ensureDbReady();
      await db.account.upsert({
        where: { slug: rec.account },
        create: {
          slug: rec.account,
          emailAddress: rec.username,
          quotaCheckedAt: new Date(),
          quotaNote: note,
          ...(quota
            ? { quotaUsedBytes: BigInt(quota.usedBytes), quotaLimitBytes: BigInt(quota.limitBytes) }
            : {}),
        },
        update: {
          quotaCheckedAt: new Date(),
          quotaNote: note,
          ...(quota
            ? { quotaUsedBytes: BigInt(quota.usedBytes), quotaLimitBytes: BigInt(quota.limitBytes) }
            : {}),
        },
      });
      res.json({
        ok: quota !== null,
        quota,
        note,
        checkedAt: new Date().toISOString(),
      });
    }),
  );

  // Renommage : l'étiquette locale change, le token est conservé. L'index
  // SQLite est un cache reconstructible : on purge l'ancien slug (renommer la
  // clé primaire avec ses relations serait plus fragile que ça ne vaut) et la
  // prochaine sync réindexe sous le nouveau nom. La couleur suit le compte.
  router.post(
    '/accounts/:slug/rename',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const to = String(req.body?.to ?? '').trim();
      if (!/^[a-z0-9][a-z0-9_-]{1,29}$/i.test(to)) {
        res.status(400).json({
          error:
            'Nouveau nom invalide : 2 à 30 caractères, lettres/chiffres/tirets/underscores uniquement.',
        });
        return;
      }
      const rec = await getAccountRecord(slug);
      if (!rec) {
        res.status(404).json({ error: `Compte "${slug}" inconnu.` });
        return;
      }
      await renameAccount(slug, to);
      let colorKept: string | null = null;
      try {
        await ensureDbReady();
        const old = await db.account.findUnique({ where: { slug }, select: { color: true } });
        colorKept = old?.color ?? null;
        await db.account.deleteMany({ where: { slug } });
        await db.account.create({
          data: { slug: to, emailAddress: rec.username, color: colorKept },
        });
      } catch {
        // Base absente / non migrée : rien à purger.
      }
      await recordOperation({
        account: slug,
        tool: 'ui_account_rename',
        params: { to },
        result: `renommé en "${to}" — index purgé, resynchronisation nécessaire`,
      });
      res.json({ ok: true, account: to, needsSync: true });
    }),
  );

  // Suppression : token effacé d'accounts.json + index purgé. Rien n'est touché
  // côté Microsoft — la boîte reste intacte, seul l'accès local est révoqué.
  router.delete(
    '/accounts/:slug',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const rec = await getAccountRecord(slug);
      if (!rec) {
        res.status(404).json({ error: `Compte "${slug}" inconnu.` });
        return;
      }
      await removeAccount(slug);
      try {
        await ensureDbReady();
        await db.account.deleteMany({ where: { slug } });
      } catch {
        // Base absente / non migrée : rien à purger.
      }
      await recordOperation({
        account: slug,
        tool: 'ui_account_remove',
        params: { username: rec.username },
        result: 'compte retiré de Mail Assistant (token effacé, index purgé) — la boîte Microsoft reste intacte',
      });
      res.json({ ok: true });
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

  // --- Accueil « Aujourd'hui » (A2 — Cap V3) --------------------------------------
  router.get(
    '/today',
    guard(async (_req, res) => {
      res.json(await generateToday());
    }),
  );

  // Aperçu EXACT des mails d'un « bruit » (garde-fou : liste avant action —
  // la suppression passe ensuite par les endpoints bulk existants, journalisés).
  router.get(
    '/today/noise/:bucket',
    guard(async (req, res) => {
      try {
        res.json(await listNoiseMessages(req.params.bucket as NoiseBucket));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // --- Mode apprentissage (A6 — Cap V3) --------------------------------------------
  router.get(
    '/suggestions',
    guard(async (_req, res) => {
      res.json(await listSuggestions());
    }),
  );

  // « Ignorer » une suggestion (mémorisé — jamais reproposée). La VALIDATION
  // passe par les endpoints existants (règles L7, rétention A3, priorités A5).
  router.post(
    '/suggestions/dismiss',
    guard(async (req, res) => {
      const kind = String(req.body?.kind ?? '');
      const refKey = String(req.body?.refKey ?? '');
      try {
        await dismissSuggestion(kind as DismissalKind, refKey);
        await recordOperation({
          account: '(global)',
          tool: 'ui_suggestion_dismiss',
          params: { kind, refKey },
          result: 'suggestion ignorée définitivement',
        });
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // --- Contrôle qualité « Vérifier l'analyse » (B2 — Série B) ---------------------
  // Échantillon réel des détections de chaque moteur, à juger par l'utilisateur.
  router.get(
    '/review/sample',
    guard(async (req, res) => {
      const perEngine = Math.min(
        Math.max(Number.parseInt(String(req.query.n ?? '10'), 10) || 10, 1),
        50,
      );
      res.json(await getReviewSample(perEngine));
    }),
  );

  router.get(
    '/review/stats',
    guard(async (_req, res) => {
      res.json({ stats: await feedbackStats() });
    }),
  );

  // Verdict Correct / Incorrect / Ne sais pas (+ raison). Les CORRECTIONS
  // (catégorie, priorité, dismiss) passent par les endpoints existants.
  router.post(
    '/review/feedback',
    guard(async (req, res) => {
      try {
        const r = await recordFeedback({
          engine: String(req.body?.engine ?? '') as ReviewEngine,
          account: String(req.body?.account ?? ''),
          messageId: Number(req.body?.messageId),
          verdict: String(req.body?.verdict ?? '') as ReviewVerdict,
          reason: req.body?.reason ? String(req.body.reason) : null,
          claim: req.body?.claim ? String(req.body.claim) : null,
        });
        await recordOperation({
          account: String(req.body?.account ?? '(global)'),
          tool: 'ui_analysis_feedback',
          params: { engine: r.engine, messageId: r.messageId, verdict: r.verdict },
          items: [{ subject: r.subject, date: null }],
          result: `analyse jugée « ${r.verdict} »`,
        });
        res.json({ ok: true, stats: await feedbackStats() });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // --- « Pourquoi ma boîte est pleine ? » + Grand ménage (A4 — Cap V3) ------------
  router.get(
    '/report',
    guard(async (_req, res) => {
      res.json(await generateMailboxReport());
    }),
  );

  // Grand ménage : applique les stratégies cochées (job — cocher = valider,
  // l'activation de chaque stratégie est persistée, tout est journalisé).
  router.post(
    '/grand-menage',
    guard(async (req, res) => {
      const ids = Array.isArray(req.body?.policyIds)
        ? (req.body.policyIds as unknown[]).map(Number).filter((x) => Number.isInteger(x) && x > 0)
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'Coche au moins une stratégie (policyIds).' });
        return;
      }
      if (hasRunningJob('grand-menage')) {
        res.status(409).json({ error: 'Un grand ménage est déjà en cours.' });
        return;
      }
      const job = startJob('grand-menage', (progress) => runGrandMenage(ids, progress));
      res.status(202).json({ jobId: job.id });
    }),
  );

  // --- Stratégies de rétention (A3 — Cap V3) --------------------------------------
  router.get(
    '/retention',
    guard(async (_req, res) => {
      res.json({ policies: await listPolicies() });
    }),
  );

  router.get(
    '/retention/:id/preview',
    guard(async (req, res) => {
      try {
        res.json(await previewPolicy(Number(req.params.id)));
      } catch (err) {
        res.status(404).json({ error: (err as Error).message });
      }
    }),
  );

  // Application réelle : job asynchrone (peut toucher des milliers de mails),
  // suivi par la pastille d'activité. La stratégie doit être ACTIVÉE.
  router.post(
    '/retention/:id/apply',
    guard(async (req, res) => {
      const id = Number(req.params.id);
      const kind = `retention:${id}`;
      if (hasRunningJob(kind)) {
        res.status(409).json({ error: 'Cette stratégie est déjà en cours d’application.' });
        return;
      }
      try {
        // Vérifie existence + activation AVANT de lancer le job (erreur propre).
        const dry = await applyPolicy(id, { confirm: false });
        const job = startJob(kind, (progress) => applyPolicy(id, { confirm: true, progress }));
        res.status(202).json({ jobId: job.id, matched: dry.matched });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  router.patch(
    '/retention/:id',
    guard(async (req, res) => {
      try {
        const p = await updatePolicy(Number(req.params.id), {
          enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
          autoApply: typeof req.body?.autoApply === 'boolean' ? req.body.autoApply : undefined,
          ageDays: typeof req.body?.ageDays === 'number' ? req.body.ageDays : undefined,
        });
        res.json({ ok: true, policy: { id: p.id, enabled: p.enabled, autoApply: p.autoApply, ageDays: p.ageDays } });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // --- Catégorisation (A1 — Cap V3) ---------------------------------------------
  // Corriger à la main la catégorie (category=null → retour auto) et/ou la
  // priorité par relation (A5 : normal / always_important / never_urgent).
  router.patch(
    '/accounts/:slug/senders',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const hasCategory = 'category' in (req.body ?? {});
      const rawCategory = req.body?.category ?? null;
      const rawPriority = req.body?.priority;
      if (!email) {
        res.status(400).json({ error: 'email requis.' });
        return;
      }
      if (hasCategory && rawCategory !== null && !SENDER_CATEGORIES.includes(rawCategory as SenderCategory)) {
        res.status(400).json({
          error: `Catégorie inconnue. Valeurs possibles : ${SENDER_CATEGORIES.join(', ')} (ou null pour revenir en automatique).`,
        });
        return;
      }
      if (rawPriority !== undefined && !SENDER_PRIORITIES.includes(rawPriority as SenderPriority)) {
        res.status(400).json({
          error: `Priorité inconnue. Valeurs possibles : ${SENDER_PRIORITIES.join(', ')}.`,
        });
        return;
      }
      if (!hasCategory && rawPriority === undefined) {
        res.status(400).json({ error: 'Indiquer category et/ou priority.' });
        return;
      }
      try {
        const out: Record<string, unknown> = { email: email.toLowerCase() };
        if (hasCategory) {
          const result = await setSenderCategory(slug, email, rawCategory as SenderCategory | null);
          Object.assign(out, result);
          await recordOperation({
            account: slug,
            tool: 'ui_sender_category',
            params: { email: result.email, category: result.category, source: result.source },
            result: `catégorie ${result.category} (${result.source})`,
          });
        }
        if (rawPriority !== undefined) {
          const result = await setSenderPriority(slug, email, rawPriority as SenderPriority);
          out.priority = result.priority;
          await recordOperation({
            account: slug,
            tool: 'ui_sender_priority',
            params: { email: result.email, priority: result.priority },
            result: `priorité ${result.priority}`,
          });
        }
        res.json(out);
      } catch (err) {
        res.status(404).json({ error: (err as Error).message });
      }
    }),
  );

  // Backfill : recalcule intentions + catégories de TOUTES les boîtes (job).
  router.post(
    '/categorize',
    guard(async (_req, res) => {
      if (hasRunningJob('categorize')) {
        res.status(409).json({ error: 'Un recalcul des catégories est déjà en cours.' });
        return;
      }
      const job = startJob('categorize', async (progress) => {
        const results: Record<string, unknown> = {};
        for (const name of await listAccountNames()) {
          try {
            results[name] = await categorizeAccount(name, progress);
          } catch (err) {
            results[name] = { error: (err as Error).message };
            progress(`⚠️ ${name} en échec (${(err as Error).message}) — on continue.`);
          }
        }
        return results;
      });
      res.status(202).json({ jobId: job.id });
    }),
  );

  // --- Extraits de texte (C1) --------------------------------------------------

  // Photographie de l'état de l'analyse (C0) : la mesure « avant ».
  router.get(
    '/analysis/coverage',
    guard(async (_req, res) => {
      const [coverage, ai, aiAccounts] = await Promise.all([
        analysisCoverage(),
        analysisProgress(),
        analysisProgressByAccount(),
      ]);
      // État du rattrapage EN COURS : sans ça, l'interface affichait des
      // compteurs figés et rien n'indiquait qu'un travail tournait
      // (retour utilisateur 29/07).
      const last = listJobs(50).find((j) => j.kind === 'snippets');
      const job = last
        ? {
            running: last.status === 'running',
            scope: (last.meta.scope as string | undefined) ?? 'recent',
            startedAt: last.startedAt,
            finishedAt: last.finishedAt,
            status: last.status,
            lastMessage: last.progress[last.progress.length - 1] ?? null,
            error: last.error,
          }
        : null;
      res.json({ ...coverage, ai, aiAccounts, job });
    }),
  );

  // Rattrapage des extraits : relance des lots jusqu'à épuisement (job).
  // scope=all pour toute la boîte, sinon les 3 derniers mois.
  router.post(
    '/snippets/backfill',
    guard(async (req, res) => {
      if (hasRunningJob('snippets')) {
        res.status(409).json({ error: 'Une récupération des extraits est déjà en cours.' });
        return;
      }
      const scope: BackfillScope = req.body?.scope === 'all' ? 'all' : 'recent';
      // Marqueur sur disque AVANT de lancer : si le serveur redémarre au
      // milieu (mise à jour nocturne…), il reprend tout seul au démarrage.
      requestBackfill(scope);
      const job = startJob('snippets', async (progress, setMeta) => {
        setMeta({ scope });
        return runBackfillAllAccounts(scope, progress);
      });
      res.status(202).json({ jobId: job.id });
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

  // --- Réponses en attente (Phase 4) --------------------------------------------
  // Vue globale : agrège tous les comptes enrôlés (les comptes non indexés
  // sont simplement vides). includeHidden=1 pour les onglets Reportés/Ignorés.
  router.get(
    '/attention/replies',
    guard(async (req, res) => {
      const sinceDays = Math.min(
        Math.max(Number.parseInt(String(req.query.sinceDays ?? '60'), 10) || 60, 1),
        365,
      );
      const results = [];
      for (const name of await listAccountNames()) {
        try {
          results.push(
            await getUnansweredEmails(name, { sinceDays, includeHidden: true, limit: 500 }),
          );
        } catch (err) {
          logger.warn('réponses en attente : compte ignoré', {
            account: name,
            error: (err as Error).message,
          });
        }
      }
      res.json({
        sinceDays,
        counts: results.reduce(
          (acc, r) => ({
            active: acc.active + r.counts.active,
            overdue: acc.overdue + r.counts.overdue,
            snoozed: acc.snoozed + r.counts.snoozed,
            dismissed: acc.dismissed + r.counts.dismissed,
          }),
          { active: 0, overdue: 0, snoozed: 0, dismissed: 0 },
        ),
        items: results
          .flatMap((r) => r.items)
          .sort((a, b) => {
            const aActive = a.state === 'active' ? 0 : 1;
            const bActive = b.state === 'active' ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;
            if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
            return new Date(a.date).getTime() - new Date(b.date).getTime();
          }),
      });
    }),
  );

  const threadAction =
    (fn: (account: string, threadId: number, body: unknown) => Promise<unknown>) =>
    guard(async (req: Request, res: Response) => {
      const threadId = Number.parseInt(String(req.params.threadId), 10);
      if (!Number.isInteger(threadId) || threadId <= 0) {
        res.status(400).json({ error: 'threadId invalide.' });
        return;
      }
      res.json(await fn(req.params.slug, threadId, req.body));
    });

  router.post(
    '/accounts/:slug/attention/replies/:threadId/snooze',
    threadAction((account, threadId, body) => {
      const days = Number.parseInt(String((body as { days?: unknown })?.days ?? '3'), 10) || 3;
      return snoozeReply(account, threadId, days);
    }),
  );
  router.post(
    '/accounts/:slug/attention/replies/:threadId/dismiss',
    threadAction((account, threadId) => dismissReply(account, threadId)),
  );
  router.post(
    '/accounts/:slug/attention/replies/:threadId/restore',
    threadAction((account, threadId) => restoreReply(account, threadId)),
  );

  // --- Relances (Phase 4, brique 2) -----------------------------------------------
  router.get(
    '/attention/followups',
    guard(async (req, res) => {
      const sinceDays = Math.min(
        Math.max(Number.parseInt(String(req.query.sinceDays ?? '60'), 10) || 60, 1),
        365,
      );
      const results = [];
      for (const name of await listAccountNames()) {
        try {
          results.push(await getFollowupsDue(name, { sinceDays, includeHidden: true, limit: 500 }));
        } catch (err) {
          logger.warn('relances : compte ignoré', {
            account: name,
            error: (err as Error).message,
          });
        }
      }
      res.json({
        sinceDays,
        counts: results.reduce(
          (acc, r) => ({
            active: acc.active + r.counts.active,
            overdue: acc.overdue + r.counts.overdue,
            snoozed: acc.snoozed + r.counts.snoozed,
            dismissed: acc.dismissed + r.counts.dismissed,
          }),
          { active: 0, overdue: 0, snoozed: 0, dismissed: 0 },
        ),
        items: results
          .flatMap((r) => r.items)
          .sort((a, b) => {
            const aActive = a.state === 'active' ? 0 : 1;
            const bActive = b.state === 'active' ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;
            if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
            return new Date(a.date).getTime() - new Date(b.date).getTime();
          }),
      });
    }),
  );

  router.post(
    '/accounts/:slug/attention/followups/:threadId/snooze',
    threadAction((account, threadId, body) => {
      const days = Number.parseInt(String((body as { days?: unknown })?.days ?? '3'), 10) || 3;
      return snoozeFollowup(account, threadId, days);
    }),
  );
  router.post(
    '/accounts/:slug/attention/followups/:threadId/dismiss',
    threadAction((account, threadId) => markFollowupDone(account, threadId)),
  );
  router.post(
    '/accounts/:slug/attention/followups/:threadId/restore',
    threadAction((account, threadId) => restoreFollowup(account, threadId)),
  );

  // --- Mails importants (Phase 4, brique 3) — lecture seule en v1 ----------------
  router.get(
    '/attention/important',
    guard(async (req, res) => {
      const sinceDays = Math.min(
        Math.max(Number.parseInt(String(req.query.sinceDays ?? '30'), 10) || 30, 1),
        365,
      );
      const minScoreRaw = Number.parseInt(String(req.query.minScore ?? '40'), 10);
      const minScore = Math.min(Math.max(Number.isNaN(minScoreRaw) ? 40 : minScoreRaw, 0), 100);
      const includeRead = ['1', 'true'].includes(String(req.query.includeRead ?? ''));
      const results = [];
      for (const name of await listAccountNames()) {
        try {
          results.push(
            await getImportantEmails(name, { sinceDays, minScore, includeRead, limit: 500 }),
          );
        } catch (err) {
          logger.warn('mails importants : compte ignoré', {
            account: name,
            error: (err as Error).message,
          });
        }
      }
      res.json({
        sinceDays,
        minScore,
        includeRead,
        counts: results.reduce(
          (acc, r) => ({
            high: acc.high + r.counts.high,
            medium: acc.medium + r.counts.medium,
            low: acc.low + r.counts.low,
          }),
          { high: 0, medium: 0, low: 0 },
        ),
        items: results
          .flatMap((r) => r.items)
          .sort(
            (a, b) => b.score - a.score || new Date(b.date).getTime() - new Date(a.date).getTime(),
          ),
      });
    }),
  );

  // --- Échéances (Phase 4, brique 4 — L2) -----------------------------------------
  router.get(
    '/attention/deadlines',
    guard(async (_req, res) => {
      const all = [];
      for (const name of await listAccountNames()) {
        try {
          all.push(...(await listDeadlines(name, { limit: 500 })));
        } catch (err) {
          logger.warn('échéances : compte ignoré', {
            account: name,
            error: (err as Error).message,
          });
        }
      }
      all.sort((a, b) => a.date.localeCompare(b.date));
      const now = Date.now();
      const isFuture = (d: { date: string }) => new Date(d.date).getTime() >= now - 86_400_000;
      res.json({
        counts: {
          proposed: all.filter((d) => d.status === 'proposed' && isFuture(d)).length,
          confirmed: all.filter((d) => d.status === 'confirmed' && isFuture(d)).length,
          past: all.filter((d) => (!isFuture(d) && d.status !== 'dismissed') || d.status === 'done').length,
          dismissed: all.filter((d) => d.status === 'dismissed').length,
        },
        items: all,
      });
    }),
  );

  // Détection (job — la passe deep lit les corps via IMAP, potentiellement longue).
  router.post(
    '/accounts/:slug/deadlines/detect',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const deep = Boolean(req.body?.deep);
      const sinceDays = Math.min(
        Math.max(Number.parseInt(String(req.body?.sinceDays ?? '30'), 10) || 30, 1),
        365,
      );
      const kind = `deadlines:${slug}`;
      if (hasRunningJob(kind)) {
        res.status(409).json({ error: 'Une détection est déjà en cours pour ce compte.' });
        return;
      }
      const rec = await resolveAccount(slug);
      const job = startJob(kind, (progress) =>
        detectDeadlines(rec, { sinceDays, deep, onProgress: progress }),
      );
      res.json({ jobId: job.id });
    }),
  );

  const deadlineAction =
    (fn: (account: string, id: number) => Promise<unknown>) =>
    guard(async (req: Request, res: Response) => {
      const id = Number.parseInt(String(req.params.id), 10);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Identifiant invalide.' });
        return;
      }
      res.json(await fn(req.params.slug, id));
    });

  router.post('/accounts/:slug/deadlines/:id/confirm', deadlineAction(confirmDeadline));
  router.post('/accounts/:slug/deadlines/:id/dismiss', deadlineAction(dismissDeadline));
  router.post('/accounts/:slug/deadlines/:id/done', deadlineAction(completeDeadline));
  router.post('/accounts/:slug/deadlines/:id/restore', deadlineAction(restoreDeadline));
  // Transforme une échéance en tâche (idempotent : réutilise la tâche existante).
  router.post('/accounts/:slug/deadlines/:id/task', deadlineAction(taskFromDeadline));

  // --- Tâches (L5.5) ---------------------------------------------------------------
  router.get(
    '/tasks',
    guard(async (_req, res) => {
      res.json(await listTasks());
    }),
  );

  router.post(
    '/tasks',
    guard(async (req, res) => {
      const title = String(req.body?.title ?? '').trim();
      if (!title) {
        res.status(400).json({ error: 'Le titre est requis.' });
        return;
      }
      let dueDate: Date | null = null;
      if (req.body?.dueDate) {
        dueDate = new Date(String(req.body.dueDate));
        if (Number.isNaN(dueDate.getTime())) {
          res.status(400).json({ error: 'Date invalide.' });
          return;
        }
      }
      const ref = req.body?.messageRef as { folder?: unknown; uid?: unknown } | undefined;
      const messageRef =
        ref && typeof ref.folder === 'string' && Number.isInteger(ref.uid)
          ? { folder: ref.folder, uid: ref.uid as number }
          : null;
      res.json(
        await createTask({
          title,
          notes: typeof req.body?.notes === 'string' ? req.body.notes : undefined,
          dueDate,
          account: typeof req.body?.account === 'string' ? req.body.account : null,
          messageRef,
        }),
      );
    }),
  );

  const taskAction =
    (fn: (id: number) => Promise<unknown>) =>
    guard(async (req: Request, res: Response) => {
      const id = Number.parseInt(String(req.params.id), 10);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Identifiant invalide.' });
        return;
      }
      res.json(await fn(id));
    });

  router.post('/tasks/:id/done', taskAction(completeTask));
  router.post('/tasks/:id/dismiss', taskAction(dismissTask));
  router.post('/tasks/:id/reopen', taskAction(reopenTask));

  // --- Brief quotidien / revue hebdo (L5) -----------------------------------------
  // GET = dernier brief enregistré (aucun calcul — null si jamais généré).
  // POST = régénère (index local, instantané) et archive dans BriefRun.
  router.get(
    '/brief',
    guard(async (req, res) => {
      const type = req.query.type === 'weekly' ? 'weekly' : 'daily';
      res.json({ type, brief: await latestBrief(type) });
    }),
  );

  router.post(
    '/brief/generate',
    guard(async (req, res) => {
      const type = req.body?.type === 'weekly' ? 'weekly' : 'daily';
      res.json({ type, brief: await generateBrief({ type }) });
    }),
  );

  // --- Recherche & lecture (L3) ---------------------------------------------------
  // Recherche dans l'INDEX local (métadonnées uniquement — instantané, aucune
  // connexion IMAP). Tous comptes si `account` absent.
  router.get(
    '/search',
    guard(async (req, res) => {
      const str = (k: string) => {
        const v = String(req.query[k] ?? '').trim();
        return v || undefined;
      };
      const date = (k: string) => {
        const v = str(k);
        if (!v) return undefined;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? undefined : d;
      };
      const result = await searchIndex({
        q: str('q'),
        account: str('account'),
        folder: str('folder'),
        from: str('from'),
        subject: str('subject'),
        since: date('since'),
        before: date('before'),
        unseen: ['1', 'true'].includes(String(req.query.unseen ?? '')),
        withAttachments: ['1', 'true'].includes(String(req.query.attachments ?? '')),
        limit: Number.parseInt(String(req.query.limit ?? '100'), 10) || 100,
      });
      res.json(result);
    }),
  );

  // --- Boîte de réception navigable (L5.2) -----------------------------------------
  // Liste paginée des mails d'un dossier, depuis l'INDEX (instantané).
  // Boîte unifiée (L5.6) : les INBOX de tous les comptes en un seul flux.
  router.get(
    '/messages',
    guard(async (req, res) => {
      const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
      const limit = Math.min(
        Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
        200,
      );
      const unseen = ['1', 'true'].includes(String(req.query.unseen ?? ''));
      const withAttachments = ['1', 'true'].includes(String(req.query.attachments ?? ''));
      const sort = ['date', 'from', 'subject'].includes(String(req.query.sort ?? ''))
        ? (String(req.query.sort) as 'date' | 'from' | 'subject')
        : undefined;
      const dir = String(req.query.dir ?? '') === 'asc' ? ('asc' as const) : ('desc' as const);
      const role = (UNIFIED_ROLES as readonly string[]).includes(String(req.query.role ?? ''))
        ? (String(req.query.role) as UnifiedRole)
        : undefined;
      const q = String(req.query.q ?? '').slice(0, 200);
      res.json(await listUnifiedInbox({ offset, limit, unseen, withAttachments, sort, dir, role, q }));
    }),
  );

  router.get(
    '/accounts/:slug/messages',
    guard(async (req, res) => {
      const folder = String(req.query.folder ?? 'INBOX');
      const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
      const limit = Math.min(
        Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
        200,
      );
      const unseen = ['1', 'true'].includes(String(req.query.unseen ?? ''));
      if (!(await isFolderIndexed(req.params.slug, folder))) {
        res.status(409).json({
          error: `Le dossier "${folder}" n'est pas encore indexé — lancer une synchronisation.`,
          needsSync: true,
        });
        return;
      }
      const withAttachments = ['1', 'true'].includes(String(req.query.attachments ?? ''));
      const sort = ['date', 'from', 'subject'].includes(String(req.query.sort ?? ''))
        ? (String(req.query.sort) as 'date' | 'from' | 'subject')
        : undefined;
      const dir = String(req.query.dir ?? '') === 'asc' ? ('asc' as const) : ('desc' as const);
      const q = String(req.query.q ?? '').slice(0, 200);
      res.json(
        await listFolderMessages(req.params.slug, folder, {
          offset,
          limit,
          unseen,
          withAttachments,
          sort,
          dir,
          q,
        }),
      );
    }),
  );

  // Actions en masse sur une sélection : corbeille (soft), déplacer, lu/non lu.
  // UIDs revalidés contre l'index, exécution par lots de 200, UNE entrée de
  // journal par opération avec la liste exacte des mails.
  router.post(
    '/accounts/:slug/messages/bulk',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const folder = String(req.body?.folder ?? '').trim();
      const action = String(req.body?.action ?? '');
      const destination = String(req.body?.destination ?? '').trim();
      const rawUids = Array.isArray(req.body?.uids)
        ? (req.body.uids as unknown[])
            .filter((n): n is number => Number.isInteger(n) && (n as number) > 0)
            .slice(0, 20_000)
        : [];
      if (!folder || rawUids.length === 0) {
        res.status(400).json({ error: 'Paramètres "folder" et "uids" requis.' });
        return;
      }
      if (!['delete', 'move', 'seen', 'unseen'].includes(action)) {
        res.status(400).json({ error: `Action inconnue : "${action}".` });
        return;
      }
      if (action === 'move' && !destination) {
        res.status(400).json({ error: 'Destination requise pour un déplacement.' });
        return;
      }
      const { uids, items } = await validateUids(slug, folder, rawUids);
      if (uids.length === 0) {
        res.status(404).json({ error: 'Aucun des mails sélectionnés n\'est dans l\'index — resynchronise.' });
        return;
      }
      const rec = await resolveAccount(slug);

      let result: Record<string, unknown>;
      let destinationUsed = destination;
      if (action === 'seen' || action === 'unseen') {
        // Marquage : une seule commande IMAP suffit (pas de déplacement).
        const add = action === 'seen' ? ['\\Seen'] : [];
        const remove = action === 'unseen' ? ['\\Seen'] : [];
        let affected = 0;
        for (let i = 0; i < uids.length; i += 200) {
          const r = await imapService.markEmails(rec, folder, uids.slice(i, i + 200), add, remove);
          affected += r.affected;
        }
        result = { affected, flag: action };
      } else {
        let moved = 0;
        let batches = 0;
        for (let i = 0; i < uids.length; i += 200) {
          const batch = uids.slice(i, i + 200);
          const r =
            action === 'delete'
              ? await imapService.moveToTrash(rec, folder, batch)
              : await imapService.moveEmails(rec, folder, batch, destination);
          moved += r.moved;
          if ('destination' in r) destinationUsed = r.destination;
          batches++;
        }
        result = { moved, batches, destination: destinationUsed };
      }

      await recordOperation({
        account: rec.account,
        tool:
          action === 'delete' ? 'ui_bulk_delete'
          : action === 'move' ? 'ui_bulk_move'
          : 'ui_bulk_mark',
        folder,
        params: { count: uids.length, action, ...(destinationUsed ? { destination: destinationUsed } : {}) },
        affectedUids: uids,
        // Marquer lu/non-lu laisse les mails à leur place : on garde le dossier
        // et l'UID pour pouvoir les rouvrir depuis le journal. Supprimer ou
        // déplacer les fait changer d'endroit : on n'écrit que sujet + date,
        // sinon le journal proposerait des liens morts.
        items:
          action === 'seen' || action === 'unseen'
            ? items.slice(0, 500).map((i) => ({ ...i, folder }))
            : items.slice(0, 500).map(({ subject, date }) => ({ subject, date })),
        result:
          action === 'delete' ? `soft-deleted ${uids.length} -> ${destinationUsed}`
          : action === 'move' ? `moved ${uids.length} -> ${destinationUsed}`
          : `flagged ${uids.length} ${action}`,
      });
      await reflectBulkInIndex(slug, folder, uids, action as 'delete' | 'move' | 'seen' | 'unseen');
      res.json({ ok: true, action, count: uids.length, skipped: rawUids.length - uids.length, ...result });
    }),
  );

  // Corps d'un mail : lecture IMAP live (texte + pièces jointes listées).
  // Ça ne marche que là où la boîte est joignable (chez l'utilisateur) — en cas
  // d'échec, l'erreur est renvoyée telle quelle et affichée proprement.
  router.get(
    '/accounts/:slug/messages/:folder/:uid',
    guard(async (req, res) => {
      const uid = Number.parseInt(String(req.params.uid), 10);
      if (!Number.isInteger(uid) || uid <= 0) {
        res.status(400).json({ error: 'UID invalide.' });
        return;
      }
      const folder = String(req.params.folder);
      const rec = await resolveAccount(req.params.slug);
      try {
        const body = await imapService.readEmail(rec, folder, uid);
        // Le FETCH du corps marque le mail \Seen côté serveur : l'index suit.
        await reflectActionInIndex(rec.account, folder, uid, 'seen').catch(() => {});
        res.json({ account: rec.account, folder, ...body });
        return;
      } catch (err) {
        // AUTO-RÉPARATION (01/08) : l'UID de l'index peut être périmé (mail
        // déplacé, re-rangé, resynchronisé). Avant d'abandonner, on cherche le
        // MÊME mail (Message-ID identique) ailleurs dans l'index et on retente
        // là-bas — l'utilisateur lit son mail au lieu d'une erreur technique.
        try {
          await ensureDbReady();
          const orig = await db.message.findFirst({
            where: { accountSlug: rec.account, uid, folder: { is: { path: folder } } },
            select: { id: true, internetMessageId: true },
          });
          if (orig?.internetMessageId) {
            const twins = await db.message.findMany({
              where: {
                accountSlug: rec.account,
                internetMessageId: orig.internetMessageId,
                isDeleted: false,
                NOT: { id: orig.id },
              },
              orderBy: { date: 'desc' },
              take: 5,
              select: { uid: true, folder: { select: { path: true } } },
            });
            for (const t of twins) {
              try {
                const body = await imapService.readEmail(rec, t.folder.path, t.uid);
                await reflectActionInIndex(rec.account, t.folder.path, t.uid, 'seen').catch(() => {});
                // L'ancienne ligne pointe dans le vide : on la retire de
                // l'index pour ne plus proposer un emplacement mort.
                await db.message
                  .update({ where: { id: orig.id }, data: { isDeleted: true } })
                  .catch(() => {});
                res.json({ account: rec.account, folder: t.folder.path, relocated: true, ...body });
                return;
              } catch {
                // Cet emplacement-là non plus — on essaie le suivant.
              }
            }
          }
        } catch {
          // Index indisponible : on retombe sur le message d'erreur classique.
        }
        res.status(502).json({
          error:
            `Lecture impossible depuis la boîte : ${(err as Error).message}. ` +
            'Si le mail existe toujours dans Outlook, une synchronisation de la boîte ' +
            'remettra l\'index d\'aplomb.',
        });
      }
    }),
  );

  // Téléchargement d'UNE pièce jointe (L5.9). `index` = position dans la liste
  // renvoyée par la lecture du mail (même parseur, même ordre). Lecture seule —
  // pas de journalisation. Cap : mails > 25 Mo refusés (limite de confort).
  router.get(
    '/accounts/:slug/messages/:folder/:uid/attachments/:index',
    guard(async (req, res) => {
      const uid = Number.parseInt(String(req.params.uid), 10);
      const index = Number.parseInt(String(req.params.index), 10);
      if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(index) || index < 0) {
        res.status(400).json({ error: 'UID ou index de pièce jointe invalide.' });
        return;
      }
      const folder = String(req.params.folder);
      const slug = req.params.slug;
      const meta = await indexedMessage(slug, folder, uid);
      if (!meta) {
        res.status(404).json({ error: "Mail introuvable dans l'index — resynchronise la boîte." });
        return;
      }
      const MAX_ATTACHMENT_MAIL_BYTES = 25 * 1024 * 1024;
      if (meta.sizeBytes > MAX_ATTACHMENT_MAIL_BYTES) {
        res.status(413).json({
          error: 'Mail trop volumineux (> 25 Mo) — ouvre cette pièce jointe depuis Outlook.',
        });
        return;
      }
      const rec = await resolveAccount(slug);
      try {
        const att = await imapService.downloadAttachment(rec, folder, uid, index);
        if (!att) {
          res.status(404).json({ error: 'Pièce jointe introuvable dans ce mail.' });
          return;
        }
        // Le download du mail pose \Seen côté serveur : l'index suit.
        await reflectActionInIndex(rec.account, folder, uid, 'seen').catch(() => {});
        const safeName = att.filename.replace(/[\r\n"\\]/g, '_');
        // inline=1 → « Voir » : le navigateur affiche (PDF/image) au lieu de
        // forcer le téléchargement, et met en cache. Sinon : téléchargement.
        const disposition = req.query.inline ? 'inline' : 'attachment';
        res
          .type(att.contentType)
          .setHeader(
            'Content-Disposition',
            `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
          )
          .send(att.content);
      } catch (err) {
        res.status(502).json({
          error:
            `Téléchargement impossible depuis la boîte : ${(err as Error).message}. ` +
            'Réessaie, ou ouvre la pièce jointe dans Outlook.',
        });
      }
    }),
  );

  // « Tout télécharger » : toutes les pièces jointes d'un mail dans un .zip.
  // Une seule descente IMAP (on veut toutes les parties), puis assemblage en
  // mémoire. Même cap 25 Mo que le téléchargement unitaire.
  router.get(
    '/accounts/:slug/messages/:folder/:uid/attachments.zip',
    guard(async (req, res) => {
      const uid = Number.parseInt(String(req.params.uid), 10);
      if (!Number.isInteger(uid) || uid <= 0) {
        res.status(400).json({ error: 'UID invalide.' });
        return;
      }
      const folder = String(req.params.folder);
      const slug = req.params.slug;
      const meta = await indexedMessage(slug, folder, uid);
      if (!meta) {
        res.status(404).json({ error: "Mail introuvable dans l'index — resynchronise la boîte." });
        return;
      }
      if (meta.sizeBytes > 25 * 1024 * 1024) {
        res.status(413).json({ error: 'Mail trop volumineux (> 25 Mo) — ouvre-le dans Outlook.' });
        return;
      }
      const rec = await resolveAccount(slug);
      try {
        const atts = await imapService.downloadAllAttachments(rec, folder, uid);
        if (atts.length === 0) {
          res.status(404).json({ error: 'Ce mail ne contient aucune pièce jointe.' });
          return;
        }
        await reflectActionInIndex(rec.account, folder, uid, 'seen').catch(() => {});
        const zip = buildZip(atts.map((a) => ({ name: a.filename, data: a.content })));
        const zipName = `pieces-jointes-${slug}-${uid}.zip`;
        res
          .type('application/zip')
          .setHeader('Content-Disposition', `attachment; filename="${zipName}"`)
          .send(zip);
      } catch (err) {
        res.status(502).json({
          error:
            `Téléchargement impossible depuis la boîte : ${(err as Error).message}. ` +
            'Réessaie, ou ouvre le mail dans Outlook.',
        });
      }
    }),
  );

  // Action sur UN mail depuis le panneau de lecture : corbeille (soft delete),
  // déplacement, lu/non lu. L'UID est revalidé contre l'index, tout est
  // journalisé avec le sujet et la date exacts du mail.
  router.post(
    '/accounts/:slug/messages/actions',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const folder = String(req.body?.folder ?? '').trim();
      const uid = Number.parseInt(String(req.body?.uid ?? ''), 10);
      const action = String(req.body?.action ?? '');
      const destination = String(req.body?.destination ?? '').trim();
      if (!folder || !Number.isInteger(uid) || uid <= 0) {
        res.status(400).json({ error: 'Paramètres "folder" et "uid" requis.' });
        return;
      }
      if (!['delete', 'move', 'seen', 'unseen', 'flag', 'unflag'].includes(action)) {
        res.status(400).json({ error: `Action inconnue : "${action}".` });
        return;
      }
      if (action === 'move' && !destination) {
        res.status(400).json({ error: 'Destination requise pour un déplacement.' });
        return;
      }
      const meta = await indexedMessage(slug, folder, uid);
      if (!meta) {
        res.status(404).json({ error: 'Mail introuvable dans l\'index — resynchronise la boîte.' });
        return;
      }
      const rec = await resolveAccount(slug);
      const items = [{ subject: meta.subject, date: meta.date }];

      let result: Record<string, unknown>;
      if (action === 'delete') {
        const r = await imapService.moveToTrash(rec, folder, [uid]);
        await recordOperation({
          account: rec.account,
          tool: 'ui_delete_message',
          folder,
          params: { count: 1, destination: r.destination },
          affectedUids: [uid],
          items,
          result: `soft-deleted 1 -> ${r.destination}`,
        });
        result = { deleted: r.moved, destination: r.destination };
      } else if (action === 'move') {
        const r = await imapService.moveEmails(rec, folder, [uid], destination);
        await recordOperation({
          account: rec.account,
          tool: 'ui_move_message',
          folder,
          params: { count: 1, destination },
          affectedUids: [uid],
          items,
          result: `moved ${r.moved} -> ${destination}`,
        });
        result = { moved: r.moved, destination };
      } else {
        const add = action === 'seen' ? ['\\Seen'] : action === 'flag' ? ['\\Flagged'] : [];
        const remove =
          action === 'unseen' ? ['\\Seen'] : action === 'unflag' ? ['\\Flagged'] : [];
        const r = await imapService.markEmails(rec, folder, [uid], add, remove);
        await recordOperation({
          account: rec.account,
          tool: 'ui_mark_message',
          folder,
          params: { count: 1, flag: action },
          affectedUids: [uid],
          items,
          result: `flagged ${r.affected}`,
        });
        result = { affected: r.affected, flag: action };
      }
      await reflectActionInIndex(
        slug,
        folder,
        uid,
        action as 'delete' | 'move' | 'seen' | 'unseen' | 'flag' | 'unflag',
      );
      res.json({ ok: true, action, ...result });
    }),
  );

  // --- Analyse du mail ouvert (L5.4) ---------------------------------------------
  // Tout est heuristique et local : importance (règles L1), état du fil,
  // échéances trouvées dans le texte FOURNI par le client (le corps déjà
  // téléchargé pour l'affichage — aucune lecture IMAP supplémentaire, aucun LLM).
  router.post(
    '/accounts/:slug/messages/analysis',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const folder = String(req.body?.folder ?? '').trim();
      const uid = Number.parseInt(String(req.body?.uid ?? ''), 10);
      const text = String(req.body?.text ?? '').slice(0, 200_000);
      if (!folder || !Number.isInteger(uid) || uid <= 0) {
        res.status(400).json({ error: 'Paramètres "folder" et "uid" requis.' });
        return;
      }
      const m = await db.message.findFirst({
        where: { accountSlug: slug, uid, isDeleted: false, folder: { path: folder } },
        select: {
          id: true,
          threadId: true,
          isOutbound: true,
          subject: true,
          date: true,
          fromEmail: true,
          hasListUnsubscribe: true,
          analysisConfidence: true,
          analysisConfidenceReason: true,
          intent: true,
          intentReason: true,
          intentSource: true,
        },
      });
      if (!m) {
        res.status(404).json({ error: 'Mail introuvable dans l\'index — resynchronise la boîte.' });
        return;
      }

      // Importance (mails reçus uniquement — le score n'a pas de sens pour tes envois).
      let importance: { score: number; level: string; reasons: string[] } | null = null;
      if (!m.isOutbound && m.fromEmail) {
        try {
          const imp = await explainImportance(slug, { messageId: m.id });
          importance = { score: imp.score, level: imp.level, reasons: imp.reasons };
        } catch {
          /* index incomplet : pas de score */
        }
      }

      // État du fil : qui a écrit en dernier, une réponse est-elle attendue ?
      let reply: { kind: string; label: string } = { kind: 'none', label: 'Mail isolé (pas de fil).' };
      if (m.threadId && m.date) {
        const [outAfter, inAfter] = await Promise.all([
          db.message.count({
            where: { threadId: m.threadId, isDeleted: false, isOutbound: true, date: { gte: m.date } },
          }),
          db.message.count({
            where: { threadId: m.threadId, isDeleted: false, isOutbound: false, date: { gt: m.date } },
          }),
        ]);
        if (m.isOutbound) {
          reply = inAfter > 0
            ? { kind: 'answered', label: 'Le correspondant a répondu depuis.' }
            : { kind: 'you-last', label: 'Tu as écrit en dernier — réponse externe attendue.' };
        } else if (m.hasListUnsubscribe || (m.fromEmail && AUTO_SENDER_RE.test(m.fromEmail))) {
          reply = { kind: 'auto', label: 'Expéditeur automatique : pas de réponse à prévoir.' };
        } else if (outAfter > 0) {
          reply = { kind: 'answered', label: 'Tu y as déjà répondu.' };
        } else if (inAfter > 0) {
          reply = { kind: 'none', label: 'Un mail plus récent existe dans ce fil.' };
        } else {
          reply = { kind: 'awaiting', label: 'Dernier message du fil : il attend probablement ta réponse.' };
        }
      }

      // Type de demande (B3) : sujet + corps affiché SANS le texte cité —
      // détecte aussi les demandes sans « ? » (« merci de me transmettre »).
      const isAuto = m.hasListUnsubscribe || (m.fromEmail && AUTO_SENDER_RE.test(m.fromEmail));
      const request = !m.isOutbound && !isAuto
        ? (() => {
            const r = detectRequestKind(m.subject, stripQuotedText(text));
            return { kind: r.kind, label: REQUEST_KIND_LABELS[r.kind], why: r.why };
          })()
        : null;

      // Échéances : déjà connues sur ce mail + nouvelles dates trouvées dans le
      // sujet + corps affiché. Dédup par date (à la minute près).
      const existingRows = await db.deadline.findMany({
        where: { accountSlug: slug, messageId: m.id },
        orderBy: { date: 'asc' },
      });
      const knownKeys = new Set(existingRows.map((d) => d.date.toISOString().slice(0, 16)));
      const detected = extractDeadlines(`${m.subject ?? ''}\n${text}`, m.date ?? new Date())
        .filter((ex) => !knownKeys.has(ex.date.toISOString().slice(0, 16)))
        .slice(0, 5)
        .map((ex) => ({
          date: ex.date.toISOString(),
          type: ex.type,
          confidence: ex.confidence,
          sourceText: ex.sourceText,
        }));

      // Confiance de l'analyse (B4) — calculée à la sync / au backfill 🏷️.
      const confidence =
        !m.isOutbound && m.analysisConfidence
          ? {
              level: m.analysisConfidence,
              label:
                m.analysisConfidence === 'high' ? 'forte'
                : m.analysisConfidence === 'medium' ? 'moyenne'
                : 'faible',
              reason: m.analysisConfidenceReason ?? '',
            }
          : null;

      // Classement courant (01/08) : ce que l'assistant croit de ce mail et de
      // son expéditeur — affiché dans le lecteur AVEC un moyen de corriger.
      // C'est la boucle de retour : une correction d'expéditeur reclasse tous
      // ses mails et n'est jamais écrasée (manual > ai > auto).
      let sender: {
        email: string;
        category: string | null;
        categorySource: string;
        priority: string;
      } | null = null;
      if (!m.isOutbound && m.fromEmail) {
        const s = await db.sender.findUnique({
          where: { accountSlug_email: { accountSlug: slug, email: m.fromEmail } },
          select: { category: true, categorySource: true, priority: true },
        });
        sender = {
          email: m.fromEmail,
          category: s?.category ?? null,
          categorySource: s?.categorySource ?? 'auto',
          priority: s?.priority ?? 'normal',
        };
      }

      res.json({
        messageId: m.id,
        importance,
        reply,
        request,
        confidence,
        classement: m.isOutbound
          ? null
          : {
              intent: m.intent,
              intentReason: m.intentReason,
              intentSource: m.intentSource,
              sender,
            },
        deadlines: {
          existing: existingRows.map((d) => ({
            id: d.id,
            date: d.date.toISOString(),
            status: d.status,
            type: d.type,
          })),
          detected,
        },
      });
    }),
  );

  // Corriger l'INTENTION d'un mail précis depuis le lecteur (01/08) — utile
  // quand un expéditeur mixte envoie pub ET factures : corriger l'expéditeur
  // ne suffit pas, il faut pouvoir corriger CE mail. Précédence stricte
  // manual > ai > auto : une correction n'est jamais écrasée par les recalculs
  // ni par l'IA. `intent: null` = revenir au calcul automatique (reposé par le
  // backfill 🏷️ ou la prochaine sync).
  router.patch(
    '/accounts/:slug/messages/intent',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const folder = String(req.body?.folder ?? '').trim();
      const uid = Number.parseInt(String(req.body?.uid ?? ''), 10);
      const raw = req.body?.intent;
      const intent = raw === null || raw === '' ? null : String(raw);
      if (!folder || !Number.isInteger(uid) || uid <= 0) {
        res.status(400).json({ error: 'Paramètres "folder" et "uid" requis.' });
        return;
      }
      if (intent !== null && !MESSAGE_INTENTS.includes(intent as MessageIntent)) {
        res.status(400).json({ error: `Intention inconnue : ${intent}.` });
        return;
      }
      await ensureDbReady();
      const m = await db.message.findFirst({
        where: { accountSlug: slug, uid, isDeleted: false, folder: { is: { path: folder } } },
        select: { id: true, subject: true, fromEmail: true },
      });
      if (!m) {
        res.status(404).json({ error: "Mail introuvable dans l'index — resynchronise la boîte." });
        return;
      }
      await db.message.update({
        where: { id: m.id },
        data: intent
          ? {
              intent,
              intentSource: 'manual',
              intentReason: 'corrigé par toi',
              // Ta correction lève le doute : le mail n'a plus à être proposé
              // au rattrapage IA ni protégé pour cause d'analyse incertaine.
              analysisConfidence: 'high',
              analysisConfidenceReason: 'intention corrigée à la main',
            }
          : { intent: null, intentSource: 'auto', intentReason: null },
      });
      await recordOperation({
        account: slug,
        tool: 'ui_message_intent',
        params: { folder, uid, intent, subject: m.subject ?? '', from: m.fromEmail ?? '' },
        result: intent
          ? `intention corrigée : ${MESSAGE_INTENT_LABELS[intent as MessageIntent]}`
          : 'intention repassée en calcul automatique',
      });
      res.json({ ok: true, intent, intentSource: intent ? 'manual' : 'auto' });
    }),
  );

  // Proposer une échéance depuis le panneau de lecture (date vue dans le mail).
  router.post(
    '/accounts/:slug/messages/propose-deadline',
    guard(async (req, res) => {
      const slug = req.params.slug;
      const folder = String(req.body?.folder ?? '').trim();
      const uid = Number.parseInt(String(req.body?.uid ?? ''), 10);
      const date = new Date(String(req.body?.date ?? ''));
      if (!folder || !Number.isInteger(uid) || uid <= 0 || Number.isNaN(date.getTime())) {
        res.status(400).json({ error: 'Paramètres "folder", "uid" et "date" requis.' });
        return;
      }
      const m = await db.message.findFirst({
        where: { accountSlug: slug, uid, isDeleted: false, folder: { path: folder } },
        select: { id: true },
      });
      if (!m) {
        res.status(404).json({ error: 'Mail introuvable dans l\'index.' });
        return;
      }
      const type = ['payment', 'document', 'appointment', 'renewal', 'other'].includes(
        String(req.body?.type),
      )
        ? (String(req.body.type) as DeadlineType)
        : 'other';
      res.json(
        await proposeDeadline(slug, m.id, {
          date,
          type,
          sourceText: String(req.body?.sourceText ?? ''),
        }),
      );
    }),
  );

  // --- Envoi de mails (L5.3) : répondre / transférer / nouveau ------------------
  // Garde-fous : destinataires validés, confirmation côté interface, envoi
  // journalisé (ui_send_mail) avec destinataires + objet, copie déposée dans
  // « Éléments envoyés » (best effort), jamais d'envoi sans clic explicite.
  router.post(
    '/accounts/:slug/send',
    guard(async (req, res) => {
      const slug = req.params.slug;
      let to: string[];
      let cc: string[];
      try {
        to = validateRecipients(req.body?.to, 'À');
        cc = validateRecipients(req.body?.cc, 'Cc');
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
      const subject = String(req.body?.subject ?? '').trim().slice(0, 500);
      const text = String(req.body?.text ?? '').slice(0, 200_000);
      if (to.length === 0) {
        res.status(400).json({ error: 'Au moins un destinataire est requis.' });
        return;
      }
      if (!subject) {
        res.status(400).json({ error: 'L\'objet est requis.' });
        return;
      }
      if (!text.trim()) {
        res.status(400).json({ error: 'Le message est vide.' });
        return;
      }

      // Réponse/transfert : on relie le fil via le Message-ID du mail d'origine.
      const replyTo = req.body?.replyTo as
        | { folder?: unknown; uid?: unknown; mode?: unknown }
        | undefined;
      let inReplyTo: string | undefined;
      let references: string[] | undefined;
      let original: { id: number; uid: number; folder: string } | null = null;
      const mode = replyTo?.mode === 'forward' ? 'forward' : replyTo ? 'reply' : 'new';
      if (replyTo && typeof replyTo.folder === 'string' && Number.isInteger(replyTo.uid)) {
        const m = await db.message.findFirst({
          where: {
            accountSlug: slug,
            uid: replyTo.uid as number,
            isDeleted: false,
            folder: { path: replyTo.folder },
          },
          select: { id: true, uid: true, internetMessageId: true, folder: { select: { path: true } } },
        });
        if (m) {
          original = { id: m.id, uid: m.uid, folder: m.folder.path };
          if (m.internetMessageId && mode === 'reply') {
            inReplyTo = m.internetMessageId;
            references = [m.internetMessageId];
          }
        }
      }

      const rec = await resolveAccount(slug);
      const { raw, recipients, from } = await sendEmail(rec, {
        to,
        cc,
        subject,
        text,
        inReplyTo,
        references,
      });

      // Copie « Éléments envoyés » : best effort (l'envoi a déjà réussi).
      let copiedTo: string | null = null;
      try {
        copiedTo = (await imapService.appendToSent(rec, raw)).folder;
      } catch (err) {
        logger.warn('copie Envoyés impossible', { account: slug, error: (err as Error).message });
      }

      // Réponse : marque le mail d'origine répondu (IMAP + index) — les
      // écrans « Réponses en attente » se mettent à jour sans re-sync.
      if (original && mode === 'reply') {
        await imapService
          .markEmails(rec, original.folder, [original.uid], ['\\Answered'], [])
          .catch(() => {});
        await db.message
          .update({ where: { id: original.id }, data: { isAnswered: true } })
          .catch(() => {});
      }

      await recordOperation({
        account: rec.account,
        tool: 'ui_send_mail',
        folder: copiedTo ?? undefined,
        params: { mode, to, cc, subject },
        items: [{ subject, date: new Date().toISOString() }],
        result: `envoyé à ${recipients.join(', ')}${copiedTo ? ` (copie dans ${copiedTo})` : ' (copie Envoyés impossible)'}`,
      });
      res.json({ ok: true, from, sentTo: recipients, copiedTo, mode });
    }),
  );

  // --- Export contacts (L4) : fichier vCard/CSV téléchargeable -------------------
  router.post(
    '/accounts/:slug/export-contacts',
    guard(async (req, res) => {
      const slug = req.params.slug;
      if (!(await getAccountRecord(slug))) {
        res.status(404).json({ error: `Compte « ${slug} » inconnu.` });
        return;
      }
      const format = req.body?.format === 'csv' ? 'csv' : 'vcard';
      const raw = Array.isArray(req.body?.senders) ? (req.body.senders as unknown[]) : [];
      const senders = raw
        .filter(
          (s): s is { address: string; name?: string } =>
            typeof s === 'object' &&
            s !== null &&
            typeof (s as { address?: unknown }).address === 'string' &&
            /.+@.+\..+/.test((s as { address: string }).address),
        )
        .slice(0, 2000)
        .map((s) => ({ address: s.address.trim(), name: typeof s.name === 'string' ? s.name : undefined }));
      if (senders.length === 0) {
        res.status(400).json({ error: 'Aucun contact valide dans la sélection.' });
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'csv') {
        res
          .type('text/csv; charset=utf-8')
          .setHeader('Content-Disposition', `attachment; filename="contacts-${slug}-${stamp}.csv"`)
          .send(toOutlookCsv(senders));
      } else {
        res
          .type('text/vcard; charset=utf-8')
          .setHeader('Content-Disposition', `attachment; filename="contacts-${slug}-${stamp}.vcf"`)
          .send(toVCard(senders));
      }
    }),
  );

  // --- Désinscription des listes (P2.2) -------------------------------------
  // Tarir le flux à la source. Rien n'est jamais automatique : on liste, tu
  // décides, et chaque désinscription est journalisée.
  router.get(
    '/unsubscribe',
    guard(async (req, res) => {
      const account = typeof req.query.account === 'string' ? req.query.account : undefined;
      const includeDone = req.query.done === '1';
      res.json({ senders: await listUnsubscribable(account, { includeDone }) });
    }),
  );

  // Va chercher les liens de désinscription (en-têtes IMAP) — travail long.
  router.post(
    '/unsubscribe/refresh',
    guard(async (_req, res) => {
      if (hasRunningJob('unsubscribe-refresh')) {
        res.status(409).json({ error: 'Une recherche de liens est déjà en cours.' });
        return;
      }
      const job = startJob('unsubscribe-refresh', async (progress) => {
        const results: Record<string, unknown> = {};
        for (const name of await listAccountNames()) {
          try {
            const rec = await resolveAccount(name);
            progress(`[${name}] recherche des liens de désinscription…`);
            results[name] = await refreshUnsubscribeLinks(rec, { onProgress: progress });
          } catch (err) {
            results[name] = { error: (err as Error).message };
          }
        }
        return results;
      });
      res.status(202).json({ jobId: job.id });
    }),
  );

  router.post(
    '/accounts/:slug/unsubscribe',
    guard(async (req, res) => {
      const email = typeof req.body?.email === 'string' ? req.body.email : '';
      if (!email) {
        res.status(400).json({ error: 'email requis.' });
        return;
      }
      try {
        const rec = await resolveAccount(req.params.slug);
        res.json(await unsubscribeSender(rec, email));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // « J'ai fait la démarche sur leur page » : on garde la trace.
  router.post(
    '/accounts/:slug/unsubscribe/mark',
    guard(async (req, res) => {
      const email = typeof req.body?.email === 'string' ? req.body.email : '';
      if (!email) {
        res.status(400).json({ error: 'email requis.' });
        return;
      }
      try {
        res.json(await markUnsubscribed(req.params.slug, email));
      } catch (err) {
        res.status(404).json({ error: (err as Error).message });
      }
    }),
  );

  // --- Transfert des boîtes entre installations -----------------------------
  // Enrôler une fois, réutiliser ailleurs (PC ↔ serveur). Le paquet est
  // chiffré par une phrase secrète choisie ici : il ne dépend d'aucune machine.
  router.post(
    '/accounts/export',
    guard(async (req, res) => {
      const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
      const names = Array.isArray(req.body?.accounts) ? (req.body.accounts as string[]) : undefined;
      try {
        res.json(await exportAccounts(passphrase, names));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  router.post(
    '/accounts/import',
    guard(async (req, res) => {
      const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
      const overwrite = req.body?.overwrite === true;
      try {
        const report = await importAccounts(req.body?.envelope, passphrase, { overwrite });
        res.json(report);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    }),
  );

  // --- Santé du système (P0.4) ----------------------------------------------
  // « L'absence d'alerte n'est pas une preuve que tout va bien » : on mesure
  // la fraîcheur des synchros, pas seulement leurs résultats.
  router.get(
    '/health',
    guard(async (_req, res) => {
      res.json(await getHealth());
    }),
  );

  // --- Sauvegardes (P0.3) ---------------------------------------------------
  // L'index des mails se reconstruit depuis IMAP, mais pas les tâches,
  // échéances, règles et corrections manuelles : c'est ça qu'on protège.
  router.get(
    '/backups',
    guard(async (_req, res) => {
      res.json({ backups: listBackups() });
    }),
  );

  router.post(
    '/backups',
    guard(async (_req, res) => {
      try {
        const b = await createBackup('manuelle');
        await recordOperation({
          account: '(système)',
          tool: 'ui_backup_create',
          params: { file: b.file, sizeBytes: b.sizeBytes },
          result: 'sauvegarde créée',
        });
        res.json(b);
      } catch (err) {
        res.status(500).json({ error: `Sauvegarde impossible : ${(err as Error).message}` });
      }
    }),
  );

  router.get(
    '/backups/:file/download',
    guard(async (req, res) => {
      const path = backupPath(String(req.params.file));
      if (!path) {
        res.status(404).json({ error: 'Sauvegarde introuvable.' });
        return;
      }
      res.download(path);
    }),
  );

  // --- Version & mise à jour -----------------------------------------------------
  router.get(
    '/version',
    guard(async (_req, res) => {
      res.json({
        ...(await version()),
        autoSync: autoSyncStatus(),
        autoUpdate: autoUpdateStatus(),
      });
    }),
  );

  router.get(
    '/update/check',
    guard(async (_req, res) => {
      res.json(await checkUpdates());
    }),
  );

  router.post(
    '/update/apply',
    guard(async (_req, res) => {
      if (hasRunningJob('update')) {
        res.status(409).json({ error: 'Une mise à jour est déjà en cours.' });
        return;
      }
      const job = startJob('update', (progress) => applyUpdate(progress));
      res.json({ jobId: job.id });
    }),
  );

  // --- Enrôlement interactif (recommandé) : popup avec sélecteur de compte ------
  router.post(
    '/enroll/start',
    guard(async (req, res) => {
      const account = String(req.body?.account ?? '').trim();
      if (!/^[a-z0-9_-]{1,40}$/i.test(account)) {
        res.status(400).json({
          error: 'Nom invalide : lettres, chiffres, tirets et underscores uniquement.',
        });
        return;
      }
      const redirectUri = `${config.admin.publicBaseUrl.replace(/\/$/, '')}/api/enroll/callback`;
      const { authUrl } = await beginInteractiveEnroll(account, redirectUri);
      const existing = await getAccountRecord(account);
      res.json({ authUrl, replacing: existing?.username ?? null, redirectUri });
    }),
  );

  // --- Enrôlement d'une nouvelle boîte (device code flow) -----------------------
  // Le job expose le code Microsoft via job.meta ; l'utilisateur le saisit sur
  // microsoft.com/devicelogin en se connectant avec la boîte à ajouter. Le
  // refresh token est chiffré côté serveur — il ne transite jamais par la page.
  router.post(
    '/enroll',
    guard(async (req, res) => {
      const account = String(req.body?.account ?? '').trim();
      if (!/^[a-z0-9_-]{1,40}$/i.test(account)) {
        res.status(400).json({
          error: 'Nom invalide : lettres, chiffres, tirets et underscores uniquement.',
        });
        return;
      }
      const kind = `enroll:${account}`;
      if (hasRunningJob(kind)) {
        res.status(409).json({ error: 'Un enrôlement est déjà en cours pour ce nom.' });
        return;
      }
      const existing = await getAccountRecord(account);
      const job = startJob(kind, async (progress, setMeta) => {
        progress('Demande du code de connexion à Microsoft…');
        const enrolled = await enrollAccount((info) => {
          setMeta({
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            expiresInSeconds: info.expiresIn,
          });
          progress('Code généré — en attente de ta validation chez Microsoft…');
        });
        // Filet de sécurité : détecte si cette adresse est déjà enrôlée sous
        // un autre nom (signe qu'on s'est connecté avec le mauvais compte —
        // le navigateur réutilise silencieusement la session Microsoft active).
        let duplicateOf: string | null = null;
        for (const n of await listAccountNames()) {
          if (n === account) continue;
          const r = await getAccountRecord(n);
          if (r && r.username.toLowerCase() === enrolled.username.toLowerCase()) {
            duplicateOf = n;
          }
        }
        await upsertAccount(account, enrolled);
        progress(`✅ ${enrolled.username} enrôlé sous le nom « ${account} ».`);
        return {
          account,
          username: enrolled.username,
          replaced: Boolean(existing),
          duplicateOf,
        };
      });
      res.json({ jobId: job.id, replacing: existing?.username ?? null });
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

  // Liste complète et classée (automatique / possiblement personnel) des mails
  // d'un expéditeur — pour valider le contenu AVANT de confirmer.
  router.get(
    '/accounts/:slug/cleanup/messages',
    guard(async (req, res) => {
      const sender = String(req.query.sender ?? '').trim();
      const folder = String(req.query.folder ?? 'INBOX');
      if (!sender) {
        res.status(400).json({ error: 'Paramètre "sender" requis.' });
        return;
      }
      res.json(await listCleanupMessages(req.params.slug, folder, sender));
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
      // Sélection fine optionnelle : seuls ces UIDs seront traités (revalidés
      // côté service contre l'index — impossible d'y glisser d'autres mails).
      const uids = Array.isArray(req.body?.uids)
        ? (req.body.uids as unknown[])
            .filter((n): n is number => Number.isInteger(n) && (n as number) > 0)
            .slice(0, 20_000)
        : undefined;
      if (uids !== undefined && uids.length === 0) {
        res.status(400).json({ error: 'Sélection vide : aucun mail coché.' });
        return;
      }
      const kind = `cleanup:${slug}`;
      if (hasRunningJob(kind) || hasRunningJob(`sync:${slug}`)) {
        res.status(409).json({ error: 'Une opération est déjà en cours sur ce compte.' });
        return;
      }
      const rec = await resolveAccount(slug);
      const job = startJob(kind, (progress) =>
        executeSenderCleanup(rec, folder, sender, progress, uids),
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

  // Liste globale des tâches (suivi multi-pages) — version allégée.
  router.get(
    '/jobs',
    guard(async (_req, res) => {
      res.json({
        jobs: listJobs().map((j) => ({
          id: j.id,
          kind: j.kind,
          status: j.status,
          startedAt: j.startedAt,
          finishedAt: j.finishedAt,
          error: j.error,
          lastProgress: j.progress[j.progress.length - 1] ?? null,
        })),
      });
    }),
  );

  // Synchronise toutes les boîtes, l'une après l'autre (file séquentielle).
  router.post(
    '/sync-all',
    guard(async (req, res) => {
      const mode = req.body?.mode === 'full' ? 'full' : 'recent';
      if (hasRunningJob('sync-all')) {
        res.status(409).json({ error: 'Une synchronisation globale est déjà en cours.' });
        return;
      }
      const names = await listAccountNames();
      if (names.length === 0) {
        res.status(400).json({ error: 'Aucun compte enrôlé.' });
        return;
      }
      const job = startSyncAllJob(
        mode,
        names.filter((n) => !hasRunningJob(`sync:${n}`)),
      );
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

  // (routes suivantes : journal, etc.)
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

/**
 * Page de résultat affichée dans la popup d'enrôlement : montre le résultat et
 * le transmet à la fenêtre principale via postMessage (même origine).
 */
function popupResult(
  res: Response,
  payload: {
    ok: boolean;
    account?: string;
    username?: string;
    duplicateOf?: string | null;
    error?: string;
  },
): void {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const message = payload.ok
    ? `✅ <strong>${escapeHtml(payload.username ?? '')}</strong> ajouté sous le nom « ${escapeHtml(
        payload.account ?? '',
      )} ».<br>Cette fenêtre va se fermer toute seule.`
    : `❌ Échec de l'enrôlement :<br>${escapeHtml(payload.error ?? 'erreur inconnue')}`;
  res
    .status(payload.ok ? 200 : 400)
    .type('html')
    .send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Boxmail — enrôlement</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:90vh;background:#f3f5f9;color:#1a2235}div{background:#fff;border-radius:14px;
padding:34px 38px;max-width:460px;box-shadow:0 10px 40px rgba(0,0,0,.12);font-size:15px;line-height:1.5}</style>
</head><body><div>${message}</div>
<script>
  try {
    window.opener && window.opener.postMessage(
      Object.assign({ source: 'boxmail-enroll' }, ${JSON.stringify(payload)}),
      window.location.origin
    );
  } catch (e) {}
  ${payload.ok ? 'setTimeout(function(){ window.close(); }, 3500);' : ''}
</script></body></html>`);
}
