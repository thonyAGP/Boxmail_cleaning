import { searchIndex, type SearchResultItem } from './search.js';

/**
 * « Retrouver sans classer » (11/08).
 *
 * Anthony ne range rien et ne rangera jamais — le lui demander serait le même
 * reproche sous un autre nom. Ses 25 000 mails ne sont pas sales : ce sont des
 * archives personnelles et professionnelles non structurées (mesuré le 10/08 :
 * 4 645 mails à pièce jointe, 4 048 factures/documents, 3 472 mails de vraies
 * personnes). Le produit ne doit donc pas l'aider à ranger, mais à RETROUVER.
 *
 * Concrètement : une recherche ne renvoie plus 500 lignes à plat triées par
 * date — ça, c'est la liste de 1990 qu'il déteste — mais quelques
 * INTERLOCUTEURS, chacun avec ce qu'il lui a envoyé.
 *
 * Aucun mail n'est déplacé : l'organisation est virtuelle, elle vit ici.
 *
 * LOT 4H (12/08) : les ENTITÉS du verdict sémantique servent au classement
 * (une correspondance sur une entité pèse comme un nom de fichier) et au nom
 * des groupes (`labelDuGroupe`). La CLÉ de regroupement, elle, reste le
 * domaine de l'expéditeur — volontairement : re-clé-er sur l'entité couperait
 * chaque interlocuteur en deux groupes, ses mails analysés d'un côté et les
 * autres de l'autre, tant que l'analyse n'a pas tout relu.
 */

/** Domaines grand public : derrière, il y a une personne, pas une entreprise. */
const DOMAINES_PERSO =
  /^(hotmail|gmail|live|outlook|yahoo|msn|orange|wanadoo|free|sfr|laposte|icloud|me|aol|bbox|numericable)\./i;

/** Sous-domaines d'envoi sans valeur d'identité : mail.leroymerlin.fr = Leroy Merlin. */
const PREFIXES_ENVOI =
  /^(mail|mails|email|e|em|news|newsletter|newsletters|info|infos|notification|notifications|notif|no-?reply|noreply|reply|send|sender|sending|smtp|mailer|marketing|com|contact|message|messages|go|link|links|t|r|m|bp|trc)\./i;

/**
 * Entité expéditrice : ce qu'un humain considère comme « le même
 * interlocuteur ». Les deux adresses Leroy Merlin (leroymerlin@mail. et
 * leroymerlin@news.) sont un seul magasin ; en revanche deux adresses gmail
 * sont deux personnes différentes — d'où le traitement à part.
 */
export function entiteExpediteur(email: string | null | undefined): string {
  const addr = (email ?? '').toLowerCase().trim();
  if (!addr.includes('@')) return addr || '(inconnu)';
  const domaine = addr.split('@')[1] ?? '';
  // Personne physique : l'adresse ENTIÈRE fait l'identité, sinon tous ses
  // contacts gmail fusionneraient en un seul groupe « gmail ».
  if (DOMAINES_PERSO.test(domaine)) return addr;
  // Entreprise : on retire les sous-domaines d'envoi, puis on garde la racine.
  let d = domaine;
  let coupe = true;
  while (coupe) {
    coupe = false;
    if (PREFIXES_ENVOI.test(d)) {
      d = d.slice(d.indexOf('.') + 1);
      coupe = true;
    }
  }
  return d || addr;
}

/** Poids d'un résultat selon l'endroit où le terme a été trouvé. */
const POIDS: Record<string, number> = {
  'pièce jointe': 4,
  sujet: 3,
  // Une ENTITÉ ou un DOSSIER nommés par l'analyse (lot 4h) pèsent comme un nom
  // de fichier : l'analyse a lu le mail entier, ce n'est pas un mot noyé dans
  // le texte — c'est précisément ce qui retrouve « 46 rue de la République »
  // quand le sujet se tait.
  'entité citée': 4,
  'dossier cité': 4,
  expéditeur: 2,
  'contenu de la pièce': 3,
  résumé: 2,
  'texte du mail': 1,
};

/** Échappe un terme pour l'insérer dans une expression régulière. */
function echappe(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Le terme est-il un VRAI mot, ou un morceau perdu au milieu d'un autre ?
 *
 * Constaté sur les vraies boîtes : chercher « RIB » remontait « Cabinet
 * Ribéroux » et « bnpparibascardif ». La base ne sait faire qu'un `contains`,
 * mais rien n'oblige à classer ces résultats aussi haut qu'une vraie
 * correspondance : on vérifie ici que le terme commence sur une frontière de
 * mot (espace, tiret, souligné, point…).
 */
function qualiteMot(terme: string, ...champs: (string | null | undefined)[]): 0 | 1 | 2 {
  if (!terme) return 0;
  const t = echappe(terme);
  const bord = '[^\\p{L}\\p{N}]';
  // Mot entier : « RIB Headlight Audit.pdf », « quittance_juin.pdf ».
  const exact = new RegExp(`(^|${bord})${t}($|${bord})`, 'iu');
  // Simple début de mot : « Ribéroux » quand on cherche « RIB ». Utile (on
  // veut que « factur » trouve « facture »), mais nettement moins probant.
  const debut = new RegExp(`(^|${bord})${t}`, 'iu');
  const ok = (re: RegExp) => champs.some((c) => !!c && re.test(c));
  if (ok(exact)) return 2;
  if (ok(debut)) return 1;
  return 0;
}

function scoreItem(it: SearchResultItem, terme = ''): number {
  let s = 0;
  for (const m of it.matchedIn) s += POIDS[m] ?? 1;
  // À pertinence égale, un document vaut mieux qu'une notification.
  if (it.hasAttachments) s += 1;
  // Un vrai mot vaut bien plus qu'un fragment : sinon « RIB » fait remonter
  // « Cabinet Ribéroux » (48 mails) avant le mail qui porte vraiment un RIB.
  // Les entités et contextes lus par l'analyse comptent au même titre (4h).
  const q = qualiteMot(
    terme,
    it.subject,
    it.fromName,
    it.summary,
    ...it.attachmentNames,
    ...it.entites.map((e) => e.nameRaw),
    ...it.contextes,
  );
  s += q === 2 ? 6 : q === 1 ? 1 : 0;
  return s;
}

/**
 * Nom affiché d'un groupe (lot 4h) : l'ENTITÉ `sent_by` lue par l'analyse
 * prime quand elle existe — le nom d'affichage d'un expéditeur est déclaratif
 * et changeant (« LEROY MERLIN Brest », « noreply »), l'entité dit QUI écrit
 * vraiment. À défaut : le nom d'affichage le plus fréquent, puis la clé.
 * Fonction pure — le banc l'éprouve avec des items en mémoire.
 */
export function labelDuGroupe(
  arr: { fromName: string; entites: { nameRaw: string; role: string }[] }[],
  key: string,
): string {
  const plusFrequent = (vals: string[]): string | null => {
    const n = new Map<string, number>();
    for (const v of vals) n.set(v, (n.get(v) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const entites = arr
    .flatMap((i) => i.entites.filter((e) => e.role === 'sent_by').map((e) => e.nameRaw.trim()))
    .filter(Boolean);
  const noms = arr.map((i) => (i.fromName || '').trim()).filter(Boolean);
  return (
    plusFrequent(entites) ??
    plusFrequent(noms) ??
    (key.includes('@') ? key : key.split('.')[0])
  );
}

export interface FindGroup {
  /** Clé de regroupement (entité ou adresse) — stable, sert au dépliage. */
  key: string;
  /** Nom lisible : « Crédit Agricole », « Nathalie HATEM ». */
  label: string;
  /** Boîtes dans lesquelles cet interlocuteur apparaît. */
  accounts: string[];
  /** Nombre de mails retenus pour ce groupe. */
  count: number;
  /** Combien portent une pièce jointe. */
  withAttachments: number;
  /** Quelques noms de fichiers, pour reconnaître d'un coup d'œil. */
  fileNames: string[];
  firstAt: string | null;
  lastAt: string | null;
  /** Les meilleurs mails du groupe (les autres se déplient à la demande). */
  items: SearchResultItem[];
}

export interface FindResult {
  query: string;
  /** Nombre total de mails correspondants dans l'index. */
  total: number;
  /** true si l'index en contient plus que ce qui a été analysé. */
  truncated: boolean;
  /** Mails analysés pour construire les groupes. */
  examined: number;
  groups: FindGroup[];
  /** Facettes, pour affiner sans taper une syntaxe. */
  facets: {
    accounts: { account: string; count: number }[];
    withAttachments: number;
    /** Où les correspondances ont été trouvées, tous résultats confondus. */
    matchedIn: { label: string; count: number }[];
  };
}

export interface FindOptions {
  q: string;
  account?: string;
  /** true = uniquement les mails porteurs d'un document. */
  withAttachments?: boolean;
  since?: Date;
  /** Nombre de groupes renvoyés (défaut 8). */
  maxGroups?: number;
  /** Mails montrés par groupe avant dépliage (défaut 3). */
  perGroup?: number;
  /** Profondeur d'analyse dans l'index (défaut 400, plafond 500). */
  scan?: number;
}

export async function find(opts: FindOptions): Promise<FindResult> {
  const q = (opts.q ?? '').trim();
  const maxGroups = Math.min(Math.max(opts.maxGroups ?? 8, 1), 30);
  const perGroup = Math.min(Math.max(opts.perGroup ?? 3, 1), 20);
  const scan = Math.min(Math.max(opts.scan ?? 400, 20), 500);

  const brut = await searchIndex({
    q: q || undefined,
    account: opts.account,
    withAttachments: opts.withAttachments,
    since: opts.since,
    limit: scan,
  });

  // Corbeille et brouillons n'ont rien à faire dans une recherche de mémoire.
  const items = brut.items.filter((i) => i.folderRole !== 'trash' && i.folderRole !== 'drafts');

  const parGroupe = new Map<string, SearchResultItem[]>();
  for (const it of items) {
    const cle = entiteExpediteur(it.fromEmail);
    const arr = parGroupe.get(cle) ?? [];
    arr.push(it);
    parGroupe.set(cle, arr);
  }

  const groupes: FindGroup[] = [];
  for (const [key, arr] of parGroupe) {
    arr.sort((a, b) => scoreItem(b, q) - scoreItem(a, q) || (b.date ?? '').localeCompare(a.date ?? ''));
    const dates = arr.map((i) => i.date).filter((d): d is string => !!d).sort();
    // Nom affiché : l'entité lue par l'analyse quand elle existe, sinon le nom
    // le plus fréquent (un même service écrit tantôt « Leroy Merlin », tantôt
    // « LEROY MERLIN Brest »).
    const label = labelDuGroupe(arr, key);

    const fichiers: string[] = [];
    for (const i of arr) {
      for (const n of i.attachmentNames) {
        if (fichiers.length < 6 && !fichiers.includes(n)) fichiers.push(n);
      }
    }
    groupes.push({
      key,
      label,
      accounts: [...new Set(arr.map((i) => i.account))],
      count: arr.length,
      withAttachments: arr.filter((i) => i.hasAttachments).length,
      fileNames: fichiers,
      firstAt: dates[0] ?? null,
      lastAt: dates[dates.length - 1] ?? null,
      items: arr.slice(0, perGroup),
    });
  }

  // Classement des groupes : la PERTINENCE d'abord (où le mot a été trouvé),
  // le volume ensuite — un groupe de 2 mails peut être la bonne réponse.
  const scoreGroupe = (g: FindGroup) => {
    const meilleurs = g.items.reduce((s, i) => s + scoreItem(i, q), 0);
    // Le volume compte, mais peu : un groupe de 2 mails peut être la bonne
    // réponse, et 48 mails d'un « Cabinet Ribéroux » ne doivent pas écraser
    // le seul mail qui porte vraiment un RIB.
    return meilleurs + Math.min(g.count, 20) / 10 + (g.withAttachments ? 1 : 0);
  };
  groupes.sort((a, b) => scoreGroupe(b) - scoreGroupe(a) || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));

  const parCompte = new Map<string, number>();
  const parEndroit = new Map<string, number>();
  for (const it of items) {
    parCompte.set(it.account, (parCompte.get(it.account) ?? 0) + 1);
    for (const m of it.matchedIn) parEndroit.set(m, (parEndroit.get(m) ?? 0) + 1);
  }

  return {
    query: q,
    total: brut.total,
    truncated: brut.truncated,
    examined: items.length,
    groups: groupes.slice(0, maxGroups),
    facets: {
      accounts: [...parCompte]
        .map(([account, count]) => ({ account, count }))
        .sort((a, b) => b.count - a.count),
      withAttachments: items.filter((i) => i.hasAttachments).length,
      matchedIn: [...parEndroit]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}
