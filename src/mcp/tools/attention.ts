import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveAccount } from '../../services/accounts.js';
import {
  getUnansweredEmails,
  getOverdueReplies,
  snoozeReply,
  dismissReply,
  restoreReply,
} from '../../services/attention.js';
import { accountParam, guard, jsonResult } from '../util.js';

/**
 * Tools MCP « intelligence » — Phase 4, brique 1 : réponses oubliées.
 * Tout est calculé depuis l'index local (instantané, aucun accès IMAP) :
 * penser à synchroniser la boîte pour des résultats à jour.
 */

const commonListParams = {
  ...accountParam,
  sinceDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(60)
    .describe("Fenêtre d'analyse en jours (défaut 60)."),
  limit: z.number().int().min(1).max(1000).default(100).describe('Nombre max de résultats.'),
};

const threadParam = {
  ...accountParam,
  threadId: z
    .number()
    .int()
    .positive()
    .describe('Identifiant du fil (champ threadId retourné par get_unanswered_emails).'),
};

export function registerAttentionTools(server: McpServer): void {
  // --- get_unanswered_emails ---
  server.registerTool(
    'get_unanswered_emails',
    {
      title: 'Mails en attente de réponse',
      description:
        "Mails entrants qui attendent une réponse de l'utilisateur : dernier message de " +
        'leur fil, en boîte de réception, sans réponse envoyée depuis. Newsletters, ' +
        'notifications et expéditeurs no-reply sont ignorés. Chaque élément porte une ' +
        '`reason` explicite, une catégorie (urgent 24 h / banque-admin 48 h / normal 7 j) ' +
        "et un indicateur `overdue`. Calculé depuis l'index local (synchroniser d'abord). " +
        'Les fils reportés (snooze) ou ignorés (dismiss) sont exclus par défaut.',
      inputSchema: {
        ...commonListParams,
        scope: z
          .enum(['all', 'overdue'])
          .default('all')
          .describe('all = tout ce qui attend une réponse ; overdue = seuils dépassés seulement.'),
        includeHidden: z
          .boolean()
          .default(false)
          .describe('true = inclure aussi les fils reportés/ignorés (champ state).'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      async (args: {
        account?: string;
        scope: 'all' | 'overdue';
        sinceDays: number;
        limit: number;
        includeHidden: boolean;
      }) => {
        const rec = await resolveAccount(args.account);
        return jsonResult(
          await getUnansweredEmails(rec.account, {
            scope: args.scope,
            sinceDays: args.sinceDays,
            limit: args.limit,
            includeHidden: args.includeHidden,
          }),
        );
      },
    ),
  );

  // --- get_overdue_replies ---
  server.registerTool(
    'get_overdue_replies',
    {
      title: 'Réponses en retard',
      description:
        'Raccourci de get_unanswered_emails limité aux mails dont le seuil de réponse est ' +
        'dépassé (urgent 24 h, banque/administration 48 h, normal 7 jours).',
      inputSchema: commonListParams,
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { account?: string; sinceDays: number; limit: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(
        await getOverdueReplies(rec.account, { sinceDays: args.sinceDays, limit: args.limit }),
      );
    }),
  );

  // --- snooze_reply ---
  server.registerTool(
    'snooze_reply',
    {
      title: 'Reporter une réponse',
      description:
        "Reporte un fil « en attente de réponse » : il disparaît de la liste pendant N jours " +
        'puis réapparaît tout seul. Ne touche pas aux mails (état local uniquement, journalisé).',
      inputSchema: {
        ...threadParam,
        days: z.number().int().min(1).max(365).default(3).describe('Durée du report en jours.'),
      },
    },
    guard(async (args: { account?: string; threadId: number; days: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await snoozeReply(rec.account, args.threadId, args.days));
    }),
  );

  // --- dismiss_reply ---
  server.registerTool(
    'dismiss_reply',
    {
      title: 'Ignorer une réponse attendue',
      description:
        "Marque un fil « pas de réponse nécessaire » : il ne sera plus proposé, sauf si un " +
        'nouveau mail arrive dans ce fil. Ne touche pas aux mails (état local, journalisé).',
      inputSchema: threadParam,
    },
    guard(async (args: { account?: string; threadId: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await dismissReply(rec.account, args.threadId));
    }),
  );

  // --- restore_reply ---
  server.registerTool(
    'restore_reply',
    {
      title: 'Remettre en liste',
      description:
        "Annule un report ou un « ignoré » : le fil redevient visible immédiatement dans " +
        'les mails en attente de réponse.',
      inputSchema: threadParam,
    },
    guard(async (args: { account?: string; threadId: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await restoreReply(rec.account, args.threadId));
    }),
  );
}
