import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateBrief } from '../../services/brief.js';
import { guard, jsonResult } from '../util.js';

/**
 * Tools MCP « brief » — Phase 8 (L5) : brief quotidien & revue hebdo.
 * Le tool renvoie un JSON structuré (index local, instantané) que Claude
 * doit ensuite raconter en français — voir les descriptions.
 */

const briefParams = {
  accounts: z
    .array(z.string())
    .optional()
    .describe('Comptes à couvrir (défaut : tous les comptes enrôlés).'),
  topLimit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Nombre d\'éléments détaillés par rubrique (défaut 5).'),
};

const NARRATE =
  'IMPORTANT : ne pas recopier le JSON brut — le RACONTER en français, en ' +
  'tutoyant, de façon concise et actionnable : commencer par l\'essentiel ' +
  '(urgences, échéances proches, mails importants), puis les réponses/relances ' +
  'en retard avec les correspondants concernés, et finir par la volumétrie et ' +
  'le nettoyage possible. Mentionner les comptes ignorés (skippedAccounts) ' +
  'seulement s\'il y en a. Chaque brief est archivé (champ previousBrief = ' +
  'écart depuis le précédent).';

export function registerBriefTools(server: McpServer): void {
  server.registerTool(
    'generate_daily_brief',
    {
      title: 'Brief quotidien',
      description:
        'Génère le brief du jour, tous comptes : nouveaux mails des dernières 24 h, ' +
        'mails importants non lus (score ≥ 60), réponses en attente en retard, relances ' +
        'à faire, échéances sous 14 jours, nettoyage possible et volumétrie par compte. ' +
        "Calculé depuis l'index local (synchroniser d'abord pour des chiffres à jour). " +
        NARRATE,
      inputSchema: briefParams,
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { accounts?: string[]; topLimit: number }) =>
      jsonResult(
        await generateBrief({ type: 'daily', accounts: args.accounts, topLimit: args.topLimit }),
      ),
    ),
  );

  server.registerTool(
    'generate_weekly_review',
    {
      title: 'Revue hebdomadaire',
      description:
        'Génère la revue de la semaine, tous comptes : nouveaux mails des 7 derniers ' +
        'jours, mails importants non lus du mois (score ≥ 60), réponses et relances en ' +
        'retard, échéances sous 14 jours, nettoyage possible et volumétrie par compte. ' +
        "Calculé depuis l'index local (synchroniser d'abord pour des chiffres à jour). " +
        NARRATE +
        ' Pour la revue hebdo, prendre du recul : tendances, gros volumes, à planifier.',
      inputSchema: briefParams,
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { accounts?: string[]; topLimit: number }) =>
      jsonResult(
        await generateBrief({ type: 'weekly', accounts: args.accounts, topLimit: args.topLimit }),
      ),
    ),
  );
}
