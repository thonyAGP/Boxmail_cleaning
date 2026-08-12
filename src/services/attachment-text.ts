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
/**
 * Table de correspondance code → caractère, extraite des flux `/ToUnicode`
 * du PDF (11/08).
 *
 * POURQUOI : les factures modernes n'écrivent pas leur texte en clair. Elles
 * utilisent des chaînes HEXADÉCIMALES `<00440045005600490053>` avec une police
 * « sous-ensemble » dont les codes n'ont aucun rapport avec l'alphabet. Sans
 * cette table, on ne lit rien — constaté en production : les factures IKEA
 * rendaient 32 caractères, c'est-à-dire uniquement leur nom de fichier.
 *
 * Le PDF fournit lui-même la table (`beginbfchar` / `beginbfrange`). On les
 * fusionne toutes : c'est approximatif quand deux polices se contredisent,
 * mais sur une facture il n'y en a qu'une ou deux et le gain est décisif.
 */
type TableUnicode = { map: Map<number, string>; largeur: 1 | 2 };

function motsHexVersTexte(hex: string, t: TableUnicode | null): string {
  const propre = hex.replace(/[^0-9a-fA-F]/g, '');
  if (propre.length === 0) return '';
  const pas = (t?.largeur ?? 2) * 2;
  let out = '';
  for (let i = 0; i + pas <= propre.length; i += pas) {
    const code = Number.parseInt(propre.slice(i, i + pas), 16);
    const c = t?.map.get(code);
    if (c !== undefined) out += c;
    // Sans table, un code sur un octet est souvent du latin1 direct.
    else if (pas === 2 && code >= 32 && code < 127) out += String.fromCharCode(code);
    else if (pas === 4 && code >= 32 && code < 0xfffd) out += String.fromCharCode(code);
  }
  return out;
}

/** Décode une destination `<0041>` ou `<00410042>` (UTF-16BE) en texte. */
function destVersTexte(hex: string): string {
  const p = hex.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 4 <= p.length; i += 4) {
    const v = Number.parseInt(p.slice(i, i + 4), 16);
    if (v > 0 && v !== 0xfffd) out += String.fromCharCode(v);
  }
  // Certaines tables donnent des destinations sur un seul octet.
  if (!out && p.length === 2) {
    const v = Number.parseInt(p, 16);
    if (v >= 32) out = String.fromCharCode(v);
  }
  return out;
}

function lireCMap(texte: string, dans: TableUnicode): void {
  // beginbfchar : paires « <source> <destination> »
  for (const bloc of texte.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const m of bloc.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const src = m[1];
      if (src.length >= 4) dans.largeur = 2;
      const c = destVersTexte(m[2]);
      if (c) dans.map.set(Number.parseInt(src, 16), c);
    }
  }
  // beginbfrange : « <lo> <hi> <dest> » ou « <lo> <hi> [<d1> <d2> …] »
  for (const bloc of texte.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const m of bloc.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g,
    )) {
      const lo = Number.parseInt(m[1], 16);
      const hi = Number.parseInt(m[2], 16);
      if (m[1].length >= 4) dans.largeur = 2;
      // Garde-fou : une plage aberrante ferait exploser la mémoire.
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 65_535) continue;
      if (m[3]) {
        const base = destVersTexte(m[3]);
        if (!base) continue;
        const premier = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) {
          dans.map.set(c, base.slice(0, -1) + String.fromCharCode(premier + (c - lo)));
        }
      } else if (m[4]) {
        const items = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)];
        items.forEach((it, i) => {
          const c = destVersTexte(it[1]);
          if (c) dans.map.set(lo + i, c);
        });
      }
    }
  }
}

/**
 * Une chaîne littérale `(…)` peut elle aussi contenir des CODES et non des
 * lettres (11/08). C'est le cas des factures IKEA : `(\x001\x00B\x00H\x00F)`
 * vaut « Page », chaque caractère étant un code sur DEUX octets d'une police
 * Type0. Sans ce décodage, on lisait des octets nuls et donc rien du tout.
 *
 * On tente le décodage par la table et on ne le retient que s'il explique
 * l'essentiel de la chaîne — sinon on garde le texte brut, qui est le cas
 * normal des PDF simples.
 */
function litteralVersTexte(brut: string, t: TableUnicode | null): string {
  if (!t || t.map.size === 0) return brut;
  const essai = (largeur: 1 | 2): { texte: string; ratio: number } => {
    if (largeur === 2 && brut.length % 2 !== 0) return { texte: '', ratio: 0 };
    let texte = '';
    let mappes = 0;
    let total = 0;
    for (let i = 0; i + largeur <= brut.length; i += largeur) {
      const code =
        largeur === 2 ? (brut.charCodeAt(i) << 8) | brut.charCodeAt(i + 1) : brut.charCodeAt(i);
      total++;
      const c = t.map.get(code);
      if (c !== undefined) {
        texte += c;
        mappes++;
      }
    }
    return { texte, ratio: total ? mappes / total : 0 };
  };
  const r = essai(t.largeur);
  // 60 % : assez pour reconnaître une police à codes, assez peu pour ne pas
  // massacrer une chaîne normale dont quelques caractères seraient dans la table.
  if (r.ratio >= 0.6) return r.texte;
  return brut;
}

function textFromContent(content: string, table: TableUnicode | null = null): string {
  const out: string[] = [];
  const re =
    /\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>|\bTJ\b|\bTj\b|\bTD\b|\bTd\b|\bT\*\b|\bET\b/gs;
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
      const brut = tok
        .slice(1, -1)
        // Séquences d'échappement PDF (RFC : \n \r \t \b \f \( \) \\ \ooo).
        .replace(/\\([nrtbf()\\])/g, (_s, c: string) =>
          ({ n: '\n', r: '\n', t: '\t', b: '', f: '\n', '(': '(', ')': ')', '\\': '\\' })[c] ?? c)
        .replace(/\\([0-7]{1,3})/g, (_s, o: string) => String.fromCharCode(Number.parseInt(o, 8)));
      // La chaîne peut contenir des CODES et non des lettres (cas IKEA).
      pending.push(litteralVersTexte(brut, table));
    } else if (tok.startsWith('<')) {
      // Chaîne hexadécimale : le cas de toutes les factures modernes.
      pending.push(motsHexVersTexte(tok.slice(1, -1), table));
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
  // Chaque « stream … endstream » est un morceau du document (souvent
  // compressé) : on les parcourt TOUS — le contenu des pages, mais aussi les
  // tables de correspondance des polices.
  const re = /stream\r?\n?([\s\S]*?)endstream/g;
  const flux: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(bin)) !== null && flux.length < 3000) {
    const rawChunk = Buffer.from(m[1], 'latin1');
    const data = /^[\s]*[\d.\-\s]*(BT|\/|q\b)/.test(m[1].slice(0, 40))
      ? rawChunk
      : inflate(rawChunk);
    if (data) flux.push(data.toString('latin1'));
  }

  // 1re passe : les tables `/ToUnicode`. Elles doivent être connues AVANT de
  // décoder le texte, sinon les chaînes hexadécimales restent illisibles.
  const table: TableUnicode = { map: new Map(), largeur: 2 };
  for (const s of flux) {
    if (s.includes('beginbfchar') || s.includes('beginbfrange')) lireCMap(s, table);
  }
  const avecTable = table.map.size > 0;

  // 2e passe : le texte. Les opérateurs sont cherchés comme des MOTS : sans
  // ça, un « TJ » présent par hasard dans un flux de métadonnées faisait
  // analyser n'importe quoi (constaté : un PDF rendait « fr-FR fr-FR fr-FR »).
  let collected = '';
  for (const s of flux) {
    if (collected.length >= MAX_TEXT) break;
    if (!/\b(Tj|TJ)\b/.test(s)) continue;
    collected += textFromContent(s, avecTable ? table : null) + '\n';
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
// --------------------------------------------------------------------------
// Documents Office (docx / xlsx / pptx) — 11/08
//
// Ce sont des archives ZIP contenant du XML. On a déjà zlib pour les PDF :
// il ne manquait qu'un lecteur d'archive. Mesuré sur ses boîtes : 222 pièces
// concernées (132 .xlsx, 90 .docx) — dont « Conditions générales de vente.docx »
// arrivé avec un devis. Sans ça, ces documents restaient introuvables.
// --------------------------------------------------------------------------

/** Une entrée d'archive ZIP, lue depuis l'annuaire central (tailles fiables). */
type EntreeZip = { nom: string; debut: number; compresse: number; methode: number };

function lireAnnuaireZip(buf: Buffer): EntreeZip[] {
  // Fin d'annuaire central (EOCD) : signature 0x06054b50, cherchée à rebours
  // (un commentaire d'archive peut la décaler de quelques octets).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const nb = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: EntreeZip[] = [];
  for (let i = 0; i < nb && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const methode = buf.readUInt16LE(p + 10);
    const compresse = buf.readUInt32LE(p + 20);
    const lgNom = buf.readUInt16LE(p + 28);
    const lgExtra = buf.readUInt16LE(p + 30);
    const lgComm = buf.readUInt16LE(p + 32);
    const offLocal = buf.readUInt32LE(p + 42);
    const nom = buf.toString('utf8', p + 46, p + 46 + lgNom);
    // L'en-tête local porte ses propres longueurs : c'est lui qui donne le
    // début réel des données.
    if (offLocal + 30 <= buf.length && buf.readUInt32LE(offLocal) === 0x04034b50) {
      const lgNomL = buf.readUInt16LE(offLocal + 26);
      const lgExtraL = buf.readUInt16LE(offLocal + 28);
      out.push({ nom, debut: offLocal + 30 + lgNomL + lgExtraL, compresse, methode });
    }
    p += 46 + lgNom + lgExtra + lgComm;
  }
  return out;
}

/** Texte brut d'un fragment XML Office : les balises sautent, le texte reste. */
function texteDuXml(xml: string): string {
  return xml
    // Fin de paragraphe / de ligne / de cellule → saut de ligne. Sans `si`
    // et `t`, les cellules d'un tableur se collaient (« Quittance 2026842,00 »
    // au lieu de deux valeurs distinctes) et fabriquaient de faux mots.
    .replace(/<\/(w:p|a:p|w:tr|row|si|t|w:t|a:t)>/gi, '\n')
    .replace(/<w:tab\b[^>]*\/?>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function officeToText(buf: Buffer): AttachmentText {
  let entrees: EntreeZip[];
  try {
    entrees = lireAnnuaireZip(buf);
  } catch {
    return { kind: 'other', text: '', note: 'Archive Office illisible.' };
  }
  if (entrees.length === 0) return { kind: 'other', text: '', note: 'Archive Office vide ou abîmée.' };

  // Les parties qui portent du texte utile, dans l'ordre de lecture.
  const utiles = entrees.filter((e) =>
    /^word\/document\.xml$/i.test(e.nom) ||
    /^word\/(header|footer)\d*\.xml$/i.test(e.nom) ||
    /^xl\/sharedStrings\.xml$/i.test(e.nom) ||
    /^ppt\/slides\/slide\d+\.xml$/i.test(e.nom) ||
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(e.nom));
  if (utiles.length === 0) return { kind: 'other', text: '', note: 'Archive sans partie textuelle connue.' };

  const morceaux: string[] = [];
  let total = 0;
  for (const e of utiles) {
    if (total >= MAX_TEXT) break;
    const brut = buf.subarray(e.debut, e.debut + e.compresse);
    // 0 = stocké tel quel, 8 = dégonflé (les deux seuls cas d'Office).
    let xml: string;
    try {
      if (e.methode === 0) xml = brut.toString('utf8');
      else {
        const d = inflateRawSync(brut);
        xml = d.toString('utf8');
      }
    } catch {
      continue;
    }
    const t = tidy(texteDuXml(xml));
    if (t) {
      morceaux.push(t);
      total += t.length;
    }
  }
  const text = morceaux.join('\n').slice(0, MAX_TEXT);
  return text
    ? { kind: 'text', text, note: 'Document Office lu (texte extrait).' }
    : { kind: 'other', text: '', note: 'Document Office sans texte exploitable.' };
}

/**
 * Rend un texte ÉCRIVABLE EN BASE.
 *
 * PANNE RÉELLE, relevée dans les journaux du 12/08 : une quinzaine d'échecs en
 * série, tous « Invalid prisma.message.update() : lone leading surrogate in
 * hex escape » / « unexpected end of hex escape ». L'extraction PDF produit des
 * demi-caractères de substitution isolés — une table `/ToUnicode` incomplète
 * suffit — et une chaîne qui en contient n'est pas encodable en UTF-8 : TOUTE
 * l'écriture échoue, pas seulement le caractère fautif.
 *
 * Conséquence : le job « pièces jointes » tournait et ne produisait rien pour
 * ces mails, en boucle, sans que rien ne le dise à l'écran. Exactement le genre
 * de panne silencieuse qui donne une illusion de couverture.
 *
 * Le même assainissement existait depuis longtemps pour le texte des MAILS
 * (`cleanSnippet`) ; il manquait pour celui des PIÈCES.
 */
export function assainirPourBase(s: string): string {
  // PAS D'EXPRESSION RÉGULIÈRE ICI — c'est ce qui a fait échouer mes deux
  // premiers correctifs du 12/08, et le défaut était hérité du nettoyage des
  // mails. Le motif habituel « (début|caractère non-haut) suivi d'un bas »
  // CONSOMME le caractère qui précède : sur deux demi-caractères isolés
  // CONSÉCUTIFS, le second n'est jamais vu — et un seul suffit à faire échouer
  // l'écriture de tout le mail.
  //
  // On parcourt donc par POINT DE CODE : « for...of » rend une paire valide
  // comme un seul point de code (au-dessus de 0xFFFF, donc hors de la plage
  // D800-DFFF) et un demi-caractère isolé comme une unité DANS cette plage. La
  // distinction est exacte, sans cas particulier, et les emojis sont préservés.
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    // Demi-caractère de substitution isolé (une paire valide ne passe pas ici).
    if (c >= 0xd800 && c <= 0xdfff) {
      out += ' ';
      continue;
    }
    // Caractères de contrôle, sauf tabulation, saut de ligne, retour chariot.
    if (c < 9 || (c > 10 && c < 32 && c !== 13)) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

export function attachmentToText(
  filename: string,
  contentType: string,
  buf: Buffer,
): AttachmentText {
  const r = attachmentToTextBrut(filename, contentType, buf);
  // Assainissement au SEUL point de sortie : tous les appelants en profitent,
  // y compris la lecture à la demande (read_attachment).
  return r.text ? { ...r, text: assainirPourBase(r.text) } : r;
}

function attachmentToTextBrut(
  filename: string,
  contentType: string,
  buf: Buffer,
): AttachmentText {
  const ct = (contentType || '').toLowerCase();
  const name = (filename || '').toLowerCase();
  if (ct.includes('pdf') || name.endsWith('.pdf')) return pdfToText(buf);
  // Office moderne (ZIP + XML). Les vieux formats binaires .doc/.xls ne sont
  // pas traités : trop peu nombreux ici pour justifier un décodeur OLE.
  if (
    ct.includes('openxmlformats-officedocument') ||
    /\.(docx|xlsx|pptx)$/.test(name)
  ) {
    return officeToText(buf);
  }
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
