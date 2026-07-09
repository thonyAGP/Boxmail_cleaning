import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveAccount, listAccountNames } from '../../services/accounts.js';
import { syncAccount } from '../../services/sync.js';
import { mailboxOverview, globalOverview } from '../../services/index-stats.js';
import { accountParam, guard, jsonResult } from '../util.js';

export function registerSyncTools(server: McpServer): void {
  server.registerTool(
    'sync_account',
    {
      title: 'Synchroniser un compte',
      description:
        "Synchronise l'index local d'un compte (métadonnées uniquement, jamais les corps). " +
        "Mode 'recent' (défaut) : INBOX + Éléments envoyés, rapide. Mode 'full' : tous les " +
        'dossiers + rafraîchissement des flags lu/non lu. À lancer avant get_mailbox_overview ' +
        'ou pour des stats à jour.',
      inputSchema: {
        ...accountParam,
        mode: z.enum(['recent', 'full']).default('recent'),
        folders: z
          .array(z.string())
          .optional()
          .describe('Limiter la sync à ces dossiers (chemins exacts).'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(async (args: { account?: string; mode: 'recent' | 'full'; folders?: string[] }) => {
      const rec = await resolveAccount(args.account);
      const report = await syncAccount(rec, { mode: args.mode, folders: args.folders });
      return jsonResult(report);
    }),
  );

  server.registerTool(
    'get_mailbox_overview',
    {
      title: "Vue d'ensemble d'un compte",
      description:
        "Vue globale d'un compte depuis l'index local (instantané) : compteurs INBOX " +
        '(total, non lus, newsletters, taille), dossiers, top expéditeurs. Nécessite une ' +
        'sync préalable (sync_account) ; le champ lastSyncAt indique la fraîcheur.',
      inputSchema: { ...accountParam },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account }: { account?: string }) => {
      const rec = await resolveAccount(account);
      return jsonResult(await mailboxOverview(rec.account));
    }),
  );

  server.registerTool(
    'get_global_overview',
    {
      title: "Vue d'ensemble toutes boîtes",
      description:
        'Vue consolidée de tous les comptes indexés : par compte (INBOX, non lus, top ' +
        'expéditeurs) + totaux. Les comptes jamais synchronisés sont signalés à part.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => {
      const overview = await globalOverview();
      const enrolled = await listAccountNames();
      const indexed = new Set(overview.accounts.map((a) => a.account));
      const neverSynced = enrolled.filter((n) => !indexed.has(n));
      return jsonResult({ ...overview, neverSynced });
    }),
  );
}
