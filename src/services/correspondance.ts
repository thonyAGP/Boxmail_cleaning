import { db, ensureDbReady } from '../db/client.js';
import { previewSnippet, splitNames } from './search.js';

/**
 * « Nos échanges avec cette personne » (11/08).
 *
 * Demande née d'un cas réel : un mail d'Elisa Serrano (juriste) contient DEUX
 * sujets — les comptes 2025 à signer, et une assemblée générale extraordinaire
 * à décider pour éviter la dissolution de la société. Impossible de trancher
 * sans voir l'historique : qu'a-t-elle déjà envoyé, à quoi ai-je déjà répondu ?
 *
 * On regroupe donc par CONVERSATION et non en liste à plat : ce qu'il veut
 * voir, ce sont « les deux sujets », pas quinze lignes triées par date.
 *
 * Lecture seule, sur l'index local : instantané, aucune connexion IMAP.
 */

export interface MessageEchange {
  messageId: number;
  account: string;
  folder: string;
  folderRole: string;
  uid: number;
  subject: string;
  date: string | null;
  /** true = mail que l'utilisateur a envoyé (sa propre réponse). */
  isOutbound: boolean;
  isSeen: boolean;
  snippet: string | null;
  attachmentNames: string[];
  hasAttachments: boolean;
}

export interface SujetEchange {
  /** Identifiant du fil, ou sujet normalisé si le fil n'est pas rattaché. */
  key: string;
  subject: string;
  count: number;
  /** Nombre de messages venant de l'interlocuteur (hors nos réponses). */
  received: number;
  /** Nombre de nos propres réponses. */
  sent: number;
  firstAt: string | null;
  lastAt: string | null;
  /** true si le dernier message est de LUI : la balle est dans notre camp. */
  waitingOnUs: boolean;
  withAttachments: number;
  messages: MessageEchange[];
}

export interface Correspondance {
  email: string;
  displayName: string;
  /** Boîtes dans lesquelles cette personne apparaît. */
  accounts: string[];
  totalMessages: number;
  totalSent: number;
  firstAt: string | null;
  lastAt: string | null;
  subjects: SujetEchange[];
}

export async function correspondance(opts: {
  email: string;
  /** Restreindre à une boîte ; absent = toutes (il écrit parfois aux deux). */
  account?: string;
  /** Nombre de conversations renvoyées (défaut 12). */
  limit?: number;
}): Promise<Correspondance> {
  await ensureDbReady();
  const email = opts.email.trim().toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 60);

  // Les mails REÇUS de cette personne…
  const recus = await db.message.findMany({
    where: {
      isDeleted: false,
      fromEmail: email,
      folder: { role: { notIn: ['spam'] } },
      ...(opts.account ? { accountSlug: opts.account } : {}),
    },
    orderBy: { date: 'desc' },
    take: 400,
    select: selection(),
  });

  // …et NOS réponses, repérées par le fil ou par le destinataire. `toEmails`
  // est stocké en JSON : un `contains` sur la chaîne suffit et reste rapide.
  const fils = [...new Set(recus.map((m) => m.threadId).filter((t): t is number => t !== null))];
  const envoyes = await db.message.findMany({
    where: {
      isDeleted: false,
      isOutbound: true,
      ...(opts.account ? { accountSlug: opts.account } : {}),
      OR: [
        ...(fils.length ? [{ threadId: { in: fils } }] : []),
        { toEmails: { contains: email } },
      ],
    },
    orderBy: { date: 'desc' },
    take: 400,
    select: selection(),
  });

  const tous = [...recus, ...envoyes];
  if (tous.length === 0) {
    return {
      email,
      displayName: email,
      accounts: [],
      totalMessages: 0,
      totalSent: 0,
      firstAt: null,
      lastAt: null,
      subjects: [],
    };
  }

  // Regroupement par CONVERSATION : le fil quand il existe, sinon le sujet
  // normalisé (un « Re: » ne doit pas créer un second sujet).
  const parSujet = new Map<string, MessageEchange[]>();
  for (const m of tous) {
    const cle =
      m.threadId !== null
        ? `t:${m.threadId}`
        : `s:${(m.normalizedSubject || m.subject || '(sans sujet)').toLowerCase()}`;
    const arr = parSujet.get(cle) ?? [];
    arr.push(versEchange(m));
    parSujet.set(cle, arr);
  }

  const sujets: SujetEchange[] = [];
  for (const [key, msgs] of parSujet) {
    // Dédoublonnage : un même mail peut être rattrapé par les deux requêtes.
    const vus = new Set<number>();
    const uniques = msgs.filter((m) => (vus.has(m.messageId) ? false : (vus.add(m.messageId), true)));
    uniques.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    const dernier = uniques[uniques.length - 1];
    const recu = uniques.filter((m) => !m.isOutbound);
    sujets.push({
      key,
      // Le sujet le plus ancien porte le mieux le titre du dossier (les
      // suivants ne sont que des « Re: ».)
      subject: (uniques[0]?.subject || dernier?.subject || '(sans sujet)').replace(/^((re|tr|fwd?)\s*:\s*)+/i, ''),
      count: uniques.length,
      received: recu.length,
      sent: uniques.length - recu.length,
      firstAt: uniques[0]?.date ?? null,
      lastAt: dernier?.date ?? null,
      waitingOnUs: !!dernier && !dernier.isOutbound,
      withAttachments: uniques.filter((m) => m.hasAttachments).length,
      messages: uniques,
    });
  }
  // Le sujet le plus récemment actif d'abord.
  sujets.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));

  const dates = tous.map((m) => m.date?.toISOString() ?? null).filter((d): d is string => !!d).sort();
  const nom = recus.find((m) => m.fromName)?.fromName ?? email;

  return {
    email,
    displayName: nom,
    accounts: [...new Set(tous.map((m) => m.accountSlug))],
    totalMessages: tous.length,
    totalSent: envoyes.length,
    firstAt: dates[0] ?? null,
    lastAt: dates[dates.length - 1] ?? null,
    subjects: sujets.slice(0, limit),
  };
}

function selection() {
  return {
    id: true,
    accountSlug: true,
    uid: true,
    threadId: true,
    subject: true,
    normalizedSubject: true,
    fromName: true,
    date: true,
    isOutbound: true,
    isSeen: true,
    snippet: true,
    attachmentNames: true,
    hasAttachments: true,
    folder: { select: { path: true, role: true } },
  } as const;
}

type Ligne = {
  id: number;
  accountSlug: string;
  uid: number;
  subject: string | null;
  date: Date | null;
  isOutbound: boolean;
  isSeen: boolean;
  snippet: string | null;
  attachmentNames: string | null;
  hasAttachments: boolean;
  folder: { path: string; role: string };
};

function versEchange(m: Ligne): MessageEchange {
  return {
    messageId: m.id,
    account: m.accountSlug,
    folder: m.folder.path,
    folderRole: m.folder.role,
    uid: m.uid,
    subject: m.subject ?? '(sans sujet)',
    date: m.date?.toISOString() ?? null,
    isOutbound: m.isOutbound,
    isSeen: m.isSeen,
    snippet: previewSnippet(m.snippet),
    attachmentNames: splitNames(m.attachmentNames),
    hasAttachments: m.hasAttachments,
  };
}
