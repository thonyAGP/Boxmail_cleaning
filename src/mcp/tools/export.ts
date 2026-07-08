import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveAccount } from '../../services/accounts.js';
import { toVCard, toOutlookCsv, type SenderContact } from '../../services/export.js';
import { accountParam, guard, fileResult } from '../util.js';

export function registerExportTools(server: McpServer): void {
  server.registerTool(
    'export_senders_vcard',
    {
      title: 'Exporter des expéditeurs (vCard/CSV)',
      description:
        'Génère un fichier vCard 3.0 (.vcf) et/ou CSV Outlook à partir d\'une liste ' +
        "d'expéditeurs (adresse + nom affiché), à importer manuellement dans les " +
        'Contacts Outlook.com (non accessibles via IMAP). Retourne le contenu texte.',
      inputSchema: {
        ...accountParam,
        senders: z
          .array(
            z.object({
              address: z.string().email().describe('Adresse email.'),
              name: z.string().optional().describe('Nom affiché.'),
            }),
          )
          .min(1)
          .max(2000)
          .describe('Expéditeurs à exporter.'),
        format: z
          .enum(['vcard', 'csv', 'both'])
          .default('vcard')
          .describe('Format de sortie (défaut vcard).'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      async ({
        account,
        senders,
        format,
      }: {
        account?: string;
        senders: SenderContact[];
        format: 'vcard' | 'csv' | 'both';
      }) => {
        // resolveAccount valide juste qu'un contexte compte existe (cohérence),
        // l'export lui-même ne touche pas IMAP.
        const rec = await resolveAccount(account).catch(() => null);
        const label = rec?.account ?? 'export';

        if (format === 'vcard') {
          return fileResult(`${label}-senders.vcf`, 'text/vcard', toVCard(senders));
        }
        if (format === 'csv') {
          return fileResult(`${label}-senders.csv`, 'text/csv', toOutlookCsv(senders));
        }
        // both
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `=== ${label}-senders.vcf (text/vcard) ===\n\n${toVCard(senders)}\n\n` +
                `=== ${label}-senders.csv (text/csv) ===\n\n${toOutlookCsv(senders)}`,
            },
          ],
        };
      },
    ),
  );
}
