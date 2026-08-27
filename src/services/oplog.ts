import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Journal des opérations d'ÉCRITURE en JSONL (SPEC §6.4).
 * Une ligne par opération : timestamp, account, tool, params, UIDs affectés.
 * Aucun secret n'est écrit (les params passés ici ne contiennent jamais de token).
 */

export interface OperationEntry {
  account: string;
  tool: string;
  params: Record<string, unknown>;
  affectedUids?: number[];
  folder?: string;
  dryRun?: boolean;
  result?: string;
  /**
   * Contenu concerné (sujet + date par mail) pour savoir EXACTEMENT quoi.
   * `folder`/`uid` sont renseignés UNIQUEMENT quand le mail est resté à sa
   * place : l'interface s'en sert pour rendre le sujet cliquable et rouvrir
   * le mail. Après une suppression ou un déplacement, on les omet — l'UID
   * d'origine ne pointerait plus sur rien (mieux vaut du texte simple qu'un
   * lien mort).
   */
  items?: { subject: string; date: string | null; folder?: string; uid?: number }[];
  /**
   * QUI A DÉCIDÉ — le champ qui rend la charge mesurable.
   *
   *   `humaine` : l'interface lui a demandé de trancher, et il a tranché.
   *   `auto`    : l'assistant a décidé seul (règle appliquée, analyse, tri).
   *   `annulee` : il a défait une décision automatique. C'est la mesure de
   *               qualité la plus fine qu'on puisse obtenir SANS lui poser une
   *               seule question — 138 décisions autonomes, 4 annulations,
   *               2,9 % de contradiction.
   *
   * ⚠️ POURQUOI UN CHAMP ET PAS LE PRÉFIXE `ui_`. La convention de nommage
   * n'est pas un contrat : `attente.regle` et `engagement_creer` sont des
   * gestes humains sans préfixe, et le front reclasse tout `tool` inconnu en
   * « réglages ». Une métrique fondée sur le nom se dégraderait en silence au
   * prochain outil ajouté. Le champ est explicite, donc vérifiable.
   *
   * Absent = non classé : ces lignes sont EXCLUES du calcul plutôt que
   * comptées par défaut dans un camp. Une métrique qui gonfle toute seule ne
   * vaut rien.
   */
  decision?: 'humaine' | 'auto' | 'annulee';
}

const SENSITIVE_KEYS = /token|secret|password|authorization|bearer|cache/i;

/** Masque défensivement toute clé qui ressemblerait à un secret. */
function scrub(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '***' : v;
  }
  return out;
}

/** Dernières opérations journalisées (les plus récentes d'abord). */
export async function readOperations(limit = 30): Promise<Record<string, unknown>[]> {
  if (!existsSync(config.files.operationsLog)) return [];
  const raw = await readFile(config.files.operationsLog, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  return lines
    .slice(-limit)
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return { raw: l };
      }
    });
}

/** Une journée de charge décisionnelle. */
export interface ChargeJour {
  jour: string;
  humaines: number;
  auto: number;
  annulees: number;
}

/**
 * LA CHARGE DÉCISIONNELLE, jour par jour.
 *
 * `readOperations(limit)` ne sait lire que les N dernières lignes : impossible
 * d'en tirer une série. Cette fonction relit le journal et compte.
 *
 * ⚠️ CE CHIFFRE NE SE LIT JAMAIS SEUL. « Décisions demandées » s'optimise
 * pathologiquement : le meilleur produit du monde selon cette métrique serait
 * celui qui ne montre RIEN. Il se lit contre une seconde métrique — ce qui a
 * été manqué — et la règle de passage est : faire baisser la charge À
 * COUVERTURE CONSTANTE OU MEILLEURE.
 */
export async function chargeDecisionnelle(jours = 14): Promise<ChargeJour[]> {
  if (!existsSync(config.files.operationsLog)) return [];
  const raw = await readFile(config.files.operationsLog, 'utf8');
  const depuis = Date.now() - jours * 86_400_000;
  const parJour = new Map<string, ChargeJour>();
  for (const ligne of raw.split('\n')) {
    if (ligne.trim() === '') continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(ligne) as Record<string, unknown>;
    } catch {
      continue;
    }
    const d = typeof o.decision === 'string' ? o.decision : null;
    if (!d) continue; // non classé : exclu, jamais compté par défaut
    const ts = typeof o.ts === 'string' ? Date.parse(o.ts) : NaN;
    if (!Number.isFinite(ts) || ts < depuis) continue;
    const jour = new Date(ts).toISOString().slice(0, 10);
    const e = parJour.get(jour) ?? { jour, humaines: 0, auto: 0, annulees: 0 };
    if (d === 'humaine') e.humaines++;
    else if (d === 'auto') e.auto++;
    else if (d === 'annulee') e.annulees++;
    parJour.set(jour, e);
  }
  return [...parJour.values()].sort((a, b) => a.jour.localeCompare(b.jour));
}

export async function recordOperation(entry: OperationEntry): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    account: entry.account,
    tool: entry.tool,
    dryRun: entry.dryRun ?? false,
    decision: entry.decision,
    folder: entry.folder,
    params: scrub(entry.params),
    affectedUids: entry.affectedUids,
    // Liste exacte des mails concernés (garde-fou) : une opération = une entrée,
    // le plafond est aligné sur la limite de sélection de l'interface (20 000).
    items: entry.items?.slice(0, 20_000),
    result: entry.result,
  });
  try {
    await mkdir(dirname(config.files.operationsLog), { recursive: true });
    await appendFile(config.files.operationsLog, line + '\n');
  } catch (err) {
    // Ne pas faire échouer l'opération métier si le log échoue, mais le signaler.
    logger.error("échec écriture journal d'opérations", { error: (err as Error).message });
  }
}
