/**
 * Tiny pydantic-v2 (lax mode, coerce_numbers_to_str=True) compatible validator.
 */
import { statSync } from 'node:fs';

export type FieldType =
  | 'str'
  | 'int'
  | 'idint'
  | 'strint'
  | 'float'
  | 'bool'
  | 'datetime'
  | 'url'
  | 'filepath'
  | 'dict'
  | 'any'
  | { list: FieldType }
  | { dict: FieldType }
  | { union: FieldType[] }
  | { literal: any[] }
  | (() => ModelSchema);

export interface FieldSpec {
  type: FieldType;
  optional?: boolean;
  default?: () => any;
}

export interface ModelSchema {
  name: string;
  base?: () => ModelSchema;
  fields: Record<string, FieldSpec>;
  /** post-processing hook (e.g. attach helper methods) */
  post?: (obj: any) => any;
}

export interface ValidationIssue {
  loc: Array<string | number>;
  msg: string;
  input?: any;
}

export class ModelValidationError extends Error {
  errors: ValidationIssue[];
  title: string;
  constructor(title: string, errors: ValidationIssue[]) {
    super(
      `${errors.length} validation error${errors.length === 1 ? '' : 's'} for ${title}\n` +
        errors.map((e) => `${e.loc.join('.')}\n  ${e.msg}${e.input !== undefined ? ` [input_value=${short(e.input)}]` : ''}`).join('\n'),
    );
    this.name = 'ValidationError';
    this.title = title;
    this.errors = errors;
  }
}

function short(v: any): string {
  try {
    const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
    return s && s.length > 80 ? s.slice(0, 77) + '...' : String(s);
  } catch {
    return String(v);
  }
}

class Fail extends Error {
  constructor(public issues: ValidationIssue[]) {
    super('fail');
  }
}

const schemaFieldsCache = new WeakMap<ModelSchema, Record<string, FieldSpec>>();

export function allFields(schema: ModelSchema): Record<string, FieldSpec> {
  let f = schemaFieldsCache.get(schema);
  if (!f) {
    f = { ...(schema.base ? allFields(schema.base()) : {}), ...schema.fields };
    schemaFieldsCache.set(schema, f);
  }
  return f;
}

const INT_RE = /^\s*[+-]?\d+\s*$/;
const NUM_RE = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;
const TRUE_SET = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_SET = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

function isPlainObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function coerce(type: FieldType, value: any, loc: Array<string | number>): any {
  if (typeof type === 'function') return parseInto(type(), value, loc);
  if (typeof type === 'object') {
    if ('list' in type) {
      let arr: any[];
      if (Array.isArray(value)) arr = value;
      else if (value instanceof Set) arr = Array.from(value);
      else throw new Fail([{ loc, msg: 'Input should be a valid list', input: value }]);
      const issues: ValidationIssue[] = [];
      const out = arr.map((item, i) => {
        try {
          return coerce(type.list, item, [...loc, i]);
        } catch (e) {
          if (e instanceof Fail) issues.push(...e.issues);
          else throw e;
          return undefined;
        }
      });
      if (issues.length) throw new Fail(issues);
      return out;
    }
    if ('dict' in type) {
      if (!isPlainObject(value)) throw new Fail([{ loc, msg: 'Input should be a valid dictionary', input: value }]);
      const out: Record<string, any> = {};
      const issues: ValidationIssue[] = [];
      for (const [k, v] of Object.entries(value)) {
        try {
          out[k] = coerce(type.dict, v, [...loc, k]);
        } catch (e) {
          if (e instanceof Fail) issues.push(...e.issues);
          else throw e;
        }
      }
      if (issues.length) throw new Fail(issues);
      return out;
    }
    if ('union' in type) {
      const issues: ValidationIssue[] = [];
      for (const t of type.union) {
        try {
          return coerce(t, value, loc);
        } catch (e) {
          if (e instanceof Fail) issues.push(...e.issues);
          else throw e;
        }
      }
      throw new Fail(issues);
    }
    if ('literal' in type) {
      if (type.literal.includes(value)) return value;
      throw new Fail([{ loc, msg: `Input should be ${type.literal.map((v) => JSON.stringify(v)).join(' or ')}`, input: value }]);
    }
  }
  switch (type) {
    case 'any':
      return value;
    case 'str':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'bigint') return value.toString();
      throw new Fail([{ loc, msg: 'Input should be a valid string', input: value }]);
    case 'strint':
      if (typeof value === 'string' || typeof value === 'number') return value;
      if (typeof value === 'bigint') return value.toString();
      throw new Fail([{ loc, msg: 'Input should be a valid string or integer', input: value }]);
    case 'idint': {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value).toString();
      if (typeof value === 'number' && Number.isFinite(value) && Math.trunc(value) === value) return String(value);
      if (typeof value === 'boolean') return value ? '1' : '0';
      if (typeof value === 'string' && INT_RE.test(value)) return BigInt(value.trim()).toString();
      throw new Fail([{ loc, msg: 'Input should be a valid integer', input: value }]);
    }
    case 'int': {
      if (typeof value === 'number') {
        if (Number.isInteger(value)) return value;
        throw new Fail([{ loc, msg: 'Input should be a valid integer, got a number with a fractional part', input: value }]);
      }
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'string' && INT_RE.test(value)) return parseInt(value, 10);
      if (typeof value === 'string' && NUM_RE.test(value) && Number.isInteger(Number(value))) return Number(value);
      throw new Fail([{ loc, msg: 'Input should be a valid integer', input: value }]);
    }
    case 'float': {
      if (typeof value === 'number') return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (typeof value === 'bigint') return Number(value);
      if (typeof value === 'string' && NUM_RE.test(value)) return Number(value);
      throw new Fail([{ loc, msg: 'Input should be a valid number', input: value }]);
    }
    case 'bool': {
      if (typeof value === 'boolean') return value;
      if (value === 0 || value === 1) return value === 1;
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (TRUE_SET.has(s)) return true;
        if (FALSE_SET.has(s)) return false;
      }
      throw new Fail([{ loc, msg: 'Input should be a valid boolean', input: value }]);
    }
    case 'datetime':
      return toDatetime(value, loc);
    case 'url': {
      if (typeof value !== 'string') throw new Fail([{ loc, msg: 'URL input should be a string or URL', input: value }]);
      let u: URL;
      try {
        u = new URL(value);
      } catch {
        throw new Fail([{ loc, msg: 'Input should be a valid URL', input: value }]);
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Fail([{ loc, msg: "URL scheme should be 'http' or 'https'", input: value }]);
      }
      if (value.length > 2083) throw new Fail([{ loc, msg: 'URL should have at most 2083 characters', input: value }]);
      // pydantic normalizes a bare host to have a trailing slash
      if (/^https?:\/\/[^/?#]+$/i.test(value)) return value + '/';
      return value;
    }
    case 'filepath': {
      const p = String(value);
      let ok = false;
      try {
        ok = statSync(p).isFile();
      } catch {
        ok = false;
      }
      if (!ok) throw new Fail([{ loc, msg: `Path does not point to a file`, input: value }]);
      return p;
    }
    case 'dict':
      if (isPlainObject(value)) return value;
      throw new Fail([{ loc, msg: 'Input should be a valid dictionary', input: value }]);
    default:
      return value;
  }
}

function toDatetime(value: any, loc: Array<string | number>): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Fail([{ loc, msg: 'Input should be a valid datetime', input: value }]);
    return value;
  }
  let num: number | null = null;
  if (typeof value === 'number') num = value;
  else if (typeof value === 'bigint') num = Number(value);
  else if (typeof value === 'string' && NUM_RE.test(value)) num = Number(value);
  if (num !== null) {
    // pydantic: values > 2e10 are treated as milliseconds (and > 2e13 as microseconds etc.)
    let seconds = num;
    while (Math.abs(seconds) > 2e10) seconds /= 1000;
    return new Date(seconds * 1000);
  }
  if (typeof value === 'string') {
    const t = Date.parse(value.includes('T') || /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value.replace(' ', 'T'));
    if (!Number.isNaN(t)) return new Date(t);
  }
  throw new Fail([{ loc, msg: 'Input should be a valid datetime', input: value }]);
}

function parseInto(schema: ModelSchema, data: any, loc: Array<string | number>): any {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    // pydantic accepts model instances / dicts only
    throw new Fail([{ loc, msg: `Input should be a valid dictionary or instance of ${schema.name}`, input: data }]);
  }
  const fields = allFields(schema);
  const out: Record<string, any> = {};
  const issues: ValidationIssue[] = [];
  for (const [name, spec] of Object.entries(fields)) {
    const has = Object.prototype.hasOwnProperty.call(data, name) && data[name] !== undefined;
    let value = has ? data[name] : undefined;
    if (!has) {
      if (spec.default) {
        out[name] = spec.default();
        continue;
      }
      issues.push({ loc: [...loc, name], msg: 'Field required', input: undefined });
      continue;
    }
    if (value === null) {
      if (spec.optional) {
        out[name] = null;
        continue;
      }
      if (spec.type === 'any') {
        out[name] = null;
        continue;
      }
    }
    try {
      out[name] = coerce(spec.type, value, [...loc, name]);
    } catch (e) {
      if (e instanceof Fail) issues.push(...e.issues);
      else throw e;
    }
  }
  if (issues.length) throw new Fail(issues);
  return schema.post ? schema.post(out) : out;
}

/** Validate and coerce `data` into the model described by `schema` (like `Model(**data)`). */
export function parseModel<T>(schema: ModelSchema, data: Record<string, any>): T {
  try {
    return parseInto(schema, data, []) as T;
  } catch (e) {
    if (e instanceof Fail) throw new ModelValidationError(schema.name, e.issues);
    throw e;
  }
}

/** model_copy(update=...) */
export function modelCopy<T extends object>(obj: T, update: Partial<T> = {}): T {
  return Object.assign(Object.create(Object.getPrototypeOf(obj)), structuredClone({ ...obj }), update);
}
