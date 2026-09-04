import {
  candidatsRecherche,
  existenceDesMots,
  hydraterMessages,
  libellesDuMasque,
  MATCH_CONTENU_PIECE,
  MATCH_CONTEXTE,
  MATCH_ENTITE,
  MATCH_EXPEDITEUR,
  MATCH_NOM_PIECE,
  MATCH_RESUME,
  MATCH_SUJET,
  MATCH_TEXTE,
  type CandidatRecherche,
  type SearchResultItem,
} from './search.js';
import { decouperTermes } from './termes.js';

/**
 * « Retrouver sans classer » (11/08).
 *
 * Anthony ne range rien et ne rangera jamais — le lui demander serait le même
 * reproche sous un autre nom. Ses 41 000 mails ne sont pas sales : ce sont des
 * archives personnelles et professionnelles non structurées. Le produit ne doit
 * donc pas l'aider à ranger, mais à RETROUVER.
 *
 * Concrètement : une recherche ne renvoie plus 500 lignes à plat triées par
 * date — ça, c'est la liste de 1990 qu'il déteste — mais quelques
 * INTERLOCUTEURS, chacun avec ce qu'il lui a envoyé.
 *
 * Aucun mail n'est déplacé : l'organisation est virtuelle, elle vit ici.
 *
 * LOT 4H (12/08) : les ENTITÉS du verdict sémantique servent au classement
 * (une correspondance sur une entité pèse comme un nom de fichier) et au nom
 * des groupes (`labelDuGroupe`).
 *
 * 19/08 — DEUX CORRECTIONS DE FOND, après le retour « c'est très lent et le tri
 * est fait n'importe comment » :
 *
 *  1. On groupe et on trie sur le vivier COMPLET, plus sur les 400 mails les
 *     plus récents. L'ancien `take 400` ne bornait pas l'affichage, il bornait
 *     l'UNIVERS : on ne classait pas « les interlocuteurs les plus pertinents »
 *     mais « les plus pertinents parmi les 400 plus récents », et un résultat
 *     fort de 2019 était écarté avant d'être vu. Phase A compacte et exhaustive
 *     (search.ts), tri global ici, puis hydratation des seuls mails montrés.
 *
 *  2. L'interlocuteur d'un mail ENVOYÉ est son DESTINATAIRE. Le corpus compte
 *     5 976 mails envoyés : groupés sur l'expéditeur, ils tombaient tous dans
 *     une carte « moi-même », qui ne veut rien dire. Les deux sens d'un échange
 *     se rejoignent maintenant dans une seule carte — ce que la page promet
 *     depuis le début (« un échange avec quelqu'un »).
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

/**
 * Les adresses de « l'autre côté » d'un mail — l'interlocuteur, pas le rôle.
 *
 * Reçu : c'est l'expéditeur. Envoyé : ce sont les destinataires (`toEmails`,
 * stocké en JSON). Un envoi à plusieurs compte dans CHAQUE interlocuteur
 * concerné : n'en garder qu'un serait arbitraire, et le mail disparaîtrait de
 * la carte des autres — or c'est bien le même échange pour chacun d'eux.
 */
export function interlocuteursDe(c: {
  isOutbound: boolean;
  fromEmail: string;
  toEmails: string;
}): string[] {
  if (!c.isOutbound) return c.fromEmail ? [c.fromEmail] : [];
  let adresses: string[] = [];
  try {
    const brut: unknown = JSON.parse(c.toEmails || '[]');
    if (Array.isArray(brut)) adresses = brut.map((x) => String(x ?? '')).filter(Boolean);
  } catch {
    // toEmails malformé (1 mail sur 5 976 en production) : on retombe sur
    // l'expéditeur plutôt que de perdre le mail.
  }
  return adresses.length ? adresses.slice(0, 10) : c.fromEmail ? [c.fromEmail] : [];
}

/** Poids d'un résultat selon l'endroit où le terme a été trouvé. */
const POIDS: [number, number][] = [
  // Une ENTITÉ ou un DOSSIER nommés par l'analyse pèsent comme un nom de
  // fichier : l'analyse a lu le mail entier, ce n'est pas un mot noyé dans le
  // texte — c'est précisément ce qui retrouve « 46 rue de la République »
  // quand le sujet se tait.
  [MATCH_NOM_PIECE, 4],
  [MATCH_ENTITE, 4],
  [MATCH_CONTEXTE, 4],
  [MATCH_SUJET, 3],
  [MATCH_EXPEDITEUR, 2],
  [MATCH_RESUME, 2],
  // 24/08 — RAMENÉ DE 3 À 1. Le contenu d'une pièce jointe pesait autant qu'un
  // sujet de mail, ce qui n'a aucun sens à la réflexion : un procès-verbal d'AG
  // de copropriété fait cinquante pages et contient « facture », « électricité »
  // et le nom de l'immeuble quelque part, forcément. Chercher
  // « facture électricité miron » remontait ainsi des PV, des DPGF et des
  // décomptes de charges — « complètement hors sujet », et il a raison.
  // Un mot trouvé dans un document entier reste un signal, mais le plus faible.
  [MATCH_CONTENU_PIECE, 1],
  [MATCH_TEXTE, 1],
];

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
  const { exact, debut } = motifsDe(terme);
  const ok = (re: RegExp) => champs.some((c) => !!c && re.test(c));
  if (ok(exact)) return 2;
  if (ok(debut)) return 1;
  return 0;
}

/**
 * Les deux expressions régulières du terme, compilées UNE fois.
 *
 * Elles l'étaient à chaque appel, donc une fois par mail candidat : sans
 * conséquence tant qu'on n'en voyait que 400, mais la recherche examine
 * maintenant tout le vivier — jusqu'à 21 605 mails sur un mot courant, soit
 * plus de 43 000 compilations pour une seule recherche.
 */
const MOTIFS = new Map<string, { exact: RegExp; debut: RegExp }>();
function motifsDe(terme: string): { exact: RegExp; debut: RegExp } {
  let m = MOTIFS.get(terme);
  if (!m) {
    const t = echappe(terme);
    const bord = '[^\\p{L}\\p{N}]';
    m = {
      // Mot entier : « RIB Headlight Audit.pdf », « quittance_juin.pdf ».
      exact: new RegExp(`(^|${bord})${t}($|${bord})`, 'iu'),
      // Simple début de mot : « Ribéroux » quand on cherche « RIB ». Utile (on
      // veut que « factur » trouve « facture »), mais nettement moins probant.
      debut: new RegExp(`(^|${bord})${t}`, 'iu'),
    };
    // Un cache non borné deviendrait une fuite : on cherche beaucoup de mots
    // différents, et deux compilations sont vite refaites.
    if (MOTIFS.size > 200) MOTIFS.clear();
    MOTIFS.set(terme, m);
  }
  return m;
}

/** Score d'un mail candidat : où les mots ont été vus, et à quel point ce sont de vrais mots. */
function scoreCandidat(c: CandidatRecherche, mots: string[]): number {
  let s = 0;
  for (const [bit, poids] of POIDS) if (c.mask & bit) s += poids;
  // À pertinence égale, un document vaut mieux qu'une notification.
  if (c.hasAttachments) s += 1;

  // Un vrai mot vaut bien plus qu'un fragment : sinon « RIB » fait remonter
  // « Cabinet Ribéroux » (48 mails) avant le mail qui porte vraiment un RIB.
  // Sur plusieurs mots, on prend la MOYENNE : la somme avantagerait
  // mécaniquement les recherches longues, ce qui n'a aucun sens puisqu'on
  // compare des mails entre eux, à requête constante.
  if (mots.length) {
    let q = 0;
    for (const m of mots) {
      const n = qualiteMot(m, c.subject, c.fromName, c.attachmentNames);
      q += n === 2 ? 6 : n === 1 ? 1 : 0;
    }
    s += q / mots.length;
  }

  // Les mots RÉUNIS au même endroit (23/08). Trois mots éparpillés dans trois
  // champs sans rapport ne valent pas trois mots dans la même phrase — sans
  // cela, le multi-mots ferait remonter des coïncidences en tête.
  s += Math.max(0, c.concentration - 1) * 3;

  // En mode repli, tous les mails n'ont pas tous les mots : ceux qui les ont
  // tous passent devant, sinon le repli enterrerait ses meilleurs résultats.
  s -= Math.max(0, mots.length - c.motsTrouves) * 4;

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

/**
 * Réunir les cartes d'un MÊME interlocuteur (19/08) — « très bizarre d'avoir
 * 2 expéditeurs alors que les 2 viennent du domaine volotea, même si les
 * adresses sont différentes (ce sont des messages automatiques de la même
 * société) ».
 *
 * Il a raison : Volotea écrit depuis `volotea.com` ET depuis
 * `voloteahelp.zendesk.com` (son guichet de support). Le domaine racine ne
 * suffit donc pas — une société parle par plusieurs portes.
 *
 * MAIS fusionner sur le nom affiché seul serait catastrophique. Simulé sur les
 * 1 819 interlocuteurs réels avant d'écrire une ligne : 107 noms sont portés
 * par plusieurs domaines, et parmi eux « Équipe des comptes Microsoft »
 * regroupait `microsoft.com` avec `daum.net` (usurpation), un nom de personne
 * physique trois domaines de spam sans rapport, un nom de cabinet comptable
 * trois sociétés différentes, « fr » un fournisseur de propreté avec Bosch.
 *
 * D'où la GARDE : on ne réunit que si le nom se retrouve DANS le domaine.
 * `voloteahelp.zendesk.com` contient « volotea » — c'est bien Volotea ;
 * `trustpilotmail.com`, qui écrit pourtant sous le nom « Volotea », ne le
 * contient pas et reste à part — c'est bien un autre expéditeur.
 *
 * Résultat simulé : 48 réunions, 61 clés absorbées, toutes vérifiées une par
 * une (Airbnb, Leroy Merlin, Air France, AXA, IKEA, EDF, Enedis, La Poste,
 * Antai, France Travail…), zéro rapprochement abusif. Bonus : les personnes
 * qui écrivent depuis deux adresses (Daniel HELAOUET en free/orange/yahoo) se
 * retrouvent enfin dans une seule carte.
 */
const LONGUEUR_MIN_NOM = 4;

/**
 * Mots trop courants pour identifier qui que ce soit. Sans eux, « Support
 * Machin » et « Support Truc » se retrouveraient réunis sous « support » dès
 * que leurs domaines contiennent le mot — ce qui arrive tout le temps.
 */
const MOTS_GENERIQUES = new Set([
  'support', 'service', 'services', 'contact', 'info', 'infos', 'client',
  'clients', 'equipe', 'team', 'noreply', 'reply', 'notification',
  'notifications', 'newsletter', 'news', 'assistance', 'compte', 'mon',
  'espace', 'groupe', 'group', 'mail', 'email', 'message', 'messages',
  'centre', 'agence', 'boutique', 'app', 'web', 'online', 'direct', 'pro',
  'atelier', 'cabinet', 'societe', 'maison', 'sarl', 'sasu', 'sci',
]);

/** Réduit un texte à ses lettres et chiffres, sans accents ni casse. */
export function compacte(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Les mots du nom affiché, sans accents ni ponctuation. */
function motsDe(label: string): string[] {
  return (label ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * La clé de réunion d'un groupe : le PLUS LONG début de son nom affiché qui se
 * retrouve dans son propre domaine — sinon `null`, et le groupe reste seul.
 *
 * Pourquoi un « début » et pas le nom entier : les expéditeurs signent
 * « Air France pour ANTHONY LE BERRE », « Airbnb Photo Team », « Airbnb
 * Team ». Exiger le nom complet laissait ces cartes à part alors que leurs
 * domaines (`service-airfrance.com`, `photography.airbnb.com`) disent
 * clairement de qui il s'agit.
 *
 * Deux gardes, et elles font tout le travail :
 *  - le début retenu doit se lire DANS le domaine — « Air France Info Vol »
 *    envoyé depuis `connect-passengers.com` reste donc séparé, à raison :
 *    c'est un prestataire, pas la compagnie ;
 *  - il doit faire au moins 4 caractères et ne pas être un mot passe-partout,
 *    sinon « Support X » et « Support Y » se retrouveraient réunis.
 */
export function cleDeReunion(label: string, cleDomaine: string): string | null {
  const domaine = compacte(cleDomaine);
  const mots = motsDe(label);
  if (!mots.length) return null;

  // PERSONNE PHYSIQUE (la clé est l'adresse entière, chez un fournisseur grand
  // public) : on exige le nom COMPLET. Simulé sans cette réserve, un début
  // suffisant réunissait « Philippe Cottet » et « philippe jacquot », ou
  // « Mélanie Baltazar » et « Melanie Duran » — deux personnes, une carte.
  // Avec elle, « Daniel HELAOUET » retrouve bien ses trois adresses (free,
  // orange, yahoo), parce que son nom entier est dans chacune.
  if (cleDomaine.includes('@')) {
    const entier = mots.join('');
    return entier.length >= LONGUEUR_MIN_NOM && domaine.includes(entier) ? entier : null;
  }

  // ENTREPRISE : du plus long au plus court, on garde la désignation la plus
  // précise que le domaine confirme.
  for (let n = mots.length; n >= 1; n--) {
    const debut = mots.slice(0, n).join('');
    if (debut.length < LONGUEUR_MIN_NOM) continue;
    if (n === 1 && MOTS_GENERIQUES.has(mots[0])) continue;
    if (domaine.includes(debut)) return debut;
  }
  return null;
}

/**
 * Les ordres proposés à l'écran. Un SEUL réglage visible, qui décide de tout :
 * l'ordre des interlocuteurs ET celui des mails dans leur carte. Deux
 * sélecteurs séparés seraient techniquement plus purs et ergonomiquement pires.
 */
export const TRIS = ['recent', 'ancien', 'az', 'za', 'pertinence'] as const;
export type TriRecherche = (typeof TRIS)[number];

export interface FindGroup {
  /** Clé de regroupement (entité ou adresse) — stable, sert au dépliage. */
  key: string;
  /** Nom lisible : « Crédit Agricole », « Nathalie HATEM ». */
  label: string;
  /**
   * D'où viennent ces mails (le domaine, ou l'adresse pour une personne).
   * L'écran ne le montre QUE si deux cartes portent le même nom — sinon c'est
   * du bruit. Cas réel : « Airbnb » depuis `airbnb.com` et « Airbnb » depuis
   * `express.medallia.com`, le prestataire qui envoie ses questionnaires. Les
   * réunir serait faux (medallia écrit pour d'autres marques) ; ne rien dire
   * laisserait Anthony devant deux cartes identiques.
   */
  via: string;
  /** Boîtes dans lesquelles cet interlocuteur apparaît. */
  accounts: string[];
  /** Nombre de mails retenus pour ce groupe. */
  count: number;
  /** Combien portent une pièce jointe. */
  withAttachments: number;
  /** Combien ont été ÉCRITS par Anthony (l'autre part étant reçue). */
  sent: number;
  /** Quelques noms de fichiers, pour reconnaître d'un coup d'œil. */
  fileNames: string[];
  firstAt: string | null;
  lastAt: string | null;
  /** Les mails du groupe déjà hydratés (les autres se déplient à la demande). */
  items: SearchResultItem[];
}

export interface FindResult {
  query: string;
  /** Nombre total de mails correspondants — exact, plus une estimation. */
  total: number;
  /** Nombre d'interlocuteurs concernés, tous groupes confondus. */
  totalGroups: number;
  /** true s'il y a plus d'interlocuteurs que de cartes affichées. */
  truncated: boolean;
  /** Mails analysés pour construire les groupes (= total, la recherche est exhaustive). */
  examined: number;
  /** Ordre appliqué (celui demandé, ou « recent » par défaut). */
  sort: TriRecherche;
  /**
   * Ce que la recherche a COMPRIS de la phrase tapée (23/08), pour que l'écran
   * puisse le montrer. Reproche constant d'Anthony : le produit « n'explique
   * pas ». Une recherche qui découpe en silence est pire qu'une recherche
   * bête — il ne peut pas voir qu'un mot a été mal coupé ou écarté.
   */
  recherche: {
    /** Les mots effectivement exigés. */
    mots: string[];
    /** Les mots creux ou trop courts qui ont été retirés. */
    ecartes: string[];
    /** true si la phrase a été cherchée d'un bloc (guillemets). */
    litteral: boolean;
    /** Mots qui n'apparaissent dans AUCUN mail — la vraie cause d'un vide. */
    motsAbsents: string[];
    /** Combien de mots un mail devait porter pour être retenu. */
    minMots: number;
    /** Ce qu'il a fallu relâcher, s'il a fallu relâcher quelque chose. */
    repli: 'aucun' | 'mots-absents' | 'moins-de-mots' | 'rien-de-trouvable';
  };
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
  /** Ordre demandé (défaut : les plus récents). */
  sort?: TriRecherche;
}

interface GroupeInterne {
  key: string;
  labelProvisoire: string;
  accounts: Set<string>;
  candidats: CandidatRecherche[];
  score: number;
  maxDate: string | null;
  minDate: string | null;
}

export async function find(opts: FindOptions): Promise<FindResult> {
  const q = (opts.q ?? '').trim();
  const maxGroups = Math.min(Math.max(opts.maxGroups ?? 8, 1), 30);
  const perGroup = Math.min(Math.max(opts.perGroup ?? 3, 1), 20);
  const sort: TriRecherche = TRIS.includes(opts.sort as TriRecherche)
    ? (opts.sort as TriRecherche)
    : 'recent';

  // --- Phase A : tout le vivier, en lignes maigres --------------------------
  // La phrase devient des MOTS (23/08). Avant, « facture électricité miron »
  // était cherché comme une chaîne de 25 caractères : aucun mail réel ne
  // s'appelle comme ça, d'où l'écran vide.
  const termes = decouperTermes(q);
  const filtres = {
    account: opts.account,
    withAttachments: opts.withAttachments,
    since: opts.since,
  };

  let mots = termes.mots;
  let minMots = mots.length;
  let motsAbsents: string[] = [];
  let repli: FindResult['recherche']['repli'] = 'aucun';
  let candidats = await candidatsRecherche({ mots, ...filtres });

  // --- Le repli, plutôt que l'écran vide ------------------------------------
  // Exiger TOUS les mots est le bon défaut, mais c'est aussi le bon moyen de
  // ne rien rendre parce qu'un seul mot périphérique manque. On aurait alors
  // remplacé « 0 résultat à tort » par « 0 résultat pour une autre raison » —
  // du point de vue d'Anthony, exactement le même écran.
  if (!candidats.length && mots.length > 1) {
    const existent = await existenceDesMots(mots, filtres);
    const presents = mots.filter((_, i) => existent[i]);
    motsAbsents = mots.filter((_, i) => !existent[i]);

    if (!presents.length) {
      // Aucun mot ne mène nulle part : inutile d'insister, mais on saura DIRE
      // lesquels plutôt que de hausser les épaules.
      repli = 'rien-de-trouvable';
    } else if (motsAbsents.length) {
      // Il y a un intrus. On cherche sans lui, en le nommant à l'écran.
      mots = presents;
      minMots = mots.length;
      repli = 'mots-absents';
      candidats = await candidatsRecherche({ mots, ...filtres });
    } else {
      // Tous les mots existent, mais jamais ensemble : on en exige un de
      // moins. Le score pénalise les mails incomplets, donc les plus proches
      // de la demande restent en tête.
      minMots = mots.length - 1;
      repli = 'moins-de-mots';
      candidats = await candidatsRecherche({ mots, minMots, ...filtres });
    }
  }

  // --- Groupement par INTERLOCUTEUR (et non par expéditeur) -----------------
  const parGroupe = new Map<string, GroupeInterne>();
  for (const c of candidats) {
    const score = scoreCandidat(c, mots);
    for (const adresse of interlocuteursDe(c)) {
      const key = entiteExpediteur(adresse);
      let g = parGroupe.get(key);
      if (!g) {
        g = {
          key,
          labelProvisoire: '',
          accounts: new Set(),
          candidats: [],
          score: 0,
          maxDate: null,
          minDate: null,
        };
        parGroupe.set(key, g);
      }
      g.candidats.push(c);
      g.accounts.add(c.account);
      g.score += score;
      // Les bornes se calculent sur les mails QUI CORRESPONDENT : trier sur le
      // dernier mail quelconque ferait remonter un interlocuteur dont le seul
      // rapport avec « avocat » date de 2021, au prétexte qu'il a envoyé une
      // newsletter hier.
      if (c.date) {
        if (!g.maxDate || c.date > g.maxDate) g.maxDate = c.date;
        if (!g.minDate || c.date < g.minDate) g.minDate = c.date;
      }
    }
  }

  // Un nom lisible AVANT hydratation : il faut pouvoir trier de A à Z sans
  // avoir chargé les mails. Les entités de l'analyse affineront ensuite.
  for (const g of parGroupe.values()) {
    g.labelProvisoire = labelDuGroupe(
      g.candidats.map((c) => ({ fromName: c.fromName, entites: [] })),
      g.key,
    );
  }

  // Une société parle par plusieurs portes : on réunit ses cartes AVANT de
  // trier, sinon le classement porterait sur des morceaux d'interlocuteur.
  const reunis = reunirMemeInterlocuteur([...parGroupe.values()]);

  // --- Tri GLOBAL, sur tous les interlocuteurs ------------------------------
  const groupesTries = reunis.sort(comparateurGroupes(sort));
  const retenus = groupesTries.slice(0, maxGroups);

  // --- Phase B : on n'hydrate que les mails réellement montrés --------------
  const aMontrer = new Map<string, CandidatRecherche[]>();
  for (const g of retenus) {
    const ordonnes = [...g.candidats].sort(comparateurMails(sort, mots));
    aMontrer.set(g.key, ordonnes.slice(0, perGroup));
  }
  const hydrates = await hydraterMessages(
    [...new Set([...aMontrer.values()].flat().map((c) => c.id))],
  );

  const groupes: FindGroup[] = retenus.map((g) => {
    const montres = aMontrer.get(g.key) ?? [];
    const items = montres
      .map((c) => {
        const item = hydrates.get(c.id);
        // `matchedIn` vient du masque calculé en SQL : la ligne hydratée ne
        // porte pas l'OCR, on ne pourrait plus dire « trouvé dans le contenu
        // de la pièce » en le recalculant ici.
        return item ? { ...item, matchedIn: libellesDuMasque(c.mask) } : null;
      })
      .filter((x): x is SearchResultItem => !!x);

    const fichiers: string[] = [];
    for (const c of g.candidats) {
      for (const n of c.attachmentNames.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        if (fichiers.length < 6 && !fichiers.includes(n)) fichiers.push(n);
      }
    }
    return {
      key: g.key,
      // L'entité lue par l'analyse prime, quand les mails montrés en portent une.
      label: labelDuGroupe(
        items.map((i) => ({ fromName: i.fromName, entites: i.entites })),
        g.key,
      ) || g.labelProvisoire,
      via: g.key,
      accounts: [...g.accounts],
      count: g.candidats.length,
      withAttachments: g.candidats.filter((c) => c.hasAttachments).length,
      sent: g.candidats.filter((c) => c.isOutbound).length,
      fileNames: fichiers,
      firstAt: g.minDate,
      lastAt: g.maxDate,
      items,
    };
  });

  // Le tri A→Z porte sur le nom RÉELLEMENT affiché : l'analyse a pu rebaptiser
  // un groupe (« noreply@… » devenu « Crédit Agricole ») entre-temps.
  if (sort === 'az' || sort === 'za') {
    const sens = sort === 'az' ? 1 : -1;
    groupes.sort((a, b) => sens * a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }));
  }

  const parCompte = new Map<string, number>();
  const parEndroit = new Map<string, number>();
  for (const c of candidats) {
    parCompte.set(c.account, (parCompte.get(c.account) ?? 0) + 1);
    for (const m of libellesDuMasque(c.mask)) parEndroit.set(m, (parEndroit.get(m) ?? 0) + 1);
  }

  return {
    query: q,
    total: candidats.length,
    // Le nombre d'interlocuteurs annoncé est celui d'APRÈS réunion : c'est ce
    // qu'il voit à l'écran, pas le décompte interne des domaines.
    totalGroups: reunis.length,
    truncated: reunis.length > groupes.length,
    examined: candidats.length,
    sort,
    recherche: {
      mots,
      ecartes: termes.ecartes,
      litteral: termes.litteral,
      motsAbsents,
      minMots,
      repli,
    },
    groups: groupes,
    facets: {
      accounts: [...parCompte]
        .map(([account, count]) => ({ account, count }))
        .sort((a, b) => b.count - a.count),
      withAttachments: candidats.filter((c) => c.hasAttachments).length,
      matchedIn: [...parEndroit]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

/**
 * Réunit les groupes qui désignent le même interlocuteur (voir `cleDeReunion`).
 * Le groupe le plus volumineux donne sa clé — celle qui sert au dépliage — et
 * les mails sont dédoublonnés : un envoi à plusieurs destinataires d'une même
 * société pourrait sinon être compté deux fois dans la carte réunie.
 */
function reunirMemeInterlocuteur(groupes: GroupeInterne[]): GroupeInterne[] {
  const parNom = new Map<string, GroupeInterne[]>();
  const seuls: GroupeInterne[] = [];
  for (const g of groupes) {
    const cle = cleDeReunion(g.labelProvisoire, g.key);
    if (!cle) { seuls.push(g); continue; }
    const l = parNom.get(cle);
    if (l) l.push(g);
    else parNom.set(cle, [g]);
  }
  const out = [...seuls];
  for (const lot of parNom.values()) {
    if (lot.length === 1) { out.push(lot[0]); continue; }
    lot.sort((a, b) => b.candidats.length - a.candidats.length);
    const chef = lot[0];
    const vus = new Set(chef.candidats.map((c) => c.id));
    for (const autre of lot.slice(1)) {
      for (const c of autre.candidats) {
        if (vus.has(c.id)) continue;
        vus.add(c.id);
        chef.candidats.push(c);
      }
      for (const a of autre.accounts) chef.accounts.add(a);
      chef.score += autre.score;
      if (autre.maxDate && (!chef.maxDate || autre.maxDate > chef.maxDate)) chef.maxDate = autre.maxDate;
      if (autre.minDate && (!chef.minDate || autre.minDate < chef.minDate)) chef.minDate = autre.minDate;
    }
    out.push(chef);
  }
  return out;
}

/** L'ordre des interlocuteurs. La pertinence sert de départage partout. */
function comparateurGroupes(sort: TriRecherche) {
  return (a: GroupeInterne, b: GroupeInterne): number => {
    switch (sort) {
      case 'ancien':
        return (a.minDate ?? '9999').localeCompare(b.minDate ?? '9999') || b.score - a.score;
      case 'az':
        return (
          a.labelProvisoire.localeCompare(b.labelProvisoire, 'fr', { sensitivity: 'base' }) ||
          b.score - a.score
        );
      case 'za':
        return (
          b.labelProvisoire.localeCompare(a.labelProvisoire, 'fr', { sensitivity: 'base' }) ||
          b.score - a.score
        );
      case 'pertinence':
        // Le volume compte, mais peu : un groupe de 2 mails peut être la bonne
        // réponse, et 48 mails d'un « Cabinet Ribéroux » ne doivent pas écraser
        // le seul mail qui porte vraiment un RIB.
        return (
          b.score + Math.min(b.candidats.length, 20) / 10 -
          (a.score + Math.min(a.candidats.length, 20) / 10)
        );
      default:
        return (b.maxDate ?? '').localeCompare(a.maxDate ?? '') || b.score - a.score;
    }
  };
}

/** L'ordre des mails DANS une carte — le même réglage décide des deux. */
function comparateurMails(sort: TriRecherche, mots: string[]) {
  return (a: CandidatRecherche, b: CandidatRecherche): number => {
    if (sort === 'ancien') return (a.date ?? '').localeCompare(b.date ?? '');
    if (sort === 'pertinence') {
      return (
        scoreCandidat(b, mots) - scoreCandidat(a, mots) ||
        (b.date ?? '').localeCompare(a.date ?? '')
      );
    }
    // Récents, A→Z et Z→A : dans la carte, le plus récent d'abord.
    return (b.date ?? '').localeCompare(a.date ?? '');
  };
}
