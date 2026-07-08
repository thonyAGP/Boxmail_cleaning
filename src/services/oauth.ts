import {
  PublicClientApplication,
  LogLevel,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node';

/** Sous-ensemble du DeviceCodeResponse MSAL utilisé pour l'affichage CLI. */
export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
}
import { config } from '../config.js';
import { encrypt, decrypt } from './crypto.js';
import { logger } from '../logger.js';

/**
 * Couche OAuth2 Microsoft (XOAUTH2) via MSAL.
 *
 * - Enrôlement : device code flow (hors Claude, en SSH). L'utilisateur valide
 *   sur microsoft.com/devicelogin.
 * - Runtime : acquireTokenSilent utilise le refresh token présent dans le cache
 *   MSAL sérialisé (chiffré au repos) pour émettre un access token frais.
 *
 * Le cache MSAL (qui contient le refresh token) est sérialisé puis chiffré
 * AES-256-GCM avant d'être écrit dans accounts.json. Il n'est jamais loggé.
 */

export interface EnrolledAccount {
  username: string;
  homeAccountId: string;
  /** Cache MSAL sérialisé PUIS chiffré (blob base64). */
  cacheBlob: string;
}

export interface AccessTokenResult {
  accessToken: string;
  username: string;
  expiresOn: Date | null;
  /** Présent uniquement si le cache a changé (refresh) et doit être re-persisté. */
  updatedCacheBlob?: string;
}

interface CacheHolder {
  data: string | null;
  changed: boolean;
}

function buildPca(holder: CacheHolder): PublicClientApplication {
  const cachePlugin: ICachePlugin = {
    beforeCacheAccess: async (ctx: TokenCacheContext) => {
      if (holder.data) ctx.tokenCache.deserialize(holder.data);
    },
    afterCacheAccess: async (ctx: TokenCacheContext) => {
      if (ctx.cacheHasChanged) {
        holder.data = ctx.tokenCache.serialize();
        holder.changed = true;
      }
    },
  };

  return new PublicClientApplication({
    auth: {
      clientId: config.oauth.clientId,
      authority: config.oauth.authority,
    },
    cache: { cachePlugin },
    system: {
      loggerOptions: {
        // On coupe totalement les logs MSAL en prod pour ne pas fuiter de tokens.
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
        loggerCallback: (_level, message, containsPii) => {
          if (!containsPii) logger.debug('msal', { message });
        },
      },
    },
  });
}

/**
 * Device code flow. Appelle `onDeviceCode` avec les instructions à afficher
 * à l'utilisateur (URL + code). Résout quand l'utilisateur a validé.
 */
export async function enrollAccount(
  onDeviceCode: (info: DeviceCodeInfo) => void,
): Promise<EnrolledAccount> {
  const holder: CacheHolder = { data: null, changed: false };
  const pca = buildPca(holder);

  const result = await pca.acquireTokenByDeviceCode({
    scopes: [...config.oauth.scopes],
    deviceCodeCallback: (resp) => onDeviceCode(resp),
  });

  if (!result || !result.account) {
    throw new Error('Enrôlement échoué : aucun compte retourné par MSAL.');
  }
  if (!holder.data) {
    throw new Error('Enrôlement échoué : cache MSAL vide (pas de refresh token).');
  }

  return {
    username: result.account.username,
    homeAccountId: result.account.homeAccountId,
    cacheBlob: encrypt(holder.data),
  };
}

/**
 * Émet un access token frais pour un compte enrôlé, en réutilisant le refresh
 * token du cache. Si MSAL a rafraîchi le cache, `updatedCacheBlob` est fourni
 * pour être re-persisté par l'appelant.
 */
export async function getAccessToken(record: {
  cacheBlob: string;
  homeAccountId: string;
}): Promise<AccessTokenResult> {
  const holder: CacheHolder = { data: decrypt(record.cacheBlob), changed: false };
  const pca = buildPca(holder);

  const account = await pca.getTokenCache().getAccountByHomeId(record.homeAccountId);
  if (!account) {
    throw new Error(
      'Compte introuvable dans le cache MSAL. Le compte doit être ré-enrôlé ' +
        '(npm run enroll -- --account <nom>).',
    );
  }

  let result;
  try {
    result = await pca.acquireTokenSilent({
      account,
      scopes: [...config.oauth.scopes],
    });
  } catch (err) {
    throw new Error(
      `Impossible de rafraîchir le token pour ${account.username} : ${
        (err as Error).message
      }. Refresh token probablement expiré/révoqué — ré-enrôler le compte.`,
    );
  }

  if (!result) {
    throw new Error('acquireTokenSilent a renvoyé un résultat vide.');
  }

  return {
    accessToken: result.accessToken,
    username: account.username,
    expiresOn: result.expiresOn ?? null,
    updatedCacheBlob: holder.changed && holder.data ? encrypt(holder.data) : undefined,
  };
}
