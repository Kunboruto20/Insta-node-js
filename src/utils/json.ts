/**
 * JSON.parse that keeps integers outside Number's safe range as strings.
 *
 * Python's json module parses arbitrarily large integers exactly; JavaScript's JSON.parse
 * silently rounds them (e.g. media ids like 3123456789012345678). This pre-pass quotes such
 * integer literals (outside of strings) before parsing.
 */
export function parseJson(text: string): any {
  if (!/\d{16}/.test(text)) return JSON.parse(text);
  return JSON.parse(quoteBigInts(text));
}

export function quoteBigInts(text: string): string {
  let out = '';
  let last = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */) {
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92 /* \ */) i += 2;
        else if (d === 34) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (c === 45 /* - */ || (c >= 48 && c <= 57)) {
      const start = i;
      if (c === 45) i++;
      while (i < n && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
      const next = i < n ? text.charCodeAt(i) : 0;
      const isFloat = next === 46 /* . */ || next === 101 || next === 69; /* e E */
      if (isFloat) {
        while (i < n && /[0-9eE.+-]/.test(text[i])) i++;
        continue;
      }
      const digits = i - start - (c === 45 ? 1 : 0);
      if (digits >= 16) {
        const literal = text.slice(start, i);
        if (!Number.isSafeInteger(Number(literal))) {
          out += text.slice(last, start) + '"' + literal + '"';
          last = i;
        }
      }
      continue;
    }
    i++;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * json.JSONDecoder().raw_decode for values starting at `s[0]` (strings, numbers, literals, objects, arrays).
 * Returns [value, consumedLength] or throws SyntaxError.
 */
export function rawDecode(s: string): [any, number] {
  const end = scanJsonValue(s, 0);
  if (end < 0) throw new SyntaxError('Expecting value');
  return [JSON.parse(s.slice(0, end)), end];
}

function skipWs(s: string, i: number): number {
  while (i < s.length && ' \t\n\r'.includes(s[i])) i++;
  return i;
}

function scanJsonValue(s: string, i: number): number {
  const c = s[i];
  if (c === '"') {
    i++;
    while (i < s.length) {
      const d = s[i];
      if (d === '\\') i += 2;
      else if (d === '"') return i + 1;
      else if (d < ' ') return -1;
      else i++;
    }
    return -1;
  }
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    i = skipWs(s, i + 1);
    if (s[i] === close) return i + 1;
    while (i < s.length) {
      if (c === '{') {
        if (s[i] !== '"') return -1;
        i = scanJsonValue(s, i);
        if (i < 0) return -1;
        i = skipWs(s, i);
        if (s[i] !== ':') return -1;
        i = skipWs(s, i + 1);
      }
      i = scanJsonValue(s, i);
      if (i < 0) return -1;
      i = skipWs(s, i);
      if (s[i] === ',') i = skipWs(s, i + 1);
      else if (s[i] === close) return i + 1;
      else return -1;
    }
    return -1;
  }
  const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(s.slice(i, i + 400));
  return m ? i + m[0].length : -1;
}

/** http.cookies.SimpleCookie().load(text) → {name: value} */
export function simpleCookieLoad(text: string): Record<string, string> {
  const pattern =
    /\s*([\w\d!#%&'~_`><@,:/$*+\-.^|)(?}{=]+?)(\s*=\s*("(?:[^\\"]|\\.)*"|\w{3},\s[\w\d\s-]{9,11}\s[\d:]{8}\sGMT|[\w\d!#%&'~_`><@,:/$*+\-.^|)(?}{=[\]]*))?\s*(\s+|;|$)/y;
  const reserved = new Set(['expires', 'path', 'comment', 'domain', 'max-age', 'secure', 'httponly', 'version', 'samesite', 'partitioned']);
  const flags = new Set(['secure', 'httponly', 'partitioned']);
  const out: Record<string, string> = {};
  let i = 0;
  let current: string | null = null;
  const n = text.length;
  while (i >= 0 && i < n) {
    pattern.lastIndex = i;
    const m = pattern.exec(text);
    if (!m) break;
    const [, key, hasEq, rawVal] = m;
    i = pattern.lastIndex;
    if (m[0].length === 0) break;
    if (key[0] === '$') {
      if (!current) continue;
      continue;
    }
    if (reserved.has(key.toLowerCase())) {
      if (!current) return out; // invalid cookie string
      if (rawVal === undefined && !flags.has(key.toLowerCase())) return out;
      continue;
    }
    if (rawVal === undefined && !hasEq) return out;
    let val = rawVal ?? '';
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\(\d{3}|.)/g, (_, g: string) => (g.length === 3 ? String.fromCharCode(parseInt(g, 8)) : g));
    }
    out[key] = val;
    current = key;
  }
  return out;
}
