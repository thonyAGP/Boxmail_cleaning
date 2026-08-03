/**
 * Connecteur Rentila — Phase 1 : comprendre les mails (03/08).
 *
 * Rentila (gestion locative, boîte Location_Brest) envoie trois familles de
 * mails, relevées sur les VRAIS sujets de la base de production :
 *  1. Notifications automatiques (« Assurance locataire expirée pour: … »,
 *     « Révision de loyer pour … », « Connexion à votre compte »…) — du bruit
 *     rangeable, MAIS certaines portent une OBLIGATION à convertir en échéance ;
 *  2. Copies des envois faits PAR l'utilisateur via Rentila (fromName
 *     « SARL BRIMMO via Rentila » : avis d'échéance, quittances, rappels aux
 *     locataires) — bruit pur, c'est lui l'expéditeur réel ;
 *  3. Messages de LOCATAIRES relayés par la messagerie Rentila (sujet libre :
 *     « Fuite évier cuisine », « VMC »…) — jamais du bruit : à traiter.
 *
 * Ce module ne fait QUE comprendre (aucune écriture vers Rentila — ce sera la
 * phase 2) : il est branché sur la détection d'échéances et sur le
 * dépouillement. Les extraits de ces mails étant souvent vides (HTML seul),
 * tout repose sur le SUJET — qui porte le bien et le délai.
 */

import { db, ensureDbReady } from '../db/client.js';
import type { ExtractedDeadline } from './deadlines.js';

export const RENTILA_SENDER_RE = /@(?:[a-z0-9-]+\.)*rentila\.com$/i;

export function isRentilaSender(email: string | null | undefined): boolean {
  return !!email && RENTILA_SENDER_RE.test(email.trim());
}

export type RentilaKind =
  | 'insurance_expired'   // assurance locataire expirée → échéance immédiate
  | 'insurance_expiring'  // « expire dans N jours » → échéance à J+N
  | 'rent_late'           // loyers en retard (pas de bien dans le sujet)
  | 'rent_revision'       // révision de loyer pour {bien} (+ rappels)
  | 'intervention'        // intervention créée pour une location
  | 'intervention_done'   // intervention terminée
  | 'lease_ended'         // location terminée {bien}
  | 'lease_signed'        // signature de contrat (nouvelle ou finalisée)
  | 'tenant_connected'    // nouveau locataire connecté au portail
  | 'login'               // connexion à votre compte (sécurité)
  | 'docs_missing'        // documents manquants
  | 'subscription'        // abonnement Rentila expiré
  | 'download_copy'       // « … disponible en téléchargement » (avis, quittances)
  | 'outbound_copy'       // copie d'un envoi fait par l'utilisateur via Rentila
  | 'support'             // support / équipe Rentila (crisp, admin, contact)
  | 'tenant_message';     // sujet libre = message relayé de la messagerie

export interface RentilaMailInfo {
  kind: RentilaKind;
  /** Libellé humain court, en français (affiché dans le dépouillement). */
  label: string;
  /** Bien concerné tel qu'écrit dans le sujet (« 101 1er droite T3 »), sinon null. */
  property: string | null;
  /** true = notification rangeable en lot ; false = demande une décision individuelle. */
  noise: boolean;
  /** Obligation détectée à proposer en échéance (sinon null). */
  due: (ExtractedDeadline & { title: string }) | null;
}

const DAY = 86_400_000;

function cleanProperty(raw: string): string {
  return raw.replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
}

/** Retire une éventuelle date finale « 12/07/2026 » des sujets de signature. */
function stripTrailingDate(raw: string): string {
  return raw.replace(/\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/, '').trim();
}

function due(
  date: Date,
  type: ExtractedDeadline['type'],
  title: string,
  subject: string,
  confidence = 0.85,
): RentilaMailInfo['due'] {
  return {
    date,
    type,
    title,
    confidence,
    sourceText: subject,
    trigger: 'notification Rentila',
  };
}

/**
 * Analyse un mail venant de Rentila. Retourne null si l'expéditeur n'est pas
 * Rentila — l'appelant n'a alors rien à faire de spécial.
 */
export function parseRentilaMail(input: {
  subject: string | null;
  fromEmail: string | null;
  fromName: string | null;
  date: Date | null;
}): RentilaMailInfo | null {
  if (!isRentilaSender(input.fromEmail)) return null;
  const subject = (input.subject ?? '').replace(/\s+/g, ' ').trim();
  const refDate = input.date ?? new Date();
  const from = (input.fromEmail ?? '').toLowerCase();

  // Copies des envois de l'utilisateur (Rentila envoie « au nom de » sa
  // société) : « SARL BRIMMO via Rentila », « SCI ALTOEN via Rentila »…
  if (/\bvia Rentila\s*$/i.test(input.fromName ?? '')) {
    return {
      kind: 'outbound_copy',
      label: 'Copie de ton envoi Rentila',
      property: null,
      noise: true,
      due: null,
    };
  }

  // Support / équipe Rentila (crisp.rentila.com, admin@, contact@).
  if (from.includes('crisp.') || from.startsWith('admin@') || from.startsWith('contact@')) {
    return {
      kind: 'support',
      label: 'Message de l’équipe Rentila',
      property: null,
      noise: false,
      due: null,
    };
  }

  let m: RegExpMatchArray | null;

  if ((m = subject.match(/^Assurance locataire expirée pour\s*:?\s*(.+)$/i))) {
    const property = cleanProperty(m[1]);
    return {
      kind: 'insurance_expired',
      label: 'Assurance locataire expirée',
      property,
      // Décision individuelle (retour 03/08 : « à traiter un par un ») —
      // seuls les envois auto/techniques restent en lot.
      noise: false,
      due: due(refDate, 'renewal', `Renouveler l'assurance locataire — ${property}`, subject, 0.9),
    };
  }
  if ((m = subject.match(/^Assurance locataire expire dans (\d{1,3}) jours?\s*:?\s*(.+)$/i))) {
    const days = Number(m[1]);
    const property = cleanProperty(m[2]);
    return {
      kind: 'insurance_expiring',
      label: `Assurance locataire expire dans ${days} jours`,
      property,
      noise: false,
      due: due(
        new Date(refDate.getTime() + days * DAY),
        'renewal',
        `Assurance locataire à renouveler — ${property}`,
        subject,
        0.9,
      ),
    };
  }
  if (/^Rappel assurance locataire/i.test(subject)) {
    // Version « non via » du rappel envoyé au locataire : simple copie.
    return { kind: 'outbound_copy', label: 'Rappel assurance envoyé au locataire', property: null, noise: true, due: null };
  }
  if (/^Loyers? en retard/i.test(subject)) {
    return { kind: 'rent_late', label: 'Loyer(s) en retard signalé(s)', property: null, noise: false, due: null };
  }
  if ((m = subject.match(/^(Rappel\s+)?[Rr]évision de loyer pour\s+(.+)$/i))) {
    const rappel = !!m[1];
    const property = cleanProperty(m[2]);
    return {
      kind: 'rent_revision',
      label: rappel ? 'Rappel : révision de loyer à faire' : 'Révision de loyer à faire',
      property,
      noise: false,
      due: due(
        new Date(refDate.getTime() + (rappel ? 7 : 30) * DAY),
        'other',
        `Réviser le loyer — ${property}`,
        subject,
        0.8,
      ),
    };
  }
  if (/^Intervention terminée/i.test(subject)) {
    return { kind: 'intervention_done', label: 'Intervention terminée', property: null, noise: false, due: null };
  }
  if ((m = subject.match(/^Intervention pour LOCATION\s+(.+)$/i))) {
    return {
      kind: 'intervention',
      label: 'Intervention demandée',
      property: cleanProperty(m[1]),
      noise: false,
      due: null,
    };
  }
  if ((m = subject.match(/^Location terminée\s+(.+)$/i))) {
    return {
      kind: 'lease_ended',
      label: 'Location terminée',
      property: cleanProperty(m[1]),
      noise: false,
      due: null,
    };
  }
  if ((m = subject.match(/^(?:Nouvelle signature contrat de location|Contrat de location signé)\s+(.+)$/i))) {
    return {
      kind: 'lease_signed',
      label: 'Contrat de location signé',
      property: cleanProperty(stripTrailingDate(m[1])),
      noise: false,
      due: null,
    };
  }
  if (/^Nouveau locataire connecté/i.test(subject)) {
    return { kind: 'tenant_connected', label: 'Nouveau locataire connecté au portail', property: null, noise: true, due: null };
  }
  if (/^Connexion à votre compte/i.test(subject)) {
    return { kind: 'login', label: 'Alerte de connexion au compte', property: null, noise: true, due: null };
  }
  if (/disponibles? en téléchargement/i.test(subject)) {
    return { kind: 'download_copy', label: 'Document disponible en téléchargement', property: null, noise: true, due: null };
  }
  if (/^Documents manquants/i.test(subject)) {
    return { kind: 'docs_missing', label: 'Documents manquants dans un dossier', property: null, noise: false, due: null };
  }
  if (/abonnement a expiré/i.test(subject)) {
    return {
      kind: 'subscription',
      label: 'Abonnement Rentila expiré',
      property: null,
      noise: false,
      due: due(refDate, 'payment', 'Renouveler l’abonnement Rentila', subject, 0.8),
    };
  }
  if (/^Rentila\.com/i.test(subject) || subject === '') {
    return { kind: 'support', label: 'Information Rentila', property: null, noise: true, due: null };
  }

  // Tout le reste venant de noreply@rentila.com = un message RELAYÉ de la
  // messagerie (locataire, artisan…) : sujet libre, à traiter par un humain.
  return {
    kind: 'tenant_message',
    label: 'Message reçu via la messagerie Rentila',
    property: null,
    noise: false,
    due: null,
  };
}

// ---------------------------------------------------------------- Vue du jour
/** Un mail à ouvrir depuis la carte « Gestion locative ». */
export interface RentilaOverviewMail {
  account: string;
  folder: string;
  uid: number;
  subject: string;
  fromName: string | null;
  fromEmail: string | null;
  date: string | null;
  isSeen: boolean;
}

export interface RentilaOverview {
  /** Il y a de la matière à afficher (sinon la carte reste invisible). */
  hasActivity: boolean;
  /** Biens dont l'assurance locataire est expirée ou expire bientôt. */
  insurance: { property: string; expired: boolean }[];
  /** Dernier signalement « Loyers en retard » (ISO), sinon null. */
  rentLateAt: string | null;
  /** Messages relayés (locataires…) pas encore dépouillés. */
  tenantMessages: RentilaOverviewMail[];
  /** Échéances Rentila à venir (proposées ou confirmées, ≤ 60 j). */
  deadlines: { id: number; account: string; title: string; date: string; status: string }[];
}

/**
 * Synthèse « Gestion locative » pour la Vue du jour : ce que Rentila attend
 * de l'utilisateur, calculé depuis l'index local (45 derniers jours). Aucune
 * boîte n'est ciblée en dur — c'est l'EXPÉDITEUR qui fait foi, donc toutes
 * les boîtes sont couvertes d'office.
 */
export async function rentilaOverview(): Promise<RentilaOverview> {
  await ensureDbReady();
  const since = new Date(Date.now() - 45 * DAY);
  const mails = await db.message.findMany({
    where: {
      isDeleted: false,
      isOutbound: false,
      date: { gte: since },
      fromEmail: { contains: 'rentila.com' },
    },
    orderBy: { date: 'desc' },
    take: 400,
    select: {
      id: true, accountSlug: true, uid: true, subject: true, fromEmail: true,
      fromName: true, date: true, isSeen: true, reviewedAt: true,
      folder: { select: { path: true } },
    },
  });

  // Assurances : l'état le plus récent par bien fait foi (une « expirée »
  // suivie d'un renouvellement n'émet pas de mail — l'échéance, elle, se
  // clôt à la main dans le calendrier).
  const insurance = new Map<string, { property: string; expired: boolean; at: number }>();
  let rentLateAt: string | null = null;
  const tenantMessages: RentilaOverviewMail[] = [];

  for (const m of mails) {
    const info = parseRentilaMail({
      subject: m.subject, fromEmail: m.fromEmail, fromName: m.fromName, date: m.date,
    });
    if (!info) continue;
    const at = m.date?.getTime() ?? 0;
    if ((info.kind === 'insurance_expired' || info.kind === 'insurance_expiring') && info.property) {
      const prev = insurance.get(info.property);
      if (!prev || at > prev.at) {
        insurance.set(info.property, {
          property: info.property,
          expired: info.kind === 'insurance_expired',
          at,
        });
      }
    } else if (info.kind === 'rent_late') {
      if (!rentLateAt || at > new Date(rentLateAt).getTime()) rentLateAt = m.date?.toISOString() ?? null;
    } else if (info.kind === 'tenant_message' && !m.reviewedAt && tenantMessages.length < 6) {
      tenantMessages.push({
        account: m.accountSlug,
        folder: m.folder.path,
        uid: m.uid,
        subject: m.subject ?? '(sans sujet)',
        fromName: m.fromName,
        fromEmail: m.fromEmail,
        date: m.date?.toISOString() ?? null,
        isSeen: m.isSeen,
      });
    }
  }

  const deadlineRows = await db.deadline.findMany({
    where: {
      status: { in: ['proposed', 'confirmed'] },
      fromEmail: { contains: 'rentila.com' },
      date: { gte: new Date(Date.now() - 7 * DAY), lte: new Date(Date.now() + 60 * DAY) },
    },
    orderBy: { date: 'asc' },
    take: 8,
    select: { id: true, accountSlug: true, title: true, date: true, status: true },
  });

  const insuranceList = [...insurance.values()]
    .sort((a, b) => Number(b.expired) - Number(a.expired) || b.at - a.at)
    .map(({ property, expired }) => ({ property, expired }));

  return {
    hasActivity: mails.length > 0,
    insurance: insuranceList,
    rentLateAt,
    tenantMessages,
    deadlines: deadlineRows.map((d) => ({
      id: d.id,
      account: d.accountSlug,
      title: d.title,
      date: d.date.toISOString(),
      status: d.status,
    })),
  };
}
