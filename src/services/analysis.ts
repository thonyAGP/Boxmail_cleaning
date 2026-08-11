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
import {
  zVerdict,
  deplier,
  projeterVersLegacy,
  SCHEMA_VERSION,
  type Verdict as VerdictSemantique,
} from './verdict.js';
import { documentHints } from './attachment-text.js';

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
  /**
   * Dossier et UID (11/08). Sans eux, l'invitation « appelle read_attachment
   * sur ce mail » était impossible à suivre : le lot ne portait que l'id
   * interne, alors que read_email et read_attachment prennent (compte,
   * dossier, uid). Le tool disait « approfondis si tu hésites » sans donner
   * de quoi le faire.
   */
  folder: string;
  uid: number;
  from: string;
  /**
   * À qui le mail est adressé, et surtout le RÔLE du compte : destinataire
   * direct, ou simplement présent dans la diffusion. Un mail où Anthony n'est
   * pas destinataire n'attend presque jamais de réponse de lui — c'est une
   * des deux informations les plus rentables qu'on ne lui envoyait pas.
   */
  to: { addresses: string[]; accountRole: 'direct' | 'non_liste' | 'inconnu' };
  subject: string;
  date: string | null;
  isSeen: boolean;
  /** Le texte préparé pour l'analyse (2 200 caractères choisis), ou l'extrait. */
  snippet: string;
  /**
   * Noms des pièces jointes. Trois mots qui portent un signal énorme :
   * `FACTURE_SOSH_052026.pdf` dit l'émetteur, la nature et la période.
   */
  attachmentNames?: string[];
  /**
   * Ce que le serveur a déjà déduit localement des pièces (fournisseur,
   * montant TTC, numéro de facture). C'était calculé puis JETÉ : le serveur
   * savait « Sosh, 42,30 €, facture n° X » et ne le mettait pas dans le lot.
   */
  documentHints?: { supplier?: string; amountTtc?: number; invoiceNumber?: string };
  /**
   * Le fil, en métadonnées et non en messages : combien d'échanges, et
   * surtout A-T-IL RÉPONDU APRÈS ce mail. C'est ce qui distingue « en
   * attente » de « déjà traité », sans envoyer un octet de plus.
   */
  thread?: { messageCount: number; repliedAfter: boolean };
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
/**
 * Répartit un budget de caractères entre les pièces d'un mail, au lieu de le
 * laisser consommer par la première.
 *
 * Le texte stocké a la forme `--- nom ---\n<contenu>`, les pièces séparées par
 * une ligne vide. On rend à chacune une part égale, en signalant ce qui a été
 * coupé — l'IA doit savoir qu'elle ne voit pas tout pour pouvoir déclarer
 * `truncated_input` plutôt que d'affirmer à tort.
 */
function repartirTexteDesPieces(texte: string, budget: number): string {
  if (texte.length <= budget) return texte;
  const blocs = texte.split(/\n\n(?=--- )/);
  if (blocs.length <= 1) return `${texte.slice(0, budget).trimEnd()}\n[…]`;
  const part = Math.max(200, Math.floor(budget / blocs.length));
  return blocs
    .map((b) => (b.length <= part ? b : `${b.slice(0, part).trimEnd()}\n[…]`))
    .join('\n\n');
}

function attachmentPayload(r: {
  hasAttachments: boolean;
  attachmentText: string | null;
  attachmentKind: string | null;
}): { attachments?: { text: string; needsVision: boolean } } {
  if (!r.hasAttachments) return {};
  if (r.attachmentKind === 'text' && r.attachmentText) {
    // Le budget est RÉPARTI entre les pièces, il n'est plus consommé par la
    // première. Sur un mail à quatre pièces, l'en-tête « --- logo.png --- »
    // puis le début du premier document épuisaient les 2 500 caractères : les
    // pièces 2 à n étaient invisibles à l'analyse alors qu'elles étaient en
    // base. Le DÉBUT de chaque document porte l'émetteur et le plus souvent le
    // total — assez pour classer ; read_attachment donne le reste.
    return {
      attachments: { text: repartirTexteDesPieces(r.attachmentText, 2500), needsVision: false },
    };
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
        uid: true,
        folder: { select: { path: true } },
        threadId: true,
        subject: true,
        fromName: true,
        fromEmail: true,
        toEmails: true,
        date: true,
        isSeen: true,
        snippet: true,
        analysisInput: true,
        intent: true,
        analysisConfidence: true,
        hasAttachments: true,
        attachmentNames: true,
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

  // Adresse de chaque compte : sert à dire si Anthony est destinataire direct.
  const adresses = new Map(
    (await db.account.findMany({ select: { slug: true, emailAddress: true } })).map((a) => [
      a.slug,
      a.emailAddress.toLowerCase(),
    ]),
  );

  // Le fil, en deux requêtes pour tout le lot — jamais une par mail. On veut
  // deux choses seulement : la taille du fil, et « a-t-il répondu APRÈS ».
  const threadIds = [...new Set(rows.map((r) => r.threadId).filter((t): t is number => t !== null))];
  const tailleFil = new Map<number, number>();
  const sortantsParFil = new Map<number, Date[]>();
  if (threadIds.length) {
    for (const t of await db.thread.findMany({
      where: { id: { in: threadIds } },
      select: { id: true, messageCount: true },
    })) {
      tailleFil.set(t.id, t.messageCount);
    }
    for (const m of await db.message.findMany({
      where: { threadId: { in: threadIds }, isOutbound: true, date: { not: null } },
      select: { threadId: true, date: true },
    })) {
      if (m.threadId === null || m.date === null) continue;
      sortantsParFil.set(m.threadId, [...(sortantsParFil.get(m.threadId) ?? []), m.date]);
    }
  }

  return {
    scope,
    remaining: Math.max(0, total - rows.length),
    items: rows.map((r) => {
      const destinataires = lireDestinataires(r.toEmails);
      const moi = adresses.get(r.accountSlug);
      const accountRole: 'direct' | 'non_liste' | 'inconnu' =
        destinataires.length === 0
          ? 'inconnu'
          : moi && destinataires.some((d) => d.includes(moi))
            ? 'direct'
            : 'non_liste';

      const noms = (r.attachmentNames ?? '').split('\n').map((n) => n.trim()).filter(Boolean);
      const indices =
        r.attachmentKind === 'text' && r.attachmentText ? documentHints(r.attachmentText) : null;

      const repondu =
        r.threadId !== null && r.date !== null
          ? (sortantsParFil.get(r.threadId) ?? []).some((d) => d > r.date!)
          : false;

      return {
        id: r.id,
        account: r.accountSlug,
        folder: r.folder.path,
        uid: r.uid,
        from: r.fromName ? `${r.fromName} <${r.fromEmail ?? ''}>` : (r.fromEmail ?? ''),
        to: { addresses: destinataires.slice(0, 8), accountRole },
        subject: r.subject ?? '(sans sujet)',
        date: r.date ? r.date.toISOString().slice(0, 10) : null,
        isSeen: r.isSeen,
        // Le texte préparé pour l'analyse d'abord ; l'extrait de 500
        // caractères tant que la recapture n'est pas passée sur ce mail.
        snippet:
          r.analysisInput ||
          r.snippet ||
          "(pas de texte lisible dans ce mail — juge sur le sujet, l'expéditeur et la date ; dis-le dans uncertainties)",
        ...(noms.length ? { attachmentNames: noms.slice(0, 12) } : {}),
        ...(indices?.supplier || indices?.amountTtc || indices?.invoiceNumber
          ? {
              documentHints: {
                ...(indices.supplier ? { supplier: indices.supplier } : {}),
                ...(indices.amountTtc ? { amountTtc: indices.amountTtc } : {}),
                ...(indices.invoiceNumber ? { invoiceNumber: indices.invoiceNumber } : {}),
              },
            }
          : {}),
        ...(r.threadId !== null
          ? { thread: { messageCount: tailleFil.get(r.threadId) ?? 1, repliedAfter: repondu } }
          : {}),
        ...attachmentPayload(r),
        guess: {
          intent: r.intent,
          senderCategory: senders.get(`${r.accountSlug}|${r.fromEmail ?? ''}`) ?? null,
          confidence: r.analysisConfidence,
        },
      };
    }),
  };
}

/** `toEmails` est une chaîne JSON (SQLite n'a pas de type natif). */
function lireDestinataires(brut: string | null): string[] {
  if (!brut) return [];
  try {
    const v = JSON.parse(brut);
    if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase()).filter(Boolean);
  } catch {
    // Ancien format ou chaîne libre : on retombe sur une séparation simple.
    return brut
      .split(/[,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
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

// ============================================================================
// LE VERDICT SÉMANTIQUE (lot 1 de la refonte — 11/08)
// ============================================================================

export interface SemanticApplyResult {
  applied: number;
  skipped: number;
  /** Verdicts refusés, un par un — jamais le lot entier. */
  rejections: { id: number; why: string }[];
  /**
   * Ce qui a été DÉGRADÉ sans échouer : une valeur hors liste fermée est
   * ramenée à `other`/`unknown` plutôt que de faire tomber le lot. On le dit,
   * sinon la dégradation reste invisible et le contrat dérive en silence.
   */
  warnings: { id: number; what: string }[];
}

/**
 * Applique des verdicts sémantiques : stocke le brut, en déplie les
 * projections, et alimente les quatre colonnes plates le temps que les
 * consommateurs basculent.
 *
 * TROIS DÉFAUTS DE `applyVerdicts` CORRIGÉS ICI, relevés en cartographiant le
 * pipeline le 11/08 :
 *
 * 1. Écritures GROUPÉES en transaction. L'ancien chemin faisait N `UPDATE`
 *    séquentiels hors transaction, sur SQLite en `connection_limit=1` — c'est
 *    le chemin lent du rattrapage. Le patron par lots existait déjà dans
 *    snippets.ts, il n'avait jamais été repris ici.
 * 2. Pas d'écrasement par un verdict vide. L'ancien réécrivait toujours
 *    `aiSummary` et `aiAction` : un verdict partiel effaçait donc un résumé
 *    antérieur, tout en posant `aiVerdictAt` — ce qui sortait définitivement
 *    le mail du vivier sans l'avoir jugé.
 * 3. Refus REMONTÉS. Un libellé de dossier rejeté ne laissait aucune trace :
 *    Claude n'apprenait jamais que son verdict avait été écarté.
 *
 * PRÉCÉDENCE. Une correction manuelle n'est jamais écrasée — mais elle ne
 * bloque plus le stockage du verdict. Ce que l'IA a compris du mail est un
 * FAIT ; ce que le produit en fait est une PROJECTION. Seule la projection
 * s'incline devant la correction d'Anthony.
 */
export async function applySemanticVerdicts(
  bruts: unknown[],
  opts: { model?: string; promptVersion?: string; inputVersion?: string } = {},
): Promise<SemanticApplyResult> {
  await ensureDbReady();
  const model = opts.model ?? 'claude (session MCP)';
  const promptVersion = opts.promptVersion ?? '1';
  const inputVersion = opts.inputVersion ?? '1';
  const now = new Date();
  const out: SemanticApplyResult = { applied: 0, skipped: 0, rejections: [], warnings: [] };
  if (bruts.length === 0) return out;

  // 1. Validation, un verdict à la fois. Un seul mauvais champ ne doit pas
  //    jeter le travail des 99 autres mails : l'analyse tourne sur le forfait
  //    d'Anthony, on ne la lui fait pas payer deux fois.
  const valides: VerdictSemantique[] = [];
  for (const brut of bruts) {
    const r = zVerdict.safeParse(brut);
    if (!r.success) {
      const id =
        typeof (brut as { id?: unknown })?.id === 'number' ? (brut as { id: number }).id : -1;
      out.rejections.push({
        id,
        why: r.error.issues
          .map((i) => `${i.path.join('.')} : ${i.message}`)
          .join(' ; ')
          .slice(0, 300),
      });
      out.skipped++;
      continue;
    }
    valides.push(r.data);
  }
  if (valides.length === 0) return out;

  const messages = new Map(
    (
      await db.message.findMany({
        where: { id: { in: valides.map((v) => v.id) } },
        select: {
          id: true,
          accountSlug: true,
          subject: true,
          date: true,
          intentSource: true,
        },
      })
    ).map((m) => [m.id, m]),
  );

  const journal = new Map<string, { subject: string; date: string | null }[]>();

  // 2. Écriture par paquets. 25 mails par transaction : assez pour que SQLite
  //    respire, assez peu pour qu'un échec ne fasse pas tomber un lot de 100.
  const PAQUET = 25;
  for (let i = 0; i < valides.length; i += PAQUET) {
    const paquet = valides.slice(i, i + PAQUET);
    const operations: unknown[] = [];

    for (const v of paquet) {
      const msg = messages.get(v.id);
      if (!msg) {
        out.rejections.push({ id: v.id, why: 'mail introuvable' });
        out.skipped++;
        continue;
      }
      const d = deplier(v);
      const legacy = projeterVersLegacy(v);

      if (d.entete.attentionMode === null || d.entete.attentionMode === 'unknown') {
        out.warnings.push({
          id: v.id,
          what: "aucune fenêtre d'attention : ce mail ne pourra jamais se périmer tout seul",
        });
      }

      const enfant = { messageId: msg.id };

      operations.push(
        // Rejouer un verdict REMPLACE le précédent : la cascade emporte les
        // projections, on ne les empile pas.
        db.mailVerdict.deleteMany({ where: { messageId: msg.id } }),
        db.mailVerdict.create({
          data: {
            messageId: msg.id,
            raw: JSON.stringify(v),
            schemaVersion: SCHEMA_VERSION,
            promptVersion,
            inputVersion,
            model,
            analysisStatus: d.entete.analysisStatus,
            inputCoverage: d.entete.inputCoverage,
            purpose: d.entete.purpose,
            subtype: d.entete.subtype,
            summary: d.entete.summary,
            attentionMode: d.entete.attentionMode,
            attentionUntil: d.entete.attentionUntil,
            attentionPrecision: d.entete.attentionPrecision,
            attentionBasis: d.entete.attentionBasis,
            actions: { create: d.actions.map((a) => ({ ...a, ...enfant })) },
            events: { create: d.events.map((e) => ({ ...e, ...enfant })) },
            documents: { create: d.documents.map((x) => ({ ...x, ...enfant })) },
            mentions: { create: d.mentions.map((m) => ({ ...m, ...enfant })) },
            contexts: { create: d.contexts.map((c) => ({ ...c, ...enfant })) },
            uncertainties: { create: d.uncertainties.map((u) => ({ ...u, ...enfant })) },
          },
        }),
        // 3. Projection de compatibilité — un ÉCHAFAUDAGE, retiré au lot 6.
        //    `aiSummary` n'est réécrit que s'il y a quelque chose à écrire :
        //    un verdict sans résumé n'efface pas le résumé précédent.
        db.message.update({
          where: { id: msg.id },
          data: {
            ...(msg.intentSource === 'manual'
              ? {}
              : {
                  intent: legacy.intent,
                  intentReason: 'analyse sémantique',
                  intentSource: 'ai',
                }),
            analysisConfidence: legacy.analysisConfidence,
            analysisConfidenceReason: "dérivée du doute déclaré par l'analyse",
            aiAction: legacy.aiAction,
            ...(legacy.aiSummary ? { aiSummary: legacy.aiSummary } : {}),
            aiVerdictAt: now,
            aiModel: model,
          },
        }),
      );

      const arr = journal.get(msg.accountSlug) ?? [];
      if (arr.length < 200) {
        arr.push({ subject: msg.subject ?? '(sans sujet)', date: msg.date?.toISOString() ?? null });
      }
      journal.set(msg.accountSlug, arr);
      out.applied++;
    }

    if (operations.length > 0) {
      await db.$transaction(operations as never);
    }
  }

  for (const [account, items] of journal) {
    await recordOperation({
      account,
      tool: 'ai_analysis_semantique',
      params: { model, verdicts: items.length, schemaVersion: SCHEMA_VERSION, promptVersion },
      result: `${items.length} verdict(s) sémantique(s) enregistrés`,
      items,
    });
  }

  logger.info('verdicts sémantiques appliqués', {
    applied: out.applied,
    skipped: out.skipped,
    warnings: out.warnings.length,
  });
  return out;
}
