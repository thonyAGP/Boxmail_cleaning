/**
 * API pièces comptables (connecteur Fiscal-Manager V1) — 2 endpoints GET,
 * strictement UNIDIRECTIONNELS : Boxmail ne sait jamais ce que deviennent
 * les candidats. Jeton dédié LECTURE SEULE (ACCOUNTING_READ_TOKEN), distinct
 * du bearer MCP — périmètre minimal si le jeton fuit. Chaque téléchargement
 * de pièce est journalisé (logs/operations.jsonl).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { listCandidates, resolveAttachment } from '../services/accounting.js';
import { getAccountRecord } from '../services/accounts.js';
import { recordOperation } from '../services/oplog.js';

function checkToken(req: Request, res: Response, next: NextFunction): void {
  const expected = config.accounting.readToken;
  if (!expected) {
    res.status(503).json({ error: "API pièces comptables désactivée (ACCOUNTING_READ_TOKEN absent du .env)." });
    return;
  }
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  if (!match) {
    res.status(401).json({ error: 'Authentification requise (Bearer token).' });
    return;
  }
  const provided = Buffer.from(match[1], 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    res.status(403).json({ error: 'Token invalide.' });
    return;
  }
  next();
}

export function buildAccountingRouter(): Router {
  const router = Router();
  router.use(checkToken);

  // Liste paginée par curseur monotone (seq SQLite — jamais une date ni un UID).
  router.get('/', async (req: Request, res: Response) => {
    try {
      const cursorRaw = typeof req.query.cursor === 'string' ? req.query.cursor : '0';
      const cursor = Number.parseInt(cursorRaw, 10);
      const limit = Number.parseInt(String(req.query.limit ?? '100'), 10);
      const page = await listCandidates(
        Number.isFinite(cursor) && cursor > 0 ? cursor : 0,
        Number.isFinite(limit) ? limit : 100,
      );
      res.json(page);
    } catch (err) {
      logger.error('liste des candidats comptables en échec', { error: (err as Error).message });
      res.status(500).json({ error: 'Erreur interne.' });
    }
  });

  // Pièce streamée depuis l'IMAP (résolution du locator au moment T).
  // Source disparue → 410 Gone : le candidat existe toujours, sa source non.
  router.get('/:candidateId/attachments/:attachmentId', async (req: Request, res: Response) => {
    const { candidateId, attachmentId } = req.params;
    try {
      const r = await resolveAttachment(candidateId, attachmentId, getAccountRecord);
      if (!r.ok) {
        res.status(r.code).json({ error: r.reason });
        return;
      }
      await recordOperation({
        account: '*',
        tool: 'accounting_attachment_download',
        params: { candidateId, attachmentId, filename: r.filename, sizeBytes: r.content.length },
        result: 'pièce servie à Fiscal-Manager',
      });
      res.setHeader('Content-Type', r.contentType);
      res.setHeader('Content-Length', String(r.content.length));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${r.filename.replace(/["\\\r\n]/g, '_')}"`,
      );
      res.end(r.content);
    } catch (err) {
      logger.error('téléchargement candidat comptable en échec', {
        candidateId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: 'Erreur interne.' });
    }
  });

  return router;
}
