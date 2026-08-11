import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateToday } from '../../services/today.js';
import { generateMailboxReport } from '../../services/report.js';
import { listPolicies, previewPolicy } from '../../services/retention.js';
import { listSuggestions } from '../../services/learning.js';
import { feedbackStats } from '../../services/quality.js';
import {
  CONFIDENCE_LEVELS,
  SENDER_CATEGORIES,
  SENDER_PRIORITIES,
  listUncertainMessages,
  setSenderCategory,
  setSenderPriority,
} from '../../services/categorize.js';
import {
  AI_ACTIONS,
  analysisProgress,
  applyVerdicts,
  nextAnalysisBatch,
  type Verdict,
} from '../../services/analysis.js';
import { MESSAGE_INTENTS } from '../../services/categorize.js';
import { resolveAccount } from '../../services/accounts.js';
import { recordOperation } from '../../services/oplog.js';
import { accountParam, guard, jsonResult } from '../util.js';

/**
 * Tools MCP « assistant » (BL1 — analyse fine via Cowork).
 * DÉCISION UTILISATEUR : l'analyse par IA se fait sur son FORFAIT Claude
 * (les sessions Cowork/claude.ai connectées à ce serveur), pas via une clé
 * API facturée à part. Ces tools complètent donc la façade MCP :
 *  - lecture : today, rapport, stratégies de rétention, suggestions, qualité ;
 *  - analyse fine : list_uncertain_messages fournit les cas que les
 *    heuristiques classent MAL (confiance faible/moyenne, B4), et Claude
 *    corrige via set_sender_category / set_sender_priority — les mécanismes
 *    EXISTANTS, journalisés et réversibles (garde-fous inchangés).
 */

const NARRATE =
  'IMPORTANT : ne pas recopier le JSON brut — le raconter en français, en ' +
  'tutoyant, de façon concise et actionnable.';

export function registerAssistTools(server: McpServer): void {
  // --- get_today -----------------------------------------------------------
  server.registerTool(
    'get_today',
    {
      title: 'Aujourd’hui (actions du jour)',
      description:
        'L’accueil « Aujourd’hui » de l’assistant, tous comptes : À FAIRE ' +
        '(réponses attendues, factures non lues, échéances dues, relances), ' +
        'IMPORTANT (top non lus ≥ 70), PEUT ATTENDRE, et le BRUIT supprimable ' +
        '(newsletters/notifications/réseaux sociaux/pubs). Calculé depuis ' +
        'l’index local — synchroniser d’abord pour des chiffres à jour. ' +
        NARRATE +
        ' Commencer par les actions (todo), finir par le bruit.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => jsonResult(await generateToday())),
  );

  // --- get_mailbox_report --------------------------------------------------
  server.registerTool(
    'get_mailbox_report',
    {
      title: 'Pourquoi ma boîte est pleine ?',
      description:
        'Rapport global : répartition par catégorie (avec %), ancienneté, top ' +
        'expéditeurs en nombre et en poids, par boîte, et « récupérable sans ' +
        'risque » (union exacte des stratégies de rétention, protections ' +
        'incluses — 0 mail personnel). ' + NARRATE,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => jsonResult(await generateMailboxReport())),
  );

  // --- list_retention_policies --------------------------------------------
  server.registerTool(
    'list_retention_policies',
    {
      title: 'Stratégies de rétention',
      description:
        'Les stratégies de rétention (OTP 7 j, livraisons 30 j, notifications ' +
        '90 j…) avec leur simulation LIVE : matchCount/matchSizeBytes (ce ' +
        'qu’elles viseraient aujourd’hui) et protectedCount (mails écartés par ' +
        'la protection centrale). enabled=false = jamais appliquée. ' +
        'L’activation/application se fait dans l’interface web — ici on ' +
        'consulte et on pré-vérifie (preview_retention_policy).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => jsonResult(await listPolicies())),
  );

  // --- preview_retention_policy -------------------------------------------
  server.registerTool(
    'preview_retention_policy',
    {
      title: 'Aperçu d’une stratégie de rétention',
      description:
        'Liste EXACTE (cap 500) des mails qu’une stratégie viserait — ' +
        'l’aperçu obligatoire avant toute action. id = celui renvoyé par ' +
        'list_retention_policies.',
      inputSchema: {
        id: z.number().int().positive().describe('Id de la stratégie (voir list_retention_policies).'),
        ...accountParam,
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { id: number; account?: string }) => {
      const account = args.account ? (await resolveAccount(args.account)).account : undefined;
      return jsonResult(await previewPolicy(args.id, account));
    }),
  );

  // --- get_learning_suggestions -------------------------------------------
  server.registerTool(
    'get_learning_suggestions',
    {
      title: 'Suggestions d’apprentissage',
      description:
        'Suggestions déduites des habitudes de l’utilisateur, chacune AVEC SA ' +
        'PREUVE : règles de classement à valider, stratégies de rétention à ' +
        'passer en automatique, priorités d’expéditeurs (⭐ toujours important ' +
        '/ 🔕 jamais urgent) déduites de la lecture. La validation se fait ' +
        'dans l’interface (écran 💡 Suggestions) ou via set_sender_priority ' +
        'après accord explicite de l’utilisateur. ' + NARRATE,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => jsonResult(await listSuggestions())),
  );

  // --- get_analysis_quality ------------------------------------------------
  server.registerTool(
    'get_analysis_quality',
    {
      title: 'Qualité de l’analyse (précision par moteur)',
      description:
        'Les % de précision par moteur d’analyse (réponses attendues, ' +
        'importants, newsletters, notifications, nettoyage), calculés à partir ' +
        'des verdicts donnés par l’utilisateur dans l’écran 🔬 Vérifier ' +
        'l’analyse. Utile pour savoir où les heuristiques se trompent.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(async () => jsonResult(await feedbackStats())),
  );

  // --- list_uncertain_messages ---------------------------------------------
  server.registerTool(
    'list_uncertain_messages',
    {
      title: 'Mails à l’analyse incertaine (à relire par Claude)',
      description:
        'Les mails que les heuristiques classent MAL ou avec doute : confiance ' +
        'faible/moyenne (B4), avec tout le contexte (intention détectée + ' +
        'raison, catégorie/priorité/volume de l’expéditeur, raison de la ' +
        'confiance). C’EST LE POINT D’ENTRÉE DE L’ANALYSE FINE : relire ces ' +
        'cas avec ton propre jugement, expliquer à l’utilisateur ce que tu ' +
        'corrigerais et pourquoi, puis — après son accord — corriger ' +
        'l’EXPÉDITEUR via set_sender_category / set_sender_priority (une ' +
        'correction d’expéditeur reclasse tous ses mails). Pour lire le ' +
        'contenu d’un mail précis : read_email.',
      inputSchema: {
        ...accountParam,
        confidence: z
          .array(z.enum(CONFIDENCE_LEVELS))
          .optional()
          .describe("Niveaux visés (défaut : ['low','medium'])."),
        limit: z.number().int().min(1).max(200).default(50).describe('Nombre de mails (cap 200).'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { account?: string; confidence?: ('high' | 'medium' | 'low')[]; limit: number }) => {
      const account = args.account ? (await resolveAccount(args.account)).account : undefined;
      return jsonResult(
        await listUncertainMessages({ account, confidence: args.confidence, limit: args.limit }),
      );
    }),
  );

  // --- set_sender_category -------------------------------------------------
  server.registerTool(
    'set_sender_category',
    {
      title: 'Corriger la catégorie d’un expéditeur',
      description:
        'Pose une catégorie MANUELLE sur un expéditeur (plus jamais écrasée ' +
        'par la sync), ou category=null pour revenir au calcul automatique. ' +
        'Réversible et journalisé. À utiliser dans le cadre d’une analyse ' +
        'fine demandée par l’utilisateur, en lui disant ce qui est corrigé et ' +
        'pourquoi. Catégories : person (personne), company, bank, insurance, ' +
        'admin, marketplace, social, newsletter, notification, ad.',
      inputSchema: {
        ...accountParam,
        email: z.string().min(3).describe('Adresse exacte de l’expéditeur.'),
        category: z
          .enum(SENDER_CATEGORIES)
          .nullable()
          .describe('Nouvelle catégorie, ou null pour revenir en automatique.'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(async (args: { account?: string; email: string; category: (typeof SENDER_CATEGORIES)[number] | null }) => {
      const rec = await resolveAccount(args.account);
      const result = await setSenderCategory(rec.account, args.email, args.category);
      await recordOperation({
        account: rec.account,
        tool: 'set_sender_category',
        params: { email: result.email, category: result.category, source: result.source },
        result: `catégorie ${result.category} (${result.source})`,
      });
      return jsonResult({ account: rec.account, ...result });
    }),
  );

  // --- set_sender_priority -------------------------------------------------
  server.registerTool(
    'set_sender_priority',
    {
      title: 'Corriger la priorité d’un expéditeur',
      description:
        'Pose la priorité par relation d’un expéditeur : always_important ' +
        '(⭐ +40 au score d’importance), never_urgent (🔕 plafond 30), ou ' +
        'normal. Jamais recalculée par la sync ; réversible (repasser à ' +
        'normal) et journalisé. À utiliser après accord de l’utilisateur.',
      inputSchema: {
        ...accountParam,
        email: z.string().min(3).describe('Adresse exacte de l’expéditeur.'),
        priority: z.enum(SENDER_PRIORITIES).describe('normal | always_important | never_urgent.'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(async (args: { account?: string; email: string; priority: (typeof SENDER_PRIORITIES)[number] }) => {
      const rec = await resolveAccount(args.account);
      const result = await setSenderPriority(rec.account, args.email, args.priority);
      await recordOperation({
        account: rec.account,
        tool: 'set_sender_priority',
        params: { email: result.email, priority: result.priority },
        result: `priorité ${result.priority}`,
      });
      return jsonResult({ account: rec.account, ...result });
    }),
  );

  // --- next_analysis_batch (C3a : le rattrapage sur le forfait) -------------
  server.registerTool(
    'next_analysis_batch',
    {
      title: 'Lot de mails à analyser',
      description:
        'LE RATTRAGE DE MASSE. Renvoie le prochain lot de mails à analyser, ' +
        'avec pour chacun un EXTRAIT DE SON TEXTE — c’est ce que les ' +
        'heuristiques n’ont jamais pu lire, d’où des milliers de mails classés ' +
        '« je ne sais pas », ni triés ni nettoyables. ' +
        'MODE D’EMPLOI : appeler ce tool, juger chaque mail à partir de son ' +
        'extrait, renvoyer les verdicts avec submit_analysis_batch, puis ' +
        'RECOMMENCER tant que `remaining` est supérieur à 0 — sans redemander ' +
        'l’autorisation entre deux lots, l’utilisateur a lancé le rattrapage. ' +
        'Les plus ANCIENS d’abord (ce sont eux qui encombrent la boîte). ' +
        'scope=uncertain (défaut) vise les cas douteux ; quand ils sont ' +
        'ÉPUISÉS, le tool bascule TOUT SEUL sur le reste des mails sans ' +
        'verdict (le champ `scope` de la réponse dit lequel a servi) — ' +
        'décision de l’utilisateur : l’IA lit TOUT, les règles se déduisent ' +
        'de ses verdicts. Un extrait « (pas de texte lisible…) » se juge sur ' +
        'le sujet et l’expéditeur, confidence=low dans le doute. ' +
        'Annonce l’avancement de temps en temps, pas à chaque lot.',
      inputSchema: {
        ...accountParam,
        scope: z
          .enum(['uncertain', 'all'])
          .default('uncertain')
          .describe('uncertain = les cas que les heuristiques ratent (défaut) ; all = tout.'),
        limit: z.number().int().min(1).max(100).default(50).describe('Mails par lot (cap 100).'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { account?: string; scope: 'uncertain' | 'all'; limit: number }) => {
      const account = args.account ? (await resolveAccount(args.account)).account : undefined;
      const [batch, progress] = await Promise.all([
        nextAnalysisBatch({ account, scope: args.scope, limit: args.limit }),
        analysisProgress(account),
      ]);
      return jsonResult({ ...batch, progress });
    }),
  );

  // --- submit_analysis_batch -----------------------------------------------
  server.registerTool(
    'submit_analysis_batch',
    {
      title: 'Renvoyer les verdicts d’analyse',
      description:
        'Enregistre ton jugement sur les mails d’un lot. Renvoyer l’`id` reçu ' +
        'tel quel. Le verdict remplit les champs que TOUS les moteurs lisent ' +
        'déjà (intention, confiance, catégorie de l’expéditeur) : une ' +
        'confiance passée de « faible » à « forte » REND le mail nettoyable, ' +
        'c’est tout l’enjeu du rattrapage. ' +
        'RÈGLES : ne juger que d’après l’extrait fourni ; dans le doute mettre ' +
        'confidence=low (le mail reste alors protégé de tout nettoyage — c’est ' +
        'le comportement sûr) ; ne poser senderCategory que si l’expéditeur est ' +
        'clairement identifiable, et « person » uniquement pour un vrai humain. ' +
        'L’IA ne supprime RIEN ici : elle classe. Une correction manuelle de ' +
        'l’utilisateur n’est jamais écrasée. Tout est journalisé et réversible. ' +
        'Les verdicts hors énumération sont refusés un par un et renvoyés dans ' +
        '`rejections` : corriger et renvoyer ceux-là seulement. ' +
        'DOSSIER (11/08) : renseigne `dossier` avec le SUJET DE VIE auquel le ' +
        'mail se rattache, en texte libre et tel que TU le lis — un bien ' +
        '(« 46 rue de la République »), une affaire (« Affaire ODAS / RG ' +
        '2025-000456 »), un véhicule, une société, un locataire, un chantier. ' +
        'Aucun vocabulaire n’est imposé : c’est précisément parce que des ' +
        'règles codées d’avance oublient les cas nouveaux que ce champ existe. ' +
        'Écris le libellé le plus STABLE et le plus court qui identifie le ' +
        'dossier (l’adresse plutôt que « travaux salle de bain 2e étage »), et ' +
        'toujours la MÊME orthographe d’un mail à l’autre — c’est ce qui les ' +
        'regroupe. Laisse VIDE si le mail ne concerne aucun dossier ' +
        'identifiable, ou s’il est trop générique (une publicité, un relevé ' +
        'bancaire courant) : mieux vaut rien qu’un dossier fourre-tout.',
      inputSchema: {
        verdicts: z
          .array(
            z.object({
              id: z.number().int().describe('L’`id` du mail, repris du lot.'),
              intent: z
                .enum(MESSAGE_INTENTS)
                .optional()
                .describe('Pourquoi ce mail a été envoyé.'),
              senderCategory: z
                .enum(SENDER_CATEGORIES)
                .nullable()
                .optional()
                .describe('Catégorie de l’EXPÉDITEUR, seulement si évidente.'),
              action: z
                .enum(AI_ACTIONS)
                .optional()
                .describe('Ce que l’utilisateur doit en faire.'),
              summary: z.string().max(300).optional().describe('Une ligne en français.'),
              confidence: z
                .enum(CONFIDENCE_LEVELS)
                .optional()
                .describe('Ta sûreté. low = le mail reste protégé.'),
              reason: z.string().max(300).optional().describe('Pourquoi, en français.'),
              dossier: z
                .string()
                .max(160)
                .nullable()
                .optional()
                .describe(
                  'Sujet de vie auquel ce mail se rattache, en TEXTE LIBRE ' +
                    '(« 46 rue de la République », « Affaire ODAS »). Même ' +
                    'orthographe d’un mail à l’autre. Vide si aucun.',
                ),
              dossierKind: z
                .enum(['bien', 'affaire', 'vehicule', 'societe', 'personne', 'autre'])
                .nullable()
                .optional()
                .describe('Nature du dossier, si elle est évidente.'),
            }),
          )
          .min(1)
          .max(100)
          .describe('Un verdict par mail jugé.'),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    guard(async (args: { verdicts: Verdict[] }) => {
      const result = await applyVerdicts(args.verdicts, { model: 'claude (session MCP)' });
      const progress = await analysisProgress();
      return jsonResult({ ...result, progress });
    }),
  );
}
