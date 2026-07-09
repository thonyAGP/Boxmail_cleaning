import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveAccount } from '../../services/accounts.js';
import { imapService } from '../../services/imap.js';
import {
  isFolderIndexed,
  senderStatsFromIndex,
  lastSyncAt,
} from '../../services/index-stats.js';
import { accountParam, guard, jsonResult } from '../util.js';

const isoDate = z
  .string()
  .describe('Date ISO 8601 (ex. 2026-01-31 ou 2026-01-31T00:00:00Z)')
  .refine((s) => !Number.isNaN(new Date(s).getTime()), { message: 'date invalide' });

export function registerReadTools(server: McpServer): void {
  // --- get_sender_stats (tool clé) ---
  server.registerTool(
    'get_sender_stats',
    {
      title: 'Statistiques par expéditeur',
      description:
        "Agrège les mails d'un dossier par expéditeur : nombre, date du plus récent, " +
        'taille totale, et % de mails portant un header List-Unsubscribe (indice ' +
        'newsletter/notification). Trié par volume décroissant. Idéal pour repérer le spam. ' +
        "Utilise l'index local (instantané) si le dossier est synchronisé, sinon scan IMAP " +
        'live (lent sur les grosses boîtes) — voir les champs source/lastSyncAt.',
      inputSchema: {
        ...accountParam,
        folder: z.string().default('INBOX').describe('Dossier à analyser (défaut INBOX).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe('Nombre max d\'expéditeurs retournés (défaut 50).'),
        since: isoDate.optional().describe('Ne compter que les mails reçus après cette date.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      async ({
        account,
        folder,
        limit,
        since,
      }: {
        account?: string;
        folder: string;
        limit: number;
        since?: string;
      }) => {
        const rec = await resolveAccount(account);
        // Chemin rapide : index local si le dossier est synchronisé.
        if (await isFolderIndexed(rec.account, folder)) {
          const stats = await senderStatsFromIndex(rec.account, folder, limit, since);
          return jsonResult({
            account: rec.account,
            folder,
            source: 'index',
            lastSyncAt: await lastSyncAt(rec.account),
            ...stats,
          });
        }
        const stats = await imapService.getSenderStats(rec, folder, limit, since);
        return jsonResult({ account: rec.account, folder, source: 'imap-live', ...stats });
      },
    ),
  );

  // --- search_emails ---
  server.registerTool(
    'search_emails',
    {
      title: 'Rechercher des mails',
      description:
        'Recherche IMAP (from, subject, since/before, seen/unseen). Retourne des ' +
        'métadonnées (uid, expéditeur, sujet, date, flags), pas les corps.',
      inputSchema: {
        ...accountParam,
        folder: z.string().default('INBOX'),
        from: z.string().optional().describe("Filtre sur l'adresse/nom expéditeur (substring)."),
        subject: z.string().optional().describe('Filtre sur le sujet (substring).'),
        since: isoDate.optional(),
        before: isoDate.optional(),
        seen: z.boolean().optional().describe('true = lus, false = non lus, absent = tous.'),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: any) => {
      const rec = await resolveAccount(args.account);
      const res = await imapService.searchEmails(rec, {
        folder: args.folder,
        from: args.from,
        subject: args.subject,
        since: args.since,
        before: args.before,
        seen: args.seen,
        limit: args.limit,
      });
      return jsonResult({ account: rec.account, folder: args.folder, ...res });
    }),
  );

  // --- read_email ---
  server.registerTool(
    'read_email',
    {
      title: 'Lire un mail',
      description:
        "Corps d'un mail par UID : texte brut (HTML converti/tronqué à ~5000 chars) " +
        'et liste des pièces jointes (sans les télécharger).',
      inputSchema: {
        ...accountParam,
        folder: z.string().default('INBOX'),
        uid: z.number().int().positive().describe('UID IMAP du message.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, folder, uid }: { account?: string; folder: string; uid: number }) => {
      const rec = await resolveAccount(account);
      const body = await imapService.readEmail(rec, folder, uid);
      return jsonResult({ account: rec.account, folder, ...body });
    }),
  );

  // --- get_thread ---
  server.registerTool(
    'get_thread',
    {
      title: "Récupérer un fil",
      description:
        "Tous les mails d'un fil de discussion (regroupés par sujet normalisé), " +
        "à partir de l'UID d'un message du fil.",
      inputSchema: {
        ...accountParam,
        folder: z.string().default('INBOX'),
        uid: z.number().int().positive().describe("UID d'un message du fil."),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account, folder, uid }: { account?: string; folder: string; uid: number }) => {
      const rec = await resolveAccount(account);
      const thread = await imapService.getThread(rec, folder, uid);
      return jsonResult({ account: rec.account, folder, count: thread.length, messages: thread });
    }),
  );
}
