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
function motEntier(terme: string, ...champs: (string | null | undefined)[]): boolean {
  if (!terme) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${echappe(terme)}`, 'iu');
  return champs.some((c) => !!c && re.test(c));
}

function scoreItem(it: SearchResultItem, terme = ''): number {
  let s = 0;
  for (const m of it.matchedIn) s += POIDS[m] ?? 1;
  // À pertinence égale, un document vaut mieux qu'une notification.
  if (it.hasAttachments) s += 1;
  // Un vrai mot vaut bien plus qu'un fragment : sinon « RIB » fait remonter
  // « Ribéroux » avant le mail qui porte réellement un RIB.
  if (terme && motEntier(terme, it.subject, it.fromName, it.summary, ...it.attachmentNames)) {
    s += 4;
  }
  return s;
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
    // Nom affiché : le plus fréquent parmi les expéditeurs du groupe (un même
    // service écrit tantôt « Leroy Merlin », tantôt « LEROY MERLIN Brest »).
    const noms = new Map<string, number>();
    for (const i of arr) {
      const n = (i.fromName || '').trim();
      if (n) noms.set(n, (noms.get(n) ?? 0) + 1);
    }
    const label =
      [...noms].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      (key.includes('@') ? key : key.split('.')[0]);

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
