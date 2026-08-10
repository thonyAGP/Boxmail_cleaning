/**
 * Lecture du CONTENU des pièces jointes (10/08).
 *
 * POURQUOI : un mail de la mère de l'utilisateur portant le SCAN d'une facture
 * Sosh avait été classé « payer ma mère ». L'analyse ne regardait que
 * l'expéditeur et le sujet : elle ne pouvait pas voir que le vrai fournisseur
 * est Sosh, que c'est une facture d'accès internet, ni son montant. Tant qu'on
 * ne lit pas la pièce, ce genre d'erreur est structurel.
 *
 * CHOIX : extraction de texte MAISON, zéro dépendance (zlib est natif) — le
 * serveur est un petit VPS et on ne veut ni pdfjs ni OCR dessus. On couvre les
 * PDF « natifs » (Sosh, OVH, EDF, opérateurs…), qui sont l'immense majorité.
 * Un PDF SCANNÉ ne contient aucun texte : on ne bricole pas, on le DIT
 * (`kind: 'scan'`) et c'est Claude — qui sait lire une image — qui la regarde
 * via le connecteur MCP. Même règle que pour le reste : l'intelligence coûteuse
 * passe par le forfait de l'utilisateur, jamais par une clé API serveur.
 */

import { inflateSync, inflateRawSync } from 'node:zlib';

/** Ce qu'on a pu tirer d'une pièce jointe. */
export interface AttachmentText {
  /** text = du texte exploitable ; scan = pièce illisible sans l'IA ; other = format non géré. */
  kind: 'text' | 'scan' | 'other';
  /** Texte extrait, nettoyé et tronqué (vide si kind != 'text'). */
  text: string;
  /** Explication en français, affichable telle quelle. */
  note: string;
}

/**
 * Longueur retenue par pièce. Généreuse À DESSEIN (demande du 10/08 : « c'est
 * l'intégralité des pièces jointes qui doit être lue, le but est de permettre
 * une recherche rapide même sur des pièces non nommées comme il faut ») : une
 * facture pèse 2 à 5 Ko de texte, un contrat ou un relevé beaucoup plus, et
 * c'est justement au milieu d'un long document qu'on cherche un nom ou un
 * numéro. Le plafond ne protège plus que des cas pathologiques.
 */
const MAX_TEXT = 200_000;
// Au-delà, on ne tente rien : une pièce de 20 Mo n'a pas à occuper le VPS.
const MAX_PDF_BYTES = 12 * 1024 * 1024;

/** Décompresse un flux PDF (FlateDecode), en tolérant les en-têtes abîmés. */
function inflate(buf: Buffer): Buffer | null {
  try {
    return inflateSync(buf);
  } catch {
    try {
      return inflateRawSync(buf);
    } catch {
      return null;
    }
  }
}

/**
 * Texte d'un contenu PDF décompressé : opérateurs Tj / TJ / ' / ".
 * On lit les chaînes littérales `(…)` — le cas courant — et on saute les
 * chaînes hexadécimales `<…>` (polices à encodage propre, illisibles sans la
 * table de correspondance : mieux vaut rien que du charabia).
 */
function textFromContent(content: string): string {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\()])*\)|\bTJ\b|\bTj\b|\bTD\b|\bTd\b|\bT\*\b|\bET\b/gs;
  let m: RegExpExecArray | null;
  let pending: string[] = [];
  const flush = (sep: string) => {
    if (pending.length) {
      out.push(pending.join(''));
      pending = [];
    }
    if (sep && out.length) out.push(sep);
  };
  while ((m = re.exec(content)) !== null) {
    const tok = m[0];
    if (tok.startsWith('(')) {
      pending.push(
        tok
          .slice(1, -1)
          // Séquences d'échappement PDF (RFC : \n \r \t \b \f \( \) \\ \ooo).
          .replace(/\\([nrtbf()\\])/g, (_s, c: string) =>
            ({ n: '\n', r: '\n', t: '\t', b: '', f: '\n', '(': '(', ')': ')', '\\': '\\' })[c] ?? c)
          .replace(/\\([0-7]{1,3})/g, (_s, o: string) => String.fromCharCode(Number.parseInt(o, 8))),
      );
    } else if (tok === 'TD' || tok === 'Td' || tok === 'T*' || tok === 'ET') {
      flush('\n');
    }
  }
  flush('');
  return out.join('');
}

/** Nettoyage : espaces multiples, lignes vides, troncature. */
function tidy(raw: string): string {
  return raw
    .replace(/\r/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .slice(0, MAX_TEXT)
    .trim();
}

/**
 * Extrait le texte d'un PDF. Best effort assumé : on rend ce qu'on a lu, et
 * on distingue clairement « rien à lire ici » (scan) de « j'ai lu ».
 */
export function pdfToText(buf: Buffer): AttachmentText {
  if (buf.length > MAX_PDF_BYTES) {
    return { kind: 'other', text: '', note: 'PDF trop volumineux pour être lu ici.' };
  }
  const bin = buf.toString('latin1');
  let collected = '';
  // Chaque « stream … endstream » est un morceau de page (souvent compressé) :
  // on les parcourt TOUS, pour lire le document en entier et pas seulement sa
  // première page (la recherche doit porter sur tout le contenu).
  const re = /stream\r?\n?([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin)) !== null && collected.length < MAX_TEXT) {
    const rawChunk = Buffer.from(m[1], 'latin1');
    // Un flux non compressé est directement du contenu ; sinon on décompresse.
    const data = /^[\s]*[\d.\-\s]*(BT|\/|q\b)/.test(m[1].slice(0, 40))
      ? rawChunk
      : inflate(rawChunk);
    if (!data) continue;
    const s = data.toString('latin1');
    if (!s.includes('Tj') && !s.includes('TJ')) continue;
    collected += textFromContent(s) + '\n';
  }
  const text = tidy(collected);
  // Un PDF de scan porte une image et (parfois) deux mots de garde : sous ce
  // seuil, on considère honnêtement qu'on n'a rien lu.
  if (text.replace(/\s/g, '').length < 25) {
    return {
      kind: 'scan',
      text: '',
      note: 'PDF sans texte (document scanné ou image) — le contenu doit être lu par l\'IA.',
    };
  }
  return { kind: 'text', text, note: `Texte extrait du PDF (${text.length} caractères).` };
}

/** Aiguillage par type de pièce. Les images sont des scans par nature. */
export function attachmentToText(
  filename: string,
  contentType: string,
  buf: Buffer,
): AttachmentText {
  const ct = (contentType || '').toLowerCase();
  const name = (filename || '').toLowerCase();
  if (ct.includes('pdf') || name.endsWith('.pdf')) return pdfToText(buf);
  if (ct.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|tiff?)$/.test(name)) {
    return {
      kind: 'scan',
      text: '',
      note: 'Image (photo ou scan) — le contenu doit être lu par l\'IA.',
    };
  }
  if (ct.startsWith('text/') || /\.(txt|csv|md)$/.test(name)) {
    const text = tidy(buf.toString('utf8'));
    return text
      ? { kind: 'text', text, note: 'Texte lu directement.' }
      : { kind: 'other', text: '', note: 'Fichier texte vide.' };
  }
  return { kind: 'other', text: '', note: `Format non lu ici (${ct || 'inconnu'}).` };
}

// --------------------------------------------------------------------------
// Ce que le texte d'une facture nous apprend
// --------------------------------------------------------------------------

/** Indices tirés du CONTENU (pas de l'expéditeur). */
export interface DocumentHints {
  /** Fournisseur réel reconnu dans le document (Sosh, OVH…), sinon null. */
  supplier: string | null;
  /** Montant TTC le plus vraisemblable, en euros. */
  amountTtc: number | null;
  /** Numéro de facture si repéré. */
  invoiceNumber: string | null;
  /** true si le document se présente comme une facture / un reçu. */
  isInvoice: boolean;
  /** Justifications en français (affichables telles quelles). */
  reasons: string[];
}

// Fournisseurs récurrents chez l'utilisateur : leur nom dans le DOCUMENT prime
// sur l'expéditeur du mail (c'est tout l'objet du correctif). Liste ouverte —
// l'absence d'un fournisseur ne change rien au reste de la détection.
const KNOWN_SUPPLIERS = [
  'sosh', 'orange', 'free mobile', 'free', 'bouygues', 'sfr', 'ovh', 'ovhcloud',
  'edf', 'engie', 'total energies', 'totalenergies', 'veolia', 'suez',
  'sfr business', 'la poste', 'amazon', 'fnac', 'darty', 'leroy merlin',
  'boulanger', 'ikea', 'castorama', 'brico depot', 'bricorama',
  'sncf', 'air france', 'booking', 'airbnb', 'uber', 'stripe',
  'axa', 'maif', 'macif', 'matmut', 'allianz', 'groupama', 'generali',
  'adobe', 'microsoft', 'google', 'apple', 'anthropic', 'openai',
];

const MONEY_RE = /(\d{1,3}(?:[   ]\d{3})*|\d+)[,.](\d{2})\s*(?:€|eur\b|euros?\b)/gi;

/**
 * Lit un texte de document et en tire fournisseur / montant / nature.
 * Volontairement conservateur : mieux vaut « je ne sais pas » qu'une valeur
 * inventée — c'est l'utilisateur (ou Claude) qui tranchera.
 */
export function documentHints(text: string): DocumentHints {
  const hints: DocumentHints = {
    supplier: null, amountTtc: null, invoiceNumber: null, isInvoice: false, reasons: [],
  };
  if (!text) return hints;
  const low = text.toLowerCase();

  // Nature du document.
  if (/\b(facture|invoice|re[çc]u|ticket de caisse|note de frais|avis d'?[ée]ch[ée]ance|quittance)\b/i.test(low)) {
    hints.isInvoice = true;
    hints.reasons.push('le document se présente comme une facture ou un reçu');
  }

  // Fournisseur : le premier nom connu qui apparaît dans le document.
  for (const s of KNOWN_SUPPLIERS) {
    const re = new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (re.test(low)) {
      hints.supplier = s.replace(/\b\w/g, (c) => c.toUpperCase());
      hints.reasons.push(`le fournisseur « ${hints.supplier} » est écrit dans le document`);
      break;
    }
  }

  // Numéro de facture. Le lookahead impose au moins un CHIFFRE : sans lui,
  // « Facture mobile » donnait « mobile » comme numéro (constaté au test).
  const num = /\b(?:facture|invoice)\s*(?:n[°o]|num[ée]ro|#)\s*[:.]?\s*((?=[A-Za-z0-9\-/]*\d)[A-Za-z0-9][A-Za-z0-9\-/]{3,})/i
    .exec(text);
  if (num) hints.invoiceNumber = num[1];

  // Montant : on privilégie une ligne « total TTC / montant à payer », sinon le
  // plus gros montant du document (les factures affichent le total en grand).
  const labelled = /(total\s*(?:ttc)?|montant\s*(?:ttc|à\s*payer|d[ûu])|net\s*à\s*payer|prélèvement)[^\n€]{0,40}?(\d{1,3}(?:[   ]\d{3})*|\d+)[,.](\d{2})/i.exec(text);
  if (labelled) {
    hints.amountTtc = Number(`${labelled[2].replace(/[\s ]/g, '')}.${labelled[3]}`);
    hints.reasons.push(`total lu dans le document : ${hints.amountTtc.toFixed(2)} €`);
  } else {
    let best: number | null = null;
    let m: RegExpExecArray | null;
    MONEY_RE.lastIndex = 0;
    while ((m = MONEY_RE.exec(text)) !== null) {
      const v = Number(`${m[1].replace(/[\s ]/g, '')}.${m[2]}`);
      if (Number.isFinite(v) && (best === null || v > best)) best = v;
    }
    if (best !== null) {
      hints.amountTtc = best;
      hints.reasons.push(`montant le plus élevé trouvé : ${best.toFixed(2)} €`);
    }
  }
  return hints;
}
