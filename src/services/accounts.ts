import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getAccessToken, type EnrolledAccount } from './oauth.js';
import { encrypt, decrypt } from './crypto.js';

/**
 * Persistance multi-comptes. accounts.json contient, par compte :
 *  - username / homeAccountId (métadonnées non secrètes)
 *  - cacheBlob : cache MSAL sérialisé PUIS chiffré AES-256-GCM
 *
 * Depuis le 14/08 (chantier comptes-imap-mot-de-passe), deux types de comptes
 * cohabitent dans le MÊME store, discriminés par `authType` :
 *  - absent ou 'oauth'  → compte Outlook historique (MSAL/XOAUTH2) — les
 *    enregistrements existants restent valides tels quels, AUCUNE migration ;
 *  - 'password'         → compte IMAP classique (OVH…) : `passwordBlob` porte
 *    le mot de passe chiffré par le même module crypto que les tokens, et les
 *    paramètres de connexion sont stockés PAR COMPTE (host/port/secure,
 *    décidés à l'enrôlement — on représente la config, on ne la déduit pas à
 *    chaque connexion).
 *
 * Le fichier lui-même est gitignore. Les seuls secrets (cacheBlob,
 * passwordBlob) sont chiffrés ; sans TOKEN_ENCRYPTION_KEY ils sont
 * inexploitables. Le mot de passe n'est jamais persisté en clair, jamais
 * loggé, jamais renvoyé par l'API.
 */

export interface AccountRecord {
  account: string;
  username: string;
  homeAccountId: string;
  cacheBlob: string;
  enrolledAt: string;
  updatedAt: string;
  // --- Comptes IMAP par mot de passe (optionnels : absents sur les comptes
  // OAuth historiques, le JSON en place se relit sans migration). ---
  authType?: 'oauth' | 'password';
  passwordBlob?: string;
  imapHost?: string;
  imapPort?: number;
  /** TLS implicite (993) ; false = STARTTLS (143). Stocké, pas déduit. */
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  /** TLS implicite (465) ; false = STARTTLS obligatoire (587). */
  smtpSecure?: boolean;
  /** Login IMAP/SMTP si différent de l'adresse (défaut = username). */
  imapUser?: string;
  smtpUser?: string;
}

/** Vrai pour un compte IMAP classique (mot de passe), faux pour OAuth. */
export function isPasswordAccount(rec: AccountRecord): boolean {
  return rec.authType === 'password';
}

/** Paramètres d'un enrôlement IMAP par mot de passe (déjà testés en amont). */
export interface ImapEnrollment {
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapUser?: string;
  smtpUser?: string;
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

/**
 * Enrôle (ou met à jour) un compte IMAP par mot de passe. GARDE ANTI-ÉCRASEMENT
 * (contre-revue 14/08) : un nom déjà pris par un compte OAuth est REFUSÉ — on
 * ne convertit jamais silencieusement un type d'authentification en l'autre.
 * Un nom déjà en password = mise à jour des identifiants (l'appelant a re-testé
 * la connexion avant d'appeler).
 */
export async function upsertImapAccount(name: string, enr: ImapEnrollment): Promise<void> {
  const store = await load();
  const now = new Date().toISOString();
  const existing = store.accounts[name];
  if (existing && existing.authType !== 'password') {
    throw new Error(
      `Le nom « ${name} » désigne déjà un compte Outlook (OAuth). ` +
        `Choisir un autre nom : un compte ne change jamais de type d'authentification.`,
    );
  }
  store.accounts[name] = {
    account: name,
    username: enr.username,
    homeAccountId: '',
    cacheBlob: '',
    enrolledAt: existing?.enrolledAt ?? now,
    updatedAt: now,
    authType: 'password',
    passwordBlob: encrypt(enr.password),
    imapHost: enr.imapHost,
    imapPort: enr.imapPort,
    imapSecure: enr.imapSecure,
    smtpHost: enr.smtpHost,
    smtpPort: enr.smtpPort,
    smtpSecure: enr.smtpSecure,
    ...(enr.imapUser && enr.imapUser !== enr.username ? { imapUser: enr.imapUser } : {}),
    ...(enr.smtpUser && enr.smtpUser !== enr.username ? { smtpUser: enr.smtpUser } : {}),
  };
  await save(store);
  // Volontairement : ni le mot de passe ni sa longueur dans le log.
  logger.info('compte IMAP enrôlé/mis à jour', {
    account: name,
    username: enr.username,
    imap: `${enr.imapHost}:${enr.imapPort}`,
    smtp: `${enr.smtpHost}:${enr.smtpPort}`,
  });
}

/** Mot de passe IMAP déchiffré à la demande (jamais persisté en clair). */
export function imapPasswordOf(rec: AccountRecord): string {
  if (rec.authType !== 'password' || !rec.passwordBlob) {
    throw new Error(`Le compte "${rec.account}" n'est pas un compte IMAP par mot de passe.`);
  }
  return decrypt(rec.passwordBlob);
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
  // Garde explicite (contre-revue 14/08) : jamais de comportement silencieux
  // si un chemin de code tente le flux OAuth sur un compte à mot de passe.
  if (rec.authType === 'password') {
    throw new Error(
      `Le compte "${rec.account}" s'authentifie par mot de passe : ` +
        `pas de token OAuth à demander (bug d'aiguillage en amont).`,
    );
  }
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
): Promise<{ ok: boolean; username: string; expiresOn: string | null; error?: string; authType?: string }> {
  // Compte à mot de passe : pas de notion d'expiration de token. On vérifie
  // seulement que le secret est présent et déchiffrable ; la santé réelle
  // (connexion) est observée par la sync, comme pour les erreurs IMAP OAuth.
  if (rec.authType === 'password') {
    try {
      imapPasswordOf(rec);
      return { ok: true, username: rec.username, expiresOn: null, authType: 'password' };
    } catch (err) {
      return {
        ok: false,
        username: rec.username,
        expiresOn: null,
        authType: 'password',
        error: (err as Error).message,
      };
    }
  }
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
