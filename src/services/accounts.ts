import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getAccessToken, type EnrolledAccount } from './oauth.js';

/**
 * Persistance multi-comptes. accounts.json contient, par compte :
 *  - username / homeAccountId (métadonnées non secrètes)
 *  - cacheBlob : cache MSAL sérialisé PUIS chiffré AES-256-GCM
 *
 * Le fichier lui-même est gitignore. Le seul secret (cacheBlob) est chiffré ;
 * sans TOKEN_ENCRYPTION_KEY il est inexploitable.
 */

export interface AccountRecord {
  account: string;
  username: string;
  homeAccountId: string;
  cacheBlob: string;
  enrolledAt: string;
  updatedAt: string;
}

interface Store {
  version: 1;
  accounts: Record<string, AccountRecord>;
}

const emptyStore: Store = { version: 1, accounts: {} };

async function load(): Promise<Store> {
  if (!existsSync(config.files.accounts)) return { ...emptyStore, accounts: {} };
  try {
    const raw = await readFile(config.files.accounts, 'utf8');
    const parsed = JSON.parse(raw) as Store;
    if (parsed.version !== 1 || typeof parsed.accounts !== 'object') {
      throw new Error('format inattendu');
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `accounts.json illisible (${(err as Error).message}). ` +
        `Vérifier le fichier / la clé de chiffrement.`,
    );
  }
}

async function save(store: Store): Promise<void> {
  await mkdir(dirname(config.files.accounts), { recursive: true });
  // Écriture atomique : tmp puis rename, pour ne pas corrompre en cas de crash.
  const tmp = `${config.files.accounts}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await rename(tmp, config.files.accounts);
}

export async function upsertAccount(name: string, enrolled: EnrolledAccount): Promise<void> {
  const store = await load();
  const now = new Date().toISOString();
  const existing = store.accounts[name];
  store.accounts[name] = {
    account: name,
    username: enrolled.username,
    homeAccountId: enrolled.homeAccountId,
    cacheBlob: enrolled.cacheBlob,
    enrolledAt: existing?.enrolledAt ?? now,
    updatedAt: now,
  };
  await save(store);
  logger.info('compte enrôlé/mis à jour', { account: name, username: enrolled.username });
}

/** Renomme un compte (l'étiquette locale uniquement, le token est conservé). */
export async function renameAccount(oldName: string, newName: string): Promise<void> {
  const store = await load();
  const rec = store.accounts[oldName];
  if (!rec) throw new Error(`Compte "${oldName}" inconnu.`);
  if (store.accounts[newName]) throw new Error(`Le nom "${newName}" est déjà utilisé.`);
  delete store.accounts[oldName];
  store.accounts[newName] = { ...rec, account: newName, updatedAt: new Date().toISOString() };
  await save(store);
  logger.info('compte renommé', { from: oldName, to: newName });
}

/** Supprime un compte enrôlé (révoque l'accès local ; le token est effacé). */
export async function removeAccount(name: string): Promise<void> {
  const store = await load();
  if (!store.accounts[name]) throw new Error(`Compte "${name}" inconnu.`);
  delete store.accounts[name];
  await save(store);
  logger.info('compte supprimé', { account: name });
}

export async function listAccountNames(): Promise<string[]> {
  const store = await load();
  return Object.keys(store.accounts).sort();
}

export async function getAccountRecord(name: string): Promise<AccountRecord | null> {
  const store = await load();
  return store.accounts[name] ?? null;
}

/**
 * Résout le nom de compte : si `requested` est fourni il doit exister ; sinon,
 * si un seul compte est enrôlé, il est choisi par défaut (SPEC §5).
 */
export async function resolveAccount(requested?: string): Promise<AccountRecord> {
  const store = await load();
  const names = Object.keys(store.accounts);
  if (names.length === 0) {
    throw new Error("Aucun compte enrôlé. Lancer : npm run enroll -- --account <nom>");
  }
  if (requested) {
    const rec = store.accounts[requested];
    if (!rec) {
      throw new Error(
        `Compte "${requested}" inconnu. Comptes disponibles : ${names.join(', ')}`,
      );
    }
    return rec;
  }
  if (names.length === 1) return store.accounts[names[0]];
  throw new Error(
    `Plusieurs comptes enrôlés (${names.join(', ')}). Préciser le paramètre "account".`,
  );
}

/**
 * Renvoie un access token frais pour le compte et re-persiste le cache MSAL
 * si celui-ci a été rafraîchi.
 */
export async function accessTokenFor(
  rec: AccountRecord,
): Promise<{ accessToken: string; username: string; expiresOn: Date | null }> {
  const res = await getAccessToken({ cacheBlob: rec.cacheBlob, homeAccountId: rec.homeAccountId });
  if (res.updatedCacheBlob) {
    const store = await load();
    const current = store.accounts[rec.account];
    if (current) {
      current.cacheBlob = res.updatedCacheBlob;
      current.updatedAt = new Date().toISOString();
      await save(store);
    }
  }
  return { accessToken: res.accessToken, username: res.username, expiresOn: res.expiresOn };
}

/** État "santé token" pour list_accounts, sans jamais exposer le token. */
export async function tokenStatus(
  rec: AccountRecord,
): Promise<{ ok: boolean; username: string; expiresOn: string | null; error?: string }> {
  try {
    const res = await accessTokenFor(rec);
    return {
      ok: true,
      username: res.username,
      expiresOn: res.expiresOn ? res.expiresOn.toISOString() : null,
    };
  } catch (err) {
    return { ok: false, username: rec.username, expiresOn: null, error: (err as Error).message };
  }
}
