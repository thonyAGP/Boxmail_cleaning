import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  avancementQualification,
  enregistrerQualifications,
  prochainsDossiers,
  type Qualif,
} from '../../services/qualification.js';
import { guard, jsonResult } from '../util.js';

/**
 * LA BOUCLE DE SUIVI : trois tools, le même patron que le rattrapage
 * d'analyse — un vivier servi par lots, un agent qui lit, des verdicts rendus.
 *
 * Ce que ces tools font et que l'analyse mail-par-mail ne fera jamais : juger
 * une HISTOIRE. « Facture reçue » n'est pas une information ; « facture reçue,
 * relancée deux fois, jamais payée, 982 jours » en est une.
 */
export function registerQualificationTools(server: McpServer): void {
  // --- next_dossiers_batch --------------------------------------------------
  server.registerTool(
    'next_dossiers_batch',
    {
      title: 'Lot de dossiers à qualifier',
      description:
        "LE SUIVI DES AFFAIRES. Renvoie les fils que le détecteur mécanique " +
        'juge anormaux — quelqu’un a relancé sans réponse, une échéance est ' +
        'passée, de l’argent est engagé sans contrepartie — avec de quoi les ' +
        'LIRE : début et fin de l’histoire, extraits, obligations déjà ' +
        'extraites, et la raison mécanique du signalement. ' +
        'CE QU’ON TE DEMANDE, ET C’EST TOUT : dire si un SUIVI est nécessaire. ' +
        'Le détecteur voit « échéance dépassée depuis 982 jours » ; il ne sait ' +
        'pas lire que la facture a été réglée par virement le mois suivant et ' +
        'que le fil n’a jamais été clos. Toi si. ' +
        'MODE D’EMPLOI IMPÉRATIF : appeler ce tool, juger CHAQUE dossier, ' +
        'renvoyer les verdicts avec submit_dossiers_batch, puis RECOMMENCER ' +
        'immédiatement jusqu’à `restants` = 0 ou jusqu’au nombre demandé. ' +
        'Ne redemande pas l’autorisation entre deux lots. ' +
        'MAIS AU-DELÀ D’UNE TRENTAINE DE DOSSIERS DANS LA MÊME CONVERSATION, ' +
        'ARRÊTE-TOI ET DIS-LE : un dossier pèse plusieurs messages, la ' +
        'conversation cumule les lots et finit par tomber. Un gros volume se ' +
        'fait avec un contexte NEUF par lot (un sous-agent par lot). ' +
        'TROIS VERDICTS POSSIBLES. `attente` : il reste quelque chose à faire ' +
        'ou à obtenir — décris-la. `rien` : classé, réglé, ou sans objet — ' +
        'DIS POURQUOI en `motif`, sinon on ne saura pas distinguer « déjà ' +
        'payé » de « pas compris ». `doute` : les extraits ne suffisent pas ' +
        '(dans ce cas seulement, read_email sur le dernier message peut ' +
        'trancher). ' +
        'PRUDENCE SUR LE SENS. `direction` dit qui doit de l’argent à qui, ' +
        'quand on le sait : « du-a-moi » signifie que c’est une facture qu’IL ' +
        'a émise — ce n’est pas une dette de sa part. `correspondants` > 3 ' +
        'signale un faux fil (des inconnus regroupés sous un même « Re: ») : ' +
        'conclus `rien` avec le motif. ' +
        'Le silence ne prouve rien hors d’une demande d’argent : un créancier ' +
        'qui se tait a souvent été payé, mais celui qui attend une signature ' +
        'classe le dossier et n’insiste pas. ' +
        'Tu écris pour LUI : `quoi` et `pourquoi` s’afficheront tels quels, ' +
        'en français, en le tutoyant, avec des dates vérifiables.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(15)
          .default(8)
          .describe(
            'Dossiers par lot (défaut 8, cap 15). Chacun porte jusqu’à 7 ' +
              'messages avec extraits : ne demande pas plus en espérant aller ' +
              'plus vite, la conversation cumule et tombe.',
          ),
        seuil: z
          .number()
          .int()
          .min(0)
          .max(300)
          .default(50)
          .describe('Score minimal du détecteur (défaut 50). Plus bas = plus de bruit.'),
        compte: z
          .string()
          .optional()
          .describe('Se limiter à une boîte (slug), par exemple « Brimmo ».'),
      },
    },
    guard(async (args: { limit: number; seuil: number; compte?: string }) => {
      const lot = await prochainsDossiers({
        limite: args.limit,
        seuil: args.seuil,
        compte: args.compte,
      });
      return jsonResult(lot);
    }),
  );

  // --- submit_dossiers_batch ------------------------------------------------
  server.registerTool(
    'submit_dossiers_batch',
    {
      title: 'Renvoyer les qualifications',
      description:
        'Enregistre ton jugement sur les dossiers d’un lot. Renvoyer le ' +
        '`threadId` reçu tel quel. ' +
        'CHAQUE dossier servi doit revenir, y compris ceux que tu classes — ' +
        'sans ça il te sera resservi indéfiniment et le vivier ne se videra ' +
        'jamais. Une fois qualifié, un fil ne revient QUE si un nouveau ' +
        'message y arrive : c’est ce qui permettra de dire « c’est le 3e ' +
        'rappel » au lieu de rejuger l’histoire à zéro. ' +
        'Une attente déjà traitée par l’utilisateur n’est jamais écrasée. ' +
        'RIEN N’EST SUPPRIMÉ ICI, rien n’est envoyé : on note ce qu’il y a à ' +
        'suivre, il décide.',
      inputSchema: {
        qualifications: z
          .array(
            z.object({
              threadId: z.number().int().positive().describe('Le `threadId` reçu dans le lot.'),
              verdict: z
                .enum(['attente', 'rien', 'doute'])
                .describe(
                  'attente = il reste quelque chose à suivre · rien = classé · ' +
                    'doute = les extraits ne suffisent pas.',
                ),
              motif: z
                .string()
                .max(300)
                .optional()
                .describe(
                  'OBLIGATOIRE quand le verdict est « rien » ou « doute » : ' +
                    'pourquoi. C’est ce qui distingue « déjà payé le 12/03 » ' +
                    'de « je n’ai pas compris ».',
                ),
              attente: z
                .object({
                  cote: z
                    .enum(['moi', 'eux'])
                    .describe(
                      'moi = c’est à LUI de faire quelque chose · eux = il ' +
                        'attend quelque chose du correspondant.',
                    ),
                  quoi: z
                    .string()
                    .max(200)
                    .describe(
                      'Ce qui est attendu, en une phrase affichée telle ' +
                        'quelle : « Régler 418 € à l’URSSAF avant le 29 août ».',
                    ),
                  qui: z.string().max(160).describe('Le correspondant, tel qu’il s’affichera.'),
                  importance: z
                    .enum(['haute', 'moyenne', 'faible'])
                    .optional()
                    .describe('Ce que ça coûte de ne rien faire.'),
                  urgence: z
                    .enum(['critique', 'haute', 'moyenne', 'faible'])
                    .optional()
                    .describe(
                      'À quelle VITESSE ça coûte — c’est un axe distinct de ' +
                        'l’importance. « critique » se réserve à ce qui se ' +
                        'ferme (prescription, poursuites annoncées, dépôt légal).',
                    ),
                  pourquoi: z
                    .string()
                    .max(600)
                    .describe(
                      'La justification AFFICHÉE, en le tutoyant, avec les ' +
                        'dates : « Tu as contesté le 25 avril 2024, ils se ' +
                        'sont engagés par écrit à répondre sous deux mois. » ' +
                        'Vérifiable, jamais un score.',
                    ),
                  risque: z
                    .string()
                    .max(300)
                    .optional()
                    .describe('Ce qui rend l’attente urgente, quand elle l’est. Vide sinon.'),
                  dueAt: z.string().optional().describe('Échéance ISO (AAAA-MM-JJ), si elle existe.'),
                  montant: z.number().optional().describe('Montant en euros, si le sujet en porte un.'),
                })
                .optional()
                .describe('Obligatoire quand le verdict est « attente ».'),
            }),
          )
          .min(1)
          .max(30)
          .describe('Une qualification par dossier servi.'),
      },
    },
    guard(async (args: { qualifications: Qualif[] }) => {
      const res = await enregistrerQualifications(args.qualifications);
      const avancement = await avancementQualification();
      return jsonResult({ ...res, avancement });
    }),
  );

  // --- qualification_progress ----------------------------------------------
  server.registerTool(
    'qualification_progress',
    {
      title: 'Avancement du suivi des affaires',
      description:
        'Combien de fils le détecteur signale, combien ont été lus, combien ' +
        'restent, et combien d’attentes en sont sorties. Lecture seule.',
      inputSchema: {},
    },
    guard(async () => jsonResult(await avancementQualification())),
  );
}
