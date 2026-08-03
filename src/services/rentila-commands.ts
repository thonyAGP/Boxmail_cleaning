import { db, ensureDbReady } from '../db/client.js';
import { recordOperation } from './oplog.js';

/**
 * Connecteur Rentila, phase 2 — la FILE DE COMMANDES (03/08).
 *
 * Rentila n'a pas d'API publique documentée : le seul canal officiel est son
 * connecteur MCP, branché sur la session Claude de l'utilisateur. Le pont
 * suit donc la même décision que l'analyse IA (10/07 : pas de clé API côté
 * serveur) :
 *   1. Boxmail PRÉPARE une commande depuis un mail (pré-remplie, éditable) ;
 *   2. l'utilisateur la VALIDE dans l'interface (c'est l'aperçu-confirmation) ;
 *   3. Claude — qui a les DEUX connecteurs (Boxmail + Rentila) — récupère les
 *      commandes validées via le tool MCP `rentila_pending_commands`, les
 *      exécute chez Rentila, et rapporte le résultat via
 *      `rentila_command_result`.
 * Aucun identifiant Rentila ne transite par le serveur ni par le navigateur.
 * Chaque étape est journalisée.
 */

export type RentilaCommandKind = 'mark_rent_paid' | 'create_task' | 'send_tenant_message';
export const RENTILA_COMMAND_KINDS: RentilaCommandKind[] = ['mark_rent_paid', 'create_task', 'send_tenant_message'];

export type RentilaCommandStatus = 'proposed' | 'approved' | 'done' | 'failed' | 'cancelled';

export interface RentilaCommandItem {
  id: number;
  createdAt: string;
  kind: RentilaCommandKind;
  params: Record<string, unknown>;
  label: string;
  account: string | null;
  messageId: number | null;
  status: RentilaCommandStatus;
  result: string | null;
  executedAt: string | null;
}

function toItem(c: {
  id: number; createdAt: Date; kind: string; params: string; label: string;
  accountSlug: string | null; messageId: number | null; status: string;
  result: string | null; executedAt: Date | null;
}): RentilaCommandItem {
  let params: Record<string, unknown> = {};
  try { params = JSON.parse(c.params) as Record<string, unknown>; } catch { /* illisible */ }
  return {
    id: c.id,
    createdAt: c.createdAt.toISOString(),
    kind: c.kind as RentilaCommandKind,
    params,
    label: c.label,
    account: c.accountSlug,
    messageId: c.messageId,
    status: c.status as RentilaCommandStatus,
    result: c.result,
    executedAt: c.executedAt?.toISOString() ?? null,
  };
}

/** Crée une commande. `approved: true` quand l'utilisateur vient de la valider
 *  dans le formulaire (le formulaire EST l'aperçu-confirmation). */
export async function createRentilaCommand(input: {
  kind: RentilaCommandKind;
  params: Record<string, unknown>;
  label: string;
  account?: string | null;
  messageId?: number | null;
  approved?: boolean;
}): Promise<RentilaCommandItem> {
  await ensureDbReady();
  if (!RENTILA_COMMAND_KINDS.includes(input.kind)) throw new Error(`Commande inconnue : ${input.kind}`);
  const label = input.label.trim().slice(0, 300);
  if (!label) throw new Error('Le libellé de la commande est requis.');
  const row = await db.rentilaCommand.create({
    data: {
      kind: input.kind,
      params: JSON.stringify(input.params ?? {}),
      label,
      accountSlug: input.account ?? null,
      messageId: input.messageId ?? null,
      status: input.approved ? 'approved' : 'proposed',
    },
  });
  await recordOperation({
    account: input.account ?? '*',
    tool: 'rentila_command_created',
    params: { id: row.id, kind: input.kind, approved: Boolean(input.approved) },
    result: `commande Rentila ${input.approved ? 'validée' : 'proposée'} : ${label}`,
  });
  return toItem(row);
}

export async function listRentilaCommands(opts: { status?: RentilaCommandStatus; limit?: number } = {}): Promise<RentilaCommandItem[]> {
  await ensureDbReady();
  const rows = await db.rentilaCommand.findMany({
    where: opts.status ? { status: opts.status } : {},
    orderBy: { id: 'desc' },
    take: Math.min(Math.max(opts.limit ?? 100, 1), 500),
  });
  return rows.map(toItem);
}

export async function approveRentilaCommand(id: number): Promise<RentilaCommandItem> {
  await ensureDbReady();
  const row = await db.rentilaCommand.findFirst({ where: { id } });
  if (!row) throw new Error(`Commande ${id} introuvable.`);
  if (row.status !== 'proposed') throw new Error(`La commande ${id} n'est pas en attente de validation (${row.status}).`);
  const updated = await db.rentilaCommand.update({ where: { id }, data: { status: 'approved' } });
  await recordOperation({
    account: row.accountSlug ?? '*',
    tool: 'rentila_command_approved',
    params: { id },
    result: `commande Rentila validée : ${row.label}`,
  });
  return toItem(updated);
}

export async function cancelRentilaCommand(id: number): Promise<RentilaCommandItem> {
  await ensureDbReady();
  const row = await db.rentilaCommand.findFirst({ where: { id } });
  if (!row) throw new Error(`Commande ${id} introuvable.`);
  if (row.status === 'done') throw new Error('Une commande déjà exécutée ne peut plus être annulée ici.');
  const updated = await db.rentilaCommand.update({ where: { id }, data: { status: 'cancelled' } });
  await recordOperation({
    account: row.accountSlug ?? '*',
    tool: 'rentila_command_cancelled',
    params: { id },
    result: `commande Rentila annulée : ${row.label}`,
  });
  return toItem(updated);
}

/** Les commandes VALIDÉES en attente d'exécution — consommées par Claude. */
export function pendingRentilaCommands(): Promise<RentilaCommandItem[]> {
  return listRentilaCommands({ status: 'approved' });
}

/** Compte rendu d'exécution (posé par Claude après action côté Rentila). */
export async function reportRentilaCommand(
  id: number,
  input: { ok: boolean; result: string },
): Promise<RentilaCommandItem> {
  await ensureDbReady();
  const row = await db.rentilaCommand.findFirst({ where: { id } });
  if (!row) throw new Error(`Commande ${id} introuvable.`);
  if (row.status !== 'approved') throw new Error(`La commande ${id} n'est pas en attente d'exécution (${row.status}).`);
  const result = input.result.trim().slice(0, 1000);
  const updated = await db.rentilaCommand.update({
    where: { id },
    data: { status: input.ok ? 'done' : 'failed', result, executedAt: new Date() },
  });
  await recordOperation({
    account: row.accountSlug ?? '*',
    tool: 'rentila_command_result',
    params: { id, ok: input.ok },
    result: `commande Rentila ${input.ok ? 'exécutée' : 'en échec'} : ${row.label} — ${result}`,
  });
  return toItem(updated);
}

/** Compteurs pour la carte « Gestion locative ». */
export async function rentilaCommandCounts(): Promise<{ proposed: number; approved: number; failed: number }> {
  await ensureDbReady();
  const [proposed, approved, failed] = await Promise.all([
    db.rentilaCommand.count({ where: { status: 'proposed' } }),
    db.rentilaCommand.count({ where: { status: 'approved' } }),
    db.rentilaCommand.count({ where: { status: 'failed' } }),
  ]);
  return { proposed, approved, failed };
}
