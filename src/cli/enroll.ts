import { parseArgs } from 'node:util';
import { enrollAccount } from '../services/oauth.js';
import {
  upsertAccount,
  listAccountNames,
  renameAccount,
  removeAccount,
} from '../services/accounts.js';

/**
 * CLI d'enrôlement d'un compte (device code flow), à lancer en SSH sur le
 * serveur — jamais via Claude.
 *
 *   npm run enroll -- --account brimmo
 *
 * Affiche un code + une URL ; l'utilisateur se connecte avec le compte Hotmail
 * cible sur microsoft.com/devicelogin. Le refresh token (dans le cache MSAL)
 * est ensuite chiffré et stocké dans accounts.json.
 */

async function run() {
  const { values } = parseArgs({
    options: {
      account: { type: 'string', short: 'a' },
      list: { type: 'boolean', short: 'l' },
      rename: { type: 'string', short: 'r' },
      to: { type: 'string', short: 't' },
      remove: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    printUsage();
    return;
  }

  if (values.rename) {
    const newName = values.to?.trim();
    if (!newName) {
      console.error('Erreur : --rename <ancien> exige aussi --to <nouveau>.');
      process.exit(1);
    }
    if (!/^[a-z0-9_-]+$/i.test(newName)) {
      console.error('Erreur : le nouveau nom ne doit contenir que lettres, chiffres, - et _.');
      process.exit(1);
    }
    await renameAccount(values.rename.trim(), newName);
    await renameIndexedAccount(values.rename.trim(), newName);
    console.log(`✅ Compte renommé : "${values.rename}" → "${newName}" (token conservé).`);
    return;
  }

  if (values.remove) {
    await removeAccount(values.remove.trim());
    await dropIndexedAccount(values.remove.trim());
    console.log(`✅ Compte "${values.remove}" supprimé (token effacé, index purgé).`);
    return;
  }

  if (values.list) {
    const names = await listAccountNames();
    if (names.length === 0) {
      console.log('Aucun compte enrôlé.');
    } else {
      console.log('Comptes enrôlés :');
      for (const n of names) console.log(`  - ${n}`);
    }
    return;
  }

  const account = values.account?.trim();
  if (!account) {
    console.error('Erreur : --account <nom> est requis.\n');
    printUsage();
    process.exit(1);
  }
  if (!/^[a-z0-9_-]+$/i.test(account)) {
    console.error('Erreur : le nom de compte ne doit contenir que lettres, chiffres, - et _.');
    process.exit(1);
  }

  console.log(`\n=== Enrôlement du compte "${account}" ===\n`);

  const enrolled = await enrollAccount((info) => {
    // Instructions device code à afficher à l'utilisateur.
    console.log('---------------------------------------------------------------');
    console.log(info.message);
    console.log('---------------------------------------------------------------');
    console.log(`\nURL     : ${info.verificationUri}`);
    console.log(`Code    : ${info.userCode}`);
    console.log('\nConnecte-toi avec le compte Hotmail/Outlook CIBLE, puis valide.\n');
    console.log('En attente de validation…\n');
  });

  await upsertAccount(account, enrolled);

  console.log('\n✅ Compte enrôlé avec succès.');
  console.log(`   Compte      : ${account}`);
  console.log(`   Adresse     : ${enrolled.username}`);
  console.log('   Le refresh token est chiffré (AES-256-GCM) dans accounts.json.');
  console.log('\nLe serveur peut maintenant utiliser ce compte via les tools MCP.\n');
}

/**
 * L'index SQLite est un cache reconstructible : au renommage on purge l'ancien
 * slug, la prochaine sync réindexe sous le nouveau nom (renommer la clé
 * primaire avec ses relations serait plus fragile que ça ne vaut).
 */
async function renameIndexedAccount(oldName: string, newName: string): Promise<void> {
  try {
    const { db } = await import('../db/client.js');
    const res = await db.account.deleteMany({ where: { slug: oldName } });
    if (res.count > 0) {
      console.log(
        `   Index local purgé pour "${oldName}" — relancer : npm run sync -- --account ${newName} --full`,
      );
    }
    await db.$disconnect();
  } catch {
    // Base absente / non migrée : rien à purger.
  }
}

async function dropIndexedAccount(name: string): Promise<void> {
  try {
    const { db } = await import('../db/client.js');
    await db.account.deleteMany({ where: { slug: name } });
    await db.$disconnect();
  } catch {
    // Base absente / non migrée : rien à purger.
  }
}

function printUsage() {
  console.log(`Usage :
  npm run enroll -- --account <nom>                Enrôler / ré-enrôler un compte
  npm run enroll -- --list                         Lister les comptes enrôlés
  npm run enroll -- --rename <ancien> --to <nouveau>   Renommer un compte (token conservé)
  npm run enroll -- --remove <nom>                 Supprimer un compte (token effacé)
  npm run enroll -- --help                         Cette aide

Prérequis : .env rempli (MS_CLIENT_ID, TOKEN_ENCRYPTION_KEY, ...).`);
}

run().catch((err) => {
  console.error('\n❌ Échec de l\'enrôlement :', (err as Error).message);
  process.exit(1);
});
