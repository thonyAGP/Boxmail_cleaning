import { db, ensureDbReady } from '../db/client.js';
import { recordOperation } from './oplog.js';
import { logger } from '../logger.js';
import { isRentilaSender, parseRentilaMail } from './rentila.js';
import type { AccountRecord } from './accounts.js';
import {
  resolveMailSemanticState,
  getOpenActions,
  getDeadlineState,
  type EtatSemantique,
} from './semantique.js';

/**
 * Moteur des échéances — BASCULE SUR LE SOCLE au lot 4c (12/08).
 *
 * C'est ce moteur qui a produit deux des trois échecs connus : le rappel
 * Air France d'un vol passé remonté première priorité, et « paiements par
 * carte indisponibles le 12 mai » (PayFiP) transformé en échéance de
 * PAIEMENT. Cause commune : il devinait sur des mots et des dates, puis un
 * veto codé à la main (`aiVerdictSaysNoAction`, supprimé ici) rattrapait ses
 * inventions en relisant `aiAction`/`analysisConfidence` — une rustine par
 * cas, exactement le montage que la refonte interdit.
 *
 * LA RÈGLE DU LOT 4C, tenue partout dans ce fichier :
 *
 *   Une échéance est une ACTION RÉELLEMENT DUE (verdict sémantique :
 *   action `actor = 'user'` encore ouverte, portant un `dueAt`) —
 *   jamais une date trouvée dans un texte.
 *
 * Les trois pièges de la contre-revue, et où ils sont parés :
 *  1. « toute date n'est pas une échéance » → `echeancesDepuisLeVerdict` ne
 *     lit QUE les actions ouvertes de l'utilisateur (via le socle) ; une date
 *     d'événement, de document ou d'information ne crée RIEN ;
 *  2. « une échéance passée n'est pas close » → aucune ligne de ce fichier ne
 *     ferme quoi que ce soit sur `date < maintenant` ; la disparition vient
 *     d'un acte (done/dismissed) ou de la fenêtre d'action du verdict ;
 *  3. « ne rien réinventer » → une action due sans date reste SANS échéance,
 *     comptée et déclarée (`withoutDate`), jamais complétée par un
 *     « facture + 30 jours ».
 *
 * COHABITATION (l'immense majorité des 25 000 mails n'a pas encore de
 * verdict sémantique) : quand le verdict existe, le socle PRIME et la regex
 * ne tourne pas ; sinon l'extraction heuristique (`extractDeadlines`)
 * reste le REPLI, marqué comme tel dans la raison affichée. Quand un verdict
 * arrive plus tard, `revoirEcheancesProposees()` ré-arbitre les propositions
 * heuristiques via le socle — c'est ce qui remplace la relecture-rustine.
 *
 * Garde-fous inchangés : chaque échéance est PROPOSÉE puis validée/ignorée
 * par l'utilisateur — jamais d'action automatique (SPEC §11.5) ; les
 * newsletters sont exclues ; un statut travaillé par l'utilisateur n'est
 * jamais écrasé.
 */

export type DeadlineType = 'payment' | 'document' | 'appointment' | 'renewal' | 'other';
export type DeadlineStatus = 'proposed' | 'confirmed' | 'dismissed' | 'done' | 'vetoed';

export interface ExtractedDeadline {
  date: Date;
  type: DeadlineType;
  confidence: number;
  /** Extrait du texte contenant la date (pour justification). */
  sourceText: string;
  /** Tournure déclencheuse trouvée (« avant le », « échéance du »…), sinon null. */
  trigger: string | null;
}

// ---------------------------------------------------------------------------
// Parseur de dates françaises (aucune dépendance)
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  janvier: 1, janv: 1,
  fevrier: 2, février: 2, fevr: 2, févr: 2,
  mars: 3,
  avril: 4, avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7, juil: 7,
  aout: 8, août: 8,
  septembre: 9, sept: 9,
  octobre: 10, oct: 10,
  novembre: 11, nov: 11,
  decembre: 12, décembre: 12, dec: 12, déc: 12,
};
const MONTH_ALT = Object.keys(MONTHS).join('|');

/** Tournures qui annoncent une vraie date limite (confiance forte). */
const TRIGGER_RE =
  /(avant le|avant fin|d'ici(?: le| au)?|au plus tard(?: le| pour le)?|jusqu'au|[ée]ch[ée]ance(?: du| au| le|\s*:)?|date limite(?: du| le|\s*:)?|[àa] r[ée]gler (?:avant|pour) le|expire le|valable jusqu'au|renouveler avant le|rendez-vous(?: le| du)|rdv(?: le| du))\s*$/i;

const TYPE_RULES: { type: DeadlineType; re: RegExp; label: string }[] = [
  {
    type: 'payment',
    re: /(payer|paiement|r[ée]gler|r[èe]glement|facture|impay[ée]|pr[ée]l[èe]vement|cotisation|loyer|relance|montant|somme)/i,
    label: 'paiement',
  },
  {
    type: 'document',
    re: /(document|justificatif|transmettre|fournir|pi[èe]ces?|attestation|dossier|d[ée]claration|formulaire|signer|signature)/i,
    label: 'document à fournir',
  },
  {
    type: 'appointment',
    re: /(rendez-vous|\brdv\b|r[ée]union|entretien|visite|convocation|assembl[ée]e)/i,
    label: 'rendez-vous',
  },
  {
    type: 'renewal',
    re: /(renouvel|expire|expiration|r[ée]silier|r[ée]siliation|fin de contrat|[ée]ch[ée]ance de contrat)/i,
    label: 'renouvellement/expiration',
  },
];

function guessType(text: string): { type: DeadlineType; label: string } {
  for (const rule of TYPE_RULES) {
    if (rule.re.test(text)) return { type: rule.type, label: rule.label };
  }
  return { type: 'other', label: 'autre' };
}

/**
 * Résout jour/mois(/année) en Date. Année absente : prochaine occurrence
 * (si la date est déjà passée de plus de 45 j cette année → année suivante ;
 * la tolérance de 45 j permet de détecter les échéances récemment dépassées).
 */
function buildDate(
  day: number,
  month: number,
  year: number | null,
  hour: number | null,
  minute: number | null,
  ref: Date,
): Date | null {
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  let y = year;
  if (y !== null && y < 100) y += 2000;
  if (y === null) {
    y = ref.getFullYear();
    const candidate = new Date(y, month - 1, day);
    if (candidate.getTime() < ref.getTime() - 45 * 86_400_000) y += 1;
  }
  if (y < 2000 || y > 2100) return null;
  const d = new Date(y, month - 1, day, hour ?? 9, minute ?? 0);
  // Rejette les dates invalides (31 février → 2/3 mars).
  if (d.getDate() !== day || d.getMonth() !== month - 1) return null;
  return d;
}

/** Extrait de contexte autour d'une position (pour sourceText). */
function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 25);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${
    end < text.length ? '…' : ''
  }`;
}

/**
 * Trouve les échéances dans un texte français.
 * Chaque date détectée est qualifiée : tournure déclencheuse (confiance 0.9)
 * ou date « nue » (0.6, gardée seulement si le contexte évoque un type connu).
 */
export function extractDeadlines(text: string, refDate = new Date()): ExtractedDeadline[] {
  if (!text) return [];
  const found: ExtractedDeadline[] = [];
  const seen = new Set<string>();

  const timeRe = /(?:\s*(?:à|a)\s*(\d{1,2})\s*h\s*(\d{2})?)?/.source;
  const patterns: { re: RegExp; kind: 'numeric' | 'textual' }[] = [
    {
      // 15/07, 15/07/2026, 15.07.26 (+ heure optionnelle)
      re: new RegExp(
        String.raw`\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b` + timeRe,
        'gi',
      ),
      kind: 'numeric',
    },
    {
      // 15 juillet, 1er juillet 2026 (+ heure optionnelle)
      re: new RegExp(
        String.raw`\b(1er|\d{1,2})\s+(${MONTH_ALT})(?:\s+(\d{4}))?\b` + timeRe,
        'gi',
      ),
      kind: 'textual',
    },
  ];

  for (const { re, kind } of patterns) {
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      let day: number, month: number;
      let year: number | null = null;
      let hour: number | null = null;
      let minute: number | null = null;

      if (kind === 'numeric') {
        day = Number.parseInt(m[1], 10);
        month = Number.parseInt(m[2], 10);
        if (m[3] !== undefined) year = Number.parseInt(m[3], 10);
        if (m[4] !== undefined) hour = Number.parseInt(m[4], 10);
        if (m[5] !== undefined) minute = Number.parseInt(m[5], 10);
        // « 15/2026 » ou fragment de montant « 15/300 € » : mois invalide → rejet
        // via buildDate ; « 07/2026 » (mois/année) non géré volontairement (ambigu).
      } else {
        day = m[1].toLowerCase() === '1er' ? 1 : Number.parseInt(m[1], 10);
        month = MONTHS[m[2].toLowerCase()] ?? 0;
        if (m[3] !== undefined) year = Number.parseInt(m[3], 10);
        if (m[4] !== undefined) hour = Number.parseInt(m[4], 10);
        if (m[5] !== undefined) minute = Number.parseInt(m[5], 10);
      }

      const date = buildDate(day, month, year, hour, minute, refDate);
      if (!date) continue;

      // Tournure déclencheuse juste avant la date (fenêtre de 28 caractères).
      const before = text.slice(Math.max(0, idx - 28), idx);
      const triggerMatch = TRIGGER_RE.exec(before);
      const trigger = triggerMatch ? triggerMatch[1].trim() : null;

      const context = excerpt(text, idx, m[0].length);
      const { type } = guessType(context);

      // Une date « nue » sans tournure ni contexte typé = bruit → ignorée.
      if (!trigger && type === 'other') continue;

      const key = date.toISOString().slice(0, 16);
      if (seen.has(key)) continue;
      seen.add(key);

      found.push({
        date,
        type: hour !== null && type === 'other' ? 'appointment' : type,
        confidence: trigger ? 0.9 : 0.6,
        sourceText: context,
        trigger,
      });
    }
  }

  return found.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ---------------------------------------------------------------------------
// Détection sur les mails d'un compte
// ---------------------------------------------------------------------------

/** Pré-filtre des sujets candidats pour la passe approfondie (corps). */
const DEEP_SUBJECT_RE =
  /(avant le|[ée]ch[ée]ance|d'ici|date limite|au plus tard|rappel|relance|facture|payer|r[ée]gler|rdv|rendez-vous|renouvel|expire|d[ée]claration|justificatif|document)/i;

const DEEP_BODY_CAP = 50;

export interface DetectReport {
  account: string;
  scanned: number;
  bodiesRead: number;
  created: number;
  alreadyKnown: number;
  /** Échéances créées depuis le VERDICT SÉMANTIQUE (actions réellement dues). */
  fromVerdict: number;
  /** Actions dues déclarées SANS date lisible : rien d'inventé — on le dit. */
  withoutDate: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Le socle d'abord (lot 4c) : échéance = action réellement due
// ---------------------------------------------------------------------------

/**
 * Nature de l'échéance déduite du GESTE demandé — plus jamais des mots du
 * sujet. `guessType` (regex) ne sert qu'au repli, sur les mails sans verdict.
 */
const TYPE_PAR_GESTE: Record<string, DeadlineType> = {
  pay: 'payment',
  provide_document: 'document',
  sign: 'document',
  declare: 'document',
  attend: 'appointment',
  book: 'appointment',
  call: 'appointment',
  renew: 'renewal',
};

/** Certitude PAR AFFIRMATION du verdict → confiance affichée (0-1). Jamais
 *  l'inverse : la confiance n'autorise rien, elle explique. */
const CONFIANCE_PAR_CERTITUDE: Record<string, number> = {
  explicit: 0.95,
  strong_inference: 0.85,
  weak_inference: 0.65,
  unknown: 0.5,
};

export interface EcheanceDuVerdict {
  date: Date;
  type: DeadlineType;
  /** Le geste demandé, tel que l'analyse l'a lu — jamais « payer maman ». */
  titre: string | null;
  confidence: number;
  reason: string;
  sourceText: string;
}

/**
 * Les échéances qu'un verdict sémantique AUTORISE — le remplaçant du couple
 * regex + veto. Fonction PURE (le banc l'éprouve avec des états en mémoire).
 *
 * Les trois pièges, tenus ici même :
 *  1. seules les actions OUVERTES de l'utilisateur produisent une échéance
 *     (`getOpenActions` : acteur `user`, rien ne l'a soldée, fenêtre non
 *     passée). Une date d'événement, de document, ou « paiements
 *     indisponibles le 12 mai » ne crée RIEN — aucune action, aucune échéance ;
 *  2. une action au `dueAt` passé reste OUVERTE (le socle la dit `enRetard`,
 *     jamais résolue) : elle produit son échéance, qui s'affichera en retard ;
 *  3. une action due SANS date ne fabrique aucune date : elle est DÉCLARÉE
 *     dans `actionsSansDate`, et c'est tout.
 */
export function echeancesDepuisLeVerdict(etat: EtatSemantique): {
  echeances: EcheanceDuVerdict[];
  actionsSansDate: string[];
} {
  const echeances: EcheanceDuVerdict[] = [];
  const actionsSansDate: string[] = [];
  // La vue « échéance » du socle : parmi ses lignes, celles d'origine
  // `action` sont exactement les actions de l'utilisateur encore ouvertes qui
  // portent un dueAt. Elle parcourt getOpenActions dans l'ordre — on s'y
  // aligne pour retrouver le détail (geste, montant, certitude) de chaque ligne.
  const vues = getDeadlineState(etat).filter((v) => v.origine === 'action');
  const ouvertes = getOpenActions(etat);
  const avecDate = ouvertes.filter((a) => a.fait.dueAt !== null);

  vues.forEach((vue, i) => {
    const a = avecDate[i];
    if (!a?.fait.dueAt) return; // jamais atteint par construction — prudence
    const montant =
      a.fait.montant !== null
        ? ` (${a.fait.montant.toFixed(2).replace('.', ',')} ${a.fait.devise ?? '€'})`
        : '';
    echeances.push({
      date: a.fait.dueAt,
      type: TYPE_PAR_GESTE[a.fait.kind] ?? 'other',
      titre: a.fait.label,
      confidence: CONFIANCE_PAR_CERTITUDE[a.fait.certainty] ?? 0.5,
      reason:
        `l'analyse du mail déclare une action à faire de ta part : ` +
        `« ${a.fait.label ?? a.fait.kind} »${montant} — ${vue.pourquoi} ` +
        `(échéance issue du verdict sémantique, pas d'une date trouvée dans le texte)`,
      sourceText: (etat.resume.valeur ?? a.fait.label ?? a.fait.kind).slice(0, 300),
    });
  });

  for (const a of ouvertes) {
    if (a.fait.dueAt === null) actionsSansDate.push(a.fait.label ?? a.fait.kind);
  }
  return { echeances, actionsSansDate };
}

/**
 * Arbitrage d'une proposition EXISTANTE (née de la regex) à la lumière du
 * socle. Fonction PURE — c'est elle qui remplace `aiVerdictSaysNoAction`.
 *
 *  - pas de verdict → on GARDE : l'inconnu ne fait taire personne, et la
 *    proposition heuristique reste la meilleure information disponible ;
 *  - verdict présent et PLUS AUCUNE action ouverte de l'utilisateur → veto.
 *    C'est le cas PayFiP (jamais eu d'action) comme le cas Air France (la
 *    fenêtre d'action est passée : hors délai n'est pas « fait », mais agir
 *    n'a plus de sens) ;
 *  - une action reste ouverte → on GARDE, toujours. Même si sa date diffère
 *    de la proposition, même si l'analyse n'a pas su lire de date : fermer à
 *    tort MASQUE une obligation, laisser ouvert dérange seulement.
 *
 * Le passage du temps ne décide RIEN ici (piège n° 2) : une proposition à la
 * date passée soutenue par une action ouverte reste affichée — en retard.
 */
export function arbitrerProposition(
  etat: EtatSemantique | null | undefined,
  dateProposee: Date,
): { garder: boolean; pourquoi: string } {
  if (!etat || !etat.analyse.verdictPresent) {
    return {
      garder: true,
      pourquoi:
        "pas encore de verdict sémantique sur ce mail — la proposition (repli heuristique) reste affichée",
    };
  }
  const ouvertes = getOpenActions(etat);
  if (ouvertes.length === 0) {
    const fenetrePassee = etat.courant.actions.some(
      (a) => a.fait.acteur === 'user' && a.horsDelai,
    );
    if (fenetrePassee) {
      return {
        garder: false,
        pourquoi:
          "la fenêtre d'action est passée — agir n'a plus de sens (un rappel périmé n'est pas une échéance)",
      };
    }
    return {
      garder: false,
      pourquoi:
        `date trouvée dans le mail, mais l'analyse conclut « ` +
        `${etat.resume.valeur ?? 'aucune action de ta part'} » — la date décrit un fait, ` +
        `pas une action de ta part`,
    };
  }
  // Une action due couvre-t-elle la date proposée ? (marge de 36 h : la regex
  // pose les dates en heure locale, le verdict en UTC — on ne veut pas qu'un
  // décalage de fuseau fasse passer une confirmation pour une divergence.)
  const MARGE_MS = 36 * 3_600_000;
  const t = dateProposee.getTime();
  const couverte = getDeadlineState(etat).some(
    (v) => v.origine === 'action' && Math.abs(v.date.getTime() - t) <= MARGE_MS,
  );
  return {
    garder: true,
    pourquoi: couverte
      ? "l'analyse confirme une action due de ta part à cette date"
      : "une action reste à faire d'après l'analyse — dans le doute, la date trouvée reste proposée",
  };
}

/**
 * Ré-arbitre les propositions EXISTANTES via le socle — remplaçant de la
 * relecture-rustine du 11/08, qui relisait `aiAction`/`analysisConfidence`.
 *
 * POURQUOI ELLE EXISTE TOUJOURS : la détection tourne à la sync, l'analyse
 * sémantique arrive APRÈS (rattrapage MCP, flux). Une proposition née de la
 * regex doit être re-jugée quand le verdict de son mail apparaît — sinon les
 * fausses échéances du stock resteraient affichées à vie (constaté le 11/08 :
 * « Votre facture mobile Free est disponible »).
 *
 * Le NOM est conservé parce que sync.ts (hors périmètre du lot 4c) l'appelle
 * à chaque synchronisation ; le corps, lui, ne devine plus rien : résolution
 * EN LOT (jamais mail par mail — SQLite connection_limit=1), puis
 * `arbitrerProposition` pour chaque ligne.
 *
 * Ne touche QUE les propositions (`proposed`) : une échéance que l'utilisateur
 * a confirmée lui appartient, on ne la lui retire jamais dans son dos.
 */
export async function revoirEcheancesProposees(): Promise<{ revues: number; ecartees: number }> {
  await ensureDbReady();
  const lignes = await db.deadline.findMany({
    where: { status: 'proposed' },
    select: { id: true, messageId: true, title: true, date: true },
  });
  if (lignes.length === 0) return { revues: 0, ecartees: 0 };
  const etats = await resolveMailSemanticState([...new Set(lignes.map((l) => l.messageId))]);
  let ecartees = 0;
  for (const d of lignes) {
    const arbitrage = arbitrerProposition(etats.get(d.messageId), d.date);
    if (arbitrage.garder) continue;
    await db.deadline.update({
      where: { id: d.id },
      data: { status: 'vetoed', vetoReason: 'ai_no_action', reason: arbitrage.pourquoi },
    });
    ecartees++;
    logger.info('échéance écartée après lecture du socle', { id: d.id, titre: d.title });
  }
  return { revues: lignes.length, ecartees };
}

export async function detectDeadlines(
  rec: AccountRecord,
  opts: {
    sinceDays?: number;
    deep?: boolean;
    /**
     * Ne traiter que les mails INDEXÉS après cette date (P0.2) : le passage
     * automatique après chaque sync ne doit voir que les nouveaux arrivants,
     * sinon il relirait les mêmes contenus toutes les 30 minutes.
     */
    indexedSince?: Date;
    onProgress?: (m: string) => void;
  } = {},
): Promise<DetectReport> {
  await ensureDbReady();
  const started = Date.now();
  const sinceDays = Math.min(Math.max(opts.sinceDays ?? 30, 1), 365);
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const progress = opts.onProgress ?? (() => {});
  const account = rec.account;

  // Mails entrants récents, hors newsletters/corbeille/spam/brouillons.
  const messages = await db.message.findMany({
    where: {
      accountSlug: account,
      isDeleted: false,
      isOutbound: false,
      hasListUnsubscribe: false,
      date: { gte: since },
      folder: { is: { role: { notIn: ['trash', 'spam', 'drafts'] } } },
      ...(opts.indexedSince ? { createdAt: { gte: opts.indexedSince } } : {}),
    },
    orderBy: { date: 'desc' },
    select: {
      id: true,
      uid: true,
      threadId: true,
      subject: true,
      fromEmail: true,
      fromName: true,
      date: true,
      folder: { select: { path: true } },
    },
  });
  progress(`${messages.length} mails à analyser (sujets)…`);

  // L'état sémantique de TOUT le lot, résolu en une passe — le détecteur ne
  // relit plus les colonnes plates (`aiAction`, `analysisConfidence`) : il
  // lit le socle, qui a déjà appliqué la précédence et l'état du fil.
  const etats = await resolveMailSemanticState(messages.map((m) => m.id));

  let created = 0;
  let alreadyKnown = 0;
  let bodiesRead = 0;
  let fromVerdict = 0;
  let withoutDate = 0;
  const createdItems: { subject: string; date: string | null; folder?: string; uid?: number }[] =
    [];

  /** Une échéance à enregistrer, d'où qu'elle vienne (verdict ou repli). */
  interface Proposition {
    date: Date;
    type: DeadlineType;
    confidence: number;
    reason: string;
    sourceText: string;
    title?: string | null;
    /** true = portée par le verdict sémantique (seule origine qui peut
     *  rouvrir une date écartée par un ancien arbitrage machine). */
    duVerdict?: boolean;
  }

  const record = async (msg: (typeof messages)[number], p: Proposition): Promise<void> => {
    const existing = await db.deadline.findUnique({
      where: {
        accountSlug_messageId_date: { accountSlug: account, messageId: msg.id, date: p.date },
      },
    });
    if (existing) {
      // Le verdict AFFIRME une action due là où un ancien arbitrage machine
      // avait écarté la date : l'analyse plus riche rouvre la proposition.
      // Un choix de l'UTILISATEUR (ignorée, confirmée, faite) n'est jamais
      // rejoué — sa vérité prime sur toute analyse.
      if (p.duVerdict && existing.status === 'vetoed') {
        await db.deadline.update({
          where: { id: existing.id },
          data: {
            status: 'proposed',
            vetoReason: null,
            confidence: p.confidence,
            reason: p.reason,
            sourceText: p.sourceText,
          },
        });
        created++;
        fromVerdict++;
        createdItems.push({
          subject: `${p.title ?? msg.subject ?? '(sans sujet)'} → ${p.date.toLocaleDateString('fr-FR')}`,
          date: msg.date?.toISOString() ?? null,
          folder: msg.folder.path,
          uid: msg.uid,
        });
        return;
      }
      alreadyKnown++;
      // Ne jamais écraser un statut travaillé par l'utilisateur ; on peut
      // seulement renforcer la confiance d'une proposition.
      if (existing.status === 'proposed' && p.confidence > existing.confidence) {
        await db.deadline.update({
          where: { id: existing.id },
          data: { confidence: p.confidence, sourceText: p.sourceText, reason: p.reason },
        });
      }
      return;
    }

    await db.deadline.create({
      data: {
        accountSlug: account,
        messageId: msg.id,
        threadId: msg.threadId,
        title: p.title ?? msg.subject ?? '(sans sujet)',
        date: p.date,
        type: p.type,
        confidence: p.confidence,
        reason: p.reason,
        sourceText: p.sourceText,
        fromEmail: msg.fromEmail,
        fromName: msg.fromName,
        subject: msg.subject,
      },
    });
    created++;
    if (p.duVerdict) fromVerdict++;
    createdItems.push({
      subject: `${p.title ?? msg.subject ?? '(sans sujet)'} → ${p.date.toLocaleDateString('fr-FR')}`,
      date: msg.date?.toISOString() ?? null,
      // Le mail n'a pas bougé : on garde de quoi le rouvrir depuis le journal.
      folder: msg.folder.path,
      uid: msg.uid,
    });
  };

  // La raison du REPLI porte son propre aveu : l'utilisateur doit voir d'un
  // coup d'œil qu'une date vient d'un motif de texte, pas d'une analyse.
  const raisonRepli = (ex: ExtractedDeadline, source: 'sujet' | 'contenu'): string =>
    [
      ex.trigger
        ? `le ${source} mentionne « ${ex.trigger} » suivi d'une date`
        : `date trouvée dans le ${source} avec un contexte de type connu`,
      `extrait : « ${ex.sourceText} »`,
      "repli heuristique — ce mail n'a pas encore de verdict d'analyse",
    ].join(' · ');

  const enregistrerRepli = (
    msg: (typeof messages)[number],
    ex: ExtractedDeadline,
    source: 'sujet' | 'contenu',
    title?: string,
  ): Promise<void> =>
    record(msg, {
      date: ex.date,
      type: ex.type,
      confidence: ex.confidence,
      reason: raisonRepli(ex, source),
      sourceText: ex.sourceText,
      title,
    });

  // Passe 1 : le SOCLE d'abord ; les sujets (heuristiques) en repli.
  for (const msg of messages) {
    const etat = etats.get(msg.id);
    if (etat?.analyse.verdictPresent) {
      // Le verdict existe : LUI SEUL décide — aucune regex sur ce mail. Une
      // date qui n'est pas une action réellement due (événement, document,
      // « indisponible le 12 mai ») ne devient jamais une proposition.
      const { echeances, actionsSansDate } = echeancesDepuisLeVerdict(etat);
      for (const e of echeances) {
        await record(msg, {
          date: e.date,
          type: e.type,
          confidence: e.confidence,
          reason: e.reason,
          sourceText: e.sourceText,
          title: e.titre,
          duVerdict: true,
        });
      }
      // Piège n° 3 : une action due SANS date lisible ne fabrique rien — on
      // la compte pour pouvoir le dire (« rien d'inventé »).
      withoutDate += actionsSansDate.length;
      continue;
    }
    // REPLI (pas encore de verdict). Les notifications Rentila ont leur propre
    // grammaire (connecteur phase 1) : le sujet porte le bien et le délai
    // (« expire dans 30 jours: 101 1er droite T3 »), mais pas de date en clair
    // — l'extracteur générique ne verrait rien. Titre réécrit en obligation.
    if (isRentilaSender(msg.fromEmail)) {
      const info = parseRentilaMail({
        subject: msg.subject,
        fromEmail: msg.fromEmail,
        fromName: msg.fromName,
        date: msg.date,
      });
      if (info) {
        if (info.due) {
          const { title, ...ex } = info.due;
          await enregistrerRepli(msg, ex, 'sujet', title);
        }
        continue; // pas d'extraction générique sur un mail Rentila reconnu
      }
    }
    for (const ex of extractDeadlines(msg.subject ?? '', msg.date ?? new Date())) {
      await enregistrerRepli(msg, ex, 'sujet');
    }
  }

  // Passe 2 (optionnelle) : corps des mails au sujet évocateur, via IMAP —
  // repli elle aussi : jamais sur un mail au verdict connu (le socle a déjà
  // tout dit, relire le corps à la regex serait deviner par-dessus).
  if (opts.deep) {
    const candidates = messages
      .filter((m) => !etats.get(m.id)?.analyse.verdictPresent)
      // Les mails Rentila sont déjà traités par leur grammaire dédiée (passe 1)
      // et leurs corps sont des gabarits HTML sans date supplémentaire.
      .filter((m) => !isRentilaSender(m.fromEmail))
      .filter((m) => DEEP_SUBJECT_RE.test(m.subject ?? ''))
      .slice(0, DEEP_BODY_CAP);
    progress(`Analyse approfondie : lecture de ${candidates.length} contenus de mails…`);
    // Import différé : imap.ts tire config.ts, qui exige le .env dès le
    // chargement — or le banc (`npm run verdict:check`) importe ce fichier
    // pour éprouver les fonctions pures, sans serveur ni IMAP.
    const { imapService } = await import('./imap.js');
    for (const msg of candidates) {
      try {
        const body = await imapService.readEmail(rec, msg.folder.path, msg.uid);
        bodiesRead++;
        for (const ex of extractDeadlines(body.text, msg.date ?? new Date())) {
          await enregistrerRepli(msg, ex, 'contenu');
        }
        if (bodiesRead % 10 === 0) progress(`…${bodiesRead}/${candidates.length} contenus lus`);
      } catch {
        // Mail déplacé/supprimé depuis la sync : on continue.
      }
    }
  }

  if (created > 0) {
    await recordOperation({
      account,
      tool: 'detect_deadlines',
      params: { sinceDays, deep: Boolean(opts.deep), created, scanned: messages.length },
      items: createdItems.slice(0, 100),
      result: `${created} échéance(s) proposée(s)`,
    });
  }
  progress(
    `✅ ${created} nouvelle(s) échéance(s) proposée(s) (${alreadyKnown} déjà connues` +
      `${fromVerdict ? `, dont ${fromVerdict} issue(s) de l'analyse sémantique` : ''}` +
      `${withoutDate ? ` ; ${withoutDate} action(s) à date encore inconnue — rien d'inventé` : ''}).`,
  );

  return {
    account,
    scanned: messages.length,
    bodiesRead,
    created,
    alreadyKnown,
    fromVerdict,
    withoutDate,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Liste et cycle de vie
// ---------------------------------------------------------------------------

export interface DeadlineItem {
  id: number;
  account: string;
  messageId: number;
  threadId: number | null;
  title: string;
  date: string;
  type: DeadlineType;
  status: DeadlineStatus;
  confidence: number;
  reason: string;
  sourceText: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  /** Motif d'écartement quand status = vetoed (ai_no_action…), sinon null. */
  vetoReason: string | null;
  /** Jours restants (négatif si passée). */
  inDays: number;
  /** Localisation du mail source dans l'index (null s'il a disparu) —
   *  permet d'ouvrir le mail depuis l'interface. */
  folder: string | null;
  uid: number | null;
  msgDate: string | null;
  isSeen: boolean | null;
}

/** Métadonnées du mail source encore présent dans l'index. */
type SourceMeta = { uid: number; isSeen: boolean; date: Date | null; folder: { path: string } };

async function loadSourceMeta(messageIds: number[]): Promise<Map<number, SourceMeta>> {
  const metas = new Map<number, SourceMeta>();
  for (let i = 0; i < messageIds.length; i += 500) {
    const rows = await db.message.findMany({
      where: { id: { in: messageIds.slice(i, i + 500) }, isDeleted: false },
      select: {
        id: true,
        uid: true,
        isSeen: true,
        date: true,
        folder: { select: { path: true } },
      },
    });
    for (const r of rows) metas.set(r.id, r);
  }
  return metas;
}

function toItem(
  d: {
    id: number;
    accountSlug: string;
    messageId: number;
    threadId: number | null;
    title: string;
    date: Date;
    type: string;
    status: string;
    confidence: number;
    reason: string;
    sourceText: string;
    fromEmail: string | null;
    fromName: string | null;
    subject: string | null;
    vetoReason?: string | null;
  },
  source?: SourceMeta,
): DeadlineItem {
  return {
    id: d.id,
    account: d.accountSlug,
    messageId: d.messageId,
    threadId: d.threadId,
    title: d.title,
    date: d.date.toISOString(),
    type: d.type as DeadlineType,
    status: d.status as DeadlineStatus,
    confidence: d.confidence,
    reason: d.reason,
    sourceText: d.sourceText,
    fromEmail: d.fromEmail,
    fromName: d.fromName,
    subject: d.subject,
    vetoReason: d.vetoReason ?? null,
    inDays: Math.round((d.date.getTime() - Date.now()) / 86_400_000),
    folder: source?.folder.path ?? null,
    uid: source?.uid ?? null,
    msgDate: source?.date?.toISOString() ?? null,
    isSeen: source?.isSeen ?? null,
  };
}

export async function listDeadlines(
  account: string,
  opts: { fromDate?: string; toDate?: string; status?: DeadlineStatus; limit?: number } = {},
): Promise<DeadlineItem[]> {
  await ensureDbReady();
  const rows = await db.deadline.findMany({
    where: {
      accountSlug: account,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.fromDate || opts.toDate
        ? {
            date: {
              ...(opts.fromDate ? { gte: new Date(opts.fromDate) } : {}),
              ...(opts.toDate ? { lte: new Date(opts.toDate) } : {}),
            },
          }
        : {}),
    },
    orderBy: { date: 'asc' },
    take: Math.min(Math.max(opts.limit ?? 200, 1), 1000),
  });
  const metas = await loadSourceMeta(rows.map((r) => r.messageId));
  return rows.map((r) => toItem(r, metas.get(r.messageId)));
}

async function setStatus(
  account: string,
  id: number,
  status: DeadlineStatus,
  toolName: string,
  resultLabel: string,
): Promise<DeadlineItem> {
  await ensureDbReady();
  const row = await db.deadline.findFirst({ where: { id, accountSlug: account } });
  if (!row) throw new Error(`Échéance ${id} introuvable pour le compte « ${account} ».`);
  // Rétablir une proposition écartée efface son motif : elle redevient une
  // proposition ordinaire, que l'utilisateur confirmera ou non.
  const updated = await db.deadline.update({
    where: { id },
    data: { status, ...(status === 'proposed' ? { vetoReason: null } : {}) },
  });
  await recordOperation({
    account,
    tool: toolName,
    params: { deadlineId: id, date: row.date.toISOString() },
    items: [{ subject: row.title, date: row.date.toISOString() }],
    result: resultLabel,
  });
  const metas = await loadSourceMeta([updated.messageId]);
  return toItem(updated, metas.get(updated.messageId));
}

export function confirmDeadline(account: string, id: number): Promise<DeadlineItem> {
  return setStatus(account, id, 'confirmed', 'confirm_deadline', 'échéance confirmée');
}

export function dismissDeadline(account: string, id: number): Promise<DeadlineItem> {
  return setStatus(account, id, 'dismissed', 'dismiss_deadline', 'échéance ignorée');
}

export function completeDeadline(account: string, id: number): Promise<DeadlineItem> {
  return setStatus(account, id, 'done', 'complete_deadline', 'échéance faite');
}

/** Remet une échéance ignorée/faite en « proposée » (annulation). */
export function restoreDeadline(account: string, id: number): Promise<DeadlineItem> {
  return setStatus(account, id, 'proposed', 'restore_deadline', 'échéance remise en proposition');
}

/**
 * EFFACER une échéance — « comme si je n'avais rien cliqué ».
 *
 * ⚠️ NE PAS CONFONDRE AVEC `dismissDeadline`. « Écarter » est une DÉCISION :
 * la ligne reste, avec le statut `dismissed`. Or le panneau de lecture masque
 * toute date déjà présente en base, quel que soit son statut (`knownKeys`
 * dans la route d'analyse) — autrement dit un « écarté » enterre la date pour
 * de bon : elle ne sera plus jamais reproposée à la lecture du mail.
 *
 * C'est acceptable quand l'utilisateur REJETTE la date. Ça ne l'est pas quand
 * il annule dans les dix secondes le clic qu'il vient de faire : il demande
 * un retour à l'état d'avant, pas l'enregistrement d'un refus. Mesuré au banc
 * le 27/08 — la deuxième ouverture du même mail ne détectait plus la date.
 *
 * Réservé à l'annulation immédiate d'une création. Ailleurs, écarter suffit.
 */
export async function deleteDeadline(account: string, id: number): Promise<{ ok: true }> {
  await ensureDbReady();
  const row = await db.deadline.findFirst({ where: { id, accountSlug: account } });
  if (!row) throw new Error(`Échéance ${id} introuvable pour le compte « ${account} ».`);
  await db.deadline.delete({ where: { id } });
  await recordOperation({
    account,
    tool: 'delete_deadline',
    decision: 'annulee',
    params: { deadlineId: id, date: row.date.toISOString() },
    items: [{ subject: row.title, date: row.date.toISOString() }],
    result: 'échéance effacée (annulation)',
  });
  return { ok: true };
}

/**
 * Propose une échéance depuis le panneau de lecture (L5.4) : l'utilisateur a
 * vu la date dans le mail ouvert et clique « Proposer ». Idempotent (contrainte
 * unique compte+mail+date) et jamais d'écrasement d'un statut travaillé.
 */
export async function proposeDeadline(
  account: string,
  messageId: number,
  /**
   * `status` : `proposed` = l'assistant SUGGÈRE, il reste à valider ailleurs.
   * `confirmed` = c'est déjà tranché.
   *
   * ⚠️ Quand le geste vient d'un CLIC de l'utilisateur sur une date qu'il a
   * sous les yeux, créer en `proposed` est absurde : son clic EST la
   * validation, et le badge « à valider dans Dates à confirmer » lui ajoutait
   * une corvée sur un autre écran. C'est exactement le travers que le chantier
   * du 27/08 corrige — ne pas transformer une conclusion en question.
   */
  input: { date: Date; type?: DeadlineType; sourceText?: string; status?: 'proposed' | 'confirmed' },
): Promise<DeadlineItem> {
  await ensureDbReady();
  const msg = await db.message.findFirst({
    where: { id: messageId, accountSlug: account, isDeleted: false },
    select: {
      id: true,
      threadId: true,
      subject: true,
      fromEmail: true,
      fromName: true,
    },
  });
  if (!msg) throw new Error(`Mail ${messageId} introuvable pour le compte « ${account} ».`);
  if (Number.isNaN(input.date.getTime())) throw new Error('Date invalide.');

  const existing = await db.deadline.findUnique({
    where: {
      accountSlug_messageId_date: { accountSlug: account, messageId, date: input.date },
    },
  });
  const metas = await loadSourceMeta([messageId]);
  if (existing) return toItem(existing, metas.get(messageId));

  const row = await db.deadline.create({
    data: {
      accountSlug: account,
      messageId,
      threadId: msg.threadId,
      title: msg.subject ?? '(sans sujet)',
      date: input.date,
      type: input.type ?? 'other',
      status: input.status ?? 'proposed',
      confidence: 0.9,
      reason:
        input.status === 'confirmed'
          ? 'notée par toi depuis la lecture du mail'
          : 'proposée depuis le panneau de lecture (date vérifiée dans le mail ouvert)',
      sourceText: (input.sourceText ?? '').slice(0, 300),
      fromEmail: msg.fromEmail,
      fromName: msg.fromName,
      subject: msg.subject,
    },
  });
  await recordOperation({
    account,
    tool: 'propose_deadline',
    decision: input.status === 'confirmed' ? 'humaine' : 'auto',
    params: { messageId, date: input.date.toISOString(), type: row.type },
    items: [{ subject: row.title, date: input.date.toISOString() }],
    result: input.status === 'confirmed' ? 'échéance notée' : 'échéance proposée depuis la lecture',
  });
  return toItem(row, metas.get(messageId));
}
