import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { normaliserIdentifiant, rattacher } from './dossiers.js';

/**
 * RELIER UN MAIL À UN BIEN SANS QUE PERSONNE NE LE DISE (24/08).
 *
 * Le trou, constaté sur ses vraies boîtes : sa facture d'électricité la
 * bellenergie ne contient NULLE PART le mot « Miron », alors qu'elle concerne
 * le 33 rue François Miron. Le lien vit dans le PDF hébergé chez le
 * fournisseur, et dans sa tête. Chercher « facture électricité miron » ne
 * pouvait donc rien donner de juste — aucun moteur ne trouve ce qui n'est
 * écrit nulle part.
 *
 * CE QUE LA MESURE A MONTRÉ (trois fournisseurs lus dans ses boîtes) :
 *
 *   EDF            adresse du bien DANS LE MAIL   ·  n° client 6029414501
 *   la bellenergie pas d'adresse                  ·  PDL 07140955100609  ·  PDF téléchargeable
 *   Free Mobile    pas d'adresse                  ·  identifiant 56129155 ·  espace abonné
 *
 * Le point commun n'est pas le PDF — c'est l'IDENTIFIANT : tous en portent un.
 * Et chez EDF, l'adresse est à 712 caractères du début, donc DÉJÀ dans les
 * 2 200 conservés par `analysisInput` : elle est en base depuis toujours, on ne
 * la lisait simplement pas.
 *
 * D'où le mécanisme, en deux temps et sans la moindre requête sortante :
 *
 *  1. un mail qui donne À LA FOIS une adresse et un identifiant APPREND le lien
 *     (le dossier « 46 rue de la République » retient le n° client 6029414501) ;
 *  2. tout mail ultérieur portant CET identifiant rejoint le dossier, même s'il
 *     ne nomme aucune adresse.
 *
 * C'est `resoudre()` de dossiers.ts qui fait déjà ce travail : identifiant dur
 * d'abord, orthographe ensuite. Ici on ne fait que lui donner à manger ce que
 * l'IA ne lui donnait pas — car ceci tourne sur TOUS les mails, analysés ou non.
 */

/**
 * Les libellés qui qualifient une adresse de BIEN.
 *
 * EXIGER UN LIBELLÉ N'EST PAS UNE PRÉCAUTION EXCESSIVE, c'est la seule chose
 * qui rende la règle utilisable. Le pied de page de Free Mobile porte « Siège
 * social : 16, rue de la Ville l'Evêque 75008 Paris » : ramasser toute adresse
 * croisée créerait un dossier « bien » pour le siège de chaque expéditeur, et
 * il en reçoit des centaines. Mieux vaut manquer une adresse que d'en inventer
 * une — un dossier faux se remarque, un dossier manquant se rattrape.
 */
const LIBELLES_ADRESSE = [
  'adresse du logement', 'adresse du bien', 'adresse de fourniture',
  'adresse de consommation', 'adresse du point de livraison', 'lieu de consommation',
  'lieu de fourniture', 'adresse de l.installation', 'bien situe', 'bien situé',
  'logement situe', 'logement situé', 'immeuble situe', 'immeuble situé',
  'adresse du chantier', 'adresse des travaux', 'adresse de l.immeuble',
];

/** Types de voie reconnus dans une adresse. */
const VOIES =
  'rue|avenue|av|boulevard|bd|impasse|all[ée]e|place|chemin|route|quai|cours|square|villa|passage|residence|résidence|lotissement';

/**
 * Les libellés qui introduisent un IDENTIFIANT dur.
 *
 * Même exigence : jamais un nombre isolé. Un mail de facture est plein de
 * montants, de dates, de codes postaux et de numéros de téléphone — ramasser
 * « tout ce qui ressemble à un numéro » relierait n'importe quoi à n'importe
 * quoi, et le mécanisme du n° 2 ci-dessus propagerait l'erreur à tous les mails
 * qui partagent ce nombre.
 */
const LIBELLES_IDENTIFIANT = [
  'pdl', 'point de livraison', 'prm', 'numero de pdl', 'numéro de pdl',
  'numero client', 'numéro client', 'n° client', 'no client', 'num client',
  'reference client', 'référence client', 'ref client', 'réf client',
  'numero de contrat', 'numéro de contrat', 'n° de contrat', 'no de contrat',
  'numero de compte', 'numéro de compte', 'compte client', 'numero de sinistre',
  'numéro de sinistre', 'n° de sinistre', 'numero de police', 'numéro de police',
  'reference dossier', 'référence dossier', 'numero de dossier', 'numéro de dossier',
];

/** Échappe un libellé pour l'insérer dans une expression régulière. */
const echapper = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Alternative régulière tolérante aux accents et à la ponctuation du libellé. */
const alternative = (libelles: string[]): string =>
  libelles.map(echapper).join('|');

/** Une adresse retenue, avec le libellé qui l'a qualifiée. */
export interface AdresseTrouvee {
  /** L'adresse telle qu'écrite, nettoyée des espaces multiples. */
  adresse: string;
  /** Le libellé qui l'introduisait — c'est lui qui la rend digne de confiance. */
  libelle: string;
}

/**
 * Les adresses de BIEN citées dans un texte. Fonction pure — le banc l'éprouve
 * sur les vrais textes de ses fournisseurs.
 */
export function adressesDuTexte(texte: string): AdresseTrouvee[] {
  const t = String(texte ?? '').replace(/\s+/g, ' ');
  if (!t) return [];
  const out: AdresseTrouvee[] = [];
  const vus = new Set<string>();
  const motif = new RegExp(
    `(${alternative(LIBELLES_ADRESSE)})\\s*:?\\s*` +
      `([^:;|]{0,40}?\\d{1,4}\\s*(?:bis|ter)?\\s*,?\\s*(?:${VOIES})\\s+[^:;|]{3,60}?)` +
      `(?=\\s*(?:$|[.;|]|\\b(?:bonjour|madame|monsieur|merci|cordialement)\\b))`,
    'giu',
  );
  for (const m of t.matchAll(motif)) {
    const adresse = m[2].replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();
    // Une adresse doit garder une taille plausible : au-delà, on a mordu sur
    // la phrase suivante et le libellé du dossier deviendrait illisible.
    if (adresse.length < 8 || adresse.length > 90) continue;
    const cle = adresse.toLowerCase();
    if (vus.has(cle)) continue;
    vus.add(cle);
    out.push({ adresse, libelle: m[1].toLowerCase() });
  }
  return out;
}

/** Un identifiant dur retenu, avec le libellé qui l'introduisait. */
export interface IdentifiantTrouve {
  /** La valeur normalisée (majuscules, séparateurs retirés). */
  valeur: string;
  /** Le libellé qui l'introduisait. */
  libelle: string;
}

/**
 * Les identifiants durs cités dans un texte. Fonction pure.
 *
 * La valeur doit contenir AU MOINS UN CHIFFRE et aucun arobase : sans cela,
 * « Identifiant : SA****@HOTMAIL.COM » (vu chez EDF) passerait pour un numéro
 * de client, et tous les mails de cette boîte se retrouveraient reliés entre
 * eux par une adresse masquée.
 */
export function identifiantsDuTexte(texte: string): IdentifiantTrouve[] {
  const t = String(texte ?? '').replace(/\s+/g, ' ');
  if (!t) return [];
  const out: IdentifiantTrouve[] = [];
  const vus = new Set<string>();
  const motif = new RegExp(
    `\\b(${alternative(LIBELLES_IDENTIFIANT)})\\s*(?:n°|no|:|-)?\\s*:?\\s*([A-Z0-9][A-Z0-9./-]{4,29})\\b`,
    'giu',
  );
  for (const m of t.matchAll(motif)) {
    const brut = m[2];
    if (brut.includes('@') || brut.includes('*')) continue;
    if (!/\d/.test(brut)) continue;
    const valeur = normaliserIdentifiant(brut);
    if (!valeur || vus.has(valeur)) continue;
    vus.add(valeur);
    out.push({ valeur, libelle: m[1].toLowerCase() });
  }
  return out;
}

/** Ce qu'une passe de liaison a produit sur un mail. */
export interface BilanLiaison {
  /** Dossiers rattachés grâce à une adresse citée. */
  parAdresse: number;
  /** Dossiers rejoints grâce à un identifiant déjà connu. */
  parIdentifiant: number;
  /** Identifiants vus mais rattachés à aucun dossier connu — le vivier à combler. */
  identifiantsOrphelins: string[];
}

/**
 * Relie un mail aux biens dont il parle, à partir de son SEUL texte déjà
 * stocké. Aucune requête sortante, aucun appel à l'IA.
 *
 * Un identifiant SEUL ne crée JAMAIS de dossier : il ne sert qu'à rejoindre un
 * dossier qui le porte déjà. Créer « Réf. 6029414501 » ferait un dossier au nom
 * illisible, que rien ne relierait jamais au bien — et il en aurait un par
 * fournisseur.
 */
export async function rattacherDepuisTexte(messageId: number): Promise<BilanLiaison> {
  await ensureDbReady();
  const m = await db.message.findUnique({
    where: { id: messageId },
    select: { subject: true, snippet: true, analysisInput: true },
  });
  if (!m) return { parAdresse: 0, parIdentifiant: 0, identifiantsOrphelins: [] };
  return rattacherTexteConnu(
    messageId,
    [m.subject, m.analysisInput || m.snippet].filter(Boolean).join('\n'),
  );
}

/**
 * Même chose, quand le texte est DÉJÀ en main — c'est le cas du job des
 * extraits, qui vient de le télécharger. Les deux expressions régulières
 * tournent en mémoire et la base n'est touchée QUE si elles ont trouvé quelque
 * chose : sur l'immense majorité des mails, relier ne coûte donc rien.
 */
export async function rattacherTexteConnu(
  messageId: number,
  texte: string,
): Promise<BilanLiaison> {
  const bilan: BilanLiaison = { parAdresse: 0, parIdentifiant: 0, identifiantsOrphelins: [] };
  const adresses = adressesDuTexte(texte);
  const identifiants = identifiantsDuTexte(texte);
  if (!adresses.length && !identifiants.length) return bilan;
  await ensureDbReady();

  // 1. Une adresse APPREND le lien, et emporte avec elle les identifiants du
  //    même mail : c'est ce qui rend les mails suivants autonomes.
  for (const a of adresses) {
    for (const ident of identifiants.length ? identifiants : [null]) {
      const r = await rattacher({
        messageId,
        label: a.adresse,
        kind: 'bien',
        identifier: ident?.valeur ?? null,
        source: 'texte',
      });
      if (r) bilan.parAdresse++;
    }
  }

  // 2. Sans adresse, un identifiant DÉJÀ CONNU suffit à rejoindre le bien.
  if (!adresses.length) {
    for (const ident of identifiants) {
      const connu = await db.dossierIdentifier.findFirst({
        where: { value: ident.valeur },
        select: { dossierId: true },
      });
      if (!connu) {
        bilan.identifiantsOrphelins.push(ident.valeur);
        continue;
      }
      await db.dossierMessage.upsert({
        where: { dossierId_messageId: { dossierId: connu.dossierId, messageId } },
        create: { dossierId: connu.dossierId, messageId, source: 'texte' },
        update: {},
      });
      bilan.parIdentifiant++;
    }
  }

  if (bilan.parAdresse || bilan.parIdentifiant) {
    logger.info('mail relié à un bien par son texte', {
      messageId,
      parAdresse: bilan.parAdresse,
      parIdentifiant: bilan.parIdentifiant,
    });
  }
  return bilan;
}
