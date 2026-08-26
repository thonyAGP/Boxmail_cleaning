import { db } from '../db/client.js';
import {
  RANG_IMPORTANCE,
  RANG_URGENCE,
  jumelleDe,
  plusSevere,
} from '../services/qualification.js';

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
 * L'ANCIENNE SURVIT, MAIS AU JUGEMENT LE PLUS SÉVÈRE. On garde le libellé et
 * l'explication de l'ancienne — écrite en relisant le dossier entier, elle est
 * mieux tournée qu'une lecture d'extraits — et on lui rattache le fil de la
 * nouvelle, ce qui rend enfin la carte ouvrable. Mais l'urgence, l'importance
 * et le risque prennent le MAXIMUM des deux : rapprocher ne doit jamais faire
 * disparaître une alarme. Mesuré dans les deux sens — la relecture classait la
 * convention Zanitti « faible » là où l'audit voyait « haute », et à l'inverse
 * elle jugeait le dossier Comptastar plus grave que l'audit.
 *
 *   npm run attentes:dedoublonner            # aperçu, ne touche à rien
 *   npm run attentes:dedoublonner -- --oui   # applique
 */

async function run() {
  const appliquer = process.argv.includes('--oui');
  // Ne traiter QUE certaines paires, désignées par l'id de l'attente à
  // retirer. Ajouté le 26/08 : sur 5 propositions, 2 seulement étaient
  // certaines — appliquer le lot entier aurait supprimé des tâches réelles.
  const iIds = process.argv.indexOf('--ids');
  const choisis =
    iIds >= 0 && process.argv[iIds + 1]
      ? new Set(
          process.argv[iIds + 1]
            .split(',')
            .map((x) => Number(x.trim()))
            .filter(Boolean),
        )
      : null;

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

  const aTraiter = choisis ? paires.filter((x) => choisis.has(x.retirer.id)) : paires;
  if (choisis) {
    console.log(
      `Selection : ${aTraiter.length} paire(s) sur ${paires.length} — ids ${[...choisis].join(', ')}.\n`,
    );
  }

  if (!appliquer) {
    console.log('Aperçu seulement. Relancer avec --oui pour appliquer.\n');
    await db.$disconnect();
    return;
  }

  for (const { garder, retirer } of aTraiter) {
    await db.attente.update({
      where: { id: garder.id },
      data: {
        threadId: garder.threadId ?? retirer.threadId,
        messageId: garder.messageId ?? retirer.messageId,
        // Le jugement le plus sévère des deux : rapprocher ne doit jamais
        // faire disparaître une alarme.
        urgence: plusSevere(garder.urgence, retirer.urgence, RANG_URGENCE),
        importance: plusSevere(garder.importance, retirer.importance, RANG_IMPORTANCE),
        risque: garder.risque ?? retirer.risque,
      },
    });
    await db.attente.delete({ where: { id: retirer.id } });
  }
  const reste = await db.attente.count({ where: { etat: { in: ['ouverte', 'probable'] } } });
  console.log(`${aTraiter.length} doublon(s) retiré(s) — ${reste} attente(s) ouverte(s).\n`);
  await db.$disconnect();
}

run().catch(async (err) => {
  console.error('\n❌', (err as Error).message, '\n');
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
