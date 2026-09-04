/**
 * Les pages d'un même document scanné (28/08).
 *
 * DÉCLENCHEUR. Mylène scanne les factures PAGE PAR PAGE et les envoie dans un
 * seul mail. Boxmail en faisait — correctement — UN candidat comptable à trois
 * pièces ; Fiscal-Manager, qui crée un document par pièce, en faisait TROIS
 * frais. Anthony l'a vu à l'écran : trois lignes « facture sosh », même
 * fournisseur, même référence, **même 23,61 €**. Créés tels quels, c'était
 * 70,83 € déclarés pour une facture de 23,61 € — la rechute exacte du « billet
 * compté trois fois » du 27/08.
 *
 * CE QUE LA RÈGLE DOIT DISTINGUER, et c'est tout le problème : plusieurs pièces
 * dans un mail, ce n'est PAS forcément un document en plusieurs pages. Mesuré
 * sur ses 213 justificatifs réels — 40 candidats portent plusieurs pièces :
 *
 *     seq 248  18 factures Amazon distinctes dans un seul mail
 *     seq 284  01-25.pdf … 07-25.pdf — SEPT relevés mensuels, pas sept pages
 *     seq 134  Invoice-….pdf + Receipt-….pdf — deux documents, un seul achat
 *     seq  67  sosh 001/002/003.jpg — TROIS PAGES d'une seule facture
 *     seq 237  001…004.jpg ET « DOSSIER JURIDIQUE » 001…004.jpg — DEUX
 *              documents de quatre pages chacun, dans le même mail
 *
 * Les fusionner par mail aurait détruit les quatre premiers cas ; ne rien
 * regrouper laisse passer les deux derniers.
 *
 * D'OÙ LA RÈGLE, VOLONTAIREMENT ÉTROITE — trois conditions cumulatives :
 *   1. **des IMAGES**, jamais des PDF. Un PDF numéroté est presque toujours un
 *      document entier de plus (les relevés `01-25`…`07-25` le montrent) ;
 *      une page scannée, elle, arrive en JPEG/PNG.
 *   2. **même racine de nom** — « sosh » pour `sosh 001.jpg`, la racine vide
 *      pour `001.jpg`. C'est elle qui sépare les deux liasses du seq 237.
 *   3. **numérotation contiguë** — 1,2,3 et pas 1,7 : deux photos éloignées
 *      dans une série n'ont pas de raison d'être les pages d'un même document.
 *
 * Sur ses données réelles, elle se déclenche sur 2 candidats et sur eux seuls,
 * et y produit exactement le bon découpage (3 pages ; 4 + 4).
 *
 * CE N'EST PAS UNE CERTITUDE, et le code ne fait pas semblant. Deux reçus d'une
 * page scannés « 001 » et « 002 » dans le même mail seraient regroupés à tort.
 * C'est pourquoi rien n'est fusionné ni caché : les pages restent
 * téléchargeables une par une, le regroupement est une PROPOSITION portant sa
 * raison en français, affichée dans « Ce qui part à la compta » — « voilà ce
 * que j'ai fait, interviens si c'est faux ».
 */

export interface PieceANommer {
  attachmentId: string;
  filename: string;
  contentType: string;
}

export interface GroupeDePages {
  /** Stable d'un passage à l'autre : rang du groupe dans l'ordre des pièces. */
  groupId: string;
  /** Les pièces du groupe, DANS L'ORDRE DES PAGES (pas l'ordre du mail). */
  attachmentIds: string[];
  pageCount: number;
  /** Pourquoi ces pièces n'en font qu'une, en français, affichable tel quel. */
  reason: string;
}

/** Racine et numéro d'un nom de fichier : « sosh 003.jpg » → { sosh, 3 }. */
function decoupe(filename: string): { stem: string; n: number | null; large: string } {
  const sansExt = filename.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const m = sansExt.match(/^(.*?)[\s._-]*(\d{1,4})$/);
  if (!m) return { stem: sansExt.trim().toLowerCase(), n: null, large: '' };
  return { stem: m[1].trim().toLowerCase(), n: Number(m[2]), large: m[2] };
}

function estImage(contentType: string): boolean {
  return /^image\//i.test(contentType || '');
}

/**
 * Les groupes de pages parmi les pièces d'UN mail. Une pièce qui n'appartient
 * à aucun groupe n'apparaît nulle part : elle reste un document à elle seule.
 */
export function grouperPagesScannees(pieces: PieceANommer[]): GroupeDePages[] {
  const parRacine = new Map<string, { piece: PieceANommer; n: number; large: string }[]>();
  for (const p of pieces) {
    if (!estImage(p.contentType)) continue;
    const d = decoupe(p.filename);
    if (d.n === null) continue;
    const lot = parRacine.get(d.stem) ?? [];
    lot.push({ piece: p, n: d.n, large: d.large });
    parRacine.set(d.stem, lot);
  }

  const groupes: GroupeDePages[] = [];
  for (const [stem, lot] of parRacine) {
    if (lot.length < 2) continue;
    const numeros = lot.map((x) => x.n);
    const distincts = new Set(numeros);
    if (distincts.size !== numeros.length) continue; // deux fois la même page
    const min = Math.min(...numeros);
    const max = Math.max(...numeros);
    if (max - min + 1 !== numeros.length) continue; // suite trouée : on s'abstient
    lot.sort((a, b) => a.n - b.n);
    const bornes = `${lot[0].large} à ${lot[lot.length - 1].large}`;
    groupes.push({
      groupId: `pages-${groupes.length + 1}`,
      attachmentIds: lot.map((x) => x.piece.attachmentId),
      pageCount: lot.length,
      reason: stem
        ? `${lot.length} images numérotées ${bornes} sous le même nom « ${stem} » : ` +
          `les pages d'un seul document scanné`
        : `${lot.length} images numérotées ${bornes} : les pages d'un seul document scanné`,
    });
  }
  // Ordre déterminé par la première page de chaque groupe dans l'ordre du mail,
  // pour que `groupId` ne bouge pas d'un passage à l'autre.
  const rang = (g: GroupeDePages) =>
    pieces.findIndex((p) => p.attachmentId === g.attachmentIds[0]);
  groupes.sort((a, b) => rang(a) - rang(b));
  groupes.forEach((g, i) => {
    g.groupId = `pages-${i + 1}`;
  });
  return groupes;
}

/**
 * Combien de DOCUMENTS distincts dans ces pièces — un groupe de pages compte
 * pour un. C'est ce nombre-là qui doit devenir des frais, pas `pieces.length`.
 */
export function nombreDeDocuments(pieces: PieceANommer[]): number {
  const groupes = grouperPagesScannees(pieces);
  const groupees = new Set(groupes.flatMap((g) => g.attachmentIds));
  return groupes.length + pieces.filter((p) => !groupees.has(p.attachmentId)).length;
}
