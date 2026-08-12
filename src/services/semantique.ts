import { db, ensureDbReady } from '../db/client.js';
import { estPerime, finDePeriode, type EtatAttention, type Precision } from './verdict.js';

/**
 * LE SOCLE SÉMANTIQUE (lot 4a — contre-revue du 12/08, section « Décision
 * finale »). La règle d'architecture, mot pour mot :
 *
 *   Les projections décrivent les faits ; le résolveur établit la vérité
 *   courante ; les moteurs appliquent une politique produit. Aucun fichier ne
 *   doit plus faire les trois à la fois.
 *
 * Ce fichier est le RÉSOLVEUR. Il ne décrit pas les faits (c'est verdict.ts et
 * les tables Verdict*), il n'applique aucune politique produit (ce sont les 21
 * moteurs) : il établit, une fois pour toutes, CE QUI EST VRAI MAINTENANT pour
 * un mail — et d'où cette vérité vient.
 *
 * LA DISTINCTION QUI COMMANDE TOUT LE VOCABULAIRE DU FICHIER :
 * le FAIT HISTORIQUE n'est pas l'ÉTAT COURANT.
 *   - « le mail demandait une réponse » est un fait, immuable
 *     (→ `faits.actionsDemandees`, au passé) ;
 *   - « une réponse reste attendue » est un état, qui dépend des messages
 *     ultérieurs du fil (→ `courant.actions[].resteAFaire`, au présent).
 *   - « contient une facture » est un fait (→ `faits.documentsPortes`) ;
 *   - « facture encore à payer » est un état (→ une action `pay` avec
 *     `resteAFaire === true`).
 * Les trois échecs de juin-août (Air France, PayFiP, la facture Sosh de maman)
 * venaient tous d'un moteur qui lisait un fait et croyait lire un état.
 *
 * LA PRÉCÉDENCE `manuel > IA > heuristique` EST APPLIQUÉE ICI, UNE SEULE FOIS,
 * et chaque valeur résolue sort AVEC SA PROVENANCE (`Resolu<T>`). Aujourd'hui
 * cette précédence est ré-implémentée à cinq endroits indépendants, qui
 * devront TOUS converger ici (lot 4b et suivants) — ne pas en ajouter un
 * sixième :
 *   - analysis.ts ~l.477  (submit_analysis_batch saute les intents `manual`) ;
 *   - analysis.ts ~l.844  (l'écriture du verdict préserve l'intent `manual`) ;
 *   - categorize.ts ~l.812 (le backfill exclut `intentSource: 'ai'` — et
 *     SEULEMENT 'ai', voir la note « douteux » du compte rendu de session) ;
 *   - snippets.ts ~l.626  (la réparation ne recalcule que `'auto'`) ;
 *   - sync.ts ~l.952      (rebuildSenders préserve categorySource manual/ai).
 * Le danger n'est pas qu'une copie soit fausse : c'est qu'elles divergent —
 * certaines fusionnent manuel+IA quand d'autres remplacent l'un par l'autre.
 *
 * PAS DE MATÉRIALISATION, PAS DE CACHE — délibéré. Tout est rechargé et
 * réassemblé à chaque appel : cela supprime toute la classe de bogues
 * d'invalidation. On matérialisera plus tard SI la mesure le montre, avec une
 * version explicite plutôt qu'un cache opaque.
 *
 * PAS DE N+1 — vital en SQLite `connection_limit=1` : le résolveur prend une
 * COLLECTION d'identifiants et charge chaque table EN UNE REQUÊTE (découpée
 * par lots de 900 identifiants uniquement pour respecter la limite de
 * variables liées de SQLite). Charger mail par mail sur 25 000 messages
 * serait catastrophique.
 */

// ---------------------------------------------------------------- provenance

/**
 * D'où vient une vérité résolue.
 *  - `manuel` : un acte de l'utilisateur — correction explicite (intention,
 *    catégorie) OU comportement observé (il a répondu, marqué une tâche faite,
 *    écarté un fil). C'est lui la vérité par définition.
 *  - `ia` : le verdict sémantique (MailVerdict et ses tables), ou sa
 *    projection legacy quand le verdict complet n'existe pas encore.
 *  - `heuristique` : les regex et règles déterministes du serveur
 *    (detectIntent, catégorisation d'expéditeur…). `intentSource === 'rule'`
 *    est rangé ici : une règle validée par simulation reste une heuristique.
 */
export type Provenance = 'manuel' | 'ia' | 'heuristique';

/** Une valeur résolue ne circule JAMAIS sans sa provenance ni sa raison. */
export interface Resolu<T> {
  valeur: T;
  source: Provenance;
  pourquoi: string;
}

// -------------------------------------------------- lignes brutes (entrées)
//
// Formes locales, découplées des types Prisma : le cœur du résolveur
// (`resoudre`) est une fonction PURE, testable avec des objets en mémoire —
// c'est ce que vérifie `npm run verdict:check` sans aucune base.

export interface LigneMessage {
  id: number;
  accountSlug: string;
  threadId: number | null;
  date: Date | null;
  fromEmail: string | null;
  subject: string | null;
  isSeen: boolean;
  isAnswered: boolean;
  isFlagged: boolean;
  isOutbound: boolean;
  isDeleted: boolean;
  isAutoReply: boolean;
  hasAttachments: boolean;
  intent: string | null;
  intentSource: string;
  intentReason: string | null;
  analysisConfidence: string | null;
  aiSummary: string | null;
  aiVerdictAt: Date | null;
}

export interface LigneVerdict {
  messageId: number;
  /** complete | partial | failed */
  analysisStatus: string;
  purpose: string | null;
  subtype: string | null;
  summary: string | null;
  attentionMode: string | null;
  attentionUntil: Date | null;
  attentionPrecision: string | null;
  attentionBasis: string | null;
}

export interface LigneAction {
  messageId: number;
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
}

export interface LigneEvenement {
  messageId: number;
  kind: string;
  label: string | null;
  startsAt: Date | null;
  startsPrecision: string | null;
  endsAt: Date | null;
  participation: string;
  certainty: string;
}

export interface LigneDocument {
  messageId: number;
  kind: string;
  label: string | null;
  issuer: string | null;
  issueDate: Date | null;
  dueDate: Date | null;
  amount: number | null;
  currency: string | null;
  reference: string | null;
  certainty: string;
}

export interface LigneMention {
  messageId: number;
  kind: string;
  nameRaw: string;
  role: string;
  identifier: string | null;
  certainty: string;
}

export interface LigneContexte {
  messageId: number;
  kind: string;
  label: string;
  certainty: string;
}

export interface LigneIncertitude {
  messageId: number;
  reason: string;
  resolvableWith: string | null;
  fieldPath: string | null;
  description: string | null;
}

export interface LigneFil {
  id: number;
  lastMessageAt: Date | null;
}

/** Dernier mail SORTANT réel (non-répondeur) de chaque fil concerné. */
export interface LigneSortant {
  threadId: number;
  dernierLe: Date | null;
}

export interface LigneExpediteur {
  accountSlug: string;
  email: string;
  category: string | null;
  categorySource: string;
  categoryReason: string | null;
  /** normal | always_important | never_urgent — choix de l'utilisateur. */
  priority: string;
  kind: string;
  engagedAt: Date | null;
}

export interface LigneTache {
  messageId: number;
  /** todo | done | dismissed */
  status: string;
}

export interface LigneEcheance {
  messageId: number;
  title: string;
  date: Date;
  type: string;
  /** proposed | confirmed | dismissed | done | vetoed */
  status: string;
  vetoReason: string | null;
  reason: string;
}

/** État utilisateur d'un fil « à traiter » (snooze/dismiss — table AttentionState). */
export interface LigneEtatFil {
  threadId: number;
  /** Message.id du dernier entrant au moment de l'action de l'utilisateur. */
  messageId: number;
  /** reply | followup */
  kind: string;
  /** snoozed | dismissed */
  state: string;
  snoozedUntil: Date | null;
}

export interface LignesBrutes {
  messages: LigneMessage[];
  verdicts: LigneVerdict[];
  actions: LigneAction[];
  evenements: LigneEvenement[];
  documents: LigneDocument[];
  mentions: LigneMention[];
  contextes: LigneContexte[];
  incertitudes: LigneIncertitude[];
  fils: LigneFil[];
  sortants: LigneSortant[];
  expediteurs: LigneExpediteur[];
  taches: LigneTache[];
  echeances: LigneEcheance[];
  etatsFil: LigneEtatFil[];
}

// ------------------------------------------------- état sémantique (sortie)

/** FAIT : ce que le mail DEMANDAIT à sa réception. Immuable — le temps qui
 *  passe et les réponses du fil ne changent jamais un fait, seulement l'état. */
export interface ActionDemandee {
  kind: string;
  label: string | null;
  /** user | sender | third_party | unknown — QUI devait agir. */
  acteur: string;
  force: string;
  /** La date qui OBLIGE à agir. Un paiement dû le 15 reste à faire le 16. */
  dueAt: Date | null;
  duePrecision: string | null;
  /** La date après laquelle agir n'a PLUS DE SENS. L'avion est parti. */
  expiresAt: Date | null;
  expiresPrecision: string | null;
  montant: number | null;
  devise: string | null;
  reference: string | null;
  certainty: string;
}

/** ÉTAT COURANT d'une action demandée : reste-t-elle à faire AUJOURD'HUI ? */
export interface EtatAction {
  fait: ActionDemandee;
  /** true = rien ne l'a soldée et sa fenêtre n'est pas passée. */
  resteAFaire: boolean;
  /** dueAt dépassé ET action toujours ouverte : un RETARD, jamais une
   *  résolution. `dueAt < maintenant` ne ferme rien, nulle part. */
  enRetard: boolean;
  /** expiresAt dépassé : agir n'a plus de sens. Fermée SANS être satisfaite. */
  horsDelai: boolean;
  source: Provenance;
  pourquoi: string;
}

export interface EvenementAnnonce {
  kind: string;
  label: string | null;
  startsAt: Date | null;
  startsPrecision: string | null;
  endsAt: Date | null;
  /** participant = il y est ; informational = on l'informe que ça a lieu. */
  participation: string;
  certainty: string;
}

/** FAIT : le mail PORTE ce document. Qu'il soit payé, périmé ou ancien ne
 *  change rien au fait — et ne le rend JAMAIS supprimable. */
export interface DocumentPorte {
  kind: string;
  label: string | null;
  /** Qui ÉMET le document — jamais qui envoie le mail (le cas Sosh/maman). */
  emetteur: string | null;
  issueDate: Date | null;
  dueDate: Date | null;
  montant: number | null;
  devise: string | null;
  reference: string | null;
  certainty: string;
}

export interface MentionEntite {
  kind: string;
  nameRaw: string;
  role: string;
  identifier: string | null;
  certainty: string;
}

export interface ContexteMentionne {
  kind: string;
  label: string;
  certainty: string;
}

export interface DouteDeclare {
  reason: string;
  resolvableWith: string | null;
  fieldPath: string | null;
  description: string | null;
}

/**
 * ÉTAT COURANT d'une échéance (ligne Deadline).
 * `echue` (la date est passée) et `close` (faite ou écartée) sont deux
 * dimensions INDÉPENDANTES : une échéance passée non traitée est `echue` et
 * PAS `close` — c'est un retard, pas une résolution.
 */
export interface EtatEcheance {
  titre: string;
  date: Date;
  type: string;
  /** La date est passée. Ne dit RIEN sur le fait qu'elle soit traitée. */
  echue: boolean;
  /** Faite ou écartée — établie par un acte, JAMAIS déduite de la date. */
  close: boolean;
  statut: 'a_venir' | 'en_retard' | 'faite' | 'ecartee';
  source: Provenance;
  pourquoi: string;
}

/**
 * ÉTAT COURANT de l'attention.
 *
 * ⚠️ `perimee === true` signifie « plus besoin d'attention TEMPORELLE »,
 * JAMAIS « supprimable ». Une facture ancienne est périmée ET intouchable.
 * La péremption tait le canal attention de la protection ; elle n'ouvre
 * aucune porte — voir `getCleanupProtection`.
 */
export interface AttentionCourante {
  /** Mode du verdict, ou 'unknown' si jamais analysé (et l'inconnu ne périme
   *  jamais — on ne masque pas un mail par ignorance). */
  mode: string;
  perimee: boolean;
  /** L'utilisateur a écarté le fil (« pas de réponse nécessaire »). */
  ecarteeManuellement: boolean;
  /** Report (snooze) actif : caché jusqu'à cette date, puis réapparaît. */
  reporteeJusquA: Date | null;
  source: Provenance;
  pourquoi: string;
}

export interface ProtectionNettoyage {
  protege: boolean;
  raisons: string[];
}

/** Faits observés par le SERVEUR (flags IMAP, fil, tâches) — ni IA ni
 *  heuristique : des constats. Exposés pour les moteurs et la protection. */
export interface SignauxServeur {
  etoile: boolean;
  repondu: boolean;
  pieceJointe: boolean;
  /** Un sortant réel (non-répondeur) existe dans le fil APRÈS ce mail. */
  sortantApresDansLeFil: boolean;
  dernierSortantDuFil: Date | null;
  tacheAFaire: boolean;
  tacheFaite: boolean;
  prioriteExpediteur: string | null;
  kindExpediteur: string | null;
}

export interface EtatSemantique {
  messageId: number;
  accountSlug: string;
  threadId: number | null;
  dateMail: Date | null;

  /** Ce qu'on sait de l'analyse elle-même (jamais une permission produit). */
  analyse: {
    verdictPresent: boolean;
    /** complete | partial | failed | aucune */
    statut: string;
    /** Doute lourd déclaré par l'IA (pièce manquante, texte tronqué…). */
    douteLourd: boolean;
    /** Confiance legacy B4 (high/medium/low) — LUE, jamais recalculée ici.
     *  ⚠️ `high` ne signifie JAMAIS « suppression autorisée » : la certitude
     *  de l'IA et l'autorisation produit sont deux dimensions différentes. */
    confianceLegacy: string | null;
  };

  /** L'intention du mail, résolue UNE FOIS avec la précédence
   *  manuel > IA > heuristique. La valeur garde le vocabulaire de sa source
   *  (intent legacy) — l'ontologie unique arrive au lot 4b. */
  nature: Resolu<string | null>;
  resume: Resolu<string | null>;
  categorieExpediteur: Resolu<string | null>;

  /** FAITS HISTORIQUES — ce que le mail disait. Le passé ne bouge plus. */
  faits: {
    /** purpose/subtype du verdict — la fonction du message. */
    objet: { purpose: string | null; subtype: string | null } | null;
    actionsDemandees: ActionDemandee[];
    evenementsAnnonces: EvenementAnnonce[];
    documentsPortes: DocumentPorte[];
    mentions: MentionEntite[];
    contextes: ContexteMentionne[];
    doutes: DouteDeclare[];
  };

  /** ÉTAT COURANT — ce qui reste vrai à l'instant `resoluA`. */
  courant: {
    actions: EtatAction[];
    echeances: EtatEcheance[];
    attention: AttentionCourante;
  };

  signauxServeur: SignauxServeur;

  /** Instant auquel la vérité courante a été établie. */
  resoluA: Date;
}

// ------------------------------------------------------------ petits outils

/** Même horizon que `ENGAGEMENT_HORIZON_DAYS` de retention.ts (730 j).
 *  Recopié plutôt qu'importé : retention.ts tire imap/accounts/oplog (effets
 *  de bord au chargement), et il importera CE fichier au lot 4j — l'import
 *  inverse ferait un cycle. Les deux constantes convergeront ici au lot 4j. */
const HORIZON_ENGAGEMENT_JOURS = 730;

/** Limite de variables liées SQLite (999 historiquement) : on découpe à 900. */
const TAILLE_LOT_SQL = 900;

function parLots<T>(items: T[], taille: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += taille) out.push(items.slice(i, i + taille));
  return out;
}

function grouperPar<T>(rows: T[], cle: (r: T) => number): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const r of rows) {
    const k = cle(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** Fin de période d'une date en base (précision respectée), null si absente. */
function finDe(d: Date | null, precision: string | null): Date | null {
  if (!d) return null;
  return finDePeriode(d.toISOString(), (precision ?? 'date') as Precision);
}

// ------------------------------------------------------------- le résolveur

export interface OptionsResolution {
  /** L'instant de référence de la vérité courante (défaut : maintenant). */
  maintenant?: Date;
}

/**
 * Cœur PUR du résolveur : assemble les lignes déjà chargées en états
 * sémantiques. Aucune base, aucun effet de bord — c'est lui que le banc
 * (`npm run verdict:check`) éprouve avec des objets en mémoire.
 */
export function resoudre(
  lignes: LignesBrutes,
  options: OptionsResolution = {},
): Map<number, EtatSemantique> {
  const maintenant = options.maintenant ?? new Date();
  const t = maintenant.getTime();

  const verdicts = new Map(lignes.verdicts.map((v) => [v.messageId, v]));
  const actions = grouperPar(lignes.actions, (r) => r.messageId);
  const evenements = grouperPar(lignes.evenements, (r) => r.messageId);
  const documents = grouperPar(lignes.documents, (r) => r.messageId);
  const mentions = grouperPar(lignes.mentions, (r) => r.messageId);
  const contextes = grouperPar(lignes.contextes, (r) => r.messageId);
  const incertitudes = grouperPar(lignes.incertitudes, (r) => r.messageId);
  const fils = new Map(lignes.fils.map((f) => [f.id, f]));
  const sortants = new Map(lignes.sortants.map((s) => [s.threadId, s.dernierLe]));
  const expediteurs = new Map(
    lignes.expediteurs.map((e) => [`${e.accountSlug}\u0000${e.email}`, e]),
  );
  const taches = grouperPar(lignes.taches, (r) => r.messageId);
  const echeances = grouperPar(lignes.echeances, (r) => r.messageId);
  const etatsFil = grouperPar(lignes.etatsFil, (r) => r.threadId);

  const out = new Map<number, EtatSemantique>();

  for (const m of lignes.messages) {
    const verdict = verdicts.get(m.id) ?? null;
    const actionsV = actions.get(m.id) ?? [];
    const evenementsV = evenements.get(m.id) ?? [];
    const documentsV = documents.get(m.id) ?? [];
    const mentionsV = mentions.get(m.id) ?? [];
    const contextesV = contextes.get(m.id) ?? [];
    const incertitudesV = incertitudes.get(m.id) ?? [];
    const tachesM = taches.get(m.id) ?? [];
    const echeancesM = echeances.get(m.id) ?? [];
    const fil = m.threadId !== null ? (fils.get(m.threadId) ?? null) : null;
    const dernierSortant = m.threadId !== null ? (sortants.get(m.threadId) ?? null) : null;
    const etatsFilM = m.threadId !== null ? (etatsFil.get(m.threadId) ?? []) : [];
    const expediteur = m.fromEmail
      ? (expediteurs.get(`${m.accountSlug}\u0000${m.fromEmail.toLowerCase()}`) ?? null)
      : null;

    // ------------------------------------------------------ signaux serveur
    const sortantApres =
      dernierSortant !== null && m.date !== null && dernierSortant.getTime() > m.date.getTime();
    const signaux: SignauxServeur = {
      etoile: m.isFlagged,
      repondu: m.isAnswered,
      pieceJointe: m.hasAttachments,
      sortantApresDansLeFil: sortantApres,
      dernierSortantDuFil: dernierSortant,
      tacheAFaire: tachesM.some((x) => x.status === 'todo'),
      tacheFaite: tachesM.some((x) => x.status === 'done'),
      prioriteExpediteur: expediteur?.priority ?? null,
      kindExpediteur: expediteur?.kind ?? null,
    };

    // ------------------------------------------------------------ analyse
    const douteLourd = incertitudesV.some((u) =>
      ['truncated_input', 'missing_attachment', 'missing_thread_context', 'conflicting_evidence'].includes(
        u.reason,
      ),
    );
    const analyse: EtatSemantique['analyse'] = {
      verdictPresent: verdict !== null,
      statut: verdict?.analysisStatus ?? 'aucune',
      douteLourd,
      confianceLegacy: m.analysisConfidence,
    };

    // -------------------------------- précédence : manuel > IA > heuristique
    //
    // C'est LA fonction unique promise par la contre-revue. La valeur sort
    // toujours avec sa provenance : sans elle, certains moteurs fusionnaient
    // manuel+IA quand d'autres remplaçaient l'un par l'autre.
    let nature: Resolu<string | null>;
    if (m.intentSource === 'manual') {
      nature = {
        valeur: m.intent,
        source: 'manuel',
        pourquoi: m.intentReason ?? 'intention corrigée à la main',
      };
    } else if (verdict !== null || m.intentSource === 'ai') {
      nature = {
        valeur: m.intent,
        source: 'ia',
        pourquoi: verdict?.subtype
          ? `analyse sémantique (${verdict.subtype})`
          : (m.intentReason ?? 'analyse IA'),
      };
    } else {
      // `intentSource === 'rule'` atterrit ici aussi : une règle regex validée
      // par simulation reste une heuristique déterministe, pas une vérité IA.
      nature = {
        valeur: m.intent,
        source: 'heuristique',
        pourquoi: m.intentReason ?? 'détection heuristique',
      };
    }

    let resume: Resolu<string | null>;
    if (verdict?.summary) {
      resume = { valeur: verdict.summary, source: 'ia', pourquoi: 'résumé du verdict sémantique' };
    } else if (m.aiSummary) {
      resume = { valeur: m.aiSummary, source: 'ia', pourquoi: 'résumé de l’analyse (projection legacy)' };
    } else {
      resume = { valeur: null, source: 'heuristique', pourquoi: 'jamais résumé' };
    }

    let categorieExpediteur: Resolu<string | null>;
    if (!expediteur) {
      categorieExpediteur = {
        valeur: null,
        source: 'heuristique',
        pourquoi: 'expéditeur inconnu de l’index',
      };
    } else if (expediteur.categorySource === 'manual') {
      categorieExpediteur = {
        valeur: expediteur.category,
        source: 'manuel',
        pourquoi: expediteur.categoryReason ?? 'catégorie posée à la main',
      };
    } else if (expediteur.categorySource === 'ai') {
      categorieExpediteur = {
        valeur: expediteur.category,
        source: 'ia',
        pourquoi: expediteur.categoryReason ?? 'catégorie posée par l’analyse IA',
      };
    } else {
      categorieExpediteur = {
        valeur: expediteur.category,
        source: 'heuristique',
        pourquoi: expediteur.categoryReason ?? 'catégorie calculée à la sync',
      };
    }

    // ------------------------------------------------------ faits (passé)
    const faits: EtatSemantique['faits'] = {
      objet: verdict ? { purpose: verdict.purpose, subtype: verdict.subtype } : null,
      actionsDemandees: actionsV.map((a) => ({
        kind: a.kind,
        label: a.label,
        acteur: a.actor,
        force: a.strength,
        dueAt: a.dueAt,
        duePrecision: a.duePrecision,
        expiresAt: a.expiresAt,
        expiresPrecision: a.expiresPrecision,
        montant: a.amount,
        devise: a.currency,
        reference: a.reference,
        certainty: a.certainty,
      })),
      evenementsAnnonces: evenementsV.map((e) => ({
        kind: e.kind,
        label: e.label,
        startsAt: e.startsAt,
        startsPrecision: e.startsPrecision,
        endsAt: e.endsAt,
        participation: e.participation,
        certainty: e.certainty,
      })),
      documentsPortes: documentsV.map((d) => ({
        kind: d.kind,
        label: d.label,
        emetteur: d.issuer,
        issueDate: d.issueDate,
        dueDate: d.dueDate,
        montant: d.amount,
        devise: d.currency,
        reference: d.reference,
        certainty: d.certainty,
      })),
      mentions: mentionsV.map((x) => ({
        kind: x.kind,
        nameRaw: x.nameRaw,
        role: x.role,
        identifier: x.identifier,
        certainty: x.certainty,
      })),
      contextes: contextesV.map((c) => ({ kind: c.kind, label: c.label, certainty: c.certainty })),
      doutes: incertitudesV.map((u) => ({
        reason: u.reason,
        resolvableWith: u.resolvableWith,
        fieldPath: u.fieldPath,
        description: u.description,
      })),
    };

    // --------------------------------------------- état courant des actions
    //
    // L'utilisateur a-t-il écarté le fil (« pas de réponse nécessaire ») ?
    // L'état n'est valable que s'il porte sur CE mail ou un plus récent du
    // même fil : un dismiss posé AVANT ce mail est caduc (schéma AttentionState).
    const reponseEcartee = etatsFilM.some(
      (e) => e.kind === 'reply' && e.state === 'dismissed' && e.messageId >= m.id,
    );
    const reportActif = etatsFilM
      .filter(
        (e) =>
          e.kind === 'reply' &&
          e.state === 'snoozed' &&
          e.messageId >= m.id &&
          e.snoozedUntil !== null &&
          e.snoozedUntil.getTime() > t,
      )
      .map((e) => e.snoozedUntil as Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    const etatsActions: EtatAction[] = faits.actionsDemandees.map((fait) => {
      // 1. MANUEL — l'utilisateur a tranché ou agi. Sa vérité prime.
      if (signaux.tacheFaite && !signaux.tacheAFaire) {
        return {
          fait,
          resteAFaire: false,
          enRetard: false,
          horsDelai: false,
          source: 'manuel',
          pourquoi: 'la tâche liée à ce mail a été marquée faite',
        };
      }
      if (fait.kind === 'reply' && reponseEcartee) {
        return {
          fait,
          resteAFaire: false,
          enRetard: false,
          horsDelai: false,
          source: 'manuel',
          pourquoi: 'fil marqué « pas de réponse nécessaire »',
        };
      }
      // 2. MANUEL (acte observé) — il a répondu. C'est ICI que le fait
      // historique (« demandait une réponse ») cesse d'être un état courant
      // (« une réponse reste attendue »). Volontairement limité à `reply` :
      // fermer à tort MASQUE, laisser ouvert dérange seulement — les autres
      // kinds ne sont pas soldés par un simple mail sortant.
      if (fait.kind === 'reply' && (m.isAnswered || signaux.sortantApresDansLeFil)) {
        return {
          fait,
          resteAFaire: false,
          enRetard: false,
          horsDelai: false,
          source: 'manuel',
          pourquoi: m.isAnswered
            ? 'mail marqué répondu (\\Answered)'
            : 'tu as écrit dans le fil après ce mail',
        };
      }
      // 3. IA (fenêtre déclarée) — hors délai : agir n'a plus de sens.
      // Fermée SANS être satisfaite (l'avion est parti). Précision respectée.
      const finFenetre = finDe(fait.expiresAt, fait.expiresPrecision);
      if (finFenetre && t > finFenetre.getTime()) {
        return {
          fait,
          resteAFaire: false,
          enRetard: false,
          horsDelai: true,
          source: 'ia',
          pourquoi: 'la fenêtre d’action est passée — agir n’a plus de sens',
        };
      }
      // 4. Ouverte. `dueAt` passé = RETARD, jamais résolution — et jamais de
      // péremption fabriquée depuis dueAt (l'inconnu ne périme pas, transitif).
      const finDue = finDe(fait.dueAt, fait.duePrecision);
      const enRetard = finDue !== null && t > finDue.getTime();
      return {
        fait,
        resteAFaire: true,
        enRetard,
        horsDelai: false,
        source: 'ia',
        pourquoi: enRetard
          ? 'échéance dépassée et rien ne l’a soldée — en retard, pas résolue'
          : 'aucun signal de résolution',
      };
    });

    // ------------------------------------------- état courant des échéances
    const etatsEcheances: EtatEcheance[] = echeancesM.map((e) => {
      const fin = finDe(e.date, 'date');
      const echue = fin !== null && t > fin.getTime();
      let statut: EtatEcheance['statut'];
      let source: Provenance;
      let pourquoi: string;
      switch (e.status) {
        case 'done':
          statut = 'faite';
          source = 'manuel';
          pourquoi = 'marquée faite';
          break;
        case 'dismissed':
          statut = 'ecartee';
          source = 'manuel';
          pourquoi = 'écartée à la main';
          break;
        case 'vetoed':
          statut = 'ecartee';
          source = 'ia';
          pourquoi = e.vetoReason ?? 'écartée par l’arbitrage de l’analyse';
          break;
        case 'confirmed':
          statut = echue ? 'en_retard' : 'a_venir';
          source = 'manuel';
          pourquoi = echue
            ? 'confirmée et dépassée — un retard, pas une résolution'
            : 'confirmée par toi';
          break;
        default:
          // proposed — détection serveur, pas encore validée.
          statut = echue ? 'en_retard' : 'a_venir';
          source = 'heuristique';
          pourquoi = echue ? 'proposée et dépassée — un retard, pas une résolution' : e.reason;
      }
      return {
        titre: e.title,
        date: e.date,
        type: e.type,
        echue,
        close: statut === 'faite' || statut === 'ecartee',
        statut,
        source,
        pourquoi,
      };
    });

    // ---------------------------------------------- état courant : attention
    let attention: AttentionCourante;
    if (!verdict) {
      // Jamais analysé : l'inconnu ne périme JAMAIS. Faire disparaître un mail
      // par ignorance serait la faute la plus coûteuse (fiscal, banque…).
      attention = {
        mode: 'unknown',
        perimee: false,
        ecarteeManuellement: reponseEcartee,
        reporteeJusquA: reportActif,
        source: 'heuristique',
        pourquoi: 'jamais analysé — l’inconnu ne périme jamais',
      };
    } else {
      const e: EtatAttention = {
        attentionMode: verdict.attentionMode,
        attentionUntil: verdict.attentionUntil,
        attentionPrecision: verdict.attentionPrecision,
        actions: actionsV.map((a) => ({
          expiresAt: a.expiresAt,
          expiresPrecision: a.expiresPrecision,
          dueAt: a.dueAt,
        })),
        events: evenementsV.map((ev) => ({
          startsAt: ev.startsAt,
          endsAt: ev.endsAt,
          startsPrecision: ev.startsPrecision,
        })),
      };
      let perimee = estPerime(e, maintenant);
      let pourquoi = perimee
        ? 'la fenêtre d’attention est passée'
        : 'le mail mérite encore l’attention (ou on ne sait pas — on montre)';
      // `until_superseded` se tranche au niveau du FIL — verdict.ts le dit et
      // renvoie ici : un message plus récent du même fil remplace celui-ci.
      if (
        verdict.attentionMode === 'until_superseded' &&
        !perimee &&
        fil?.lastMessageAt &&
        m.date &&
        fil.lastMessageAt.getTime() > m.date.getTime()
      ) {
        perimee = true;
        pourquoi = 'un message plus récent l’a remplacé dans le fil';
      }
      attention = {
        mode: verdict.attentionMode ?? 'unknown',
        perimee,
        ecarteeManuellement: reponseEcartee,
        reporteeJusquA: reportActif,
        source: 'ia',
        pourquoi,
      };
    }

    out.set(m.id, {
      messageId: m.id,
      accountSlug: m.accountSlug,
      threadId: m.threadId,
      dateMail: m.date,
      analyse,
      nature,
      resume,
      categorieExpediteur,
      faits,
      courant: { actions: etatsActions, echeances: etatsEcheances, attention },
      signauxServeur: signaux,
      resoluA: maintenant,
    });
  }

  return out;
}

/**
 * LE POINT D'ENTRÉE des 21 moteurs : résout l'état sémantique d'une
 * COLLECTION de mails.
 *
 * Jamais un mail à la fois : en SQLite `connection_limit=1`, charger
 * message → actions → événements → documents → entités mail par mail sur
 * 25 000 messages serait catastrophique. Ici : 14 requêtes par lot de 900
 * identifiants (constant en dessous de 900, jamais proportionnel à N), puis
 * assemblage en mémoire.
 */
export async function resolveMailSemanticState(
  messageIds: number[],
  options: OptionsResolution = {},
): Promise<Map<number, EtatSemantique>> {
  await ensureDbReady();
  const ids = [...new Set(messageIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return new Map();

  // --- 1) les mails eux-mêmes (colonnes plates : flags, précédence, legacy)
  const messages: LigneMessage[] = [];
  for (const lot of parLots(ids, TAILLE_LOT_SQL)) {
    messages.push(
      ...(await db.message.findMany({
        where: { id: { in: lot } },
        select: {
          id: true,
          accountSlug: true,
          threadId: true,
          date: true,
          fromEmail: true,
          subject: true,
          isSeen: true,
          isAnswered: true,
          isFlagged: true,
          isOutbound: true,
          isDeleted: true,
          isAutoReply: true,
          hasAttachments: true,
          intent: true,
          intentSource: true,
          intentReason: true,
          analysisConfidence: true,
          aiSummary: true,
          aiVerdictAt: true,
        },
      })),
    );
  }

  const threadIds = [...new Set(messages.map((m) => m.threadId).filter((x): x is number => x !== null))];
  const slugs = [...new Set(messages.map((m) => m.accountSlug))];
  const emails = [
    ...new Set(messages.map((m) => m.fromEmail?.toLowerCase()).filter((x): x is string => !!x)),
  ];

  // --- 2..8) le verdict sémantique et ses tables, par messageId
  const verdicts: LigneVerdict[] = [];
  const actions: LigneAction[] = [];
  const evenements: LigneEvenement[] = [];
  const documents: LigneDocument[] = [];
  const mentions: LigneMention[] = [];
  const contextes: LigneContexte[] = [];
  const incertitudes: LigneIncertitude[] = [];
  for (const lot of parLots(ids, TAILLE_LOT_SQL)) {
    verdicts.push(
      ...(await db.mailVerdict.findMany({
        where: { messageId: { in: lot } },
        select: {
          messageId: true,
          analysisStatus: true,
          purpose: true,
          subtype: true,
          summary: true,
          attentionMode: true,
          attentionUntil: true,
          attentionPrecision: true,
          attentionBasis: true,
        },
      })),
    );
    actions.push(
      ...(await db.verdictAction.findMany({
        where: { messageId: { in: lot } },
        select: {
          messageId: true,
          kind: true,
          label: true,
          actor: true,
          strength: true,
          dueAt: true,
          duePrecision: true,
          expiresAt: true,
          expiresPrecision: true,
          amount: true,
          currency: true,
          reference: true,
          certainty: true,
        },
      })),
    );
    evenements.push(
      ...(await db.verdictEvent.findMany({
        where: { messageId: { in: lot } },
        select: {
          messageId: true,
          kind: true,
          label: true,
          startsAt: true,
          startsPrecision: true,
          endsAt: true,
          participation: true,
          certainty: true,
        },
      })),
    );
    documents.push(
      ...(await db.verdictDocument.findMany({
        where: { messageId: { in: lot } },
        select: {
          messageId: true,
          kind: true,
          label: true,
          issuer: true,
          issueDate: true,
          dueDate: true,
          amount: true,
          currency: true,
          reference: true,
          certainty: true,
        },
      })),
    );
    mentions.push(
      ...(await db.entityMention.findMany({
        where: { messageId: { in: lot } },
        select: {
          messageId: true,
          kind: true,
          nameRaw: true,
          role: true,
          identifier: true,
          certainty: true,
        },
      })),
    );
    contextes.push(
      ...(await db.verdictContext.findMany({
        where: { messageId: { in: lot } },
        select: { messageId: true, kind: true, label: true, certainty: true },
      })),
    );
    incertitudes.push(
      ...(await db.verdictUncertainty.findMany({
        where: { messageId: { in: lot } },
        select: {
          messageId: true,
          reason: true,
          resolvableWith: true,
          fieldPath: true,
          description: true,
        },
      })),
    );
  }

  // --- 9..10) l'état du FIL : c'est lui qui transforme un fait historique
  // (« demandait une réponse ») en état courant (« réponse encore attendue »).
  const fils: LigneFil[] = [];
  const sortants: LigneSortant[] = [];
  for (const lot of parLots(threadIds, TAILLE_LOT_SQL)) {
    fils.push(
      ...(await db.thread.findMany({
        where: { id: { in: lot } },
        select: { id: true, lastMessageAt: true },
      })),
    );
    // Un groupBy plutôt qu'un findMany : une ligne par fil, quel que soit le
    // nombre de sortants. isAutoReply exclu — un répondeur ne solde rien.
    const aggs = await db.message.groupBy({
      by: ['threadId'],
      where: { threadId: { in: lot }, isOutbound: true, isAutoReply: false, isDeleted: false },
      _max: { date: true },
    });
    for (const a of aggs) {
      if (a.threadId !== null) sortants.push({ threadId: a.threadId, dernierLe: a._max.date });
    }
  }

  // --- 11) expéditeurs (catégorie + précédence + priorité par relation)
  const expediteurs: LigneExpediteur[] = [];
  for (const lot of parLots(emails, TAILLE_LOT_SQL)) {
    expediteurs.push(
      ...(await db.sender.findMany({
        where: { accountSlug: { in: slugs }, email: { in: lot } },
        select: {
          accountSlug: true,
          email: true,
          category: true,
          categorySource: true,
          categoryReason: true,
          priority: true,
          kind: true,
          engagedAt: true,
        },
      })),
    );
  }

  // --- 12..14) traces utilisateur : tâches, échéances, reports/écartements
  const taches: LigneTache[] = [];
  const echeances: LigneEcheance[] = [];
  const etatsFil: LigneEtatFil[] = [];
  for (const lot of parLots(ids, TAILLE_LOT_SQL)) {
    taches.push(
      ...(await db.task.findMany({
        where: { messageId: { in: lot } },
        select: { messageId: true, status: true },
      })).filter((x): x is LigneTache => x.messageId !== null),
    );
    echeances.push(
      ...(await db.deadline.findMany({
        where: { messageId: { in: lot } },
        select: {
          messageId: true,
          title: true,
          date: true,
          type: true,
          status: true,
          vetoReason: true,
          reason: true,
        },
      })),
    );
  }
  for (const lot of parLots(threadIds, TAILLE_LOT_SQL)) {
    etatsFil.push(
      ...(await db.attentionState.findMany({
        where: { threadId: { in: lot } },
        select: {
          threadId: true,
          messageId: true,
          kind: true,
          state: true,
          snoozedUntil: true,
        },
      })),
    );
  }

  return resoudre(
    {
      messages,
      verdicts,
      actions,
      evenements,
      documents,
      mentions,
      contextes,
      incertitudes,
      fils,
      sortants,
      expediteurs,
      taches,
      echeances,
      etatsFil,
    },
    options,
  );
}

// -------------------------------------------------------------- sélecteurs
//
// Les sélecteurs LISENT l'état résolu, ils ne rechargent rien et ne
// réinterprètent rien : ce sont les portes d'entrée que les moteurs
// utiliseront à la place de leurs relectures des colonnes plates.

/** Les actions qui restent à faire PAR L'UTILISATEUR. C'est la réponse à
 *  « qu'attend-on de lui ? » — jamais « qu'a-t-on trouvé comme dates ? ». */
export function getOpenActions(etat: EtatSemantique): EtatAction[] {
  return etat.courant.actions.filter((a) => a.fait.acteur === 'user' && a.resteAFaire);
}

/** L'état d'attention courant — la péremption y est déjà tranchée, fil compris. */
export function getAttentionState(etat: EtatSemantique): AttentionCourante {
  return etat.courant.attention;
}

/**
 * Vue « échéance » d'un mail : les lignes Deadline (cycle de vie produit) ET
 * les actions utilisateur encore ouvertes qui portent un `dueAt`.
 *
 * Une échéance = une action réellement due, jamais une simple date trouvée
 * (piège n° 1 de deadlines.ts) — c'est pourquoi seules les actions OUVERTES
 * de l'utilisateur en produisent. Et une action sans date n'invente rien :
 * une échéance inconnue reste inconnue.
 */
export interface EcheanceResolue {
  origine: 'deadline' | 'action';
  titre: string;
  date: Date;
  /** Date passée = RETARD. Jamais une résolution, jamais un masquage. */
  echue: boolean;
  /** Faite ou écartée — par un acte, jamais par le calendrier. */
  close: boolean;
  statut: 'a_venir' | 'en_retard' | 'faite' | 'ecartee';
  source: Provenance;
  pourquoi: string;
}

export function getDeadlineState(etat: EtatSemantique): EcheanceResolue[] {
  const t = etat.resoluA.getTime();
  const lignes: EcheanceResolue[] = etat.courant.echeances.map((e) => ({
    origine: 'deadline',
    titre: e.titre,
    date: e.date,
    echue: e.echue,
    close: e.close,
    statut: e.statut,
    source: e.source,
    pourquoi: e.pourquoi,
  }));
  for (const a of getOpenActions(etat)) {
    if (!a.fait.dueAt) continue; // pas de date → pas d'échéance inventée
    const fin = finDePeriode(a.fait.dueAt.toISOString(), (a.fait.duePrecision ?? 'date') as Precision);
    const echue = fin !== null && t > fin.getTime();
    lignes.push({
      origine: 'action',
      titre: a.fait.label ?? a.fait.kind,
      date: a.fait.dueAt,
      echue,
      close: false, // ouverte par construction (getOpenActions)
      statut: echue ? 'en_retard' : 'a_venir',
      source: a.source,
      pourquoi: echue ? 'action due et dépassée — en retard, pas résolue' : 'action due, encore ouverte',
    });
  }
  return lignes;
}

/** Les faits utiles à la comptabilité : documents portés + rôles d'entités.
 *  Des FAITS — « contient une facture » — jamais « facture à payer » (ça,
 *  c'est une action `pay` dans getOpenActions). */
export interface FaitsComptables {
  documents: DocumentPorte[];
  /** Qui a ENVOYÉ le mail (rôle sent_by) — maman, pas Sosh. */
  envoyePar: MentionEntite[];
  /** Qui ÉMET les documents (rôle issued_by) — Sosh, pas maman. */
  emisPar: MentionEntite[];
  factureA: MentionEntite[];
  paye: MentionEntite[];
  contextes: ContexteMentionne[];
}

export function getAccountingFacts(etat: EtatSemantique): FaitsComptables {
  const parRole = (role: string): MentionEntite[] =>
    etat.faits.mentions.filter((x) => x.role === role);
  return {
    documents: etat.faits.documentsPortes,
    envoyePar: parRole('sent_by'),
    emisPar: parRole('issued_by'),
    factureA: parRole('billed_to'),
    paye: parRole('pays'),
    contextes: etat.faits.contextes,
  };
}

// --------------------------------------------- protection du nettoyage (veto)

/**
 * L'INVARIANT DE SÉCURITÉ « 0 mail personnel », détaché de l'IA.
 *
 * POURQUOI IL EXISTE : jusqu'ici la garantie reposait accidentellement sur
 * `analysisConfidence = 'low'` dans une clause SQL de retention.ts
 * (protectionClauses, ~l.250) — un champ d'IA portait un invariant de
 * sécurité. Ici le veto est DÉDIÉ et *failure closed* : doute, inconnu,
 * correction manuelle, relation personnelle, preuve insuffisante ⇒ PROTÉGÉ.
 * En cas d'erreur ou de donnée manquante ⇒ PROTÉGÉ.
 *
 * LES DEUX CONFUSIONS QUE CE CODE REND IMPOSSIBLES :
 *  1. `perimee === true` signifie « plus besoin d'attention temporelle »,
 *     JAMAIS « supprimable ». La péremption n'apparaît ici que pour TAIRE le
 *     canal attention — elle n'est jamais une raison de DÉprotéger. Une
 *     facture ancienne est périmée ET intouchable (ses documents la protègent).
 *  2. `certainty = 'high'` de l'IA ne signifie JAMAIS « suppression
 *     autorisée ». Aucune certitude, si haute soit-elle, n'ouvre de porte :
 *     la libération exige l'ABSENCE de tous les vetos, pas la présence d'une
 *     confiance. Certitude de l'analyse et autorisation produit sont deux
 *     dimensions différentes.
 *
 * Usage prévu (lot 4j) : le nettoyage sélectionne d'abord GROSSIÈREMENT en
 * SQL (les clauses actuelles), puis REVALIDE chaque candidat ici, en lot, AU
 * MOMENT D'AGIR — jamais mail par mail au moment du DELETE.
 */
export function getCleanupProtection(
  etat: EtatSemantique | null | undefined,
): ProtectionNettoyage {
  // Donnée manquante ⇒ protégé. Un mail qu'on ne sait pas résoudre ne se
  // supprime pas — c'est le sens même de « failure closed ».
  if (!etat) {
    return {
      protege: true,
      raisons: ['état sémantique introuvable — protégé par défaut (failure closed)'],
    };
  }
  try {
    const raisons: string[] = [];
    const t = etat.resoluA.getTime();
    const horizon = t - HORIZON_ENGAGEMENT_JOURS * 86_400_000;

    // --- Corrections et choix MANUELS : une main humaine est passée là.
    if (etat.nature.source === 'manuel') raisons.push('intention corrigée à la main');
    if (etat.categorieExpediteur.source === 'manuel')
      raisons.push('catégorie d’expéditeur posée à la main');
    if (etat.signauxServeur.etoile) raisons.push('mail étoilé');
    if (etat.signauxServeur.prioriteExpediteur === 'always_important')
      raisons.push('expéditeur marqué « toujours important »');
    if (etat.signauxServeur.tacheAFaire) raisons.push('une tâche à faire est liée à ce mail');

    // --- Relation PERSONNELLE : la garantie « 0 mail personnel ».
    if (etat.categorieExpediteur.valeur === 'person')
      raisons.push('expéditeur classé « personne »');
    if (etat.signauxServeur.kindExpediteur === 'person')
      raisons.push('expéditeur reconnu comme une personne');
    if (
      etat.faits.mentions.some(
        (x) =>
          x.role === 'sent_by' &&
          x.kind === 'person' &&
          (x.certainty === 'explicit' || x.certainty === 'strong_inference'),
      )
    )
      raisons.push('l’analyse dit que ce mail vient d’une personne');

    // --- Traces d'échange, GRADUÉES comme dans retention.ts (P2.1) : elles
    // protègent tant que l'échange est récent ; une date inconnue protège.
    if (
      etat.signauxServeur.repondu &&
      (etat.dateMail === null || etat.dateMail.getTime() >= horizon)
    )
      raisons.push('mail auquel tu as répondu récemment');
    const sortant = etat.signauxServeur.dernierSortantDuFil;
    if (
      (sortant !== null && sortant.getTime() >= horizon) ||
      (sortant === null && etat.signauxServeur.sortantApresDansLeFil)
    )
      raisons.push('tu as écrit récemment dans ce fil');

    // --- Contenu à VALEUR : documents, pièces, actions et échéances vivantes.
    if (etat.faits.documentsPortes.length > 0)
      raisons.push('porte un document (facture, contrat, attestation…)');
    if (etat.signauxServeur.pieceJointe) raisons.push('a des pièces jointes');
    if (getOpenActions(etat).length > 0) raisons.push('une action reste à faire');
    if (etat.courant.echeances.some((e) => !e.close))
      raisons.push('une échéance active est liée à ce mail');

    // --- Attention encore VIVANTE. Noter le sens unique : non-périmé
    // protège ; périmé ne DÉprotège rien (confusion n° 1).
    if (etat.analyse.verdictPresent) {
      const att = etat.courant.attention;
      if (att.mode === 'unknown') {
        raisons.push('fenêtre d’attention inconnue — dans le doute, on garde');
      } else if (att.mode !== 'none' && !att.perimee) {
        raisons.push('le mail mérite encore l’attention');
      }
    }

    // --- Doute / preuve INSUFFISANTE : on ne supprime jamais sur un doute.
    if (etat.analyse.verdictPresent && etat.analyse.statut !== 'complete')
      raisons.push('analyse partielle ou en échec');
    if (etat.analyse.douteLourd)
      raisons.push('doute lourd déclaré par l’analyse (pièce manquante, texte tronqué…)');
    if (etat.analyse.confianceLegacy === 'low')
      raisons.push('analyse incertaine (confiance faible)');
    if (!etat.analyse.verdictPresent) {
      // Pas de verdict sémantique : la seule preuve est l'heuristique legacy.
      // Elle ne suffit que si une intention est posée ET que la confiance B4
      // n'est ni absente ni faible — sinon, preuve insuffisante ⇒ protégé.
      const confiance = etat.analyse.confianceLegacy;
      if (etat.nature.valeur === null || confiance === null) {
        raisons.push('jamais analysé — preuve insuffisante pour autoriser quoi que ce soit');
      }
    }

    return { protege: raisons.length > 0, raisons };
  } catch (err) {
    // Failure closed jusque dans l'exception : une protection qui plante
    // devient une protection qui protège.
    return {
      protege: true,
      raisons: [
        `erreur pendant l’évaluation — protégé par défaut : ${(err as Error).message}`,
      ],
    };
  }
}

/**
 * Le veto en LOT, pour une liste BORNÉE de candidats (le nettoyage
 * présélectionne en SQL, puis revalide ici au moment d'agir).
 *
 * Failure closed de bout en bout : un id introuvable rend « protégé » ; une
 * résolution qui échoue rend TOUT le lot « protégé ».
 */
export async function isCleanupProtected(
  messageIds: number[],
  options: OptionsResolution = {},
): Promise<Map<number, ProtectionNettoyage>> {
  const out = new Map<number, ProtectionNettoyage>();
  let etats: Map<number, EtatSemantique>;
  try {
    etats = await resolveMailSemanticState(messageIds, options);
  } catch (err) {
    for (const id of messageIds) {
      out.set(id, {
        protege: true,
        raisons: [
          `résolution impossible — tout le lot est protégé par défaut : ${(err as Error).message}`,
        ],
      });
    }
    return out;
  }
  for (const id of messageIds) {
    out.set(id, getCleanupProtection(etats.get(id)));
  }
  return out;
}
