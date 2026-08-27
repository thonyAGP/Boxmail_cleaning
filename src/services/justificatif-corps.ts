/**
 * LE JUSTIFICATIF EST DANS LE CORPS — pas en pièce jointe (27/08).
 *
 * POURQUOI. Une catégorie entière de dépenses n'arrivait jamais à
 * Fiscal-Manager : les billets d'avion. Ces mails ne portent AUCUNE pièce
 * jointe, et la détection comptable les écartait structurellement
 * (`hasAttachments: true` avant toute analyse). Conséquence concrète, mesurée
 * par Anthony : ces frais sont systématiquement oubliés dans Jump et Expensya.
 * Le compteur `skippedNoAttachment` les comptait déjà — sans que personne ne le
 * lise.
 *
 * Le second verrou était sémantique : une confirmation de réservation est
 * analysée comme *confirmation* ou *voyage*, jamais comme *facture*. Attendre
 * que le verdict dise « invoice » revient à attendre pour toujours.
 *
 * D'OÙ CE MODULE, et sa règle de conduite : **mieux vaut manquer un cas que
 * noyer l'écran « Pièces reçues »**. Un justificatif porté par le corps n'est
 * reconnu que si TROIS choses sont réunies :
 *   1. un MONTANT PAYÉ explicite — pas un prix affiché, pas un total
 *      prévisionnel : une somme annoncée comme réglée ;
 *   2. un MARQUEUR de pièce — réservation confirmée, référence de dossier,
 *      billet, commande… ce qui distingue le justificatif de la publicité ;
 *   3. l'absence de tout marqueur de BRUIT (enregistrement, retard, wifi à
 *      bord, rappel de vol) — ces mails-là parlent du même voyage sans être
 *      la preuve d'un paiement.
 *
 * Fonctions PURES : aucun accès base ni IMAP, donc éprouvables au banc sur des
 * corps de mails écrits à la main.
 */

export interface JustificatifCorps {
  /** L'émetteur lu — transporteur ou marchand, jamais « l'expéditeur du mail ». */
  supplier: string;
  /** Montant réglé, en unités de la devise (euros décimaux). */
  amountTtc: number;
  devise: string;
  /** Référence de réservation / commande, quand elle est identifiable. */
  reference: string | null;
  /** Justifications en français, affichables telles quelles. */
  reasons: string[];
}

/** Ce qui annonce un paiement RÉALISÉ. « Prix » et « à partir de » sont exclus. */
const MOTS_PAIEMENT = [
  'montant payé', 'montant paye', 'total payé', 'total paye', 'total réglé',
  'total regle', 'payé avec', 'paye avec', 'réglé par', 'regle par',
  'montant total', 'total ttc', 'montant débité', 'montant debite', 'débité',
  'debite', 'prélevé', 'preleve', 'amount paid', 'total paid', 'paid with',
  'total charged', 'montant de la transaction', 'somme réglée', 'somme reglee',
  'vous avez payé', 'vous avez paye', 'total de votre commande',
];

/** Ce qui fait une PIÈCE : la trace d'une transaction, pas une offre. */
const MARQUEURS_PIECE = [
  'réservation confirmée', 'reservation confirmee', 'confirmation de réservation',
  'confirmation de reservation', 'votre réservation', 'votre reservation',
  'référence de réservation', 'reference de reservation', 'numéro de réservation',
  'numero de reservation', 'booking reference', 'booking confirmation',
  'votre commande', 'récapitulatif de commande', 'recapitulatif de commande',
  'confirmation de commande', 'votre billet', 'vos billets', 'e-ticket',
  'billet électronique', 'billet electronique', 'facture', 'reçu', 'recu',
  'justificatif', 'order confirmation', 'votre achat',
];

/**
 * LE BRUIT. Ces mails parlent du même voyage et portent parfois un montant —
 * ils ne sont pas la preuve d'un paiement. Critère d'acceptation explicite
 * d'Anthony : « les mails de bruit ne deviennent PAS candidats ».
 *
 * ⚠️ CES MARQUEURS SE JUGENT SUR LE SUJET, JAMAIS SUR LE CORPS. La première
 * version cherchait partout, et se serait sabordée dès le premier vrai billet :
 * une confirmation Volotea contient « Enregistrement en ligne à partir de 48 h
 * avant le départ », et beaucoup de confirmations glissent une « offre » en bas
 * de page. Ce dont parle un mail se lit dans son SUJET ; ce qu'il contient
 * n'est pas ce dont il parle.
 */
const MARQUEURS_BRUIT = [
  'enregistrement', 'check-in', 'checkin', 'embarquement', 'carte d’embarquement',
  "carte d'embarquement", 'boarding pass', 'votre vol approche', 'vol approche',
  'préparez votre', 'preparez votre', 'wifi', 'wi-fi', 'retard', 'annulation de vol',
  'perturbation', 'rappel', 'votre vol part', 'n’oubliez pas', "n'oubliez pas", 'newsletter',
  'offre', 'promotion', 'promo', 'à ne pas manquer', 'a ne pas manquer',
  'dernière minute', 'derniere minute', 'bons plans', 'inspirez-vous',
  'évaluez votre', 'evaluez votre', 'donnez votre avis', 'enquête de satisfaction',
  'enquete de satisfaction', 'modification de votre vol', 'horaire de votre vol',
];

/** Marques dont le nom de domaine ne dit pas le nom commercial. */
const NOMS_COMMERCIAUX: Record<string, string> = {
  airfrance: 'Air France', 'air-france': 'Air France', klm: 'KLM',
  volotea: 'Volotea', transavia: 'Transavia', easyjet: 'easyJet',
  ryanair: 'Ryanair', vueling: 'Vueling', lufthansa: 'Lufthansa',
  britishairways: 'British Airways', iberia: 'Iberia', sncf: 'SNCF',
  'oui.sncf': 'SNCF Connect', sncfconnect: 'SNCF Connect', trainline: 'Trainline',
  ouigo: 'OUIGO', flixbus: 'FlixBus', blablacar: 'BlaBlaCar',
  booking: 'Booking.com', airbnb: 'Airbnb', expedia: 'Expedia',
  hertz: 'Hertz', avis: 'Avis', europcar: 'Europcar', sixt: 'Sixt',
};

const sansAccents = (t: string): string =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const contient = (t: string, mots: string[]): string | null =>
  mots.find((m) => t.includes(sansAccents(m))) ?? null;

/**
 * Convertit une somme écrite à la française ou à l'anglaise.
 * « 1 234,56 » → 1234.56 · « 1,234.56 » → 1234.56 · « 441.78 » → 441.78
 *
 * Règle : quand les deux séparateurs sont présents, le DERNIER est le décimal.
 */
export function montantDepuis(brut: string): number | null {
  const t = brut.replace(/[\s  ]/g, '');
  const dernierPoint = t.lastIndexOf('.');
  const dernierVirgule = t.lastIndexOf(',');
  let normalise: string;
  if (dernierPoint >= 0 && dernierVirgule >= 0) {
    const decimal = dernierPoint > dernierVirgule ? '.' : ',';
    const millier = decimal === '.' ? ',' : '.';
    normalise = t.split(millier).join('').replace(decimal, '.');
  } else if (dernierVirgule >= 0) {
    // Virgule décimale seulement si elle est suivie de 1 ou 2 chiffres.
    normalise = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.split(',').join('');
  } else if (dernierPoint >= 0) {
    normalise = /\.\d{1,2}$/.test(t) ? t : t.split('.').join('');
  } else {
    normalise = t;
  }
  const v = Number.parseFloat(normalise);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

const RE_MONTANT =
  /(?:(€|EUR|USD|\$|GBP|£)\s*)?(\d{1,3}(?:[\s  .,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(€|EUR|USD|\$|GBP|£)?/gi;

const DEVISES: Record<string, string> = {
  '€': 'EUR', eur: 'EUR', $: 'USD', usd: 'USD', '£': 'GBP', gbp: 'GBP',
};

/**
 * Le montant PAYÉ, cherché ligne à ligne. Le mot de paiement doit être sur la
 * même ligne que la somme, ou sur la précédente — au-delà, le rapprochement
 * relève de la devinette (un prix d'appel trois paragraphes plus bas n'est pas
 * ce qui a été réglé).
 */
export function montantPaye(texte: string): { montant: number; devise: string; ligne: string } | null {
  const lignes = texte.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i];
    const zone = sansAccents(`${i > 0 ? lignes[i - 1] : ''} ${ligne}`);
    if (!contient(zone, MOTS_PAIEMENT)) continue;
    RE_MONTANT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_MONTANT.exec(ligne)) !== null) {
      const symbole = (m[1] || m[3] || '').toLowerCase();
      if (!symbole) continue; // une somme sans devise n'est pas un montant
      const valeur = montantDepuis(m[2]);
      if (valeur === null) continue;
      return { montant: valeur, devise: DEVISES[symbole] ?? 'EUR', ligne: ligne.trim() };
    }
  }
  return null;
}

/**
 * La référence de dossier. Cherchée d'abord après un mot qui l'annonce, puis
 * dans le sujet — les transporteurs l'y mettent presque toujours.
 * Un code de réservation mêle lettres ET chiffres : c'est ce qui le distingue
 * d'un mot ordinaire en capitales (« BONJOUR », « AGP-BES »).
 */
export function referenceDossier(texte: string, sujet: string): string | null {
  /**
   * ⚠️ TROIS PRÉCAUTIONS, toutes payées au banc :
   *  - le drapeau `i` porte sur les MOTS-CLÉS, pas sur le code : un code de
   *    réservation est en CAPITALES. Sans cette vérification, « Votre
   *    réservation est confirmée. / Dossier : XKPL42 » capturait « Dossie » —
   *    le mot-clé suivant — et la fonction rendait null ;
   *  - on parcourt TOUTES les occurrences, pas la première : le premier
   *    mot-clé du texte n'est presque jamais celui qui précède le code ;
   *  - lettres ET chiffres exigés, ce qui écarte « BONJOUR » comme « AGP-BES » ;
   *  - le code est sur la MÊME LIGNE que son intitulé. Laisser le motif
   *    franchir un saut de ligne lui faisait avaler le mot-clé suivant :
   *    « Votre réservation est confirmée. ⏎ Dossier : XKPL42 » capturait
   *    « Dossier », puis repartait APRÈS lui — le vrai code était perdu.
   */
  const apresMot =
    /(?:r[ée]f[ée]rence|r[ée]servation|reservation|booking|dossier|confirmation|commande|pnr)[^\n:]{0,24}[: \t][ \t]*([A-Za-z0-9]{5,10})\b/gi;
  const valide = (v: string) => v === v.toUpperCase() && /[A-Z]/.test(v) && /\d/.test(v);
  let m: RegExpExecArray | null;
  while ((m = apresMot.exec(texte)) !== null) {
    if (valide(m[1])) return m[1];
  }
  for (const jeton of (sujet || '').split(/[^A-Za-z0-9]+/)) {
    const v = jeton.toUpperCase();
    if (v.length >= 5 && v.length <= 10 && valide(v) && !/^\d+$/.test(v)) return v;
  }
  return null;
}

/** Le nom commercial de l'émetteur, lu sur le nom affiché ou le domaine. */
export function emetteur(fromName: string | null, fromEmail: string | null): string | null {
  const domaine = (fromEmail || '').split('@')[1]?.toLowerCase() ?? '';
  const etiquettes = domaine.split('.').filter((e) => e && !/^(com|fr|net|org|eu|co|uk|es|it|de|be|info|mail|email|e|news|no)$/.test(e));
  for (const e of [...etiquettes].reverse()) {
    if (NOMS_COMMERCIAUX[e]) return NOMS_COMMERCIAUX[e];
  }
  // Un nom affiché parlant prime sur le domaine — sauf s'il n'est qu'une adresse
  // ou une fonction de boîte aux lettres.
  const nom = (fromName || '').trim();
  const creux = /^(no.?reply|ne.?pas.?repondre|contact|info|service|clients?|support)/i;
  if (nom && !nom.includes('@') && !creux.test(nom) && nom.length <= 40) return nom;
  const principale = etiquettes[etiquettes.length - 1];
  if (!principale) return null;
  return principale.charAt(0).toUpperCase() + principale.slice(1);
}

/**
 * CE MAIL MÉRITE-T-IL QU'ON DESCENDE SON CORPS COMPLET ?
 *
 * ⚠️ LA QUESTION QUI A FAILLI TOUT FAIRE ÉCHOUER (27/08). Le premier
 * rattrapage sur `lb2i` a rendu **0 billet** — alors que le préfiltre voyait
 * bien les 94 mails candidats, dont les quatre réservations Volotea. Cause :
 * je jugeais sur `analysisInput`, un extrait SÉLECTIONNÉ de ~2 200 caractères
 * où les passages sautés sont remplacés par « […] ». Les 2 280 caractères
 * indexés de la confirmation Volotea ne contenaient AUCUNE ligne de paiement :
 * elle avait été coupée. Conclure « pas un justificatif » sur un texte tronqué,
 * c'est refaire le piège du § 53 — « un mail sans extrait est INVISIBLE, pas
 * en attente ».
 *
 * Donc : quand le texte indexé porte un marqueur de pièce et aucun bruit, mais
 * pas de montant, on ne conclut PAS — on descend le corps entier. Le coût
 * reste borné par la présélection SQL (94 mails sur douze mois pour cette
 * boîte), et il n'est payé qu'une fois : le verdict est ensuite mémorisé.
 */
export function meriteLectureComplete(input: {
  subject: string | null;
  texte: string;
}): boolean {
  const sujet = input.subject ?? '';
  const texte = input.texte ?? '';
  if (contient(sansAccents(sujet), MARQUEURS_BRUIT)) return false;
  if (!contient(sansAccents(`${sujet}\n${texte}`), MARQUEURS_PIECE)) return false;
  // Un montant déjà lisible ? Alors le texte indexé suffisait, et s'il n'a rien
  // donné c'est pour une autre raison — inutile de payer une descente IMAP.
  return montantPaye(texte) === null;
}

export function justificatifDansLeCorps(input: {
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  texte: string;
}): JustificatifCorps | null {
  const sujet = input.subject ?? '';
  const texte = input.texte ?? '';
  if (texte.trim().length < 40) return null;

  const plat = sansAccents(`${sujet}\n${texte}`);

  // 3. Le bruit d'abord : un seul marqueur suffit à écarter — mais lu sur le
  //    SUJET seul (voir MARQUEURS_BRUIT : le corps d'un vrai billet parle lui
  //    aussi d'enregistrement et d'offres).
  const bruit = contient(sansAccents(sujet), MARQUEURS_BRUIT);
  if (bruit) return null;

  // 2. Un marqueur de pièce.
  const marqueur = contient(plat, MARQUEURS_PIECE);
  if (!marqueur) return null;

  // 1. Un montant annoncé comme payé.
  const paye = montantPaye(texte);
  if (!paye) return null;

  const supplier = emetteur(input.fromName, input.fromEmail);
  if (!supplier) return null;

  const reference = referenceDossier(texte, sujet);
  const reasons = [
    `justificatif porté par le CORPS du mail : aucune pièce jointe, le message lui-même est la preuve`,
    `montant payé lu dans le texte — « ${paye.ligne.slice(0, 110)} »`,
    `pièce reconnue par « ${marqueur} »`,
    `émetteur « ${supplier} » lu sur ${input.fromEmail ?? "l'expéditeur"}`,
  ];
  if (reference) reasons.push(`référence « ${reference} »`);

  return { supplier, amountTtc: paye.montant, devise: paye.devise, reference, reasons };
}

/**
 * Le nom de fichier de la pièce synthétique. STABLE et déterministe : c'est
 * une composante de l'identité côté Fiscal-Manager, qui porte une contrainte
 * unique `(sourceSystem, sourceCandidateId, sourceAttachmentId)` — un nom qui
 * bougerait d'un passage à l'autre fabriquerait un doublon.
 */
export function nomDeFichier(j: JustificatifCorps, messageId: number): string {
  const propre = (t: string) =>
    t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '').slice(0, 40);
  const marque = propre(j.supplier) || 'Justificatif';
  const ref = j.reference ? propre(j.reference) : `mail${messageId}`;
  return `${marque}_${ref}.pdf`;
}
