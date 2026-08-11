import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { recordOperation } from './oplog.js';
import {
  MESSAGE_INTENTS,
  SENDER_CATEGORIES,
  CONFIDENCE_LEVELS,
  type MessageIntent,
  type SenderCategory,
  type ConfidenceLevel,
} from './categorize.js';

/**
 * Analyse fine par l'IA (C2 — Série C).
 *
 * L'assistant ne lisait que le sujet : tout mail non reconnu tombait en
 * « confiance faible », donc ni trié ni nettoyable. Maintenant que chaque mail
 * porte un extrait de son texte (C1), une IA peut juger — et son verdict
 * DÉBLOQUE le nettoyage en remontant la confiance.
 *
 * CHOIX STRUCTURANT : le verdict s'écrit dans les champs EXISTANTS
 * (`Message.intent`, `Message.analysisConfidence`, `Sender.category`), avec une
 * source `'ai'`. Conséquence : « Aujourd'hui », les stratégies de rétention et
 * le score d'importance en profitent SANS une ligne de changement. Précédence
 * stricte : **manual > ai > auto**.
 *
 * GARDE-FOUS : l'IA ne supprime JAMAIS rien, elle classe. Elle n'écrase jamais
 * une correction manuelle. Un verdict hors énumération est refusé (le mail
 * reste simplement non analysé). Tout est journalisé et réversible.
 *
 * Deux moteurs se branchent sur `applyVerdicts`, un seul chemin d'écriture :
 *  - C3a : piloté depuis Claude via MCP (sur le forfait) — le rattrapage ;
 *  - C3b : Haiku côté serveur, sur le flux courant (à venir).
 */

export const AI_ACTIONS = ['reply', 'pay', 'read', 'archive', 'none'] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

export const AI_ACTION_LABELS: Record<AiAction, string> = {
  reply: 'à répondre',
  pay: 'à payer',
  read: 'à lire',
  archive: 'à archiver',
  none: 'rien à faire',
};

/** Portée du lot : les cas douteux d'abord, ou tout ce qui a un texte. */
export type AnalysisScope = 'uncertain' | 'all';

export interface AnalysisCandidate {
  /** Identifiant à renvoyer tel quel dans le verdict. */
  id: number;
  account: string;
  from: string;
  subject: string;
  date: string | null;
  isSeen: boolean;
  snippet: string;
  /**
   * CONTENU DES PIÈCES JOINTES (10/08). Ce qui compte ici, c'est que
   * l'expéditeur ne dit PAS de quoi parle le document : un proche qui
   * transfère le scan d'une facture Sosh reste un proche, mais le mail parle
   * d'une facture Sosh. Sans ce champ, le lot était jugé sur l'expéditeur —
   * d'où le classement « payer maman » corrigé ce jour.
   * Absent quand le mail n'a pas de pièce lisible.
   */
  attachments?: {
    /** Texte lu dans les pièces (tronqué), ou message expliquant qu'il faut les regarder. */
    text: string;
    /** true = pièce image/scannée : appelle read_attachment pour la LIRE toi-même. */
    needsVision: boolean;
  };
  /** Ce que les heuristiques croient aujourd'hui — à corriger si c'est faux. */
  guess: { intent: string | null; senderCategory: string | null; confidence: string | null };
}

export interface AnalysisBatch {
  scope: AnalysisScope;
  items: AnalysisCandidate[];
  /** Mails restant à analyser APRÈS ce lot (pour savoir s'il faut continuer). */
  remaining: number;
}

const MAX_BATCH = 100;

/**
 * Mails analysables : lecture du texte TENTÉE (snippet non null), pas encore
 * de verdict, hors rebut. Un extrait VIDE reste analysable (demande
 * utilisateur 02/08) : l'IA juge alors sur le sujet, l'expéditeur et la date —
 * c'est toujours mieux que de laisser ces mails hors de portée pour toujours.
 */
function candidateWhere(scope: AnalysisScope, account?: string) {
  return {
    isDeleted: false,
    isOutbound: false,
    folder: { is: { role: { notIn: ['trash', 'spam'] } } },
    snippet: { not: null },
    aiVerdictAt: null,
    ...(account ? { accountSlug: account } : {}),
    // « uncertain » vise ce qui bloque réellement : analyse faible/moyenne, ou
    // intention absente/générique. C'est là que l'IA change quelque chose.
    ...(scope === 'uncertain'
      ? {
          OR: [
            { analysisConfidence: { in: ['low', 'medium'] } },
            { intent: null },
            { intent: 'info' },
          ],
        }
      : {}),
  };
}

/**
 * Bloc « pièces jointes » d'un candidat. Trois cas honnêtes :
 *  - texte lu   → il est fourni (tronqué, il pèse dans le lot) ;
 *  - scan/image → on le DIT et on invite à lire la pièce (read_attachment) ;
 *  - pas encore lu → on le dit aussi, pour ne pas laisser croire qu'il n'y a
 *    rien dans la pièce alors qu'on ne l'a simplement pas encore ouverte.
 */
function attachmentPayload(r: {
  hasAttachments: boolean;
  attachmentText: string | null;
  attachmentKind: string | null;
}): { attachments?: { text: string; needsVision: boolean } } {
  if (!r.hasAttachments) return {};
  if (r.attachmentKind === 'text' && r.attachmentText) {
    // Tronqué ICI seulement : ce lot passe par le forfait de l'utilisateur, on
    // n'y verse pas un relevé de 200 Ko. Le DÉBUT du document porte l'en-tête,
    // le fournisseur et le plus souvent le total — assez pour classer ; pour
    // le reste, read_attachment donne le document entier.
    return { attachments: { text: r.attachmentText.slice(0, 2500), needsVision: false } };
  }
  if (r.attachmentKind === 'scan') {
    return {
      attachments: {
        text: "Pièce jointe scannée ou photographiée : son texte n'est pas extractible ici. Si le classement en dépend (facture ? de qui ? quel montant ?), appelle read_attachment sur ce mail pour la REGARDER.",
        needsVision: true,
      },
    };
  }
  if (r.attachmentKind === 'other') {
    return { attachments: { text: 'Pièce jointe dans un format non lu ici.', needsVision: false } };
  }
  return {
    attachments: {
      text: "Ce mail porte une pièce jointe qui n'a pas encore été lue — appelle read_attachment si son contenu change le classement.",
      needsVision: true,
    },
  };
}

/**
 * Lot suivant à analyser. Charge utile VOLONTAIREMENT compacte : c'est le
 * forfait de l'utilisateur qui paie ces jetons (C3a). Les plus ANCIENS d'abord :
 * ce sont eux qui encombrent la boîte et que le rattrapage vise.
 */
export async function nextAnalysisBatch(
  opts: { account?: string; limit?: number; scope?: AnalysisScope } = {},
): Promise<AnalysisBatch> {
  await ensureDbReady();
  let scope = opts.scope ?? 'uncertain';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_BATCH);
  let where = candidateWhere(scope, opts.account);

  // TRAITEMENT INTÉGRAL (décision utilisateur 02/08) : quand les cas douteux
  // sont épuisés, la boucle continue TOUTE SEULE sur le reste des mails sans
  // verdict — l'IA lit tout, les règles se déduisent ensuite de ses verdicts.
  if (scope === 'uncertain' && (await db.message.count({ where })) === 0) {
    scope = 'all';
    where = candidateWhere(scope, opts.account);
  }

  const [rows, total] = await Promise.all([
    db.message.findMany({
      where,
      orderBy: { date: 'asc' },
      take: limit,
      select: {
        id: true,
        accountSlug: true,
        subject: true,
        fromName: true,
        fromEmail: true,
        date: true,
        isSeen: true,
        snippet: true,
        intent: true,
        analysisConfidence: true,
        hasAttachments: true,
        attachmentText: true,
        attachmentKind: true,
      },
    }),
    db.message.count({ where }),
  ]);

  // Catégorie actuelle des expéditeurs concernés (contexte du jugement).
  const keys = [...new Set(rows.map((r) => `${r.accountSlug}|${r.fromEmail ?? ''}`))];
  const senders = new Map<string, string | null>();
  if (keys.length) {
    const emails = [...new Set(rows.map((r) => r.fromEmail).filter((e): e is string => !!e))];
    for (const s of await db.sender.findMany({
      where: { email: { in: emails } },
      select: { accountSlug: true, email: true, category: true },
    })) {
      senders.set(`${s.accountSlug}|${s.email}`, s.category);
    }
  }

  return {
    scope,
    remaining: Math.max(0, total - rows.length),
    items: rows.map((r) => ({
      id: r.id,
      account: r.accountSlug,
      from: r.fromName ? `${r.fromName} <${r.fromEmail ?? ''}>` : (r.fromEmail ?? ''),
      subject: r.subject ?? '(sans sujet)',
      date: r.date ? r.date.toISOString().slice(0, 10) : null,
      isSeen: r.isSeen,
      snippet:
        r.snippet ||
        "(pas de texte lisible dans ce mail — juge sur le sujet, l'expéditeur et la date ; dans le doute, confidence=low)",
      ...attachmentPayload(r),
      guess: {
        intent: r.intent,
        senderCategory: senders.get(`${r.accountSlug}|${r.fromEmail ?? ''}`) ?? null,
        confidence: r.analysisConfidence,
      },
    })),
  };
}

export interface Verdict {
  id: number;
  intent?: string;
  /** Catégorie de l'EXPÉDITEUR (pas du mail) — facultative. */
  senderCategory?: string | null;
  action?: string;
  /** Une ligne en français, ce que dit ce mail. */
  summary?: string;
  confidence?: string;
  /** Pourquoi — affiché tel quel à l'utilisateur. */
  reason?: string;
  /**
   * DOSSIER auquel ce mail se rattache (11/08) — libellé LIBRE, tel que
   * l'analyse le lit dans le mail : « 46 rue de la République »,
   * « Affaire ODAS », « Renault Trafic AB-123-CD », « Location Mounia ».
   *
   * C'est volontairement une chaîne libre et non une liste fermée : le
   * reproche qui a fait naître ce champ est qu'un vocabulaire codé en dur
   * « est à corriger à chaque nouveau cas et en oublie systématiquement ».
   * Le serveur ne connaît aucun dossier d'avance ; il enregistre ce que
   * l'analyse a compris.
   */
  dossier?: string | null;
  /** bien | affaire | vehicule | societe | personne | autre — facultatif. */
  dossierKind?: string | null;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  sendersUpdated: number;
  /** Motif de chaque verdict écarté, pour que l'appelant corrige son tir. */
  rejections: { id: number; why: string }[];
}

const isIntent = (v: unknown): v is MessageIntent =>
  typeof v === 'string' && (MESSAGE_INTENTS as readonly string[]).includes(v);
const isCategory = (v: unknown): v is SenderCategory =>
  typeof v === 'string' && (SENDER_CATEGORIES as readonly string[]).includes(v);
const isConfidence = (v: unknown): v is ConfidenceLevel =>
  typeof v === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(v);
const isAction = (v: unknown): v is AiAction =>
  typeof v === 'string' && (AI_ACTIONS as readonly string[]).includes(v);

/**
 * Applique des verdicts. CHEMIN D'ÉCRITURE UNIQUE des deux moteurs (MCP et
 * Haiku) : une seule logique de précédence, un seul format de journal.
 *
 * Un verdict invalide n'annule pas le lot : il est écarté avec son motif, et le
 * mail reste candidat pour plus tard. Mieux vaut un mail non analysé qu'un mail
 * mal classé — c'est la confiance qui décide s'il devient supprimable.
 */
export async function applyVerdicts(
  verdicts: Verdict[],
  opts: { model?: string } = {},
): Promise<ApplyResult> {
  await ensureDbReady();
  const model = opts.model ?? 'claude (session MCP)';
  const now = new Date();
  const out: ApplyResult = { applied: 0, skipped: 0, sendersUpdated: 0, rejections: [] };
  if (verdicts.length === 0) return out;

  const ids = verdicts.map((v) => v.id).filter((n) => Number.isInteger(n));
  const messages = new Map(
    (
      await db.message.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          accountSlug: true,
          fromEmail: true,
          subject: true,
          date: true,
          intentSource: true,
        },
      })
    ).map((m) => [m.id, m]),
  );

  const journal = new Map<string, { subject: string; date: string | null }[]>();

  for (const v of verdicts) {
    const msg = messages.get(v.id);
    if (!msg) {
      out.skipped++;
      out.rejections.push({ id: v.id, why: 'mail introuvable (supprimé ou déplacé depuis)' });
      continue;
    }
    if (msg.intentSource === 'manual') {
      out.skipped++;
      out.rejections.push({ id: v.id, why: 'corrigé à la main — une correction manuelle prime' });
      continue;
    }
    if (v.intent !== undefined && !isIntent(v.intent)) {
      out.skipped++;
      out.rejections.push({ id: v.id, why: `intention inconnue : « ${String(v.intent)} »` });
      continue;
    }
    if (v.confidence !== undefined && !isConfidence(v.confidence)) {
      out.skipped++;
      out.rejections.push({ id: v.id, why: `confiance inconnue : « ${String(v.confidence)}»` });
      continue;
    }
    if (v.action !== undefined && !isAction(v.action)) {
      out.skipped++;
      out.rejections.push({ id: v.id, why: `action inconnue : « ${String(v.action)} »` });
      continue;
    }

    const reason = (v.reason ?? '').trim().slice(0, 300);
    await db.message.update({
      where: { id: v.id },
      data: {
        ...(v.intent !== undefined
          ? {
              intent: v.intent,
              intentReason: reason ? `analyse IA : ${reason}` : 'analyse IA',
              intentSource: 'ai',
            }
          : {}),
        ...(v.confidence !== undefined
          ? {
              analysisConfidence: v.confidence,
              analysisConfidenceReason: reason ? `analyse IA : ${reason}` : 'analyse IA',
            }
          : {}),
        aiSummary: (v.summary ?? '').trim().slice(0, 300) || null,
        aiAction: v.action ?? null,
        aiVerdictAt: now,
        aiModel: model,
      },
    });
    out.applied++;

    // Rattachement au DOSSIER. Volontairement tolérant : un libellé vague ou
    // trop court est simplement ignoré (cleDossier renvoie null), sans faire
    // échouer le verdict — l'analyse n'a pas à connaître nos règles de forme.
    if (v.dossier) {
      try {
        const { rattacher } = await import('./dossiers.js');
        await rattacher({
          messageId: v.id,
          label: v.dossier,
          kind: v.dossierKind ?? undefined,
          source: 'ia',
        });
      } catch (err) {
        logger.warn('rattachement au dossier en échec', {
          id: v.id,
          error: (err as Error).message,
        });
      }
    }

    const arr = journal.get(msg.accountSlug) ?? [];
    if (arr.length < 200) {
      arr.push({ subject: msg.subject ?? '(sans sujet)', date: msg.date?.toISOString() ?? null });
    }
    journal.set(msg.accountSlug, arr);

    // Catégorie d'expéditeur : l'IA corrige toute catégorie posée
    // AUTOMATIQUEMENT (par les regex), sur un verdict sûr uniquement.
    //
    // Au départ je ne laissais remplir que la case « je ne sais pas »
    // (company/vide), par prudence. C'était trop restrictif, et ça bloquait
    // précisément ce qu'il fallait débloquer : les heuristiques classent
    // « personne » des expéditeurs comme member@hi5.com, meetic@meetic.com ou
    // postmaster@… — or « personne » est la catégorie la PLUS protectrice
    // (garantie « 0 mail personnel »), donc ces robots devenaient
    // définitivement innettoyables (constaté en réel le 29/07).
    //
    // Garde-fous conservés : une catégorie MANUELLE n'est jamais touchée, un
    // verdict IA déjà posé n'est pas rejugé (pas de valse d'un mail à
    // l'autre), et rien n'est supprimé sans aperçu ni confirmation.
    if (v.senderCategory !== undefined && v.senderCategory !== null && msg.fromEmail) {
      if (!isCategory(v.senderCategory)) {
        out.rejections.push({ id: v.id, why: `catégorie inconnue : « ${String(v.senderCategory)} »` });
      } else if (v.confidence === 'high') {
        const sender = await db.sender.findUnique({
          where: { accountSlug_email: { accountSlug: msg.accountSlug, email: msg.fromEmail } },
          select: { id: true, category: true, categorySource: true },
        });
        if (sender && sender.categorySource === 'auto') {
          await db.sender.update({
            where: { id: sender.id },
            data: {
              category: v.senderCategory,
              categorySource: 'ai',
              categoryReason: reason ? `analyse IA : ${reason}` : 'analyse IA',
            },
          });
          out.sendersUpdated++;
        }
      }
    }
  }

  for (const [account, items] of journal) {
    await recordOperation({
      account,
      tool: 'ai_analysis',
      params: { model, verdicts: items.length },
      result: `${items.length} mail(s) analysés par l'IA`,
      items,
    });
  }
  logger.info('verdicts IA appliqués', {
    applied: out.applied,
    skipped: out.skipped,
    senders: out.sendersUpdated,
  });
  return out;
}

export interface AnalysisProgress {
  /** Mails porteurs d'un texte exploitable (matière première de l'analyse). */
  withText: number;
  analysed: number;
  /** Restant dans la portée « cas douteux ». */
  remainingUncertain: number;
  /** Restant si on analyse TOUT ce qui a un texte. */
  remainingAll: number;
  pct: number;
}

/** Avancement de l'analyse IA, pour l'interface et pour piloter le rattrapage. */
export async function analysisProgress(account?: string): Promise<AnalysisProgress> {
  await ensureDbReady();
  // Même base que candidateWhere : lecture TENTÉE (extrait vide inclus) —
  // sinon les compteurs « restants » et « analysables » divergent.
  const base = {
    isDeleted: false,
    isOutbound: false,
    folder: { is: { role: { notIn: ['trash', 'spam'] } } },
    snippet: { not: null },
    ...(account ? { accountSlug: account } : {}),
  };
  const [withText, analysed, remainingUncertain, remainingAll] = await Promise.all([
    db.message.count({ where: base }),
    db.message.count({ where: { ...base, aiVerdictAt: { not: null } } }),
    db.message.count({ where: candidateWhere('uncertain', account) }),
    db.message.count({ where: candidateWhere('all', account) }),
  ]);
  return {
    withText,
    analysed,
    remainingUncertain,
    remainingAll,
    pct: withText === 0 ? 0 : Math.round((analysed / withText) * 100),
  };
}

export interface AccountAnalysisProgress extends AnalysisProgress {
  account: string;
}

/**
 * Avancement de l'analyse IA PAR BOÎTE (retour utilisateur 01/08) : le
 * rattrapage annonçait « il reste 4 500 mails » (portée « cas douteux » d'une
 * boîte) pendant que Paramètres affichait « 42 % analysés » (global) — deux
 * vérités, aucun moyen de les rapprocher. Ici, les quatre compteurs par boîte,
 * en 4 requêtes groupBy au total (et non 4 × N boîtes).
 */
export async function analysisProgressByAccount(): Promise<AccountAnalysisProgress[]> {
  await ensureDbReady();
  // Même base que candidateWhere (extrait vide inclus) — voir analysisProgress.
  const base = {
    isDeleted: false,
    isOutbound: false,
    folder: { is: { role: { notIn: ['trash', 'spam'] } } },
    snippet: { not: null },
  };
  const group = (where: object) =>
    db.message.groupBy({ by: ['accountSlug'], where, _count: { _all: true } });
  const [withText, analysed, remUncertain, remAll] = await Promise.all([
    group(base),
    group({ ...base, aiVerdictAt: { not: null } }),
    group(candidateWhere('uncertain')),
    group(candidateWhere('all')),
  ]);
  const toMap = (rows: { accountSlug: string; _count: { _all: number } }[]) =>
    new Map(rows.map((r) => [r.accountSlug, r._count._all]));
  const mWithText = toMap(withText);
  const mAnalysed = toMap(analysed);
  const mUncertain = toMap(remUncertain);
  const mAll = toMap(remAll);
  const slugs = new Set([...mWithText.keys(), ...mUncertain.keys(), ...mAll.keys()]);
  return [...slugs].sort().map((account) => {
    const wt = mWithText.get(account) ?? 0;
    const an = mAnalysed.get(account) ?? 0;
    return {
      account,
      withText: wt,
      analysed: an,
      remainingUncertain: mUncertain.get(account) ?? 0,
      remainingAll: mAll.get(account) ?? 0,
      pct: wt === 0 ? 0 : Math.round((an / wt) * 100),
    };
  });
}
