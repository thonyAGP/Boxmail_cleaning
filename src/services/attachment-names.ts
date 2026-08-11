import { db, ensureDbReady } from '../db/client.js';
import { logger } from '../logger.js';
import { imapService } from './imap.js';
import { countAttachments, collectAttachmentInfo } from './sync.js';
import type { AccountRecord } from './accounts.js';

/**
 * Noms des pièces jointes — rattrapage sur l'existant (11/08).
 *
 * POURQUOI : « retrouver sans classer ». Anthony ne range rien, mais ses
 * fournisseurs nomment leurs fichiers. Mesuré le 10/08 : 10 191 mails portent
 * une pièce jointe et le texte n'en avait été lu que sur 27 — la promesse
 * « je retrouve ton document » reposait sur du vide. Les NOMS, eux, sont
 * disponibles gratuitement dans le bodyStructure : aucune pièce n'est
 * téléchargée ici, on ne lit que la table des matières du mail.
 *
 * Effet de bord volontaire et utile : la passe REPARE aussi `hasAttachments`
 * et `attachmentCount` sur les mails indexés avant que la sync ne les calcule
 * (ils étaient restés à false/0, ce qui fausse toutes les protections
 * « ce mail porte une pièce, on n'y touche pas »).
 *
 * `attachmentNames = ''` (chaîne vide) signifie « déjà regardé, aucune pièce
 * nommée » : sans ça, le rattrapage repasserait éternellement sur les mêmes
 * mails, comme le job des extraits l'a appris à ses dépens.
 */

const DEFAUT = 400;
const MAXI = 3000;
/** Un dossier en panne ne doit pas bloquer le rattrapage : on le réessaie plus tard. */
const REESSAI_MS = 6 * 3600_000;

export interface NamesOptions {
  limit?: number;
  /** 'oldest' (défaut) pour purger le fonds, 'newest' pour le flux courant. */
  order?: 'oldest' | 'newest';
  onProgress?: (message: string) => void;
}

export interface NamesResult {
  /** Mails examinés (structure reçue ou non). */
  scanned: number;
  /** Mails pour lesquels au moins un nom de pièce a été enregistré. */
  named: number;
  /** Mails sans aucune pièce nommée (marqués comme vus). */
  empty: number;
  /** Mails dont `hasAttachments`/`attachmentCount` ont été corrigés. */
  repaired: number;
  /** Dossiers en échec : mails remis à plus tard. */
  deferred: number;
  /** Ce qu'il reste à faire sur ce compte. */
  remaining: number;
}

export async function backfillAttachmentNames(
  rec: AccountRecord,
  opts: NamesOptions = {},
): Promise<NamesResult> {
  await ensureDbReady();
  const progress = opts.onProgress ?? (() => {});
  const limit = Math.min(Math.max(opts.limit ?? DEFAUT, 1), MAXI);
  const order = opts.order ?? 'oldest';

  // Corbeille et spam exclus : on n'indexe pas ce qui est déjà jeté.
  const where = {
    accountSlug: rec.account,
    isDeleted: false,
    attachmentNames: null,
    folder: { is: { role: { notIn: ['trash', 'spam'] } } },
  };

  const pending = await db.message.findMany({
    where,
    orderBy: { date: order === 'oldest' ? 'asc' : 'desc' },
    take: limit,
    select: {
      id: true,
      uid: true,
      hasAttachments: true,
      attachmentCount: true,
      folder: { select: { path: true } },
    },
  });

  const result: NamesResult = {
    scanned: 0,
    named: 0,
    empty: 0,
    repaired: 0,
    deferred: 0,
    remaining: 0,
  };
  if (pending.length === 0) return result;

  // Un seul verrouillage de boîte par dossier.
  const parDossier = new Map<string, typeof pending>();
  for (const m of pending) {
    const arr = parDossier.get(m.folder.path) ?? [];
    arr.push(m);
    parDossier.set(m.folder.path, arr);
  }
  progress(
    `${pending.length} mail(s) à examiner dans ${parDossier.size} dossier(s) — lecture des structures…`,
  );

  const maj: {
    id: number;
    names: string;
    meta: string | null;
    count: number;
    has: boolean;
    repaired: boolean;
  }[] = [];

  for (const [chemin, messages] of parDossier) {
    try {
      const structures = await imapService.fetchBodyStructures(
        rec,
        chemin,
        messages.map((m) => m.uid),
      );
      for (const m of messages) {
        result.scanned++;
        // Mail absent de la réponse (supprimé entre-temps) : on le marque vu,
        // sinon il revient à chaque passe.
        const node = structures.get(m.uid) ?? null;
        const info = collectAttachmentInfo(node as never);
        const names = info.map((x) => x.n).join('\n');
        const count = countAttachments(node as never);
        const has = count > 0;
        const repaired = has !== m.hasAttachments || count !== m.attachmentCount;
        if (names) result.named++;
        else result.empty++;
        if (repaired) result.repaired++;
        maj.push({
          id: m.id,
          names,
          meta: info.length ? JSON.stringify(info) : null,
          count,
          has,
          repaired,
        });
      }
    } catch (err) {
      logger.warn('noms des pièces : dossier ignoré', {
        account: rec.account,
        folder: chemin,
        error: (err as Error).message,
      });
      result.deferred += messages.length;
      progress(`⚠️ ${chemin} ignoré (${(err as Error).message}) — réessai plus tard.`);
    }
  }

  // Écritures groupées, une transaction par paquet (SQLite mono-connexion).
  for (let i = 0; i < maj.length; i += 200) {
    const paquet = maj.slice(i, i + 200);
    await db.$transaction(
      paquet.map((u) =>
        db.message.update({
          where: { id: u.id },
          data: {
            attachmentNames: u.names,
            attachmentMeta: u.meta,
            ...(u.repaired ? { hasAttachments: u.has, attachmentCount: u.count } : {}),
          },
        }),
      ),
    );
  }

  result.remaining = await db.message.count({ where });
  progress(
    `Noms des pièces : ${result.named} mail(s) documentés, ${result.repaired} corrigé(s), ` +
      `${result.remaining} restant(s).`,
  );
  return result;
}

/** Réservé : mails dont la structure n'a jamais pu être lue (dossier en panne). */
export function retryDelayMs(): number {
  return REESSAI_MS;
}
