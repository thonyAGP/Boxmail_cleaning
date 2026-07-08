/**
 * Logger minimal, sans dépendance. Écrit sur stderr pour ne pas polluer
 * stdout (utilisé par certains transports MCP). Ne logge JAMAIS de secrets.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold: Level = (process.env.LOG_LEVEL as Level) || 'info';

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (order[level] < order[threshold]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  process.stderr.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
