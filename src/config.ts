import 'dotenv/config';
import { resolve } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Variable d'environnement manquante: ${name}. Voir .env.example`);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const projectRoot = process.cwd();

/**
 * Configuration centrale. Les secrets (bearer token, clé de chiffrement,
 * client id) ne sont lus qu'ici et jamais loggés.
 */
export const config = {
  http: {
    port: int('PORT', 8787),
    host: optional('HOST', '127.0.0.1'),
  },
  auth: {
    // Le bearer token est requis pour DÉMARRER le serveur : on refuse
    // d'exposer un endpoint mail sans authentification.
    bearerToken: required('MCP_BEARER_TOKEN'),
  },
  crypto: {
    // Clé AES-256-GCM (32 octets) encodée base64.
    encryptionKeyB64: required('TOKEN_ENCRYPTION_KEY'),
  },
  oauth: {
    clientId: required('MS_CLIENT_ID'),
    authority: optional('MS_AUTHORITY', 'https://login.microsoftonline.com/consumers'),
    // Scopes délégués IMAP/SMTP (ressource). offline_access / openid / profile
    // sont RÉSERVÉS : MSAL les ajoute implicitement pour un client public afin
    // d'obtenir le refresh token — les passer explicitement fait planter MSAL.
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
    ],
  },
  smtp: {
    // Activé par défaut depuis le rattrapage maquette (L5.3, 07/2026) : la
    // composition passe par l'interface avec confirmation + journal.
    enabled: bool('ENABLE_SMTP_SEND', true),
    host: optional('SMTP_HOST', 'smtp-mail.outlook.com'),
    port: int('SMTP_PORT', 587),
  },
  imap: {
    host: optional('IMAP_HOST', 'outlook.office365.com'),
    port: int('IMAP_PORT', 993),
  },
  rateLimit: {
    max: int('RATE_LIMIT_MAX', 60),
    windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
  },
  admin: {
    // Mot de passe de l'interface web. Si absent, l'interface est désactivée
    // (le serveur MCP fonctionne normalement).
    password: process.env.ADMIN_PASSWORD?.trim() || null,
    sessionTtlMs: int('ADMIN_SESSION_TTL_MINUTES', 24 * 60) * 60_000,
    // URL publique de l'interface (sert au retour OAuth de l'enrôlement).
    // En local la valeur par défaut suffit ; sur le serveur : https://mcp.lb2i.fr
    publicBaseUrl: optional('PUBLIC_BASE_URL', `http://localhost:${int('PORT', 8787)}`),
  },
  files: {
    accounts: resolve(projectRoot, optional('ACCOUNTS_FILE', 'accounts.json')),
    operationsLog: resolve(projectRoot, optional('OPERATIONS_LOG', 'logs/operations.jsonl')),
  },
  limits: {
    // Plafond dur par opération de suppression (SPEC §6.3).
    maxDeletePerCall: 200,
    // Troncature du corps HTML converti (SPEC read_email).
    maxBodyChars: 5000,
  },
} as const;

export type AppConfig = typeof config;
