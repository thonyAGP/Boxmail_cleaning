import { db, ensureDbReady } from '../db/client.js';
import { recordOperation } from './oplog.js';
import {
  resolveMailSemanticState,
  getOpenActions,
  getAttentionState,
  type EtatSemantique,
} from './semantique.js';

/**
 * Attention Engine — Phase 4, brique 1 : RÉPONSES OUBLIÉES (SPEC V2 §8.3).
 * BASCULÉ SUR LE SOCLE au lot 4d (12/08).
 *
 * C'est ce moteur qui cachait le plus : le banc du 11/08 a compté 115 mails
 * qui méritaient d'être vus et n'apparaissaient NULLE PART — des demandes de
 * réservation Airbnb, une relance de facture impayée répétée cinq mois,
 * « Votre paiement au cabinet comptable a échoué » resté 334 jours sans
 * suite. Cause commune : des listes fermées (adresses no-reply, intentions
 * « sans réponse ») avaient le dernier mot sur ce que l'analyse avait compris.
 *
 * LA RÈGLE DU LOT 4D, tenue dans `evaluerReponseAttendue` :
 *
 *   Une réponse est attendue quand une ACTION de type réponse est encore
 *   OUVERTE pour l'utilisateur (verdict sémantique : action `reply`,
 *   `actor = 'user'`, que rien n'a soldée) ET que la fenêtre d'attention est
 *   vivante. Jamais parce que le dernier message du fil est entrant, jamais
 *   à cause d'une catégorie, jamais malgré l'analyse.
 *
 * COHABITATION (l'immense majorité des mails n'a pas encore de verdict
 * sémantique) : quand le verdict existe, LUI SEUL décide — l'adresse de
 * l'expéditeur, les intentions legacy et `aiAction` ne sont plus consultés.
 * Sinon, les heuristiques historiques restent le REPLI, correctif du 11/08
 * compris (`ATTEND_REPONSE` : l'adresse ne prime pas sur l'analyse), et la
 * raison affichée avoue le repli.
 *
 * Seuils SPEC : urgent 24 h · banque/comptable/administration 48 h ·
 * normal 7 jours. Chaque élément porte une `reason` explicite en français.
 *
 * L'utilisateur peut reporter (snooze) ou ignorer (dismiss) un fil : l'état
 * est stocké dans AttentionState, lié au dernier message entrant du fil — si
 * un nouveau mail arrive ensuite dans le fil, l'état devient caduc et
 * l'élément réapparaît automatiquement.
 */

export type ReplyCategory = 'urgent' | 'important' | 'normal';
export type ReplyState = 'active' | 'snoozed' | 'dismissed';

export interface ReplyItem {
  account: string;
  threadId: number;
  /** id interne (colonne Message.id) du mail en attente — sert au suivi d'état. */
  messageId: number;
  uid: number;
  folder: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  date: string;
  isSeen: boolean;
  /** Nombre de messages du fil (contexte). */
  threadMessageCount: number;
  category: ReplyCategory;
  categoryLabel: string;
  thresholdHours: number;
  waitingHours: number;
  /** true si le seuil de la catégorie est dépassé. */
  overdue: boolean;
  /** Type de demande détecté (B3) : réponse attendue / action / question / info. */
  requestKind: RequestKind;
  requestKindLabel: string;
  /** true si tu n'es pas dans les destinataires principaux (probablement en copie). */
  inCopy: boolean;
  /** Justification explicite, affichée telle quelle. */
  reason: string;
  /**
   * SUR QUOI REPOSE la qualification (18/08) : `verdict` = l'analyse déclare
   * une action `reply` de l'utilisateur encore ouverte ; `structure` = simple
   * forme du fil (dernier entrant, rien envoyé depuis), qui ne prouve rien.
   * L'accueil s'en sert pour ne JAMAIS donner une des trois cartes à une
   * présomption tant qu'il reste un fait établi à montrer.
   */
  preuve: 'verdict' | 'structure';
  state: ReplyState;
  snoozedUntil: string | null;
}

export interface UnansweredOptions {
  /** overdue = seulement les seuils dépassés (défaut all). */
  scope?: 'all' | 'overdue';
  /** Fenêtre d'analyse en jours (défaut 60, max 365). */
  sinceDays?: number;
  /** Nombre max d'éléments retournés (défaut 200). */
  limit?: number;
  /** Inclure aussi les éléments reportés/ignorés (pour les onglets de l'interface). */
  includeHidden?: boolean;
}

export interface UnansweredResult {
  account: string;
  sinceDays: number;
  counts: { active: number; overdue: number; snoozed: number; dismissed: number };
  items: ReplyItem[];
  truncated: boolean;
}

const THRESHOLDS: Record<ReplyCategory, number> = {
  urgent: 24,
  important: 48,
  normal: 7 * 24,
};

const CATEGORY_LABELS: Record<ReplyCategory, string> = {
  urgent: 'Urgent',
  important: 'Banque / admin / pro',
  normal: 'Normal',
};

/** Expéditeurs automatiques (même filtre que le nettoyage) : jamais « à répondre ». */
// Séparateurs [-._] optionnels partout : « no_reply@paypal », « do_not_reply@arlo »
// et « no.reply@vilogi » passaient la barrière et finissaient dans « Réponses en
// attente » (constaté sur données réelles le 02/08).
export const AUTO_SENDER_RE =
  /(no[-._]?reply|nepasrepondre|ne[-._]?pas[-._]?repondre|do[-._]?not[-._]?reply|notification|mailer-daemon|newsletter|automat|postmaster)/i;

/**
 * Intentions où l'analyse dit ELLE-MÊME qu'une réponse est attendue. Aucune
 * heuristique de structure — l'adresse de l'expéditeur, la forme du fil — n'a
 * le droit de les faire taire.
 *
 * MESURÉ LE 11/08, et c'est la raison d'être de cette constante. Le banc a
 * trouvé 115 mails qui méritaient d'être vus et n'apparaissaient nulle part.
 * 48 d'entre eux venaient d'une adresse écartée par AUTO_SENDER_RE : vilogi
 * (son syndic), dgfip (les impôts), airbnb et homeexchange (sa location
 * saisonnière), gocardless, foncia, pacifica. Sa location tourne sur des
 * adresses de notification ; une expression régulière sur l'expéditeur les
 * faisait disparaître alors que l'analyse avait écrit « attend une réponse ».
 *
 * Ce garde-fou existait déjà plus bas dans getUnansweredEmails, mais il était
 * INATTEIGNABLE : le filtre d'adresse s'appliquait soixante lignes plus tôt,
 * à la collecte. Il était donc du code mort depuis sa naissance — écrit
 * précisément pour « un message de voyageur Airbnb », et incapable de le
 * sauver. D'où sa remontée ici, au niveau du module.
 *
 * Depuis le lot 4d, ne sert plus qu'au REPLI (mails sans verdict sémantique) :
 * quand le verdict existe, c'est lui qui dit si une réponse reste attendue.
 */
export const ATTEND_REPONSE = new Set(['reply_expected', 'action_required']);

/**
 * Sujet de RÉPONSE AUTOMATIQUE (répondeur, absence du bureau, accusé
 * d'orientation). Bug réel 02/08 : l'utilisateur répond, le répondeur du
 * destinataire renvoie « Ceci est une réponse automatique… » une minute plus
 * tard — chronologiquement le fil se termine par un entrant, donc il
 * retombait dans « À répondre » ET disparaissait de « À relancer ». Ces mails
 * ne comptent NI comme « attend ta réponse » NI comme « réponse reçue ».
 */
export const AUTO_REPLY_SUBJECT_RE =
  /r[ée]ponse\s+automatique|r[ée]ponse\s+d['’]absence|absente?\s+du\s+bureau|automatic\s+reply|auto[-\s]?reply|autoreply|out\s+of\s+office|away\s+from\s+(the\s+)?office/i;

export function isAutoReplySubject(subject: string | null | undefined): boolean {
  return !!subject && AUTO_REPLY_SUBJECT_RE.test(subject);
}

/** Sujet qui réclame une réponse rapide. */
export const URGENT_SUBJECT_RE =
  /(urgent|au plus vite|asap|dernier rappel|derni[èe]re relance|mise en demeure|imp[ée]ratif|avant le)/i;

/**
 * Expéditeur type banque / administration / comptable / juridique (seuil 48 h).
 * Attention aux faux positifs : pas de domaines grand public (orange.fr, sfr…)
 * et frontières de mots sur les tokens courts (caf ≠ café, msa ≠ thomsa).
 */
export const IMPORTANT_SENDER_RE =
  /(banque|bank|cr[ée]dit|boursorama|fortuneo|\bbnp\b|societe ?generale|banquepostale|impot|finances|dgfip|tresor|urssaf|ameli|cpam|\bmsa\b|\bcaf\b|assurance|mutuelle|notaire|avocat|huissier|comptab|prefecture|mairie|gouv\.fr|pole-?emploi|francetravail|syndic|foncia)/i;

// ---------------------------------------------------------------------------
// Avis automatiques (règle utilisateur du 31/07/2026) — deux familles à ne
// PAS confondre :
//  · « relevé / documents à disposition » : la banque annonce la génération
//    d'un relevé mensuel. Il n'y a JAMAIS rien à traiter — ni réponse à
//    attendre, ni « non traité » à afficher, quel que soit l'âge du mail.
//  · « un message dans votre espace » : là il y a bien quelque chose à lire,
//    mais le message ne reste consultable que ~60 jours côté banque — passé
//    ce délai, l'avis est périmé et ne doit plus compter nulle part.
// Les avis d'espace de MOINS de 60 jours gardent le comportement normal.
// ---------------------------------------------------------------------------

/** Mise à disposition automatique d'un relevé/document (génération mensuelle). */
export const DOCUMENT_NOTICE_RE =
  /(relev[ée]s?[^\n]{0,40}\b(est |sont )?disponibles?\b|(relev[ée]s?|documents?)[^\n]{0,60}[àa] disposition\b|mise [àa] disposition[^\n]{0,40}(relev[ée]s?|documents?))/i;

/** Avis « un (nouveau) message t'attend dans ton espace / ta messagerie ». */
export const ESPACE_MESSAGE_RE =
  /((nouveaux?\s+)?messages?[^\n]{0,30}(dans|sur)\s+(votre|ton)\s+(espace|messagerie)|vous avez\s+(re[çc]u\s+)?(un|\d+)\s+(nouveaux?\s+)?messages?|messages? vous attend)/i;

/** Durée de vie d'un avis « message dans ton espace » avant péremption. */
export const ESPACE_MESSAGE_TTL_DAYS = 60;

/**
 * Si ce mail est un avis automatique qui ne réclame (plus) aucun traitement,
 * renvoie la raison en français ; sinon null. Sujet seul (index-only).
 */
export function autoNoticeMuted(
  subject: string | null | undefined,
  date: Date | null,
  now: number,
): string | null {
  const s = (subject ?? '').replace(/’/g, "'");
  if (DOCUMENT_NOTICE_RE.test(s)) {
    return 'avis automatique de mise à disposition d’un relevé/document — rien à traiter (ta règle)';
  }
  if (ESPACE_MESSAGE_RE.test(s)) {
    const ageDays = date ? (now - date.getTime()) / 86_400_000 : 0;
    if (ageDays > ESPACE_MESSAGE_TTL_DAYS) {
      return `avis « message dans ton espace » périmé (plus de ${ESPACE_MESSAGE_TTL_DAYS} jours) — plus rien à consulter (ta règle)`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Réponse attendue v2 (B3) : TYPE DE DEMANDE. Beaucoup de mails réclament une
// réponse SANS poser de question (« merci de me transmettre », « dans
// l'attente de votre retour ») — motifs français explicites, appliqués au
// sujet (index-only) et, quand il est disponible, au corps SANS le texte cité.
// ---------------------------------------------------------------------------

export type RequestKind = 'reply_expected' | 'action' | 'question' | 'information';

export const REQUEST_KIND_LABELS: Record<RequestKind, string> = {
  reply_expected: 'Réponse explicitement attendue',
  action: 'Action demandée',
  question: 'Question posée',
  information: 'Information',
};

/** Réponse explicitement attendue, sans « ? » (tournures françaises). */
export const REPLY_EXPECTED_RE =
  /(dans l'attente de (votre|ta|ton) (r[ée]ponse|retour|confirmation|accord)|en attente de (votre|ta|ton) (r[ée]ponse|retour)|j'attends (votre|ta|ton) (r[ée]ponse|retour|accord|confirmation)|merci de (me |nous )?(r[ée]pondre|confirmer|tenir inform[ée])|r[ée]ponse (souhait[ée]e|attendue|rapide)|qu'en (penses?[- ]tu|pensez[- ]vous)|(tiens|tenez)[- ](moi|nous) (au courant|inform[ée]e?s?)|dis[- ]moi (ce que|si|quand|ce qu')|confirmez?[- ](moi|nous)|merci de (nous |me )?faire (un )?retour)/i;

/** Action demandée, sans « ? » (transmettre, signer, valider, régler…). */
export const ACTION_REQUEST_RE =
  /(merci de (me |nous |bien vouloir )?(transmettre|envoyer|renvoyer|retourner|fournir|valider|signer|compl[ée]ter|remplir|v[ée]rifier|payer|r[ée]gler|d[ée]poser)|veuillez (me |nous |bien vouloir )?(transmettre|envoyer|renvoyer|retourner|fournir|valider|signer|compl[ée]ter|remplir|proc[ée]der)|(pouvez|pourriez)[- ]vous|(peux|pourrais)[- ]tu|[àa] (me |nous )?retourner (sign[ée]|compl[ée]t[ée]|avant)|[àa] (compl[ée]ter|signer|valider|r[ée]gler) (avant|pour|imp[ée]rativement)|action requise|signature (requise|attendue)|piece[s]? [àa] fournir|document[s]? [àa] (fournir|signer|retourner))/i;

/**
 * Retire le texte CITÉ d'un corps de mail (lignes « > », blocs « Le … a
 * écrit : », séparateurs Outlook) : on n'analyse que ce que l'expéditeur a
 * réellement écrit, pas la conversation recopiée dessous.
 */
export function stripQuotedText(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(>|\|)/.test(line)) continue; // ligne citée
    if (/^\s*Le .{4,100} a [ée]crit\s*:/.test(line)) break;
    if (/^\s*On .{4,100} wrote\s*:/i.test(line)) break;
    if (/^-{2,}\s*(Message d'origine|Message transf[ée]r[ée]|Original Message|Forwarded message)/i.test(line)) break;
    if (/^\s*_{6,}\s*$/.test(line)) break; // séparateur de citation Outlook
    if (/^\s*De\s?:\s.+/.test(line) || /^\s*From\s?:\s.+@/.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Détecte le TYPE de demande d'un mail entrant : réponse explicitement
 * attendue > action demandée > question > information. Le sujet suffit
 * (index-only) ; le corps — déjà débarrassé du texte cité — affine quand
 * l'interface le fournit (analyse du mail ouvert).
 */
export function detectRequestKind(
  subject: string | null | undefined,
  body?: string | null,
): { kind: RequestKind; why: string } {
  const s = (subject ?? '').replace(/’/g, "'");
  const b = (body ?? '').replace(/’/g, "'").slice(0, 20_000);
  let m = REPLY_EXPECTED_RE.exec(s) ?? (b ? REPLY_EXPECTED_RE.exec(b) : null);
  if (m) return { kind: 'reply_expected', why: `réponse explicitement attendue (« ${m[0].trim()} »)` };
  m = ACTION_REQUEST_RE.exec(s) ?? (b ? ACTION_REQUEST_RE.exec(b) : null);
  if (m) return { kind: 'action', why: `action demandée (« ${m[0].trim()} »)` };
  if (s.includes('?')) return { kind: 'question', why: 'le sujet pose une question' };
  if (b && /^[^>\n]*\S.*\?\s*$/m.test(b)) {
    return { kind: 'question', why: 'le mail pose une question' };
  }
  return { kind: 'information', why: 'aucune demande explicite détectée' };
}

// ---------------------------------------------------------------------------
// La décision « une réponse est-elle encore attendue ? » (lot 4d)
// ---------------------------------------------------------------------------

/**
 * REPLI UNIQUEMENT — intentions legacy réputées « sans réponse » quand
 * l'expéditeur n'est pas une personne. Mesuré le 02/08 : 47 des 81 « en
 * attente » étaient des factures Amazon/Stripe, des codes AXA/impots, des
 * confirmations bancaires — c'est ce qui minait la confiance dans l'écran.
 * `reminder` et `appointment` ajoutés le 11/08 (le rappel Air France d'un vol
 * passé présenté première priorité du jour).
 *
 * Cette liste ne s'applique JAMAIS à un mail porteur d'un verdict sémantique :
 * là, l'attention vient d'une action ouverte + d'une fenêtre + de l'état du
 * fil, jamais d'une catégorie (piège n° 3 de la contre-revue). Elle meurt avec
 * le dernier mail non analysé.
 */
const NO_REPLY_INTENTS = new Set([
  'otp',
  'invoice',
  'shipping',
  'confirmation',
  'promo',
  'document',
  'reminder',
  'appointment',
  // `info` AJOUTÉ LE 18/08 — le trou par lequel passaient les publicités.
  // MESURÉ sur la production : sur les 9 « réponses attendues » qualifiées
  // sans verdict ce matin-là, 8 portaient `intent = 'info'` — « Joyeux
  // anniversaire 🎉 un cadeau rien que pour vous », « Le Galaxy S26 Ultra à
  // 1€ », « +250 € de titres cadeaux », « We're updating our Privacy
  // Policy »… L'ancienne analyse les avait pourtant correctement rangées
  // « information » ; personne ne l'écoutait, et la carte tombait sur le
  // `return attendue: true` final. L'utilisateur : « ces mails n'attendaient
  // même pas de réponse ».
  //
  // Les 7 écartés sont TOUS des expéditeurs `company`. Les 2 candidats
  // légitimes du même lot — « SAS LB2I – Remise de résultat » (sa comptable)
  // et « RECOMMANDES URSSAF » (via Mylène) — sont classés `person` et
  // survivent donc par l'exception ci-dessous, qui fait ici exactement son
  // travail. C'est pourquoi `info` est sûr ICI et le serait pas sans elle.
  'info',
]);

/** Verdict de l'ancienne analyse plate : « rien à faire » (repli uniquement). */
const AI_ACTIONS_SANS_SUITE = new Set(['archive', 'none', 'read']);

/** Ce que le repli heuristique doit savoir d'un mail sans verdict. */
export interface CandidatRepli {
  fromEmail: string;
  subject: string | null;
  date: Date | null;
  /** Colonne legacy `intent` (elle porte déjà les corrections manuelles). */
  intent: string | null;
  /** Colonne legacy `aiAction` (projection de l'ancienne analyse). */
  aiAction: string | null;
  /**
   * En-tête List-Unsubscribe. Signal de DIFFUSION, pas de non-réponse : les
   * plateformes en mettent sur des mails transactionnels. Ne sert plus qu'au
   * repli, jamais à écarter un mail dont l'analyse dit le contraire.
   */
  hasListUnsubscribe?: boolean;
}

export interface EvaluationReponse {
  attendue: boolean;
  /** verdict = décidé par le socle ; repli = heuristiques legacy, en
   *  attendant que ce mail soit analysé. */
  source: 'verdict' | 'repli';
  /** Justification en français, affichable telle quelle. */
  pourquoi: string;
}

/**
 * Une réponse est-elle encore attendue de l'utilisateur pour ce mail ?
 * Fonction PURE (le banc l'éprouve avec des états résolus en mémoire).
 *
 * Les trois pièges de la contre-revue, tenus ici même :
 *  1. « demandait une réponse » (fait) ≠ « une réponse reste à faire »
 *     (état) → on lit `getOpenActions` (courant), jamais
 *     `faits.actionsDemandees` ; un mail auquel il a répondu, ou un fil marqué
 *     « pas de réponse nécessaire », sort avec le pourquoi de sa clôture ;
 *  2. l'expéditeur n'est pas l'acteur → seules les actions `actor = 'user'`
 *     comptent (getOpenActions filtre) : une demande de réservation venant de
 *     `automated@airbnb.com` reste visible, un mail où il n'est pas
 *     destinataire de la demande n'attend rien de lui ;
 *  3. pas de NO_REPLY_INTENTS déguisé → sur un mail au verdict connu, AUCUNE
 *     catégorie (facture, info, confirmation…) n'est consultée : uniquement
 *     l'ouverture de l'action, la fenêtre d'attention et l'état du fil.
 */
export function evaluerReponseAttendue(
  etat: EtatSemantique | null | undefined,
  candidat: CandidatRepli,
  maintenant: number,
): EvaluationReponse {
  // ------------------------------------------------ le verdict, quand il existe
  if (etat?.analyse.verdictPresent) {
    const reponses = etat.courant.actions.filter(
      (a) => a.fait.kind === 'reply' && a.fait.acteur === 'user',
    );
    const ouvertes = reponses.filter((a) => a.resteAFaire);
    if (ouvertes.length === 0) {
      const fermee = reponses[0];
      // L'écartement manuel (« pas de réponse nécessaire ») ne fait pas
      // DISPARAÎTRE l'élément : il doit rester visible dans l'onglet
      // « Ignorées » du moteur, et restaurable. C'est l'état utilisateur
      // (states, étape 4 de getUnansweredEmails) qui le marquera `dismissed` ;
      // ici on ne répond qu'à la question structurelle « une réponse
      // serait-elle attendue sans cet écartement ? ».
      const fermeeParEcartementSeul =
        fermee !== undefined &&
        etat.courant.attention.ecarteeManuellement &&
        !etat.signauxServeur.repondu &&
        !etat.signauxServeur.sortantApresDansLeFil &&
        !etat.signauxServeur.tacheFaite;
      if (fermeeParEcartementSeul) {
        return {
          attendue: true,
          source: 'verdict',
          pourquoi:
            'le mail demandait une réponse — fil marqué « pas de réponse nécessaire » par toi',
        };
      }
      if (fermee) {
        // Le FAIT demeure (le mail demandait une réponse) ; l'ÉTAT est soldé —
        // et on dit par quoi (il a répondu, écarté le fil, fenêtre passée…).
        return {
          attendue: false,
          source: 'verdict',
          pourquoi: `le mail demandait une réponse, mais plus maintenant : ${fermee.pourquoi}`,
        };
      }
      return {
        attendue: false,
        source: 'verdict',
        pourquoi: "l'analyse du mail ne déclare aucune réponse à faire de ta part",
      };
    }
    const attention = getAttentionState(etat);
    if (attention.perimee) {
      return {
        attendue: false,
        source: 'verdict',
        pourquoi: `la fenêtre d'attention est passée — ${attention.pourquoi}`,
      };
    }
    const a = ouvertes[0];
    return {
      attendue: true,
      source: 'verdict',
      pourquoi:
        `l'analyse du mail déclare une réponse encore attendue de ta part` +
        `${a.fait.label ? ` (« ${a.fait.label} »)` : ''}`,
    };
  }

  // -------------------------------- le repli (pas encore de verdict sémantique)
  //
  // Comportement historique conservé, correctif du 11/08 compris : quand
  // l'ancienne analyse a écrit « attend une réponse », NI l'adresse de
  // l'expéditeur NI son propre `aiAction` n'ont le droit de la faire taire.
  const attendExplicite = ATTEND_REPONSE.has(candidat.intent ?? '');
  // L'en-tête de désinscription redescend ICI, dans le repli : il écartait le
  // mail à la collecte, donc AVANT même que l'analyse ait son mot à dire —
  // même faute que l'adresse de l'expéditeur, et sur les mêmes catégories
  // (assurance, comptable, syndic, relance de facture impayée).
  if (candidat.hasListUnsubscribe && !attendExplicite) {
    return {
      attendue: false,
      source: 'repli',
      pourquoi:
        "l'expéditeur propose une désinscription (liste de diffusion) et aucune analyse ne dit le contraire — repli, pas encore de verdict",
    };
  }
  if (AUTO_SENDER_RE.test(candidat.fromEmail) && !attendExplicite) {
    return {
      attendue: false,
      source: 'repli',
      pourquoi:
        'expéditeur automatique (no-reply/notification) et aucune analyse ne dit le contraire — repli, pas encore de verdict',
    };
  }
  const muet = autoNoticeMuted(candidat.subject, candidat.date, maintenant);
  if (muet) {
    return { attendue: false, source: 'repli', pourquoi: muet };
  }
  // Une PERSONNE n'est jamais écartée : elle peut attendre une réponse quoi
  // qu'elle envoie (l'artisan qui joint sa facture attend parfois un retour).
  const estUnePersonne =
    etat?.categorieExpediteur.valeur === 'person' ||
    etat?.signauxServeur.kindExpediteur === 'person';
  if (!estUnePersonne) {
    if (candidat.intent && NO_REPLY_INTENTS.has(candidat.intent)) {
      return {
        attendue: false,
        source: 'repli',
        pourquoi: `mail transactionnel (${candidat.intent}) d'un expéditeur qui n'est pas une personne — repli, pas encore de verdict`,
      };
    }
    if (candidat.aiAction && AI_ACTIONS_SANS_SUITE.has(candidat.aiAction) && !attendExplicite) {
      return {
        attendue: false,
        source: 'repli',
        pourquoi: `l'ancienne analyse conclut « ${candidat.aiAction} » (rien à faire) — repli, en attendant le verdict sémantique`,
      };
    }
  }
  return {
    attendue: true,
    source: 'repli',
    pourquoi:
      "dernier message du fil sans réponse envoyée — repli heuristique, ce mail n'a pas encore de verdict d'analyse",
  };
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function humanDelay(hours: number): string {
  if (hours < 1) return "moins d'une heure";
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} jours`;
}

function categorize(c: {
  subject: string | null;
  fromEmail: string | null;
  fromName: string | null;
}): { category: ReplyCategory; why: string } {
  const subject = c.subject ?? '';
  const urgentMatch = URGENT_SUBJECT_RE.exec(subject);
  if (urgentMatch) {
    return { category: 'urgent', why: `sujet marqué urgent (« ${urgentMatch[0]} »)` };
  }
  const senderText = `${c.fromEmail ?? ''} ${c.fromName ?? ''}`;
  const importantMatch = IMPORTANT_SENDER_RE.exec(senderText);
  if (importantMatch) {
    return {
      category: 'important',
      why: `expéditeur type banque/administration/pro (« ${importantMatch[0]} »)`,
    };
  }
  return { category: 'normal', why: 'correspondant classique' };
}

/**
 * Liste les mails en attente de réponse d'un compte, avec état (actif /
 * reporté / ignoré), catégorie, seuil et justification.
 */
export async function getUnansweredEmails(
  account: string,
  opts: UnansweredOptions = {},
): Promise<UnansweredResult> {
  await ensureDbReady();
  const sinceDays = Math.min(Math.max(opts.sinceDays ?? 60, 1), 365);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const now = Date.now();

  // Adresse du compte : sert à distinguer destinataire principal / copie (B3).
  const accountRow = await db.account.findUnique({
    where: { slug: account },
    select: { emailAddress: true },
  });
  const accountEmail = accountRow?.emailAddress?.toLowerCase() ?? null;

  // 1. Candidats : mails entrants « répondables » de la boîte de réception.
  //    PLUS AUCUN FILTRE DE FORME À LA COLLECTE (lot 4d, complété le 12/08) :
  //    ni l'adresse de l'expéditeur, ni l'en-tête List-Unsubscribe. C'est
  //    evaluerReponseAttendue qui décide — le verdict d'abord, les heuristiques
  //    en repli.
  //
  //    MESURÉ : le List-Unsubscribe écartait 21 des 191 mails que le banc
  //    compte comme « à traiter », soit le même angle mort que les 48 mails
  //    no-reply de la veille. Dedans : cinq mails AXA, deux de son comptable,
  //    deux de son syndic, une relance de facture impayée, et « [ACTION
  //    REQUISE] – Mise en conformité de votre société ». Les plateformes
  //    posent cet en-tête sur des mails transactionnels ; c'est un signal de
  //    diffusion, pas une preuve qu'aucune réponse n'est attendue.
  const raw = await db.message.findMany({
    where: {
      accountSlug: account,
      isDeleted: false,
      isOutbound: false,
      isAnswered: false,
      isAutoReply: false,
      threadId: { not: null },
      fromEmail: { not: null },
      date: { gte: since },
      folder: { is: { role: 'inbox' } },
    },
    orderBy: { date: 'desc' },
    select: {
      id: true,
      threadId: true,
      uid: true,
      subject: true,
      fromEmail: true,
      fromName: true,
      toEmails: true,
      date: true,
      isSeen: true,
      // Colonnes legacy, lues UNIQUEMENT par le repli (mails sans verdict
      // sémantique) — voir evaluerReponseAttendue.
      intent: true,
      aiAction: true,
      hasListUnsubscribe: true,
      folder: { select: { path: true } },
    },
  });

  // Un candidat par fil : le plus récent (la liste est triée par date desc).
  const byThread = new Map<number, (typeof raw)[number]>();
  for (const m of raw) {
    if (m.threadId === null || m.date === null || !m.fromEmail) continue;
    // Filet pour les mails indexés avant la colonne isAutoReply : un
    // répondeur d'absence ne demande rien.
    if (isAutoReplySubject(m.subject)) continue;
    if (!byThread.has(m.threadId)) byThread.set(m.threadId, m);
  }

  // L'état sémantique de TOUT le lot, résolu en une passe (lot 4d — jamais
  // mail par mail, SQLite connection_limit=1) : précédence, état du fil et
  // clôture des actions y sont déjà tranchés.
  const etats = await resolveMailSemanticState([...byThread.values()].map((m) => m.id));

  // La décision « réponse attendue ? », mail par mail : le verdict sémantique
  // quand il existe (action `reply` ouverte + fenêtre vivante), le repli
  // heuristique sinon — correctif du 11/08 compris (l'adresse de l'expéditeur
  // ne prime pas sur l'analyse : une demande de réservation Airbnb part de
  // `automated@airbnb.com`, une relance de son syndic de
  // `notification@vilogi.com`).
  const evaluations = new Map<number, EvaluationReponse>();
  for (const [threadId, m] of [...byThread]) {
    const evaluation = evaluerReponseAttendue(
      etats.get(m.id),
      {
        fromEmail: m.fromEmail as string,
        subject: m.subject,
        date: m.date,
        intent: m.intent,
        aiAction: m.aiAction,
        hasListUnsubscribe: m.hasListUnsubscribe,
      },
      now,
    );
    if (!evaluation.attendue) {
      byThread.delete(threadId);
      continue;
    }
    evaluations.set(threadId, evaluation);
  }
  const threadIds = [...byThread.keys()];

  // 2. Contexte des fils : dernier message toutes directions confondues et
  //    dernière réponse sortante — pour ne garder que les fils qui se
  //    terminent par ce mail entrant, sans réponse de l'utilisateur depuis.
  const lastAny = new Map<number, { max: Date | null; count: number }>();
  const lastOut = new Map<number, Date | null>();
  for (const ids of chunk(threadIds, 500)) {
    const aggs = await db.message.groupBy({
      by: ['threadId'],
      // isAutoReply exclu : un répondeur automatique ne « termine » pas un fil.
      where: { threadId: { in: ids }, isDeleted: false, isAutoReply: false },
      _max: { date: true },
      _count: { _all: true },
    });
    for (const a of aggs) {
      if (a.threadId !== null) lastAny.set(a.threadId, { max: a._max.date, count: a._count._all });
    }
    const outs = await db.message.groupBy({
      by: ['threadId'],
      where: { threadId: { in: ids }, isDeleted: false, isOutbound: true },
      _max: { date: true },
    });
    for (const o of outs) {
      if (o.threadId !== null) lastOut.set(o.threadId, o._max.date);
    }
  }

  // 3. États utilisateur (reporté / ignoré) sur ces fils.
  const states = new Map<
    number,
    { messageId: number; state: string; snoozedUntil: Date | null }
  >();
  for (const ids of chunk(threadIds, 500)) {
    const rows = await db.attentionState.findMany({
      where: { accountSlug: account, kind: 'reply', threadId: { in: ids } },
    });
    for (const r of rows) {
      states.set(r.threadId, {
        messageId: r.messageId,
        state: r.state,
        snoozedUntil: r.snoozedUntil,
      });
    }
  }

  // 4. Construction des éléments.
  const items: ReplyItem[] = [];
  for (const [threadId, m] of byThread) {
    const any = lastAny.get(threadId);
    if (!any?.max || !m.date) continue;
    // Un message plus récent existe dans le fil → ce mail n'est pas « le
    // dernier mot » (déjà répondu, ou suivi d'un autre mail) : pas en attente.
    if (any.max.getTime() > m.date.getTime()) continue;
    const out = lastOut.get(threadId);
    if (out && out.getTime() >= m.date.getTime()) continue;

    let { category, why } = categorize(m);

    // B3 : destinataire principal ou simple copie ? Si le compte n'apparaît
    // pas dans les destinataires principaux (To), la réponse n'est
    // probablement pas attendue de TOI → seuil normal, raison explicite.
    let inCopy = false;
    if (m.toEmails && accountEmail) {
      try {
        const to = JSON.parse(m.toEmails) as unknown;
        inCopy = Array.isArray(to) && to.length > 0 && !to.includes(accountEmail);
      } catch {
        /* toEmails illisible : on considère destinataire principal */
      }
    }
    if (inCopy && category !== 'normal') {
      category = 'normal';
      why = `${why} — mais tu es en copie, seuil ramené à normal`;
    }

    // B3 : type de demande. Quand le verdict sémantique a tranché, c'est SA
    // raison qui s'affiche (elle dit d'où vient la décision) ; sinon les
    // motifs FR du sujet, comme avant.
    const evaluation = evaluations.get(threadId);
    const request: { kind: RequestKind; why: string } =
      evaluation?.source === 'verdict'
        ? { kind: 'reply_expected', why: evaluation.pourquoi }
        : detectRequestKind(m.subject);

    const thresholdHours = THRESHOLDS[category];
    const waitingHours = (now - m.date.getTime()) / 3_600_000;
    const overdue = waitingHours > thresholdHours;

    // État effectif : un état lié à un ancien message du fil est caduc.
    let state: ReplyState = 'active';
    let snoozedUntil: string | null = null;
    const st = states.get(threadId);
    if (st && st.messageId === m.id) {
      if (st.state === 'dismissed') state = 'dismissed';
      else if (st.state === 'snoozed' && st.snoozedUntil && st.snoozedUntil.getTime() > now) {
        state = 'snoozed';
        snoozedUntil = st.snoozedUntil.toISOString();
      }
    }

    const reasons = [
      `Dernier message du fil, reçu il y a ${humanDelay(waitingHours)}, aucune réponse envoyée depuis`,
      why,
    ];
    if (request.kind !== 'information') reasons.push(request.why);
    if (inCopy) reasons.push('tu es en copie (pas le destinataire principal)');
    if (!m.isSeen) reasons.push('jamais ouvert');
    reasons.push(
      overdue
        ? `seuil ${CATEGORY_LABELS[category].toLowerCase()} de ${humanDelay(thresholdHours)} dépassé`
        : `seuil de ${humanDelay(thresholdHours)} pas encore atteint`,
    );

    items.push({
      account,
      threadId,
      messageId: m.id,
      uid: m.uid,
      folder: m.folder.path,
      fromEmail: m.fromEmail as string,
      fromName: m.fromName,
      subject: m.subject ?? '(sans sujet)',
      date: m.date.toISOString(),
      isSeen: m.isSeen,
      threadMessageCount: any.count,
      category,
      categoryLabel: CATEGORY_LABELS[category],
      thresholdHours,
      waitingHours: Math.round(waitingHours * 10) / 10,
      overdue,
      requestKind: request.kind,
      requestKindLabel: REQUEST_KIND_LABELS[request.kind],
      inCopy,
      reason: reasons.join(' · '),
      preuve: evaluations.get(threadId)?.source === 'verdict' ? 'verdict' : 'structure',
      state,
      snoozedUntil,
    });
  }

  const counts = {
    active: items.filter((i) => i.state === 'active').length,
    overdue: items.filter((i) => i.state === 'active' && i.overdue).length,
    snoozed: items.filter((i) => i.state === 'snoozed').length,
    dismissed: items.filter((i) => i.state === 'dismissed').length,
  };

  let filtered = items;
  if (!opts.includeHidden) filtered = filtered.filter((i) => i.state === 'active');
  if (opts.scope === 'overdue') filtered = filtered.filter((i) => i.state !== 'active' || i.overdue);

  // En retard d'abord (les plus anciens en tête), puis les autres ; à état
  // égal, les mails où tu es en copie passent APRÈS (B3).
  filtered.sort((a, b) => {
    const aActive = a.state === 'active' ? 0 : 1;
    const bActive = b.state === 'active' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.inCopy !== b.inCopy) return a.inCopy ? 1 : -1;
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  return {
    account,
    sinceDays,
    counts,
    items: filtered.slice(0, limit),
    truncated: filtered.length > limit,
  };
}

/** Réponses en retard uniquement (raccourci SPEC : get_overdue_replies). */
export async function getOverdueReplies(
  account: string,
  opts: Omit<UnansweredOptions, 'scope'> = {},
): Promise<UnansweredResult> {
  return getUnansweredEmails(account, { ...opts, scope: 'overdue' });
}

// ---------------------------------------------------------------------------
// Snooze / dismiss / restore — état utilisateur d'un fil.
// ---------------------------------------------------------------------------

async function lastThreadMessage(account: string, threadId: number) {
  const thread = await db.thread.findFirst({
    where: { id: threadId, accountSlug: account },
    select: { id: true },
  });
  if (!thread) throw new Error(`Fil ${threadId} introuvable pour le compte « ${account} ».`);
  const last = await db.message.findFirst({
    where: { threadId, isDeleted: false },
    orderBy: { date: 'desc' },
    select: {
      id: true,
      uid: true,
      subject: true,
      date: true,
      folder: { select: { path: true } },
    },
  });
  if (!last) throw new Error(`Fil ${threadId} vide (aucun message indexé).`);
  return last;
}

export interface ReplyStateChange {
  account: string;
  threadId: number;
  subject: string;
  state: ReplyState;
  snoozedUntil: string | null;
}

/**
 * Reporte un fil : il disparaît de la liste jusqu'à la date donnée
 * (`days` jours, défaut 3, max 365), puis réapparaît tout seul.
 */
async function snoozeItem(
  account: string,
  threadId: number,
  kind: 'reply' | 'followup',
  toolName: string,
  days = 3,
): Promise<ReplyStateChange> {
  await ensureDbReady();
  const d = Math.min(Math.max(Math.round(days), 1), 365);
  const until = new Date(Date.now() + d * 86_400_000);
  const last = await lastThreadMessage(account, threadId);
  await db.attentionState.upsert({
    where: { accountSlug_threadId_kind: { accountSlug: account, threadId, kind } },
    create: {
      accountSlug: account,
      threadId,
      messageId: last.id,
      kind,
      state: 'snoozed',
      snoozedUntil: until,
    },
    update: { messageId: last.id, state: 'snoozed', snoozedUntil: until },
  });
  await recordOperation({
    account,
    tool: toolName,
    folder: last.folder.path,
    params: { threadId, days: d, until: until.toISOString() },
    affectedUids: [last.uid],
    items: [{ subject: last.subject ?? '(sans sujet)', date: last.date?.toISOString() ?? null }],
    result: `reporté ${d} jour(s)`,
  });
  return {
    account,
    threadId,
    subject: last.subject ?? '(sans sujet)',
    state: 'snoozed',
    snoozedUntil: until.toISOString(),
  };
}

export function snoozeReply(account: string, threadId: number, days = 3): Promise<ReplyStateChange> {
  return snoozeItem(account, threadId, 'reply', 'snooze_reply', days);
}

/** Reporte une relance : cachée jusqu'à la date donnée, puis elle revient. */
export function snoozeFollowup(
  account: string,
  threadId: number,
  days = 3,
): Promise<ReplyStateChange> {
  return snoozeItem(account, threadId, 'followup', 'snooze_followup', days);
}

/**
 * Ignore un fil : il ne sera plus proposé — sauf si un NOUVEAU mail arrive
 * dans le fil (l'état est lié au dernier message au moment du clic).
 */
async function dismissItem(
  account: string,
  threadId: number,
  kind: 'reply' | 'followup',
  toolName: string,
  resultLabel: string,
): Promise<ReplyStateChange> {
  await ensureDbReady();
  const last = await lastThreadMessage(account, threadId);
  await db.attentionState.upsert({
    where: { accountSlug_threadId_kind: { accountSlug: account, threadId, kind } },
    create: {
      accountSlug: account,
      threadId,
      messageId: last.id,
      kind,
      state: 'dismissed',
    },
    update: { messageId: last.id, state: 'dismissed', snoozedUntil: null },
  });
  await recordOperation({
    account,
    tool: toolName,
    folder: last.folder.path,
    params: { threadId },
    affectedUids: [last.uid],
    items: [{ subject: last.subject ?? '(sans sujet)', date: last.date?.toISOString() ?? null }],
    result: resultLabel,
  });
  return {
    account,
    threadId,
    subject: last.subject ?? '(sans sujet)',
    state: 'dismissed',
    snoozedUntil: null,
  };
}

export function dismissReply(account: string, threadId: number): Promise<ReplyStateChange> {
  return dismissItem(account, threadId, 'reply', 'dismiss_reply', 'ignoré');
}

/** Marque une relance comme traitée (relance envoyée, ou plus nécessaire). */
export function markFollowupDone(account: string, threadId: number): Promise<ReplyStateChange> {
  return dismissItem(account, threadId, 'followup', 'mark_followup_done', 'traité');
}

/** Annule un report/ignore : le fil redevient visible immédiatement. */
async function restoreItem(
  account: string,
  threadId: number,
  kind: 'reply' | 'followup',
  toolName: string,
): Promise<ReplyStateChange> {
  await ensureDbReady();
  const last = await lastThreadMessage(account, threadId);
  await db.attentionState.deleteMany({
    where: { accountSlug: account, threadId, kind },
  });
  await recordOperation({
    account,
    tool: toolName,
    folder: last.folder.path,
    params: { threadId },
    affectedUids: [last.uid],
    items: [{ subject: last.subject ?? '(sans sujet)', date: last.date?.toISOString() ?? null }],
    result: 'remis en liste',
  });
  return {
    account,
    threadId,
    subject: last.subject ?? '(sans sujet)',
    state: 'active',
    snoozedUntil: null,
  };
}

export function restoreReply(account: string, threadId: number): Promise<ReplyStateChange> {
  return restoreItem(account, threadId, 'reply', 'restore_reply');
}

/** Annule le report/traité d'une relance : elle redevient visible. */
export function restoreFollowup(account: string, threadId: number): Promise<ReplyStateChange> {
  return restoreItem(account, threadId, 'followup', 'restore_followup');
}
