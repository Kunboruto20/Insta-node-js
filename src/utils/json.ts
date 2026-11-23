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
