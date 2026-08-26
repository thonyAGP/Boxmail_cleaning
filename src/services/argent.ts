import { db, ensureDbReady } from '../db/client.js';
import { deplie } from './accents.js';

/**
 * « Où est passé mon argent avec X ? » — 26/08.
 *
 * POURQUOI PAR TIERS, ET PAS UN TABLEAU DE BORD GLOBAL (mesuré ce jour-là) :
 * la matière chiffrée existe (2 651 documents en euros posés par l'analyse),
 * mais un total de portefeuille serait FAUX et spectaculairement faux. Le top
 * des montants, vérifié pièce par pièce, contient des annonces immobilières
 * (un château à 2 680 000 €), des budgets de copropriété (756 605,61 € de
 * travaux Foncia), des pesos chiliens (928 054 CLP), et au moins une erreur
 * de lecture (1 654 320 extrait « 654 320 »). Additionner tout cela ne
 * produirait pas un chiffre discutable : un chiffre absurde.
 *
 * En revanche, RESTREINT À UN TIERS et présenté PIÈCE PAR PIÈCE, le même
 * matériau est exact : sur le dossier Legalfree il rend 1 131,26 € en trois
 * reçus, au centime près, ce qu'il a fallu deux heures de fouille manuelle
 * pour établir. On expose donc les pièces, groupées par devise, et jamais un
 * total qui mélangerait des choses de nature différente.
 */

/** Types de documents qui engagent réellement de l'argent. */
const VERSE = new Set(['receipt']);
const FACTURE = new Set(['invoice', 'tax_notice']);
const PROPOSE = new Set(['quote']);

export interface PieceArgent {
  messageId: number;
  accountSlug: string;
  /** Dossier IMAP + UID : de quoi ouvrir le mail dans le lecteur. */
  folder: string;
  uid: number;
  date: string;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  kind: string;
  label: string | null;
  issuer: string | null;
  reference: string | null;
  amount: number;
  currency: string;
  dueDate: string | null;
  certainty: string;
  evidence: string | null;
}

export interface TotalDevise {
  devise: string;
  verse: number;
  facture: number;
  propose: number;
  autre: number;
  nbPieces: number;
}

export interface Completude {
  boite: string;
  lisibles: number;
  total: number;
  taux: number;
}

export interface SuiviTiers {
  recherche: string;
  emetteurs: string[];
  totaux: TotalDevise[];
  pieces: PieceArgent[];
  completude: Completude[];
  avertissements: string[];
}

const normalise = (s: string): string =>
  deplie(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Tiers connus (pour la liste et l'autocomplétion). */
export async function tiersConnus(limit = 60): Promise<
  { libelle: string; nbPieces: number; devises: string[] }[]
> {
  await ensureDbReady();
  const rows = await db.$queryRawUnsafe<
    { issuer: string; n: bigint; devises: string }[]
  >(
    `SELECT d.issuer AS issuer, COUNT(*) AS n,
            GROUP_CONCAT(DISTINCT UPPER(COALESCE(d.currency, 'EUR'))) AS devises
       FROM VerdictDocument d
      WHERE d.amount IS NOT NULL AND d.issuer IS NOT NULL AND TRIM(d.issuer) <> ''
      GROUP BY LOWER(d.issuer)
      ORDER BY n DESC
      LIMIT ?1`,
    limit,
  );
  return rows.map((r) => ({
    libelle: r.issuer,
    nbPieces: Number(r.n),
    devises: (r.devises || 'EUR').split(','),
  }));
}

/**
 * Toutes les pièces chiffrées liées à un tiers. La correspondance se fait sur
 * l'émetteur posé par l'analyse ET sur l'expéditeur du mail : un reçu Stripe
 * porte « Legalfree » en émetteur mais arrive de `invoice+statements@stripe.com`.
 */
export async function suivreTiers(recherche: string): Promise<SuiviTiers> {
  await ensureDbReady();
  const q = normalise(recherche);
  const avertissements: string[] = [];
  if (q.length < 2) {
    return {
      recherche,
      emetteurs: [],
      totaux: [],
      pieces: [],
      completude: [],
      avertissements: ['Saisir au moins deux caractères.'],
    };
  }
  const motif = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const rows = await db.$queryRawUnsafe<
    {
      messageId: number;
      accountSlug: string;
      folder: string;
      uid: number;
      date: number;
      subject: string | null;
      fromName: string | null;
      fromEmail: string | null;
      kind: string;
      label: string | null;
      issuer: string | null;
      reference: string | null;
      amount: number;
      currency: string | null;
      dueDate: number | null;
      certainty: string | null;
      evidence: string | null;
    }[]
  >(
    `SELECT d.messageId, m.accountSlug, f.path AS folder, m.uid, m.date, m.subject,
            m.fromName, m.fromEmail,
            d.kind, d.label, d.issuer, d.reference, d.amount, d.currency,
            d.dueDate, d.certainty, d.evidence
       FROM VerdictDocument d
       JOIN Message m ON m.id = d.messageId
       JOIN Folder f ON f.id = m.folderId
      WHERE d.amount IS NOT NULL
        AND m.isDeleted = 0
        AND ( LOWER(COALESCE(d.issuer, '')) LIKE ?1 ESCAPE '\\'
           OR LOWER(COALESCE(m.fromEmail, '')) LIKE ?1 ESCAPE '\\'
           OR LOWER(COALESCE(m.fromName, '')) LIKE ?1 ESCAPE '\\'
           OR LOWER(COALESCE(m.subject, '')) LIKE ?1 ESCAPE '\\' )
      ORDER BY m.date ASC`,
    motif,
  );

  const pieces: PieceArgent[] = rows.map((r) => ({
    messageId: r.messageId,
    accountSlug: r.accountSlug,
    folder: r.folder,
    uid: Number(r.uid),
    date: new Date(Number(r.date)).toISOString(),
    subject: r.subject,
    fromName: r.fromName,
    fromEmail: r.fromEmail,
    kind: r.kind,
    label: r.label,
    issuer: r.issuer,
    reference: r.reference,
    amount: r.amount,
    currency: (r.currency || 'EUR').toUpperCase(),
    dueDate: r.dueDate ? new Date(Number(r.dueDate)).toISOString() : null,
    certainty: r.certainty || 'unknown',
    evidence: r.evidence,
  }));

  // Totaux PAR DEVISE : mélanger euros et pesos produirait un chiffre faux.
  const parDevise = new Map<string, TotalDevise>();
  for (const p of pieces) {
    const t =
      parDevise.get(p.currency) ??
      { devise: p.currency, verse: 0, facture: 0, propose: 0, autre: 0, nbPieces: 0 };
    if (VERSE.has(p.kind)) t.verse += p.amount;
    else if (FACTURE.has(p.kind)) t.facture += p.amount;
    else if (PROPOSE.has(p.kind)) t.propose += p.amount;
    else t.autre += p.amount;
    t.nbPieces++;
    parDevise.set(p.currency, t);
  }
  const totaux = [...parDevise.values()].sort((a, b) => b.nbPieces - a.nbPieces);
  if (totaux.length > 1) {
    avertissements.push(
      `Plusieurs devises (${totaux.map((t) => t.devise).join(', ')}) : chaque total reste dans la sienne, rien n'est converti.`,
    );
  }

  // COMPLÉTUDE — sur TOUTES les boîtes, pas seulement celles qui ont rendu une
  // pièce. C'est le piège exact du dossier Legalfree (26/08) : le reçu de
  // 1 347,42 € dormait dans une boîte lue à 2,5 %, donc cette boîte ne
  // remontait AUCUNE pièce — et une complétude calculée sur les seules boîtes
  // trouvées l'aurait déclarée hors sujet. Une boîte muette n'est pas une
  // boîte sans pièce : c'est une boîte qu'on n'a pas pu interroger.
  const brut = await db.$queryRawUnsafe<
    { accountSlug: string; total: bigint; lisibles: bigint }[]
  >(
    `SELECT m.accountSlug, COUNT(*) AS total,
            SUM(CASE WHEN m.snippet IS NOT NULL THEN 1 ELSE 0 END) AS lisibles
       FROM Message m JOIN Folder f ON f.id = m.folderId
      WHERE m.isDeleted = 0 AND f.role NOT IN ('trash', 'spam')
      GROUP BY m.accountSlug`,
  );
  const completude: Completude[] = brut
    .map((r) => {
      const total = Number(r.total);
      const lisibles = Number(r.lisibles);
      return {
        boite: r.accountSlug,
        lisibles,
        total,
        taux: total ? Math.round((lisibles / total) * 100) : 0,
      };
    })
    .sort((a, b) => a.taux - b.taux);

  const aveugles = completude.filter((c) => c.taux < 90 && c.total - c.lisibles >= 200);
  const manquants = aveugles.reduce((n, c) => n + (c.total - c.lisibles), 0);
  if (aveugles.length) {
    avertissements.push(
      `Chiffres établis sur une lecture INCOMPLÈTE : ${manquants.toLocaleString('fr-FR')} mails ` +
        `ne sont pas encore lus (${aveugles.map((c) => `${c.boite} ${c.taux} %`).join(', ')}). ` +
        `Des pièces peuvent manquer, y compris des paiements.`,
    );
  }

  const emetteurs = [
    ...new Set(pieces.map((p) => p.issuer).filter((x): x is string => !!x)),
  ].slice(0, 12);

  return { recherche, emetteurs, totaux, pieces, completude, avertissements };
}
