import { z } from 'zod';

/**
 * Le verdict sémantique — ce que l'IA a compris d'un mail.
 *
 * POURQUOI CE FICHIER EXISTE. Anthony, le 11/08 : « j'ai vraiment peur de ta
 * conception qui est à corriger à chaque nouveau cas et qui en oublie
 * systématiquement tant que je ne passe pas manuellement dessus. » Le reproche
 * était fondé. Jusqu'ici le verdict de l'IA s'écrasait dans quatre colonnes
 * plates (`intent`, `aiAction`, `analysisConfidence`, `aiSummary`), et vingt
 * et un services appliquaient par-dessus leurs propres règles écrites à la
 * main — qui contredisaient l'analyse ou ignoraient ce qu'elle avait compris.
 *
 * LE RENVERSEMENT (docs/CONTRAT-EXTRACTION.md, confrontation du 11/08) :
 *
 *   L'IA extrait une représentation SÉMANTIQUE du mail ;
 *   le serveur en déduit les usages.
 *
 * On cesse donc de lui demander « faut-il l'afficher dans le briefing ? »,
 * « faut-il créer une échéance ? » : ce sont des PROJECTIONS d'une même vérité
 * sémantique, c'est-à-dire des décisions de produit, pas des faits lus.
 *
 * LE POINT NON NÉGOCIABLE : le verdict brut est stocké tel quel, immuable, et
 * les projections en sont dérivées. Parce que dans six mois on voudra changer
 * le fonctionnement du briefing SANS changer ce que l'IA avait compris du
 * mail. Aujourd'hui les deux sont confondus, donc toute évolution de produit
 * impose une réanalyse de 25 000 mails.
 */

// ------------------------------------------------------------- vocabulaire
//
// RÈGLE DE FRONTIÈRE : fermé pour ce qui déclenche du code, libre pour ce qui
// enrichit le sens. Chaque liste fermée porte donc une valeur de sortie
// (`other` / `unknown`) ET s'accompagne d'un champ libre — un cas nouveau
// apparaît demain sans migration et sans réanalyse.

export const PURPOSES = [
  'request',
  'response',
  'notification',
  'confirmation',
  'transaction_record',
  'document_delivery',
  'security',
  'marketing',
  'conversation',
  'other',
  'unknown',
] as const;

/**
 * Modes d'attention. C'est ici que se règle le cas Air France : un rappel
 * d'enregistrement pour un vol du 16 juin est `until_time` — le 17, le serveur
 * constate que c'est passé, sans qu'aucune IA soit rappelée.
 */
export const ATTENTION_MODES = [
  'persistent',
  'until_time',
  'while_action_open',
  'while_event_future',
  'until_superseded',
  'none',
  'unknown',
] as const;

export const ATTENTION_BASIS = [
  'action_window',
  'event_window',
  'information_window',
  'security_code',
  'promotion',
  'unknown',
] as const;

/** Qui doit agir. Sépare « maman envoie » de « Sosh facture ». */
export const ACTORS = ['user', 'sender', 'third_party', 'unknown'] as const;

export const STRENGTHS = ['required', 'requested', 'optional', 'informational'] as const;

export const ACTION_KINDS = [
  'pay',
  'reply',
  'sign',
  'provide_document',
  'book',
  'call',
  'attend',
  'renew',
  'declare',
  'confirm',
  'review',
  'other',
] as const;

export const EVENT_KINDS = [
  'appointment',
  'travel',
  'service_window',
  'delivery',
  'meeting',
  'other',
] as const;

export const DOCUMENT_KINDS = [
  'invoice',
  'quote',
  'contract',
  'receipt',
  'tax_notice',
  'statement',
  'certificate',
  'report',
  'id_document',
  'legal_notice',
  'other',
] as const;

export const ENTITY_KINDS = [
  'person',
  'company',
  'property',
  'vehicle',
  'contract',
  'service',
  'account',
  'other',
] as const;

/**
 * Rôles. `sent_by` ≠ `issued_by` est la correction structurelle du troisième
 * échec : le scan d'une facture Sosh transmis par sa mère était classé « payer
 * maman ». Avec ces deux rôles distincts, le raccourci devient impossible.
 */
export const ENTITY_ROLES = [
  'sent_by',
  'issued_by',
  'concerns',
  'billed_to',
  'pays',
  'represents',
  'mentioned',
  'other',
] as const;

export const CONTEXT_KINDS = ['property', 'company', 'affair', 'vehicle', 'reference', 'other'] as const;

/** Précision d'une date : « en mai » n'est pas « le 12 mai à 14 h ». */
export const PRECISIONS = ['datetime', 'date', 'month', 'year', 'range', 'unknown'] as const;

/** Certitude PAR AFFIRMATION — une confiance globale tirait tout vers le bas. */
export const CERTAINTIES = ['explicit', 'strong_inference', 'weak_inference', 'unknown'] as const;

export const EVIDENCE_SOURCES = [
  'subject',
  'body',
  'attachment_name',
  'attachment_text',
  'thread_context',
  'inferred',
] as const;

export const UNCERTAINTY_REASONS = [
  'not_present',
  'ambiguous',
  'truncated_input',
  'missing_attachment',
  'missing_thread_context',
  'conflicting_evidence',
] as const;

export const RESOLVABLE_WITH = [
  'full_body',
  'attachment_text',
  'thread_context',
  'manual_review',
  'none',
] as const;

export type Purpose = (typeof PURPOSES)[number];
export type AttentionMode = (typeof ATTENTION_MODES)[number];
export type Certainty = (typeof CERTAINTIES)[number];
export type Precision = (typeof PRECISIONS)[number];

/** Version du schéma. À incrémenter quand la FORME du verdict change. */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- validation
//
// `.catch()` PARTOUT sur les listes fermées, et ce n'est pas de la complaisance.
// Aujourd'hui, une seule valeur hors énumération fait échouer l'appel ENTIER de
// 100 verdicts — alors que l'analyse tourne sur le forfait d'Anthony. Une
// valeur inconnue doit dégrader ce champ-là, pas jeter le travail des
// 99 autres mails.

const enumSouple = <T extends readonly [string, ...string[]]>(
  valeurs: T,
  defaut: T[number],
): z.ZodType<T[number]> => z.enum(valeurs).catch(defaut as never) as unknown as z.ZodType<T[number]>;

/** Une preuve : la citation du texte et d'où elle vient. Règle anti-invention. */
const zPreuve = z.object({
  quote: z.string().max(400).optional(),
  source: enumSouple(EVIDENCE_SOURCES, 'inferred').optional(),
});

/**
 * Une date n'est jamais un simple champ : elle porte sa précision, si elle
 * était écrite ou déduite, et sa certitude. Sans ça, « en mai » et « le 12 mai
 * à 14 h » se comparent de la même façon et on se trompe d'un mois.
 */
const zDate = z.object({
  raw: z.string().max(120).optional(),
  normalized: z.string().max(40).optional(),
  precision: enumSouple(PRECISIONS, 'unknown').optional(),
  explicitness: enumSouple(['explicit', 'inferred'] as const, 'inferred').optional(),
  certainty: enumSouple(CERTAINTIES, 'unknown').optional(),
  evidence: zPreuve.optional(),
});

const zAction = z.object({
  kind: enumSouple(ACTION_KINDS, 'other'),
  /** Libellé libre, en français, affichable tel quel. */
  label: z.string().max(200).optional(),
  actor: enumSouple(ACTORS, 'unknown').optional(),
  strength: enumSouple(STRENGTHS, 'requested').optional(),
  /** La date qui OBLIGE à agir. Un paiement dû le 15 reste à faire le 16. */
  dueAt: zDate.optional(),
  /** La date après laquelle agir n'a PLUS DE SENS. L'avion est parti. */
  expiresAt: zDate.optional(),
  amount: z.number().optional(),
  currency: z.string().max(8).optional(),
  reference: z.string().max(120).optional(),
  certainty: enumSouple(CERTAINTIES, 'unknown').optional(),
  evidence: zPreuve.optional(),
});

const zEvent = z.object({
  kind: enumSouple(EVENT_KINDS, 'other'),
  label: z.string().max(200).optional(),
  startsAt: zDate.optional(),
  endsAt: zDate.optional(),
  /** participant = il y est ; informational = on l'informe que ça a lieu. */
  participation: enumSouple(['participant', 'informational', 'unknown'] as const, 'unknown').optional(),
  certainty: enumSouple(CERTAINTIES, 'unknown').optional(),
  evidence: zPreuve.optional(),
});

const zDocument = z.object({
  kind: enumSouple(DOCUMENT_KINDS, 'other'),
  label: z.string().max(200).optional(),
  /** Qui ÉMET le document — pas qui envoie le mail. */
  issuer: z.string().max(200).optional(),
  issueDate: zDate.optional(),
  dueDate: zDate.optional(),
  amount: z.number().optional(),
  currency: z.string().max(8).optional(),
  reference: z.string().max(120).optional(),
  certainty: enumSouple(CERTAINTIES, 'unknown').optional(),
  evidence: zPreuve.optional(),
});

/**
 * MENTION d'entité, jamais identité. L'IA écrira « 46 rue de la République »,
 * puis « Immeuble République », puis « 46 Rue République Brest » : ce n'est pas
 * un défaut du modèle, c'est le mauvais outil pour assurer l'identité. Le
 * serveur tient l'identité (lot 3) ; l'IA propose.
 */
const zEntite = z.object({
  kind: enumSouple(ENTITY_KINDS, 'other'),
  nameRaw: z.string().max(200),
  role: enumSouple(ENTITY_ROLES, 'mentioned').optional(),
  /** SIRET, n° de contrat, plaque, IBAN partiel… ce qui permet de recoller. */
  identifier: z.string().max(120).optional(),
  certainty: enumSouple(CERTAINTIES, 'unknown').optional(),
  evidence: zPreuve.optional(),
});

const zContexte = z.object({
  kind: enumSouple(CONTEXT_KINDS, 'other'),
  label: z.string().max(200),
  certainty: enumSouple(CERTAINTIES, 'unknown').optional(),
  evidence: zPreuve.optional(),
});

/** Le doute, structuré pour être exploitable — il dit COMMENT le lever. */
const zIncertitude = z.object({
  fieldPath: z.string().max(120).optional(),
  reason: enumSouple(UNCERTAINTY_REASONS, 'ambiguous'),
  description: z.string().max(300).optional(),
  resolvableWith: enumSouple(RESOLVABLE_WITH, 'manual_review').optional(),
});

export const zVerdict = z.object({
  /** Identifiant du mail, tel que rendu par le lot. */
  id: z.number().int().positive(),
  analysis: z
    .object({
      status: enumSouple(['complete', 'partial', 'failed'] as const, 'complete').optional(),
      /** Ce que l'IA a réellement vu : sujet seul, extrait tronqué, pièces… */
      inputCoverage: z.string().max(200).optional(),
    })
    .optional(),
  communication: z
    .object({
      purpose: enumSouple(PURPOSES, 'unknown').optional(),
      /** LIBRE : `flight_check_in_reminder`, `temporary_service_outage`… */
      subtype: z.string().max(80).optional(),
      summary: z.string().max(300).optional(),
    })
    .optional(),
  attention: z
    .object({
      mode: enumSouple(ATTENTION_MODES, 'unknown').optional(),
      until: zDate.optional(),
      basis: enumSouple(ATTENTION_BASIS, 'unknown').optional(),
    })
    .optional(),
  actions: z.array(zAction).max(20).optional(),
  events: z.array(zEvent).max(20).optional(),
  documents: z.array(zDocument).max(20).optional(),
  entities: z.array(zEntite).max(30).optional(),
  contextHints: z.array(zContexte).max(10).optional(),
  uncertainties: z.array(zIncertitude).max(20).optional(),
  /** Soupape d'extension : ce qui ne rentre nulle part, sans migration. */
  facts: z.array(z.object({ key: z.string().max(80), value: z.string().max(300) })).max(20).optional(),
});

export type Verdict = z.infer<typeof zVerdict>;
export type VerdictDate = z.infer<typeof zDate>;
export type VerdictAction = z.infer<typeof zAction>;

// --------------------------------------------------------------- péremption

/**
 * Fin de la période couverte par une date, selon sa précision.
 *
 * On étend TOUJOURS vers le futur : « mai 2026 » devient le 31 mai à 23 h 59.
 * Le sens de l'arrondi n'est pas neutre — dans l'autre sens, un mail resterait
 * caché alors qu'il compte encore. On préfère le montrer un jour de trop.
 */
export function finDePeriode(iso: string | undefined, precision?: Precision): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  switch (precision) {
    case 'year':
      return new Date(Date.UTC(d.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
    case 'month':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    case 'date':
    case 'range':
    case 'unknown':
    case undefined:
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
    default:
      return d;
  }
}

/** Forme minimale nécessaire au calcul — utilisable depuis la base ou le JSON. */
export interface EtatAttention {
  attentionMode: string | null;
  attentionUntil: Date | null;
  attentionPrecision: string | null;
  actions: { expiresAt: Date | null; expiresPrecision: string | null; dueAt: Date | null }[];
  events: { startsAt: Date | null; endsAt: Date | null; startsPrecision: string | null }[];
}

/**
 * Ce mail a-t-il cessé de mériter l'attention ?
 *
 * C'EST LA FONCTION QUI REMPLACE LES RUSTINES. Le 11/08, un rappel
 * d'enregistrement Air France pour un vol du 16 juin arrivait PREMIÈRE priorité
 * du jour. Le correctif de l'époque fut un veto codé à la main dans deux
 * moteurs. Ici, aucune règle : l'IA a écrit « expiresAt : 2026-06-16 », le
 * serveur constate que c'est passé, et le mail sort du briefing tout seul —
 * le 17 juin comme le 11 août, sans rappeler l'IA et sans ligne de code
 * supplémentaire quand le cas suivant se présentera.
 *
 * PRUDENCE DÉLIBÉRÉE : `unknown` ne périme JAMAIS. Faire disparaître un mail
 * par ignorance serait la faute la plus coûteuse — fiscal, banque, assurance,
 * copropriété. Dans le doute, on montre.
 */
export function estPerime(e: EtatAttention, maintenant: Date = new Date()): boolean {
  const t = maintenant.getTime();

  switch (e.attentionMode) {
    case 'none':
      return true;
    case 'persistent':
      return false;

    case 'until_time': {
      const fin = e.attentionUntil
        ? finDePeriode(e.attentionUntil.toISOString(), (e.attentionPrecision ?? 'date') as Precision)
        : null;
      // Une fenêtre annoncée sans date exploitable ne périme pas : on ne
      // masque pas un mail sur une donnée qu'on n'a pas su lire.
      return fin ? t > fin.getTime() : false;
    }

    case 'while_action_open': {
      if (e.actions.length === 0) return false;
      // Périmé seulement si TOUTES les actions sont hors délai. Une seule
      // action encore ouverte suffit à garder le mail visible.
      return e.actions.every((a) => {
        const fin = a.expiresAt
          ? finDePeriode(a.expiresAt.toISOString(), (a.expiresPrecision ?? 'date') as Precision)
          : null;
        return fin ? t > fin.getTime() : false;
      });
    }

    case 'while_event_future': {
      if (e.events.length === 0) return false;
      return e.events.every((ev) => {
        const ref = ev.endsAt ?? ev.startsAt;
        const fin = ref
          ? finDePeriode(ref.toISOString(), (ev.startsPrecision ?? 'date') as Precision)
          : null;
        return fin ? t > fin.getTime() : false;
      });
    }

    // `until_superseded` se tranche au niveau du FIL (un message plus récent
    // remplace celui-ci), pas au niveau du mail : ce n'est pas ici.
    case 'until_superseded':
    case 'unknown':
    default:
      return false;
  }
}

// ----------------------------------------------------------------- dépliage

const versDate = (d?: VerdictDate): Date | null => {
  if (!d?.normalized) return null;
  const parsed = new Date(d.normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const preuve = (p?: { quote?: string; source?: string }): { texte: string | null; source: string | null } => ({
  texte: p?.quote ?? null,
  source: p?.source ?? null,
});

export interface Deplie {
  entete: {
    purpose: string | null;
    subtype: string | null;
    summary: string | null;
    analysisStatus: string;
    inputCoverage: string | null;
    attentionMode: string | null;
    attentionUntil: Date | null;
    attentionPrecision: string | null;
    attentionBasis: string | null;
  };
  actions: {
    kind: string;
    label: string | null;
    actor: string;
    strength: string;
    dueAt: Date | null;
    duePrecision: string | null;
    expiresAt: Date | null;
    expiresPrecision: string | null;
    amount: number | null;
    currency: string | null;
    reference: string | null;
    certainty: string;
    evidence: string | null;
    evidenceSource: string | null;
  }[];
  events: {
    kind: string;
    label: string | null;
    startsAt: Date | null;
    startsPrecision: string | null;
    endsAt: Date | null;
    participation: string;
    certainty: string;
    evidence: string | null;
  }[];
  documents: {
    kind: string;
    label: string | null;
    issuer: string | null;
    issueDate: Date | null;
    dueDate: Date | null;
    amount: number | null;
    currency: string | null;
    reference: string | null;
    certainty: string;
    evidence: string | null;
  }[];
  mentions: {
    kind: string;
    nameRaw: string;
    role: string;
    identifier: string | null;
    certainty: string;
    evidence: string | null;
  }[];
  contexts: { kind: string; label: string; certainty: string; evidence: string | null }[];
  uncertainties: {
    fieldPath: string | null;
    reason: string;
    description: string | null;
    resolvableWith: string | null;
  }[];
}

/** Déplie le verdict en lignes prêtes pour la base. Pure, testable seule. */
export function deplier(v: Verdict): Deplie {
  return {
    entete: {
      purpose: v.communication?.purpose ?? null,
      subtype: v.communication?.subtype ?? null,
      summary: v.communication?.summary ?? null,
      analysisStatus: v.analysis?.status ?? 'complete',
      inputCoverage: v.analysis?.inputCoverage ?? null,
      attentionMode: v.attention?.mode ?? null,
      attentionUntil: versDate(v.attention?.until),
      attentionPrecision: v.attention?.until?.precision ?? null,
      attentionBasis: v.attention?.basis ?? null,
    },
    actions: (v.actions ?? []).map((a) => ({
      kind: a.kind,
      label: a.label ?? null,
      actor: a.actor ?? 'unknown',
      strength: a.strength ?? 'requested',
      dueAt: versDate(a.dueAt),
      duePrecision: a.dueAt?.precision ?? null,
      expiresAt: versDate(a.expiresAt),
      expiresPrecision: a.expiresAt?.precision ?? null,
      amount: a.amount ?? null,
      currency: a.currency ?? null,
      reference: a.reference ?? null,
      certainty: a.certainty ?? 'unknown',
      evidence: preuve(a.evidence).texte,
      evidenceSource: preuve(a.evidence).source,
    })),
    events: (v.events ?? []).map((e) => ({
      kind: e.kind,
      label: e.label ?? null,
      startsAt: versDate(e.startsAt),
      startsPrecision: e.startsAt?.precision ?? null,
      endsAt: versDate(e.endsAt),
      participation: e.participation ?? 'unknown',
      certainty: e.certainty ?? 'unknown',
      evidence: preuve(e.evidence).texte,
    })),
    documents: (v.documents ?? []).map((d) => ({
      kind: d.kind,
      label: d.label ?? null,
      issuer: d.issuer ?? null,
      issueDate: versDate(d.issueDate),
      dueDate: versDate(d.dueDate),
      amount: d.amount ?? null,
      currency: d.currency ?? null,
      reference: d.reference ?? null,
      certainty: d.certainty ?? 'unknown',
      evidence: preuve(d.evidence).texte,
    })),
    mentions: (v.entities ?? []).map((e) => ({
      kind: e.kind,
      nameRaw: e.nameRaw,
      role: e.role ?? 'mentioned',
      identifier: e.identifier ?? null,
      certainty: e.certainty ?? 'unknown',
      evidence: preuve(e.evidence).texte,
    })),
    contexts: (v.contextHints ?? []).map((c) => ({
      kind: c.kind,
      label: c.label,
      certainty: c.certainty ?? 'unknown',
      evidence: preuve(c.evidence).texte,
    })),
    uncertainties: (v.uncertainties ?? []).map((u) => ({
      fieldPath: u.fieldPath ?? null,
      reason: u.reason,
      description: u.description ?? null,
      resolvableWith: u.resolvableWith ?? null,
    })),
  };
}

// ------------------------------------------------- projection de compatibilité

/**
 * Traduction vers les quatre colonnes plates, le temps que les 21 consommateurs
 * basculent (lot 4).
 *
 * C'est un ÉCHAFAUDAGE, pas une cible : cette fonction disparaît au lot 6. Elle
 * existe parce qu'Anthony a choisi une bascule rapide — sans elle, le premier
 * verdict du nouveau format ferait disparaître le mail de tous les écrans à la
 * fois.
 *
 * Elle penche systématiquement du côté prudent : `low` protège de tout
 * nettoyage automatique (retention.ts), et `archive` autorise une suppression
 * de masse. Dans le doute, on choisit donc `low` et on évite `archive`.
 */
export function projeterVersLegacy(v: Verdict): {
  intent: string | null;
  aiAction: string | null;
  analysisConfidence: 'high' | 'medium' | 'low';
  aiSummary: string | null;
} {
  const actions = v.actions ?? [];
  const documents = v.documents ?? [];
  const purpose = v.communication?.purpose ?? 'unknown';
  const aUser = (k: string): boolean =>
    actions.some((a) => a.kind === k && (a.actor ?? 'unknown') === 'user');

  // --- aiAction
  let aiAction: string | null;
  if (aUser('pay')) aiAction = 'pay';
  else if (aUser('reply') || aUser('confirm') || aUser('provide_document') || aUser('sign'))
    aiAction = 'reply';
  else if (
    // « archive » ouvre la porte à la suppression de masse : on ne l'accorde
    // qu'à un mail sans aucune action, sans document, sans attention, ET dont
    // la fonction est explicitement du bruit.
    actions.length === 0 &&
    documents.length === 0 &&
    (v.attention?.mode ?? 'unknown') === 'none' &&
    (purpose === 'marketing' || purpose === 'notification')
  )
    aiAction = 'archive';
  else if (actions.length === 0 && (v.attention?.mode ?? 'unknown') === 'none') aiAction = 'none';
  else aiAction = 'read';

  // --- intent : la meilleure approximation de l'ancienne liste fermée.
  const doc = documents[0];
  let intent: string | null;
  if (purpose === 'security') intent = 'otp';
  else if (doc?.kind === 'invoice') intent = 'invoice';
  else if (documents.length > 0) intent = 'document';
  else if (purpose === 'marketing') intent = 'promo';
  else if ((v.events ?? []).some((e) => e.kind === 'appointment' || e.kind === 'travel'))
    intent = 'appointment';
  else if ((v.events ?? []).some((e) => e.kind === 'delivery')) intent = 'shipping';
  else if (aUser('reply')) intent = 'reply_expected';
  else if (actions.some((a) => (a.actor ?? 'unknown') === 'user')) intent = 'action_required';
  else if (purpose === 'confirmation') intent = 'confirmation';
  else intent = 'info';

  // --- confiance : dérivée du doute déclaré, jamais demandée à l'IA.
  const incertitudes = v.uncertainties ?? [];
  const doutesLourds = incertitudes.some((u) =>
    ['truncated_input', 'missing_attachment', 'missing_thread_context', 'conflicting_evidence'].includes(
      u.reason,
    ),
  );
  const certitudes = [
    ...actions.map((a) => a.certainty ?? 'unknown'),
    ...documents.map((d) => d.certainty ?? 'unknown'),
  ];
  let analysisConfidence: 'high' | 'medium' | 'low';
  if (doutesLourds || (v.analysis?.status ?? 'complete') !== 'complete') analysisConfidence = 'low';
  else if (certitudes.length > 0 && certitudes.every((c) => c === 'explicit')) analysisConfidence = 'high';
  else if (certitudes.some((c) => c === 'weak_inference' || c === 'unknown')) analysisConfidence = 'low';
  else analysisConfidence = 'medium';

  return {
    intent,
    aiAction,
    analysisConfidence,
    aiSummary: v.communication?.summary ?? null,
  };
}
