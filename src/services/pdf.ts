/**
 * FABRIQUER UN PDF À PARTIR D'UN MAIL — sans dépendance, sans rien écrire sur
 * disque (27/08).
 *
 * POURQUOI CE FICHIER EXISTE. Une catégorie entière de justificatifs n'arrive
 * jamais jusqu'à Fiscal-Manager : les billets d'avion. Ces mails ne portent
 * AUCUNE pièce jointe — le justificatif, c'est le corps du message. Pour les
 * faire passer dans le tuyau existant sans le modifier, on expose le corps
 * comme une pièce SYNTHÉTIQUE, rendue en PDF à la demande.
 *
 * TROIS CONTRAINTES QUI DICTENT LA FORME :
 *  1. **Aucun stockage.** Décision n° 3 de docs/CONNECTEUR-FISCAL-MANAGER.md :
 *     l'IMAP est le stockage durable, Boxmail ne conserve pas de PDF. On génère
 *     en mémoire, on rend, on oublie.
 *  2. **Un VRAI PDF.** Jump et Expensya reçoivent le fichier tel quel comme
 *     justificatif : il doit commencer par `%PDF` et s'ouvrir dans un lecteur
 *     ordinaire, pas seulement « ne pas planter ».
 *  3. **Aucune dépendance nouvelle.** Le VPS fait un `npm install` complet à
 *     chaque mise à jour ; ajouter une bibliothèque de rendu pour écrire du
 *     texte noir sur blanc serait payer cher une ligne droite.
 *
 * CE QUE ÇA NE FAIT PAS : ni images, ni mise en page HTML, ni polices
 * embarquées. Le corps d'un mail de réservation est du texte — c'est le montant
 * payé et la référence qui font le justificatif, pas la charte du transporteur.
 */

/** Marges et métriques d'une page A4, en points PostScript (72 pt = 1 pouce). */
const PAGE = { largeur: 595.28, hauteur: 841.89, marge: 56 };
const CORPS = { taille: 10, interligne: 13.5 };
const TITRE = { taille: 13, interligne: 18 };
/** Helvetica ~0,52 em par caractère en moyenne : suffit pour couper les lignes. */
const LARGEUR_CAR = 0.52;

/**
 * WinAnsiEncoding (cp1252) — l'encodage déclaré pour la police. Les caractères
 * hors table deviennent « ? » plutôt que de produire un PDF illisible : un
 * justificatif à demi lisible vaut mieux qu'un fichier refusé.
 *
 * ⚠️ L'euro est à 0x80 en WinAnsi, PAS à son point Unicode — et c'est
 * précisément le caractère qui compte ici (« Montant payé : 160,36 € »).
 */
const HORS_LATIN1: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
  'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91,
  '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98,
  '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

/**
 * Ce qui n'existe pas en WinAnsi mais se dit très bien en ASCII.
 *
 * ⚠️ VU AU RENDU (27/08) : sans cette table, « Malaga (AGP) → Brest (BES) »
 * s'imprimait « Malaga (AGP) ? Brest (BES) ». Sur un justificatif de vol, la
 * flèche EST l'itinéraire — la perdre abîme la pièce elle-même.
 */
const TRANSLITTERE: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '⟶': '->', '⇒': '=>', '⇄': '<->', '➔': '->',
  '✈': '(avion)', '✔': 'v', '✓': 'v', '✗': 'x', '×': 'x', '·': '.', '≥': '>=',
  '≤': '<=', '≠': '!=', '⁄': '/', '№': 'No', '±': '+/-',
};

function versWinAnsi(texte: string): Buffer {
  const octets: number[] = [];
  for (const c of texte) {
    const remplacant = TRANSLITTERE[c];
    if (remplacant !== undefined) {
      for (const r of remplacant) octets.push(r.charCodeAt(0));
      continue;
    }
    const point = c.codePointAt(0) ?? 63;
    if (HORS_LATIN1[c] !== undefined) octets.push(HORS_LATIN1[c]);
    else if (point >= 32 && point <= 255) octets.push(point);
    else octets.push(63); // « ? »
  }
  return Buffer.from(octets);
}

/** Échappe ce qui a un sens dans une chaîne littérale PDF. */
function echapper(texte: string): Buffer {
  const brut = versWinAnsi(texte);
  const out: number[] = [];
  for (const o of brut) {
    if (o === 0x28 || o === 0x29 || o === 0x5c) out.push(0x5c); // ( ) \
    out.push(o);
  }
  return Buffer.from(out);
}

/** Coupe une ligne trop longue sans casser les mots quand c'est possible. */
function replier(ligne: string, largeurMax: number, taille: number): string[] {
  const parCar = Math.max(20, Math.floor(largeurMax / (taille * LARGEUR_CAR)));
  if (ligne.length <= parCar) return [ligne];
  const sorties: string[] = [];
  let courante = '';
  for (const mot of ligne.split(/\s+/)) {
    if (!courante.length) {
      courante = mot;
    } else if (courante.length + 1 + mot.length <= parCar) {
      courante += ` ${mot}`;
    } else {
      sorties.push(courante);
      courante = mot;
    }
    // Un mot seul plus long que la ligne (URL, référence) : coupe franche.
    while (courante.length > parCar) {
      sorties.push(courante.slice(0, parCar));
      courante = courante.slice(parCar);
    }
  }
  if (courante.length) sorties.push(courante);
  return sorties;
}

export interface MailAImprimer {
  subject: string;
  fromName: string | null;
  fromEmail: string | null;
  date: Date | null;
  /** Le corps en TEXTE (le HTML doit être converti avant l'appel). */
  texte: string;
  /** Lignes d'en-tête supplémentaires (référence, montant relevé…). */
  entetes?: string[];
}

/**
 * Rend le mail en PDF. Déterministe : le même mail rend le même octet — c'est
 * ce qui permet à Fiscal-Manager de retirer deux fois la même pièce sans
 * fabriquer un doublon.
 */
export function mailEnPdf(mail: MailAImprimer): Buffer {
  const largeurUtile = PAGE.largeur - 2 * PAGE.marge;

  const enTete: string[] = [mail.subject || '(sans objet)'];
  const de = [mail.fromName, mail.fromEmail ? `<${mail.fromEmail}>` : null]
    .filter(Boolean)
    .join(' ');
  if (de) enTete.push(`De : ${de}`);
  if (mail.date) {
    enTete.push(
      `Reçu le ${mail.date.toISOString().slice(0, 10)} à ${mail.date.toISOString().slice(11, 16)} UTC`,
    );
  }
  for (const e of mail.entetes ?? []) enTete.push(e);

  // Une ligne = un tuple (texte, gras). Le titre est le seul gras.
  const lignes: { t: string; gras: boolean }[] = [];
  enTete.forEach((l, i) => {
    for (const bout of replier(l, largeurUtile, i === 0 ? TITRE.taille : CORPS.taille)) {
      lignes.push({ t: bout, gras: i === 0 });
    }
  });
  lignes.push({ t: '', gras: false });
  // Un trait en tirets ASCII : le tiret cadratin n'existe pas en WinAnsi et
  // deviendrait une file de « ? ».
  lignes.push({ t: '-'.repeat(72), gras: false });
  lignes.push({ t: '', gras: false });
  for (const brute of (mail.texte || '(corps vide)').replace(/\r\n?/g, '\n').split('\n')) {
    if (!brute.trim()) { lignes.push({ t: '', gras: false }); continue; }
    for (const bout of replier(brute.trim(), largeurUtile, CORPS.taille)) {
      lignes.push({ t: bout, gras: false });
    }
  }

  // Découpe en pages.
  const hauteurUtile = PAGE.hauteur - 2 * PAGE.marge;
  const parPage = Math.floor(hauteurUtile / CORPS.interligne);
  const pages: { t: string; gras: boolean }[][] = [];
  for (let i = 0; i < lignes.length; i += parPage) pages.push(lignes.slice(i, i + parPage));
  if (!pages.length) pages.push([{ t: '(corps vide)', gras: false }]);

  // ── Assemblage du PDF ──────────────────────────────────────────────────
  // Objets : 1 catalogue, 2 pages, 3 police normale, 4 police grasse,
  // puis par page un objet Page et un objet Contents.
  const objets: Buffer[] = [];
  const pousser = (corps: Buffer | string) =>
    objets.push(Buffer.isBuffer(corps) ? corps : Buffer.from(corps, 'latin1'));

  const idPremierePage = 5;
  const idsPages = pages.map((_, i) => idPremierePage + i * 2);

  pousser('<< /Type /Catalog /Pages 2 0 R >>');
  pousser(
    `<< /Type /Pages /Count ${pages.length} /Kids [${idsPages.map((n) => `${n} 0 R`).join(' ')}] >>`,
  );
  pousser('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  pousser('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  pages.forEach((page, i) => {
    const idPage = idsPages[i];
    const idFlux = idPage + 1;
    pousser(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.largeur.toFixed(2)} ${PAGE.hauteur.toFixed(2)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${idFlux} 0 R >>`,
    );

    const morceaux: Buffer[] = [Buffer.from('BT\n', 'latin1')];
    let y = PAGE.hauteur - PAGE.marge;
    let premiere = true;
    for (const l of page) {
      const taille = l.gras ? TITRE.taille : CORPS.taille;
      const saut = l.gras ? TITRE.interligne : CORPS.interligne;
      y -= premiere ? taille : saut;
      premiere = false;
      morceaux.push(Buffer.from(`/${l.gras ? 'F2' : 'F1'} ${taille} Tf\n`, 'latin1'));
      morceaux.push(Buffer.from(`1 0 0 1 ${PAGE.marge.toFixed(2)} ${y.toFixed(2)} Tm\n`, 'latin1'));
      morceaux.push(Buffer.from('(', 'latin1'), echapper(l.t), Buffer.from(') Tj\n', 'latin1'));
    }
    morceaux.push(Buffer.from('ET', 'latin1'));
    const flux = Buffer.concat(morceaux);
    pousser(
      Buffer.concat([
        Buffer.from(`<< /Length ${flux.length} >>\nstream\n`, 'latin1'),
        flux,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
  });

  // En-tête, corps des objets, table des références croisées, bande-annonce.
  const entete = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const blocs: Buffer[] = [entete];
  const offsets: number[] = [];
  let position = entete.length;
  objets.forEach((o, i) => {
    const bloc = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      o,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.push(position);
    position += bloc.length;
    blocs.push(bloc);
  });

  const debutXref = position;
  let xref = `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${debutXref}\n%%EOF\n`;
  blocs.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(blocs);
}
