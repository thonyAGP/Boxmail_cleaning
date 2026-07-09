// Prépare la base locale : génère le client Prisma + applique les migrations.
// Fournit une valeur par défaut à DATABASE_URL pour que ça marche même si le
// .env de l'utilisateur date d'avant l'ajout de l'index (Phase 3).
import { spawnSync } from 'node:child_process';
import 'dotenv/config';

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
  process.env.DATABASE_URL = 'file:../data/boxmail.db';
  console.log('DATABASE_URL absent du .env — valeur par défaut utilisée : file:../data/boxmail.db');
}

const isWin = process.platform === 'win32';
for (const args of [
  ['prisma', 'generate'],
  ['prisma', 'migrate', 'deploy'],
]) {
  const r = spawnSync('npx', args, { stdio: 'inherit', env: process.env, shell: isWin });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log('\n✅ Base de données prête (data/boxmail.db).');
