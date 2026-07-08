import { z } from 'zod';
import { logger } from '../logger.js';

/** Résultat texte JSON standard pour un tool MCP. */
export function jsonResult(obj: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
  };
}

/** Résultat fichier (texte) — pour livrer .vcf / .csv en téléchargement. */
export function fileResult(filename: string, mime: string, data: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `Fichier généré : ${filename} (${mime})\n` +
          `--- Copier/coller le contenu ci-dessous dans un fichier ${filename} ---\n\n` +
          data,
      },
    ],
  };
}

/** Résultat d'erreur MCP (isError:true) sans jamais fuiter de secret. */
export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn('tool error', { message });
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `Erreur : ${message}` }],
  };
}

/** Enveloppe un handler de tool pour convertir les exceptions en errorResult. */
export function guard<T extends (args: any) => Promise<any>>(fn: T): T {
  return (async (args: any) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  }) as T;
}

/** Paramètre `account` commun à tous les tools (optionnel : défaut si 1 seul compte). */
export const accountParam = {
  account: z
    .string()
    .optional()
    .describe("Nom du compte enrôlé (ex. 'brimmo'). Optionnel si un seul compte existe."),
};
