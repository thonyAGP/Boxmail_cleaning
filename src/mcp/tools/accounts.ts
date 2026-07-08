import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listAccountNames, getAccountRecord, tokenStatus } from '../../services/accounts.js';
import { accountParam, guard, jsonResult } from '../util.js';

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'Lister les comptes',
      description:
        "Liste les comptes mail enrôlés et l'état de santé de leur token OAuth " +
        '(sans jamais exposer le token). Aucun paramètre requis.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => {
      const names = await listAccountNames();
      const accounts = [];
      for (const name of names) {
        const rec = await getAccountRecord(name);
        if (!rec) continue;
        const status = await tokenStatus(rec);
        accounts.push({
          account: name,
          username: rec.username,
          enrolledAt: rec.enrolledAt,
          updatedAt: rec.updatedAt,
          tokenOk: status.ok,
          tokenExpiresOn: status.expiresOn,
          ...(status.error ? { tokenError: status.error } : {}),
        });
      }
      return jsonResult({ count: accounts.length, accounts });
    }),
  );
}
