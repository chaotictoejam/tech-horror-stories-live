// Structured logs. Story text must only ever be logged at DEBUG, which is off by default.
type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
const ORDER: Record<Level, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'INFO'] ?? ORDER.INFO;

function emit(level: Level, msg: string, data?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  console.log(JSON.stringify({ level, msg, ...data }));
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('DEBUG', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('INFO', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('WARN', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('ERROR', msg, data),
};
