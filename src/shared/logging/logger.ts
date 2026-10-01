export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

// Keys whose values must never reach logs, whatever the caller passes.
const REDACTED_KEYS = new Set([
  'phone',
  'authorization',
  'token',
  'jwt',
  'secret',
  'password',
  'name',
]);

export function maskPhone(phone: string): string {
  return `***${phone.slice(-4)}`;
}

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return out;
}

export function createLogger(
  sink: LogSink = (line) => process.stdout.write(`${line}\n`),
  bindings: LogFields = {},
): Logger {
  const write = (level: string, message: string, fields: LogFields = {}) => {
    sink(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        message,
        ...redact(bindings),
        ...redact(fields),
      }),
    );
  };
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (extra) => createLogger(sink, { ...bindings, ...extra }),
  };
}

export const silentLogger: Logger = createLogger(() => undefined);
