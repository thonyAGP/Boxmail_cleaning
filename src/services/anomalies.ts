import { db, ensureDbReady } from '../db/client.js';
import { deplie } from './accents.js';

/**
 * LE DÉTECTEUR DE FUMÉE (26/08) — moteur A.
 *
 * POURQUOI MÉCANIQUE, ET POURQUOI EN PREMIER (contre-revue aveugle du 26/08) :
 * « Tu as déjà un excellent détecteur de fumée. Il serait dommage de demander au
 * LLM de reconnaître chaque incendie avant d'autoriser l'alarme. »
 *
 * L'argument est chiffré. L'analyse sémantique a extrait 5 822 actions dont
 * l'acteur est l'utilisateur, et SEULEMENT 82 dont l'acteur est son
 * correspondant : le contrat d'extraction demande « qui doit agir » pour
 * ÉCARTER ce qui ne le concerne pas, jamais pour SUIVRE ce qu'on lui promet.
 * Bâtir le suivi sur les seules obligations extraites reviendrait donc à bâtir
 * sur du vide — et laisserait aveugles les 53 % de mails que l'IA n'a pas
 * encore lus.
 *
 * Ce moteur travaille donc sur TOUT, y compris là où aucun verdict n'existe.
 * Il ne comprend rien ; il repère des formes. Le sens viendra après, et
 * seulement sur ce qu'il aura signalé (moteur B).
 *
 * COROLLAIRE UTILE : il devient un contrôle qualité de l'extraction. Un fil
 * très anormal SANS obligation extraite signale que l'analyse a raté quelque
 * chose.
 */

/** Un signal, son poids, et la phrase qui l'explique à l'utilisateur. */
export interface Signal {
  code: string;
  poids: number;
  phrase: string;
}

export interface Anomalie {
  threadId: number;
  accountSlug: string;
  correspondant: string;
  correspondantNom: string | null;
  sujet: string;
  score: number;
  signaux: Signal[];
  /** Dernier message du fil, toutes directions. */
  dernierAt: Date;
  premierAt: Date;
  /** Messages reçus depuis la dernière fois qu'il a écrit (0 = il a le dernier mot). */
  entrantsDepuisReponse: number;
  aDejaRepondu: boolean;
  montantMax: number | null;
  echeanceDepassee: Date | null;
  /** Ce que le type d'affaire fait de l'âge (cf. ageMultiplicateur). */
  nature: Nature;
  /** Le fil porte-t-il au moins une obligation extraite ? (contrôle qualité) */
  aObligation: boolean;
  /** Sens de l'argent : ce que je dois, ce qu'on me doit, ou indéterminé. */
  direction: Direction;
  /** Correspondants distincts — au-delà de 3, le « fil » n'est pas une histoire. */
  correspondants: number;
}

/**
 * La NATURE décide de ce que le temps fait à l'importance (contre-revue) :
 * « Un paiement de 2 478 € sans prestation depuis quatorze mois doit monter
 * avec l'âge. Une demande de devis sans réponse depuis 2016 doit tomber
 * quasiment à zéro. » L'âge n'est donc PAS un malus uniforme — c'était le
 * défaut mesuré de la première version, qui remontait des fils de 2015.
 */
export type Nature = 'dette' | 'reglementaire' | 'ponctuel' | 'inconnu';

const RE_DETTE =
  /(factur|impay|recouvr|relance|honorair|acompte|solde|virement|r[eè]glement|pr[eé]l[eè]vement|d[eé]bit|cr[eé]ance|remboursement|indemnisation|sinistre|litige|contentieux|huissier|mise en demeure|adjudication|greffe|formalit|notaire|avocat)/i;
const RE_REGLEMENTAIRE =
  /(urssaf|imp[oô]t|dgfip|fisc|tva|cotisation|d[eé]claration|attestation|assurance|contr[oô]le|conformit|kbis|statut|assembl[eé]e g[eé]n[eé]rale|proc[eè]s-verbal)/i;
const RE_PONCTUEL =
  /(invitation|disponibilit|rendez-vous|devis|proposition commerciale|newsletter|webinar|sondage|enqu[eê]te|avis|parrainage|promo)/i;

export function natureDuSujet(texte: string): Nature {
  const t = texte || '';
  // L'ordre compte : « relance de devis » est une dette, pas un ponctuel.
  if (RE_DETTE.test(t)) return 'dette';
  if (RE_REGLEMENTAIRE.test(t)) return 'reglementaire';
  if (RE_PONCTUEL.test(t)) return 'ponctuel';
  return 'inconnu';
}

/**
 * Multiplicateur d'âge, non monotone. Rend un facteur appliqué au score.
 * Une dette de 14 mois pèse PLUS qu'une dette d'un mois ; une invitation de
 * 2016 ne pèse plus rien.
 */
export function ageMultiplicateur(nature: Nature, jours: number): number {
  const ans = jours / 365;
  switch (nature) {
    case 'dette':
      // Monte jusqu'à ~2 ans (le temps rend l'anomalie plus criante), puis
      // redescend doucement : au-delà de 5 ans, la prescription et l'oubli
      // font leur œuvre.
      if (jours < 30) return 0.7;
      if (ans <= 2) return 1 + Math.min(jours, 730) / 730;
      return Math.max(0.5, 2 - (ans - 2) * 0.35);
    case 'reglementaire':
      if (jours < 30) return 0.8;
      return ans <= 3 ? 1.3 : Math.max(0.4, 1.3 - (ans - 3) * 0.25);
    case 'ponctuel':
      // Un rendez-vous manqué en 2016 n'intéresse plus personne.
      if (jours < 30) return 1;
      if (ans <= 1) return 0.5;
      return 0.05;
    default:
      if (jours < 30) return 1;
      return ans <= 2 ? 0.8 : Math.max(0.15, 0.8 - (ans - 2) * 0.2);
  }
}

/**
 * Adresses dont le NOM dit qu'on n'y répond pas. MALUS, JAMAIS EXCLUSION
 * (contre-revue) : « une administration peut parfaitement envoyer une demande
 * actionnable depuis une adresse ne-pas-repondre ». Mesuré : la DGFiP écrit
 * bien depuis `ne-pas-repondre@dgfip.finances.gouv.fr`.
 */
const RE_SANS_REPONSE =
  /(^|[._-])(no[._-]?reply|noreply|ne[-_.]?pas[-_.]?repondre|nepasrepondre|donotreply|do[-_.]?not[-_.]?reply|automated|notifications?|newsletter|mailer|no[-_.]?responder)([._-]|@)/i;

export function adresseSansReponse(email: string): boolean {
  return RE_SANS_REPONSE.test(email || '');
}

/**
 * L'ESCALADE EST ORIENTÉE (26/08, défaut n° 4 relevé par l'audit).
 *
 * « relance » n'est pas `escalation = true`. Il faut savoir QUI relance QUI :
 * l'assureur protection juridique écrit « INFO RELANCE TIERS » pour dire qu'il
 * a relancé LA PARTIE ADVERSE. C'est une bonne nouvelle — la preuve qu'il agit
 * sur le dossier — et mon détecteur la comptait comme une menace.
 *
 * Ces motifs disent que le mot « relance » vise quelqu'un d'AUTRE que
 * l'utilisateur : dans ce cas, l'escalade retombe à zéro.
 */
const RE_RELANCE_TIERS =
  /(relance tiers|info relance|nous avons relanc|avons relanc[eé] (?:le |la |les |votre |l.)?(?:tiers|adverse|partie|compagnie|assureur|d[eé]biteur)|relance de notre part aupr[eè]s|relanc[eé] pour vous)/i;

/** Niveau d'escalade lexicale, 0 (rien) à 5 (mise en demeure). */
export function niveauEscalade(texte: string): number {
  const t = (texte || '').toLowerCase();
  // Le veto d'orientation passe AVANT tout : un mot fort dans une phrase qui
  // désigne un tiers ne dit rien sur l'utilisateur.
  if (RE_RELANCE_TIERS.test(t)) return 0;
  if (/mise en demeure|contentieux|huissier|injonction/.test(t)) return 5;
  if (/derni[eè]re relance|dernier rappel|dernier avertissement|impay/.test(t)) return 4;
  if (/relance|rappel|toujours pas|sans r[eé]ponse|reste dans l.attente/.test(t)) return 3;
  if (/urgent|au plus vite|imp[eé]ratif|avant le/.test(t)) return 2;
  return 0;
}

/**
 * LES ENTITÉS DE L'UTILISATEUR — pour donner un SENS aux montants (défaut n° 1).
 *
 * « Jamais amount = 13200, mais amount + payeur + bénéficiaire + nature, puis
 * direction = receivable ou payable. »
 *
 * Mesuré : les fils Cogidata faisaient remonter 10 890 €, 13 200 € et 14 520 €
 * comme des dettes à payer — ce sont ses RECETTES de conseil, facturées par
 * LB2I. Même défaut que Club Med sur l'écran argent (222 950 € affichés à
 * l'envers). Un montant dont le sens est incertain ne doit PAS peser comme une
 * dette.
 *
 * La liste se dérive des comptes enrôlés : ce sont ses sociétés.
 */
let _mesEntites: string[] | null = null;

export async function mesEntites(): Promise<string[]> {
  if (_mesEntites) return _mesEntites;
  await ensureDbReady();
  const comptes = await db.account.findMany({ select: { slug: true, emailAddress: true } });
  const mots = new Set<string>();
  for (const c of comptes) {
    // ⚠️ Le slug reste ENTIER. Le découper donnait « au » (Au-marais),
    // « location » (Location_Brest), « techni » (techni-soft) — des fragments
    // qui reconnaissent « Renault » ou « location saisonnière » comme étant
    // ses propres sociétés, et retournent donc le sens de toutes ses dettes.
    const s = c.slug.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (s.length >= 5) mots.add(s);
    const dom = (c.emailAddress ?? '').split('@')[1]?.split('.')[0]?.toLowerCase();
    // On écarte les domaines grand public : « hotmail » n'est pas une société.
    if (dom && dom.length >= 4 && !/hotmail|gmail|outlook|yahoo|free|orange|wanadoo|laposte/.test(dom)) {
      mots.add(dom);
    }
  }
  _mesEntites = [...mots];
  return _mesEntites;
}

export type Direction = 'du-par-moi' | 'du-a-moi' | 'incertain';

/**
 * Qui doit l'argent ? On ne le devine pas : on lit l'ÉMETTEUR du document.
 * Une facture émise par une de ses sociétés est une créance en sa faveur.
 */
export function directionDuMontant(emetteur: string | null, siennes: string[]): Direction {
  if (!emetteur) return 'incertain';
  // Séparateurs normalisés des deux côtés : « LOCATION-BREST » doit
  // rencontrer le slug « location brest ».
  const e = deplie(emetteur).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (siennes.some((m) => e.includes(m))) return 'du-a-moi';
  return 'du-par-moi';
}

const MOT_ESCALADE: Record<number, string> = {
  5: 'mise en demeure',
  4: 'dernière relance ou impayé',
  3: 'relance',
  2: 'marqué urgent',
};

interface Brut {
  threadId: number;
  accountSlug: string;
  email: string;
  nom: string | null;
  sujet: string;
  n: number;
  mesMsg: number;
  premier: number;
  dernier: number;
  dernierEntrant: number;
  derniereSortie: number | null;
  news: number;
  escaladeSujet: number;
  actMoi: number;
  actEux: number;
  montant: string | null;
  echeance: number | null;
  repondus: number;
  totalFils: number;
  aVerdict: number;
  correspondants: number;
  emetteur: string | null;
}

/**
 * Une seule requête, agrégée par fil. Pas de sous-requête corrélée (mesuré à
 * 132 s le 19/08 sur un LIKE) : uniquement des CTE jointes.
 */
const SQL = `
WITH fil AS (
  SELECT m.threadId,
         MIN(m.accountSlug) accountSlug,
         COUNT(*) n,
         SUM(CASE WHEN m.isOutbound = 1 THEN 1 ELSE 0 END) mesMsg,
         MIN(m.date) premier,
         MAX(m.date) dernier,
         MAX(CASE WHEN m.isOutbound = 0 THEN m.date END) dernierEntrant,
         MAX(CASE WHEN m.isOutbound = 1 THEN m.date END) derniereSortie
    FROM Message m JOIN Folder f ON f.id = m.folderId
   WHERE m.isDeleted = 0 AND m.threadId IS NOT NULL
     AND f.role NOT IN ('trash', 'spam', 'drafts')
   GROUP BY m.threadId
  HAVING COUNT(*) >= 2
),
entrant AS (
  SELECT m.threadId,
         LOWER(MIN(m.fromEmail)) email,
         MIN(m.fromName) nom,
         MAX(m.hasListUnsubscribe) news,
         GROUP_CONCAT(SUBSTR(COALESCE(m.subject, ''), 1, 90), ' ~ ') sujets,
         MAX(COALESCE(m.subject, '')) sujet,
         MAX(CASE WHEN v.id IS NOT NULL THEN 1 ELSE 0 END) aVerdict,
         -- Combien de correspondants DISTINCTS écrivent dans ce « fil » ?
         -- C'est ce qui démasque les fils fabriqués par le repli sur le sujet
         -- (cf. defaut n° 3) : un vrai échange en a un ou deux.
         COUNT(DISTINCT LOWER(m.fromEmail)) correspondants
    FROM Message m
    LEFT JOIN MailVerdict v ON v.messageId = m.id
   WHERE m.isOutbound = 0 AND m.threadId IN (SELECT threadId FROM fil)
   GROUP BY m.threadId
),
-- L'ÉMETTEUR du document chiffré : c'est lui qui dit dans quel sens va
-- l'argent. Jamais l'expéditeur du mail (une facture peut être transférée).
doc AS (
  SELECT m.threadId, MIN(d.issuer) emetteur
    FROM VerdictDocument d JOIN Message m ON m.id = d.messageId
   WHERE m.threadId IS NOT NULL AND d.amount IS NOT NULL AND d.issuer IS NOT NULL
   GROUP BY m.threadId
),
acte AS (
  SELECT m.threadId,
         SUM(CASE WHEN a.actor = 'user' THEN 1 ELSE 0 END) actMoi,
         SUM(CASE WHEN a.actor IN ('sender', 'third_party') THEN 1 ELSE 0 END) actEux,
         CAST(MAX(COALESCE(a.amount, 0)) AS TEXT) montant,
         MAX(CASE WHEN a.dueAt < ?1 THEN a.dueAt END) echeance
    FROM VerdictAction a JOIN Message m ON m.id = a.messageId
   WHERE m.threadId IS NOT NULL
   GROUP BY m.threadId
),
histo AS (
  SELECT s.email,
         SUM(CASE WHEN t.mes > 0 THEN 1 ELSE 0 END) repondus,
         COUNT(*) totalFils
    FROM (SELECT threadId, LOWER(fromEmail) email FROM Message
           WHERE isOutbound = 0 AND threadId IS NOT NULL GROUP BY threadId) s
    JOIN (SELECT threadId, SUM(CASE WHEN isOutbound = 1 THEN 1 ELSE 0 END) mes
            FROM Message WHERE threadId IS NOT NULL GROUP BY threadId) t
      ON t.threadId = s.threadId
   GROUP BY s.email
)
SELECT f.threadId, f.accountSlug, e.email, e.nom, e.sujet, e.sujets,
       e.correspondants,
       f.n, f.mesMsg, f.premier, f.dernier, f.dernierEntrant, f.derniereSortie,
       e.news, e.aVerdict, d.emetteur,
       COALESCE(a.actMoi, 0) actMoi, COALESCE(a.actEux, 0) actEux,
       COALESCE(a.montant, '0') montant, a.echeance,
       COALESCE(h.repondus, 0) repondus, COALESCE(h.totalFils, 0) totalFils
  FROM fil f
  JOIN entrant e ON e.threadId = f.threadId
  LEFT JOIN acte a ON a.threadId = f.threadId
  LEFT JOIN doc d ON d.threadId = f.threadId
  LEFT JOIN histo h ON h.email = e.email`;

export interface OptionsDetection {
  /** Score minimal retenu (défaut 50). */
  seuil?: number;
  /** Ne garder que les fils touchés depuis N jours (défaut : aucune limite). */
  depuisJours?: number | null;
  limite?: number;
}

export async function detecterAnomalies(opts: OptionsDetection = {}): Promise<Anomalie[]> {
  await ensureDbReady();
  const seuil = opts.seuil ?? 50;
  const maintenant = Date.now();
  const siennes = await mesEntites();

  const brut = await db.$queryRawUnsafe<(Brut & { sujets: string })[]>(SQL, maintenant);
  const out: Anomalie[] = [];

  for (const r of brut) {
    const n = Number(r.n);
    const mesMsg = Number(r.mesMsg);
    const dernier = Number(r.dernier);
    const premier = Number(r.premier);
    const dernierEntrant = Number(r.dernierEntrant || dernier);
    const derniereSortie = r.derniereSortie ? Number(r.derniereSortie) : null;

    if (opts.depuisJours && maintenant - dernier > opts.depuisJours * 86_400_000) continue;

    // Combien de messages reçus depuis la dernière fois qu'il a écrit ?
    // C'est le vrai « 3e rappel » : pas le volume du fil, mais l'insistance
    // restée sans retour.
    const entrantsDepuisReponse =
      derniereSortie === null ? n - mesMsg : dernierEntrant > derniereSortie ? 1 : 0;

    const signaux: Signal[] = [];
    let score = 0;
    const add = (code: string, poids: number, phrase: string) => {
      score += poids;
      signaux.push({ code, poids, phrase });
    };

    const jours = Math.round((maintenant - dernier) / 86_400_000);
    const joursDepuisPremier = Math.round((maintenant - premier) / 86_400_000);
    const escalade = Math.max(niveauEscalade(r.sujets || ''), niveauEscalade(r.sujet || ''));
    const nature = natureDuSujet(`${r.sujet || ''} ${r.sujets || ''}`);
    const montant = Number.parseFloat(r.montant || '0') || 0;
    const actMoi = Number(r.actMoi);
    const actEux = Number(r.actEux);
    const totalFils = Number(r.totalFils);
    const repondus = Number(r.repondus);
    const taux = totalFils ? repondus / totalFils : 0;

    // --- ce qui fait qu'une histoire mérite un regard ---
    if (actMoi > 0) add('action-moi', 40, 'une action est attendue de toi');
    if (actEux > 0) add('action-eux', 25, "ils se sont engagés à quelque chose");
    if (r.echeance) {
      const j = Math.round((maintenant - Number(r.echeance)) / 86_400_000);
      add('echeance', 30, `échéance dépassée depuis ${j} jour${j > 1 ? 's' : ''}`);
    }

    // LE MONTANT NE PÈSE QUE S'IL VA DANS LE BON SENS (défaut n° 1). Une
    // facture émise par une de ses sociétés est une recette, pas une dette :
    // la compter comme « je dois agir » a fait remonter 13 200 € de revenus
    // de conseil en tête des anomalies.
    const direction = directionDuMontant(r.emetteur, siennes);
    if (montant > 0) {
      if (direction === 'du-par-moi') add('montant', 20, `${montant.toFixed(2)} € en jeu`);
      else if (direction === 'du-a-moi') {
        add('montant-recette', 5, `${montant.toFixed(2)} € — facture que TU as émise`);
      } else add('montant-incertain', 8, `${montant.toFixed(2)} € (sens incertain)`);
    }

    // LE FIL EST-IL UNE VRAIE HISTOIRE ? (défaut n° 3) Le threading se rabat
    // sur le sujet normalisé quand l'en-tête RFC manque : un « fil » nommé
    // « facture » a ainsi rassemblé 4 artisans sur 11 ans. Les obligations y
    // sont réelles, mais l'histoire est fausse — et une relance écrite sur
    // cette base viserait le mauvais interlocuteur.
    const correspondants = Number(r.correspondants ?? 1);
    if (correspondants >= 4) {
      add('fil-douteux', -35, `${correspondants} correspondants différents — ce n'est pas une seule histoire`);
    } else if (correspondants === 3) {
      add('fil-douteux', -12, '3 correspondants différents dans ce fil');
    }
    if (escalade >= 3) add('escalade', 25, `le ton monte : ${MOT_ESCALADE[escalade]}`);
    else if (escalade === 2) add('escalade', 10, MOT_ESCALADE[2]);

    if (mesMsg === 0 && n >= 3) {
      add('jamais-repondu', 20, `${n} messages reçus, aucune réponse de ta part`);
    } else if (entrantsDepuisReponse >= 2) {
      add('relances', 20, `${entrantsDepuisReponse} messages depuis ta dernière réponse`);
    }

    // Le taux de réponse historique : bon signal NÉGATIF, mauvais signal
    // positif (mesuré le 26/08 — il laissait passer no.reply@leboncoin.fr).
    // On ne s'en sert donc que pour CONFIRMER qu'il s'agit d'un interlocuteur
    // avec qui il dialogue réellement.
    if (taux >= 0.2) add('interlocuteur', 25, `tu réponds habituellement à ce correspondant (${Math.round(taux * 100)} %)`);
    else if (taux >= 0.05) add('interlocuteur', 8, `échanges occasionnels (${Math.round(taux * 100)} %)`);

    // --- ce qui doit faire douter (malus, jamais exclusion) ---
    if (adresseSansReponse(r.email || '')) {
      add('sans-reponse', -60, "adresse à laquelle on ne peut pas répondre");
    }
    if (Number(r.news) === 1) add('diffusion', -40, 'diffusion de masse (désabonnement possible)');
    if (r.email && !r.email.includes('@')) add('sans-adresse', -30, 'expéditeur non identifiable');

    /**
     * L'ASYMÉTRIE DU SILENCE (mesurée le 26/08 — voir obligations.ts).
     *
     * Première version : le top 22 était intégralement composé de factures de
     * chantier de 2022-2023 présentées comme des anomalies. Elles sont
     * réglées : un maçon ne se tait pas deux ans sur une facture ouverte.
     *
     * Le temps n'accuse donc que lorsque C'EST EUX qui doivent quelque chose,
     * ou que le ton monte. Quand c'est MOI qui dois et que plus personne ne
     * relance depuis des mois, le silence disculpe au lieu d'accuser.
     */
    // ⚠️ SPÉCIALISATION (défaut n° 2) : le silence ne disculpe que sur une
    // DEMANDE D'ARGENT. Un créancier impayé relance ; le demandeur d'une
    // signature classe et attend. Sans cette restriction, la convention
    // d'honoraires jamais signée depuis 19 mois passait pour réglée.
    const detteMonetaire =
      nature === 'dette' && (montant > 0 || !!r.echeance) && direction !== 'du-a-moi';
    const eventuelleDette = actMoi > 0 && actEux === 0 && escalade < 3 && detteMonetaire;
    const silenceDisculpe = eventuelleDette && jours > 180;
    const mult = silenceDisculpe
      ? Math.max(0.25, 1 - jours / 1095)
      : ageMultiplicateur(nature, jours);
    score = Math.round(score * mult);
    if (silenceDisculpe) {
      signaux.push({
        code: 'silence-disculpe',
        poids: 0,
        phrase: `personne ne relance depuis ${Math.round(jours / 30)} mois — probablement réglé`,
      });
    } else if (mult >= 1.3) {
      signaux.push({ code: 'age', poids: 0, phrase: `sans mouvement depuis ${Math.round(jours / 30)} mois` });
    }

    if (score < seuil) continue;

    out.push({
      threadId: Number(r.threadId),
      accountSlug: r.accountSlug,
      correspondant: r.email || '',
      correspondantNom: r.nom,
      sujet: r.sujet || '(sans sujet)',
      score,
      signaux,
      dernierAt: new Date(dernier),
      premierAt: new Date(premier),
      entrantsDepuisReponse,
      aDejaRepondu: mesMsg > 0,
      montantMax: montant || null,
      echeanceDepassee: r.echeance ? new Date(Number(r.echeance)) : null,
      nature,
      aObligation: actMoi + actEux > 0,
      direction,
      correspondants,
    });
    void joursDepuisPremier;
  }

  out.sort((a, b) => b.score - a.score);
  return opts.limite ? out.slice(0, opts.limite) : out;
}

/** La phrase unique qui justifie l'alerte — « la possibilité d'expliquer
 *  pourquoi est presque aussi importante que la détection ». */
export function phraseDe(a: Anomalie): string {
  const forts = a.signaux.filter((s) => s.poids > 0).sort((x, y) => y.poids - x.poids);
  const qui = a.correspondantNom || a.correspondant;
  return `${qui} — ${forts.slice(0, 3).map((s) => s.phrase).join(', ')}.`;
}
