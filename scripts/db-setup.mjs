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
for (const cmd of ['prisma generate', 'prisma migrate deploy']) {
  // Une seule chaîne de commande avec shell:true (évite l'avertissement
  // DEP0190 de Node sur la concaténation d'arguments).
  const r = isWin
    ? spawnSync(`npx ${cmd}`, { stdio: 'inherit', env: process.env, shell: true })
    : spawnSync('npx', cmd.split(' '), { stdio: 'inherit', env: process.env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log('\n✅ Base de données prête (data/boxmail.db).');
