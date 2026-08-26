import { db } from '../db/client.js';
import { avancementQualification, prochainsDossiers } from '../services/qualification.js';

/**
 * Voir ce que la boucle de suivi servirait à l'IA, sans rien consommer.
 *
 *   npm run dossiers                 # avancement + 3 dossiers
 *   npm run dossiers -- --n 8        # 8 dossiers
 *   npm run dossiers -- --compte Brimmo
 *   npm run dossiers -- --brut       # le JSON exact envoyé, et son poids
 */

const arg = (nom: string): string | undefined => {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function run() {
  const brut = process.argv.includes('--brut');
  const n = Number(arg('n') ?? 3);

  const av = await avancementQualification();
  console.log('\n=== SUIVI DES AFFAIRES ===');
  console.log(
    `${av.detectes} fil(s) signalés · ${av.qualifies} lus · ${av.restants} à lire · ` +
      `${av.attentes} attente(s) ouverte(s)`,
  );
  if (Object.keys(av.parVerdict).length) {
    console.log(
      '  verdicts rendus : ' +
        Object.entries(av.parVerdict)
          .map(([k, v]) => `${k}=${v}`)
          .join(' · '),
    );
  }

  const lot = await prochainsDossiers({ limite: n, compte: arg('compte') });
  if (!lot.dossiers.length) {
    console.log('\nRien à qualifier — le vivier est vide.\n');
    await db.$disconnect();
    return;
  }

  if (brut) {
    const json = JSON.stringify(lot, null, 2);
    console.log(json);
    console.log(`\n— poids du lot : ${(Buffer.byteLength(json, 'utf8') / 1024).toFixed(1)} Ko ` +
      `pour ${lot.dossiers.length} dossier(s) —\n`);
    await db.$disconnect();
    return;
  }

  console.log(`\n=== ${lot.dossiers.length} PROCHAIN(S) DOSSIER(S) (${lot.restants} en attente) ===`);
  for (const d of lot.dossiers) {
    console.log(`\n[${d.score}] fil ${d.threadId} — ${d.correspondant}`);
    console.log(`   ${d.sujet}`);
    console.log(
      `   ${d.compte} · ${d.nature} · argent ${d.direction} · ` +
        `${d.moisSansMouvement} mois sans mouvement · ${d.messages.length} message(s)` +
        (d.messagesOmis ? ` (+${d.messagesOmis} omis)` : ''),
    );
    console.log(`   → ${d.pourquoiRetenu}`);
    for (const m of d.messages.slice(-2)) {
      const e = m.extrait ? m.extrait.slice(0, 110) + (m.extrait.length > 110 ? '…' : '') : '(sans extrait)';
      console.log(`     ${m.date} ${m.sens.padEnd(6)} ${e}`);
    }
    if (d.obligations.length) console.log(`     obligations déjà extraites : ${d.obligations.length}`);
  }

  const poids = Buffer.byteLength(JSON.stringify(lot), 'utf8') / 1024;
  console.log(`\n— poids réel du lot : ${poids.toFixed(1)} Ko —\n`);
  await db.$disconnect();
}

run().catch(async (err) => {
  console.error('\n❌', (err as Error).message, '\n');
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
