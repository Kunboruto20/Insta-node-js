/** JSON encoder matching instagrapi's InstagrapiJSONEncoder + dumps(separators=(",", ":")). */
function encodeValue(_key: string, value: any): any {
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** A number that python would serialize as a float (e.g. 1080.0 instead of 1080) */
export class PyFloat {
  constructor(public readonly value: number) {}
  toJSON(): number {
    return this.value;
  }
  toString(): string {
    return pyFloatString(this.value);
  }
}

/** Mark a number as a python float for JSON serialization */
export function pyFloat(n: number): PyFloat {
  return new PyFloat(Number(n));
}

export function pyFloatString(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n}.0`;
  const s = String(n);
  return s.includes('e') ? s.replace(/e\+?(-?)(\d)$/, 'e$1' + '0$2').replace('e+', 'e+') : s;
}

function prepare(value: any): any {
  if (value instanceof PyFloat) return `__PYFLOAT__${pyFloatString(value.value)}__`;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (value instanceof Set) return Array.from(value, prepare);
  if (value instanceof Map) return Object.fromEntries(Array.from(value, ([k, v]) => [k, prepare(v)]));
  if (typeof value === 'bigint') return `__PYBIGINT__${value.toString()}__`;
  if (Array.isArray(value)) return value.map(prepare);
  if (value && typeof value === 'object' && !(value instanceof URL)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = prepare(v);
    return out;
  }
  if (value instanceof URL) return value.toString();
  return value;
}

/** Python json.dumps default (ensure_ascii=True, separators=(", ", ": ")) */
export function pyJsonDumps(data: any, compact = false): string {
  const json = (JSON.stringify(prepare(data), encodeValue) ?? 'null')
    .replace(/"__PYBIGINT__(-?\d+)__"/g, '$1')
    .replace(/"__PYFLOAT__([^"_]+)__"/g, '$1');
  const ascii = json.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (compact) return ascii;
  return addPySpacing(ascii);
}

/** Insert python's default ", " and ": " separators outside of strings. */
function addPySpacing(json: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += json[++i];
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
    if (c === ',') out += ' ';
    else if (c === ':') out += ' ';
  }
  return out;
}

/** Json dumps format as required Instagram (compact separators, ensure_ascii) */
export function dumps(data: any): string {
  return pyJsonDumps(data, true);
}

/**
 * Navigate through nested dictionaries/lists using provided keys.
 */
export function jsonValue(data: any, ...args: Array<string | number | { default: any }>): any {
  let def: any = undefined;
  const last = args[args.length - 1];
  if (last && typeof last === 'object') {
    def = (last as any).default;
    args = args.slice(0, -1);
  }
  let cur: any = data;
  for (const a of args) {
    try {
      if (cur === null || cur === undefined) return def;
      if (typeof a === "number") cur = Array.isArray(cur) ? cur[a < 0 ? cur.length + a : a] : cur[a];
      else if (typeof a !== "string") return def;
      else {
        if (typeof cur !== 'object' || Array.isArray(cur)) return def;
        cur = cur[a];
      }
      if (cur === null || cur === undefined) return def;
    } catch {
      return def;
    }
  }
  return cur;
}

export function deepcopy<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return structuredClone(value);
}

/** Python repr() of JSON-like data (dict/list/str/int/float/bool/None). */
export function pyRepr(v: any): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return pyStrRepr(v);
  if (v instanceof Date) return `datetime.datetime.fromtimestamp(${v.getTime() / 1000})`;
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (typeof v === 'object') return '{' + Object.entries(v).map(([k, val]) => `${pyStrRepr(k)}: ${pyRepr(val)}`).join(', ') + '}';
  return String(v);
}

function pyFloatRepr(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf';
  const s = String(n);
  return /[.e]/.test(s) ? s.replace(/e\+?/, 'e+').replace('e+-', 'e-') : `${s}.0`;
}

export function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + quote;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + quote;
}

/** html.unescape */
export function htmlUnescape(s: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[ent.toLowerCase()] ?? m;
  });
}

/** python int(): returns number when safe, BigInt otherwise (serialized as a raw JSON number) */
export function pyInt(v: any): number | bigint {
  const b = BigInt(String(v).trim());
  return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
}
