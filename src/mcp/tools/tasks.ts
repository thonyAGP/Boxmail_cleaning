import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listTasks, createTask, completeTask, dismissTask } from '../../services/tasks.js';
import { guard, jsonResult } from '../util.js';

/**
 * Tools MCP « tâches » (L5.5) — la liste à faire de l'utilisateur.
 * État local (SQLite) : ne touche jamais aux mails, tout est journalisé.
 */

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    'list_tasks',
    {
      title: 'Lister les tâches',
      description:
        "Liste les tâches de l'utilisateur (à faire / terminées / ignorées) avec compteurs. " +
        'Les tâches à faire sont triées par échéance (les plus proches et en retard en tête). ' +
        'Chaque tâche peut référencer le mail ou l\'échéance qui l\'a créée. Lecture seule.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).default(200).describe('Nombre max de tâches.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (args: { limit: number }) => jsonResult(await listTasks({ limit: args.limit }))),
  );

  server.registerTool(
    'create_task',
    {
      title: 'Créer une tâche',
      description:
        "Ajoute une tâche à la liste de l'utilisateur (titre, note et date limite optionnelles). " +
        'Ne touche pas aux mails — état local journalisé. Pour transformer une échéance en ' +
        'tâche, utiliser plutôt son id d\'échéance côté interface.',
      inputSchema: {
        title: z.string().min(1).max(300).describe('Titre de la tâche (en français).'),
        notes: z.string().max(2000).optional().describe('Détails libres (optionnel).'),
        dueDate: z
          .string()
          .optional()
          .describe('Date limite ISO 8601 (ex. 2026-07-15) — optionnelle.'),
        account: z.string().optional().describe('Compte concerné (optionnel).'),
      },
    },
    guard(async (args: { title: string; notes?: string; dueDate?: string; account?: string }) =>
      jsonResult(
        await createTask({
          title: args.title,
          notes: args.notes,
          dueDate: args.dueDate ? new Date(args.dueDate) : null,
          account: args.account ?? null,
        }),
      ),
    ),
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Terminer une tâche',
      description:
        'Marque une tâche comme faite (champ id retourné par list_tasks). Journalisé.',
      inputSchema: {
        taskId: z.number().int().positive().describe('Identifiant de la tâche.'),
      },
    },
    guard(async (args: { taskId: number }) => jsonResult(await completeTask(args.taskId))),
  );

  server.registerTool(
    'dismiss_task',
    {
      title: 'Ignorer une tâche',
      description:
        'Retire une tâche de la liste sans la marquer faite (plus pertinente). Journalisé et ' +
        'réversible depuis l\'interface (onglet Ignorées).',
      inputSchema: {
        taskId: z.number().int().positive().describe('Identifiant de la tâche.'),
      },
    },
    guard(async (args: { taskId: number }) => jsonResult(await dismissTask(args.taskId))),
  );
}
