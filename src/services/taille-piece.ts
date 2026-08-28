/**
 * La taille RÉELLE d'une pièce jointe (28/08).
 *
 * DÉCLENCHEUR. Fiscal-Manager affiche désormais un temps écoulé et un temps
 * restant pendant l'import, calculés sur la taille des pièces à récupérer. Or
 * la taille que Boxmail annonçait était **~37 % trop grande** : une barre de
 * progression fausse d'un tiers, et un plafond `MAX_FILE_BYTES` qui rejetterait
 * un fichier de 7,3 Mo en croyant qu'il en fait 10.
 *
 * POURQUOI. `sizeBytes` vient du BODYSTRUCTURE IMAP, et la RFC 3501 est
 * explicite : c'est « the size of the body in octets », **telle que transmise**,
 * donc ENCODÉE. Une pièce binaire voyage en base64 : 3 octets deviennent
 * 4 caractères, plus un CRLF tous les 76 caractères — soit 78 octets transmis
 * pour 57 octets de fichier.
 *
 * MESURÉ, PAS DÉDUIT. Huit pièces réelles de la production, téléchargées et
 * comparées à ce que l'API annonçait (octets servis / octets annoncés) :
 *
 *     application/pdf   4 133 836 → 3 020 878   0,7308   « Facture août à novembre.pdf »
 *     image/jpeg        2 556 060 → 1 867 889   0,7308   « sosh 003.jpg »
 *     image/jpeg        2 125 506 → 1 553 251   0,7308   « 003.jpg »
 *     image/jpeg        1 351 708 →   987 784   0,7308   « ACIAJURIS MECHACHE 002.jpg »
 *     application/pdf     663 226 →   484 665   0,7308   « FACTURE LE BERRE.pdf »
 *     application/pdf     138 934 →   101 527   0,7308   « …SNCFCONNECT.pdf »
 *     application/pdf      49 154 →    35 919   0,7307   « Facture_FR77079426.pdf »
 *     application/pdf       3 378 →     2 466   0,7300   « Facture_35242857.pdf »
 *
 * Le même rapport de 3 Ko à 4 Mo, PDF comme JPEG : 57/78 = 0,73077. Le facteur
 * n'est pas une moyenne empirique, c'est l'arithmétique de base64.
 *
 * L'ENCODAGE EST CONNU, ET GRATUIT : il est dans le BODYSTRUCTURE que la sync
 * lit déjà (`encoding: "base64"` sur les pièces, `"quoted-printable"` sur les
 * parties texte). Aucun octet de plus sur le réseau. Il n'est simplement pas
 * conservé sur les candidats détectés AVANT ce jour — d'où le repli.
 *
 * LE REPLI ASSUMÉ. Sans encodage connu, on se fie au type : un PDF, une image,
 * un ZIP ne peuvent pas voyager en 7bit — MIME impose un encodage binaire, en
 * pratique base64. Une partie `text/*`, elle, peut être en 7bit comme en
 * quoted-printable : on ne devine pas, on rend la taille transmise.
 * `basis` dit toujours laquelle des trois situations s'applique : personne ne
 * doit prendre une estimation pour une mesure.
 */

/** 76 caractères de base64 + CRLF transportent 57 octets de fichier. */
const BASE64_UTILE = 57;
const BASE64_TRANSMIS = 78;

export type BaseTaille =
  /** Encodage connu et non transformant : la taille transmise EST la taille. */
  | 'exacte'
  /** Encodage base64 connu : arithmétique sûre à quelques octets près. */
  | 'estimee-base64'
  /** Encodage inconnu, type binaire : base64 supposé (voir en-tête du module). */
  | 'supposee-base64'
  /** Ni encodage ni certitude sur le type : on rend la taille transmise. */
  | 'transmise';

export interface TailleReelle {
  /** Meilleure estimation des octets du FICHIER, ceux qui seront téléchargés. */
  bytes: number;
  /** Ce que le BODYSTRUCTURE annonçait — les octets qui transitent en IMAP. */
  transferBytes: number;
  basis: BaseTaille;
}

/** Un type qui ne peut pas voyager en 7bit : MIME impose un encodage binaire. */
function estBinaire(contentType: string): boolean {
  const t = (contentType || '').toLowerCase();
  if (!t) return false;
  return !t.startsWith('text/') && !t.startsWith('message/');
}

export function tailleReelle(
  transferBytes: number,
  contentType: string,
  encoding?: string | null,
): TailleReelle {
  const brut = Math.max(0, Math.trunc(transferBytes || 0));
  const enc = (encoding || '').toLowerCase().trim();
  const enBase64 = () => Math.round((brut * BASE64_UTILE) / BASE64_TRANSMIS);

  if (enc === 'base64') return { bytes: enBase64(), transferBytes: brut, basis: 'estimee-base64' };
  if (enc === '7bit' || enc === '8bit' || enc === 'binary') {
    return { bytes: brut, transferBytes: brut, basis: 'exacte' };
  }
  // quoted-printable : le facteur dépend du contenu (de 1,01 pour du texte
  // français à 3 pour du binaire). On ne devine pas ce qu'on ne peut pas
  // calculer — c'est ce qui distingue une estimation d'une invention.
  if (enc === 'quoted-printable') return { bytes: brut, transferBytes: brut, basis: 'transmise' };
  if (!enc && estBinaire(contentType)) {
    return { bytes: enBase64(), transferBytes: brut, basis: 'supposee-base64' };
  }
  return { bytes: brut, transferBytes: brut, basis: 'transmise' };
}
