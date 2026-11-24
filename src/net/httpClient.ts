/**
 * HTTP session built on undici.
 *
 * Features used by the library: persistent case-insensitive headers, a cookie jar
 * (domain-less cookies are sent to every host),
 * http(s)/socks proxies, TLS verification toggle or custom CA, retry
 * strategy, redirects, gzip/deflate/br decoding, and HTTP/2 (used by the
 * "http2"/"mobile" transports).
 */
import { boomifyError } from '../core/boomErrors';
import { readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';
import { Agent, Dispatcher, ProxyAgent, buildConnector, request as undiciRequest } from 'undici';
import { SocksClient, SocksProxy } from 'socks';
import { parseJson } from '../helpers/bigJson';

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotli = promisify(zlib.brotliDecompress);

// ---------------------------------------------------------------- errors

/** Base transport error (Boom: HTTP status of the response when >= 400, otherwise the class status). */
export class RequestException extends Error {
  static statusCode = 502;
  response: Response | null;
  request: PreparedRequest | null;
  constructor(message: string, opts: { response?: Response | null; request?: PreparedRequest | null; cause?: unknown } = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.response = opts.response ?? null;
    this.request = opts.request ?? opts.response?.request ?? null;
    const responseStatus = this.response?.status_code;
    const status = typeof responseStatus === 'number' && responseStatus >= 400 ? responseStatus : (new.target as any).statusCode;
    boomifyError(this, status);
  }
}
export class HTTPError extends RequestException {}
export class ConnectionError extends RequestException {
  static statusCode = 503;
}
export class ProxyError extends ConnectionError {}
export class SSLError extends ConnectionError {}
export class Timeout extends RequestException {
  static statusCode = 504;
}
export class ConnectTimeout extends ConnectionError {
  static statusCode = 504;
}
export class ReadTimeout extends Timeout {}
export class ChunkedEncodingError extends RequestException {}
export class TooManyRedirects extends RequestException {}
export class JSONDecodeError extends Error {
  doc: string;
  constructor(message: string, doc: string) {
    super(message);
    this.name = 'JSONDecodeError';
    this.doc = doc;
    boomifyError(this, 502, { code: 'MALFORMED_RESPONSE' });
  }
}

// ---------------------------------------------------------------- headers

export class CaseInsensitiveDict {
  private store = new Map<string, [string, string]>();

  constructor(init?: Record<string, any> | CaseInsensitiveDict | null) {
    if (init) this.update(init);
  }
  set(key: string, value: any): void {
    this.store.set(key.toLowerCase(), [key, value === undefined || value === null ? '' : String(value)]);
  }
  get(key: string, def?: string): string | undefined {
    const v = this.store.get(key.toLowerCase());
    return v ? v[1] : def;
  }
  has(key: string): boolean {
    return this.store.has(key.toLowerCase());
  }
  pop(key: string, def?: string): string | undefined {
    const v = this.store.get(key.toLowerCase());
    this.store.delete(key.toLowerCase());
    return v ? v[1] : def;
  }
  delete(key: string): void {
    this.store.delete(key.toLowerCase());
  }
  update(other: Record<string, any> | CaseInsensitiveDict | null | undefined): void {
    if (!other) return;
    if (other instanceof CaseInsensitiveDict) {
      for (const [k, v] of other.items()) this.set(k, v);
    } else {
      for (const [k, v] of Object.entries(other)) if (v !== undefined) this.set(k, v);
    }
  }
  keys(): string[] {
    return Array.from(this.store.values(), ([k]) => k);
  }
  items(): Array<[string, string]> {
    return Array.from(this.store.values());
  }
  clear(): void {
    this.store.clear();
  }
  toObject(): Record<string, string> {
    return Object.fromEntries(this.items());
  }
  copy(): CaseInsensitiveDict {
    return new CaseInsensitiveDict(this);
  }
  [Symbol.iterator]() {
    return this.keys()[Symbol.iterator]();
  }
}

// ---------------------------------------------------------------- cookies

export interface Cookie {
  name: string;
  value: string;
  domain: string; // '' means "any domain"
  path: string;
  expires?: number | null; // unix seconds
  secure?: boolean;
  hostOnly?: boolean;
}

export class CookieJar {
  private cookies: Cookie[] = [];

  static fromDict(dict: Record<string, any> | null | undefined): CookieJar {
    const jar = new CookieJar();
    for (const [k, v] of Object.entries(dict || {})) jar.set(k, v);
    return jar;
  }

  set(name: string, value: any, opts: { domain?: string; path?: string; expires?: number | null; secure?: boolean } = {}): void {
    const domain = (opts.domain || '').replace(/^\./, '').toLowerCase();
    const path = opts.path || '/';
    this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain && c.path === path));
    if (value === null || value === undefined) return;
    this.cookies.push({ name, value: String(value), domain, path, expires: opts.expires ?? null, secure: opts.secure });
  }

  /** Get a cookie value by name, or `def` when missing */
  get(name: string, def?: string): string | undefined {
    this.purgeExpired();
    let found: Cookie | undefined;
    for (const c of this.cookies) if (c.name === name) found = c;
    return found ? found.value : def;
  }

  delete(name: string): void {
    this.cookies = this.cookies.filter((c) => c.name !== name);
  }

  clear(): void {
    this.cookies = [];
  }

  getDict(): Record<string, string> {
    this.purgeExpired();
    const out: Record<string, string> = {};
    for (const c of this.cookies) out[c.name] = c.value;
    return out;
  }

  /** alias of toDict() */
  get_dict(): Record<string, string> {
    return this.getDict();
  }

  update(dict: Record<string, any>): void {
    for (const [k, v] of Object.entries(dict)) this.set(k, v);
  }

  all(): Cookie[] {
    this.purgeExpired();
    return this.cookies.map((c) => ({ ...c }));
  }

  private purgeExpired() {
    const now = Date.now() / 1000;
    this.cookies = this.cookies.filter((c) => !c.expires || c.expires > now);
  }

  /** Build the Cookie header for a URL */
  headerFor(url: URL): string {
    this.purgeExpired();
    const host = url.hostname.toLowerCase();
    const parts: string[] = [];
    const seen = new Map<string, number>();
    for (const c of this.cookies) {
      if (c.domain) {
        if (c.hostOnly ? host !== c.domain : !(host === c.domain || host.endsWith('.' + c.domain))) continue;
      }
      if (!url.pathname.startsWith(c.path)) continue;
      if (c.secure && url.protocol !== 'https:') continue;
      const pair = `${c.name}=${c.value}`;
      if (seen.has(c.name)) parts[seen.get(c.name)!] = pair;
      else {
        seen.set(c.name, parts.length);
        parts.push(pair);
      }
    }
    return parts.join('; ');
  }

  /** Store Set-Cookie headers from a response */
  storeFromHeaders(url: URL, setCookies: string[]): void {
    for (const header of setCookies) {
      const parsed = parseSetCookie(header, url);
      if (!parsed) continue;
      this.cookies = this.cookies.filter(
        (c) => !(c.name === parsed.name && (c.domain === parsed.domain || c.domain === '') && c.path === parsed.path),
      );
      if (parsed.expires !== null && parsed.expires !== undefined && parsed.expires <= Date.now() / 1000) continue;
      this.cookies.push(parsed);
    }
  }
}

function parseSetCookie(header: string, url: URL): Cookie | null {
  const segments = header.split(';');
  const first = segments.shift();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  let value = first.slice(eq + 1).trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  const cookie: Cookie = { name, value, domain: url.hostname.toLowerCase(), path: '/', expires: null, hostOnly: true };
  let defaultPath = url.pathname.replace(/\/[^/]*$/, '') || '/';
  cookie.path = defaultPath;
  for (const seg of segments) {
    const i = seg.indexOf('=');
    const key = (i < 0 ? seg : seg.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : seg.slice(i + 1).trim();
    if (key === 'domain' && val) {
      cookie.domain = val.replace(/^\./, '').toLowerCase();
      cookie.hostOnly = false;
    } else if (key === 'path' && val) cookie.path = val;
    else if (key === 'max-age') {
      const n = parseInt(val, 10);
      if (!Number.isNaN(n)) cookie.expires = Date.now() / 1000 + n;
    } else if (key === 'expires' && cookie.expires === null) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) cookie.expires = t / 1000;
    } else if (key === 'secure') cookie.secure = true;
  }
  return cookie;
}

// ---------------------------------------------------------------- request / response

export type Params = Record<string, any> | Array<[string, any]> | string | null | undefined;
export type Body = string | Buffer | Uint8Array | Record<string, any> | null | undefined;

export interface PreparedRequest {
  method: string;
  url: string;
  headers: CaseInsensitiveDict;
  body: string | Buffer | null;
}

export class Response {
  status_code = 0;
  reason = '';
  headers = new CaseInsensitiveDict();
  url = '';
  content: Buffer = Buffer.alloc(0);
  request!: PreparedRequest;
  history: Response[] = [];
  http_version = '1.1';
  elapsed = 0;
  /** raw number of (decoded) bytes received */
  rawLength = 0;
  /** header: Set-Cookie values */
  setCookies: string[] = [];

  get text(): string {
    return this.content.toString('utf8');
  }
  get ok(): boolean {
    return this.status_code < 400;
  }
  /** Parsed cookies set by this response */
  get cookies(): Record<string, string> {
    const jar = new CookieJar();
    jar.storeFromHeaders(new URL(this.url), this.setCookies);
    return jar.getDict();
  }
  json(): any {
    const text = this.text;
    try {
      return parseJson(text);
    } catch (e: any) {
      throw new JSONDecodeError(`${e.message}`, text);
    }
  }
  raise_for_status(): void {
    let msg = '';
    if (this.status_code >= 400 && this.status_code < 500) msg = `${this.status_code} Client Error: ${this.reason} for url: ${this.url}`;
    else if (this.status_code >= 500 && this.status_code < 600) msg = `${this.status_code} Server Error: ${this.reason} for url: ${this.url}`;
    if (msg) throw new HTTPError(msg, { response: this });
  }
  /** alias */
  raiseForStatus(): void {
    this.raise_for_status();
  }
}

export interface RequestOptions {
  params?: Params;
  data?: Body;
  json?: any;
  headers?: Record<string, any> | CaseInsensitiveDict | null;
  allowRedirects?: boolean;
  timeout?: number | [number, number] | null;
  proxies?: Proxies;
}

export interface Proxies {
  http?: string;
  https?: string;
  all?: string;
}

export type Transport = 'http1' | 'http2' | 'mobile' | 'impersonate';

/**
 * Default JA3 for the "impersonate" transport: a modern Chrome-on-Android
 * BoringSSL ClientHello. The official app's handshake is BoringSSL-based, so
 * this is far closer to it than Node's own OpenSSL fingerprint. Override it
 * with a captured value for an exact match.
 */
export const DEFAULT_IMPERSONATE_JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,' +
  '0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';

/** Minimal shape of the lazily-loaded cycletls instance we rely on. */
interface CycleTLSClient {
  (url: string, config: Record<string, any>, method: string): Promise<{ status: number; body: string; headers: Record<string, any>; finalUrl?: string }>;
  exit(): Promise<void>;
}

export interface RetryConfig {
  total: number;
  statusForcelist: number[];
  backoffFactor: number;
  allowedMethods: string[];
}

const STATUS_REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 413: 'Payload Too Large', 429: 'Too Many Requests', 500: 'Internal Server Error',
  502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/** URL-encode a form (arrays become repeated keys, spaces become '+') */
export function urlencode(params: Params): string {
  if (!params) return '';
  if (typeof params === 'string') return params;
  const pairs: Array<[string, any]> = Array.isArray(params) ? params : Object.entries(params);
  const out: string[] = [];
  for (const [k, v] of pairs) {
    if (v === undefined || v === null) continue;
    const values = Array.isArray(v) ? v : [v];
    for (const item of values) {
      out.push(`${qp(k)}=${qp(textValue(item))}`);
    }
  }
  return out.join('&');
}

function textValue(v: any): string {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return String(v);
}

function qp(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host']);

/**
 * Undici connector that opens the TCP connection through a SOCKS4/5 proxy, then lets undici
 * perform the TLS handshake (ALPN, HTTP/2) on top of the tunnelled socket.
 */
function socksConnector(proxy: SocksProxy, tlsOptions: Record<string, any>): buildConnector.connector {
  const tlsConnect = buildConnector(tlsOptions as buildConnector.BuildOptions);
  const timeout = typeof tlsOptions.timeout === 'number' ? tlsOptions.timeout : 10_000;
  return (options, callback) => {
    const port = options.port ? Number.parseInt(options.port, 10) : options.protocol === 'http:' ? 80 : 443;
    SocksClient.createConnection({
      command: 'connect',
      proxy,
      timeout,
      destination: { host: options.hostname, port },
    }).then(
      ({ socket }) => {
        if (options.protocol !== 'https:') {
          callback(null, socket.setNoDelay());
          return;
        }
        tlsConnect({ ...options, httpSocket: socket } as any, callback);
      },
      (error: Error) => callback(error, null),
    );
  };
}

export class Session {
  headers = new CaseInsensitiveDict({
    'User-Agent': 'insta-node-js',
    'Accept-Encoding': 'gzip, deflate',
    Accept: '*/*',
    Connection: 'keep-alive',
  });
  cookies = new CookieJar();
  proxies: Proxies = {};
  verify: boolean | string = true;
  transport: Transport = 'http1';
  /** When true, always present a mobile-app-like TLS 1.3-only ClientHello, even on the http1 transport. */
  mobileTls = false;
  retry: RetryConfig = { total: 3, statusForcelist: [429, 500, 502, 503, 504], backoffFactor: 2, allowedMethods: ['GET', 'POST'] };
  maxRedirects = 30;
  /** browser profile name used by the public "http2" transport */
  impersonate?: string;
  /** JA3 presented by the "impersonate" transport (defaults to a Chrome-on-Android ClientHello) */
  impersonateJa3: string = DEFAULT_IMPERSONATE_JA3;
  /** optional explicit HTTP/2 settings fingerprint for the "impersonate" transport */
  impersonateHttp2?: string;

  private dispatchers = new Map<string, Dispatcher>();
  private cycleTls: Promise<CycleTLSClient> | null = null;

  mount(transport: Transport, retry?: Partial<RetryConfig>): void {
    this.transport = transport;
    if (retry) this.retry = { ...this.retry, ...retry };
    if (transport !== 'http1') this.retry = { ...this.retry, total: 0 };
    this.closeDispatchers();
  }

  close(): void {
    this.closeDispatchers();
    if (this.cycleTls) {
      const pending = this.cycleTls;
      this.cycleTls = null;
      pending.then((c) => c.exit()).catch(() => undefined);
    }
  }

  private closeDispatchers() {
    for (const d of this.dispatchers.values()) d.close().catch(() => undefined);
    this.dispatchers.clear();
  }

  private tlsOptions(): Record<string, any> {
    const opts: Record<string, any> = {};
    if (this.verify === false) opts.rejectUnauthorized = false;
    else if (typeof this.verify === 'string') {
      try {
        if (statSync(this.verify).isFile()) opts.ca = readFileSync(this.verify);
      } catch {
        /* ignore unreadable CA path */
      }
    }
    if (this.mobileTls || this.transport === 'http2' || this.transport === 'mobile') {
      // Mobile-like ClientHello: TLS 1.3 only with modern groups, matching the official app's handshake.
      opts.minVersion = 'TLSv1.3';
      opts.maxVersion = 'TLSv1.3';
      opts.ecdhCurve = this.transport === 'mobile' ? 'X25519' : 'X25519MLKEM768:X25519:P-256:P-384';
      opts.ALPNProtocols = this.transport === 'http1' ? ['http/1.1'] : ['h2'];
    }
    return opts;
  }

  private getDispatcher(proxyUrl: string | undefined): Dispatcher {
    const tls = this.tlsOptions();
    const key = `${proxyUrl || 'direct'}|${this.transport}|${JSON.stringify({ ...tls, ca: tls.ca ? 'ca' : undefined })}`;
    let d = this.dispatchers.get(key);
    if (d) return d;
    const allowH2 = this.transport !== 'http1';
    const common = { allowH2, keepAliveTimeout: 30_000, connections: 32 } as any;
    if (proxyUrl) {
      const scheme = proxyUrl.split(':', 1)[0].toLowerCase();
      if (scheme.startsWith('socks')) {
        const u = new URL(proxyUrl);
        d = new Agent({
          ...common,
          connect: socksConnector(
            {
              type: scheme.startsWith('socks4') ? 4 : 5,
              host: u.hostname.replace(/^\[|\]$/g, ''),
              port: Number(u.port || 1080),
              userId: u.username ? decodeURIComponent(u.username) : undefined,
              password: u.password ? decodeURIComponent(u.password) : undefined,
            },
            { ...tls, allowH2 },
          ),
        });
      } else {
        d = new ProxyAgent({ uri: proxyUrl, requestTls: tls as any, proxyTls: this.verify === false ? { rejectUnauthorized: false } : undefined, ...common });
      }
    } else {
      d = new Agent({ connect: tls as any, ...common });
    }
    this.dispatchers.set(key, d!);
    return d!;
  }

  private selectProxy(url: URL, proxies?: Proxies): string | undefined {
    const p = proxies || this.proxies || {};
    const scheme = url.protocol.replace(':', '');
    return (p as any)[scheme] || p.all || undefined;
  }

  prepare(method: string, url: string, opts: RequestOptions = {}): PreparedRequest {
    const headers = this.headers.copy();
    if (opts.headers) {
      const extra = opts.headers instanceof CaseInsensitiveDict ? opts.headers.toObject() : opts.headers;
      for (const [k, v] of Object.entries(extra)) {
        if (v === null || v === undefined) headers.delete(k);
        else headers.set(k, v);
      }
    }
    let full = url;
    const qs = urlencode(opts.params);
    if (qs) full += (full.includes('?') ? '&' : '?') + qs;
    let body: string | Buffer | null = null;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    } else if (opts.data !== undefined && opts.data !== null) {
      if (typeof opts.data === 'string') body = opts.data;
      else if (Buffer.isBuffer(opts.data)) body = opts.data;
      else if (opts.data instanceof Uint8Array) body = Buffer.from(opts.data);
      else {
        body = urlencode(opts.data as Record<string, any>);
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/x-www-form-urlencoded');
      }
    }
    return { method: method.toUpperCase(), url: full, headers, body };
  }

  async request(method: string, url: string, opts: RequestOptions = {}): Promise<Response> {
    const prepared = this.prepare(method, url, opts);
    const allowRedirects = opts.allowRedirects ?? true;
    const history: Response[] = [];
    let current = prepared;
    for (let hop = 0; ; hop++) {
      const resp = await this.sendWithRetry(current, opts);
      if (!allowRedirects || ![301, 302, 303, 307, 308].includes(resp.status_code) || !resp.headers.get('location')) {
        resp.history = history;
        return resp;
      }
      if (hop >= this.maxRedirects) throw new TooManyRedirects(`Exceeded ${this.maxRedirects} redirects.`, { response: resp });
      history.push(resp);
      const next = new URL(resp.headers.get('location')!, current.url).toString();
      let method2 = current.method;
      let body = current.body;
      const headers = current.headers.copy();
      if (resp.status_code === 303 && method2 !== 'HEAD') method2 = 'GET';
      if ((resp.status_code === 302 || resp.status_code === 301) && method2 === 'POST') method2 = 'GET';
      if (method2 === 'GET' && current.method !== 'GET') {
        body = null;
        headers.delete('Content-Type');
        headers.delete('Content-Length');
      }
      if (new URL(next).host !== new URL(current.url).host) {
        headers.delete('Authorization');
        headers.delete('Host');
      }
      current = { method: method2, url: next, headers, body };
    }
  }

  private async sendWithRetry(req: PreparedRequest, opts: RequestOptions): Promise<Response> {
    const retryable = this.retry.allowedMethods.includes(req.method);
    let attempt = 0;
    while (true) {
      let resp: Response;
      try {
        resp = await this.send(req, opts);
      } catch (e) {
        if (retryable && attempt < this.retry.total && e instanceof ConnectionError && !(e instanceof ProxyError)) {
          attempt++;
          await this.backoff(attempt, null);
          continue;
        }
        throw e;
      }
      if (retryable && attempt < this.retry.total && this.retry.statusForcelist.includes(resp.status_code)) {
        attempt++;
        await this.backoff(attempt, resp);
        continue;
      }
      return resp;
    }
  }

  private async backoff(attempt: number, resp: Response | null) {
    let wait = 0;
    const retryAfter = resp?.headers.get('retry-after');
    if (retryAfter && resp && [413, 429, 503].includes(resp.status_code)) {
      const n = Number(retryAfter);
      wait = Number.isFinite(n) ? n : Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000);
    } else if (attempt > 1) {
      wait = Math.min(120, this.retry.backoffFactor * 2 ** (attempt - 1));
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000));
  }

  async send(req: PreparedRequest, opts: RequestOptions = {}): Promise<Response> {
    if (this.transport === 'impersonate') return this.sendViaCycleTLS(req, opts);
    const url = new URL(req.url);
    const proxyUrl = this.selectProxy(url, opts.proxies);
    const dispatcher = this.getDispatcher(proxyUrl);
    const headers: Record<string, string> = {};
    let hostOverride: string | undefined;
    for (const [k, v] of req.headers.items()) {
      const lower = k.toLowerCase();
      if (lower === 'host') {
        if (v && v !== url.host) hostOverride = v;
        continue;
      }
      if (this.transport !== 'http1' && HOP_BY_HOP.has(lower)) continue;
      if (lower === 'connection' || lower === 'keep-alive') continue;
      headers[k] = v;
    }
    if (hostOverride && this.transport === 'http1') headers.host = hostOverride;
    const cookieHeader = this.cookies.headerFor(url);
    if (cookieHeader && !req.headers.has('Cookie')) headers.cookie = cookieHeader;
    if (req.body !== null && req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body));
    else if (req.method === 'POST' || req.method === 'PUT') headers['content-length'] = '0';

    let connectTimeout: number | undefined;
    let readTimeout: number | undefined;
    if (Array.isArray(opts.timeout)) [connectTimeout, readTimeout] = opts.timeout;
    else if (typeof opts.timeout === 'number') connectTimeout = readTimeout = opts.timeout;

    const started = Date.now();
    let res: Dispatcher.ResponseData;
    try {
      res = await undiciRequest(url, {
        method: req.method as any,
        headers,
        body: req.body ?? undefined,
        dispatcher,
        headersTimeout: readTimeout ? readTimeout * 1000 : 300_000,
        bodyTimeout: readTimeout ? readTimeout * 1000 : 300_000,
        maxRedirections: 0,
      } as any);
    } catch (e: any) {
      throw mapNetworkError(e, req, connectTimeout);
    }
    let raw: Buffer;
    try {
      raw = Buffer.from(await res.body.arrayBuffer());
    } catch (e: any) {
      throw new ChunkedEncodingError(`Connection broken: ${e?.message || e}`, { request: req, cause: e });
    }
    const response = new Response();
    response.request = req;
    response.url = req.url;
    response.status_code = res.statusCode;
    response.reason = STATUS_REASONS[res.statusCode] || '';
    response.elapsed = (Date.now() - started) / 1000;
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      if (k.toLowerCase() === 'set-cookie') {
        response.setCookies = Array.isArray(v) ? v : [v];
        response.headers.set(k, response.setCookies.join(', '));
      } else response.headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    response.rawLength = raw.length;
    const encoding = (response.headers.get('content-encoding') || '').toLowerCase().trim();
    try {
      if (encoding === 'gzip' || encoding === 'x-gzip') response.content = await gunzip(raw);
      else if (encoding === 'deflate') {
        try {
          response.content = await inflate(raw);
        } catch {
          response.content = await inflateRaw(raw);
        }
      } else if (encoding === 'br') response.content = await brotli(raw);
      else response.content = raw;
    } catch (e: any) {
      throw new ChunkedEncodingError(`Received response with content-encoding: ${encoding}, but failed to decode it.`, {
        request: req,
        cause: e,
      });
    }
    if (response.setCookies.length) this.cookies.storeFromHeaders(url, response.setCookies);
    return response;
  }

  private loadCycleTLS(): Promise<CycleTLSClient> {
    if (this.cycleTls) return this.cycleTls;
    this.cycleTls = (async () => {
      let initCycleTLS: (opts?: Record<string, any>) => Promise<CycleTLSClient>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        initCycleTLS = require('cycletls');
      } catch {
        throw new ConnectionError(
          "The 'impersonate' transport needs the optional 'cycletls' package. Install it with: npm install cycletls",
        );
      }
      return initCycleTLS();
    })();
    this.cycleTls.catch(() => {
      this.cycleTls = null;
    });
    return this.cycleTls;
  }

  private async sendViaCycleTLS(req: PreparedRequest, opts: RequestOptions): Promise<Response> {
    const url = new URL(req.url);
    const proxyUrl = this.selectProxy(url, opts.proxies);
    const headers: Record<string, string> = {};
    let userAgent = '';
    for (const [k, v] of req.headers.items()) {
      const lower = k.toLowerCase();
      if (lower === 'host' || lower === 'connection' || lower === 'keep-alive' || lower === 'content-length') continue;
      if (lower === 'user-agent') userAgent = v;
      headers[k] = v;
    }
    const cookieHeader = this.cookies.headerFor(url);
    if (cookieHeader && !req.headers.has('Cookie')) headers.Cookie = cookieHeader;

    let readTimeout: number | undefined;
    if (Array.isArray(opts.timeout)) readTimeout = opts.timeout[1];
    else if (typeof opts.timeout === 'number') readTimeout = opts.timeout;

    const body = req.body === null || req.body === undefined ? '' : typeof req.body === 'string' ? req.body : req.body.toString('utf8');
    const config: Record<string, any> = {
      headers,
      body,
      ja3: this.impersonateJa3,
      userAgent,
      disableRedirect: true,
      insecureSkipVerify: this.verify === false,
      timeout: readTimeout ?? 300,
    };
    if (this.impersonateHttp2) config.http2Fingerprint = this.impersonateHttp2;
    if (proxyUrl) config.proxy = proxyUrl;

    const client = await this.loadCycleTLS();
    const started = Date.now();
    let res: { status: number; body: string; headers: Record<string, any>; finalUrl?: string };
    try {
      res = await client(req.url, config, req.method.toLowerCase());
    } catch (e: any) {
      throw mapNetworkError(e, req);
    }
    if (res.status === 408) throw new ReadTimeout(`cycletls timeout: ${res.body || ''}`, { request: req });
    if (res.status === 0) throw new ConnectionError(`cycletls connection failed: ${res.body || ''}`, { request: req });

    const response = new Response();
    response.request = req;
    response.url = res.finalUrl || req.url;
    response.status_code = res.status;
    response.reason = STATUS_REASONS[res.status] || '';
    response.elapsed = (Date.now() - started) / 1000;
    const setCookies: string[] = [];
    for (const [k, v] of Object.entries(res.headers || {})) {
      if (v === undefined || v === null) continue;
      if (k.toLowerCase() === 'set-cookie') {
        const list = Array.isArray(v) ? (v as string[]) : splitSetCookie(String(v));
        setCookies.push(...list);
        response.headers.set(k, setCookies.join(', '));
      } else response.headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    }
    response.setCookies = setCookies;
    // cycletls already decompresses the body and returns it as text.
    response.content = Buffer.from(res.body ?? '', 'utf8');
    response.rawLength = response.content.length;
    if (setCookies.length) this.cookies.storeFromHeaders(url, setCookies);
    return response;
  }

  get(url: string, opts: RequestOptions = {}) {
    return this.request('GET', url, opts);
  }
  post(url: string, opts: RequestOptions = {}) {
    return this.request('POST', url, opts);
  }
  head(url: string, opts: RequestOptions = {}) {
    return this.request('HEAD', url, { allowRedirects: false, ...opts });
  }
  put(url: string, opts: RequestOptions = {}) {
    return this.request('PUT', url, opts);
  }
  delete(url: string, opts: RequestOptions = {}) {
    return this.request('DELETE', url, opts);
  }
}

/** Split a comma-joined Set-Cookie header, keeping commas that belong inside Expires dates. */
function splitSetCookie(header: string): string[] {
  return header.split(/,(?=\s*[^;,\s]+=)/).map((s) => s.trim()).filter(Boolean);
}

function mapNetworkError(e: any, req: PreparedRequest, connectTimeout?: number): Error {
  const code = e?.code || e?.cause?.code || '';
  const msg = `${e?.name || 'Error'}: ${e?.message || e}${code ? ` (${code})` : ''}`;
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return new ReadTimeout(msg, { request: req, cause: e });
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return new ConnectTimeout(msg, { request: req, cause: e });
  if (/proxy/i.test(msg)) return new ProxyError(msg, { request: req, cause: e });
  if (/certificate|SSL|TLS/i.test(msg)) return new SSLError(msg, { request: req, cause: e });
  void connectTimeout;
  return new ConnectionError(msg, { request: req, cause: e });
}

/** One-off request helper: `request('GET', url, ...)` */
const defaultSession = new Session();
export function get(url: string, opts: RequestOptions = {}): Promise<Response> {
  return defaultSession.get(url, opts);
}
