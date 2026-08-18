import { db, ensureDbReady } from '../db/client.js';

/**
 * AFFAIRES EN COURS — les engagements pris qui n'ont pas abouti.
 *
 * POURQUOI CE MOTEUR EXISTE (18/08/2026). Anthony a mandaté Legalfree en juin
 * 2025 pour remonter ses parts dans la holding, a payé 1 131,26 € en août, et
 * a découvert un an plus tard SUR INFOGREFFE que rien n'était inscrit. De même
 * pour le changement de direction de LB2i chez Captain Contrat : bloqué sur une
 * signature, avec une échéance de paiement rejetée. Dans les deux cas, RIEN
 * dans sa boîte ne le lui rappellera : le déclencheur est un SILENCE.
 *
 * LA RÈGLE FONDATRICE, héritée de la contre-revue aveugle du 18/08 :
 * l'ouverture d'une affaire exige TOUJOURS une preuve positive — un geste de
 * l'utilisateur, ou un fait analysé (mandat, paiement d'une prestation,
 * procédure engagée). Le silence ne prouve jamais qu'un engagement existe ; il
 * prouve seulement qu'un engagement DÉJÀ ÉTABLI n'a pas de clôture connue.
 * Sans cette règle, on retomberait exactement dans la qualification par preuve
 * négative qui mettait trois publicités en tête de la Vue du jour.
 *
 * `reviewAt` N'EST PAS `dueAt` : `dueAt` dit « ceci devait être fait avant » ;
 * `reviewAt` dit « à cette date, si je n'ai toujours aucune preuve que c'est
 * fait, je dois regarder ». Une affaire sans échéance contractuelle a quand
 * même une date de vérification — c'est tout l'intérêt du modèle.
 */

/** Délai de vérification par défaut quand rien ne le fixe : 30 jours. */
const REVIEW_DEFAUT_JOURS = 30;

export interface EngagementItem {
  id: number;
  label: string;
  expected: string | null;
  actor: string;
  status: string;
  source: string;
  openedAt: string;
  reviewAt: string | null;
  dueAt: string | null;
  amountPaid: number | null;
  contactEmail: string | null;
  contactName: string | null;
  accountSlug: string | null;
  dossierId: number | null;
  dossierLabel: string | null;
  reason: string | null;
  notes: string | null;
  snoozedUntil: string | null;
  /** Vrai quand la date de vérification est atteinte et rien ne prouve la clôture. */
  aRelancer: boolean;
  /** Jours écoulés depuis l'engagement. */
  joursOuvert: number;
  /** Justification affichable, construite à partir des faits — jamais inventée. */
  pourquoi: string;
  /** Les mails qui prouvent l'affaire. */
  preuves: EngagementPreuve[];
}

export interface EngagementPreuve {
  messageId: number;
  role: string;
  subject: string | null;
  date: string | null;
  fromEmail: string | null;
  isOutbound: boolean;
  account: string;
}

export interface EngagementInput {
  label: string;
  expected?: string | null;
  actor?: string;
  openedAt?: string | null;
  reviewAt?: string | null;
  dueAt?: string | null;
  amountPaid?: number | null;
  contactEmail?: string | null;
  contactName?: string | null;
  accountSlug?: string | null;
  dossierId?: number | null;
  notes?: string | null;
  messageIds?: number[];
}

const jours = (d: Date | null | undefined, ref = Date.now()): number =>
  d ? Math.round((ref - d.getTime()) / 86_400_000) : 0;

/**
 * Une affaire est « à relancer » quand sa date de vérification est atteinte,
 * qu'elle n'est ni close ni reportée. C'est la seule règle qui transforme un
 * SILENCE en signal — et elle n'agit que sur un engagement déjà prouvé.
 */
function estARelancer(e: {
  status: string;
  reviewAt: Date | null;
  snoozedUntil: Date | null;
}): boolean {
  if (e.status !== 'ouvert' && e.status !== 'propose') return false;
  if (!e.reviewAt) return false;
  if (e.snoozedUntil && e.snoozedUntil.getTime() > Date.now()) return false;
  return e.reviewAt.getTime() <= Date.now();
}

function construirePourquoi(e: {
  openedAt: Date;
  amountPaid: number | null;
  reviewAt: Date | null;
  actor: string;
  reason: string | null;
  status: string;
  snoozedUntil: Date | null;
}): string {
  const bouts: string[] = [];
  const j = jours(e.openedAt);
  bouts.push(`engagée il y a ${j} jour${j > 1 ? 's' : ''}`);
  if (e.amountPaid != null) {
    bouts.push(`${e.amountPaid.toFixed(2).replace('.', ',')} € déjà réglés`);
  }
  if (estARelancer(e)) {
    bouts.push('aucune preuve d’aboutissement à la date de vérification');
  } else if (e.reviewAt) {
    const d = Math.round((e.reviewAt.getTime() - Date.now()) / 86_400_000);
    bouts.push(d >= 0 ? `vérification dans ${d} jour${d > 1 ? 's' : ''}` : 'vérification à programmer');
  }
  if (e.reason) bouts.push(e.reason);
  return bouts.join(' · ');
}

/** Liste les affaires, les plus urgentes d'abord. */
export async function listerEngagements(opts: { inclureClos?: boolean } = {}): Promise<{
  items: EngagementItem[];
  compteurs: { total: number; aRelancer: number; ouvertes: number; proposees: number; closes: number };
}> {
  await ensureDbReady();
  const rows = await db.engagement.findMany({
    where: opts.inclureClos ? {} : { status: { in: ['propose', 'ouvert'] } },
    include: {
      dossier: { select: { label: true } },
      messages: {
        include: {
          message: {
            select: {
              id: true, subject: true, date: true, fromEmail: true,
              isOutbound: true, accountSlug: true,
            },
          },
        },
      },
    },
    orderBy: { openedAt: 'asc' },
  });

  const items: EngagementItem[] = rows.map((e) => ({
    id: e.id,
    label: e.label,
    expected: e.expected,
    actor: e.actor,
    status: e.status,
    source: e.source,
    openedAt: e.openedAt.toISOString(),
    reviewAt: e.reviewAt?.toISOString() ?? null,
    dueAt: e.dueAt?.toISOString() ?? null,
    amountPaid: e.amountPaid,
    contactEmail: e.contactEmail,
    contactName: e.contactName,
    accountSlug: e.accountSlug,
    dossierId: e.dossierId,
    dossierLabel: e.dossier?.label ?? null,
    reason: e.reason,
    notes: e.notes,
    snoozedUntil: e.snoozedUntil?.toISOString() ?? null,
    aRelancer: estARelancer(e),
    joursOuvert: jours(e.openedAt),
    pourquoi: construirePourquoi(e),
    preuves: e.messages
      .map((m) => ({
        messageId: m.message.id,
        role: m.role,
        subject: m.message.subject,
        date: m.message.date?.toISOString() ?? null,
        fromEmail: m.message.fromEmail,
        isOutbound: m.message.isOutbound,
        account: m.message.accountSlug,
      }))
      .sort((a, b) => String(a.date).localeCompare(String(b.date))),
  }));

  // À relancer d'abord, puis les plus anciennement engagées.
  items.sort((a, b) => {
    if (a.aRelancer !== b.aRelancer) return a.aRelancer ? -1 : 1;
    return a.openedAt.localeCompare(b.openedAt);
  });

  const tous = await db.engagement.groupBy({ by: ['status'], _count: { _all: true } });
  const parStatut = Object.fromEntries(tous.map((t) => [t.status, t._count._all]));
  return {
    items,
    compteurs: {
      total: Object.values(parStatut).reduce((a, b) => a + b, 0),
      aRelancer: items.filter((i) => i.aRelancer).length,
      ouvertes: parStatut.ouvert ?? 0,
      proposees: parStatut.propose ?? 0,
      closes: parStatut.clos ?? 0,
    },
  };
}

/** Crée une affaire. `source=manual` ⇒ aucune analyse ne la réécrira jamais. */
export async function creerEngagement(
  input: EngagementInput,
  source: 'manual' | 'auto' = 'manual',
): Promise<number> {
  await ensureDbReady();
  const label = (input.label ?? '').trim();
  if (!label) throw new Error('Un intitulé est nécessaire.');
  const openedAt = input.openedAt ? new Date(input.openedAt) : new Date();
  // Pas de date de vérification fournie : on en pose une, sinon l'affaire ne
  // ressortirait jamais — et c'est précisément l'oubli qu'on veut éviter.
  const reviewAt = input.reviewAt
    ? new Date(input.reviewAt)
    : new Date(Date.now() + REVIEW_DEFAUT_JOURS * 86_400_000);

  const e = await db.engagement.create({
    data: {
      label,
      expected: input.expected ?? null,
      actor: input.actor ?? 'tiers',
      status: source === 'manual' ? 'ouvert' : 'propose',
      source,
      openedAt,
      reviewAt,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      amountPaid: input.amountPaid ?? null,
      contactEmail: input.contactEmail ?? null,
      contactName: input.contactName ?? null,
      accountSlug: input.accountSlug ?? null,
      dossierId: input.dossierId ?? null,
      notes: input.notes ?? null,
    },
  });
  if (input.messageIds?.length) await lierMessages(e.id, input.messageIds);
  return e.id;
}

export async function lierMessages(
  engagementId: number,
  messageIds: number[],
  role = 'contexte',
): Promise<number> {
  await ensureDbReady();
  let n = 0;
  for (const messageId of messageIds) {
    try {
      await db.engagementMessage.upsert({
        where: { engagementId_messageId: { engagementId, messageId } },
        create: { engagementId, messageId, role },
        update: { role },
      });
      n += 1;
    } catch {
      // mail supprimé entre-temps : on ignore, ce n'est pas bloquant
    }
  }
  return n;
}

/**
 * Modifie une affaire. Une saisie de l'utilisateur bascule `source` en
 * `manual` : à partir de là, plus aucune proposition automatique ne la
 * réécrira (même garde-fou que `Dossier.labelSource`, appris le 11/08 — sinon
 * sa correction serait effacée au tour suivant et il ne recommencerait pas).
 */
export async function modifierEngagement(
  id: number,
  patch: Partial<EngagementInput> & { status?: string },
): Promise<void> {
  await ensureDbReady();
  const data: Record<string, unknown> = { source: 'manual' };
  if (patch.label !== undefined) data.label = String(patch.label).trim();
  if (patch.expected !== undefined) data.expected = patch.expected;
  if (patch.actor !== undefined) data.actor = patch.actor;
  if (patch.notes !== undefined) data.notes = patch.notes;
  if (patch.amountPaid !== undefined) data.amountPaid = patch.amountPaid;
  if (patch.contactEmail !== undefined) data.contactEmail = patch.contactEmail;
  if (patch.contactName !== undefined) data.contactName = patch.contactName;
  if (patch.accountSlug !== undefined) data.accountSlug = patch.accountSlug;
  if (patch.dossierId !== undefined) data.dossierId = patch.dossierId;
  if (patch.openedAt !== undefined) data.openedAt = patch.openedAt ? new Date(patch.openedAt) : undefined;
  if (patch.reviewAt !== undefined) data.reviewAt = patch.reviewAt ? new Date(patch.reviewAt) : null;
  if (patch.dueAt !== undefined) data.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
  if (patch.status !== undefined) {
    data.status = patch.status;
    data.closedAt = patch.status === 'clos' || patch.status === 'abandonne' ? new Date() : null;
  }
  await db.engagement.update({ where: { id }, data });
}

/** Clôt une affaire. INVARIANT : un `clos` ne se rouvre jamais tout seul. */
export async function cloreEngagement(id: number, abandon = false): Promise<void> {
  await modifierEngagement(id, { status: abandon ? 'abandonne' : 'clos' });
}

/** Reporte l'affaire de N jours : elle ne sera pas proposée à la relance d'ici là. */
export async function reporterEngagement(id: number, jours_: number): Promise<void> {
  await ensureDbReady();
  const n = Math.min(Math.max(Math.round(jours_), 1), 365);
  await db.engagement.update({
    where: { id },
    data: { snoozedUntil: new Date(Date.now() + n * 86_400_000) },
  });
}

export async function supprimerEngagement(id: number): Promise<void> {
  await ensureDbReady();
  // INVARIANT : supprimer une affaire ne touche AUCUN mail. Le cascade ne
  // porte que sur la table de liaison.
  await db.engagement.delete({ where: { id } });
}

/**
 * Les affaires « dues » pour la Vue du jour. Volontairement AVARE : seules
 * celles qui sont à relancer, et confirmées ou proposées — jamais une affaire
 * dont la date de vérification est encore devant.
 */
export async function engagementsDus(): Promise<EngagementItem[]> {
  const { items } = await listerEngagements();
  return items.filter((i) => i.aRelancer);
}
