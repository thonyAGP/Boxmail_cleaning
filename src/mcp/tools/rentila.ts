import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { pendingRentilaCommands, reportRentilaCommand } from '../../services/rentila-commands.js';
import { guard, jsonResult } from '../util.js';

/**
 * Tools MCP « commandes Rentila » (connecteur phase 2, 03/08).
 *
 * Boxmail prépare des ordres depuis les mails ; l'utilisateur les VALIDE dans
 * l'interface ; Claude — qui a AUSSI le connecteur MCP Rentila dans sa
 * session — les exécute chez Rentila puis rapporte le résultat ici. Aucun
 * identifiant Rentila ne vit côté Boxmail.
 */

export function registerRentilaTools(server: McpServer): void {
  server.registerTool(
    'rentila_pending_commands',
    {
      title: 'Commandes Rentila en attente',
      description:
        "Les commandes Rentila VALIDÉES par l'utilisateur dans Boxmail, en attente d'exécution. " +
        "MODE D'EMPLOI : exécuter chaque commande via le connecteur MCP Rentila de la session, " +
        'puis rapporter le résultat avec rentila_command_result (OBLIGATOIRE, succès comme échec). ' +
        'Recettes par type : ' +
        "『mark_rent_paid』 params {tenantName, tenantEmail?, amount?, paidDate?, sendReceipt?, note?} → " +
        'retrouver le locataire (search/query_tenants), lister ses loyers impayés (query_payments ' +
        'payment_type=rent, payment_status=pending, tenant_id=…), identifier LE bon loyer (montant/période) ; ' +
        'si un doute subsiste (plusieurs candidats, montant différent), NE RIEN pointer et rapporter ' +
        "l'ambiguïté en échec ; sinon change_payment_status(status=2, received_date=paidDate) — partiel " +
        '(status=1 + partial_amount) si amount < total — puis, si sendReceipt, send_payment_receipt. ' +
        "『create_task』 params {title, dueDate?, note?} → create_task côté Rentila. " +
        "Toujours répondre en français à l'utilisateur avec ce qui a été fait, et ne JAMAIS improviser " +
        "une action non décrite par la commande. Lecture seule ici (l'écriture se fait chez Rentila).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => jsonResult({ commands: await pendingRentilaCommands() })),
  );

  server.registerTool(
    'rentila_command_result',
    {
      title: "Rapporter l'exécution d'une commande Rentila",
      description:
        "Enregistre le résultat d'une commande Rentila exécutée (ou tentée) via le connecteur. " +
        'À appeler UNE FOIS par commande, succès comme échec — le résultat apparaît dans ' +
        "l'interface Boxmail et le journal. `ok=false` avec une explication claire vaut mieux " +
        "qu'un pointage hasardeux.",
      inputSchema: {
        id: z.number().int().min(1).describe('Identifiant de la commande (champ id).'),
        ok: z.boolean().describe('true = exécutée chez Rentila, false = échec/ambiguïté.'),
        result: z
          .string()
          .min(1)
          .max(1000)
          .describe("Compte rendu en français (ce qui a été fait, ou pourquoi c'est un échec)."),
      },
    },
    guard(async (args: { id: number; ok: boolean; result: string }) =>
      jsonResult(await reportRentilaCommand(args.id, { ok: args.ok, result: args.result }))),
  );
}
