import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { getAccountRecord, listAccountNames, upsertAccount } from './accounts.js';
import { decrypt, encrypt } from './crypto.js';
import { recordOperation } from './oplog.js';
import { logger } from '../logger.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Transfert des boîtes entre installations (PC ↔ serveur).
 *
 * POURQUOI CE N'EST PAS UNE SIMPLE COPIE DE FICHIER : les accès sont chiffrés
 * avec TOKEN_ENCRYPTION_KEY, propre à chaque installation. On déchiffre donc
 * avec la clé locale, puis on RE-chiffre avec une phrase secrète choisie par
 * l'utilisateur — le fichier obtenu ne dépend d'aucune machine.
 *
 * ⚠️ Le fichier exporté donne un accès COMPLET aux boîtes : il se traite comme
 * un mot de passe. D'où la phrase secrète obligatoire (12 caractères minimum)
 * et le fait qu'on ne l'écrive jamais sur le disque du serveur.
 */

const FORMAT = 'boxmail-accounts-export';
const VERSION = 1;
const MIN_PASSPHRASE = 12;

export interface ExportEnvelope {
  format: typeof FORMAT;
  version: number;
  kdf: 'scrypt';
  salt: string;
  iv: string;
  tag: string;
  data: string;
  /** Métadonnées non secrètes, pour informer avant de saisir la phrase. */
  accounts: number;
  exportedAt: string;
}

interface PortableAccount {
  account: string;
  username: string;
  homeAccountId: string;
  /** Cache MSAL EN CLAIR dans le paquet chiffré (rechiffré à l'arrivée). */
  cache: string;
  enrolledAt: string;
}

async function keyFrom(passphrase: string, salt: Buffer): Promise<Buffer> {
  return scrypt(passphrase, salt, 32);
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.trim().length < MIN_PASSPHRASE) {
    throw new Error(
      `Phrase secrète trop courte (${MIN_PASSPHRASE} caractères minimum) — ` +
        `ce fichier donne accès à tes boîtes mail.`,
    );
  }
}

/**
 * Prépare le paquet chiffré contenant les boîtes demandées (toutes par défaut).
 */
export async function exportAccounts(
  passphrase: string,
  names?: string[],
): Promise<ExportEnvelope> {
  assertPassphrase(passphrase);
  const wanted = names?.length ? names : await listAccountNames();
  if (wanted.length === 0) throw new Error('Aucune boîte à exporter.');

  const portable: PortableAccount[] = [];
  for (const name of wanted) {
    const rec = await getAccountRecord(name);
    if (!rec) continue;
    portable.push({
      account: rec.account,
      username: rec.username,
      homeAccountId: rec.homeAccountId,
      // Déchiffré ici avec la clé de CETTE installation…
      cache: decrypt(rec.cacheBlob),
      enrolledAt: rec.enrolledAt,
    });
  }
  if (portable.length === 0) throw new Error('Aucune boîte à exporter.');

  // …puis rechiffré avec la phrase secrète : le fichier ne dépend plus d'ici.
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await keyFrom(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify({ version: VERSION, accounts: portable });
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  await recordOperation({
    account: '(système)',
    tool: 'ui_accounts_export',
    params: { accounts: portable.map((p) => p.account) },
    result: `${portable.length} boîte(s) exportée(s)`,
  });
  logger.info('export des boîtes', { count: portable.length });

  return {
    format: FORMAT,
    version: VERSION,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    accounts: portable.length,
    exportedAt: new Date().toISOString(),
  };
}

export interface ImportReport {
  imported: string[];
  skipped: { account: string; reason: string }[];
}

/**
 * Réinstalle des boîtes depuis un paquet exporté. Par défaut on ne remplace
 * PAS une boîte déjà enrôlée ici (on la signale) : l'import ne doit pas
 * écraser silencieusement des accès en cours d'usage.
 */
export async function importAccounts(
  envelope: unknown,
  passphrase: string,
  opts: { overwrite?: boolean } = {},
): Promise<ImportReport> {
  assertPassphrase(passphrase);
  const env = envelope as ExportEnvelope;
  if (!env || env.format !== FORMAT) {
    throw new Error("Ce fichier n'est pas un export de boîtes Mail Assistant.");
  }
  if (env.version !== VERSION) {
    throw new Error(`Version d'export non gérée (${env.version}).`);
  }

  let payload: { accounts: PortableAccount[] };
  try {
    const key = await keyFrom(passphrase, Buffer.from(env.salt, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(env.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    payload = JSON.parse(clear);
  } catch {
    // Phrase fausse ou fichier altéré : GCM ne fait pas la différence, et
    // c'est très bien ainsi (on n'apprend rien à qui essaie au hasard).
    throw new Error('Phrase secrète incorrecte, ou fichier abîmé.');
  }

  const existing = new Set(await listAccountNames());
  const report: ImportReport = { imported: [], skipped: [] };
  for (const acc of payload.accounts ?? []) {
    if (existing.has(acc.account) && !opts.overwrite) {
      report.skipped.push({ account: acc.account, reason: 'déjà enrôlée ici' });
      continue;
    }
    await upsertAccount(acc.account, {
      username: acc.username,
      homeAccountId: acc.homeAccountId,
      // Rechiffré avec la clé de CETTE installation.
      cacheBlob: encrypt(acc.cache),
    });
    report.imported.push(acc.account);
  }

  await recordOperation({
    account: '(système)',
    tool: 'ui_accounts_import',
    params: { imported: report.imported, skipped: report.skipped.map((s) => s.account) },
    result: `${report.imported.length} boîte(s) importée(s)`,
  });
  logger.info('import des boîtes', {
    imported: report.imported.length,
    skipped: report.skipped.length,
  });
  return report;
}
