import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerFolderTools } from './tools/folders.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerExportTools } from './tools/export.js';

/**
 * Construit une instance McpServer avec tous les tools enregistrés.
 * Une instance est créée par session HTTP (voir index.ts).
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'boxmail-mcp',
      version: '1.0.0',
    },
    {
      instructions:
        "Serveur de tri/nettoyage de boîtes mail Outlook.com/Hotmail (IMAP). " +
        'Utiliser get_sender_stats pour repérer les gros expéditeurs et newsletters, ' +
        'puis bulk_delete_by_sender (dry-run par défaut) pour nettoyer. Les suppressions ' +
        'sont des soft deletes (corbeille). Toujours confirmer avant confirm:true.',
    },
  );

  registerAccountTools(server);
  registerFolderTools(server);
  registerReadTools(server);
  registerWriteTools(server);
  registerExportTools(server);

  return server;
}
