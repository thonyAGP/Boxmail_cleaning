import { db, ensureDbReady } from '../db/client.js';
import { listAccountNames } from './accounts.js';
import { getUnansweredEmails, type ReplyItem } from './attention.js';
import { getFollowupsDue, type FollowupItem } from './followups.js';
import { getImportantEmails, type ImportantItem } from './importance.js';
import { listDeadlines, type DeadlineItem } from './deadlines.js';
import { previewSnippet } from './search.js';
import { logger } from '../logger.js';
import {
  resolveMailSemanticState,
  getOpenActions,
  type EtatSemantique,
} from './semantique.js';

/**
 * Accueil « Aujourd'hui » (A2 — Cap V3). L'utilisateur ne voit plus des mails
 * mais des ACTIONS : à faire, important, peut attendre, bruit. Agrégat
 * index-only multi-comptes qui RÉUTILISE les moteurs existants (réponses,
 * relances, échéances, importance). Un compte en erreur est signalé sans
 * casser l'accueil.
 *
 * LOT 4G (12/08) : cet écran CONSOMME, il n'interprète plus.
 *  - `NEVER_REPLY_INTENTS` a disparu : le moteur des réponses (lot 4d) décide
 *    déjà — verdict d'abord, heuristiques en repli — re-filtrer ici, c'était
 *    ré-interpréter par-dessus ;
 *  - « factures à traiter » (intent = 'invoice') est devenu « actions de
 *    PAIEMENT encore ouvertes » : « contient une facture » est un FAIT,
 *    « facture encore à payer » est un ÉTAT — seul le second est une action ;
 *  - le bruit s'appuie sur le verdict quand il existe (voir NOISE_BUCKET_CASE) ;
 *  - UNE carte par mail : échéance > réponse > paiement (`uneCarteParMail`).
 *
 * BUDGET DE REQUÊTES : generateToday tourne à CHAQUE ouverture de l'accueil.
 * Tout est résolu EN LOT (jamais mail par mail — SQLite connection_limit=1) :
 * ~46 requêtes par compte via les moteurs (dont 2 × 14 de résolution en lot),
 * et ~18 globales (dont les 14, constantes, du lot « paiements ouverts »).
 * Rien ici n'est proportionnel au nombre de mails.
 */

export type NoiseBucket = 'newsletter' | 'notification' | 'social' | 'promo';

export const NOISE_BUCKETS: NoiseBucket[] = ['newsletter', 'notification', 'social', 'promo'];

// GARDE-FOU (retour utilisateur 10/07) : un mail reçu ces N derniers jours
// n'est JAMAIS du « bruit » supprimable — une newsletter d'aujourd'hui peut
// encore être lue. Appliqué aux compteurs ET à l'aperçu/suppression.
export const NOISE_MIN_AGE_DAYS = 7;

// Affectation d'un mail de la boîte de réception à un « bruit » (disjoint —
// l'ordre du CASE fait foi).
//
// LE SOCLE PRIME QUAND LE VERDICT EXISTE (lot 4g) — en SQL, parce que ce CASE
// balaie TOUTE la boîte de réception à chaque ouverture de l'accueil (résoudre
// 25 000 états en mémoire ici serait un contresens de budget) :
//  · un mail dont l'analyse déclare une action de l'UTILISATEUR n'est JAMAIS
//    du bruit — la demande de réservation Airbnb voyage avec un List-Unsubscribe
//    et vient d'un expéditeur classé « notification », elle n'en est pas moins
//    à traiter (même angle mort que les 48 mails no-reply du 11/08) ;
//  · c'est ensuite la FONCTION du message lue par l'analyse qui range :
//    marketing → pub (ou newsletter/réseau social si la catégorie d'expéditeur
//    l'affine), notification à attention éteinte → notification. Tout le reste
//    (document, transaction, sécurité, fenêtre encore vivante ou illisible en
//    SQL) reste HORS bruit : dans le doute, on protège — jamais l'inverse.
// Sans verdict : les heuristiques historiques (catégorie d'expéditeur résolue
// par la sync avec sa précédence, intent legacy), à l'identique.
const NOISE_BUCKET_CASE = `CASE
  -- LE BON DISCRIMINANT est l'existence d'un verdict SÉMANTIQUE, pas
  -- `aiVerdictAt` : cette colonne est posée par l'ANCIENNE analyse plate sur
  -- 17 207 mails qui n'ont aucune ligne MailVerdict. Les tester avec
  -- `aiVerdictAt` les faisait tomber ENTRE les deux chemins — trop « analysés »
  -- pour le repli, sans aucune donnée pour le nouveau. Le banc l'a vu tout de
  -- suite : 51,8 % → 52,9 % de fuite (12/08).
  WHEN EXISTS (SELECT 1 FROM MailVerdict v WHERE v.messageId = m.id) THEN CASE
    WHEN EXISTS (SELECT 1 FROM VerdictAction va WHERE va.messageId = m.id AND va.actor = 'user') THEN NULL
    WHEN EXISTS (SELECT 1 FROM MailVerdict v WHERE v.messageId = m.id AND v.purpose = 'marketing')
      THEN (CASE WHEN s.category IN ('newsletter', 'social') THEN s.category ELSE 'promo' END)
    WHEN EXISTS (SELECT 1 FROM MailVerdict v WHERE v.messageId = m.id AND v.purpose = 'notification' AND v.attentionMode = 'none') THEN 'notification'
    ELSE NULL END
  WHEN s.category = 'newsletter' THEN 'newsletter'
  WHEN s.category = 'notification' THEN 'notification'
  WHEN s.category = 'social' THEN 'social'
  WHEN s.category = 'ad' OR m.intent = 'promo' THEN 'promo'
  ELSE NULL END`;

export interface InvoiceItem {
  account: string;
  folder: string;
  uid: number;
  /** id interne (colonne Message.id) — sert au dédoublonnage des cartes. */
  messageId: number;
  subject: string;
  fromEmail: string;
  fromName: string | null;
  date: string | null;
  isSeen: boolean;
  reason: string;
}

/**
 * L'action de PAIEMENT encore ouverte d'un mail, ou null. Fonction PURE
 * (le banc l'éprouve avec des états résolus en mémoire).
 *
 * C'est le remplaçant du bloc « intent = 'invoice' » : seule une action `pay`
 * de l'UTILISATEUR que rien n'a soldée compte — pas un mot dans un sujet.
 * Une fenêtre passée (`horsDelai`) ou une action soldée (répondu, tâche
 * faite) ne remontent jamais dans la vue du jour ; un `dueAt` dépassé, si :
 * c'est un RETARD, pas une résolution.
 */
export function paiementOuvert(
  etat: EtatSemantique | null | undefined,
): { pourquoi: string } | null {
  if (!etat?.analyse.verdictPresent) return null;
  const pay = getOpenActions(etat).filter((a) => a.fait.kind === 'pay');
  if (pay.length === 0) return null;
  const a = pay[0];
  const montant =
    a.fait.montant !== null
      ? ` (${a.fait.montant.toFixed(2).replace('.', ',')} ${a.fait.devise ?? '€'})`
      : '';
  const quand = a.enRetard
    ? ' — échéance dépassée, en retard, pas résolue'
    : a.fait.dueAt
      ? ` — à régler avant le ${a.fait.dueAt.toLocaleDateString('fr-FR')}`
      : '';
  return {
    pourquoi: `l'analyse du mail déclare un paiement encore à faire de ta part : « ${a.fait.label ?? 'paiement'} »${montant}${quand}`,
  };
}

/**
 * UNE carte par mail (lot 4g) : un mail déjà présenté par une famille
 * prioritaire ne réapparaît pas dans une famille suivante. L'ordre choisi —
 * échéance > réponse > paiement — va du plus qualifié (date + cycle de vie +
 * geste validables) au plus générique ; et sans lui, chaque action `pay`
 * datée ferait DEUX cartes, puisque la détection d'échéances (lot 4c) crée
 * déjà une Deadline à partir de la même action.
 */
export function uneCarteParMail<R extends { messageId: number }>(
  prioritaires: { messageId: number }[],
  suivants: R[],
): R[] {
  const pris = new Set(prioritaires.map((x) => x.messageId));
  return suivants.filter((x) => !pris.has(x.messageId));
}

export interface NoiseBucketStat {
  bucket: NoiseBucket;
  count: number;
  unseen: number;
  sizeBytes: number;
}

export interface TodaySummary {
  generatedAt: string;
  accounts: string[];
  skippedAccounts: { account: string; error: string }[];
  todo: {
    replies: ReplyItem[];
    followups: FollowupItem[];
    deadlines: DeadlineItem[];
    invoices: InvoiceItem[];
    total: number;
    /** Actions réellement présentes dans les listes (= ce que le parcours traitera). */
    queued: number;
  };
  important: ImportantItem[];
  canWait: { count: number; unseen: number };
  noise: { buckets: NoiseBucketStat[]; total: number; sizeBytes: number };
  /** false = catégories A1 jamais calculées → proposer le recalcul. */
  categorized: boolean;
}

const TOP = 10;

/** Agrégat « Aujourd'hui » sur tous les comptes enrôlés. */
export async function generateToday(): Promise<TodaySummary> {
  await ensureDbReady();
  const names = await listAccountNames();
  const skipped: { account: string; error: string }[] = [];
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const replies: ReplyItem[] = [];
  const followups: FollowupItem[] = [];
  const deadlines: DeadlineItem[] = [];
  const important: ImportantItem[] = [];

  for (const name of names) {
    try {
      const r = await getUnansweredEmails(name, { sinceDays: 60, limit: 100 });
      replies.push(...r.items.filter((i) => i.state === 'active'));
      const f = await getFollowupsDue(name, { sinceDays: 60, limit: 100 });
      followups.push(...f.items.filter((i) => i.state === 'active'));
      const d = await listDeadlines(name, { toDate: endOfToday.toISOString(), limit: 100 });
      deadlines.push(
        ...d.filter(
          (x) =>
            (x.status === 'proposed' || x.status === 'confirmed') &&
            // échéances dépassées : on remonte 90 j max (au-delà = du passé, pas une action)
            x.inDays >= -90,
        ),
      );
      const imp = await getImportantEmails(name, { sinceDays: 7, minScore: 70, limit: 20 });
      important.push(...imp.items);
    } catch (err) {
      skipped.push({ account: name, error: (err as Error).message });
      logger.warn('aujourd’hui : compte ignoré', { account: name, error: (err as Error).message });
    }
  }

  // Plus AUCUN re-filtrage des réponses ici (lot 4g — NEVER_REPLY_INTENTS
  // supprimé) : getUnansweredEmails décide déjà, verdict d'abord et
  // heuristiques en repli. Re-filtrer sur `intent` par-dessus, c'était
  // exactement le montage rustine que la refonte interdit — et il aurait
  // fait taire un verdict « réponse attendue » sur un mail de confirmation.

  // Les plus en retard d'abord ; échéances par date croissante.
  replies.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.waitingHours - a.waitingHours);
  followups.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.waitingHours - a.waitingHours);
  deadlines.sort((a, b) => a.inDays - b.inDays);
  important.sort((a, b) => b.score - a.score);

  // Paiements à faire (lot 4g). Deux régimes, comme partout depuis 4c :
  //  1. le VERDICT : présélection SQL bornée (mails d'inbox dont l'analyse a
  //     déclaré une action `pay` de l'utilisateur, 90 j), puis le socle
  //     tranche l'ouverture EN LOT — 14 requêtes constantes, jamais mail par
  //     mail ;
  //  2. le REPLI (mails jamais analysés) : l'ancien critère « intention
  //     facture, non lu, 30 j », inchangé, et la raison avoue le repli.
  type PayRow = {
    id: number;
    account: string;
    folder: string;
    uid: number;
    subject: string | null;
    fromEmail: string | null;
    fromName: string | null;
    date: string | number | bigint | null;
    isSeen: number;
  };
  const payRows = await db.$queryRawUnsafe<PayRow[]>(
    `SELECT DISTINCT m.id, m.accountSlug AS account, f.path AS folder, m.uid, m.subject,
            m.fromEmail, m.fromName, m.date, m.isSeen
     FROM Message m
     JOIN Folder f ON f.id = m.folderId
     JOIN VerdictAction va ON va.messageId = m.id
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'
       AND va.kind = 'pay' AND va.actor = 'user'
       AND m.date >= ?
     ORDER BY m.date DESC LIMIT 50`,
    new Date(Date.now() - 90 * 86_400_000).getTime(),
  );
  const etatsPay = await resolveMailSemanticState(payRows.map((r) => r.id));
  const invoices: InvoiceItem[] = [];
  for (const r of payRows) {
    const paiement = paiementOuvert(etatsPay.get(r.id));
    if (!paiement) continue; // soldé, hors délai, ou pas à lui : pas une action
    invoices.push({
      account: r.account,
      folder: r.folder,
      uid: r.uid,
      messageId: r.id,
      subject: r.subject ?? '(sans sujet)',
      fromEmail: r.fromEmail ?? '',
      fromName: r.fromName,
      date: rawDate(r.date),
      isSeen: r.isSeen === 1,
      reason: paiement.pourquoi,
    });
  }
  type InvoiceRow = PayRow & { intentReason: string | null };
  const invoiceRows = await db.$queryRawUnsafe<InvoiceRow[]>(
    `SELECT m.id, m.accountSlug AS account, f.path AS folder, m.uid, m.subject,
            m.fromEmail, m.fromName, m.date, m.isSeen, m.intentReason
     FROM Message m JOIN Folder f ON f.id = m.folderId
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'
       AND NOT EXISTS (SELECT 1 FROM MailVerdict v WHERE v.messageId = m.id)
       AND m.intent = 'invoice' AND m.isSeen = 0
       AND m.date >= ?
     ORDER BY m.date DESC LIMIT ${TOP}`,
    new Date(Date.now() - 30 * 86_400_000).getTime(),
  );
  invoices.push(
    ...invoiceRows.map((r) => ({
      account: r.account,
      folder: r.folder,
      uid: r.uid,
      messageId: r.id,
      subject: r.subject ?? '(sans sujet)',
      fromEmail: r.fromEmail ?? '',
      fromName: r.fromName,
      date: rawDate(r.date),
      isSeen: r.isSeen === 1,
      reason: `${r.intentReason ?? 'facture détectée dans le sujet'} — repli, pas encore de verdict d'analyse`,
    })),
  );

  // UNE carte par mail : un mail déjà présenté comme échéance ne redevient ni
  // « réponse attendue » ni « paiement » ; un mail « réponse attendue » ne
  // redevient pas « paiement ». Voir uneCarteParMail pour l'ordre choisi.
  const deadlinesCartes = deadlines.map((d) => ({ messageId: d.messageId }));
  const repliesUniques = uneCarteParMail(deadlinesCartes, replies);
  const invoicesUniques = uneCarteParMail(
    [...deadlinesCartes, ...repliesUniques],
    invoices,
  ).slice(0, TOP);

  // Bruit : compteurs par catégorie sur toutes les boîtes de réception.
  // Un mail récent (< NOISE_MIN_AGE_DAYS) n'est PAS du bruit : il bascule
  // dans « peut attendre » (bucket NULL) au lieu d'être supprimable.
  const noiseCutoff = Date.now() - NOISE_MIN_AGE_DAYS * 86_400_000;
  type NoiseRow = { bucket: string | null; cnt: bigint; unseen: bigint; size: bigint | null };
  const noiseRows = await db.$queryRawUnsafe<NoiseRow[]>(
    `SELECT CASE WHEN m.date >= ? THEN NULL ELSE (${NOISE_BUCKET_CASE}) END AS bucket,
            COUNT(*) AS cnt,
            SUM(CASE WHEN m.isSeen = 0 THEN 1 ELSE 0 END) AS unseen,
            SUM(m.sizeBytes) AS size
     FROM Message m
     JOIN Folder f ON f.id = m.folderId
     LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'
     GROUP BY bucket`,
    noiseCutoff,
  );
  const buckets: NoiseBucketStat[] = NOISE_BUCKETS.map((b) => {
    const row = noiseRows.find((r) => r.bucket === b);
    return {
      bucket: b,
      count: Number(row?.cnt ?? 0),
      unseen: Number(row?.unseen ?? 0),
      sizeBytes: Number(row?.size ?? 0),
    };
  });
  const quiet = noiseRows.find((r) => r.bucket === null);

  // Peut attendre : les non-lus de l'inbox qui ne sont NI du bruit NI déjà
  // dans « à faire » (approximation : hors factures — les réponses attendues
  // s'y retrouvent mais restent peu nombreuses).
  type CanWaitRow = { cnt: bigint };
  const canWaitRows = await db.$queryRawUnsafe<CanWaitRow[]>(
    `SELECT COUNT(*) AS cnt
     FROM Message m
     JOIN Folder f ON f.id = m.folderId
     LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'
       AND m.isSeen = 0
       AND ((${NOISE_BUCKET_CASE}) IS NULL OR m.date >= ?)
       -- Ce qui est déjà compté ailleurs (« à payer ») ne compte pas ici.
       -- Le verdict d'abord ; l'intention legacy seulement pour les mails
       -- qui n'en ont pas encore — sinon un mail portant une action de
       -- paiement ouverte serait rangé dans « peut attendre » parce que son
       -- ancienne étiquette disait « info ».
       AND NOT EXISTS (
         SELECT 1 FROM VerdictAction va
          WHERE va.messageId = m.id AND va.kind = 'pay' AND va.actor = 'user')
       AND (EXISTS (SELECT 1 FROM MailVerdict v WHERE v.messageId = m.id)
            OR m.intent IS NULL OR m.intent != 'invoice')`,
    noiseCutoff,
  );

  const categorizedCount = await db.sender.count({ where: { category: { not: null } } });

  return {
    generatedAt: new Date().toISOString(),
    accounts: names,
    skippedAccounts: skipped,
    todo: {
      replies: repliesUniques.slice(0, TOP),
      followups: followups.slice(0, TOP),
      deadlines: deadlines.slice(0, TOP),
      invoices: invoicesUniques,
      // Totaux sur les listes DÉDOUBLONNÉES : un mail = une carte, donc un
      // seul point dans le compte (sinon « 52 actions » en contenait 3 fois
      // certaines — même famille d'incohérence que le 10/08).
      total: repliesUniques.length + followups.length + deadlines.length + invoicesUniques.length,
      // Ce que le parcours « Commencer » pourra RÉELLEMENT traiter : les
      // listes sont plafonnées à TOP par famille. Sans ce chiffre, l'écran
      // annonçait « ≈ 78 min » pour 52 actions et le parcours disait
      // « Action 1 sur 35 » (incohérence signalée le 10/08).
      queued:
        Math.min(repliesUniques.length, TOP) +
        Math.min(followups.length, TOP) +
        Math.min(deadlines.length, TOP) +
        invoicesUniques.length,
    },
    important: important.slice(0, 5),
    canWait: {
      count: Number(quiet?.cnt ?? 0),
      unseen: Number(canWaitRows[0]?.cnt ?? 0),
    },
    noise: {
      buckets,
      total: buckets.reduce((s, b) => s + b.count, 0),
      sizeBytes: buckets.reduce((s, b) => s + b.sizeBytes, 0),
    },
    categorized: categorizedCount > 0,
  };
}

export interface NoisePreview {
  bucket: NoiseBucket;
  total: number;
  truncated: boolean;
  items: {
    account: string;
    folder: string;
    uid: number;
    subject: string;
    fromEmail: string;
    fromName: string | null;
    date: string | null;
    isSeen: boolean;
    /** Début du texte du mail (C1) — null s'il n'a pas encore été capturé. */
    snippet: string | null;
  }[];
}

const PREVIEW_CAP = 500;

/**
 * Liste EXACTE des mails d'un « bruit » (aperçu avant toute action —
 * garde-fou Cap V3 : rien n'est supprimé sans que la liste ait été montrée).
 * Cap 500 : l'interface le signale et propose de recommencer.
 */
export async function listNoiseMessages(bucket: NoiseBucket): Promise<NoisePreview> {
  await ensureDbReady();
  if (!NOISE_BUCKETS.includes(bucket)) throw new Error(`Bruit inconnu : ${bucket}`);
  type Row = {
    account: string;
    folder: string;
    uid: number;
    subject: string | null;
    fromEmail: string | null;
    fromName: string | null;
    date: string | number | bigint | null;
    isSeen: number;
    snippet: string | null;
  };
  // Même garde-fou que les compteurs : jamais un mail des NOISE_MIN_AGE_DAYS
  // derniers jours. Tri ASC : le lot (cap 500) traite les PLUS ANCIENS
  // d'abord — on ne supprime pas la newsletter reçue ce matin.
  const noiseCutoff = Date.now() - NOISE_MIN_AGE_DAYS * 86_400_000;
  const base = `FROM Message m
     JOIN Folder f ON f.id = m.folderId
     LEFT JOIN Sender s ON s.accountSlug = m.accountSlug AND s.email = m.fromEmail
     WHERE m.isDeleted = 0 AND m.isOutbound = 0 AND f.role = 'inbox'
       AND m.date < ?
       AND (${NOISE_BUCKET_CASE}) = ?`;
  const [countRows, rows] = await Promise.all([
    db.$queryRawUnsafe<{ cnt: bigint }[]>(`SELECT COUNT(*) AS cnt ${base}`, noiseCutoff, bucket),
    db.$queryRawUnsafe<Row[]>(
      `SELECT m.accountSlug AS account, f.path AS folder, m.uid, m.subject,
              m.fromEmail, m.fromName, m.date, m.isSeen, m.snippet
       ${base} ORDER BY m.date ASC LIMIT ${PREVIEW_CAP}`,
      noiseCutoff,
      bucket,
    ),
  ]);
  const total = Number(countRows[0]?.cnt ?? 0);
  return {
    bucket,
    total,
    truncated: total > rows.length,
    items: rows.map((r) => ({
      account: r.account,
      folder: r.folder,
      uid: r.uid,
      subject: r.subject ?? '(sans sujet)',
      fromEmail: r.fromEmail ?? '',
      fromName: r.fromName,
      date: rawDate(r.date),
      isSeen: r.isSeen === 1,
      snippet: previewSnippet(r.snippet),
    })),
  };
}

function rawDate(v: string | number | bigint | null): string | null {
  if (v === null || v === undefined) return null;
  const d = typeof v === 'string' ? new Date(v) : new Date(Number(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
