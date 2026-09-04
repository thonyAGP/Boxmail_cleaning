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

/** Autre adresse de la MÊME maison (le dossier ne passe pas par une seule). */
export interface VoisinDomaine {
  email: string;
  displayName: string;
  count: number;
  lastAt: string | null;
}

/**
 * Interlocuteur d'une AUTRE maison relié par une ENTITÉ commune (lot 4h).
 * Le cas déclencheur du 11/08 dépasse le domaine : le dossier « approbation
 * des comptes » passe par contact@cabinet-compta.example.com ET par le
 * prestataire de signature — deux domaines sans rapport, reliés parce que
 * leurs verdicts nomment les mêmes entités.
 */
export interface VoisinEntite {
  email: string;
  displayName: string;
  count: number;
  lastAt: string | null;
  /** Les entités partagées qui font le lien (« ACME », « 46 rue… »). */
  entites: string[];
}

export interface Correspondance {
  email: string;
  displayName: string;
  /**
   * Autres interlocuteurs du même domaine (11/08). Cas déclencheur : le
   * dossier « approbation des comptes » passe par
   * contact@cabinet-compta.example.com ET par le prestataire de signature, et
   * chercher une seule adresse rate la moitié du dossier. Vide pour les
   * domaines grand public : deux adresses gmail sont deux personnes sans
   * rapport.
   */
  alsoFromDomain: VoisinDomaine[];
  /**
   * Interlocuteurs reliés par une entité que l'analyse a lue dans les mails
   * de cette personne (lot 4h) — plus large que le domaine, voir VoisinEntite.
   */
  alsoByEntity: VoisinEntite[];
  /** Boîtes dans lesquelles cette personne apparaît. */
  accounts: string[];
  totalMessages: number;
  totalSent: number;
  firstAt: string | null;
  lastAt: string | null;
  subjects: SujetEchange[];
}

/**
 * LES DOMAINES QUI N'IDENTIFIENT PERSONNE. Chez un fournisseur, le domaine EST
 * l'interlocuteur : `litiges@acme.example.com` et
 * `relationclient@acme.example.com` sont la même maison. Chez un fournisseur
 * de messagerie, le domaine ne désigne rien —
 * regrouper par `hotmail.com` fusionnerait toute sa vie privée en un seul
 * « correspondant ». C'est le garde-fou qui rend l'élargissement sûr.
 */
const DOMAINES_PUBLICS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.fr', 'outlook.com',
  'outlook.fr', 'live.com', 'live.fr', 'msn.com', 'yahoo.com', 'yahoo.fr',
  'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net', 'neuf.fr',
  'bbox.fr', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com',
  'proton.me', 'gmx.fr', 'gmx.com', 'yopmail.com', 'numericable.fr',
]);

/**
 * Les autres adresses de la MÊME MAISON, quand la maison est identifiable.
 *
 * ⚠️ CE QUI A RENDU CETTE FONCTION NÉCESSAIRE (mesuré le 27/08 sur la base
 * réelle). Le dossier « remboursement ACME » vit sur **10 adresses**
 * (`litiges@`, `relationclient@`, `encours@`, `contact@`, `devis@`,
 * `nepasrepondre@`…) et **34 fils**. Le panneau « Voir l'histoire », calqué
 * sur UNE adresse, en montrait 3. Anthony : « tu donnes l'impression d'avoir
 * créé un truc solide mais c'est du vent ».
 *
 * Lu dans `Sender` — table petite — et non par un LIKE sur `Message`
 * (139 863 lignes) : 9 ms contre un balayage complet. Le résultat sert ensuite
 * un `fromEmail IN (...)`, qui utilise l'index (3 ms pour 28 mails).
 * Plafonné à 300 : très en dessous des 999 valeurs qui font PANIQUER le moteur.
 */
export async function adressesDeLOrganisation(
  email: string,
): Promise<{ domaine: string; adresses: string[] } | null> {
  const domaine = (email.split('@')[1] ?? '').toLowerCase();
  if (!domaine || DOMAINES_PUBLICS.has(domaine)) return null;
  // Un sous-domaine de service (`contact@service.acme.example.com`) appartient à la
  // même maison : on remonte au domaine enregistrable, deux étiquettes.
  const parts = domaine.split('.');
  const racine = parts.length > 2 ? parts.slice(-2).join('.') : domaine;
  const adresses = (
    await db.sender.findMany({
      where: { email: { endsWith: `@${racine}` } },
      select: { email: true },
      take: 300,
    })
  ).map((s) => s.email.toLowerCase());
  const uniques = [...new Set([...adresses, email.toLowerCase()])];
  return uniques.length > 1 ? { domaine: racine, adresses: uniques } : null;
}

export async function correspondance(opts: {
  email: string;
  /**
   * Élargissement à la MAISON : toutes les adresses de l'organisation. Quand
   * il est fourni, « tout ce qui s'est dit avec eux » couvre le fournisseur
   * entier, pas seulement la boîte aux lettres qui a écrit ce jour-là.
   */
  emails?: string[];
  /** Restreindre à une boîte ; absent = toutes (il écrit parfois aux deux). */
  account?: string;
  /** Nombre de conversations renvoyées (défaut 12). */
  limit?: number;
}): Promise<Correspondance> {
  await ensureDbReady();
  const email = opts.email.trim().toLowerCase();
  const cibles = [...new Set((opts.emails?.length ? opts.emails : [email]).map((e) => e.toLowerCase()))];
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 60);

  // Les mails REÇUS de cette personne…
  const recus = await db.message.findMany({
    where: {
      isDeleted: false,
      fromEmail: cibles.length > 1 ? { in: cibles } : email,
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
        ...cibles.map((e) => ({ toEmails: { contains: e } })),
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
      alsoFromDomain: [],
      alsoByEntity: [],
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
    alsoFromDomain: await voisinsDuDomaine(email, opts.account),
    alsoByEntity: await voisinsParEntite(recus.map((m) => m.id), email, opts.account),
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

/** Domaines grand public : deux adresses n'y sont pas la même maison. */
const DOMAINES_PERSO =
  /^(hotmail|gmail|live|outlook|yahoo|msn|orange|wanadoo|free|sfr|laposte|icloud|me|aol)\./i;

async function voisinsDuDomaine(email: string, account?: string): Promise<VoisinDomaine[]> {
  const domaine = email.split('@')[1] ?? '';
  if (!domaine || DOMAINES_PERSO.test(domaine)) return [];
  const rows = await db.message.findMany({
    where: {
      isDeleted: false,
      isOutbound: false,
      fromEmail: { endsWith: '@' + domaine, not: email },
      folder: { role: { notIn: ['spam', 'trash'] } },
      ...(account ? { accountSlug: account } : {}),
    },
    orderBy: { date: 'desc' },
    take: 300,
    select: { fromEmail: true, fromName: true, date: true },
  });
  const parAdresse = new Map<string, VoisinDomaine>();
  for (const r of rows) {
    const e = (r.fromEmail ?? '').toLowerCase();
    if (!e) continue;
    const v = parAdresse.get(e) ?? {
      email: e,
      displayName: r.fromName || e,
      count: 0,
      lastAt: null as string | null,
    };
    v.count++;
    const d = r.date?.toISOString() ?? null;
    if (d && (!v.lastAt || d > v.lastAt)) v.lastAt = d;
    parAdresse.set(e, v);
  }
  return [...parAdresse.values()].sort((a, b) => b.count - a.count).slice(0, 6);
}

/**
 * Voisins par ENTITÉ (lot 4h) : les adresses d'AUTRES maisons dont les mails
 * citent — d'après le verdict sémantique — les mêmes entités que ceux de cette
 * personne. C'est ce qui recolle le dossier quand il change de canal (le
 * courrier d'Elisa continue chez Yousign).
 *
 * Trois requêtes bornées, jamais mail par mail : les mentions des mails reçus
 * (déjà plafonnés à 400), les échos de ces entités ailleurs (plafonnés), puis
 * la validation des messages porteurs. La correspondance d'entité est EXACTE
 * (même graphie) : les variantes d'orthographe relèvent de l'identité des
 * dossiers (lot 3), pas d'une normalisation refaite ici.
 */
async function voisinsParEntite(
  messageIds: number[],
  email: string,
  account?: string,
): Promise<VoisinEntite[]> {
  if (messageIds.length === 0) return [];
  const domaine = email.split('@')[1] ?? '';
  // 1. Les entités FORTES que l'analyse a lues dans les mails de la personne.
  //    Les inférences faibles n'accrochent rien : relier deux interlocuteurs
  //    sur un doute fabriquerait des rapprochements faux.
  const propres = await db.entityMention.findMany({
    where: {
      messageId: { in: messageIds },
      certainty: { in: ['explicit', 'strong_inference'] },
      kind: { in: ['person', 'company', 'property', 'vehicle', 'contract'] },
    },
    select: { nameRaw: true },
  });
  const noms = [
    ...new Set(propres.map((p) => p.nameRaw.trim()).filter((n) => n.length >= 4)),
  ].slice(0, 40);
  if (noms.length === 0) return [];

  // 2. Les mêmes entités citées AILLEURS.
  const echos = await db.entityMention.findMany({
    where: {
      nameRaw: { in: noms },
      certainty: { in: ['explicit', 'strong_inference'] },
    },
    select: { messageId: true, nameRaw: true },
    take: 2000,
  });
  const propresSet = new Set(messageIds);
  const parMessage = new Map<number, Set<string>>();
  for (const e of echos) {
    if (propresSet.has(e.messageId)) continue;
    const s = parMessage.get(e.messageId) ?? new Set<string>();
    s.add(e.nameRaw.trim());
    parMessage.set(e.messageId, s);
  }
  if (parMessage.size === 0) return [];

  // 3. Qui a envoyé ces mails-là ? La même maison est déjà couverte par
  //    alsoFromDomain — on ne montre ici que ce que le domaine ne voit pas.
  const ids = [...parMessage.keys()];
  const parAdresse = new Map<string, VoisinEntite>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db.message.findMany({
      where: {
        id: { in: ids.slice(i, i + 500) },
        isDeleted: false,
        isOutbound: false,
        fromEmail: { not: null },
        folder: { role: { notIn: ['spam', 'trash'] } },
        ...(account ? { accountSlug: account } : {}),
      },
      select: { id: true, fromEmail: true, fromName: true, date: true },
    });
    for (const r of rows) {
      const e = (r.fromEmail ?? '').toLowerCase();
      if (!e || e === email) continue;
      if (domaine && e.endsWith('@' + domaine)) continue;
      const v = parAdresse.get(e) ?? {
        email: e,
        displayName: r.fromName || e,
        count: 0,
        lastAt: null as string | null,
        entites: [] as string[],
      };
      v.count++;
      const d = r.date?.toISOString() ?? null;
      if (d && (!v.lastAt || d > v.lastAt)) v.lastAt = d;
      for (const n of parMessage.get(r.id) ?? []) {
        if (v.entites.length < 3 && !v.entites.includes(n)) v.entites.push(n);
      }
      parAdresse.set(e, v);
    }
  }
  return [...parAdresse.values()].sort((a, b) => b.count - a.count).slice(0, 6);
}

/* ═══════════════════ CONTEXTE D'UN MAIL — refonte du 18/08 ═══════════════════
 *
 * POURQUOI CETTE REFONTE. « Nos échanges » triait les conversations par date
 * décroissante puis coupait aux 12 premières. AUCUN critère de pertinence :
 * ouvrir une mise en demeure URSSAF affichait « COUCOU », « 100 ans de la
 * PLM », « facture sosh » — les 12 conversations les plus RÉCENTES sur 264.
 * Retour utilisateur : « nos échanges ne se cantonne pas qu'au sujet traité ».
 *
 * LA RÈGLE, issue d'une contre-revue aveugle en 2 tours
 * (.consult/2026-08-18-nos-echanges/synthese.md) :
 *
 *   LIÉ À CE MAIL = même correspondant
 *                   ET ( même fil
 *                        OU même sujet normalisé
 *                        OU au moins un dossier en commun )
 *
 * Le premier réflexe — « prendre le dossier du mail » — a été MESURÉ et
 * écarté : 31 % seulement des mails portent un dossier, 28 % en portent
 * plusieurs, et leur médiane est de 1 mail. Sur le cas URSSAF, le dossier le
 * plus PRÉCIS (« URSSAF Bretagne », 2 mails) est le moins utile ; c'est le
 * plus LARGE (« SAS LB2I », 10 mails avec Mylène) qui porte le contexte. Les
 * dossiers sont donc d'excellents SIGNAUX DE LIAISON, pas un conteneur
 * navigable — d'où l'union plutôt qu'un choix.
 *
 * Le tri se fait par FORCE DU LIEN, pas par date : mêler un mail du même fil
 * et un mail relié par un dossier large sur le seul critère de récence ferait
 * remonter le moins pertinent.
 */

/** Un message du contexte, avec la raison de sa présence. */
export interface MessageLie extends MessageEchange {
  /** Ce qui relie ce message au mail courant, en clair. */
  lienPar: string;
  /** Force du lien (0 = le plus fort) — sert au tri, pas à l'affichage. */
  force: number;
  /** true quand ce message EST le mail courant (repère « vous êtes ici »). */
  estCourant: boolean;
}

export type Focale = 'sujet' | 'lie' | 'tout';

export interface ContexteMail {
  email: string;
  displayName: string;
  accounts: string[];
  /** Identifiant du mail courant — sert au repère « vous êtes ici ». */
  messageIdCourant: number;
  focale: Focale;
  /**
   * Le domaine de l'organisation quand l'interlocuteur en est une
   * (`acme.example.com`),
   * null pour une adresse personnelle. C'est le libellé du troisième onglet.
   */
  organisation: string | null;
  /** Les trois compteurs, hors mail courant — ils remplissent les onglets. */
  compteurs: { sujet: number; lie: number; tout: number };
  /** Messages de la focale demandée (focales `sujet` et `lie`). */
  messages: MessageLie[];
  /** Combien de liés n'ont pas été renvoyés (garde-fou des dossiers géants). */
  tronque: number;
  /** Regroupement par conversation — UNIQUEMENT pour la focale `tout`. */
  sujets: SujetEchange[];
}

/** Plafond d'affichage : 92 % des cas tiennent en 20 (mesuré sur 250 mails). */
const PLAFOND_LIES = 20;

const normaliserSujet = (s: string | null | undefined): string =>
  (s ?? '').replace(/^((re|tr|fwd?)\s*:\s*)+/i, '').trim().toLowerCase();

export async function contexteDuMail(opts: {
  /** Identifiant interne, quand l'écran appelant le connaît. */
  messageId?: number;
  /**
   * REPÈRE DE SECOURS (18/08, correctif) : la plupart des écrans ouvrent le
   * lecteur avec un simple `{account, folder, uid}` et ne transportent PAS
   * `messageId` — la Vue du jour la première. S'appuyer sur le seul
   * `messageId` faisait donc répondre « ce mail n'est pas encore indexé » sur
   * des mails parfaitement indexés. Le trio compte/dossier/UID, lui, est
   * TOUJOURS disponible : le lecteur en a besoin pour télécharger le corps.
   */
  account?: string;
  folder?: string;
  uid?: number;
  focale?: Focale;
  limit?: number;
}): Promise<ContexteMail> {
  await ensureDbReady();
  const focale: Focale = opts.focale ?? 'lie';

  const ou = opts.messageId
    ? { id: opts.messageId }
    : opts.account && opts.folder && opts.uid
      ? { accountSlug: opts.account, folder: { path: opts.folder }, uid: opts.uid }
      : null;
  if (!ou) throw new Error('Mail non identifié (ni identifiant, ni compte/dossier/UID).');

  const courant = await db.message.findFirst({
    where: ou,
    select: {
      id: true, subject: true, normalizedSubject: true, threadId: true,
      fromEmail: true, fromName: true, isOutbound: true, toEmails: true,
      dossiers: { select: { dossierId: true } },
    },
  });
  if (!courant) throw new Error('Mail introuvable.');

  // L'INTERLOCUTEUR n'est pas toujours l'expéditeur : sur un mail que
  // l'utilisateur a ENVOYÉ, c'est le destinataire qu'il faut suivre.
  const email = (courant.isOutbound
    ? (JSON.parse(courant.toEmails || '[]') as string[])[0]
    : courant.fromEmail) ?? courant.fromEmail ?? '';
  if (!email) throw new Error('Aucun interlocuteur identifiable sur ce mail.');
  const cible = email.toLowerCase();

  /**
   * L'UNIVERS DU PANNEAU — ce dans quoi les trois focales vont puiser.
   *
   * ⚠️ IL NE SE RÉDUIT PLUS À UNE ADRESSE (corrigé le 27/08, sur données
   * RÉELLES). Il l'a été pendant neuf jours, et ça donnait ceci sur le dossier
   * « remboursement ACME » : « Ce sujet · 0 », alors que le fil comptait
   * trois messages, et « Tout · 2 » pour une affaire de 34 mails.
   *
   * Deux causes, toutes deux ici :
   *  1. LE FIL ÉTAIT AMPUTÉ. Une conversation appartient à ses participants,
   *     pas à une boîte aux lettres : le mail d'ancrage venait de
   *     `compta.client@intermediaire.example.net` (2 mails en tout), ses deux
   *     frères de fil de `litiges@acme.example.com` — donc invisibles. Un fil
   *     est désormais pris
   *     ENTIER, quel que soit l'expéditeur.
   *  2. L'INTERLOCUTEUR ÉTAIT UNE ADRESSE. ACME écrit depuis dix boîtes
   *     différentes selon le service. On élargit à la maison — sauf domaine
   *     public, voir `adressesDeLOrganisation`.
   *
   * CHRONOMÉTRÉ AVANT D'ÊTRE ÉCRIT, sur les 139 863 mails de production :
   * l'union coûte 160 ms et rend 37 mails, là où l'ancienne requête coûtait
   * 158 ms pour en rendre 3. L'élargissement est gratuit — le `LIKE` sur
   * `toEmails` était déjà payé.
   */
  /**
   * LES MAISONS DU DOSSIER — celles de TOUS les participants du fil, pas
   * seulement celle de l'expéditeur du mail ouvert.
   *
   * ⚠️ MESURÉ APRÈS UNE PREMIÈRE CORRECTION INSUFFISANTE (27/08). Élargir au
   * domaine de l'ancre faisait passer le dossier ACME de 2 à 4 mails — mieux,
   * mais toujours faux : le mail d'ancrage vient de
   * `compta.client@intermediaire.example.net`, et les 34 mails de l'affaire sont
   * chez `acme.example.com`. Le dossier traverse
   * DEUX maisons, et le fil est précisément ce qui les relie — il contient un
   * message de `litiges@acme.example.com` de juin 2024.
   *
   * La règle qui en sort : les interlocuteurs d'un dossier sont les
   * PARTICIPANTS de son fil. Plafonné à trois maisons — au-delà, on n'a plus
   * un dossier mais une liste de diffusion.
   */
  const participants = courant.threadId !== null
    ? await db.message.findMany({
        where: { threadId: courant.threadId, isDeleted: false },
        select: { fromEmail: true, toEmails: true },
        take: 60,
      })
    : [];
  const candidatsAdresses = [
    cible,
    ...participants.flatMap((m) => [
      m.fromEmail ?? '',
      ...((JSON.parse(m.toEmails || '[]') as string[]) ?? []),
    ]),
  ]
    .map((e) => (e || '').toLowerCase())
    .filter(Boolean);
  const maisons: { domaine: string; adresses: string[] }[] = [];
  const vues = new Set<string>();
  for (const adr of candidatsAdresses) {
    const dom = (adr.split('@')[1] ?? '').toLowerCase();
    if (!dom || vues.has(dom)) continue;
    vues.add(dom);
    const m = await adressesDeLOrganisation(adr);
    if (m && !maisons.some((x) => x.domaine === m.domaine)) maisons.push(m);
    if (maisons.length >= 3) break;
  }
  // La maison qui NOMME l'onglet est choisie plus bas, une fois l'univers
  // connu : celle du mail ouvert n'est pas forcément celle du dossier.
  const maisonDuMailOuvert =
    maisons.find((m) => cible.endsWith(`@${m.domaine}`)) ?? maisons[0] ?? null;
  const tous = await db.message.findMany({
    where: {
      isDeleted: false,
      folder: { role: { notIn: ['spam'] } },
      OR: [
        { fromEmail: cible },
        { toEmails: { contains: cible } },
        ...(courant.threadId !== null ? [{ threadId: courant.threadId }] : []),
        ...maisons.map((m) => ({ fromEmail: { in: m.adresses } })),
        ...maisons.map((m) => ({ toEmails: { contains: `@${m.domaine}` } })),
      ],
    },
    orderBy: { date: 'desc' },
    take: 600,
    select: { ...selection(), threadId: true, fromEmail: true, dossiers: { select: { dossierId: true } } },
  });

  const sujetRef = normaliserSujet(courant.normalizedSubject ?? courant.subject);
  const dossiersRef = new Set(courant.dossiers.map((d) => d.dossierId));

  // Force du lien : plus le nombre est petit, plus le lien est fort.
  const evaluer = (m: (typeof tous)[number]): { force: number; lienPar: string } | null => {
    if (courant.threadId !== null && m.threadId === courant.threadId) {
      return { force: 0, lienPar: 'même conversation' };
    }
    if (sujetRef && normaliserSujet(m.normalizedSubject ?? m.subject) === sujetRef) {
      return { force: 1, lienPar: 'même objet' };
    }
    const communs = m.dossiers.filter((d) => dossiersRef.has(d.dossierId)).length;
    if (communs > 1) return { force: 2, lienPar: `${communs} dossiers en commun` };
    if (communs === 1) return { force: 3, lienPar: 'même dossier' };
    return null;
  };

  const lies: MessageLie[] = [];
  let compteurSujet = 0;
  for (const m of tous) {
    const l = evaluer(m);
    if (!l) continue;
    if (l.force <= 1 && m.id !== courant.id) compteurSujet += 1;
    lies.push({
      ...versEchange(m),
      lienPar: l.lienPar,
      force: l.force,
      estCourant: m.id === courant.id,
    });
  }
  // Tri par FORCE du lien, la date ne départage qu'à force égale.
  lies.sort((a, b) => a.force - b.force || (a.date ?? '').localeCompare(b.date ?? ''));

  const compteurs = {
    sujet: compteurSujet,
    lie: lies.filter((m) => !m.estCourant).length,
    tout: tous.filter((m) => m.id !== courant.id).length,
  };

  // La focale « sujet » resserre sur le fil et l'objet ; « lie » garde tout.
  const retenus = focale === 'sujet' ? lies.filter((m) => m.force <= 1) : lies;
  // Chronologie pour la lecture (le tri par force servait à choisir QUI).
  const parDate = [...retenus].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  const plafond = Math.min(Math.max(opts.limit ?? PLAFOND_LIES, 1), 200);
  // On garde les plus FORTS, puis on les remet en ordre chronologique : sinon
  // un dossier géant noierait le fil courant sous des mails anciens.
  const gardes = retenus.slice(0, plafond + 1).map((m) => m.messageId);
  const messages = parDate.filter((m) => gardes.includes(m.messageId));

  /**
   * QUELLE MAISON NOMME L'ONGLET. Pas celle du mail ouvert : celle qui PORTE
   * le dossier. Mesuré sur ACME — le mail d'ancrage vient de
   * `compta.client@intermediaire.example.net`, mais 28 des 36 mails de l'affaire
   * sont chez `acme.example.com`. Écrire « Tout avec intermediaire.example.net »
   * désignerait l'intermédiaire et
   * pas l'interlocuteur. On prend donc celle qui pèse le plus dans l'univers.
   */
  const poids = new Map<string, number>();
  for (const m of tous) {
    const d = (m.fromEmail ?? '').toLowerCase().split('@')[1];
    if (d) poids.set(d, (poids.get(d) ?? 0) + 1);
  }
  const maisonPrincipale =
    maisons
      .map((m) => ({
        domaine: m.domaine,
        n: [...poids].filter(([d]) => d === m.domaine || d.endsWith(`.${m.domaine}`))
          .reduce((t, [, v]) => t + v, 0),
      }))
      .sort((a, b) => b.n - a.n)[0]?.domaine ?? maisonDuMailOuvert?.domaine ?? null;

  const nom = courant.isOutbound
    ? (tous.find((m) => !m.isOutbound && m.fromName)?.fromName ?? email)
    : (courant.fromName ?? email);

  return {
    email: cible,
    displayName: nom,
    // Le nom de la MAISON quand l'élargissement s'applique : c'est lui que
    // l'onglet doit afficher. « Tout avec Comptabilité » désignait la boîte aux
    // lettres qui avait écrit ce jour-là ; « Tout avec acme.example.com » désigne
    // l'interlocuteur réel.
    organisation: maisonPrincipale,
    accounts: [...new Set(tous.map((m) => m.accountSlug))],
    messageIdCourant: courant.id,
    focale,
    compteurs,
    messages: focale === 'tout' ? [] : messages,
    tronque: Math.max(0, retenus.filter((m) => !m.estCourant).length - plafond),
    // La vue élargie garde le regroupement par conversation : c'est là qu'il
    // explore vraiment, et 800 messages à plat seraient illisibles. Elle est
    // élargie à la maison, sinon le troisième onglet resterait aveugle là où
    // les deux premiers voient enfin.
    sujets: focale === 'tout'
      ? (
          await correspondance({
            email: cible,
            emails: maisons.flatMap((m) => m.adresses),
            limit: 40,
          })
        ).subjects
      : [],
  };
}
