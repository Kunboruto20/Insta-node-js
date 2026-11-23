/** Bounded readers for the additional-profile flow; never execute Bloks code. */
import * as Boom from '@hapi/boom';
import { boomifyError } from '../core/boomErrors';
import { deepEqual, stableStringify } from '../helpers/equality';
import { jsonDumps } from '../helpers/encoding';

export const FLOW = { flow_type: 'spc', flow_name: 'secondary_profile_creation_ig_default' };
export const DOC_ID = '356548512611906258864738750706';
export const APPS: Record<string, string> = {
  entry: 'com.bloks.www.bloks.caa.reg.spc_create_profile.async',
  username: 'com.bloks.www.bloks.caa.reg.username.async',
  optin: 'com.bloks.www.bloks.caa.reg.ac_optin.async',
  create: 'com.bloks.www.bloks.caa.reg.create.account.async',
};
const _TOKEN = /\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+/g;
const _MAX_SIZE = 2_000_000;

class SpcValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpcValueError';
    boomifyError(this, 422, { code: 'MALFORMED_RESPONSE' });
  }
}

function _json(value: any): any {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function tryJson(symbol: string): any {
  try {
    return JSON.parse(symbol);
  } catch {
    if (symbol === 'NaN') return NaN;
    if (symbol === 'Infinity') return Infinity;
    if (symbol === '-Infinity') return -Infinity;
    return symbol;
  }
}

export function _vm(text: string): any[] {
  const root: any[] = [];
  const stack: any[][] = [root];
  let count = 0;
  for (const match of text.matchAll(_TOKEN)) {
    if (count > 100_000) throw new SpcValueError('SPC token limit exceeded');
    count++;
    const symbol = match[0];
    if (symbol === '(') {
      if (stack.length >= 80) throw new SpcValueError('SPC nesting limit exceeded');
      const child: any[] = [];
      stack[stack.length - 1].push(child);
      stack.push(child);
    } else if (symbol === ')') {
      if (stack.length === 1) throw new SpcValueError('Unbalanced SPC payload');
      stack.pop();
    } else {
      stack[stack.length - 1].push(tryJson(symbol));
    }
  }
  if (stack.length !== 1) throw new SpcValueError('Unbalanced SPC payload');
  return root;
}

/** Expand JSON strings and literal VM syntax within strict resource limits. */
export function* _walk(value: any): Generator<any> {
  if (jsonDumps(value).length > _MAX_SIZE) throw new SpcValueError('SPC response too large');
  const pending: Array<[any, number]> = [[value, 0]];
  const seenStrings = new Set<string>();
  let count = 0;
  let expandedBytes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    count += 1;
    if (count > 100_000 || depth > 100) throw new SpcValueError('SPC structure limit exceeded');
    yield item;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const v of Object.values(item)) pending.push([v, depth + 1]);
    } else if (Array.isArray(item)) {
      for (const v of item) pending.push([v, depth + 1]);
    } else if (typeof item === 'string' && !seenStrings.has(item)) {
      seenStrings.add(item);
      expandedBytes += item.length;
      if (expandedBytes > 4 * _MAX_SIZE) throw new SpcValueError('SPC expansion limit exceeded');
      const stripped = item.trim();
      if (stripped.startsWith('{') || stripped.startsWith('[')) {
        let decoded: any;
        try {
          decoded = JSON.parse(stripped);
        } catch {
          continue;
        }
        pending.push([decoded, depth + 1]);
      } else if (/^\([a-zA-Z0-9_.]+[\s)]/.test(stripped)) {
        pending.push([_vm(stripped), depth + 1]);
      }
    }
  }
}

export function _literal(value: any): any {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number') return value ?? null;
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value[0] === 'f4i' &&
    Array.isArray(value[1]) &&
    Array.isArray(value[2]) &&
    value[1][0] === 'dkc' &&
    value[2][0] === 'dkc'
  ) {
    const keys = value[1].slice(1);
    const values = value[2].slice(1);
    if (keys.length !== values.length || keys.some((k: any) => typeof k !== 'string') || new Set(keys).size !== keys.length) {
      throw new SpcValueError('Malformed SPC literal map');
    }
    const out: Record<string, any> = {};
    keys.forEach((k: string, i: number) => {
      out[k] = _literal(values[i]);
    });
    return out;
  }
  throw new SpcValueError('Nonliteral SPC continuation');
}

/** Select a unique button transition, keeping its context and reg_info paired. */
export function continuation(response: any, stage: string): Record<string, any> {
  if (!['username', 'optin', 'create'].includes(stage)) throw new SpcValueError('Unknown SPC stage');
  const candidates = new Map<string, Record<string, any>>();
  for (const item of _walk(response)) {
    if (!Array.isArray(item) || item[0] !== 'f4i') continue;
    let mapping: any;
    try {
      mapping = _literal(item);
    } catch (e) {
      if (e instanceof SpcValueError) continue;
      throw e;
    }
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || !mapping.reg_context) continue;
    try {
      const regInfo = _json(mapping.reg_info ?? null);
      if (!deepEqual(_json(mapping.flow_info ?? null), FLOW) || !regInfo || typeof regInfo !== 'object' || Array.isArray(regInfo)) continue;
    } catch {
      continue;
    }
    const matches =
      (stage === 'username' && mapping.action === 1) ||
      (stage === 'optin' && mapping.is_tds_reg_flow === 0 && !('user_opted_out_of_ntp' in mapping)) ||
      (stage === 'create' && mapping.should_ignore_suma_check === 0 && mapping.app_id === 0);
    if (matches && typeof mapping.reg_context === 'string' && typeof mapping.reg_info === 'string') {
      candidates.set(stableStringify(mapping), mapping);
    }
  }
  if (candidates.size !== 1) throw new SpcValueError('Missing or ambiguous SPC continuation');
  return candidates.values().next().value!;
}

/** Read only the response's root action, excluding embedded UI templates. */
export function* _rootActions(response: any): Generator<string> {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new SpcValueError('Malformed SPC response');
  const roots: any[] = [response];
  const data = response.data ?? {};
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const item of Object.values(data) as any[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const bundle = item.action?.action_bundle?.bloks_bundle_action;
      if (bundle !== undefined && bundle !== null) roots.push(_json(bundle));
    }
  }
  for (const root of roots) {
    if (root && typeof root === 'object' && !Array.isArray(root)) {
      const action = root.layout?.bloks_payload?.action;
      if (typeof action === 'string') yield action;
    }
  }
}

/** Validate the actual registration result and its embedded session together. */
export function registration(
  response: any,
  parentId: string,
  username: string,
): [Record<string, any>, Record<string, any>, Record<string, any>, Record<string, string>] {
  if (jsonDumps(response).length > _MAX_SIZE) throw new SpcValueError('SPC response too large');
  const wrappers = new Map<string, any>();
  for (const action of _rootActions(response)) {
    for (const item of _walk(action)) {
      if (item && typeof item === 'object' && !Array.isArray(item) && 'registration_response' in item) {
        wrappers.set(stableStringify(item), item);
      }
    }
  }
  if (wrappers.size !== 1) throw new SpcValueError('Missing or ambiguous SPC registration result');
  const wrapper = wrappers.values().next().value;
  const result = _json(wrapper.registration_response);
  let headers = _json(wrapper.headers ?? null);
  if (!result || typeof result !== 'object' || Array.isArray(result) || !headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new SpcValueError('Malformed SPC registration result');
  }
  headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const user = result.created_user;
  if (result.account_created !== true || result.status !== 'ok' || !user || typeof user !== 'object' || Array.isArray(user)) {
    throw new SpcValueError('SPC creation not confirmed');
  }
  const pk = String(user.pk || user.id || '');
  if (
    !/^\d+$/.test(pk) ||
    BigInt(pk) <= 0n ||
    pk === String(parentId) ||
    (user.id !== undefined && user.id !== null && String(user.id) !== pk) ||
    String(user.username ?? '').toLowerCase() !== username.toLowerCase()
  ) {
    throw new SpcValueError('SPC returned an unexpected identity');
  }
  const authorization = headers['ig-set-authorization'] ?? '';
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer IGT:2:')) throw new SpcValueError('Missing SPC authorization');
  let auth: any;
  try {
    const b64 = authorization.slice('Bearer IGT:2:'.length);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) throw Boom.badData('Invalid base64');
    auth = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    throw new SpcValueError('Malformed SPC authorization');
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth) || String(auth.ds_user_id) !== pk || typeof auth.sessionid !== 'string' || !auth.sessionid) {
    throw new SpcValueError('SPC authorization identity mismatch');
  }
  // Use credentials from the paired token, not arbitrary cookie attributes in
  // the nested response (whose native representation is not a JSON cookie jar).
  const cookies = { sessionid: auth.sessionid, ds_user_id: pk };
  return [{ ...user, pk }, auth, headers, cookies];
}
