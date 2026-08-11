import { db, ensureDbReady } from '../db/client.js';

/**
 * Pièces jointes en double (11/08) — demande d'Anthony : « puisque tu passes
 * de toute façon sur toutes les pièces jointes, savoir si des pièces sont en
 * double ; je pense que ça prend plus de place que les newsletters ».
 *
 * Les mesures lui donnent raison : sur une fraction du fonds, on trouvait déjà
 * ~1 658 exemplaires en trop pour ~1,4 Go, quand tout le nettoyage du bruit ne
 * libérait que 137 Mo.
 *
 * DEUX NIVEAUX DE CERTITUDE, et le vocabulaire suit :
 *  · CONFIRMÉ  — même empreinte SHA-256 : ce sont les mêmes octets, point.
 *  · PROBABLE  — même nom et même taille annoncée. Ça ne PROUVE rien : la
 *    taille donnée par IMAP est celle du fichier ENCODÉ pour le transport, pas
 *    du fichier d'origine. Et « photo.jpg » présent dans sept mails, ce sont
 *    sept photos différentes.
 *
 * On ne supprime RIEN ici : c'est une lecture. La déduplication est d'abord
 * cognitive — voir « 1 document · 4 exemplaires » plutôt que quatre résultats.
 */

/** Noms trop génériques pour qu'une simple homonymie vaille présomption. */
const NOMS_GENERIQUES =
  /^(image|photo|img|dsc|scan|screenshot|capture|document|doc|fichier|file|piece|pj|att|attachment|untitled|sans[ _-]?titre)[\s_-]*\d*\.\w+$/i;

export interface PieceFiche {
  n: string;
  s: number;
  h?: string;
}

export interface OccurrenceDoublon {
  messageId: number;
  account: string;
  folder: string;
  uid: number;
  subject: string;
  fromName: string;
  date: string | null;
}

export interface GroupeDoublon {
  /** Clé interne (empreinte, ou nom+taille). */
  key: string;
  /** Nom de fichier affiché. */
  fileName: string;
  /** Taille d'un exemplaire, en octets. */
  sizeBytes: number;
  /** Nombre d'exemplaires trouvés. */
  count: number;
  /** Place occupée par les exemplaires SURNUMÉRAIRES. */
  wastedBytes: number;
  /** 'confirme' (même empreinte) ou 'probable' (même nom et même taille). */
  certitude: 'confirme' | 'probable';
  /** Boîtes concernées. */
  accounts: string[];
  occurrences: OccurrenceDoublon[];
}

export interface RapportDoublons {
  /** Mails dont la fiche des pièces est connue (dénominateur honnête). */
  examined: number;
  /** Mails à pièce jointe encore non examinés — le rapport est donc partiel. */
  pending: number;
  groups: GroupeDoublon[];
  totals: {
    groups: number;
    extraCopies: number;
    wastedBytes: number;
    confirmedGroups: number;
    confirmedWastedBytes: number;
  };
}

export async function listeDoublons(
  opts: { limit?: number; minBytes?: number; account?: string } = {},
): Promise<RapportDoublons> {
  await ensureDbReady();
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  // Sous 200 Ko, l'exemplaire en trop ne vaut pas qu'on en parle.
  const minBytes = opts.minBytes ?? 200 * 1024;

  const rows = await db.message.findMany({
    where: {
      isDeleted: false,
      attachmentMeta: { not: null },
      folder: { role: { notIn: ['trash', 'spam'] } },
      ...(opts.account ? { accountSlug: opts.account } : {}),
    },
    select: {
      id: true,
      accountSlug: true,
      uid: true,
      subject: true,
      fromName: true,
      fromEmail: true,
      date: true,
      attachmentMeta: true,
      folder: { select: { path: true } },
    },
  });

  const groupes = new Map<
    string,
    { fileName: string; size: number; certitude: 'confirme' | 'probable'; occ: OccurrenceDoublon[] }
  >();

  for (const m of rows) {
    let fiche: PieceFiche[];
    try {
      fiche = JSON.parse(m.attachmentMeta ?? '[]') as PieceFiche[];
    } catch {
      continue;
    }
    for (const p of fiche) {
      const nom = (p.n ?? '').trim();
      const taille = Number(p.s ?? 0);
      if (!nom || taille < minBytes) continue;
      // L'empreinte prime sur le nom : « facture.pdf » et « FRINV3159229.pdf »
      // peuvent être exactement le même document.
      const cle = p.h ? `h:${p.h}` : `n:${nom.toLowerCase()}|${taille}`;
      // Sans empreinte, un nom passe-partout ne suffit pas à présumer quoi que
      // ce soit : sept « photo.jpg » de même taille restent sept photos.
      if (!p.h && NOMS_GENERIQUES.test(nom)) continue;
      const g =
        groupes.get(cle) ??
        {
          fileName: nom,
          size: taille,
          certitude: (p.h ? 'confirme' : 'probable') as 'confirme' | 'probable',
          occ: [] as OccurrenceDoublon[],
        };
      // Un même mail ne compte qu'une fois par fichier.
      if (!g.occ.some((o) => o.messageId === m.id)) {
        g.occ.push({
          messageId: m.id,
          account: m.accountSlug,
          folder: m.folder.path,
          uid: m.uid,
          subject: m.subject ?? '(sans sujet)',
          fromName: m.fromName || m.fromEmail || '',
          date: m.date?.toISOString() ?? null,
        });
      }
      groupes.set(cle, g);
    }
  }

  const liste: GroupeDoublon[] = [];
  for (const [key, g] of groupes) {
    if (g.occ.length < 2) continue;
    g.occ.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    liste.push({
      key,
      fileName: g.fileName,
      sizeBytes: g.size,
      count: g.occ.length,
      wastedBytes: g.size * (g.occ.length - 1),
      certitude: g.certitude,
      accounts: [...new Set(g.occ.map((o) => o.account))],
      occurrences: g.occ,
    });
  }
  // Le plus coûteux d'abord ; à gain égal, une certitude passe devant.
  liste.sort(
    (a, b) =>
      b.wastedBytes - a.wastedBytes ||
      (a.certitude === b.certitude ? 0 : a.certitude === 'confirme' ? -1 : 1),
  );

  const confirmes = liste.filter((g) => g.certitude === 'confirme');
  const pending = await db.message.count({
    where: {
      isDeleted: false,
      hasAttachments: true,
      attachmentMeta: null,
      folder: { role: { notIn: ['trash', 'spam'] } },
      ...(opts.account ? { accountSlug: opts.account } : {}),
    },
  });

  return {
    examined: rows.length,
    pending,
    groups: liste.slice(0, limit),
    totals: {
      groups: liste.length,
      extraCopies: liste.reduce((s, g) => s + g.count - 1, 0),
      wastedBytes: liste.reduce((s, g) => s + g.wastedBytes, 0),
      confirmedGroups: confirmes.length,
      confirmedWastedBytes: confirmes.reduce((s, g) => s + g.wastedBytes, 0),
    },
  };
}
