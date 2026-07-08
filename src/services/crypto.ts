import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Chiffrement symétrique AES-256-GCM pour les tokens/caches MSAL au repos.
 *
 * Format du blob (base64 d'une concaténation binaire) :
 *   [ iv (12o) | authTag (16o) | ciphertext (n) ]
 *
 * La clé provient de TOKEN_ENCRYPTION_KEY (32 octets base64), hors du repo.
 */

const KEY = loadKey();

function loadKey(): Buffer {
  const key = Buffer.from(config.crypto.encryptionKeyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY doit décoder vers 32 octets (AES-256). ` +
        `Obtenu: ${key.length}. Générer avec: npm run genkey`,
    );
  }
  return key;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decrypt(blobB64: string): string {
  const blob = Buffer.from(blobB64, 'base64');
  if (blob.length < 12 + 16) {
    throw new Error('Blob chiffré invalide (trop court).');
  }
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
