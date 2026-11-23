/** JSON.stringify with sorted keys (python json.dumps(..., sort_keys=True) for identity purposes) */
export function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** python == for JSON-like values */
export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'boolean') return a === Number(b);
  if (typeof b === 'number' && typeof a === 'boolean') return b === Number(a);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x: any, i: number) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}
