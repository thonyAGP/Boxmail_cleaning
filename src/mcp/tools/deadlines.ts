import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveAccount } from '../../services/accounts.js';
import {
  detectDeadlines,
  listDeadlines,
  confirmDeadline,
  dismissDeadline,
  completeDeadline,
  restoreDeadline,
} from '../../services/deadlines.js';
import { accountParam, guard, jsonResult } from '../util.js';

/**
 * Tools MCP « échéances » — Phase 4, brique 4 (L2).
 * Détection dans les sujets (index, instantané) et, sur demande, dans les
 * corps (IMAP, plafonné). Une échéance détectée est PROPOSÉE : l'utilisateur
 * (ou Claude sur son instruction) la confirme, l'ignore ou la marque faite.
 */

const idParam = {
  ...accountParam,
  deadlineId: z
    .number()
    .int()
    .positive()
    .describe('Identifiant de l\'échéance (champ id retourné par list_deadlines).'),
};

export function registerDeadlineTools(server: McpServer): void {
  server.registerTool(
    'detect_deadlines',
    {
      title: 'Détecter les échéances',
      description:
        "Analyse les mails entrants récents pour détecter des dates limites (paiement, " +
        'document à fournir, rendez-vous, renouvellement…). Passe rapide sur les sujets ' +
        '(index local) ; avec deep:true, lit aussi le CONTENU des mails au sujet évocateur ' +
        '(IMAP, max 50 mails — plus lent). Les newsletters sont exclues. Les échéances ' +
        'trouvées sont créées en statut « proposed » (jamais d\'écrasement d\'un statut ' +
        'validé). Relancer la détection est sans danger (idempotent).',
      inputSchema: {
        ...accountParam,
        sinceDays: z.number().int().min(1).max(365).default(30),
        deep: z
          .boolean()
          .default(false)
          .describe('true = lire aussi les corps des mails candidats (lent).'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(async (args: { account?: string; sinceDays: number; deep: boolean }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await detectDeadlines(rec, { sinceDays: args.sinceDays, deep: args.deep }));
    }),
  );

  server.registerTool(
    'list_deadlines',
    {
      title: 'Lister les échéances',
      description:
        'Échéances détectées/confirmées, triées par date croissante. Champ inDays = jours ' +
        'restants (négatif si passée). Statuts : proposed (à valider), confirmed, done, ' +
        'dismissed. Lancer detect_deadlines d\'abord pour des résultats à jour.',
      inputSchema: {
        ...accountParam,
        status: z.enum(['proposed', 'confirmed', 'dismissed', 'done']).optional(),
        fromDate: z.string().optional().describe('Borne basse ISO (ex. 2026-07-01).'),
        toDate: z.string().optional().describe('Borne haute ISO.'),
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      async (args: {
        account?: string;
        status?: 'proposed' | 'confirmed' | 'dismissed' | 'done';
        fromDate?: string;
        toDate?: string;
        limit: number;
      }) => {
        const rec = await resolveAccount(args.account);
        return jsonResult({
          account: rec.account,
          deadlines: await listDeadlines(rec.account, args),
        });
      },
    ),
  );

  server.registerTool(
    'confirm_deadline',
    {
      title: 'Confirmer une échéance',
      description:
        "Valide une échéance proposée (statut confirmed). Ne créer d'événement calendrier " +
        "qu'à la demande explicite de l'utilisateur — jamais automatiquement.",
      inputSchema: idParam,
    },
    guard(async (args: { account?: string; deadlineId: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await confirmDeadline(rec.account, args.deadlineId));
    }),
  );

  server.registerTool(
    'dismiss_deadline',
    {
      title: 'Ignorer une échéance',
      description: "Écarte une échéance (fausse détection ou sans importance) — réversible.",
      inputSchema: idParam,
    },
    guard(async (args: { account?: string; deadlineId: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await dismissDeadline(rec.account, args.deadlineId));
    }),
  );

  server.registerTool(
    'complete_deadline',
    {
      title: 'Marquer une échéance faite',
      description: "L'obligation a été remplie (payé, envoyé, honoré…) — statut done.",
      inputSchema: idParam,
    },
    guard(async (args: { account?: string; deadlineId: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await completeDeadline(rec.account, args.deadlineId));
    }),
  );

  server.registerTool(
    'restore_deadline',
    {
      title: 'Rétablir une échéance',
      description: 'Remet une échéance ignorée/faite en statut « proposed » (annulation).',
      inputSchema: idParam,
    },
    guard(async (args: { account?: string; deadlineId: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await restoreDeadline(rec.account, args.deadlineId));
    }),
  );
}
