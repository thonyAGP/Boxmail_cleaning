// Prépare la base locale : génère le client Prisma + applique les migrations.
// Fournit une valeur par défaut à DATABASE_URL pour que ça marche même si le
// .env de l'utilisateur date d'avant l'ajout de l'index (Phase 3).
//
// Trois modes (les deux derniers servent à la mise à jour du serveur en
// ligne — voir src/db/migrate.ts) :
//   node scripts/db-setup.mjs            → generate + migrate deploy
//   node scripts/db-setup.mjs generate   → generate seul (NE TOUCHE PAS la base :
//                                          utilisable pendant que le serveur tourne)
//   node scripts/db-setup.mjs migrate    → migrate deploy seul (exige que
//                                          personne ne tienne la base ouverte)
import { spawnSync } from 'node:child_process';
import 'dotenv/config';

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
  process.env.DATABASE_URL = 'file:../data/boxmail.db';
  console.log('DATABASE_URL absent du .env — valeur par défaut utilisée : file:../data/boxmail.db');
}

const mode = (process.argv[2] || 'all').toLowerCase();
const steps =
  mode === 'generate'
    ? ['prisma generate']
    : mode === 'migrate'
      ? ['prisma migrate deploy']
      : ['prisma generate', 'prisma migrate deploy'];

const isWin = process.platform === 'win32';
for (const cmd of steps) {
  // Une seule chaîne de commande avec shell:true (évite l'avertissement
  // DEP0190 de Node sur la concaténation d'arguments).
  const r = isWin
    ? spawnSync(`npx ${cmd}`, { stdio: 'inherit', env: process.env, shell: true })
    : spawnSync('npx', cmd.split(' '), { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log(
  mode === 'generate' ? '\n✅ Client Prisma généré.' : '\n✅ Base de données prête (data/boxmail.db).',
);
