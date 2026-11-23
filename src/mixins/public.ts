import * as Boom from '@hapi/boom';
import { createWriteStream, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import {
  ClientBadRequestError,
  ClientConnectionError,
  ClientError,
  ClientForbiddenError,
  ClientGraphqlError,
  ClientIncompleteReadError,
  ClientJSONDecodeError,
  ClientLoginRequired,
  ClientNotFoundError,
  ClientThrottledError,
  ClientUnauthorizedError,
} from '../exceptions';
import { ConnectionError, HTTPError, JSONDecodeError, Response } from '../http/session';
import { truncateLogText } from '../utils/logging';
import { now, randomDelay, sleep } from '../utils/timing';
import { ensure } from '../utils/validation';
import { ClientBase } from '../base';
import type { Client } from '../client';

export type PublicTransport = 'http1' | 'http2';
export const PUBLIC_WEB_APP_ID = '936619743392459';
export const PUBLIC_WEB_ASBD_ID = '129477';

export interface PublicRequestOptions {
  data?: any;
  params?: Record<string, any> | null;
  headers?: Record<string, any> | null;
  updateHeaders?: boolean | null;
  returnJson?: boolean;
  retriesCount?: number | null;
  retriesTimeout?: number | null;
}

export class PublicRequestMixin {
  /** Set web and non-LSD GraphQL UAs; null makes GraphQL follow the web UA. */
  setPublicUserAgent(this: Client, userAgent: string, graphqlUserAgent: string | null = null): boolean {
    this.publicUserAgent = userAgent;
    this.publicGraphqlUserAgent = graphqlUserAgent;
    this.public.headers.set('User-Agent', userAgent);
    if (this.settings) Object.assign(this.settings, { public_user_agent: userAgent, public_graphql_user_agent: graphqlUserAgent });
    return true;
  }

  _normalizePublicTransport(this: Client, publicTransport?: PublicTransport | null): PublicTransport {
    const t = publicTransport || 'http1';
    if (t !== 'http1' && t !== 'http2') throw Boom.badRequest("publicTransport must be 'http1' or 'http2'");
    return t;
  }

  _defaultPublicUserAgent(this: Client, publicTransport: PublicTransport, impersonate: string): string {
    return ClientBase._defaultPublicUserAgent(publicTransport, impersonate);
  }

  _buildPublicSessionRetryStrategy(this: Client) {
    return {
      total: this.sessionRetryTotal,
      statusForcelist: this.sessionRetryStatuses,
      allowedMethods: ['GET', 'POST'],
      backoffFactor: this.sessionRetryBackoffFactor,
    };
  }

  _configurePublicSessionRetry(this: Client): void {
    if (this.publicTransport === 'http2') {
      // Browser-like transport: HTTP/2 + modern TLS, no adapter retries
      this.public.impersonate = this.publicTransportImpersonate;
      this.public.mount('http2');
    } else {
      this.public.mount('http1', this._buildPublicSessionRetryStrategy());
    }
  }

  /**
   * Issue a HEAD request through the public session — useful for resolving
   * short-link redirects without downloading the body (e.g. instagram.com/share/... link expansion).
   * Default followRedirects=false means callers can read response.headers.get("location").
   */
  async publicHead(this: Client, url: string, followRedirects = false): Promise<Response> {
    this.publicRequestsCount += 1;
    return this.public.head(url, { allowRedirects: followRedirects, proxies: this.public.proxies, timeout: this.readTimeout });
  }

  async publicRequest(this: Client, url: string, opts: PublicRequestOptions = {}): Promise<any> {
    const retriesCount = opts.retriesCount ?? this.publicRequestRetriesCount;
    const retriesTimeout = opts.retriesTimeout ?? this.publicRequestRetriesTimeout;
    ensure(retriesCount <= 10, 'Retries count is too high');
    ensure(retriesTimeout <= 600, 'Retries timeout is too high');
    for (let iteration = 0; iteration < retriesCount; iteration++) {
      try {
        if (this.delayRange) await randomDelay(this.delayRange);
        return await this._sendPublicRequest(url, {
          data: opts.data,
          params: opts.params,
          headers: opts.headers,
          returnJson: opts.returnJson ?? false,
          updateHeaders: opts.updateHeaders,
        });
      } catch (e: any) {
        if (e instanceof ClientLoginRequired || e instanceof ClientNotFoundError || e instanceof ClientBadRequestError) {
          throw e; // Stop retries
        }
        if (e instanceof ClientError) {
          const responseStatus = e.response?.status_code;
          if (this.publicTransport === 'http1' && this.sessionRetryTotal > 0 && this.sessionRetryStatuses.includes(responseStatus)) {
            throw e;
          }
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

  async _sendPublicRequest(
    this: Client,
    url: string,
    opts: {
      data?: any;
      params?: Record<string, any> | null;
      headers?: Record<string, any> | null;
      returnJson?: boolean;
      stream?: boolean;
      timeout?: number | null;
      updateHeaders?: boolean | null;
    } = {},
  ): Promise<any> {
    const { data = null, params = null, headers = null, returnJson = false, stream = false, timeout = null, updateHeaders = null } = opts;
    this.publicRequestsCount += 1;
    let perRequestHeaders: Record<string, any> | null = null;
    if (headers && Object.keys(headers).length) {
      if (updateHeaders === null || updateHeaders === undefined || updateHeaders === true) this.public.headers.update(headers);
      else if (updateHeaders === false) perRequestHeaders = headers;
    }
    if (this.lastResponseTs && now() - this.lastResponseTs < 1.0) await sleep(1.0);
    if (this.requestTimeout) await sleep(this.requestTimeout);
    let response: Response | null = null;
    try {
      if (data !== null && data !== undefined) {
        // POST
        response = await this.public.post(url, { data, params, headers: perRequestHeaders, proxies: this.public.proxies, timeout });
      } else {
        // GET
        response = await this.public.get(url, { params, headers: perRequestHeaders, proxies: this.public.proxies, timeout });
      }
      if (!stream) {
        const expectedLength = parseInt(response.headers.get('Content-Length') || '0', 10) || 0;
        const actualLength = response.rawLength;
        if (actualLength < expectedLength) {
          throw new ClientIncompleteReadError(`Incomplete read (${actualLength} bytes read, ${expectedLength} more expected)`, { response });
        }
      }
      this.publicRequestLogger.debug('public_request %s: %s', response.status_code, response.url);
      this.publicRequestLogger.info('[%s] [%s] %s %s', this.public.proxies.https, response.status_code, data ? 'POST' : 'GET', response.url);
      this.lastPublicResponse = response;
      response.raise_for_status();
      if (stream) return response;
      if (returnJson) {
        this.lastPublicJson = response.json();
        return this.lastPublicJson;
      }
      return response.text;
    } catch (e: any) {
      if (e instanceof JSONDecodeError) {
        if (response && (response.url.includes('/login/') || response.url.includes('/challenge/'))) {
          throw new ClientLoginRequired(e, { response });
        }
        this.publicRequestLogger.error(
          'Status %s: JSONDecodeError in public_request (url=%s) >>> %s',
          response?.status_code,
          response?.url,
          truncateLogText(response?.text),
        );
        throw new ClientJSONDecodeError(`JSONDecodeError ${e.message} while opening ${url}`, { response });
      }
      if (e instanceof HTTPError) {
        const r = e.response!;
        if (r.status_code === 401) throw new ClientUnauthorizedError(e, { response: r });
        if (r.status_code === 403) throw new ClientForbiddenError(e, { response: r });
        if (r.status_code === 400) throw new ClientBadRequestError(e, { response: r });
        if (r.status_code === 429) throw new ClientThrottledError(e, { response: r });
        if (r.status_code === 404) throw new ClientNotFoundError(e, { response: r });
        throw new ClientError(e, { response: r });
      }
      if (e instanceof ConnectionError) throw new ClientConnectionError(`${e.name} ${e.message}`);
      throw e;
    } finally {
      this.lastResponseTs = now();
    }
  }

  _expectedContentLength(this: Client, response: Response): number | null {
    const contentLength = response.headers.get('Content-Length');
    if (!contentLength) return null;
    const n = parseInt(contentLength, 10);
    return Number.isNaN(n) ? null : n;
  }

  _raiseForIncompleteDownload(this: Client, actualLength: number, expectedLength: number | null, source: string): void {
    if (expectedLength === null || actualLength === expectedLength) return;
    throw new ClientIncompleteReadError(`Broken file ${source} (Content-length=${expectedLength}, but file length=${actualLength})`);
  }

  async _downloadResponseToPath(this: Client, response: Response, filePath: string): Promise<string> {
    try {
      await fsp.writeFile(filePath, response.content);
      // check the decoded file size against Content-Length (only meaningful for identity encoding)
      const encoding = (response.headers.get('content-encoding') || '').toLowerCase();
      const stat = await fsp.stat(filePath);
      this._raiseForIncompleteDownload(
        encoding && encoding !== 'identity' ? response.rawLength : stat.size,
        this._expectedContentLength(response),
        `"${filePath}"`,
      );
    } catch (e) {
      await fsp.unlink(filePath).catch(() => undefined);
      throw e;
    }
    return path.resolve(filePath);
  }

  _downloadResponseBytes(this: Client, response: Response, url: string): Buffer {
    const content = response.content;
    const encoding = (response.headers.get('content-encoding') || '').toLowerCase();
    this._raiseForIncompleteDownload(
      encoding && encoding !== 'identity' ? response.rawLength : content.length,
      this._expectedContentLength(response),
      `from url "${url}"`,
    );
    return content;
  }

  async publicGraphqlRequest(
    this: Client,
    variables: any,
    opts: { queryHash?: string | null; queryId?: string | null; data?: any; params?: Record<string, any> | null; headers?: Record<string, any> | null } = {},
  ): Promise<any> {
    const { queryHash = null, queryId = null, data = null, headers = null } = opts;
    let params = opts.params ?? null;
    ensure(queryId || queryHash, 'Must provide valid one of: query_id, query_hash');
    const defaultParams: Record<string, any> = { variables: JSON.stringify(variables) };
    if (queryId) defaultParams.query_id = queryId;
    if (queryHash) defaultParams.query_hash = queryHash;
    if (params) Object.assign(params, defaultParams);
    else params = defaultParams;
    try {
      const bodyJson = await this.publicRequest(this.GRAPHQL_PUBLIC_API_URL, { data, params, headers, returnJson: true });
      if ((bodyJson?.status ?? null) !== 'ok') {
        throw new ClientGraphqlError(`Unexpected status '${bodyJson?.status ?? null}' in response. Message: '${bodyJson?.message ?? null}'`);
      }
      if (!('data' in bodyJson)) {
        const errors = bodyJson.errors || [];
        const summary = errors.length ? errors[0].summary : null;
        const description = errors.length ? errors[0].description : null;
        throw new ClientGraphqlError(`Missing 'data' in GraphQL response. Summary: '${summary}'. Description: '${description}'`);
      }
      return bodyJson.data;
    } catch (e: any) {
      if (e instanceof ClientBadRequestError) {
        let message = null;
        try {
          message = e.response.json()?.message ?? null;
        } catch {
          /* JSONDecodeError */
        }
        throw new ClientGraphqlError(`Error: '${e.message}'. Message: '${message}'`, { response: e.response });
      }
      throw e;
    }
  }

  _extractPublicLsdToken(this: Client, html: string): string | null {
    if (!html) return null;
    let match = html.match(/\["LSD",\[\],\{"token":"([^"]+)"\}/);
    if (match) return match[1];
    match = html.match(/"LSD",\[\],\{"token":"([^"]+)"/);
    return match ? match[1] : null;
  }

  _extractPublicFbDtsgToken(this: Client, html: string): string | null {
    if (!html) return null;
    const match = html.match(/\["DTSG(?:Init|Initial)Data",\[\],\{"token":"([^"]+)"/);
    return match ? match[1] : null;
  }

  /**
   * POST a doc_id-based GraphQL query to Instagram's public web endpoints.
   * Newer Instagram web GraphQL endpoints use doc_id instead of the legacy
   * query_hash / query_id scheme. Returns the parsed data payload.
   */
  async publicDocIdGraphqlRequest(
    this: Client,
    docId: string,
    variables: Record<string, any>,
    opts: { referer?: string | null; headers?: Record<string, string> | null; url?: string | null; includeLsd?: boolean; includeFbDtsg?: boolean } = {},
  ): Promise<any> {
    const { referer = null, headers = null, url = null, includeLsd = false, includeFbDtsg = false } = opts;
    const data: Record<string, any> = { variables: JSON.stringify(variables), doc_id: docId, server_timestamps: 'true' };
    this.injectSessionidToPublic();
    const queryUrl = url || this.GRAPHQL_PUBLIC_API_URL;
    const refererUrl = referer || 'https://www.instagram.com/';
    let lsd: string | null = null;
    if (includeLsd || includeFbDtsg) {
      const html = await this.publicRequest(refererUrl, { returnJson: false });
      lsd = this._extractPublicLsdToken(html);
      if (lsd) data.lsd = lsd;
      if (includeFbDtsg) {
        const fbDtsg = this._extractPublicFbDtsgToken(html);
        if (fbDtsg) data.fb_dtsg = fbDtsg;
      }
    }
    const mergedHeaders: Record<string, string> = {
      Accept: '*/*',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'en-US,en;q=0.8',
      Referer: refererUrl,
      'User-Agent': this.publicGraphqlUserAgent === null ? this.publicUserAgent : this.publicGraphqlUserAgent,
    };
    if (includeLsd) {
      Object.assign(mergedHeaders, {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.instagram.com',
        'User-Agent': this.publicUserAgent,
        'X-ASBD-ID': PUBLIC_WEB_ASBD_ID,
        'X-IG-App-ID': PUBLIC_WEB_APP_ID,
      });
      if (lsd) mergedHeaders['X-FB-LSD'] = lsd;
    }
    const csrftoken = this.public.cookies.get('csrftoken');
    if (csrftoken) mergedHeaders['X-CSRFToken'] = csrftoken;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) mergedHeaders[key.toLowerCase() === 'user-agent' ? 'User-Agent' : key] = value;
    }
    const bodyJson = await this.publicRequest(queryUrl, { data, headers: mergedHeaders, updateHeaders: false, returnJson: true });
    if (bodyJson?.data === null || bodyJson?.data === undefined) {
      const errors = bodyJson?.errors || [];
      const summary = errors.length ? errors[0].summary : null;
      const description = errors.length ? errors[0].description : null;
      throw new ClientGraphqlError(
        `Missing 'data' in doc_id GraphQL response (doc_id=${docId}). Summary: '${summary}'. Description: '${description}'`,
      );
    }
    return bodyJson.data;
  }
}

export class TopSearchesPublicMixin {
  /** Anonymous IG search request */
  async topSearch(this: Client, query: string): Promise<any> {
    const url = 'https://www.instagram.com/web/search/topsearch/';
    const rank = 0.7763938004511706; // Static public web rank value, not a credential.
    const params = { context: 'blended', query, rank_token: rank, include_reel: 'true' };
    return this.publicRequest(url, { params, returnJson: true });
  }
}

export class ProfilePublicMixin {
  async locationFeed(this: Client, locationId: string | number, count = 16, endCursor: string | null = null): Promise<any> {
    if (count > 50) throw Boom.badRequest('Count cannot be greater than 50');
    const variables: Record<string, any> = { id: locationId, first: Math.trunc(count) };
    if (endCursor) variables.after = endCursor;
    const data = await this.publicGraphqlRequest(variables, { queryHash: '1b84447a4d8b6d6d0426fefb34514485' });
    return data.location;
  }

  async profileRelatedInfo(this: Client, profileId: string | number): Promise<any> {
    const variables = {
      user_id: profileId,
      include_chaining: true,
      include_reel: true,
      include_suggested_users: true,
      include_logged_out_extras: true,
      include_highlight_reels: true,
      include_related_profiles: true,
    };
    const data = await this.publicGraphqlRequest(variables, { queryHash: 'e74d51c10ecc0fe6250a295b9bb9db74' });
    return data.user;
  }
}

void createWriteStream;
