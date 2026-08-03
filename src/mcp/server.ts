import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerFolderTools } from './tools/folders.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerExportTools } from './tools/export.js';
import { registerSyncTools } from './tools/sync.js';
import { registerDeadlineTools } from './tools/deadlines.js';
import { registerAttentionTools } from './tools/attention.js';
import { registerBriefTools } from './tools/brief.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerRuleTools } from './tools/rules.js';
import { registerAssistTools } from './tools/assist.js';
import { registerRentilaTools } from './tools/rentila.js';

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
        'sont des soft deletes (corbeille). Toujours confirmer avant confirm:true. ' +
        'get_unanswered_emails / get_overdue_replies listent les mails en attente de ' +
        'réponse (avec reason) ; snooze_reply / dismiss_reply pour les reporter/ignorer. ' +
        '« Fais-moi mon brief » → generate_daily_brief (ou generate_weekly_review) puis ' +
        'raconter le résultat en français. « Qu’est-ce que j’ai à faire ? » → get_today. ' +
        '« Pourquoi ma boîte est pleine ? » → get_mailbox_report. ANALYSE FINE (sur le ' +
        'forfait de l’utilisateur) : list_uncertain_messages liste les mails que les ' +
        'heuristiques classent avec doute — les relire avec ton propre jugement, proposer ' +
        'les corrections à l’utilisateur, puis les poser via set_sender_category / ' +
        'set_sender_priority (journalisé, réversible). Toujours parler français et tutoyer.',
    },
  );

  registerAccountTools(server);
  registerFolderTools(server);
  registerReadTools(server);
  registerWriteTools(server);
  registerExportTools(server);
  registerSyncTools(server);
  registerDeadlineTools(server);
  registerAttentionTools(server);
  registerBriefTools(server);
  registerTaskTools(server);
  registerRuleTools(server);
  registerAssistTools(server);
  registerRentilaTools(server);

  return server;
}
