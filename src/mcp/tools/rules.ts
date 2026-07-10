import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  suggestRules,
  listRules,
  previewRule,
  applyRule,
  updateRule,
} from '../../services/rules.js';
import { resolveAccount } from '../../services/accounts.js';
import { guard, jsonResult } from '../util.js';

/**
 * Tools MCP « règles de classement » (L7 — Rule Engine SPEC V2).
 * GARDE-FOU : une suggestion n'est jamais appliquée sans validation ;
 * apply_mail_rule exige confirm=true et journalise la liste exacte.
 */

export function registerRuleTools(server: McpServer): void {
  server.registerTool(
    'suggest_mail_rules',
    {
      title: 'Suggérer des règles de classement',
      description:
        "Analyse l'index d'une boîte et PROPOSE des règles de classement (« si expéditeur X → " +
        'déplacer vers le dossier Y ») : rangements déjà faits à la main à automatiser, grosses ' +
        "newsletters à isoler. Ne déplace RIEN — les suggestions attendent la validation de " +
        "l'utilisateur. Narrer les suggestions en français (tutoyer), ne pas recopier le JSON.",
      inputSchema: {
        account: z.string().describe('Nom de la boîte (slug).'),
      },
    },
    guard(async (args: { account: string }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await suggestRules(rec.account));
    }),
  );

  server.registerTool(
    'list_mail_rules',
    {
      title: 'Lister les règles de classement',
      description:
        "Liste les règles d'une boîte (suggérées / actives / en pause) avec, pour chacune, le " +
        'nombre de mails de la boîte de réception qui matchent en ce moment (pendingCount). ' +
        'Lecture seule.',
      inputSchema: {
        account: z.string().describe('Nom de la boîte (slug).'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { account: string }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult({ rules: await listRules(rec.account) });
    }),
  );

  server.registerTool(
    'preview_mail_rule',
    {
      title: "Aperçu d'une règle",
      description:
        'Montre les mails de la boîte de réception qui seraient déplacés par une règle (cap 500, ' +
        'sujets + dates). Lecture seule — à présenter à l\'utilisateur AVANT toute application.',
      inputSchema: {
        account: z.string().describe('Nom de la boîte (slug).'),
        ruleId: z.number().int().positive().describe('Id de la règle.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { account: string; ruleId: number }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(await previewRule(rec.account, args.ruleId));
    }),
  );

  server.registerTool(
    'apply_mail_rule',
    {
      title: 'Appliquer une règle (déplacement)',
      description:
        'Déplace les mails matchés vers le dossier cible de la règle (créé au besoin). ' +
        "ACTION D'ÉCRITURE : exiger confirm=true après avoir montré l'aperçu à l'utilisateur. " +
        'Déplacement uniquement (jamais de suppression), lots de 200, tout est journalisé. ' +
        'La règle suggérée devient active.',
      inputSchema: {
        account: z.string().describe('Nom de la boîte (slug).'),
        ruleId: z.number().int().positive().describe('Id de la règle.'),
        confirm: z
          .boolean()
          .default(false)
          .describe("true UNIQUEMENT après validation explicite de l'utilisateur."),
      },
    },
    guard(async (args: { account: string; ruleId: number; confirm: boolean }) => {
      const rec = await resolveAccount(args.account);
      if (!args.confirm) {
        const preview = await previewRule(rec.account, args.ruleId);
        return jsonResult({
          dryRun: true,
          message:
            `${preview.total} mails seraient déplacés vers « ${preview.rule.targetFolder} ». ` +
            'Repasser avec confirm=true après validation de l\'utilisateur.',
          preview,
        });
      }
      return jsonResult(await applyRule(rec, args.ruleId, { tool: 'apply_mail_rule' }));
    }),
  );

  server.registerTool(
    'set_mail_rule_status',
    {
      title: "Changer l'état d'une règle",
      description:
        "Valide (active), met en pause (paused) ou règle l'application automatique d'une règle. " +
        "GARDE-FOU : autoApply=true exige une règle active — c'est l'utilisateur qui décide.",
      inputSchema: {
        account: z.string().describe('Nom de la boîte (slug).'),
        ruleId: z.number().int().positive().describe('Id de la règle.'),
        status: z.enum(['active', 'paused']).optional().describe('Nouvel état (optionnel).'),
        autoApply: z
          .boolean()
          .optional()
          .describe('Application automatique à chaque synchronisation (optionnel).'),
      },
    },
    guard(async (args: { account: string; ruleId: number; status?: 'active' | 'paused'; autoApply?: boolean }) => {
      const rec = await resolveAccount(args.account);
      return jsonResult(
        await updateRule(rec.account, args.ruleId, {
          status: args.status,
          autoApply: args.autoApply,
        }),
      );
    }),
  );
}
