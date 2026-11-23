import * as config from '../core/defaults';
import {
  ChallengeRequired,
  ClientBadRequestError,
  ClientConnectionError,
  ClientError,
  ClientForbiddenError,
  ClientGraphqlError,
  ClientJSONDecodeError,
  ClientLoginRequired,
  ClientNotFoundError,
  ClientThrottledError,
  ClientUnauthorizedError,
  FeedbackRequired,
  LoginRequired,
  PrivateAccount,
  RateLimitError,
  SentryBlock,
  UserNotFound,
} from '../core/errorClasses';
import { ConnectionError, HTTPError, JSONDecodeError, Response } from '../net/httpClient';
import { truncateLogText } from '../helpers/logger';
import { now, randomDelay, sleep } from '../helpers/delays';
import { ensure } from '../helpers/assertions';
import type { Client } from '../core/instaClient';

export const GRAPHQL_API_URL = 'https://www.instagram.com/api/graphql';
export const PRIVATE_GRAPHQL_QUERY_URL = 'https://i.instagram.com/graphql/query';
export const PRIVATE_GRAPHQL_WWW_DOMAIN = 'b.i.instagram.com';

export const GQL_STUFF: Record<string, string> = {
  av: '17841464591314721',
  __d: 'www',
  __user: '0',
  __a: '1',
  __req: 'q',
  __hs: '19768.HYP:instagram_web_pkg.2.1..0.1',
  dpr: '2',
  __ccg: 'UNKNOWN',
  __rev: '1011444902',
  __s: 'x82a1q:agr3gd:4nh4nl',
  __hsi: '7335888108907652597',
  __dyn:
    '7xeUjG1mxu1syUbFp40NonwgU7SbzEdF8aUco2qwJxS0k24o0B-' +
    'q1ew65xO0FE2awt81s8hwGwQwoEcE7O2l0Fwqo31w9O7U2cxe0E' +
    'UjwGzEaE7622362W2K0zK5o4q3y1Sx-0iS2Sq2-azqwt8dUaob8' +
    '2cwMwrUdUbGwmk0KU6O1FwlE6PhA6bxy4VUKUnAwHw',
  __csr:
    'g9cj5kxfs8lifTitQDqhdhalmDEAJaKBRJFdkAGHBkPy9HgCA-A' +
    'rtucm5bCBBGpyAoz-mLJpXJufKWGQ9hHhAhnKECuFUZ3Q8Jkmmp' +
    'eWyGAzkEj_CjyoZUgK-E8bwYzaxy00ktMGx20XU3gw4KAo3MChU' +
    'jw3N80poolwiA1d7G2yu2ucxi1nwEw16OE1JsS043Etw63wkSEgg1Mu00yiU',
  __comet_req: '7',
  lsd: '6b2800R9u4biJOYjcdXFEI',
  __spin_r: '1011444902',
  __spin_b: 'trunk',
  __spin_t: '1708019550',
  fb_api_caller_class: 'RelayModern',
  fb_api_req_friendly_name: 'PolarisPostCommentsPaginationQuery',
  server_timestamps: 'true',
};

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class PrivateGraphQLRequestFeature {
  _mergeIncrementalGraphqlPayload(this: Client, base: Record<string, any>, payload: Record<string, any>): void {
    let pathArr = payload.path;
    if (!Array.isArray(pathArr) || !pathArr.length || !('data' in payload)) return;
    let target: any = base;
    if (pathArr.length && pathArr[0] !== 'data') target = base.data ?? {};
    else if (pathArr.length && pathArr[0] === 'data') pathArr = pathArr.slice(1);
    if (!pathArr.length) return;
    for (const key of pathArr.slice(0, -1)) {
      if (target === null || target === undefined || typeof target !== 'object') return;
      if (Array.isArray(target) && (typeof key !== 'number' || key >= target.length)) return;
      if (!Array.isArray(target) && !(key in target)) return;
      target = target[key];
    }
    if (target === null || target === undefined || typeof target !== 'object') return;
    const key = pathArr[pathArr.length - 1];
    const value = payload.data;
    if (Array.isArray(target)) {
      if (typeof key !== 'number') return;
      if (key === target.length) {
        target.push(value);
        return;
      }
      if (key >= target.length || key < -target.length) return;
      const idx = key < 0 ? target.length + key : key;
      const current = target[idx];
      if (isDict(current) && isDict(value)) Object.assign(current, value);
      else target[idx] = value;
      return;
    }
    const current = target[key];
    if (isDict(current) && isDict(value)) Object.assign(current, value);
    else target[key] = value;
  }

  /** fb_dtsg token (lazily fetched) */
  async getFbDtsg(this: Client): Promise<string | null> {
    if (!this._fbDtsg) this._fbDtsg = await this.fetchFbDtsg();
    return this._fbDtsg;
  }

  async fetchFbDtsg(this: Client): Promise<string | null> {
    this.injectSessionidToPublic();
    const response = await this.graphql.get('https://www.instagram.com/', { proxies: this.graphql.proxies });
    const html = response.content.length ? response.content.toString('utf8') : '';
    if (html) {
      let s = html.indexOf('__eqmc');
      // a missing marker gives index -1, which slices from the end
      if (s < 0) s = html.length - 1;
      const e = s + 1000;
      let eqmc = html.slice(s, e);
      const s2 = eqmc.indexOf('{');
      const e2 = eqmc.indexOf('</script>');
      eqmc = sliceRange(eqmc, s2, e2);
      if (eqmc) return JSON.parse(eqmc).f;
    }
    return null;
  }

  _jsonFromGraphqlResponse(this: Client, response: Response): any {
    try {
      return response.json();
    } catch (err) {
      if (!(err instanceof JSONDecodeError)) throw err;
      const chunks = response.text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (e: any) {
            throw new JSONDecodeError(e.message, line);
          }
        });
      if (!chunks.length) throw err;
      const body = chunks[0];
      for (const chunk of chunks.slice(1)) {
        const updates = Array.isArray(chunk) ? chunk : [chunk];
        for (const update of updates) if (isDict(update)) this._mergeIncrementalGraphqlPayload(body, update);
      }
      return body;
    }
  }

  async graphqlRequest(
    this: Client,
    opts: { data?: any; params?: Record<string, any> | null; headers?: Record<string, any> | null; returnJson?: boolean; retriesCount?: number; retriesTimeout?: number } = {},
  ): Promise<any> {
    const { data = null, params = null, headers = null, returnJson = true, retriesCount = 1, retriesTimeout = 2 } = opts;
    ensure(retriesCount <= 10, 'Retries count is too high');
    ensure(retriesTimeout <= 600, 'Retries timeout is too high');
    this.injectSessionidToPublic();
    for (let iteration = 0; iteration < retriesCount; iteration++) {
      try {
        if (this.delayRange) await randomDelay(this.delayRange);
        return await this._sendGraphqlRequest({ data, params, headers, returnJson });
      } catch (e: any) {
        if (e instanceof ClientLoginRequired || e instanceof ClientNotFoundError || e instanceof ClientBadRequestError) throw e;
        if (e instanceof ClientError) {
          const msg = String(e.message);
          if (
            e instanceof ClientConnectionError &&
            msg.includes('SOCKSHTTPSConnectionPool') &&
            msg.includes('Max retries exceeded with url') &&
            msg.includes('Failed to establish a new connection')
          ) {
            throw e;
          }
          if (retriesCount > iteration + 1) await sleep(retriesTimeout);
          else throw e;
          continue;
        }
        throw e;
      }
    }
    return undefined;
  }

  async _sendGraphqlRequest(
    this: Client,
    opts: { data?: any; params?: Record<string, any> | null; headers?: Record<string, any> | null; returnJson?: boolean } = {},
  ): Promise<any> {
    const { data = null, params = null, headers = null, returnJson = false } = opts;
    this.lastGraphqlResponse = null;
    this.graphqlRequestsCount += 1;
    if (headers) this.graphql.headers.update(headers);
    if (this.lastResponseTs && now() - this.lastResponseTs < 1.0) await sleep(1.0);
    let response: Response | null = null;
    try {
      if (data !== null && data !== undefined) {
        response = await this.graphql.post(GRAPHQL_API_URL, { data, params, proxies: this.graphql.proxies });
      } else {
        response = await this.graphql.get(GRAPHQL_API_URL, { params, proxies: this.graphql.proxies });
      }
      this.requestLogger.debug('graphql_request %s: %s', response.status_code, response.url);
      this.requestLogger.info('GraphQL: [%s] [%s] %s %s', this.graphql.proxies.https, response.status_code, data ? 'POST' : 'GET', response.url);
      this.lastGraphqlResponse = response;
      response.raise_for_status();
      if (returnJson) {
        this.lastGraphqlJson = response.json();
        return this.lastGraphqlJson;
      }
      return response.text;
    } catch (e: any) {
      if (e instanceof JSONDecodeError) {
        const url = String(response?.url);
        if (url.includes('/login/')) throw new ClientLoginRequired(e, { response });
        this.requestLogger.error(
          'Status %s: JSONDecodeError in graphql_request (url=%s) >>> %s',
          response?.status_code,
          url,
          truncateLogText(response?.text),
        );
        throw new ClientJSONDecodeError(`JSONDecodeError ${e.message} while opening ${url}`, { response });
      }
      if (e instanceof HTTPError) {
        const statusCode = this.lastGraphqlResponse?.status_code;
        const Exc =
          statusCode === 401
            ? ClientUnauthorizedError
            : statusCode === 403
              ? ClientForbiddenError
              : statusCode === 400
                ? ClientBadRequestError
                : statusCode === 429
                  ? ClientThrottledError
                  : statusCode === 404
                    ? ClientNotFoundError
                    : ClientError;
        throw new Exc(e, { response: this.lastGraphqlResponse });
      }
      if (e instanceof ConnectionError) throw new ClientConnectionError(`${e.name} ${e.message}`);
      throw e;
    } finally {
      this.lastResponseTs = now();
    }
  }

  /**
   * Map a failed private GraphQL HTTP response to a typed exception.
   * Shared by privateGraphqlQueryRequest and privateGraphqlWwwRequest so both surface
   * LoginRequired / ChallengeRequired / FeedbackRequired / RateLimitError and status-coded
   * errors instead of a generic ClientError. Always throws.
   */
  _raiseGraphqlHttpError(this: Client, exc: unknown, response: Response | null): never {
    let lastJson: Record<string, any> = {};
    try {
      const bodyJson = response?.json();
      if (isDict(bodyJson)) {
        this.lastJson = bodyJson;
        lastJson = bodyJson;
      }
    } catch {
      lastJson = {};
    }
    const message = String(lastJson.message || '').toLowerCase();
    const errorType = lastJson.error_type;
    if (message === 'login_required') throw new LoginRequired(exc, { response, ...lastJson });
    if (message === 'challenge_required') throw new ChallengeRequired({ ...lastJson });
    if (message === 'feedback_required') throw new FeedbackRequired(exc, { response, ...lastJson });
    if (errorType === 'rate_limit_error') throw new RateLimitError(exc, { response, ...lastJson });
    if (message === 'user_blocked') throw new SentryBlock(exc, { response, ...lastJson });
    if (message.includes('not authorized to view user')) throw new PrivateAccount(exc, { response, ...lastJson });
    if (message.includes('unable to fetch followers') || message.includes('error generating user info response')) {
      throw new UserNotFound(exc, { response, ...lastJson });
    }
    if (response?.status_code === 404 && response?.text === 'Not Found') throw new ChallengeRequired({ ...lastJson });
    const statusCode = response?.status_code;
    const map: Record<number, typeof ClientError> = {
      400: ClientBadRequestError,
      401: ClientUnauthorizedError,
      403: ClientForbiddenError,
      404: ClientNotFoundError,
      429: ClientThrottledError,
    };
    const Cls = (statusCode !== undefined && map[statusCode]) || ClientError;
    throw new Cls(exc, { response, ...lastJson });
  }

  async privateGraphqlRequest(this: Client, data: Record<string, any>, headers: Record<string, any> | null = null, domain: string | null = null): Promise<any> {
    this.lastResponse = null;
    this.lastJson = {};
    let response: Response | null = null;
    const merged: Record<string, any> = { ...this.baseHeaders };
    merged['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    if (this.authorization) merged.Authorization = this.authorization;
    const friendlyName = data.fb_api_req_friendly_name;
    if (friendlyName) merged['X-FB-Friendly-Name'] = friendlyName;
    if (headers) Object.assign(merged, headers);
    if (this.requestTimeout) await sleep(this.requestTimeout);
    let url = `https://${domain || config.API_DOMAIN}/graphql/query`;
    try {
      this.privateRequestsCount += 1;
      response = await this.private.post(url, { data, headers: merged, proxies: this.private.proxies });
      this.requestLog(response);
      this.lastResponse = response;
      response.raise_for_status();
      this.lastJson = this._jsonFromGraphqlResponse(response);
    } catch (exc: any) {
      if (exc instanceof JSONDecodeError) {
        url = response ? response.url : url;
        throw new ClientJSONDecodeError(`JSONDecodeError ${exc.message} while opening ${url}`, { response });
      }
      if (exc instanceof HTTPError) throw new ClientError(exc, { response: exc.response });
      if (exc instanceof ConnectionError) throw new ClientConnectionError(`${exc.name} ${exc.message}`);
      throw exc;
    }
    if (this.lastJson?.errors) throw new ClientGraphqlError(this.lastJson.errors);
    if (this.lastJson?.status === 'fail') throw new ClientError({ response, ...this.lastJson });
    return this.lastJson;
  }

  async privateGraphqlWwwRequest(
    this: Client,
    friendlyName: string,
    variables: Record<string, any> | null = null,
    clientDocId: string | null = null,
    domain: string = PRIVATE_GRAPHQL_WWW_DOMAIN,
    extraHeaders: Record<string, any> | null = null,
    purpose: string | null = 'fetch',
    opts: { allowRedirects?: boolean | null; timeout?: number | null } = {},
  ): Promise<any> {
    const data: Record<string, any> = {
      method: 'post',
      pretty: 'false',
      format: 'json',
      server_timestamps: 'true',
      locale: 'user',
      fb_api_req_friendly_name: friendlyName,
      enable_canonical_naming: 'true',
      enable_canonical_variable_overrides: 'true',
      enable_canonical_naming_ambiguous_type_prefixing: 'true',
      variables: JSON.stringify(variables || {}),
    };
    if (purpose !== null && purpose !== undefined) data.purpose = purpose;
    if (clientDocId) data.client_doc_id = String(clientDocId);
    const headers: Record<string, any> = {
      'X-FB-Friendly-Name': friendlyName,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
    if (clientDocId) headers['X-Client-Doc-Id'] = String(clientDocId);
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const merged: Record<string, any> = { ...this.baseHeaders, ...headers };
    merged.Host = domain;
    if (this.authorization && !('Authorization' in merged)) merged.Authorization = this.authorization;
    if (this.requestTimeout) await sleep(this.requestTimeout);
    let url = `https://${domain}/graphql_www`;
    const requestOptions: Record<string, any> = {};
    if (opts.allowRedirects !== null && opts.allowRedirects !== undefined) requestOptions.allowRedirects = opts.allowRedirects;
    if (opts.timeout !== null && opts.timeout !== undefined) requestOptions.timeout = opts.timeout;
    let response: Response | null = null;
    try {
      this.privateRequestsCount += 1;
      response = await this.private.post(url, { data, headers: merged, proxies: this.private.proxies, ...requestOptions });
      this.requestLog(response);
      this.lastResponse = response;
      response.raise_for_status();
      this.lastJson = this._jsonFromGraphqlResponse(response);
    } catch (exc: any) {
      if (exc instanceof JSONDecodeError) {
        url = response ? response.url : url;
        throw new ClientJSONDecodeError(`JSONDecodeError ${exc.message} while opening ${url}`, { response });
      }
      if (exc instanceof HTTPError) this._raiseGraphqlHttpError(exc, response);
      if (exc instanceof ConnectionError) throw new ClientConnectionError(`${exc.name} ${exc.message}`);
      throw exc;
    }
    if (this.lastJson?.errors) throw new ClientGraphqlError(this.lastJson.errors);
    if (this.lastJson?.status === 'fail') throw new ClientError({ response, ...this.lastJson });
    return this.lastJson;
  }

  async privateGraphqlQueryRequest(
    this: Client,
    friendlyName: string,
    rootFieldName: string,
    variables: Record<string, any> | null = null,
    clientDocId: string | null = null,
    priority: string | null = null,
    extraHeaders: Record<string, any> | null = null,
  ): Promise<any> {
    const data: Record<string, any> = {
      method: 'post',
      pretty: 'false',
      format: 'json',
      server_timestamps: 'true',
      locale: 'user',
      fb_api_req_friendly_name: friendlyName,
      enable_canonical_naming: 'true',
      enable_canonical_variable_overrides: 'true',
      enable_canonical_naming_ambiguous_type_prefixing: 'true',
      variables: JSON.stringify(variables || {}),
    };
    if (clientDocId) data.client_doc_id = clientDocId;
    const headers: Record<string, any> = {
      'X-FB-Friendly-Name': friendlyName,
      'X-Root-Field-Name': rootFieldName,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
    if (clientDocId) headers['X-Client-Doc-Id'] = String(clientDocId);
    if (priority) headers.Priority = priority;
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const merged: Record<string, any> = { ...this.baseHeaders, ...headers };
    if (this.authorization && !('Authorization' in merged)) merged.Authorization = this.authorization;
    this.lastJson = {};
    const response = await this.private.post(PRIVATE_GRAPHQL_QUERY_URL, { data, headers: merged, proxies: this.private.proxies });
    this.lastResponse = response;
    try {
      response.raise_for_status();
    } catch (e) {
      if (e instanceof HTTPError) this._raiseGraphqlHttpError(e, response);
      throw e;
    }
    let body: any;
    try {
      body = response.json();
    } catch (e) {
      if (!(e instanceof JSONDecodeError)) throw e;
      const text = response.text.trim();
      const rows = text
        .split('"}\n')
        .filter((item) => item)
        .map((item) => JSON.parse(item.endsWith('"}') ? item : `${item}"}`));
      body = { stream_rows: rows };
    }
    this.lastJson = body;
    return body;
  }

  async privateGraphqlMemoriesPog(this: Client, clientDocId = '4160563056814166588457451196', directRegionHint: string | null = null): Promise<any> {
    const extraHeaders = directRegionHint ? { 'ig-u-ig-direct-region-hint': directRegionHint } : null;
    return this.privateGraphqlQueryRequest(
      'MemoriesPogQuery',
      'xdt_get_story_memories_pog',
      { request: { user_id: 0 } },
      clientDocId,
      null,
      extraHeaders,
    );
  }

  async privateGraphqlRealtimeRegionHint(this: Client, clientDocId = '52232106018313849661757113193'): Promise<any> {
    return this.privateGraphqlQueryRequest('IGRealtimeRegionHintQuery', 'xdt_igd_msg_region', {}, clientDocId, 'u=3, i');
  }

  async privateGraphqlTopAudioTrendsEligibleCategories(this: Client, clientDocId = '10243243298540497152200027985'): Promise<any> {
    return this.privateGraphqlQueryRequest('GetTopAudioTrendsEligibleCategories', 'xdt_top_audio_trends_eligible_tabs', {}, clientDocId);
  }

  async privateGraphqlUpdateInboxTrayLastSeen(this: Client, clientDocId = '41048505499858972910914091441'): Promise<any> {
    return this.privateGraphqlQueryRequest('UpdateInboxTrayLastSeenTimestamp', '__typename', {}, clientDocId);
  }
}

/** String slice that supports negative indices (counted from the end) */
export function sliceRange(s: string, start: number, end: number): string {
  const len = s.length;
  const a = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
  const b = end < 0 ? Math.max(0, len + end) : Math.min(end, len);
  return a < b ? s.slice(a, b) : '';
}
