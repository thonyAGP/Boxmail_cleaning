import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { recordOperation } from './oplog.js';
import { createTask } from './tasks.js';
import { chunk } from './attention.js';
import { isRentilaSender, parseRentilaMail, type RentilaMailInfo } from './rentila.js';
import { extractDeadlines } from './deadlines.js';
import {
  resolveMailSemanticState,
  getOpenActions,
  type EtatSemantique,
  type EtatAction,
  type Provenance,
} from './semantique.js';

/**
 * Dépouillement du courrier entrant (Lot 1 du plan validé le 02/08).
 * BASCULÉ SUR LE SOCLE au lot 4f (12/08) — c'est l'écran quotidien d'Anthony,
 * le plus gros risque de la refonte d'après la contre-revue :
 *
 *   « Migrer ses 8 fonctions séparément : deux sur le nouveau modèle, trois
 *   sur les colonnes legacy, trois sur leurs propres heuristiques. »
 *
 * La parade est STRUCTURELLE, pas disciplinaire : `reviewQueue` résout l'état
 * sémantique de TOUT le lot en une passe (resolveMailSemanticState), le
 * condense en UN objet par mail (`depouillerEtat`, fonction pure éprouvée par
 * le banc), et les fonctions internes (classifyRow, buildProposal,
 * convergence, toItem, reviewLearning) deviennent PRÉSENTATIVES : aucune ne
 * relit `intent`, `aiAction` ni `analysisConfidence` — elles reçoivent l'objet
 * résolu. Le jour où la politique de classement change, elle change à UN
 * endroit.
 *
 * L'application savait détecter, classer et noter — mais s'arrêtait juste
 * avant le geste : rien ne prenait en charge « voici tes 20 nouveaux mails,
 * décide de leur sort ». Ce service introduit l'état manquant entre « mail
 * arrivé » et « mail traité » : le mail DÉPOUILLÉ, c'est-à-dire un mail sur
 * lequel une DÉCISION a été prise (reviewedAt + reviewDecision), indépendante
 * du statut lu/non-lu d'Outlook.
 *
 * Décisions possibles :
 *  - seen   : « Vu » — marqué lu (IMAP + index), rien d'autre ;
 *  - later  : « À lire plus tard » — décision prise, lecture reportée ;
 *  - keep   : « Garder dans la boîte » — décision prise, aucun effet ;
 *  - action : « Ajouter à mes actions » — crée une tâche liée au mail ;
 *  - trash  : corbeille (soft delete, lots de 200, récupérable ~30 j) —
 *             TOUJOURS confirmée côté interface avant d'arriver ici.
 * Tout est journalisé (ui_review_decide) avec la liste exacte des mails.
 */

export type ReviewClass = 'important' | 'read' | 'range';
export type ReviewDecision = 'seen' | 'later' | 'keep' | 'action' | 'trash';
export const REVIEW_DECISIONS: ReviewDecision[] = ['seen', 'later', 'keep', 'action', 'trash'];

// ---------------------------------------------------------------- Ligne de base
// Sans borne basse, le premier dépouillement présenterait les ~26 000 mails de
// l'historique. La ligne de base est posée au premier appel (48 h en arrière)
// et n'avance jamais : la file se vide par les DÉCISIONS (reviewedAt), pas par
// le temps. Les mails plus anciens que la ligne de base sont réputés dépouillés
// par l'âge.
const BASELINE_FILE = (): string => resolve(process.cwd(), 'data', 'review-baseline.json');

function getBaseline(): Date {
  try {
    if (existsSync(BASELINE_FILE())) {
      const raw = JSON.parse(readFileSync(BASELINE_FILE(), 'utf8')) as { baseline?: string };
      const d = raw.baseline ? new Date(raw.baseline) : null;
      if (d && !Number.isNaN(d.getTime())) return d;
    }
  } catch {
    /* fichier illisible : on repart de la valeur par défaut */
  }
  const baseline = new Date(Date.now() - 48 * 3600_000);
  try {
    mkdirSync(dirname(BASELINE_FILE()), { recursive: true });
    writeFileSync(BASELINE_FILE(), JSON.stringify({ baseline: baseline.toISOString() }), 'utf8');
  } catch (err) {
    logger.warn('ligne de base du dépouillement non écrite', { error: (err as Error).message });
  }
  return baseline;
}

// ---------------------------------------------------------------- Résolution (lot 4f)

/** Catégories d'expéditeur qui exigent une décision individuelle. */
const CATEGORIES_A_DECIDER = new Set(['person', 'bank', 'admin', 'insurance']);
const CATEGORIES_BRUIT = new Set(['newsletter', 'notification', 'social', 'ad']);

/** REPLI uniquement — natures legacy à décision individuelle / rangeables.
 *  Ces listes MEURENT avec le dernier mail non analysé : sur un mail au
 *  verdict connu, aucune catégorie n'est consultée (piège n° 3, contre-revue). */
const NATURES_A_DECIDER = new Set(['invoice', 'reply_expected', 'appointment', 'reminder', 'action_required']);
const NATURES_RANGEABLES = new Set(['promo', 'confirmation', 'shipping', 'otp']);

/** Libellés FR des natures legacy citées dans les raisons du repli. */
const NATURE_LABELS: Record<string, string> = {
  invoice: 'facture', reply_expected: 'réponse attendue', appointment: 'rendez-vous',
  reminder: 'rappel', action_required: 'action à faire', promo: 'publicité',
  confirmation: 'confirmation', shipping: 'suivi de livraison', otp: 'code à usage unique',
  document: 'document', info: 'information',
};

/** Contrainte d'une action ouverte : le tri qui désigne LE geste central.
 *  Retard d'abord, puis la date la plus proche, la force, et le kind — pour
 *  qu'un mail « payer + répondre » ait UNE raison principale stable. */
const ORDRE_FORCE: Record<string, number> = { required: 0, requested: 1, optional: 2, informational: 3 };
const ORDRE_GESTE: Record<string, number> = {
  pay: 0, reply: 1, sign: 2, provide_document: 3, declare: 4, renew: 5,
  attend: 6, book: 7, call: 8, confirm: 9, review: 10, other: 11,
};

/**
 * Familles de lot côté verdict : le PURPOSE (fonction du message), libellé en
 * français. C'est lui qui garde les quittances séparées du marketing d'un même
 * expéditeur — le rôle que tenait `intent` dans l'ancienne clé de lot.
 */
const FAMILLES_VERDICT: Record<string, string> = {
  request: 'demandes',
  response: 'réponses reçues',
  notification: 'notifications',
  confirmation: 'confirmations automatiques',
  transaction_record: 'traces de transaction (reçus, quittances…)',
  document_delivery: 'documents transmis',
  security: 'codes et sécurité',
  marketing: 'publicités / newsletters',
  conversation: 'conversations',
  other: 'nature à préciser',
  unknown: 'nature à préciser',
};

/** Colonnes legacy embarquées pour le REPLI (mails sans verdict sémantique).
 *  Jamais consultées quand le verdict existe — même contrat que le
 *  `CandidatRepli` d'attention.ts. */
export interface RepereRepli {
  /** Projection de l'ancienne analyse plate (reply/pay/read/archive/none). */
  aiAction: string | null;
  /** Source de l'intent legacy. Seul usage restant : « rule » (règle regex
   *  validée par simulation) reste un signal fiable pour le régime A — le
   *  socle range « rule » sous `heuristique` et perdrait cette nuance. */
  intentSource: string | null;
}

/**
 * L'OBJET RÉSOLU que reçoivent les 8 fonctions du dépouillement. Une seule
 * carte par mail : `primaryReason` est LA raison, `secondaryReasons` des
 * mentions sous la même carte — jamais des cartes concurrentes (un mail
 * « échéance + réponse attendue + à lire » n'existe plus).
 */
export interface EtatDepouille {
  classe: ReviewClass;
  /** verdict = décidé par le socle ; repli = heuristiques legacy en attendant
   *  que ce mail soit analysé. La raison affichée avoue toujours sa provenance. */
  source: 'verdict' | 'repli';
  primaryReason: string;
  secondaryReasons: string[];
  /** L'action ouverte la plus contraignante — le geste que la carte propose. */
  geste: {
    kind: string;
    label: string | null;
    dueAt: Date | null;
    enRetard: boolean;
    montant: number | null;
    devise: string | null;
    certainty: string;
  } | null;
  veutPayer: boolean;
  veutRepondre: boolean;
  /** Intention résolue par le socle (précédence manuel > IA > heuristique). */
  nature: string | null;
  natureSource: Provenance;
  /** true si la nature peut compter comme signal de convergence (régime A). */
  natureFiable: boolean;
  resume: string | null;
  categorieExpediteur: string | null;
  /** Confiance legacy B4 — affichage seulement, n'autorise jamais rien. */
  confiance: string | null;
  /** Clé de FAMILLE du regroupement en lots (préfixée v:/n: — un mail analysé
   *  et un mail non analysé ne portent pas le même niveau de preuve). */
  lotFamille: string;
  /** Libellé FR de la famille (null = le front affiche la nature legacy). */
  lotFamilleLabel: string | null;
}

const FR_DATE_COURT = (d: Date): string => d.toLocaleDateString('fr-FR');

function libelleAction(a: EtatAction): string {
  const montant =
    a.fait.montant !== null
      ? ` (${a.fait.montant.toFixed(2).replace('.', ',')} ${a.fait.devise ?? '€'})`
      : '';
  const quand = a.enRetard
    ? ' — échéance dépassée, en retard, pas résolue'
    : a.fait.dueAt
      ? ` — à faire avant le ${FR_DATE_COURT(a.fait.dueAt)}`
      : '';
  return `« ${a.fait.label ?? a.fait.kind} »${montant}${quand}`;
}

/**
 * Condense l'état sémantique d'un mail en UN objet de dépouillement.
 * Fonction PURE (le banc l'éprouve avec des états résolus en mémoire).
 *
 * Les trois pièges de la contre-revue, tenus ici même :
 *  1. les 8 fonctions ne migrent pas séparément : elles lisent TOUTES cet
 *     objet, résolu une fois — plus aucune relecture des colonnes plates ;
 *  2. le sens n'est pas le classement : la classe (important/read/range) est
 *     une POLITIQUE DE RANGEMENT sur l'ouverture de l'action, l'échéance, le
 *     doute et la fenêtre — elle ne fabrique aucune conclusion sémantique ;
 *  3. une carte, une raison : le geste central est choisi par un tri stable,
 *     tout le reste (autres actions, échéance déjà suivie, document porté)
 *     devient une mention secondaire sous la MÊME carte.
 */
export function depouillerEtat(etat: EtatSemantique, repli: RepereRepli): EtatDepouille {
  const nature = etat.nature.valeur;
  const cat = etat.categorieExpediteur.valeur;
  const confiance = etat.analyse.confianceLegacy;
  const verdictPresent = etat.analyse.verdictPresent;
  const resume = etat.resume.valeur;

  const ouvertes = [...getOpenActions(etat)].sort(
    (a, b) =>
      Number(b.enRetard) - Number(a.enRetard) ||
      (a.fait.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) -
        (b.fait.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
      (ORDRE_FORCE[a.fait.force] ?? 9) - (ORDRE_FORCE[b.fait.force] ?? 9) ||
      (ORDRE_GESTE[a.fait.kind] ?? 99) - (ORDRE_GESTE[b.fait.kind] ?? 99),
  );
  const central = ouvertes[0] ?? null;
  const geste = central
    ? {
        kind: central.fait.kind,
        label: central.fait.label,
        dueAt: central.fait.dueAt,
        enRetard: central.enRetard,
        montant: central.fait.montant,
        devise: central.fait.devise,
        certainty: central.fait.certainty,
      }
    : null;

  // Le verdict décide seul quand il existe ; sinon les colonnes legacy (repli).
  const veutPayer = verdictPresent
    ? ouvertes.some((a) => a.fait.kind === 'pay')
    : nature === 'invoice' || repli.aiAction === 'pay';
  const veutRepondre = verdictPresent
    ? ouvertes.some((a) => a.fait.kind === 'reply')
    : nature === 'reply_expected' || repli.aiAction === 'reply';

  const echeancesActives = etat.courant.echeances.filter((e) => !e.close);
  const mentionEcheance = (e: (typeof echeancesActives)[number]): string =>
    `déjà suivie en échéance : « ${e.titre} » (${FR_DATE_COURT(e.date)}${e.echue ? ', dépassée' : ''})`;

  let classe: ReviewClass;
  let primary: string;
  const secondaires: string[] = [];

  if (verdictPresent) {
    if (central) {
      classe = 'important';
      primary = `une action reste à faire de ta part : ${libelleAction(central)} (analyse du mail)`;
      for (const a of ouvertes.slice(1)) secondaires.push(`aussi à faire : ${libelleAction(a)}`);
      for (const e of echeancesActives) secondaires.push(mentionEcheance(e));
    } else if (cat !== null && CATEGORIES_A_DECIDER.has(cat)) {
      classe = 'important';
      primary = `à décider toi-même : ${etat.categorieExpediteur.pourquoi}`;
      for (const e of echeancesActives) secondaires.push(mentionEcheance(e));
    } else if (echeancesActives.length > 0) {
      // L'obligation vit déjà ailleurs : PAS une seconde carte « à décider ».
      classe = 'read';
      primary =
        `l'obligation vit déjà en échéance : « ${echeancesActives[0].titre} » ` +
        `(${FR_DATE_COURT(echeancesActives[0].date)}) — rien d'autre à décider ici`;
      for (const e of echeancesActives.slice(1)) secondaires.push(mentionEcheance(e));
    } else if (etat.analyse.statut !== 'complete' || etat.analyse.douteLourd) {
      classe = 'read';
      primary = "l'analyse est incomplète ou déclare un doute — à lire pour décider toi-même";
    } else if (etat.courant.attention.perimee) {
      // C'est ici qu'Air France en août devient rangeable au lieu de crier
      // « dernier rappel » : la fenêtre est passée, plus rien à faire.
      classe = 'range';
      primary = `plus rien à surveiller d'après l'analyse — ${etat.courant.attention.pourquoi}`;
    } else {
      classe = 'read';
      primary = `l'analyse garde ce mail sous attention — ${etat.courant.attention.pourquoi}`;
    }
    if (etat.faits.documentsPortes.length > 0) {
      secondaires.push('porte un document (facture, contrat, attestation…) — à retrouver, jamais à perdre');
    }
    if (resume) secondaires.push(`résumé de l'analyse : ${resume}`);
  } else {
    // ---------------------------- REPLI (pas encore de verdict sémantique)
    // Le comportement historique de `classify`, à l'identique — mais sur des
    // valeurs RÉSOLUES (précédence déjà appliquée), et la raison avoue le repli.
    if (cat !== null && CATEGORIES_A_DECIDER.has(cat)) {
      classe = 'important';
      primary = `à décider toi-même : ${etat.categorieExpediteur.pourquoi}`;
    } else if (repli.aiAction === 'reply' || repli.aiAction === 'pay') {
      classe = 'important';
      primary =
        `l'ancienne analyse conclut « ${repli.aiAction === 'pay' ? 'payer' : 'répondre'} » — ` +
        'repli, pas encore de verdict sémantique';
    } else if (nature !== null && NATURES_A_DECIDER.has(nature)) {
      classe = 'important';
      primary =
        `classé « ${NATURE_LABELS[nature] ?? nature} » (${etat.nature.pourquoi})` +
        (etat.nature.source === 'manuel' ? '' : ' — repli, pas encore de verdict sémantique');
    } else if (confiance === 'low') {
      classe = 'read';
      primary = 'analyse incertaine (confiance faible) — à lire pour décider toi-même';
    } else if (cat !== null && CATEGORIES_BRUIT.has(cat)) {
      classe = 'range';
      primary = `rangeable d'un geste : ${etat.categorieExpediteur.pourquoi}`;
    } else if (nature !== null && NATURES_RANGEABLES.has(nature)) {
      classe = 'range';
      primary =
        `mail transactionnel (${NATURE_LABELS[nature] ?? nature}) — rangeable d'un geste ` +
        '(repli, pas encore de verdict)';
    } else {
      classe = 'read';
      primary = "rien ne le distingue encore — à lire (repli, ce mail n'a pas de verdict d'analyse)";
    }
    if (resume) secondaires.push(`résumé de l'analyse : ${resume}`);
  }

  return {
    classe,
    source: verdictPresent ? 'verdict' : 'repli',
    primaryReason: primary,
    secondaryReasons: secondaires,
    geste,
    veutPayer,
    veutRepondre,
    nature,
    natureSource: etat.nature.source,
    natureFiable:
      verdictPresent ||
      etat.nature.source === 'manuel' ||
      repli.intentSource === 'rule' ||
      (nature !== null && confiance === 'high'),
    resume,
    categorieExpediteur: cat,
    confiance,
    lotFamille: verdictPresent
      ? `v:${etat.faits.objet?.purpose ?? 'unknown'}`
      : `n:${nature ?? ''}`,
    lotFamilleLabel: verdictPresent
      ? (FAMILLES_VERDICT[etat.faits.objet?.purpose ?? 'unknown'] ?? 'nature à préciser')
      : null,
  };
}

interface CandidateRow {
  id: number;
  accountSlug: string;
  uid: number;
  subject: string | null;
  snippet: string | null;
  fromEmail: string | null;
  fromName: string | null;
  date: Date | null;
  isSeen: boolean;
  /** Colonnes legacy, lues UNIQUEMENT par le repli (voir RepereRepli). */
  aiAction: string | null;
  intentSource: string | null;
  folder: { path: string };
}

async function loadCandidates(): Promise<CandidateRow[]> {
  await ensureDbReady();
  const baseline = getBaseline();
  // Plus AUCUNE lecture d'intent / analysisConfidence / aiSummary ici (lot 4f) :
  // ces vérités arrivent RÉSOLUES par le socle, avec leur provenance. La
  // catégorie d'expéditeur aussi — l'ancien chargement senderCat a disparu.
  return db.message.findMany({
    where: {
      isDeleted: false,
      isOutbound: false,
      isAutoReply: false,
      reviewedAt: null,
      date: { gte: baseline },
      folder: { is: { role: 'inbox' } },
    },
    orderBy: { date: 'desc' },
    take: 500,
    select: {
      id: true, accountSlug: true, uid: true, subject: true, snippet: true,
      fromEmail: true, fromName: true, date: true, isSeen: true,
      aiAction: true, intentSource: true,
      folder: { select: { path: true } },
    },
  });
}

/**
 * L'état de dépouillement de TOUT le lot, résolu en une passe — jamais mail
 * par mail (SQLite `connection_limit=1`) : 14 requêtes constantes par lot de
 * 900, puis `depouillerEtat` en mémoire.
 */
async function resoudreLot(rows: CandidateRow[]): Promise<Map<number, EtatDepouille>> {
  const etats = await resolveMailSemanticState(rows.map((r) => r.id));
  const out = new Map<number, EtatDepouille>();
  for (const r of rows) {
    const etat = etats.get(r.id);
    if (!etat) continue; // mail disparu entre les deux requêtes : ignoré
    out.set(r.id, depouillerEtat(etat, { aiAction: r.aiAction, intentSource: r.intentSource }));
  }
  return out;
}

/**
 * Classement d'un mail pour le dépouillement, connecteur Rentila compris :
 * les notifications automatiques sont rangeables (les obligations qu'elles
 * portent vivent déjà en échéances), les messages relayés de locataires et
 * les alertes qui exigent un geste restent des décisions individuelles.
 * Hors Rentila (grammaire déterministe), la classe vient de l'objet résolu.
 */
function classifyRow(
  m: CandidateRow,
  d: EtatDepouille,
): { cls: ReviewClass; rentila: RentilaMailInfo | null } {
  if (isRentilaSender(m.fromEmail)) {
    const info = parseRentilaMail({
      subject: m.subject,
      fromEmail: m.fromEmail,
      fromName: m.fromName,
      date: m.date,
    });
    if (info) {
      if (info.noise) return { cls: 'range', rentila: info };
      const needsAction =
        info.kind === 'tenant_message' || info.kind === 'docs_missing' || info.kind === 'subscription';
      return { cls: needsAction ? 'important' : 'read', rentila: info };
    }
  }
  return { cls: d.classe, rentila: null };
}

/** Libellé lisible d'une notification Rentila pour les listes exactes. */
function rentilaDisplay(info: RentilaMailInfo, subject: string | null): string {
  const base = info.property ? `${info.label} — ${info.property}` : info.label;
  const raw = (subject ?? '').trim();
  // Les copies/téléchargements gardent le sujet d'origine visible : le label
  // seul ne dirait pas QUEL envoi est concerné.
  if ((info.kind === 'outbound_copy' || info.kind === 'download_copy' || info.kind === 'support') && raw) {
    return `${base} (« ${raw} »)`;
  }
  return base;
}

// ---------------------------------------------------------------- Propositions (chantier 2)
// La review à deux régimes (spécifiée avec ChatGPT le 03/08) :
//  - régime A (signaux convergents) : l'écran est centré sur une PROPOSITION
//    pré-remplie et éditable — « Payer Foncia — avant le 15/09 » — validée
//    d'un geste ;
//  - régime B (incertain) : AUCUNE pré-sélection — l'assistant le dit
//    honnêtement plutôt que de fabriquer une proposition à 30 %.
// Bascule booléenne : ≥ 2 signaux positifs ET 0 contradiction. Pas de score.

export interface ReviewProposal {
  objectType: 'deadline' | 'task' | 'rentila_message';
  mode: 'create' | 'confirm' | 'exists';
  /** Titre de l'objet — pour un message Rentila : le SUJET du message. */
  title: string;
  /** ISO — échéances uniquement (ou échéance LIÉE d'un message Rentila). */
  date: string | null;
  deadlineType: string;
  deadlineId: number | null;
  why: string;
  /** Message Rentila : corps pré-rédigé, éditable. */
  body?: string | null;
  /** Message Rentila : bien concerné (destinataires = locataires du bail actif). */
  property?: string | null;
  /** Message Rentila : titre de l'échéance liée (affichage de la case à cocher). */
  deadlineTitle?: string | null;
}

interface ExistingDeadline { id: number; status: string; title: string; date: Date }

const FR_DATE = (d: Date): string => d.toLocaleDateString('fr-FR');

/** « EDF » depuis le nom affiché, sinon le domaine (« foncia »), sinon générique. */
function payeeName(m: { fromName: string | null; fromEmail: string | null }): string {
  if (m.fromName?.trim()) return m.fromName.trim();
  const domain = m.fromEmail?.split('@')[1]?.split('.')[0];
  return domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : 'le créancier';
}

function firstNameOf(m: { fromName: string | null; fromEmail: string | null }): string {
  const first = (m.fromName ?? '').trim().split(/\s+/)[0];
  return first || m.fromEmail || '?';
}

/** Nature de l'échéance proposée : le GESTE décide, jamais les mots du sujet.
 *  Même table que deadlines.ts (TYPE_PAR_GESTE, non exporté là-bas — les deux
 *  convergeront au socle avec l'ontologie unique du lot 4b). */
const TYPE_PAR_GESTE: Record<string, string> = {
  pay: 'payment',
  provide_document: 'document',
  sign: 'document',
  declare: 'document',
  attend: 'appointment',
  book: 'appointment',
  call: 'appointment',
  renew: 'renewal',
};

/** Premier titre-verbe possible pour ce mail, ou null si aucune famille ne s'applique.
 *  Fonction PRÉSENTATIVE (lot 4f) : elle reçoit l'objet résolu `d` et ne relit
 *  aucune colonne plate. Exportée pour le banc (`npm run verdict:check`). */
export function buildProposal(
  m: Pick<CandidateRow, 'subject' | 'fromEmail' | 'fromName' | 'date'>,
  existing: ExistingDeadline | null,
  rentila: RentilaMailInfo | null,
  d: EtatDepouille,
): ReviewProposal | null {
  const subject = (m.subject ?? '').replace(/\s+/g, ' ').trim() || '(sans sujet)';

  // Assurance locataire expirée / à échoir : le bon geste est RENTILA par
  // défaut (retour utilisateur 03/08 : « tu vois bien que c'est du Rentila »)
  // — un message au locataire via la messagerie de la plateforme, pré-rédigé,
  // avec la confirmation de l'échéance liée embarquée dans le même geste.
  if (rentila && (rentila.kind === 'insurance_expired' || rentila.kind === 'insurance_expiring') && rentila.property) {
    const expired = rentila.kind === 'insurance_expired';
    return {
      objectType: 'rentila_message', mode: 'create',
      title: "Attestation d'assurance habitation à mettre à jour",
      body: `Bonjour,\n\nVotre attestation d'assurance habitation pour le logement ${rentila.property} `
        + (expired ? 'est expirée.' : 'arrive à expiration.')
        + `\n\nMerci de téléverser votre attestation en cours de validité dans votre espace locataire Rentila, rubrique « Documents ».\n\nCordialement`,
      property: rentila.property,
      date: existing?.date.toISOString() ?? null,
      deadlineType: 'renewal',
      deadlineId: existing?.id ?? null,
      deadlineTitle: existing?.title ?? null,
      why: expired
        ? "L'assurance de ce logement est expirée — le locataire doit téléverser sa nouvelle attestation."
        : "L'assurance de ce logement expire bientôt — autant prévenir le locataire dès maintenant.",
    };
  }

  // Notification Rentila dont l'obligation vit DÉJÀ en échéance (créée par la
  // détection automatique) : jamais de doublon — confirmer, ou continuer.
  if (rentila && existing) {
    return {
      objectType: 'deadline',
      mode: existing.status === 'confirmed' ? 'exists' : 'confirm',
      title: existing.title,
      date: existing.date.toISOString(),
      deadlineType: 'other',
      deadlineId: existing.id,
      why: existing.status === 'confirmed'
        ? 'Cette notification a déjà son échéance confirmée.'
        : 'Cette notification a déjà été transformée en échéance — confirme-la, ou ajuste-la.',
    };
  }

  if (rentila?.kind === 'tenant_message') {
    return {
      objectType: 'task', mode: 'create',
      title: `Traiter avec le locataire — ${subject}`.slice(0, 200),
      date: null, deadlineType: 'other', deadlineId: null,
      why: 'Un locataire signale un problème qui demande probablement un suivi.',
    };
  }

  // -------------------------------------------- le verdict, quand il existe
  // LUI SEUL décide : aucune regex sur ce mail — une date que l'analyse n'a
  // pas su lire n'est PAS re-devinée dans le sujet (piège n° 3 des échéances :
  // rien d'inventé). Le repli plus bas garde l'ancien comportement, motifs de
  // sujet compris, pour l'immense majorité des mails pas encore analysés.
  if (d.source === 'verdict') {
    const g = d.geste;
    if (!g) {
      // Rien d'ouvert. Si une échéance suit déjà ce mail, on la montre au lieu
      // de proposer un doublon ; sinon il n'y a honnêtement rien à proposer.
      if (existing) {
        return {
          objectType: 'deadline',
          mode: existing.status === 'confirmed' ? 'exists' : 'confirm',
          title: existing.title, date: existing.date.toISOString(),
          deadlineType: 'other', deadlineId: existing.id,
          why: existing.status === 'confirmed'
            ? 'Cette obligation a déjà son échéance confirmée.'
            : 'Une échéance existe déjà pour ce mail — confirme-la, ou ajuste-la.',
        };
      }
      return null;
    }
    const montant = g.montant !== null
      ? ` (${g.montant.toFixed(2).replace('.', ',')} ${g.devise ?? '€'})`
      : '';
    if (g.kind === 'reply') {
      return {
        objectType: 'task', mode: 'create',
        title: (g.label ?? `Répondre à ${firstNameOf(m)}`).slice(0, 200),
        date: null, deadlineType: 'other', deadlineId: null,
        why: "L'analyse du mail déclare une réponse encore attendue de ta part.",
      };
    }
    if (existing?.status === 'confirmed') {
      return {
        objectType: 'deadline', mode: 'exists',
        title: existing.title, date: existing.date.toISOString(),
        deadlineType: TYPE_PAR_GESTE[g.kind] ?? 'other', deadlineId: existing.id,
        why: 'Cette obligation a déjà son échéance confirmée.',
      };
    }
    const titreGeste = g.label ?? (g.kind === 'pay' ? `Payer ${payeeName(m)}` : subject.replace(/^(re|fwd?|tr)\s*:\s*/i, ''));
    const date = existing?.date ?? g.dueAt ?? null;
    if (date) {
      return {
        objectType: 'deadline', mode: existing ? 'confirm' : 'create',
        title: `${titreGeste} — avant le ${FR_DATE(date)}`.slice(0, 200),
        date: date.toISOString(),
        deadlineType: TYPE_PAR_GESTE[g.kind] ?? 'other',
        deadlineId: existing?.id ?? null,
        why: `L'analyse du mail déclare une action à faire de ta part${montant}, due le ${FR_DATE(date)} (verdict sémantique, pas une date trouvée dans le texte).`,
      };
    }
    return {
      objectType: 'task', mode: 'create',
      title: titreGeste.slice(0, 200), date: null, deadlineType: 'other', deadlineId: null,
      why: `L'analyse du mail déclare une action à faire de ta part${montant}, sans date lisible — rien d'inventé.`,
    };
  }

  // ------------------------------ REPLI (pas encore de verdict sémantique)
  if (d.veutPayer) {
    const payee = payeeName(m);
    if (existing?.status === 'confirmed') {
      return {
        objectType: 'deadline', mode: 'exists',
        title: existing.title, date: existing.date.toISOString(),
        deadlineType: 'payment', deadlineId: existing.id,
        why: 'Cette facture a déjà son échéance confirmée.',
      };
    }
    const date = existing?.date ?? extractDeadlines(subject, m.date ?? new Date())[0]?.date ?? null;
    if (date) {
      return {
        objectType: 'deadline', mode: existing ? 'confirm' : 'create',
        title: `Payer ${payee} — avant le ${FR_DATE(date)}`.slice(0, 200),
        date: date.toISOString(), deadlineType: 'payment', deadlineId: existing?.id ?? null,
        why: `J'ai reconnu une facture et trouvé une échéance au ${FR_DATE(date)} (lu dans le sujet — repli, pas encore d'analyse).`,
      };
    }
    return {
      objectType: 'task', mode: 'create',
      title: `Payer ${payee}`.slice(0, 200), date: null, deadlineType: 'other', deadlineId: null,
      why: `J'ai reconnu une facture de ${payee}, sans date d'échéance lisible (repli, pas encore d'analyse).`,
    };
  }

  if (d.veutRepondre) {
    return {
      objectType: 'task', mode: 'create',
      title: `Répondre à ${firstNameOf(m)}`.slice(0, 200),
      date: null, deadlineType: 'other', deadlineId: null,
      why: 'Le dernier message du fil attend probablement ta réponse.',
    };
  }

  // « Action à faire » (voter, signer, activer…) : ni une réponse, ni une
  // simple information — une tâche, avec le sujet (souvent déjà un impératif :
  // « Vote now! … ») comme intitulé.
  if (d.nature === 'action_required') {
    return {
      objectType: 'task', mode: 'create',
      title: subject.replace(/^(re|fwd?|tr)\s*:\s*/i, '').slice(0, 200),
      date: null, deadlineType: 'other', deadlineId: null,
      why: 'Ce mail demande une action de ta part (pas une réponse).',
    };
  }

  if (d.nature === 'appointment') {
    if (existing?.status === 'confirmed') {
      return {
        objectType: 'deadline', mode: 'exists',
        title: existing.title, date: existing.date.toISOString(),
        deadlineType: 'appointment', deadlineId: existing.id,
        why: 'Ce rendez-vous a déjà son échéance confirmée.',
      };
    }
    const date = existing?.date ?? extractDeadlines(subject, m.date ?? new Date())[0]?.date ?? null;
    if (!date) return null; // pas de date → rien à proposer honnêtement
    return {
      objectType: 'deadline', mode: existing ? 'confirm' : 'create',
      title: `Rendez-vous : ${subject}`.slice(0, 200),
      date: date.toISOString(), deadlineType: 'appointment', deadlineId: existing?.id ?? null,
      why: `Une date de rendez-vous a été détectée (${FR_DATE(date)}).`,
    };
  }

  return null;
}

/**
 * Régime A ou B ? Booléen : au moins 2 signaux positifs indépendants ET
 * aucune contradiction entre sources fortes. Présentative (lot 4f) : tout
 * vient de l'objet résolu — l'historique des gestes n'est plus clefé sur
 * `intent` (voir reviewLearning pour la justification de la nouvelle clé).
 */
function convergence(
  d: EtatDepouille,
  hasDate: boolean,
  history: { decision: ReviewDecision; count: number; mixed: boolean } | undefined,
): boolean {
  const positives: string[] = [];
  if (d.categorieExpediteur) positives.push('sender');
  if (d.natureFiable && d.nature !== null) positives.push('intent');
  if (hasDate) positives.push('date');
  if (history && !history.mixed && history.count >= 3) positives.push('history');

  const promoLike = d.nature === 'promo' || d.nature === 'otp';
  const trustedCat = CATEGORIES_A_DECIDER.has(d.categorieExpediteur ?? '');
  const noiseCat = CATEGORIES_BRUIT.has(d.categorieExpediteur ?? '');
  const contradiction =
    (promoLike && trustedCat) ||
    (noiseCat && d.veutRepondre) ||
    (history?.mixed === false && history.decision === 'trash' && (d.veutPayer || d.veutRepondre));

  return positives.length >= 2 && !contradiction;
}

/** Présentative (lot 4f) : tout ce qui s'affiche vient de l'objet résolu `d`
 *  — l'intention montrée est la RÉSOLUE (précédence appliquée), la raison est
 *  `primaryReason` (une carte, une raison, qui avoue sa provenance). */
function toItem(
  m: CandidateRow,
  cls: ReviewClass,
  d: EtatDepouille | null,
  rentila?: RentilaMailInfo | null,
) {
  return {
    id: m.id,
    account: m.accountSlug,
    folder: m.folder.path,
    uid: m.uid,
    subject: m.subject ?? '(sans sujet)',
    snippet: (m.snippet ?? '').slice(0, 160),
    fromEmail: m.fromEmail,
    fromName: m.fromName,
    date: m.date?.toISOString() ?? null,
    isSeen: m.isSeen,
    intent: d?.nature ?? null,
    /** Le geste attendu est une réponse (libellé du bouton « Lire et répondre »). */
    veutRepondre: d?.veutRepondre ?? false,
    aiSummary: d?.resume ?? null,
    confidence: d?.confiance ?? null,
    senderCategory: d?.categorieExpediteur ?? null,
    class: cls,
    /** LA raison de la carte + mentions secondaires (jamais d'autres cartes). */
    primaryReason: d?.primaryReason ?? null,
    secondaryReasons: d?.secondaryReasons ?? [],
    /** Lecture Rentila du mail (« Assurance locataire expirée — 101… »), sinon null. */
    rentilaLabel: rentila ? rentilaDisplay(rentila, m.subject) : null,
    /** Chantier 2 — posés par l'enrichissement de reviewQueue. */
    regime: null as 'A' | 'B' | null,
    proposal: null as ReviewProposal | null,
  };
}
export type ReviewItem = ReturnType<typeof toItem>;

export interface ReviewLot {
  kind: 'lot';
  account: string;
  fromEmail: string;
  fromName: string | null;
  /** Nature legacy — repli uniquement (le front l'affiche via ses libellés). */
  intent: string | null;
  /** Libellé FR de la famille quand le verdict a rangé le lot, sinon null. */
  familleLabel: string | null;
  senderCategory: string | null;
  count: number;
  ids: number[];
  /** Échantillon (10 max) pour la liste exacte affichée avant décision. */
  samples: { id: number; subject: string; date: string | null; folder: string; uid: number }[];
  /** true = lot « 🏠 Alertes Rentila » (toutes notifications confondues). */
  rentila?: boolean;
}
export interface ReviewSingle {
  kind: 'single';
  item: ReviewItem;
}
export type ReviewGroup = ReviewSingle | ReviewLot;

/** Compteurs pour la carte « N nouveaux mails attendent une décision ». */
export async function reviewSummary(): Promise<{
  total: number;
  important: number;
  read: number;
  range: number;
  reviewedToday: number;
  laterCount: number;
  baseline: string;
}> {
  const rows = await loadCandidates();
  const depouilles = await resoudreLot(rows);
  let important = 0;
  let read = 0;
  let range = 0;
  for (const m of rows) {
    const d = depouilles.get(m.id);
    if (!d) continue;
    const { cls } = classifyRow(m, d);
    if (cls === 'important') important++;
    else if (cls === 'read') read++;
    else range++;
  }
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [reviewedToday, laterCount] = await Promise.all([
    db.message.count({ where: { reviewedAt: { gte: startOfDay } } }),
    db.message.count({ where: { reviewDecision: 'later', isDeleted: false } }),
  ]);
  return {
    total: rows.length,
    important,
    read,
    range,
    reviewedToday,
    laterCount,
    baseline: getBaseline().toISOString(),
  };
}

/**
 * File du parcours : les importants un par un, puis les « à lire », puis le
 * rangeable par LOTS homogènes.
 *
 * CLÉ DE LOT (lot 4f) : compte + expéditeur + FAMILLE résolue — `intent` en
 * est sorti. Un lot, c'est « la même décision qui se répète » ; ce qui rend la
 * décision identique, c'est QUI envoie et POUR QUOI FAIRE le message existe :
 *  - mail analysé : le purpose du verdict (`v:transaction_record`…) — c'est
 *    lui qui garde le loyer en retard hors du lot des quittances ;
 *  - mail pas encore analysé : la nature RÉSOLUE par le socle (`n:promo`…),
 *    précédence manuel > IA > heuristique déjà appliquée.
 * Les préfixes v:/n: empêchent un mail analysé et un mail non analysé de se
 * retrouver dans le même lot : ils ne portent pas le même niveau de preuve,
 * on ne leur applique pas un geste commun sur la foi de deux vocabulaires.
 */
export async function reviewQueue(): Promise<{ groups: ReviewGroup[]; total: number }> {
  const rows = await loadCandidates();
  // L'état sémantique de TOUT le lot, résolu en UNE passe (comme
  // getUnansweredEmails) : les 8 fonctions en aval ne relisent plus rien.
  const depouilles = await resoudreLot(rows);
  const singles: ReviewSingle[] = [];
  const lots = new Map<string, ReviewLot>();
  let total = 0;

  for (const m of rows) {
    const d = depouilles.get(m.id);
    if (!d) continue;
    const { cls, rentila } = classifyRow(m, d);
    total++;
    if (cls !== 'range' || !m.fromEmail) {
      singles.push({ kind: 'single', item: toItem(m, cls, d, rentila) });
      continue;
    }
    // Toutes les notifications Rentila d'un compte forment UN lot (peu importe
    // la famille) : c'est la même décision — « j'ai vu, les obligations sont
    // déjà dans le calendrier ».
    const key = rentila
      ? `${m.accountSlug}|__rentila__`
      : `${m.accountSlug}|${m.fromEmail}|${d.lotFamille}`;
    if (!lots.has(key)) {
      lots.set(key, {
        kind: 'lot',
        account: m.accountSlug,
        fromEmail: m.fromEmail,
        fromName: rentila ? 'Rentila' : m.fromName,
        // Familles à deux régimes : verdict → libellé FR ; repli → la nature
        // legacy, que le front sait déjà libeller.
        intent: rentila || d.lotFamilleLabel ? null : d.nature,
        familleLabel: rentila ? null : d.lotFamilleLabel,
        senderCategory: rentila ? 'notification' : d.categorieExpediteur,
        count: 0,
        ids: [],
        samples: [],
        ...(rentila ? { rentila: true } : {}),
      });
    }
    const lot = lots.get(key)!;
    lot.count++;
    lot.ids.push(m.id);
    if (lot.samples.length < 10) {
      lot.samples.push({
        id: m.id,
        subject: rentila ? rentilaDisplay(rentila, m.subject) : m.subject ?? '(sans sujet)',
        date: m.date?.toISOString() ?? null,
        folder: m.folder.path,
        uid: m.uid,
      });
    }
  }

  // Ordre du parcours (§11) : importants (récents d'abord — la liste l'est
  // déjà), à lire, puis les lots du plus gros au plus petit. Un « lot » d'un
  // seul mail redevient une décision individuelle.
  const ordered: ReviewGroup[] = [
    ...singles.filter((s) => s.item.class === 'important'),
    ...singles.filter((s) => s.item.class === 'read'),
  ];
  const sortedLots = [...lots.values()].sort((a, b) => b.count - a.count);
  for (const lot of sortedLots) {
    if (lot.count === 1) {
      const s = lot.samples[0];
      const row = rows.find((r) => r.id === s.id)!;
      const info = lot.rentila
        ? parseRentilaMail({ subject: row.subject, fromEmail: row.fromEmail, fromName: row.fromName, date: row.date })
        : null;
      ordered.push({ kind: 'single', item: toItem(row, 'range', depouilles.get(row.id) ?? null, info) });
    } else {
      ordered.push(lot);
    }
  }
  const groups = ordered.slice(0, 120);

  // ---- Chantier 2 : régime A/B + proposition sur les décisions individuelles.
  const singleItems = groups
    .filter((g): g is ReviewSingle => g.kind === 'single')
    .map((g) => g.item)
    .filter((it) => it.class !== 'range'); // le bruit garde son écran actuel (Vu par défaut)

  if (singleItems.length > 0) {
    // Échéances déjà connues pour ces mails (dédoublonnage : confirmer, jamais recréer).
    const dls = await db.deadline.findMany({
      where: {
        messageId: { in: singleItems.map((it) => it.id) },
        status: { in: ['proposed', 'confirmed'] },
      },
      orderBy: { date: 'asc' },
      select: { id: true, messageId: true, status: true, title: true, date: true },
    });
    const dlByMsg = new Map<number, ExistingDeadline>();
    for (const d of dls) {
      // confirmée > proposée ; sinon la plus proche dans le temps.
      const prev = dlByMsg.get(d.messageId);
      if (!prev || (d.status === 'confirmed' && prev.status !== 'confirmed')) dlByMsg.set(d.messageId, d);
    }

    // Historique des gestes par motif (signal + contradiction) — même clé que
    // l'apprentissage : compte + expéditeur, sans `intent` (voir reviewLearning).
    const decided = await db.message.groupBy({
      by: ['accountSlug', 'fromEmail', 'reviewDecision'],
      where: { reviewedAt: { not: null }, reviewDecision: { in: ['seen', 'trash', 'keep'] }, fromEmail: { not: null } },
      _count: { _all: true },
    });
    const history = new Map<string, { decision: ReviewDecision; count: number; mixed: boolean }>();
    for (const dec of decided) {
      const key = `${dec.accountSlug}|${dec.fromEmail}`;
      const prev = history.get(key);
      if (!prev) history.set(key, { decision: dec.reviewDecision as ReviewDecision, count: dec._count._all, mixed: false });
      else {
        prev.mixed = true;
        if (dec._count._all > prev.count) {
          prev.decision = dec.reviewDecision as ReviewDecision;
          prev.count = dec._count._all;
        }
      }
    }

    for (const it of singleItems) {
      const row = rows.find((r) => r.id === it.id);
      const d = depouilles.get(it.id);
      if (!row || !d) continue;
      const rentila = isRentilaSender(row.fromEmail)
        ? parseRentilaMail({ subject: row.subject, fromEmail: row.fromEmail, fromName: row.fromName, date: row.date })
        : null;
      const existing = dlByMsg.get(it.id) ?? null;
      const proposal = buildProposal(row, existing, rentila, d);
      const hist = row.fromEmail ? history.get(`${row.accountSlug}|${row.fromEmail}`) : undefined;
      // Régime A d'office quand la source est déterministe : grammaire Rentila
      // (construite sur les sujets réels), correction MANUELLE (la vérité par
      // définition), « action à faire » (règle regex validée par simulation
      // sur les ~26 000 sujets de prod le 03/08), ou verdict sémantique dont
      // le geste est affirmé (explicit / strong_inference — jamais une
      // inférence faible : elle repasse par la convergence de signaux).
      const regimeA = proposal !== null
        && (rentila !== null
          || d.natureSource === 'manuel'
          || d.nature === 'action_required'
          || (d.source === 'verdict' && d.geste !== null
            && (d.geste.certainty === 'explicit' || d.geste.certainty === 'strong_inference'))
          || convergence(d, existing !== null || proposal.date !== null, hist));
      it.regime = regimeA ? 'A' : 'B';
      it.proposal = regimeA ? proposal : null;
    }
  }

  return { groups, total };
}

// ---------------------------------------------------------------- Apprentissage
// Lot 3 du plan : l'assistant observe les DÉCISIONS répétées (même compte,
// même expéditeur → même geste ; `intent` a quitté la clé au lot 4f) et les
// restitue :
//  - 2 gestes identiques  → simple remarque en fin de dépouillement ;
//  - 3 gestes cohérents ou plus → proposition explicite, avec la liste exacte
//    des mails EN ATTENTE qui seraient concernés (« Voir les N mails »).
// Un motif contredit (gestes différents sur la même clé) n'est JAMAIS proposé,
// et « Ne plus proposer » est définitif (data/review-learning.json).
// L'application d'une proposition repasse par reviewDecide (journalisée), la
// corbeille restant confirmée côté interface — rien n'est jamais automatisé.

const LEARNING_FILE = (): string => resolve(process.cwd(), 'data', 'review-learning.json');

function readLearningState(): { dismissed: Record<string, string> } {
  try {
    if (existsSync(LEARNING_FILE())) {
      const raw = JSON.parse(readFileSync(LEARNING_FILE(), 'utf8')) as { dismissed?: Record<string, string> };
      if (raw && typeof raw.dismissed === 'object' && raw.dismissed) return { dismissed: raw.dismissed };
    }
  } catch {
    /* fichier illisible : on repart d'un état vide */
  }
  return { dismissed: {} };
}

export interface LearningMotif {
  key: string;
  account: string;
  fromEmail: string;
  fromName: string | null;
  /** Toujours null depuis le lot 4f (l'intention a quitté la clé du motif) —
   *  champ conservé : le front l'affiche quand il est présent. */
  intent: string | null;
  decision: ReviewDecision;
  /** Nombre de gestes identiques déjà faits par l'utilisateur. */
  count: number;
  /** Mails encore en attente de décision qui correspondent au motif. */
  pendingIds: number[];
  pendingSamples: { subject: string; date: string | null }[];
}

/** Seuls ces gestes s'apprennent : un « plus tard » ou une tâche créée ne
 *  disent rien de généralisable sur l'expéditeur. */
const LEARNABLE: ReviewDecision[] = ['seen', 'trash', 'keep'];

export async function reviewLearning(): Promise<{ notes: LearningMotif[]; proposals: LearningMotif[] }> {
  await ensureDbReady();
  const decided = await db.message.findMany({
    where: { reviewedAt: { not: null }, reviewDecision: { in: LEARNABLE }, fromEmail: { not: null } },
    orderBy: { reviewedAt: 'desc' },
    take: 2000,
    select: { accountSlug: true, fromEmail: true, fromName: true, reviewDecision: true },
  });

  // Décompte par clé compte|expéditeur, toutes décisions confondues (pour
  // détecter les contradictions). `intent` est SORTI de la clé (lot 4f) : les
  // gestes passés ne portent pas l'état sémantique du moment où ils ont été
  // faits, et un motif clefé sur du vocabulaire legacy survivrait à sa
  // disparition. Conséquence assumée : un expéditeur aux gestes différents
  // selon la nature (quittances « vu », relances « gardé ») devient un motif
  // CONTREDIT — donc jamais proposé. C'est le sens du garde-fou : mieux vaut
  // zéro proposition qu'une proposition qui généralise à tort.
  const tally = new Map<string, {
    account: string; fromEmail: string; fromName: string | null;
    byDecision: Map<ReviewDecision, number>;
  }>();
  for (const m of decided) {
    const key = `${m.accountSlug}|${m.fromEmail}`;
    if (!tally.has(key)) {
      tally.set(key, {
        account: m.accountSlug, fromEmail: m.fromEmail!, fromName: m.fromName,
        byDecision: new Map(),
      });
    }
    const t = tally.get(key)!.byDecision;
    const d = m.reviewDecision as ReviewDecision;
    t.set(d, (t.get(d) ?? 0) + 1);
  }

  const { dismissed } = readLearningState();
  // Un « Ne plus proposer » posé AVANT le lot 4f portait l'ancienne clé
  // (compte|expéditeur|intent|décision) : il continue de faire taire le motif
  // pour ce même expéditeur et ce même geste, quelle que soit l'intention.
  const ecarteAvantLot4f = (account: string, email: string, decision: ReviewDecision): boolean =>
    Object.keys(dismissed).some(
      (k) => k.startsWith(`${account}|${email}|`) && k.endsWith(`|${decision}`),
    );
  const rows = await loadCandidates();
  const notes: LearningMotif[] = [];
  const proposals: LearningMotif[] = [];

  for (const [key, t] of tally) {
    // Motif cohérent = UNE seule décision observée sur la clé. Dès que
    // l'utilisateur a corrigé (gestes différents), le motif disparaît.
    if (t.byDecision.size !== 1) continue;
    const [decision, count] = [...t.byDecision.entries()][0];
    if (count < 2) continue;
    const motifKey = `${key}|${decision}`;
    if (dismissed[motifKey] || ecarteAvantLot4f(t.account, t.fromEmail, decision)) continue;

    const pending = rows.filter((r) =>
      r.accountSlug === t.account && r.fromEmail === t.fromEmail);
    const motif: LearningMotif = {
      key: motifKey,
      account: t.account,
      fromEmail: t.fromEmail,
      fromName: t.fromName,
      intent: null,
      decision,
      count,
      pendingIds: pending.map((r) => r.id),
      pendingSamples: pending.slice(0, 8).map((r) => ({
        subject: r.subject ?? '(sans sujet)',
        date: r.date?.toISOString() ?? null,
      })),
    };
    // Proposition seulement si elle a une prise concrète (des mails en attente).
    if (count >= 3 && motif.pendingIds.length > 0) proposals.push(motif);
    else if (count === 2) notes.push(motif);
  }

  proposals.sort((a, b) => b.pendingIds.length - a.pendingIds.length);
  notes.sort((a, b) => b.count - a.count);
  return { notes: notes.slice(0, 5), proposals: proposals.slice(0, 5) };
}

/** « Ne plus proposer » — définitif, journalisé. */
export async function reviewLearningDismiss(key: string): Promise<void> {
  const state = readLearningState();
  state.dismissed[key] = new Date().toISOString();
  mkdirSync(dirname(LEARNING_FILE()), { recursive: true });
  writeFileSync(LEARNING_FILE(), JSON.stringify(state, null, 2), 'utf8');
  const [account] = key.split('|');
  await recordOperation({
    account: account || '*',
    tool: 'ui_review_learning_dismiss',
    params: { key },
    result: `apprentissage : proposition « ${key} » écartée définitivement`,
  });
}

// ---------------------------------------------------------------- Décision
/**
 * De quoi ramener un lot mis à la corbeille (bandeau « Annuler » 10 s).
 * Un groupe par compte+dossier d'origine ; `trashUids` sont les UIDs pris
 * dans la corbeille (COPYUID). Absent = annulation impossible, et le bandeau
 * ne s'affiche pas plutôt que de promettre un retour qui n'aura pas lieu.
 */
export interface UndoTrashGroup {
  account: string;
  folder: string;
  uids: number[];
  trashUids: number[];
  messageIds: number[];
}

export interface DecideResult {
  count: number;
  decision: ReviewDecision;
  tasksCreated: number;
  errors: string[];
  undo?: UndoTrashGroup[];
}

/**
 * Applique UNE décision à un ou plusieurs mails. Les effets réels (marquer lu,
 * corbeille) passent par IMAP compte par compte, dossier par dossier, lots de
 * 200 — et l'index est mis à jour dans la foulée. Un dossier injoignable
 * n'empêche pas la décision d'être enregistrée : l'état IMAP se recalera à la
 * synchronisation suivante.
 */
export async function reviewDecide(ids: number[], decision: ReviewDecision): Promise<DecideResult> {
  await ensureDbReady();
  if (!REVIEW_DECISIONS.includes(decision)) throw new Error(`Décision inconnue : ${decision}`);
  const unique = [...new Set(ids)].slice(0, 500);
  const messages = await db.message.findMany({
    where: { id: { in: unique }, isDeleted: false },
    select: {
      id: true, accountSlug: true, uid: true, subject: true, date: true,
      fromEmail: true, fromName: true, folder: { select: { path: true } },
    },
  });
  if (messages.length === 0) return { count: 0, decision, tasksCreated: 0, errors: [] };

  const errors: string[] = [];
  let tasksCreated = 0;

  // Effets réels, groupés par compte + dossier.
  const undo: UndoTrashGroup[] = [];
  if (decision === 'seen' || decision === 'trash') {
    // Import différé (même raison que deadlines.ts) : imap.ts tire config.ts,
    // qui exige le .env dès le chargement — or le banc (`npm run
    // verdict:check`) importe ce fichier pour éprouver les fonctions pures.
    const [{ imapService }, { resolveAccount }] = await Promise.all([
      import('./imap.js'),
      import('./accounts.js'),
    ]);
    const byTarget = new Map<
      string,
      { account: string; folder: string; uids: number[]; messageIds: number[] }
    >();
    for (const m of messages) {
      const key = `${m.accountSlug}|${m.folder.path}`;
      if (!byTarget.has(key)) {
        byTarget.set(key, { account: m.accountSlug, folder: m.folder.path, uids: [], messageIds: [] });
      }
      byTarget.get(key)!.uids.push(m.uid);
      byTarget.get(key)!.messageIds.push(m.id);
    }
    for (const t of byTarget.values()) {
      try {
        const rec = await resolveAccount(t.account);
        const trashUids: number[] = [];
        for (const part of chunk(t.uids, 200)) {
          if (decision === 'seen') await imapService.markEmails(rec, t.folder, part, ['\\Seen'], []);
          else {
            const r = await imapService.moveToTrash(rec, t.folder, part);
            if (r.newUids.length === part.length) trashUids.push(...r.newUids);
          }
        }
        // Annulation proposée seulement si le serveur a rendu TOUS les UIDs de
        // corbeille : mieux vaut pas de bandeau qu'un retour partiel.
        if (decision === 'trash' && trashUids.length === t.uids.length) {
          undo.push({ account: t.account, folder: t.folder, uids: t.uids, trashUids, messageIds: t.messageIds });
        }
      } catch (err) {
        errors.push(`${t.account}/${t.folder} : ${(err as Error).message}`);
        logger.warn('dépouillement : effet IMAP en échec (index quand même mis à jour)', {
          account: t.account, folder: t.folder, decision, error: (err as Error).message,
        });
      }
    }
  }
  if (decision === 'action') {
    for (const m of messages) {
      try {
        await createTask({
          title: `Traiter : ${m.subject ?? '(sans sujet)'}`,
          account: m.accountSlug,
          messageRef: { folder: m.folder.path, uid: m.uid },
          source: 'mail',
        });
        tasksCreated++;
      } catch (err) {
        errors.push(`tâche « ${m.subject ?? ''} » : ${(err as Error).message}`);
      }
    }
  }

  // La décision elle-même + reflet local des effets.
  const now = new Date();
  const idList = messages.map((m) => m.id);
  await db.message.updateMany({
    where: { id: { in: idList } },
    data: {
      reviewedAt: now,
      reviewDecision: decision,
      ...(decision === 'seen' ? { isSeen: true } : {}),
      ...(decision === 'trash' ? { isDeleted: true } : {}),
    },
  });

  const accounts = [...new Set(messages.map((m) => m.accountSlug))];
  const DECISION_LABELS: Record<ReviewDecision, string> = {
    seen: 'marqué(s) vu(s)',
    later: 'gardé(s) à lire plus tard',
    keep: 'gardé(s) dans la boîte',
    action: 'ajouté(s) aux actions (tâche créée)',
    trash: 'mis à la corbeille (récupérables ~30 j)',
  };
  await recordOperation({
    account: accounts.length === 1 ? accounts[0] : '*',
    tool: 'ui_review_decide',
    params: { decision, count: messages.length },
    affectedUids: messages.map((m) => m.uid),
    items: messages.slice(0, 500).map((m) => ({
      subject: m.subject ?? '(sans sujet)',
      date: m.date?.toISOString() ?? null,
      // Corbeille : le mail a bougé, pas de lien (il serait mort).
      ...(decision === 'trash' ? {} : { folder: m.folder.path, uid: m.uid }),
    })),
    result: `dépouillement : ${messages.length} mail(s) ${DECISION_LABELS[decision]}`,
  });

  return { count: messages.length, decision, tasksCreated, errors, ...(undo.length ? { undo } : {}) };
}

/**
 * Annulation d'une mise à la corbeille faite au dépouillement (bandeau 10 s).
 * Trajet inverse exact : les mails reviennent de la corbeille dans leur
 * dossier d'origine, l'index est réveillé (isDeleted=false, nouvel UID) et la
 * décision est effacée — le mail se represente au dépouillement.
 */
export async function reviewRestore(groups: UndoTrashGroup[]): Promise<{ restored: number }> {
  await ensureDbReady();
  // Import différé — voir reviewDecide (le banc importe ce fichier).
  const [{ imapService }, { resolveAccount }] = await Promise.all([
    import('./imap.js'),
    import('./accounts.js'),
  ]);
  let restored = 0;
  for (const g of groups) {
    if (!g?.folder || !Array.isArray(g.trashUids) || g.trashUids.length === 0) continue;
    const rec = await resolveAccount(g.account);
    const r = await imapService.restoreFromTrash(rec, g.trashUids.slice(0, 500), g.folder);
    restored += r.moved;
    // Les mails reprennent de nouveaux UIDs : on repointe ligne par ligne
    // (une collision d'UID ne doit pas faire échouer le reste).
    const ids = g.messageIds ?? [];
    for (let i = 0; i < ids.length; i++) {
      try {
        await db.message.update({
          where: { id: ids[i] },
          data: {
            isDeleted: false,
            reviewedAt: null,
            reviewDecision: null,
            ...(r.newUids[i] ? { uid: r.newUids[i] } : {}),
          },
        });
      } catch {
        /* la sync a déjà recréé la ligne sous sa nouvelle identité */
      }
    }
    await recordOperation({
      account: g.account,
      tool: 'ui_review_undo',
      folder: g.folder,
      params: { count: r.moved, from: r.trash },
      affectedUids: g.uids,
      result: `annulation : ${r.moved} mail(s) ramené(s) de ${r.trash} vers ${g.folder}`,
    });
  }
  return { restored };
}

// ---------------------------------------------------------------- Validation (chantier 2)
export interface ValidateProposalInput {
  messageId: number;
  objectType: 'deadline' | 'task' | 'rentila_message';
  title: string;
  /** ISO — requis pour une échéance. */
  date?: string | null;
  deadlineType?: string;
  deadlineId?: number | null;
  /** « Déjà fait » : l'action a eu lieu — on la CONSIGNE (statut done)
   *  au lieu de la mettre au programme. L'historique garde le fait. */
  markDone?: boolean;
  /** ISO — quand l'action a été faite (défaut : maintenant). */
  doneAt?: string | null;
  /** Message Rentila : corps validé (envoyé tel quel par Claude). */
  body?: string | null;
  /** Message Rentila : bien concerné (destinataires = bail actif). */
  property?: string | null;
  /** Message Rentila : confirmer aussi l'échéance liée (deadlineId). */
  confirmDeadline?: boolean;
}

/**
 * Valider une proposition = DEUX effets indissociables (spéc. actée 03/08) :
 * l'objet métier est créé/confirmé ET le mail est dépouillé — dans une même
 * transaction SQLite, avec UNE ligne de journal. L'effet IMAP (marquer lu)
 * reste hors transaction, tolérant comme partout. Idempotence par l'ÉTAT
 * COMPLET : objet présent + mail non dépouillé → seule la décision est
 * appliquée ; les deux présents → « déjà fait ».
 */
export async function validateProposal(input: ValidateProposalInput): Promise<{
  status: 'done' | 'already';
  label: string;
  errors: string[];
}> {
  await ensureDbReady();
  const title = (input.title ?? '').trim().slice(0, 300);
  if (!title) throw new Error('Le titre est vide.');
  const m = await db.message.findFirst({
    where: { id: input.messageId, isDeleted: false },
    select: {
      id: true, accountSlug: true, uid: true, subject: true, date: true,
      threadId: true, reviewedAt: true, fromEmail: true, fromName: true,
      folder: { select: { path: true } },
    },
  });
  if (!m) throw new Error("Mail introuvable dans l'index — resynchronise la boîte.");

  const errors: string[] = [];
  let label = '';
  let decisionApplied = false;
  const markDone = input.markDone === true;
  const doneAt = input.doneAt ? new Date(input.doneAt) : new Date();
  if (Number.isNaN(doneAt.getTime())) throw new Error('Date de réalisation invalide.');

  if (input.objectType === 'deadline') {
    const date = input.date ? new Date(input.date) : null;
    if (!date || Number.isNaN(date.getTime())) throw new Error("Date d'échéance requise.");
    const dtype = ['payment', 'document', 'appointment', 'renewal', 'other'].includes(input.deadlineType ?? '')
      ? (input.deadlineType as string)
      : 'other';
    const existing = input.deadlineId
      ? await db.deadline.findFirst({ where: { id: input.deadlineId, accountSlug: m.accountSlug } })
      : await db.deadline.findFirst({
          where: { accountSlug: m.accountSlug, messageId: m.id, status: { in: ['proposed', 'confirmed'] } },
          orderBy: { date: 'asc' },
        });
    if (existing?.status === 'confirmed' && m.reviewedAt) {
      return { status: 'already', label: 'échéance déjà confirmée et mail déjà dépouillé', errors };
    }
    const targetStatus = markDone ? 'done' : 'confirmed';
    await db.$transaction(async (tx) => {
      if (existing) {
        if (existing.status !== targetStatus || existing.title !== title || existing.date.getTime() !== date.getTime()) {
          await tx.deadline.update({
            where: { id: existing.id },
            data: { title, date, status: targetStatus },
          });
        }
      } else {
        await tx.deadline.create({
          data: {
            accountSlug: m.accountSlug,
            messageId: m.id,
            threadId: m.threadId,
            title,
            date,
            type: dtype,
            // Née d'une validation humaine explicite : confirmée — ou déjà
            // réglée (« déjà fait ») : l'historique garde le fait.
            status: targetStatus,
            confidence: 1,
            reason: markDone
              ? `réglée avant même d'être programmée (consignée au dépouillement le ${doneAt.toLocaleDateString('fr-FR')})`
              : 'proposée au dépouillement, validée par toi',
            sourceText: m.subject ?? '',
            fromEmail: m.fromEmail,
            fromName: m.fromName,
            subject: m.subject,
          },
        });
      }
      if (!m.reviewedAt) {
        await tx.message.update({
          where: { id: m.id },
          data: { reviewedAt: new Date(), reviewDecision: 'seen', isSeen: true },
        });
        decisionApplied = true;
      }
    });
    label = markDone
      ? `échéance « ${title} » consignée comme réglée`
      : existing
        ? `échéance confirmée « ${title} » (${date.toLocaleDateString('fr-FR')})`
        : `échéance créée « ${title} » (${date.toLocaleDateString('fr-FR')})`;
  } else if (input.objectType === 'rentila_message') {
    // Message au locataire via la messagerie Rentila : la validation CRÉE la
    // commande (file « à exécuter par Claude »), confirme l'échéance liée si
    // demandé, et dépouille le mail — un seul geste, une transaction, une
    // ligne de journal. L'envoi réel se fait par Claude (connecteur Rentila).
    if (m.reviewedAt) return { status: 'already', label: 'mail déjà dépouillé', errors };
    const body = (input.body ?? '').trim();
    if (!body) throw new Error('Le message est vide.');
    const property = (input.property ?? '').trim();
    if (!property) throw new Error('Le bien concerné est requis.');
    const confirmDl = input.confirmDeadline === true && Number.isInteger(input.deadlineId ?? null) && (input.deadlineId as number) > 0;
    await db.$transaction(async (tx) => {
      await tx.rentilaCommand.create({
        data: {
          kind: 'send_tenant_message',
          params: JSON.stringify({
            property,
            tenantName: null,
            tenantEmail: null,
            subject: title,
            body,
            mailSubject: m.subject ?? null,
          }),
          label: `Message Rentila — ${property} : ${title}`.slice(0, 300),
          accountSlug: m.accountSlug,
          messageId: m.id,
          status: 'approved',
        },
      });
      if (confirmDl) {
        await tx.deadline.updateMany({
          where: { id: input.deadlineId as number, accountSlug: m.accountSlug, status: 'proposed' },
          data: { status: 'confirmed' },
        });
      }
      await tx.message.update({
        where: { id: m.id },
        data: { reviewedAt: new Date(), reviewDecision: 'seen', isSeen: true },
      });
      decisionApplied = true;
    });
    label = `message locataire préparé « ${title} » (${property})${confirmDl ? ' + échéance confirmée' : ''} — à faire exécuter par Claude`;
  } else {
    if (m.reviewedAt) return { status: 'already', label: 'mail déjà dépouillé', errors };
    const dueDate = input.date ? new Date(input.date) : null;
    const task = await createTask({
      title,
      account: m.accountSlug,
      messageRef: { folder: m.folder.path, uid: m.uid },
      source: 'mail',
      ...(dueDate && !Number.isNaN(dueDate.getTime()) ? { dueDate } : {}),
    });
    if (markDone) {
      // « Déjà fait » : la tâche naît terminée, à la date/heure indiquée —
      // le fait reste visible dans l'historique des tâches et le journal.
      await db.task.update({ where: { id: task.id }, data: { status: 'done', doneAt } });
    }
    await db.message.update({
      where: { id: m.id },
      data: { reviewedAt: new Date(), reviewDecision: 'action', isSeen: true },
    });
    decisionApplied = true;
    label = markDone
      ? `action consignée comme faite « ${title} » (le ${doneAt.toLocaleDateString('fr-FR')} à ${doneAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })})`
      : `tâche créée « ${title} »`;
  }

  // Effet IMAP hors transaction : l'index local fait foi, l'état distant se
  // recale à la synchronisation suivante en cas d'échec.
  if (decisionApplied) {
    try {
      // Import différé — voir reviewDecide (le banc importe ce fichier).
      const [{ imapService }, { resolveAccount }] = await Promise.all([
        import('./imap.js'),
        import('./accounts.js'),
      ]);
      const rec = await resolveAccount(m.accountSlug);
      await imapService.markEmails(rec, m.folder.path, [m.uid], ['\Seen'], []);
    } catch (err) {
      errors.push(`marquage lu : ${(err as Error).message}`);
    }
  }

  await recordOperation({
    account: m.accountSlug,
    tool: 'ui_review_validate',
    params: { messageId: m.id, objectType: input.objectType },
    affectedUids: [m.uid],
    items: [{ subject: m.subject ?? '(sans sujet)', date: m.date?.toISOString() ?? null, folder: m.folder.path, uid: m.uid }],
    result: `dépouillement : ${label} + mail traité`,
  });
  return { status: 'done', label, errors };
}

/**
 * Annule la décision de dépouillement d'un mail (bandeau « Annuler » de 10 s
 * après un reclassement) : le mail redevient « à dépouiller ». L'état lu/non-lu
 * n'est pas touché (la lecture a réellement eu lieu). Journalisé.
 */
export async function reviewUndo(messageId: number): Promise<{ ok: true }> {
  await ensureDbReady();
  const m = await db.message.findFirst({
    where: { id: messageId, isDeleted: false },
    select: { id: true, accountSlug: true, uid: true, subject: true, date: true, folder: { select: { path: true } } },
  });
  if (!m) throw new Error("Mail introuvable dans l'index.");
  await db.message.update({
    where: { id: m.id },
    data: { reviewedAt: null, reviewDecision: null },
  });
  await recordOperation({
    account: m.accountSlug,
    tool: 'ui_review_undo',
    params: { messageId: m.id },
    affectedUids: [m.uid],
    items: [{ subject: m.subject ?? '(sans sujet)', date: m.date?.toISOString() ?? null, folder: m.folder.path, uid: m.uid }],
    result: 'décision annulée : le mail revient au dépouillement',
  });
  return { ok: true };
}
