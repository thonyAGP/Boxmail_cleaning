import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveAccount } from '../../services/accounts.js';
import {
  getUnansweredEmails,
  getOverdueReplies,
  snoozeReply,
  dismissReply,
  restoreReply,
  snoozeFollowup,
  markFollowupDone,
  restoreFollowup,
} from '../../services/attention.js';
import { getFollowupsDue } from '../../services/followups.js';
import { getImportantEmails, explainImportance } from '../../services/importance.js';
import { accountParam, guard, jsonResult } from '../util.js';

/**
 * Tools MCP « intelligence » — Phase 4 : réponses oubliées (brique 1),
 * relances (brique 2) et mails importants (brique 3). Tout est calculé depuis
 * l'index local (instantané, aucun accès IMAP) : penser à synchroniser la
 * boîte pour des résultats à jour.
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

  // --- get_followups_due (brique 2 : relances) ---
  server.registerTool(
    'get_followups_due',
    {
      title: 'Relances à faire',
      description:
        "Fils où l'utilisateur a écrit en dernier et attend une réponse externe : dernier " +
        'message du fil envoyé par lui, sans retour depuis. Les destinataires automatiques ' +
        '(no-reply…) sont exclus. Chaque élément porte le correspondant à relancer, une ' +
        '`reason` explicite, une catégorie (sujet pressant 3 j / banque-admin-pro 5 j / ' +
        "normal 7 j) et un indicateur `overdue`. Calculé depuis l'index local (synchroniser " +
        "d'abord, y compris le dossier Éléments envoyés — inclus dans toute sync). Les fils " +
        'reportés (snooze) ou marqués traités sont exclus par défaut.',
      inputSchema: {
        ...commonListParams,
        scope: z
          .enum(['all', 'overdue'])
          .default('all')
          .describe('all = toutes les attentes ; overdue = délais de relance dépassés seulement.'),
        includeHidden: z
          .boolean()
          .default(false)
          .describe('true = inclure aussi les fils reportés/traités (champ state).'),
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
          await getFollowupsDue(rec.account, {
            scope: args.scope,
            sinceDays: args.sinceDays,
            limit: args.limit,
            includeHidden: args.includeHidden,
          }),
        );
      },
    ),
  );

  // --- snooze_followup ---
  server.registerTool(
    'snooze_followup',
    {
      title: 'Reporter une relance',
      description:
        'Reporte une relance : le fil disparaît de la liste pendant N jours puis réapparaît. ' +
        'Ne touche pas aux mails (état local uniquement, journalisé).',
      inputSchema: {
        ...threadParam,
        days: z.number().int().min(1).max(365).default(3).describe('Durée du report en jours.'),
      },
    },
    guard(async (args: { account?: string; threadId: number; days: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await snoozeFollowup(rec.account, args.threadId, args.days));
    }),
  );

  // --- mark_followup_done ---
  server.registerTool(
    'mark_followup_done',
    {
      title: 'Marquer une relance traitée',
      description:
        'Marque une relance comme traitée (relance envoyée par ailleurs, ou plus nécessaire) : ' +
        'le fil ne sera plus proposé, sauf si un nouveau message y arrive. Ne touche pas aux ' +
        'mails (état local, journalisé).',
      inputSchema: threadParam,
    },
    guard(async (args: { account?: string; threadId: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await markFollowupDone(rec.account, args.threadId));
    }),
  );

  // --- restore_followup ---
  server.registerTool(
    'restore_followup',
    {
      title: 'Remettre une relance en liste',
      description:
        'Annule un report ou un « traité » : le fil redevient visible immédiatement dans les ' +
        'relances à faire.',
      inputSchema: threadParam,
    },
    guard(async (args: { account?: string; threadId: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await restoreFollowup(rec.account, args.threadId));
    }),
  );

  // --- get_important_emails (brique 3 : mails importants) ---
  server.registerTool(
    'get_important_emails',
    {
      title: 'Mails importants (score /100)',
      description:
        "Mails entrants de la boîte de réception, scorés 0-100 par des règles explicites " +
        '(expéditeur banque/administration +30, sujet urgent +20, vraie personne +15, ' +
        'non lu récent +15, question / montant / attend une réponse +10, newsletter ou ' +
        'notification −40). Chaque élément porte `score`, `level` (high ≥ 70, medium 40-69, ' +
        "low < 40) et `reasons[]` en français. Par défaut : non lus des 30 derniers jours, " +
        "score ≥ 40. Calculé depuis l'index local (synchroniser d'abord). Lecture seule.",
      inputSchema: {
        ...accountParam,
        sinceDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(30)
          .describe("Fenêtre d'analyse en jours (défaut 30)."),
        minScore: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(40)
          .describe('Score minimal pour apparaître dans la liste (défaut 40).'),
        includeRead: z
          .boolean()
          .default(false)
          .describe('true = inclure aussi les mails déjà lus (défaut : non lus uniquement).'),
        limit: z.number().int().min(1).max(1000).default(100).describe('Nombre max de résultats.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      async (args: {
        account?: string;
        sinceDays: number;
        minScore: number;
        includeRead: boolean;
        limit: number;
      }) => {
        const rec = await resolveAccount(args.account);
        return jsonResult(
          await getImportantEmails(rec.account, {
            sinceDays: args.sinceDays,
            minScore: args.minScore,
            includeRead: args.includeRead,
            limit: args.limit,
          }),
        );
      },
    ),
  );

  // --- explain_importance ---
  server.registerTool(
    'explain_importance',
    {
      title: "Expliquer le score d'un mail",
      description:
        "Détaille le score d'importance (0-100) d'un mail précis avec toutes les règles " +
        'appliquées (`reasons[]`). Indiquer messageId (champ messageId retourné par ' +
        'get_important_emails) OU threadId (→ dernier mail entrant du fil). Fonctionne ' +
        'aussi sur un mail lu ou ancien. Lecture seule.',
      inputSchema: {
        ...accountParam,
        messageId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Identifiant interne du mail (champ messageId des tools attention).'),
        threadId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Identifiant du fil : le dernier mail entrant du fil sera expliqué.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { account?: string; messageId?: number; threadId?: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(
        await explainImportance(rec.account, {
          messageId: args.messageId,
          threadId: args.threadId,
        }),
      );
    }),
  );
}
