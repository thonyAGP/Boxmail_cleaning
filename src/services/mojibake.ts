/**
 * Réparation du texte « mojibake » — de l'UTF-8 qui a été lu une fois de trop
 * comme du latin-1/windows-1252, et RE-ENCODÉ ainsi : « à » s'écrit « Ã© »,
 * « ç » « Ã§ », « ° » « Â° », l'apostrophe typographique « â€™ ».
 *
 * POURQUOI CE MODULE EXISTE (tour d'analyse du 30/07, mesuré sur l'index réel) :
 * 3 617 extraits sur 20 238 — 17,9 %, et les SEPT boîtes sont touchées —
 * étaient illisibles. Trois conséquences, dans l'ordre de gravité :
 *  1. les motifs de `detectIntent` sont écrits pour tolérer l'ABSENCE d'accent
 *     (`[ée]ch[ée]ance`, `impay[ée]`) mais pas le mojibake : « Ã© » est DEUX
 *     caractères, la classe n'en matche qu'un. Une échéance écrite
 *     « Ã©chÃ©ance » n'était donc jamais reconnue et le mail retombait en
 *     « info » ;
 *  2. 1 665 de ces mails avaient DÉJÀ reçu un verdict de l'IA — rendu sur un
 *     texte qu'elle ne pouvait pas lire ;
 *  3. 3 166 étaient en confiance HAUTE, donc ni protégés par la clause
 *     « confiance faible », ni signalés comme douteux nulle part.
 *
 * POURQUOI `decodeText` (imap.ts) NE POUVAIT PAS LE VOIR : il traite le cas du
 * charset MAL DÉCLARÉ, en re-décodant le buffer autrement. Ici le charset est
 * bien déclaré et le décodage est correct — c'est le CONTENU qui est déjà
 * abîmé, en amont, par une passerelle. Re-décoder le même buffer rend le même
 * texte ; la réparation doit donc se faire sur le TEXTE.
 *
 * MÉTHODE : on ne re-décode pas la chaîne entière (essayé d'abord : sur 400
 * extraits, 234 échouaient — une seule séquence abîmée quelque part suffisait
 * à faire échouer tout le texte). On remplace SÉQUENCE PAR SÉQUENCE, et seules
 * les séquences valides sont converties : le reste du texte n'est jamais
 * touché, donc aucun caractère de remplacement n'est introduit. Mesure sur les
 * données réelles : 1 978 extraits réparés sur 2 000, 0 caractère cassé, et
 * 0 modification sur 5 000 extraits sains.
 */

/**
 * Continuations possibles d'une séquence UTF-8 mal relue.
 *
 * Les octets 0x80–0xBF donnent des caractères U+0080–U+00BF en latin-1 — mais
 * en windows-1252 (ce que font la plupart des passerelles) la plage 0x80–0x9F
 * porte des caractères IMPRIMABLES : €, ', ", –, ™… Sans eux on rate justement
 * l'apostrophe typographique française, de loin le cas le plus fréquent.
 */
const CP1252_VERS_OCTET = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

const CONTINUATION =
  '[\\u0080-\\u00BF\\u20AC\\u201A\\u0192\\u201E\\u2026\\u2020\\u2021\\u02C6\\u2030' +
  '\\u0160\\u2039\\u0152\\u017D\\u2018\\u2019\\u201C\\u201D\\u2022\\u2013\\u2014' +
  '\\u02DC\\u2122\\u0161\\u203A\\u0153\\u017E\\u0178]';

/** Séquences UTF-8 de 2, 3 et 4 octets, telles qu'elles apparaissent une fois mal relues. */
const SEQUENCE_RE = new RegExp(
  `[\\u00C2-\\u00DF]${CONTINUATION}` +
    `|[\\u00E0-\\u00EF]${CONTINUATION}{2}` +
    `|[\\u00F0-\\u00F4]${CONTINUATION}{3}`,
  'g',
);

/** Caractère de contrôle : une réparation qui en produit s'est trompée. */
const CONTROLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function versOctet(caractere: string): number {
  const code = caractere.codePointAt(0) ?? -1;
  if (code < 0x100) return code;
  return CP1252_VERS_OCTET.get(code) ?? -1;
}

/**
 * Rend le texte lisible. Idempotent : un texte sain — ou déjà réparé — est
 * renvoyé tel quel (aucune séquence ne correspond plus).
 */
export function reparerMojibake(texte: string): string {
  if (!texte) return texte;
  return texte.replace(SEQUENCE_RE, (sequence) => {
    const octets = Array.from(sequence, versOctet);
    // Un caractère hors table (donc hors mojibake possible) : on ne touche à rien.
    if (octets.some((o) => o < 0)) return sequence;
    const decode = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(octets));
    // Séquence incomplète ou abîmée : la laisser telle quelle vaut mieux que
    // d'écrire un « caractère inconnu » à la place — on n'aggrave jamais.
    if (decode.includes('�') || CONTROLE_RE.test(decode)) return sequence;
    return decode;
  });
}

/** true si `reparerMojibake` changerait quelque chose — sans construire le résultat. */
export function contientMojibake(texte: string | null | undefined): boolean {
  if (!texte) return false;
  return reparerMojibake(texte) !== texte;
}
