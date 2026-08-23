/**
 * Découper ce qu'Anthony tape en mots cherchables (23/08).
 *
 * AVANT : toute la phrase devenait UN motif `LIKE '%facture électricité
 * miron%'` — une chaîne de 25 caractères cherchée telle quelle, espaces
 * compris. Un mail « Votre facture d'électricité - contrat Miron » contient
 * pourtant les trois mots, mais ne sortait pas. C'est ce qui lui a rendu un
 * écran vide le 23/08, et ça valait pour TOUTE recherche de plus d'un mot.
 *
 * Le découpage a l'air trivial. Il ne l'est pas :
 *
 *  - **les mots creux doivent partir** — « la facture de la maison » exigerait
 *    sinon que « la » et « de » soient présents, ce qui est toujours vrai et
 *    n'apporte rien, mais surtout allonge la requête pour rien ;
 *  - **les mots courts ne doivent PAS tous partir.** Une règle bête « on jette
 *    ce qui fait deux lettres ou moins » tuerait `RH`, `TV`, `PV`, `T2`, `M2` —
 *    or il loue des appartements et suit des travaux : ce sont des mots
 *    porteurs chez lui. D'où la liste blanche ;
 *  - **une phrase longue ne doit pas devenir une passoire à l'envers.** Chaque
 *    mot exigé en plus RÉDUIT le résultat ; « je cherche le mail du notaire
 *    avec la facture de la maison » ferait 8 exigences cumulées et ne
 *    ramènerait rien. D'où le plafond.
 *
 * Les guillemets restent le moyen d'exiger une expression exacte : `"avis
 * d'imposition"` reste un seul terme, c'est-à-dire l'ancien comportement, à la
 * demande.
 */

/** Au-delà, chaque mot supplémentaire ne fait que rétrécir le résultat. */
const MAX_MOTS = 8;

/**
 * Mots trop fréquents pour discriminer quoi que ce soit. Volontairement courte
 * et française : ce n'est pas une liste de « stop words » de moteur de
 * recherche, juste de quoi éviter d'exiger « de » dans chaque mail.
 */
const MOTS_VIDES = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'a', 'au',
  'aux', 'en', 'dans', 'pour', 'par', 'sur', 'sous', 'avec', 'sans', 'ce',
  'cet', 'cette', 'ces', 'mon', 'ma', 'mes', 'son', 'sa', 'ses', 'leur',
  'leurs', 'notre', 'nos', 'votre', 'vos', 'qui', 'que', 'quoi', 'dont',
  'est', 'sont', 'etait', 'ete', 'avoir', 'etre', 'fait', 'faire', 'plus',
  'moins', 'tout', 'tous', 'toute', 'toutes', 'je', 'tu', 'il', 'elle',
  'nous', 'vous', 'ils', 'elles', 'me', 'te', 'se', 'lui', 'y', 'ne', 'pas',
  'mail', 'mails', 'message', 'messages', 'cherche', 'chercher', 'trouve',
  'trouver', 'voir', 'montre', 'montrer',
]);

/**
 * Les mots courts qui comptent malgré leur taille. Tirés de SES sujets à lui :
 * il loue des logements (T2, M2), gère des sociétés (CA, TVA), suit des
 * travaux (PV, DP) et reçoit des relevés (RIB, IBAN).
 */
const COURTS_UTILES = new Set([
  'rh', 'tv', 'pv', 'ca', 'cb', 'dp', 'ci', 'rc', 'ac', 'ok', 'no', 'id',
  't1', 't2', 't3', 't4', 't5', 'f1', 'f2', 'f3', 'f4', 'm2', 'm3',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
]);

/** Ce que la recherche a compris de la phrase tapée. */
export interface TermesRecherche {
  /** La phrase telle qu'il l'a écrite. */
  brut: string;
  /** Les mots effectivement cherchés, dans l'ordre où il les a tapés. */
  mots: string[];
  /** Ce qui a été écarté (mot creux, trop court, au-delà du plafond). */
  ecartes: string[];
  /**
   * true quand la phrase entière a été gardée en un seul morceau : soit elle
   * était entre guillemets, soit il n'en restait rien après nettoyage.
   */
  litteral: boolean;
}

/** Enlève accents et casse — sert à comparer aux listes, jamais à chercher. */
function replie(mot: string): string {
  return mot
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Découpe la phrase en mots cherchables.
 *
 * Ne renvoie JAMAIS une liste vide : si tout a été écarté (il a tapé « de la »),
 * on retombe sur la phrase entière en un seul terme — mieux vaut l'ancien
 * comportement qu'un écran vide sans explication.
 */
export function decouperTermes(q: string): TermesRecherche {
  // L'apostrophe typographique du clavier français doit se comporter comme
  // l'apostrophe droite, sinon « l'électricité » et « l'électricité » (même
  // mot, deux caractères différents) se découpent différemment.
  const brut = (q ?? '').replace(/[‘’]/g, "'").trim();
  if (!brut) return { brut: '', mots: [], ecartes: [], litteral: false };

  // Les guillemets réclament l'expression exacte : c'est l'échappatoire vers
  // l'ancien comportement, et le seul moyen de chercher une suite de mots.
  const entreGuillemets = brut.match(/^["«“](.+)["»”]$/);
  if (entreGuillemets) {
    return { brut, mots: [entreGuillemets[1].trim()], ecartes: [], litteral: true };
  }

  const morceaux = brut
    .split(/[^\p{L}\p{N}@._+-]+/u)
    .map((m) => m.replace(/^[._+-]+|[._+-]+$/g, ''))
    .filter(Boolean);

  const mots: string[] = [];
  const ecartes: string[] = [];
  const vus = new Set<string>();

  for (const m of morceaux) {
    const cle = replie(m);
    if (vus.has(cle)) continue;
    // Une adresse mail tapée en entier reste entière : la couper sur le @
    // ferait chercher « hotmail » chez tout le monde.
    const estAdresse = m.includes('@');
    if (!estAdresse && MOTS_VIDES.has(cle)) {
      ecartes.push(m);
      continue;
    }
    if (!estAdresse && cle.length <= 2 && !COURTS_UTILES.has(cle)) {
      ecartes.push(m);
      continue;
    }
    if (mots.length >= MAX_MOTS) {
      ecartes.push(m);
      continue;
    }
    vus.add(cle);
    mots.push(m);
  }

  if (!mots.length) return { brut, mots: [brut], ecartes: [], litteral: true };
  return { brut, mots, ecartes, litteral: false };
}
