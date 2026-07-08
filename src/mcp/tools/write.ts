import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveAccount } from '../../services/accounts.js';
import { imapService } from '../../services/imap.js';
import { recordOperation } from '../../services/oplog.js';
import { config } from '../../config.js';
import { accountParam, guard, jsonResult } from '../util.js';

const uidsParam = z
  .array(z.number().int().positive())
  .min(1)
  .max(1000)
  .describe('Liste des UID IMAP concernés.');

export function registerWriteTools(server: McpServer): void {
  // --- move_emails ---
  server.registerTool(
    'move_emails',
    {
      title: 'Déplacer des mails',
      description: 'Déplace des UIDs vers un dossier de destination.',
      inputSchema: {
        ...accountParam,
        folder: z.string().default('INBOX').describe('Dossier source.'),
        uids: uidsParam,
        destination: z.string().min(1).describe('Dossier de destination.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    guard(async (args: any) => {
      const rec = await resolveAccount(args.account);
      const res = await imapService.moveEmails(rec, args.folder, args.uids, args.destination);
      await recordOperation({
        account: rec.account,
        tool: 'move_emails',
        folder: args.folder,
        params: { destination: args.destination, count: args.uids.length },
        affectedUids: args.uids,
        result: `moved ${res.moved}`,
      });
      return jsonResult({ account: rec.account, folder: args.folder, ...res });
    }),
  );

  // --- mark_emails ---
  server.registerTool(
    'mark_emails',
    {
      title: 'Marquer des mails',
      description: 'Ajoute/retire des flags : seen/unseen/flagged.',
      inputSchema: {
        ...accountParam,
        folder: z.string().default('INBOX'),
        uids: uidsParam,
        flag: z
          .enum(['seen', 'unseen', 'flagged', 'unflagged'])
          .describe('Action de flag à appliquer.'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(async (args: any) => {
      const rec = await resolveAccount(args.account);
      const map: Record<string, { add: string[]; remove: string[] }> = {
        seen: { add: ['\\Seen'], remove: [] },
        unseen: { add: [], remove: ['\\Seen'] },
        flagged: { add: ['\\Flagged'], remove: [] },
        unflagged: { add: [], remove: ['\\Flagged'] },
      };
      const { add, remove } = map[args.flag as string];
      const res = await imapService.markEmails(rec, args.folder, args.uids, add, remove);
      await recordOperation({
        account: rec.account,
        tool: 'mark_emails',
        folder: args.folder,
        params: { flag: args.flag, count: args.uids.length },
        affectedUids: args.uids,
        result: `flagged ${res.affected}`,
      });
      return jsonResult({ account: rec.account, folder: args.folder, flag: args.flag, ...res });
    }),
  );

  // --- delete_emails (soft delete + garde-fous) ---
  server.registerTool(
    'delete_emails',
    {
      title: 'Supprimer des mails (soft delete)',
      description:
        'Supprime des UIDs = DÉPLACEMENT vers la corbeille (récupérable ~30j, jamais ' +
        "d'EXPUNGE définitif). DRY-RUN PAR DÉFAUT : sans confirm:true, retourne " +
        'seulement ce qui SERAIT supprimé. Plafond : 200 mails/appel.',
      inputSchema: {
        ...accountParam,
        folder: z.string().default('INBOX'),
        uids: uidsParam,
        confirm: z
          .boolean()
          .default(false)
          .describe('false (défaut) = dry-run. true = exécute réellement la suppression.'),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    guard(async (args: any) => {
      const rec = await resolveAccount(args.account);
      return runDelete(rec, args.folder, args.uids, args.confirm, 'delete_emails', {
        uidCount: args.uids.length,
      });
    }),
  );

  // --- bulk_delete_by_sender ---
  server.registerTool(
    'bulk_delete_by_sender',
    {
      title: 'Supprimer tous les mails d\'un expéditeur (soft delete)',
      description:
        "Supprime (soft delete) tous les mails d'un expéditeur dans un dossier. " +
        'DRY-RUN PAR DÉFAUT. Plafond : 200 mails/appel (au-delà, restreindre avec since/before).',
      inputSchema: {
        ...accountParam,
        folder: z.string().default('INBOX'),
        sender: z.string().min(1).describe("Adresse (ou fragment) de l'expéditeur."),
        since: z
          .string()
          .optional()
          .describe('Limiter aux mails après cette date ISO (pour découper les gros volumes).'),
        before: z.string().optional().describe('Limiter aux mails avant cette date ISO.'),
        confirm: z.boolean().default(false).describe('false (défaut) = dry-run. true = exécute.'),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    guard(async (args: any) => {
      const rec = await resolveAccount(args.account);
      const query: Record<string, unknown> = { from: args.sender };
      if (args.since) query.since = new Date(args.since);
      if (args.before) query.before = new Date(args.before);
      const uids = await imapService.searchUids(rec, args.folder, query as any);
      if (uids.length === 0) {
        return jsonResult({
          account: rec.account,
          folder: args.folder,
          sender: args.sender,
          dryRun: !args.confirm,
          count: 0,
          message: 'Aucun mail correspondant à cet expéditeur.',
        });
      }
      return runDelete(rec, args.folder, uids, args.confirm, 'bulk_delete_by_sender', {
        sender: args.sender,
        since: args.since,
        before: args.before,
      });
    }),
  );
}

/**
 * Logique commune de suppression avec garde-fous (SPEC §6) :
 *  - plafond 200/appel,
 *  - dry-run par défaut (retourne le résumé sans rien toucher),
 *  - soft delete (déplacement vers Trash),
 *  - journalisation JSONL.
 */
async function runDelete(
  rec: { account: string },
  folder: string,
  uids: number[],
  confirm: boolean,
  tool: string,
  extraParams: Record<string, unknown>,
) {
  const cap = config.limits.maxDeletePerCall;
  if (uids.length > cap) {
    return jsonResult({
      account: rec.account,
      folder,
      blocked: true,
      count: uids.length,
      message:
        `Plafond de sécurité dépassé : ${uids.length} > ${cap} mails. ` +
        'Découper l\'opération (ex. restreindre par date since/before).',
    });
  }

  const preview = await imapService.summarize(rec as any, folder, uids);

  if (!confirm) {
    await recordOperation({
      account: rec.account,
      tool,
      folder,
      dryRun: true,
      params: { ...extraParams, count: uids.length },
      affectedUids: uids,
      result: 'dry-run',
    });
    return jsonResult({
      account: rec.account,
      folder,
      dryRun: true,
      wouldDelete: preview.count,
      senders: preview.senders,
      sampleSubjects: preview.sampleSubjects,
      dateRange: preview.dateRange,
      uids,
      hint: 'Relancer avec confirm:true pour déplacer réellement vers la corbeille.',
    });
  }

  const res = await imapService.moveToTrash(rec as any, folder, uids);
  await recordOperation({
    account: rec.account,
    tool,
    folder,
    dryRun: false,
    params: { ...extraParams, count: uids.length },
    affectedUids: uids,
    result: `soft-deleted ${res.moved} -> ${res.destination}`,
  });
  return jsonResult({
    account: rec.account,
    folder,
    dryRun: false,
    deleted: res.moved,
    movedTo: res.destination,
    note: 'Soft delete : messages déplacés en corbeille, récupérables ~30j côté Outlook.com.',
  });
}
