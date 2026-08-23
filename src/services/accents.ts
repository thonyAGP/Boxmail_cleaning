/**
 * Chercher sans se soucier des accents (23/08).
 *
 * Défaut mesuré le 19/08 et resté ouvert : « republique » rendait 64 mails,
 * « République » en rendait 294. Deux recherches, deux résultats, aucun
 * message — Anthony n'avait aucun moyen de savoir qu'il en manquait 230.
 *
 * Le `LIKE` de SQLite ne replie la casse QUE pour l'ASCII : « é » et « É »
 * sont deux caractères sans rapport pour lui. Un sujet commençant par
 * « Électricité » était donc introuvable en tapant « électricité ».
 *
 * POURQUOI PAS DÉPLIER À LA VOLÉE, dans la requête. Mesuré le 23/08 sur un
 * corpus de 41 000 mails bâti aux dimensions réelles (corps de 2 200
 * caractères, OCR sur 20 % des mails, base de 248 Mo) :
 *
 *     recherche à 3 mots        LIKE brut   664 ms   →  déplié à la volée   5 954 ms
 *     pire cas (0 résultat)     LIKE brut   543 ms   →  déplié à la volée  13 511 ms
 *
 * 25 fois plus lent sur le cas comparable. On paie donc le dépliage UNE fois,
 * à l'écriture, dans deux colonnes tenues par des déclencheurs SQLite — et pas
 * par du code TypeScript : plus de dix fichiers écrivent le sujet, l'extrait,
 * le texte d'analyse ou l'OCR, et il suffirait d'en oublier un pour que la
 * colonne mente en silence. Le déclencheur, lui, ne s'oublie pas.
 */

/**
 * Les lettres accentuées du français (et quelques voisines) vers leur lettre
 * nue. Les majuscules figurent explicitement : `lower()` ne les replie pas.
 *
 * CETTE LISTE EST LA SOURCE UNIQUE. Le SQL des déclencheurs et du remplissage
 * initial est ENGENDRÉ à partir d'elle (scripts/gen-migration-accents.mjs), et
 * la requête de recherche déplie le mot tapé avec `deplie()` ci-dessous. Les
 * deux côtés ne peuvent donc pas diverger — c'était le vrai risque : déplier
 * la requête plus largement que le contenu ne trouve plus rien.
 */
export const ACCENTS: [string, string][] = [
  ['à', 'a'], ['â', 'a'], ['ä', 'a'], ['á', 'a'], ['ã', 'a'], ['å', 'a'],
  ['À', 'a'], ['Â', 'a'], ['Ä', 'a'], ['Á', 'a'], ['Ã', 'a'], ['Å', 'a'],
  ['è', 'e'], ['é', 'e'], ['ê', 'e'], ['ë', 'e'],
  ['È', 'e'], ['É', 'e'], ['Ê', 'e'], ['Ë', 'e'],
  ['ì', 'i'], ['í', 'i'], ['î', 'i'], ['ï', 'i'],
  ['Ì', 'i'], ['Í', 'i'], ['Î', 'i'], ['Ï', 'i'],
  ['ò', 'o'], ['ó', 'o'], ['ô', 'o'], ['ö', 'o'], ['õ', 'o'],
  ['Ò', 'o'], ['Ó', 'o'], ['Ô', 'o'], ['Ö', 'o'], ['Õ', 'o'],
  ['ù', 'u'], ['ú', 'u'], ['û', 'u'], ['ü', 'u'],
  ['Ù', 'u'], ['Ú', 'u'], ['Û', 'u'], ['Ü', 'u'],
  ['ç', 'c'], ['Ç', 'c'], ['ñ', 'n'], ['Ñ', 'n'],
  ['ÿ', 'y'], ['Ý', 'y'], ['ý', 'y'],
];

/**
 * JUSQU'OÙ LES ACCENTS SONT IGNORÉS — décidé sur mesure, pas au jugé.
 *
 * Recopier aussi le CORPS des mails déplié a été essayé, puis abandonné. Sur
 * 41 000 mails aux dimensions réelles :
 *
 *     corps + documents dépliés  →  base 248 → 423 Mo (+71 %)   pire cas 1 387 ms
 *     borné à 3 000 caractères   →  base 248 → 391 Mo (+58 %)   pire cas 1 268 ms
 *     champs courts + entités    →  voir plus bas
 *
 * La borne n'a presque rien rendu : dans un corpus réel, la plupart des mails
 * tiennent déjà sous 3 000 caractères. Le coût ne venait pas des documents
 * scannés mais de la DUPLICATION DU CORPS, inévitable dès qu'on le recopie.
 *
 * Or doubler le temps de recherche serait une régression très visible pour
 * Anthony — la recherche est passée de 132 s à ~300 ms le 19/08, c'est
 * exactement ce qu'il a remarqué et apprécié — contre un gain, lui, presque
 * invisible : les mots accentués qui servent à retrouver quelque chose sont
 * des NOMS (« République », « Nîmes », « Hélène »), et ceux-là vivent dans le
 * sujet, le nom de l'expéditeur, le nom des fichiers, le résumé, et surtout
 * dans les ENTITÉS lues par l'analyse.
 *
 * D'où le périmètre retenu : ces champs-là, dépliés ; le corps du mail, non.
 * Le corps reste cherché en entier, mais à l'accent près. Cette limite est
 * DITE à l'écran plutôt que subie en silence.
 */
export const LONGUEUR_DEPLIEE = 2000;

/** Déplie un texte comme le font les déclencheurs, à l'identique. */
export function deplie(s: string): string {
  let out = s;
  for (const [de, vers] of ACCENTS) out = out.split(de).join(vers);
  return out.toLowerCase();
}

/** Le mot tapé contient-il quelque chose que le dépliage change ? */
export function aDesAccents(s: string): boolean {
  return ACCENTS.some(([de]) => s.includes(de));
}

/**
 * L'expression SQL qui déplie une colonne — utilisée pour ENGENDRER le SQL des
 * déclencheurs et du remplissage, jamais dans une requête de recherche (c'est
 * précisément ce qui coûtait 13 secondes).
 */
export function sqlDeplie(colonne: string): string {
  let sql = colonne;
  for (const [de, vers] of ACCENTS) sql = `replace(${sql},'${de}','${vers}')`;
  return `lower(${sql})`;
}

/**
 * Les champs recopiés dépliés dans `Message.searchShort`. Tous courts : une
 * centaine de caractères par mail, contre les 2 700 qu'aurait coûté le corps.
 */
export const CHAMPS_COURTS = ['subject', 'fromName', 'fromEmail', 'attachmentNames', 'aiSummary'];

/**
 * Les tables ANNEXES dépliées, et la colonne concernée. Ce sont elles qui font
 * l'essentiel de la valeur : l'analyse a lu le mail entier et en a extrait
 * « 46 rue de la République » : c'est là qu'on retrouve un nom accentué, même
 * quand le sujet se tait.
 */
export const TABLES_ANNEXES: { table: string; source: string; cible: string }[] = [
  { table: 'EntityMention', source: 'nameRaw', cible: 'nameDeplie' },
  { table: 'VerdictContext', source: 'label', cible: 'labelDeplie' },
];
