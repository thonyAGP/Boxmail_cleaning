import { parseArgs } from 'node:util';
import { resolveAccount } from '../services/accounts.js';
import { imapService } from '../services/imap.js';

/**
 * Démo/diagnostic du tool clé `get_sender_stats` en ligne de commande.
 * Affiche le top des expéditeurs d'un dossier (volume, dernier mail, taille,
 * % newsletters via List-Unsubscribe).
 *
 *   npm run stats -- --account brimmo --limit 25
 *   npm run stats -- --account brimmo --folder INBOX --since 2025-01-01
 */
function fmtSize(bytes: number): string {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' Go';
  if (bytes > 1e6) return (bytes / 1e6).toFixed(1) + ' Mo';
  if (bytes > 1e3) return (bytes / 1e3).toFixed(0) + ' Ko';
  return bytes + ' o';
}

async function run() {
  const { values } = parseArgs({
    options: {
      account: { type: 'string', short: 'a' },
      folder: { type: 'string', short: 'f' },
      limit: { type: 'string', short: 'l' },
      since: { type: 'string', short: 's' },
    },
  });

  const folder = values.folder ?? 'INBOX';
  const limit = values.limit ? Number.parseInt(values.limit, 10) : 25;

  const rec = await resolveAccount(values.account);
  console.log(
    `\n=== Statistiques par expéditeur — ${rec.account} / ${folder}` +
      `${values.since ? ' depuis ' + values.since : ''} ===\n`,
  );
  console.log('(analyse en cours, peut prendre un moment sur une grosse boîte…)\n');

  const { totalMessages, senders } = await imapService.getSenderStats(
    rec,
    folder,
    limit,
    values.since,
  );
  await imapService.closeAll();

  console.log(`Total analysé : ${totalMessages} messages\n`);
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  console.log(pad('#', 4) + pad('Nb', 6) + pad('Newsl.', 8) + pad('Taille', 9) + 'Expéditeur');
  console.log('-'.repeat(78));
  senders.forEach((s, i) => {
    const label = s.name ? `${s.name} <${s.address}>` : s.address;
    console.log(
      pad(String(i + 1), 4) +
        pad(String(s.count), 6) +
        pad(s.unsubscribePct + '%', 8) +
        pad(fmtSize(s.totalSizeBytes), 9) +
        label,
    );
  });
  console.log(
    '\nNewsl.% = part des mails avec header List-Unsubscribe ' +
      '(fort = newsletter/notification, bon candidat au nettoyage).\n',
  );
}

run().catch(async (err) => {
  await imapService.closeAll().catch(() => {});
  console.error('\n❌ Erreur :', (err as Error).message, '\n');
  process.exit(1);
});
