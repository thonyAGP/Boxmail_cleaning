/**
 * Engendre la migration des colonnes « sans accents » (23/08).
 *
 * Le SQL des déclencheurs répète la même cinquantaine de `replace()` une
 * dizaine de fois : l'écrire à la main, c'est se garantir une divergence avec
 * la liste d'accents de src/services/accents.ts — et une divergence ici ne
 * casse rien bruyamment, elle fait juste manquer des mails en silence.
 *
 *   npm run build && node scripts/gen-migration-accents.mjs
 *
 * Le fichier produit est committé : la migration reste un artefact figé, et
 * relancer ce script sur une liste inchangée le réécrit à l'identique.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const { ACCENTS, LONGUEUR_DEPLIEE, CHAMPS_COURTS, TABLES_ANNEXES } = await import(
  `file:///${join(RACINE, 'dist/services/accents.js').replace(/\\/g, '/')}`
);

/** Déplie une colonne. `prefixe` vaut 'NEW.' dans un déclencheur. */
const deplie = (col, prefixe = '') => {
  let sql = `COALESCE(${prefixe}${col},'')`;
  for (const [de, vers] of ACCENTS) sql = `replace(${sql},'${de}','${vers}')`;
  return sql;
};

/** Concatène des champs dépliés, en minuscules, borné en longueur. */
const expr = (champs, prefixe = '') =>
  `substr(lower(${champs.map((c) => deplie(c, prefixe)).join(" || ' ' || ")}),1,${LONGUEUR_DEPLIEE})`;

const court = (p = '') => expr(CHAMPS_COURTS, p);

/** Les deux déclencheurs (insertion, mise à jour) d'une table. */
const declencheurs = (nom, table, cible, calcul, surveilles) => `
CREATE TRIGGER "${nom}_insert" AFTER INSERT ON "${table}"
BEGIN
  UPDATE "${table}" SET "${cible}" = ${calcul('NEW.')} WHERE "id" = NEW."id";
END;

CREATE TRIGGER "${nom}_update"
AFTER UPDATE OF ${surveilles.map((c) => `"${c}"`).join(', ')} ON "${table}"
BEGIN
  UPDATE "${table}" SET "${cible}" = ${calcul('NEW.')} WHERE "id" = NEW."id";
END;`;

const annexes = TABLES_ANNEXES.map(({ table, source, cible }) => {
  const calcul = (p = '') => `lower(${deplie(source, p)})`;
  return `
ALTER TABLE "${table}" ADD COLUMN "${cible}" TEXT;
UPDATE "${table}" SET "${cible}" = ${calcul()};
${declencheurs(`${table.toLowerCase()}_deplie`, table, cible, calcul, [source])}`;
}).join('\n');

const sql = `-- Recherche insensible aux accents (23/08) — ENGENDRÉ par
-- scripts/gen-migration-accents.mjs à partir de src/services/accents.ts.
-- Ne pas modifier à la main : relancer le script.
--
-- « republique » rendait 64 mails, « République » 294, sans un mot d'avertissement.
-- Le LIKE de SQLite ne replie la casse que pour l'ASCII et ignore les accents.
--
-- Déplier à CHAQUE requête a été mesuré : 13 s sur 41 000 mails, 25 fois plus
-- lent. On déplie donc une fois, à l'écriture, tenu par des déclencheurs — et
-- non par du TypeScript : plus de dix fichiers écrivent ces textes, un
-- branchement en oublierait un et la colonne mentirait en silence.
--
-- PÉRIMÈTRE : les champs courts et les entités lues par l'analyse. Recopier
-- aussi le corps des mails a été essayé puis abandonné (+71 % de base, temps
-- de recherche doublé) : les noms accentués qui servent à retrouver quelque
-- chose vivent dans les sujets et les entités, pas noyés dans un paragraphe.

ALTER TABLE "Message" ADD COLUMN "searchShort" TEXT;
UPDATE "Message" SET "searchShort" = ${court()};
${declencheurs('message_search', 'Message', 'searchShort', court, CHAMPS_COURTS)}
${annexes}
`;

const dossier = join(RACINE, 'prisma/migrations/20260823120000_recherche_sans_accents');
mkdirSync(dossier, { recursive: true });
writeFileSync(join(dossier, 'migration.sql'), sql, 'utf8');
console.log(`✅ migration engendrée (${(sql.length / 1024).toFixed(1)} Ko) : ${dossier}`);
