import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveAccount } from '../../services/accounts.js';
import { imapService } from '../../services/imap.js';
import { recordOperation } from '../../services/oplog.js';
import { accountParam, guard, jsonResult } from '../util.js';

export function registerFolderTools(server: McpServer): void {
  server.registerTool(
    'list_folders',
    {
      title: 'Lister les dossiers',
      description: "Arborescence des dossiers IMAP du compte (path, nom, usage spécial).",
      inputSchema: { ...accountParam },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ account }: { account?: string }) => {
      const rec = await resolveAccount(account);
      const folders = await imapService.listFolders(rec);
      return jsonResult({ account: rec.account, count: folders.length, folders });
    }),
  );

  server.registerTool(
    'create_folder',
    {
      title: 'Créer un dossier',
      description: 'Crée un dossier IMAP. Le chemin peut inclure le délimiteur parent.',
      inputSchema: {
        ...accountParam,
        path: z.string().min(1).describe("Chemin du dossier à créer (ex. 'Factures')."),
      },
      annotations: { destructiveHint: false },
    },
    guard(async ({ account, path }: { account?: string; path: string }) => {
      const rec = await resolveAccount(account);
      const res = await imapService.createFolder(rec, path);
      await recordOperation({
        account: rec.account,
        tool: 'create_folder',
        params: { path },
        result: res.created ? 'created' : 'exists',
      });
      return jsonResult({ account: rec.account, ...res });
    }),
  );
}
