import { parseArgs } from 'node:util';
import { resolveAccount } from '../services/accounts.js';
import { syncAccount } from '../services/sync.js';
import { imapService } from '../services/imap.js';
import { db } from '../db/client.js';

/**
 * Synchronisation manuelle d'un compte vers l'index SQLite.
 *
 *   npm run sync -- --account brimmo            # recent : INBOX + Sent
 *   npm run sync -- --account brimmo --full     # tous les dossiers + flags
 *   npm run sync -- --account brimmo --folder INBOX
 */
async function run() {
  const { values } = parseArgs({
    options: {
      account: { type: 'string', short: 'a' },
      full: { type: 'boolean', short: 'F' },
      folder: { type: 'string', short: 'f', multiple: true },
    },
  });

  const rec = await resolveAccount(values.account);
  const mode = values.full ? 'full' : 'recent';
  console.log(`\n=== Sync ${rec.account} (${rec.username}) — mode ${mode} ===\n`);

  const report = await syncAccount(rec, {
    mode,
    folders: values.folder,
    onProgress: (m) => console.log(`  ${m}`),
  });

  const icon = report.errors.length === 0 ? '✅' : '⚠️';
  console.log(`\n${icon} Sync terminée en ${(report.durationMs / 1000).toFixed(1)}s`);
  console.log(`   Dossiers synchronisés : ${report.foldersSynced.length}`);
  if (report.errors.length) {
    console.log(`   Dossiers en échec     : ${report.errors.length}`);
    for (const e of report.errors) console.log(`     - ${e.folder} : ${e.message}`);
    console.log('   → Relancer la sync : elle reprend là où chaque dossier s\'est arrêté.');
  }
  console.log(`   Nouveaux messages     : ${report.newMessages}`);
  console.log(`   Messages disparus     : ${report.deletedMessages}`);
  if (mode === 'full') console.log(`   Flags mis à jour      : ${report.flagUpdates}`);
  console.log(`   Fils rattachés        : ${report.threadsLinked}`);
  console.log(`   Expéditeurs agrégés   : ${report.sendersUpdated}\n`);

  await imapService.closeAll();
  await db.$disconnect();
}

run().catch(async (err) => {
  console.error('\n❌ Échec de la sync :', (err as Error).message, '\n');
  await imapService.closeAll().catch(() => {});
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
