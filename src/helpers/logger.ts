export const DEFAULT_LOG_TEXT_LIMIT = 512;

export function truncateLogText(text: unknown, limit = DEFAULT_LOG_TEXT_LIMIT): string {
  const s = text === null || text === undefined ? '' : String(text);
  if (s.length <= limit) return s;
  const omitted = s.length - limit;
  return `${s.slice(0, limit)}... [truncated ${omitted} chars; total ${s.length}]`;
}

export interface Logger {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warning(...args: any[]): void;
  error(...args: any[]): void;
  exception(...args: any[]): void;
}

const LEVELS: Record<string, number> = { debug: 10, info: 20, warning: 30, error: 40, silent: 100 };

/** printf-style %s / %d formatting used by logging calls. */
export function formatString(fmt: unknown, args: any[]): string {
  if (typeof fmt !== 'string' || !args.length) return [fmt, ...args].map((a) => (typeof a === 'string' ? a : safeStr(a))).join(' ');
  let i = 0;
  const out = fmt.replace(/%[sdrf]/g, () => (i < args.length ? safeStr(args[i++]) : ''));
  return i < args.length ? `${out} ${args.slice(i).map(safeStr).join(' ')}` : out;
}

function safeStr(a: any): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return typeof a === 'object' ? JSON.stringify(a) : String(a);
  } catch {
    return String(a);
  }
}

/** Minimal leveled logger (debug/info/warning/error). Silent unless a level is configured. */
export class SimpleLogger implements Logger {
  level: number;
  constructor(public name: string, level: keyof typeof LEVELS | number = (process.env.INSTA_NODE_LOG_LEVEL as any) || 'warning') {
    this.level = typeof level === 'number' ? level : LEVELS[level] ?? 30;
  }
  setLevel(level: keyof typeof LEVELS | number) {
    this.level = typeof level === 'number' ? level : LEVELS[level] ?? 30;
  }
  private log(lvl: number, tag: string, args: any[]) {
    if (lvl < this.level) return;
    const [fmt, ...rest] = args;
    const line = `${new Date().toISOString()} ${tag} ${this.name}: ${formatString(fmt, rest)}`;
    if (lvl >= 30) console.error(line);
    else console.log(line);
  }
  debug(...args: any[]) { this.log(10, 'DEBUG', args); }
  info(...args: any[]) { this.log(20, 'INFO', args); }
  warning(...args: any[]) { this.log(30, 'WARNING', args); }
  warn(...args: any[]) { this.log(30, 'WARNING', args); }
  error(...args: any[]) { this.log(40, 'ERROR', args); }
  exception(...args: any[]) { this.log(40, 'ERROR', args); }
}

const loggers = new Map<string, SimpleLogger>();
export function getLogger(name: string): SimpleLogger {
  let l = loggers.get(name);
  if (!l) {
    l = new SimpleLogger(name);
    loggers.set(name, l);
  }
  return l;
}
