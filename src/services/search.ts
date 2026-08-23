import { db, ensureDbReady } from '../db/client.js';
import {
  resolveMailSemanticState,
  type EtatSemantique,
  type Provenance,
} from './semantique.js';

/**
 * Recherche de mails dans l'INDEX local (L3). Métadonnées uniquement : aucune
 * connexion IMAP, aucune lecture de contenu — instantané même sur des dizaines
 * de milliers de mails. La lecture du corps d'un mail précis passe par
 * imapService.readEmail (route dédiée), jamais par un LLM.
 *
 * LOT 4H (12/08) : la recherche s'appuie sur le modèle sémantique.
 *  - Les ENTITÉS (`EntityMention.nameRaw`) et les CONTEXTES
 *    (`VerdictContext.label`) du verdict sont cherchables : c'est ce qui fait
 *    qu'on retrouve « 46 rue de la République » même quand ni le sujet ni le
 *    texte ne le disent — l'analyse l'a lu, elle, dans le mail entier ;
 *  - chaque résultat porte sa `nature` RÉSOLUE par le socle (précédence
 *    manuel > IA > heuristique, appliquée une seule fois dans semantique.ts)
 *    avec sa provenance — la colonne `intent` n'est plus qu'une façade ;
 *  - `explainMatch` sait dire « trouvé dans une entité citée » : un résultat
 *    ne doit jamais apparaître sans raison.
 *
 * BUDGET : la résolution sémantique se fait EN LOT sur les lignes RETOURNÉES
 * (≤ 500), soit 14 requêtes constantes par appel — jamais proportionnel au
 * nombre de mails de l'index (SQLite connection_limit=1).
 */

/** Longueur de l'extrait renvoyé aux listes (le stockage en garde ~500). */
const SNIPPET_PREVIEW_CHARS = 160;

/**
 * Tronque l'extrait pour l'affichage : une liste peut compter 500 lignes, et
 * envoyer l'extrait complet de chacune gonflerait la réponse sans rien
 * apporter à l'œil. Une chaîne vide (mail sans texte exploitable) devient null.
 */
export function previewSnippet(snippet: string | null | undefined): string | null {
  const s = (snippet ?? '').trim();
  if (!s) return null;
  return s.length > SNIPPET_PREVIEW_CHARS
    ? `${s.slice(0, SNIPPET_PREVIEW_CHARS).trimEnd()}…`
    : s;
}

export interface SearchOptions {
  /** Texte libre : OR sur sujet, adresse et nom d'expéditeur. */
  q?: string;
  /** Restreindre à un compte (slug) ; absent = tous les comptes indexés. */
  account?: string;
  /** Restreindre à un dossier (chemin exact, ex. INBOX). */
  folder?: string;
  /** Filtre expéditeur (fragment d'adresse ou de nom). */
  from?: string;
  /** Filtre sujet (fragment). */
  subject?: string;
  /** Mails reçus après cette date. */
  since?: Date;
  /** Mails reçus avant cette date. */
  before?: Date;
  /** true = non lus uniquement. */
  unseen?: boolean;
  /** true = mails avec pièces jointes uniquement (info posée à la sync). */
  withAttachments?: boolean;
  limit?: number;
}

export interface SearchResultItem {
  account: string;
  folder: string;
  folderRole: string;
  uid: number;
  messageId: number;
  threadId: number | null;
  subject: string;
  fromName: string;
  fromEmail: string;
  date: string | null;
  isSeen: boolean;
  isFlagged: boolean;
  isOutbound: boolean;
  /**
   * FAÇADE legacy (lot 4h) : la valeur de `nature` recopiée pour les écrans
   * qui lisent encore `intent`. Côté serveur, lire `nature` — elle dit d'où
   * la valeur vient.
   */
  intent: string | null;
  /**
   * L'intention RÉSOLUE par le socle sémantique, avec sa provenance et son
   * pourquoi (affichables tels quels). La précédence manuel > IA > heuristique
   * est appliquée UNE fois, dans semantique.ts — plus jamais ici.
   */
  nature: { valeur: string | null; source: Provenance; pourquoi: string } | null;
  /** Entités lues par l'analyse (« 46 rue de la République », « Sosh »…). */
  entites: { kind: string; nameRaw: string; role: string }[];
  /** Dossiers (contextes) cités par l'analyse. */
  contextes: string[];
  hasListUnsubscribe: boolean;
  hasAttachments: boolean;
  attachmentCount: number;
  sizeBytes: number;
  /**
   * Début du texte du mail (C1), tronqué pour l'affichage en liste ; null si
   * le texte n'a pas encore été capturé. L'extrait complet reste en base pour
   * l'analyse — inutile d'envoyer 500 caractères × 500 lignes au navigateur.
   */
  snippet: string | null;
  /** Noms des pièces jointes (11/08) — ce qu'on montre pour « retrouver ». */
  attachmentNames: string[];
  /** Résumé de l'analyse, en français ; null si le mail n'a pas été analysé. */
  summary: string | null;
  /**
   * POURQUOI ce mail ressort (11/08) : sujet, expéditeur, pièce jointe,
   * contenu de la pièce, texte du mail, résumé. Vide si la recherche n'avait
   * pas de texte libre. Reproche constant de l'utilisateur : le produit
   * « n'explique pas pourquoi ».
   */
  matchedIn: string[];
}

export interface SearchResult {
  total: number;
  truncated: boolean;
  items: SearchResultItem[];
}

/**
 * PHASE A de « retrouver » (19/08) — le vivier COMPLET des mails correspondants,
 * en lignes compactes.
 *
 * Pourquoi une requête SQL écrite à la main plutôt que du Prisma : mesuré sur la
 * base de production (41 607 mails), la clause
 * `verdict.mentions.some.nameRaw.contains` que produisait Prisma est traduite en
 * sous-requête CORRÉLÉE — pour CHACUN des 41 607 mails, un scan des 29 039
 * `EntityMention`, soit ~1,2 milliard de comparaisons : **132 763 ms**. Le même
 * LIKE sur la table seule prend 6 ms. Les CTE ci-dessous parcourent les mentions
 * UNE fois : la recherche entière retombe à ~200 ms.
 *
 * Pourquoi pas une pré-requête d'ids passée en `id: { in: [...] }` : au-delà de
 * 999 valeurs, le moteur Prisma ne renvoie pas une erreur mais **panique**
 * (`PrismaClientRustPanicError`, limite SQLite de paramètres) — vérifié : 999
 * passe, 1 000 casse. Le gros ensemble d'ids doit rester DANS SQLite.
 *
 * Pourquoi exhaustif : tant qu'on ne ramenait que les 400 mails les plus
 * récents, on ne classait pas « les interlocuteurs les plus pertinents » mais
 * « les plus pertinents parmi les 400 plus récents » — un résultat fort de 2019
 * était écarté avant même d'être vu. D'où des lignes volontairement maigres
 * (pas d'OCR, pas de résumé) : le pire cas mesuré (« de ») fait 21 605 lignes
 * pour 5 Mo, le cas courant quelques centaines.
 *
 * `mask` dit dans QUELS champs le terme a été vu — il doit être calculé ici :
 * la ligne compacte ne porte plus `attachmentText`, donc « trouvé dans le
 * contenu de la pièce » ne serait plus reconstituable en aval.
 */
export const MATCH_SUJET = 1;
export const MATCH_EXPEDITEUR = 2;
export const MATCH_TEXTE = 4;
export const MATCH_CONTENU_PIECE = 8;
export const MATCH_NOM_PIECE = 16;
export const MATCH_RESUME = 32;
export const MATCH_ENTITE = 64;
export const MATCH_CONTEXTE = 128;

export interface CandidatRecherche {
  id: number;
  account: string;
  date: string | null;
  fromEmail: string;
  fromName: string;
  toEmails: string;
  isOutbound: boolean;
  subject: string;
  attachmentNames: string;
  hasAttachments: boolean;
  /** Union des endroits où AU MOINS un mot cherché a été vu. */
  mask: number;
  /** Combien des mots cherchés ce mail contient (23/08). */
  motsTrouves: number;
  /**
   * Le plus grand nombre de mots réunis dans UN MÊME champ (23/08).
   *
   * Sans ce chiffre, le classement ment dès qu'on cherche plusieurs mots : un
   * mail où « facture » est dans le sujet, « électricité » dans une pièce
   * jointe et « miron » dans un résumé porte trois correspondances sans le
   * moindre rapport entre elles, et son masque le fait passer pour un
   * excellent résultat. Trois mots dans la MÊME phrase, c'est autre chose.
   */
  concentration: number;
}

/**
 * Échappe les jokers LIKE du terme tapé : sans ça, chercher « 100% » ou
 * « devis_2024 » fait de `%` et `_` des jokers et ramène n'importe quoi.
 */
function motifLike(terme: string): string {
  return `%${terme.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Les champs fouillés, groupés par bit de masque (23/08).
 *
 * L'ORDRE COMPTE : SQLite évalue les `OR` de gauche à droite et s'arrête au
 * premier vrai. `subject` et `fromName` sont courts, `attachmentText` porte
 * l'OCR de pièces entières — le mettre en tête ferait payer le pire cas à
 * chaque ligne, alors qu'il est presque toujours inutile de descendre
 * jusque-là.
 *
 * `analysisInput` REJOINT la recherche ici (23/08) : ~2 200 caractères de
 * corps, structure conservée, déjà en base pour l'analyse — mais jamais
 * interrogés jusqu'ici. La recherche se contentait de `snippet`, 500
 * caractères aplatis, absent sur les 6 246 mails envoyés. C'est le plus gros
 * gain de couverture du lot, et il ne coûte pas une ligne de rattrapage.
 */
const CHAMPS_CHERCHES: { colonnes: string[]; bit: number }[] = [
  { colonnes: ['m.subject'], bit: MATCH_SUJET },
  { colonnes: ['m.fromName', 'm.fromEmail'], bit: MATCH_EXPEDITEUR },
  { colonnes: ['m.attachmentNames'], bit: MATCH_NOM_PIECE },
  { colonnes: ['m.aiSummary'], bit: MATCH_RESUME },
  { colonnes: ['m.snippet', 'm.analysisInput'], bit: MATCH_TEXTE },
  { colonnes: ['m.attachmentText'], bit: MATCH_CONTENU_PIECE },
];

/** `col LIKE ?n OR col2 LIKE ?n` pour un champ et un mot donnés. */
const testChamp = (colonnes: string[], n: number): string =>
  colonnes.map((c) => `${c} LIKE ?${n} ESCAPE '\\'`).join(' OR ');

/** Le mot n° n est-il présent quelque part dans ce mail ? */
const presence = (n: number): string =>
  `(${CHAMPS_CHERCHES.map((f) => testChamp(f.colonnes, n)).join(' OR ')}` +
  ` OR m.id IN (SELECT messageId FROM mh${n}) OR m.id IN (SELECT messageId FROM ch${n}))`;

/**
 * La requête du vivier, construite pour N mots (23/08).
 *
 * Elle était figée sur UN motif ; elle est maintenant générée, parce que le
 * nombre de mots change à chaque recherche. Trois invariants tenus par
 * construction :
 *
 *  - **aucune sous-requête corrélée.** Les CTE parcourent `EntityMention` et
 *    `VerdictContext` une fois par mot, jamais une fois par mail — c'est ce
 *    qui avait coûté 132 secondes le 19/08 ;
 *  - **le compte de paramètres reste dérisoire** : N mots (8 au plus) + 3
 *    filtres, très loin des 999 au-delà desquels le moteur panique ;
 *  - **le filtre reste en `AND` court-circuité** dans le cas courant : dès
 *    qu'un mot manque, la ligne est abandonnée sans évaluer les suivants. Le
 *    mode « au moins K mots » (le repli) coûte plus cher, mais il ne se
 *    déclenche que sur une recherche restée vide.
 */
function sqlCandidats(nbMots: number, minMots: number): string {
  const mots = Array.from({ length: nbMots }, (_, i) => i + 1);
  const pAccount = nbMots + 1;
  const pPieces = nbMots + 2;
  const pDepuis = nbMots + 3;

  const cte = mots
    .flatMap((n) => [
      `mh${n} AS (SELECT DISTINCT messageId FROM EntityMention WHERE nameRaw LIKE ?${n} ESCAPE '\\')`,
      `ch${n} AS (SELECT DISTINCT messageId FROM VerdictContext WHERE label LIKE ?${n} ESCAPE '\\')`,
    ])
    .join(',\n     ');

  // Le masque : l'union des endroits où CHACUN des mots a été vu.
  const masque = CHAMPS_CHERCHES.map(
    (f) =>
      `(CASE WHEN ${mots.map((n) => testChamp(f.colonnes, n)).join(' OR ')}` +
      ` THEN ${f.bit} ELSE 0 END)`,
  )
    .concat(
      `(CASE WHEN ${mots.map((n) => `m.id IN (SELECT messageId FROM mh${n})`).join(' OR ')}` +
        ` THEN ${MATCH_ENTITE} ELSE 0 END)`,
      `(CASE WHEN ${mots.map((n) => `m.id IN (SELECT messageId FROM ch${n})`).join(' OR ')}` +
        ` THEN ${MATCH_CONTEXTE} ELSE 0 END)`,
    )
    .join('\n      + ');

  // Combien de mots au même endroit — voir `concentration`.
  const parChamp = CHAMPS_CHERCHES.map(
    (f) => mots.map((n) => `(CASE WHEN ${testChamp(f.colonnes, n)} THEN 1 ELSE 0 END)`).join(' + '),
  );
  const concentration = nbMots > 1 ? `max(${parChamp.join(',\n            ')})` : '1';

  const comptage = mots.map((n) => `(CASE WHEN ${presence(n)} THEN 1 ELSE 0 END)`).join(' + ');
  // Tous les mots exigés : des AND que SQLite abandonne au premier manquant.
  // Repli : la somme, qui doit être calculée en entier — plus lente, et c'est
  // assumé puisqu'on n'y vient qu'après une recherche restée vide.
  const filtre =
    minMots >= nbMots
      ? mots.map((n) => presence(n)).join('\n   AND ')
      : `(${comptage}) >= ${minMots}`;

  return `
WITH ${cte}
SELECT m.id, m.accountSlug, m.date, m.fromEmail, m.fromName, m.toEmails, m.isOutbound,
       m.subject, m.attachmentNames, m.hasAttachments,
        ${masque} AS mask,
       ${comptage} AS motsTrouves,
       ${concentration} AS concentration
FROM Message m
JOIN Folder f ON f.id = m.folderId
WHERE m.isDeleted = 0
  AND f.role NOT IN ('trash', 'drafts')
  AND (?${pAccount} IS NULL OR m.accountSlug = ?${pAccount})
  AND (?${pPieces} = 0 OR m.hasAttachments = 1)
  AND (?${pDepuis} IS NULL OR m.date >= ?${pDepuis})
  AND ${filtre}`;
}

/**
 * Le vivier complet des mails correspondants (corbeille et brouillons exclus).
 *
 * `mots` remplace l'ancien `q` : la phrase est découpée en amont
 * (`termes.ts`), parce que le découpage est une décision produit — quels mots
 * comptent, lesquels sont du bruit — et pas un détail d'accès aux données.
 *
 * `minMots` sert au repli : à défaut, tous les mots sont exigés.
 */
export async function candidatsRecherche(opts: {
  mots: string[];
  minMots?: number;
  account?: string;
  withAttachments?: boolean;
  since?: Date;
}): Promise<CandidatRecherche[]> {
  await ensureDbReady();
  const mots = opts.mots.filter((m) => m.trim().length > 0);
  if (!mots.length) return [];
  const minMots = Math.min(Math.max(opts.minMots ?? mots.length, 1), mots.length);
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    sqlCandidats(mots.length, minMots),
    ...mots.map(motifLike),
    opts.account ?? null,
    opts.withAttachments ? 1 : 0,
    opts.since ? opts.since.toISOString() : null,
  );
  // $queryRaw rend les entiers SQLite en BigInt et les booléens en 0/1 : on
  // remet des types JS ordinaires une bonne fois, ici.
  return rows.map((r) => ({
    id: Number(r.id),
    account: String(r.accountSlug ?? ''),
    date: r.date ? new Date(r.date as string | number | Date).toISOString() : null,
    fromEmail: String(r.fromEmail ?? ''),
    fromName: String(r.fromName ?? ''),
    toEmails: String(r.toEmails ?? ''),
    isOutbound: !!Number(r.isOutbound ?? 0),
    subject: String(r.subject ?? ''),
    attachmentNames: String(r.attachmentNames ?? ''),
    hasAttachments: !!Number(r.hasAttachments ?? 0),
    mask: Number(r.mask ?? 0),
    motsTrouves: Number(r.motsTrouves ?? 0),
    concentration: Number(r.concentration ?? 0),
  }));
}

/**
 * Chacun de ces mots existe-t-il, SEUL, quelque part (23/08) ?
 *
 * Sert au repli : quand une recherche à plusieurs mots ne rend rien, la
 * première chose à savoir est s'il y a un intrus. « facture électricité
 * miron » sans résultat, c'est très différent selon que « miron » n'apparaisse
 * dans aucun mail (il faut le dire, et chercher sans lui) ou que les trois
 * mots existent mais ne se croisent jamais.
 *
 * `LIMIT 1` par mot : on ne veut pas le vivier, juste savoir s'il est vide.
 */
export async function existenceDesMots(
  mots: string[],
  opts: { account?: string; withAttachments?: boolean; since?: Date } = {},
): Promise<boolean[]> {
  await ensureDbReady();
  const out: boolean[] = [];
  for (const mot of mots) {
    const sql = `${sqlCandidats(1, 1)}\nLIMIT 1`;
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      sql,
      motifLike(mot),
      opts.account ?? null,
      opts.withAttachments ? 1 : 0,
      opts.since ? opts.since.toISOString() : null,
    );
    out.push(rows.length > 0);
  }
  return out;
}

/** Les libellés de `matchedIn`, reconstitués depuis le masque calculé en SQL. */
export function libellesDuMasque(mask: number): string[] {
  const out: string[] = [];
  if (mask & MATCH_NOM_PIECE) out.push('pièce jointe');
  if (mask & MATCH_SUJET) out.push('sujet');
  if (mask & MATCH_EXPEDITEUR) out.push('expéditeur');
  if (mask & MATCH_ENTITE) out.push('entité citée');
  if (mask & MATCH_CONTEXTE) out.push('dossier cité');
  if (mask & MATCH_CONTENU_PIECE) out.push('contenu de la pièce');
  if (mask & MATCH_RESUME) out.push('résumé');
  if (mask & MATCH_TEXTE) out.push('texte du mail');
  return out;
}

/**
 * PHASE B : les mails à MONTRER, hydratés en une seule requête (jamais une par
 * carte). Les ids viennent des groupes retenus — au plus quelques centaines,
 * donc très en dessous des 999 paramètres qui font paniquer le moteur.
 */
export async function hydraterMessages(ids: number[]): Promise<Map<number, SearchResultItem>> {
  await ensureDbReady();
  const out = new Map<number, SearchResultItem>();
  if (!ids.length) return out;
  const rows: Awaited<ReturnType<typeof lireLot>> = [];
  for (let i = 0; i < ids.length; i += 500) rows.push(...(await lireLot(ids.slice(i, i + 500))));
  const etats = await resolveMailSemanticState(rows.map((r) => r.id));
  for (const m of rows) {
    out.set(m.id, {
      account: m.accountSlug,
      folder: m.folder.path,
      folderRole: m.folder.role,
      uid: m.uid,
      messageId: m.id,
      threadId: m.threadId,
      subject: m.subject ?? '(sans sujet)',
      fromName: m.fromName ?? '',
      fromEmail: m.fromEmail ?? '',
      date: m.date?.toISOString() ?? null,
      isSeen: m.isSeen,
      isFlagged: m.isFlagged,
      isOutbound: m.isOutbound,
      ...partieSemantique(etats.get(m.id), m.intent),
      hasListUnsubscribe: m.hasListUnsubscribe,
      hasAttachments: m.hasAttachments,
      attachmentCount: m.attachmentCount,
      sizeBytes: m.sizeBytes,
      snippet: previewSnippet(m.snippet),
      attachmentNames: splitNames(m.attachmentNames),
      summary: m.aiSummary ? m.aiSummary.slice(0, 220) : null,
      matchedIn: [],
    });
  }
  return out;
}

function lireLot(ids: number[]) {
  return db.message.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      accountSlug: true,
      uid: true,
      threadId: true,
      subject: true,
      fromName: true,
      fromEmail: true,
      date: true,
      isSeen: true,
      isFlagged: true,
      isOutbound: true,
      intent: true,
      hasListUnsubscribe: true,
      hasAttachments: true,
      attachmentCount: true,
      sizeBytes: true,
      snippet: true,
      attachmentNames: true,
      aiSummary: true,
      folder: { select: { path: true, role: true } },
    },
  });
}

/** Recherche métadata dans l'index, tous comptes si `account` absent. */
export async function searchIndex(opts: SearchOptions): Promise<SearchResult> {
  await ensureDbReady();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  const and: Record<string, unknown>[] = [];
  const q = opts.q?.trim();
  if (q) {
    and.push({
      OR: [
        { subject: { contains: q } },
        { fromEmail: { contains: q.toLowerCase() } },
        { fromName: { contains: q } },
        // Le TEXTE du mail et celui de ses PIÈCES JOINTES (10/08). Demande
        // explicite : « le but est de permettre une recherche rapide même sur
        // des pièces non nommées comme il faut » — un PDF appelé
        // « document(3).pdf » se retrouve par ce qu'il CONTIENT (un numéro de
        // facture, un nom de fournisseur, un montant).
        { snippet: { contains: q } },
        { attachmentText: { contains: q } },
        // Le NOM des pièces jointes (11/08). L'inverse du cas précédent, et
        // de loin le plus fréquent : le mail s'appelle « Votre document est
        // disponible » et c'est la pièce qui s'appelle « quittance_juin.pdf ».
        { attachmentNames: { contains: q } },
        // Le RÉSUMÉ de l'analyse (11/08) : 17 056 mails en ont un, écrit en
        // français. Il porte souvent le mot que cherche Anthony là où le
        // sujet ne dit rien (« relance de la banque sur le prêt Altoen »).
        { aiSummary: { contains: q } },
        // Les ENTITÉS et les CONTEXTES du verdict sémantique (lot 4h). C'est
        // ce qui fait qu'on retrouve « 46 rue de la République » même quand le
        // sujet ne le dit pas : l'analyse a lu le mail entier et a nommé de
        // quoi il parle — la recherche n'a plus qu'à s'en servir.
        { verdict: { is: { mentions: { some: { nameRaw: { contains: q } } } } } },
        { verdict: { is: { contexts: { some: { label: { contains: q } } } } } },
      ],
    });
  }
  const from = opts.from?.trim();
  if (from) {
    and.push({
      OR: [{ fromEmail: { contains: from.toLowerCase() } }, { fromName: { contains: from } }],
    });
  }
  const subject = opts.subject?.trim();
  if (subject) and.push({ subject: { contains: subject } });

  const where = {
    isDeleted: false,
    ...(opts.account ? { accountSlug: opts.account } : {}),
    ...(opts.folder ? { folder: { path: opts.folder } } : {}),
    ...(opts.unseen ? { isSeen: false } : {}),
    ...(opts.withAttachments ? { hasAttachments: true } : {}),
    ...(opts.since || opts.before
      ? {
          date: {
            ...(opts.since ? { gte: opts.since } : {}),
            ...(opts.before ? { lte: opts.before } : {}),
          },
        }
      : {}),
    ...(and.length ? { AND: and } : {}),
  };

  const [total, rows] = await Promise.all([
    db.message.count({ where }),
    db.message.findMany({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        accountSlug: true,
        uid: true,
        threadId: true,
        subject: true,
        fromName: true,
        fromEmail: true,
        date: true,
        isSeen: true,
        isFlagged: true,
        isOutbound: true,
        intent: true,
        hasListUnsubscribe: true,
        hasAttachments: true,
        attachmentCount: true,
        sizeBytes: true,
        snippet: true,
        attachmentNames: true,
        attachmentText: true,
        aiSummary: true,
        folder: { select: { path: true, role: true } },
      },
    }),
  ]);

  // L'état sémantique des lignes RETOURNÉES, résolu en une passe (lot 4h) :
  // 14 requêtes constantes pour ≤ 500 lignes — jamais mail par mail.
  const etats = await resolveMailSemanticState(rows.map((r) => r.id));

  return {
    total,
    truncated: total > rows.length,
    items: rows.map((m) => {
      const sem = partieSemantique(etats.get(m.id), m.intent);
      return {
        account: m.accountSlug,
        folder: m.folder.path,
        folderRole: m.folder.role,
        uid: m.uid,
        messageId: m.id,
        threadId: m.threadId,
        subject: m.subject ?? '(sans sujet)',
        fromName: m.fromName ?? '',
        fromEmail: m.fromEmail ?? '',
        date: m.date?.toISOString() ?? null,
        isSeen: m.isSeen,
        isFlagged: m.isFlagged,
        isOutbound: m.isOutbound,
        ...sem,
        hasListUnsubscribe: m.hasListUnsubscribe,
        hasAttachments: m.hasAttachments,
        attachmentCount: m.attachmentCount,
        sizeBytes: m.sizeBytes,
        snippet: previewSnippet(m.snippet),
        attachmentNames: splitNames(m.attachmentNames),
        summary: m.aiSummary ? m.aiSummary.slice(0, 220) : null,
        matchedIn: explainMatch(q, {
          subject: m.subject,
          fromName: m.fromName,
          fromEmail: m.fromEmail,
          attachmentNames: m.attachmentNames,
          attachmentText: m.attachmentText,
          snippet: m.snippet,
          aiSummary: m.aiSummary,
          entites: sem.entites.map((e) => e.nameRaw),
          contextes: sem.contextes,
        }),
      };
    }),
  };
}

/**
 * La part sémantique d'un item de liste : la nature résolue (avec provenance)
 * et ce que l'analyse a nommé. Quand le mail n'est pas dans la résolution
 * (jamais le cas en pratique — elle porte sur les lignes retournées), la
 * colonne legacy reste la façade et rien n'est inventé.
 *
 * Bornes volontaires (8 entités, 6 contextes) : une liste peut compter 500
 * lignes, on n'envoie au navigateur que de quoi reconnaître, pas l'analyse
 * entière.
 */
function partieSemantique(
  etat: EtatSemantique | undefined,
  intentColonne: string | null,
): Pick<SearchResultItem, 'intent' | 'nature' | 'entites' | 'contextes'> {
  if (!etat) return { intent: intentColonne, nature: null, entites: [], contextes: [] };
  return {
    intent: etat.nature.valeur,
    nature: {
      valeur: etat.nature.valeur,
      source: etat.nature.source,
      pourquoi: etat.nature.pourquoi,
    },
    entites: etat.faits.mentions
      .slice(0, 8)
      .map((x) => ({ kind: x.kind, nameRaw: x.nameRaw, role: x.role })),
    contextes: etat.faits.contextes.slice(0, 6).map((c) => c.label),
  };
}


/** Noms de pièces stockés en une chaîne (un par ligne) → tableau affichable. */
export function splitNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/**
 * Où le terme cherché a-t-il été trouvé ? Renvoyé au navigateur pour que
 * chaque résultat puisse dire « trouvé dans le nom de la pièce jointe »
 * plutôt que d'apparaître sans raison.
 *
 * L'ordre est celui de la CONFIANCE accordée à la correspondance : un mot
 * dans le nom du fichier, dans le sujet ou dans ce que l'ANALYSE a nommé
 * (entité, dossier) est un signal plus fort que le même mot noyé au milieu
 * du texte — c'est aussi ce qui permet de dire pourquoi un mail ressort
 * alors que son sujet ne contient pas le terme.
 */
export function explainMatch(
  q: string | undefined,
  champs: {
    subject?: string | null;
    fromName?: string | null;
    fromEmail?: string | null;
    attachmentNames?: string | null;
    attachmentText?: string | null;
    snippet?: string | null;
    aiSummary?: string | null;
    /** Noms d'entités lus par l'analyse (lot 4h). */
    entites?: string[];
    /** Libellés de dossiers/contextes lus par l'analyse (lot 4h). */
    contextes?: string[];
  },
): string[] {
  const terme = q?.trim().toLowerCase();
  if (!terme) return [];
  const contient = (v: string | null | undefined) => !!v && v.toLowerCase().includes(terme);
  const contientUn = (vs: string[] | undefined) => !!vs && vs.some((v) => contient(v));
  const out: string[] = [];
  if (contient(champs.attachmentNames)) out.push('pièce jointe');
  if (contient(champs.subject)) out.push('sujet');
  if (contient(champs.fromName) || contient(champs.fromEmail)) out.push('expéditeur');
  if (contientUn(champs.entites)) out.push('entité citée');
  if (contientUn(champs.contextes)) out.push('dossier cité');
  if (contient(champs.attachmentText)) out.push('contenu de la pièce');
  if (contient(champs.aiSummary)) out.push('résumé');
  if (contient(champs.snippet)) out.push('texte du mail');
  return out;
}

export interface FolderListing {
  account: string;
  folder: string;
  total: number;
  offset: number;
  items: SearchResultItem[];
}

/**
 * Liste paginée des mails d'un dossier (L5.2 — boîte de réception navigable).
 * Index only : tri date desc, `offset`/`limit` pour la pagination, `total`
 * pour afficher « page X / Y ». Même forme d'items que la recherche.
 */
/**
 * Boîte de réception UNIFIÉE (L5.6) : les INBOX de tous les comptes, triées
 * par date décroissante, paginées. Même forme d'items que listFolderMessages
 * (chaque item porte son account/folder/uid → lecture et actions OK).
 */
export type FolderSort = 'date' | 'from' | 'subject';

/** Tri des listes de dossier (L5.10) : date (défaut), expéditeur ou sujet. */
function folderOrderBy(sort: FolderSort | undefined, dir: 'asc' | 'desc') {
  if (sort === 'from') return [{ fromEmail: dir }, { id: dir }] as const;
  if (sort === 'subject') return [{ subject: dir }, { id: dir }] as const;
  return [{ date: dir }, { id: dir }] as const;
}

// 'flagged' = pseudo-rôle : tous les mails suivis (⭐), quel que soit le dossier
// (corbeille et spam exclus).
/** Clause OR sujet/adresse/nom pour le filtre rapide des listes de dossiers. */
function quickTextFilter(q: string | undefined) {
  const t = q?.trim();
  if (!t) return {};
  return {
    OR: [
      { subject: { contains: t } },
      { fromEmail: { contains: t.toLowerCase() } },
      { fromName: { contains: t } },
      // Cherche aussi DANS les pièces jointes : une facture nommée
      // « document(3).pdf » se retrouve par son contenu (10/08).
      { attachmentText: { contains: t } },
      // …et dans ce que l'analyse a NOMMÉ (lot 4h) : le filtre rapide doit
      // retrouver « 46 rue de la République » même quand le sujet se tait.
      { verdict: { is: { mentions: { some: { nameRaw: { contains: t } } } } } },
      { verdict: { is: { contexts: { some: { label: { contains: t } } } } } },
    ],
  };
}

export const UNIFIED_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'archive', 'spam', 'flagged'] as const;
export type UnifiedRole = (typeof UNIFIED_ROLES)[number];

export async function listUnifiedInbox(
  opts: {
    offset?: number;
    limit?: number;
    unseen?: boolean;
    withAttachments?: boolean;
    sort?: FolderSort;
    dir?: 'asc' | 'desc';
    /** Rôle de dossier agrégé sur toutes les boîtes (défaut : inbox). */
    role?: UnifiedRole;
    /** Filtre texte rapide : sujet, adresse ou nom d'expéditeur (L5.18). */
    q?: string;
  } = {},
): Promise<FolderListing> {
  await ensureDbReady();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const role = opts.role ?? 'inbox';
  const where = {
    isDeleted: false,
    ...(role === 'flagged'
      ? { isFlagged: true, folder: { is: { role: { notIn: ['trash', 'spam'] } } } }
      : { folder: { is: { role } } }),
    ...(opts.unseen ? { isSeen: false } : {}),
    ...(opts.withAttachments ? { hasAttachments: true } : {}),
    ...quickTextFilter(opts.q),
  };
  const [total, rows] = await Promise.all([
    db.message.count({ where }),
    db.message.findMany({
      where,
      orderBy: [...folderOrderBy(opts.sort, opts.dir ?? 'desc')],
      skip: offset,
      take: limit,
      select: {
        id: true,
        accountSlug: true,
        uid: true,
        threadId: true,
        subject: true,
        fromName: true,
        fromEmail: true,
        date: true,
        isSeen: true,
        isFlagged: true,
        isOutbound: true,
        intent: true,
        hasListUnsubscribe: true,
        hasAttachments: true,
        attachmentCount: true,
        sizeBytes: true,
        snippet: true,
        attachmentNames: true,
        aiSummary: true,
        folder: { select: { path: true, role: true } },
      },
    }),
  ]);
  // Nature résolue et entités pour la page affichée (≤ 200 lignes) : 14
  // requêtes constantes par vue — le socle décide, la colonne reste une façade.
  const etats = await resolveMailSemanticState(rows.map((r) => r.id));
  return {
    account: '',
    folder: `(toutes les boîtes · ${role})`,
    total,
    offset,
    items: rows.map((m) => ({
      account: m.accountSlug,
      folder: m.folder.path,
      folderRole: m.folder.role,
      uid: m.uid,
      messageId: m.id,
      threadId: m.threadId,
      subject: m.subject ?? '(sans sujet)',
      fromName: m.fromName ?? '',
      fromEmail: m.fromEmail ?? '',
      date: m.date?.toISOString() ?? null,
      isSeen: m.isSeen,
      isFlagged: m.isFlagged,
      isOutbound: m.isOutbound,
      ...partieSemantique(etats.get(m.id), m.intent),
      hasListUnsubscribe: m.hasListUnsubscribe,
      hasAttachments: m.hasAttachments,
      attachmentCount: m.attachmentCount,
      sizeBytes: m.sizeBytes,
      snippet: previewSnippet(m.snippet),
      // Le nom des pieces sert AUSSI dans les listes de dossier : c'est
      // souvent lui qui dit ce qu'un mail contient (11/08).
      attachmentNames: splitNames(m.attachmentNames),
      summary: m.aiSummary ? m.aiSummary.slice(0, 220) : null,
      matchedIn: [],
    })),
  };
}

export async function listFolderMessages(
  account: string,
  folder: string,
  opts: {
    offset?: number;
    limit?: number;
    unseen?: boolean;
    withAttachments?: boolean;
    sort?: FolderSort;
    dir?: 'asc' | 'desc';
    /** Filtre texte rapide : sujet, adresse ou nom d'expéditeur (L5.18). */
    q?: string;
  } = {},
): Promise<FolderListing> {
  await ensureDbReady();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = {
    accountSlug: account,
    isDeleted: false,
    folder: { path: folder },
    ...(opts.unseen ? { isSeen: false } : {}),
    ...(opts.withAttachments ? { hasAttachments: true } : {}),
    ...quickTextFilter(opts.q),
  };
  const [total, rows] = await Promise.all([
    db.message.count({ where }),
    db.message.findMany({
      where,
      orderBy: [...folderOrderBy(opts.sort, opts.dir ?? 'desc')],
      skip: offset,
      take: limit,
      select: {
        id: true,
        accountSlug: true,
        uid: true,
        threadId: true,
        subject: true,
        fromName: true,
        fromEmail: true,
        date: true,
        isSeen: true,
        isFlagged: true,
        isOutbound: true,
        intent: true,
        hasListUnsubscribe: true,
        hasAttachments: true,
        attachmentCount: true,
        sizeBytes: true,
        snippet: true,
        attachmentNames: true,
        aiSummary: true,
        folder: { select: { path: true, role: true } },
      },
    }),
  ]);
  // Même régime que la boîte unifiée : la nature vient du socle, en lot.
  const etats = await resolveMailSemanticState(rows.map((r) => r.id));
  return {
    account,
    folder,
    total,
    offset,
    items: rows.map((m) => ({
      account: m.accountSlug,
      folder: m.folder.path,
      folderRole: m.folder.role,
      uid: m.uid,
      messageId: m.id,
      threadId: m.threadId,
      subject: m.subject ?? '(sans sujet)',
      fromName: m.fromName ?? '',
      fromEmail: m.fromEmail ?? '',
      date: m.date?.toISOString() ?? null,
      isSeen: m.isSeen,
      isFlagged: m.isFlagged,
      isOutbound: m.isOutbound,
      ...partieSemantique(etats.get(m.id), m.intent),
      hasListUnsubscribe: m.hasListUnsubscribe,
      hasAttachments: m.hasAttachments,
      attachmentCount: m.attachmentCount,
      sizeBytes: m.sizeBytes,
      snippet: previewSnippet(m.snippet),
      // Le nom des pieces sert AUSSI dans les listes de dossier : c'est
      // souvent lui qui dit ce qu'un mail contient (11/08).
      attachmentNames: splitNames(m.attachmentNames),
      summary: m.aiSummary ? m.aiSummary.slice(0, 220) : null,
      matchedIn: [],
    })),
  };
}

/**
 * Revalide une sélection d'UIDs contre l'index d'un dossier : ne garde que
 * les mails réellement présents, et retourne leurs sujets/dates pour le
 * journal. Garde-fou des actions en masse de l'interface.
 */
export async function validateUids(
  account: string,
  folder: string,
  uids: number[],
): Promise<{ uids: number[]; items: { subject: string; date: string | null; uid: number }[] }> {
  await ensureDbReady();
  const valid: number[] = [];
  // L'UID est renvoyé avec chaque item : l'appelant décide s'il le journalise
  // (mail resté en place ⇒ ouvrable depuis le journal) ou non (mail déplacé).
  const items: { subject: string; date: string | null; uid: number }[] = [];
  for (let i = 0; i < uids.length; i += 500) {
    const rows = await db.message.findMany({
      where: {
        accountSlug: account,
        isDeleted: false,
        uid: { in: uids.slice(i, i + 500) },
        folder: { path: folder },
      },
      select: { uid: true, subject: true, date: true },
    });
    for (const r of rows) {
      valid.push(r.uid);
      items.push({
        subject: r.subject ?? '(sans sujet)',
        date: r.date?.toISOString() ?? null,
        uid: r.uid,
      });
    }
  }
  return { uids: valid, items };
}

/** Variante en masse de reflectActionInIndex (une requête par lot de 500). */
export async function reflectBulkInIndex(
  account: string,
  folder: string,
  uids: number[],
  action: 'delete' | 'move' | 'seen' | 'unseen',
): Promise<void> {
  await ensureDbReady();
  const data =
    action === 'delete' || action === 'move'
      ? { isDeleted: true }
      : { isSeen: action === 'seen' };
  for (let i = 0; i < uids.length; i += 500) {
    await db.message.updateMany({
      where: { accountSlug: account, uid: { in: uids.slice(i, i + 500) }, folder: { path: folder } },
      data,
    });
  }
}

/**
 * Annulation d'une suppression : les mails sont revenus dans leur dossier
 * d'origine, avec de NOUVEAUX UIDs (un déplacement IMAP renumérote). On
 * réveille les lignes de l'index (isDeleted=false) et on repointe leur UID
 * quand le serveur nous l'a donné, pour que l'écran redevienne juste
 * immédiatement — la sync suivante réconcilie de toute façon.
 * Chaque ligne est traitée à part : une collision d'UID (contrainte
 * folderId+uid) ne doit pas faire échouer la restauration entière.
 */
export async function reflectRestoreInIndex(
  account: string,
  folder: string,
  pairs: { oldUid: number; newUid?: number }[],
): Promise<number> {
  await ensureDbReady();
  let restored = 0;
  for (const { oldUid, newUid } of pairs) {
    try {
      const row = await db.message.findFirst({
        where: { accountSlug: account, uid: oldUid, folder: { path: folder } },
        select: { id: true },
      });
      if (!row) continue;
      await db.message.update({
        where: { id: row.id },
        data: { isDeleted: false, ...(newUid && newUid !== oldUid ? { uid: newUid } : {}) },
      });
      restored++;
    } catch {
      // UID déjà pris (la sync est passée avant nous) : la ligne existe déjà
      // sous sa nouvelle identité, il n'y a rien à réveiller.
    }
  }
  return restored;
}

/**
 * Métadonnées d'un mail de l'index (pour journaliser les actions de l'interface
 * avec le sujet/la date exacts, et vérifier que le mail visé existe bien).
 */
export async function indexedMessage(
  account: string,
  folder: string,
  uid: number,
): Promise<{
  id: number;
  subject: string;
  date: string | null;
  isSeen: boolean;
  sizeBytes: number;
} | null> {
  await ensureDbReady();
  const m = await db.message.findFirst({
    where: { accountSlug: account, uid, isDeleted: false, folder: { path: folder } },
    select: { id: true, subject: true, date: true, isSeen: true, sizeBytes: true },
  });
  if (!m) return null;
  return {
    id: m.id,
    subject: m.subject ?? '(sans sujet)',
    date: m.date?.toISOString() ?? null,
    isSeen: m.isSeen,
    sizeBytes: m.sizeBytes,
  };
}

/**
 * Répercute dans l'index une action faite via l'interface, sans attendre la
 * prochaine sync : suppression (soft) → isDeleted, lu/non lu → isSeen.
 * L'index reste un cache : la sync suivante réconcilie l'état réel.
 */
export async function reflectActionInIndex(
  account: string,
  folder: string,
  uid: number,
  action: 'delete' | 'move' | 'seen' | 'unseen' | 'flag' | 'unflag',
): Promise<void> {
  await ensureDbReady();
  const data =
    action === 'delete' || action === 'move' ? { isDeleted: true }
    : action === 'flag' || action === 'unflag' ? { isFlagged: action === 'flag' }
    : { isSeen: action === 'seen' };
  await db.message.updateMany({
    where: { accountSlug: account, uid, folder: { path: folder } },
    data,
  });
}
