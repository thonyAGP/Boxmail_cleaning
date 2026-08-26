import { db } from '../db/client.js';
import { jumelleDe } from '../services/qualification.js';

/**
 * Rapproche les attentes qui racontent la même histoire.
 *
 * POURQUOI CE CLI EXISTE. Les 14 attentes établies à la main le 26/08 n'ont
 * pas de `threadId` : la boucle de qualification, qui dédoublonne par fil, les
 * a donc recréées. Mesuré à la première exécution : la convention Zanitti, le
 * sinistre MECHACHE, et surtout l'URSSAF — dont les DEUX cartes étaient les
 * seules urgences critiques de l'écran. Deux rouges pour une seule dette.
 *
 * Le service applique désormais la règle à la création. Ce CLI la rejoue sur
 * ce qui existe déjà, et servira encore chaque fois qu'une vague aura tourné
 * avant un déploiement.
 *
 * L'ANCIENNE GAGNE, TOUJOURS. On rattache l'ancienne au fil et on supprime la
 * nouvelle : une attente écrite en relisant le dossier entier est mieux jugée
 * qu'une lecture d'extraits. Mesuré — la boucle classait la convention Zanitti
 * « faible/faible » là où l'audit voyait « haute/haute », à raison.
 *
 *   npm run attentes:dedoublonner            # aperçu, ne touche à rien
 *   npm run attentes:dedoublonner -- --oui   # applique
 */

async function run() {
  const appliquer = process.argv.includes('--oui');

  const toutes = await db.attente.findMany({
    where: { etat: { in: ['ouverte', 'probable'] } },
    orderBy: { id: 'asc' },
  });

  // L'ancienne = le plus petit id. On ne compare que vers l'arrière.
  const paires: { garder: (typeof toutes)[0]; retirer: (typeof toutes)[0] }[] = [];
  const dejaRetirees = new Set<number>();

  for (const nouvelle of toutes) {
    if (dejaRetirees.has(nouvelle.id)) continue;
    const anciennes = toutes.filter(
      (o) =>
        o.id < nouvelle.id &&
        !dejaRetirees.has(o.id) &&
        o.accountSlug === nouvelle.accountSlug &&
        o.cote === nouvelle.cote,
    );
    const jumelle = jumelleDe(anciennes, {
      qui: nouvelle.qui,
      quoi: nouvelle.quoi,
      dueAt: nouvelle.dueAt,
    });
    if (jumelle) {
      paires.push({ garder: jumelle, retirer: nouvelle });
      dejaRetirees.add(nouvelle.id);
    }
  }

  if (!paires.length) {
    console.log(`\n${toutes.length} attente(s) ouverte(s) — aucun doublon.\n`);
    await db.$disconnect();
    return;
  }

  console.log(`\n=== ${paires.length} DOUBLON(S) sur ${toutes.length} attente(s) ===\n`);
  for (const { garder, retirer } of paires) {
    console.log(`GARDER  #${garder.id} [${garder.source}] ${garder.urgence}/${garder.importance}`);
    console.log(`        ${garder.qui} — ${garder.quoi}`);
    console.log(`RETIRER #${retirer.id} [${retirer.source}] ${retirer.urgence}/${retirer.importance}`);
    console.log(`        ${retirer.qui} — ${retirer.quoi}`);
    if (!garder.threadId && retirer.threadId) {
      console.log(`        → l'ancienne récupère le fil ${retirer.threadId} (elle pourra s'ouvrir)`);
    }
    console.log();
  }

  if (!appliquer) {
    console.log('Aperçu seulement. Relancer avec --oui pour appliquer.\n');
    await db.$disconnect();
    return;
  }

  for (const { garder, retirer } of paires) {
    if (!garder.threadId && retirer.threadId) {
      await db.attente.update({
        where: { id: garder.id },
        data: { threadId: retirer.threadId, messageId: retirer.messageId },
      });
    }
    await db.attente.delete({ where: { id: retirer.id } });
  }
  const reste = await db.attente.count({ where: { etat: { in: ['ouverte', 'probable'] } } });
  console.log(`${paires.length} doublon(s) retiré(s) — ${reste} attente(s) ouverte(s).\n`);
  await db.$disconnect();
}

run().catch(async (err) => {
  console.error('\n❌', (err as Error).message, '\n');
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
