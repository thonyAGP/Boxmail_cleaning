import { db } from '../db/client.js';
import { getAccountRecord, listAccountNames } from '../services/accounts.js';
import { detectAccountingCandidates } from '../services/accounting.js';

/**
 * RATTRAPAGE DES PIÈCES COMPTABLES — à la demande, sur une fenêtre choisie.
 *
 * L'utilisateur, lui, n'a rien à lancer : le rattrapage se déclenche tout seul
 * au démarrage (`whatsnew.ts`, entrée `accounting-body-doc-v1`). Ce CLI existe
 * pour VÉRIFIER depuis le serveur — relancer une boîte précise, mesurer ce que
 * la nouvelle détection ramasse, et lire le détail par voie.
 *
 *   npm run compta:rattrapage                       # 12 mois, toutes les boîtes
 *   npm run compta:rattrapage -- --jours 730
 *   npm run compta:rattrapage -- --compte lb2i
 */

const arg = (nom: string): string | undefined => {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function run() {
  const jours = Math.min(Math.max(Number(arg('jours') ?? 365), 1), 3650);
  const limite = Math.min(Math.max(Number(arg('limite') ?? 500), 1), 1000);
  const cible = arg('compte');
  const noms = cible ? [cible] : await listAccountNames();

  console.log(`\n=== RATTRAPAGE PIÈCES COMPTABLES — ${jours} jours, ${noms.length} boîte(s) ===\n`);
  console.log('boîte                 examinés  créés   verdict  repli  CORPS  corps lus');
  console.log('─'.repeat(78));

  let totalCorps = 0;
  for (const nom of noms) {
    try {
      const rec = await getAccountRecord(nom);
      if (!rec) {
        console.log(`${nom.padEnd(20)}  (compte introuvable)`);
        continue;
      }
      const r = await detectAccountingCandidates(rec, { sinceDays: jours, limit: limite });
      totalCorps += r.viaCorps;
      console.log(
        `${nom.padEnd(20)} ${String(r.scanned).padStart(9)} ${String(r.created).padStart(6)} ` +
          `${String(r.viaVerdict).padStart(9)} ${String(r.viaRepli).padStart(6)} ` +
          `${String(r.viaCorps).padStart(6)} ${String(r.corpsLusEnImap).padStart(10)}`,
      );
    } catch (err) {
      console.log(`${nom.padEnd(20)}  ❌ ${(err as Error).message}`);
    }
  }

  console.log('─'.repeat(78));
  console.log(`\n${totalCorps} justificatif(s) PORTÉ(S) PAR LE CORPS retrouvé(s).`);
  console.log('Ces mails n’ont aucune pièce jointe : le message EST la preuve.');
  console.log('Ils sont désormais protégés de toute suppression automatique.\n');

  await db.$disconnect();
}

run().catch(async (err) => {
  console.error('\n❌', (err as Error).message, '\n');
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
