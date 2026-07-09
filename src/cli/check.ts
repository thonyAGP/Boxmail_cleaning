import { parseArgs } from 'node:util';
import { resolveAccount } from '../services/accounts.js';
import { imapService } from '../services/imap.js';

/**
 * Diagnostic Phase 0 : vérifie de bout en bout qu'un compte enrôlé peut
 * ouvrir IMAP en XOAUTH2 et lister ses dossiers (LIST). C'est le test bloquant
 * du SPEC §8.1 — s'il passe, IMAP+OAuth2 est viable pour ce compte.
 *
 *   npm run check -- --account brimmo
 */
async function run() {
  const { values } = parseArgs({
    options: {
      account: { type: 'string', short: 'a' },
      folder: { type: 'string', short: 'f' },
    },
  });

  console.log('\n=== Phase 0 — diagnostic IMAP + XOAUTH2 ===\n');

  console.log('1/3  Résolution du compte + rafraîchissement du token OAuth…');
  const rec = await resolveAccount(values.account);
  console.log(`     ✅ compte "${rec.account}" (${rec.username})`);

  console.log('2/3  Connexion IMAP (XOAUTH2) + LIST des dossiers…');
  const folders = await imapService.listFolders(rec);
  console.log(`     ✅ ${folders.length} dossiers listés :`);
  for (const f of folders) {
    const tag = f.specialUse ? `  [${f.specialUse}]` : '';
    console.log(`        - ${f.path}${tag}`);
  }

  console.log('3/3  Statut de la boîte INBOX…');
  const folder = values.folder ?? 'INBOX';
  const status = await imapService.getStatus(rec, folder);
  console.log(`     ✅ ${folder} : ${status.messages} messages, ${status.unseen} non lus`);

  await imapService.closeAll();

  console.log('\n🎉 PHASE 0 VALIDÉE : IMAP + XOAUTH2 fonctionne pour ce compte.');
  console.log('   → Le backend IMAP est viable, on peut continuer le déploiement.\n');
}

run().catch(async (err) => {
  await imapService.closeAll().catch(() => {});
  console.error('\n❌ PHASE 0 ÉCHOUÉE :', (err as Error).message);
  console.error(
    '\nSi l\'erreur est une authentification IMAP refusée (AUTHENTICATIONFAILED, ' +
      'scope refusé…), l\'accès IMAP OAuth2 est probablement bloqué pour les comptes ' +
      'perso → voir le Plan B (Graph API) dans le README.\n',
  );
  process.exit(1);
});
