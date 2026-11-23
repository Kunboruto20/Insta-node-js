import * as Boom from '@hapi/boom';
import { createInterface } from 'node:readline/promises';
import * as config from '../config';
import {
  AccountContactPointRequired,
  AccountEditError,
  AccountSuspended,
  BadPassword,
  ChallengeRequired,
  ClientBadRequestError,
  ClientConnectionError,
  ClientError,
  ClientForbiddenError,
  ClientIncompleteReadError,
  ClientJSONDecodeError,
  ClientNeedsUpgradeError,
  ClientNotFoundError,
  ClientRequestTimeout,
  ClientThrottledError,
  ClientUnauthorizedError,
  DirectMessageRequestsDisabled,
  FeedbackRequired,
  InvalidMediaId,
  InvalidTargetUser,
  LoginRequired,
  MediaUnavailable,
  PleaseWaitFewMinutes,
  PrivateAccount,
  ProxyAddressIsBlocked,
  RateLimitError,
  SentryBlock,
  TwoFactorRequired,
  UnknownError,
  UserNotFound,
  VideoTooLongException,
} from '../exceptions';
import { ChunkedEncodingError, ConnectionError, HTTPError, JSONDecodeError, Response } from '../http/session';
import { generateSignature } from '../utils/auth';
import { truncateLogText } from '../utils/logging';
import { dumps } from '../utils/serialization';
import { now, randomDelay, randomUniform, sleep } from '../utils/timing';
import type { Client } from '../client';

const _DIRECT_MESSAGE_REQUESTS_DISABLED_MARKERS = [
  "can't message this account unless they follow you",
  "can't receive your message because they don't allow new message requests",
  "doesn't allow new message requests",
  "don't allow new message requests",
  'does not allow new message requests',
];

const _ACCOUNT_CONTACT_POINT_REQUIRED_MARKERS = ['need an email or confirmed phone number'];
export const _LOGIN_CONTEXT_REJECTION_HINT =
  'This can also happen when Instagram rejects the proxy/IP, device fingerprint, ' +
  'or login context, even if the password is correct.';

function _privateMessageText(message: any): string {
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const errors = message.errors;
    if (Array.isArray(errors)) return errors.map((e: any) => String(e)).join(' ');
    return Object.values(message).map((v) => String(v)).join(' ');
  }
  if (Array.isArray(message)) return message.map((i) => String(i)).join(' ');
  return String(message || '');
}

function _isAccountContactPointRequired(endpoint: string, message: any): boolean {
  if (!endpoint || !endpoint.includes('accounts/edit_profile')) return false;
  const normalized = _privateMessageText(message).toLowerCase();
  return _ACCOUNT_CONTACT_POINT_REQUIRED_MARKERS.some((m) => normalized.includes(m));
}

function _isAccountEditError(endpoint: string): boolean {
  return Boolean(endpoint && endpoint.includes('accounts/edit_profile'));
}

function _isDirectMessageRequestsDisabled(endpoint: string, message: any): boolean {
  if (!endpoint || !message || !endpoint.includes('direct_v2/')) return false;
  const normalized = String(message).toLowerCase().replace(/’/g, "'");
  return _DIRECT_MESSAGE_REQUESTS_DISABLED_MARKERS.some((m) => normalized.includes(m));
}

function withoutMessage(obj: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj || {})) if (k !== 'message') out[k] = v;
  return out;
}

async function askLine(prompt: string): Promise<string> {
  if (!process.stdin.readable) throw Boom.preconditionFailed('Standard input is not readable (set challengeCodeHandler)');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const closed = new Promise<never>((_, reject) => rl.once('close', () => reject(Boom.preconditionFailed('Standard input was closed (set challengeCodeHandler)'))));
    return await Promise.race([rl.question(prompt), closed]);
  } finally {
    rl.close();
  }
}

export interface PrivateRequestOptions {
  params?: Record<string, any> | null;
  login?: boolean;
  withSignature?: boolean;
  headers?: Record<string, any> | null;
  extraSig?: string[] | null;
  domain?: string | null;
  returnResponse?: boolean;
}

/**
 * Helpers for private request
 */
export class PrivateRequestMixin {
  /** Manual security code helper (reads from stdin). Returns code as string (can start with 0). */
  async manualInputCode(this: Client, username: string, choice?: any): Promise<string> {
    let code: string | null = null;
    try {
      while (true) {
        code = (await askLine(`Enter code (6 digits) for ${username} (${choice}): `)).trim();
        if (code && /^\d+$/.test(code)) break;
      }
    } catch (e) {
      throw new ChallengeRequired(
        'Challenge code input is unavailable. Provide a challengeCodeHandler ' +
          'or disable automatic resolution with withChallengeFlow=false.',
        withoutMessage(this.lastJson),
      );
    }
    return code;
  }

  async manualChangePassword(this: Client, username: string): Promise<string> {
    let pwd: string | null = null;
    try {
      while (!pwd) pwd = (await askLine(`Enter password for ${username}: `)).trim();
    } catch (e) {
      throw new ChallengeRequired(
        'Password input is unavailable. Provide a changePasswordHandler ' +
          'or disable automatic resolution with withChallengeFlow=false.',
        withoutMessage(this.lastJson),
      );
    }
    return pwd;
  }

  _buildPrivateSessionRetryStrategy(this: Client) {
    return {
      total: this.sessionRetryTotal,
      statusForcelist: this.sessionRetryStatuses,
      allowedMethods: ['GET', 'POST'],
      backoffFactor: this.sessionRetryBackoffFactor,
    };
  }

  _normalizePrivateTransport(this: Client, privateTransport: any): 'http1' | 'http2' | 'mobile' {
    if (!['http1', 'http2', 'mobile'].includes(privateTransport)) {
      throw Boom.badRequest("privateTransport must be 'http1', 'http2' or 'mobile'");
    }
    return privateTransport;
  }

  _configurePrivateSessionRetry(this: Client, privateTransport?: 'http1' | 'http2' | 'mobile' | null): void {
    const transport = privateTransport ?? this.privateTransport;
    if ((transport === 'http2' || transport === 'mobile') && this._privateAdapterTransport === transport) return;
    this.private.mount(transport, this._buildPrivateSessionRetryStrategy());
    this.privateTransport = transport;
    this._privateAdapterTransport = transport;
  }

  /** Small Delay */
  async smallDelay(this: Client): Promise<void> {
    await sleep(randomUniform(0.75, 3.75));
  }

  /** Very small delay */
  async verySmallDelay(this: Client): Promise<void> {
    await sleep(randomUniform(0.175, 0.875));
  }

  get baseHeaders(): Record<string, string> {
    const self = this as unknown as Client;
    const locale = self.locale.replace(/-/g, '_');
    const acceptLanguage = ['en-US'];
    if (locale) {
      const lang = locale.replace(/_/g, '-');
      if (!acceptLanguage.includes(lang)) acceptLanguage.unshift(lang);
    }
    const headers: Record<string, string> = {
      'X-IG-App-Locale': locale,
      'X-IG-Device-Locale': locale,
      'X-IG-Mapped-Locale': locale,
      'X-Pigeon-Session-Id': self._pigeonSessionId,
      'X-Pigeon-Rawclienttime': now().toFixed(3),
      // "X-IG-Connection-Speed": "-1kbps",
      // No measured download samples: report unknown bandwidth.
      'X-IG-Bandwidth-Speed-KBPS': '-1.000',
      'X-IG-Bandwidth-TotalBytes-B': '0',
      'X-IG-Bandwidth-TotalTime-MS': '0',
      // "X-IG-EU-DC-ENABLED": "true", # <- type of DC? Eu is euro, but we use US
      // "X-IG-Prefetch-Request": "foreground",  # OLD from instabot
      'X-IG-App-Startup-Country': self.country.toUpperCase(),
      'X-Bloks-Version-Id': self.bloksVersioningId,
      'X-IG-WWW-Claim': '0',
      // X-IG-WWW-Claim: hmac.AR3zruvyGTlwHvVd2ACpGCWLluOppXX4NAVDV-iYslo9CaDd
      'X-Bloks-Is-Layout-RTL': 'false',
      'X-Bloks-Is-Panorama-Enabled': 'true',
      'X-IG-Device-ID': self.uuid,
      'X-IG-Family-Device-ID': self.phoneId,
      'X-IG-Android-ID': self.androidDeviceId,
      'X-IG-Timezone-Offset': String(self.timezoneOffset),
      'X-IG-Connection-Type': 'WIFI',
      'X-IG-Capabilities': '3brTv10=', // "3brTvwE=" in instabot
      'X-IG-App-ID': self.appId,
      Priority: 'u=3',
      'User-Agent': self.userAgent || '',
      'Accept-Language': acceptLanguage.join(', '),
      'X-MID': self.mid || '', // e.g. X--ijgABABFjLLQ1NTEe0A6JSN7o, YRwa1QABBAF-ZA-1tPmnd0bEniTe
      'Accept-Encoding': 'gzip, deflate', // ignore zstd
      Host: self.domain,
      'X-FB-HTTP-Engine': 'Tigon/MNS/TCP',
      'X-Tigon-Is-Retry': 'False',
      'X-Zero-Balance': 'INIT',
      'X-Zero-Eh': '',
      'X-Zero-State': 'unknown',
      'Zero-HTTP-Network-Interface': 'wifi',
      Connection: 'keep-alive',
      // "Pragma": "no-cache",
      // "Cache-Control": "no-cache",
      'X-FB-Client-IP': 'True',
      'X-FB-Server-Cluster': 'True',
      'IG-INTENDED-USER-ID': String(self.userId || 0),
      'X-IG-Nav-Chain': '9MV:self_profile:2,ProfileMediaTabFragment:self_profile:3,9Xf:self_following:4',
    };
    if (self.userId) {
      const nextYear = now() + 31536000; // + 1 year in seconds
      Object.assign(headers, {
        'IG-U-DS-USER-ID': String(self.userId),
        // Direct:
        'IG-U-IG-DIRECT-REGION-HINT': `LLA,${self.userId},${nextYear}:01f7bae7d8b131877d8e0ae1493252280d72f6d0d554447cb1dc9049b6b2c507c08605b7`,
        'IG-U-SHBID': `12695,${self.userId},${nextYear}:01f778d9c9f7546cf3722578fbf9b85143cd6e5132723e5c93f40f55ca0459c8ef8a0d9f`,
        'IG-U-SHBTS': `${Math.trunc(now())},${self.userId},${nextYear}:01f7ace11925d0388080078d0282b75b8059844855da27e23c90a362270fddfb3fae7e28`,
        'IG-U-RUR': `RVA,${self.userId},${nextYear}:01f7f627f9ae4ce2874b2e04463efdb184340968b1b006fa88cb4cc69a942a04201e544c`,
      });
    }
    if (self.igURur) headers['IG-U-RUR'] = self.igURur;
    if (self.igWwwClaim) headers['X-IG-WWW-Claim'] = self.igWwwClaim;
    if (self.usdidPrivateKey) headers['X-Meta-Usdid'] = self.usdidHeader();
    return headers;
  }

  privateHeaders(this: Client, headers?: Record<string, any> | null): Record<string, string> {
    const requestHeaders: Record<string, string> = { ...this.baseHeaders };
    if (headers) Object.assign(requestHeaders, headers);
    if (this.authorization && !Object.keys(requestHeaders).some((k) => k.toLowerCase() === 'authorization')) {
      requestHeaders.Authorization = this.authorization;
    }
    return requestHeaders;
  }

  /** Set you country code (ISO 3166-1/3166-2), e.g. US, UK, RU. Advise to specify the country code of your proxy */
  setCountry(this: Client, country = 'US'): boolean {
    this.settings.country = this.country = String(country);
    return true;
  }

  /** Set country calling code */
  setCountryCode(this: Client, countryCode = 1): boolean {
    this.settings.country_code = this.countryCode = Math.trunc(Number(countryCode));
    return true;
  }

  /** Set you locale (e.g. en_US). Advise to specify the locale code of your proxy */
  setLocale(this: Client, locale = 'en_US'): boolean {
    const userAgent = (this.settings.user_agent || '').split(this.locale).join(locale);
    this.settings.locale = this.locale = String(locale);
    this.setUserAgent(userAgent); // update locale in user_agent
    if (locale.includes('_')) this.setCountry(locale.slice(locale.lastIndexOf('_') + 1));
    return true;
  }

  _timezoneNameFromOffset(this: Client, seconds: number): string {
    seconds = Math.trunc(Number(seconds));
    if (seconds === 0) return 'GMT';
    const sign = seconds > 0 ? '+' : '-';
    seconds = Math.abs(seconds);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `GMT${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  _boolToIgString(this: Client, value: any): string {
    return value ? 'true' : 'false';
  }

  /** Set your timezone name for request metadata. */
  setTimezoneName(this: Client, timezoneName = ''): boolean {
    this.settings.timezone_name = this.timezoneName = String(timezoneName);
    return true;
  }

  /** Set you timezone offset in seconds (offset from UTC) */
  setTimezoneOffset(this: Client, seconds = 0, timezoneName: string | null = null): boolean {
    this.settings.timezone_offset = this.timezoneOffset = Math.trunc(Number(seconds));
    this.setTimezoneName(timezoneName === null || timezoneName === undefined ? this._timezoneNameFromOffset(this.timezoneOffset) : timezoneName);
    return true;
  }

  /** Configure whether request metadata reports push as disabled. */
  setPushDisabled(this: Client, disabled = true): boolean {
    this.settings.push_disabled = this.pushDisabled = Boolean(disabled);
    return true;
  }

  setIgURur(this: Client, value: any): boolean {
    this.settings.ig_u_rur = this.igURur = value;
    return true;
  }

  setIgWwwClaim(this: Client, value: any): boolean {
    this.settings.ig_www_claim = this.igWwwClaim = value;
    return true;
  }

  withQueryParams(this: Client, data: Record<string, any>, params: any): Record<string, any> {
    return { ...data, query_params: JSON.stringify(params) };
  }

  async _sendPrivateRequest(
    this: Client,
    endpoint: string,
    data: any = null,
    opts: PrivateRequestOptions = {},
  ): Promise<any> {
    const { params = null, login = false, withSignature = true, headers = null, extraSig = null, domain = null, returnResponse = false } = opts;
    this.lastResponse = null;
    let lastJson: any = {};
    this.lastJson = lastJson; // for Sentry context in traceback
    this.private.headers.update(this.baseHeaders);
    // Per-request overrides (caller headers such as X-FB-Friendly-Name, and the
    // Host override used for domain routing) must not be merged into the
    // persistent session headers: doing so leaks e.g. a Bloks async-action
    // friendly name onto every later unrelated request. Send them per-request.
    const requestHeaders: Record<string, any> = headers ? { ...headers } : {};
    if (domain) requestHeaders.Host = domain;
    if (!login) await sleep(this.requestTimeout);
    let response: Response | null = null;
    try {
      if (!endpoint.startsWith('/')) endpoint = `/v1/${endpoint}`;
      if (endpoint === '/challenge/') endpoint = '/v1/challenge/'; // wow so hard, is it safe tho?
      const apiUrl = `https://${domain || config.API_DOMAIN}/api${endpoint}`;
      this.logger.info(apiUrl);
      if (data) {
        // POST
        this.private.headers.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
        if (withSignature) {
          // Client.direct_answer doesn't need a signature
          data = generateSignature(dumps(data));
          if (extraSig) data += extraSig.join('&');
        }
        response = await this.private.post(apiUrl, {
          data,
          params,
          headers: Object.keys(requestHeaders).length ? requestHeaders : null,
          proxies: this.private.proxies,
        });
      } else {
        // GET
        this.private.headers.pop('Content-Type');
        response = await this.private.get(apiUrl, {
          params,
          headers: Object.keys(requestHeaders).length ? requestHeaders : null,
          proxies: this.private.proxies,
        });
      }
      this.logger.debug('private_request %s: %s (%s)', response.status_code, response.url, response.text);
      const mid = response.headers.get('ig-set-x-mid');
      if (mid) this.mid = mid;
      this.requestLog(response);
      this.lastResponse = response;
      if (returnResponse) return response;
      response.raise_for_status();
      // last_json - for Sentry context in traceback
      this.lastJson = lastJson = response.json();
      this.logger.debug('last_json %s', lastJson);
    } catch (e: any) {
      if (e instanceof JSONDecodeError) {
        this.logger.error(
          'Status %s: JSONDecodeError in private_request (user_id=%s, endpoint=%s) >>> %s',
          response?.status_code,
          this.userId,
          endpoint,
          truncateLogText(response?.text),
        );
        throw new ClientJSONDecodeError(`JSONDecodeError ${e.message} while opening ${response?.url}`, { response });
      }
      if (e instanceof HTTPError) {
        const resp = e.response!;
        try {
          this.lastJson = lastJson = resp.json();
        } catch {
          /* not a number */
        }
        if (!lastJson || typeof lastJson !== 'object' || Array.isArray(lastJson)) lastJson = {};
        const message = lastJson.message || '';
        if (typeof message === 'string' && message.includes('Please wait a few minutes')) {
          throw new PleaseWaitFewMinutes(e, { response: resp, ...lastJson });
        }
        if (resp.status_code === 403) {
          if (message === 'login_required') throw new LoginRequired({ response: resp, ...lastJson });
          if (resp.text.length < 512) lastJson.message = resp.text;
          throw new ClientForbiddenError(e, { response: resp, ...lastJson });
        } else if (resp.status_code === 400) {
          const errorType = lastJson.error_type;
          const msg = typeof message === 'string' ? message : String(message);
          if (lastJson.two_factor_info) {
            if (!lastJson.message) {
              lastJson.message = 'Two-factor authentication required';
              if (lastJson.error_type !== 'two_factor_required') {
                this.logger.info(
                  'Changing error_type from %s to two_factor_required due to presence of two_factor_info',
                  lastJson.error_type,
                );
              }
              lastJson.error_type = 'two_factor_required';
            }
            throw new TwoFactorRequired({ ...lastJson });
          } else if (message === 'challenge_required') {
            const challenge = lastJson.challenge || {};
            if ((challenge.url || '').includes('/suspended/')) throw new AccountSuspended({ ...lastJson });
            throw new ChallengeRequired({ ...lastJson });
          } else if (message === 'feedback_required') {
            throw new FeedbackRequired({ ...lastJson, message: `${message}: ${lastJson.feedback_message}` });
          } else if (errorType === 'sentry_block') {
            throw new SentryBlock({ ...lastJson });
          } else if (errorType === 'rate_limit_error') {
            throw new RateLimitError({ ...lastJson });
          } else if (errorType === 'bad_password') {
            lastJson.message = [lastJson.message || 'Instagram rejected the login credentials.', _LOGIN_CONTEXT_REJECTION_HINT]
              .filter(Boolean)
              .join(' ');
            throw new BadPassword({ ...lastJson });
          } else if (errorType === 'two_factor_required') {
            if (!lastJson.message) lastJson.message = 'Two-factor authentication required';
            throw new TwoFactorRequired({ ...lastJson });
          } else if (_isAccountContactPointRequired(endpoint, message)) {
            throw new AccountContactPointRequired(e, { response: resp, ...lastJson });
          } else if (_isAccountEditError(endpoint)) {
            throw new AccountEditError(e, { response: resp, ...lastJson });
          } else if (_isDirectMessageRequestsDisabled(endpoint, message)) {
            throw new DirectMessageRequestsDisabled(e, { response: resp, ...lastJson });
          } else if (msg.includes('VideoTooLongException')) {
            throw new VideoTooLongException(e, { response: resp, ...lastJson });
          } else if (msg.includes('Not authorized to view user')) {
            throw new PrivateAccount(e, { response: resp, ...lastJson });
          } else if (msg.includes('Invalid target user')) {
            throw new InvalidTargetUser(e, { response: resp, ...lastJson });
          } else if (msg.includes('Invalid media_id')) {
            throw new InvalidMediaId(e, { response: resp, ...lastJson });
          } else if (msg.includes('Media is unavailable') || msg.includes('Media not found or unavailable')) {
            throw new MediaUnavailable(e, { response: resp, ...lastJson });
          } else if (msg.includes('has been deleted')) {
            // Sorry, this photo has been deleted.
            throw new MediaUnavailable(e, { response: resp, ...lastJson });
          } else if (msg.includes('unable to fetch followers')) {
            // returned when user not found
            throw new UserNotFound(e, { response: resp, ...lastJson });
          } else if (msg.includes('The username you entered')) {
            // The username you entered doesn't appear to belong to an account.
            // Please check your username and try again.
            lastJson.message = 'Instagram has blocked your IP address, use a quality proxy provider (not free, not shared)';
            throw new ProxyAddressIsBlocked({ ...lastJson });
          } else if (errorType === 'needs_upgrade') {
            throw new ClientNeedsUpgradeError({ ...lastJson, response: resp });
          } else if (errorType || message) {
            throw new UnknownError({ ...lastJson });
          }
          // TODO: Handle last_json with {'message': 'counter get error', 'status': 'fail'}
          this.logger.exception(e);
          this.logger.warning('Status 400: %s', message || 'Empty response message. Maybe enabled Two-factor auth?');
          throw new ClientBadRequestError(e, { response: resp, ...lastJson });
        } else if (resp.status_code === 429) {
          this.logger.warning('Status 429: Too many requests');
          throw new ClientThrottledError(e, { response: resp, ...lastJson });
        } else if (resp.status_code === 401) {
          this.logger.warning('Status 401: Unauthorized %s', endpoint);
          throw new ClientUnauthorizedError(e, { response: resp, ...lastJson });
        } else if (resp.status_code === 404) {
          if (resp.text === 'Not Found') {
            // Masked challenge (often on /media/.../comments/) — IG
            // returns the bare body "Not Found" instead of a JSON
            // challenge envelope. Surface it as ChallengeRequired so
            // callers can resolve it instead of treating the resource
            // as missing.
            this.logger.warning('Status 404 (masked challenge): %s', endpoint);
            throw new ChallengeRequired({ ...lastJson });
          }
          this.logger.warning('Status 404: Endpoint %s does not exist', endpoint);
          throw new ClientNotFoundError(e, { response: resp, ...lastJson });
        } else if (resp.status_code === 408) {
          this.logger.warning('Status 408: Request Timeout');
          throw new ClientRequestTimeout(e, { response: resp, ...lastJson });
        }
        throw new ClientError(e, { response: resp, ...lastJson });
      }
      if (e instanceof ChunkedEncodingError) throw new ClientIncompleteReadError(`${e.name} ${e.message}`);
      if (e instanceof ConnectionError) throw new ClientConnectionError(`${e.name} ${e.message}`);
      throw e;
    }
    if (lastJson && lastJson.status === 'fail') {
      const message = lastJson.message || '';
      if (_isAccountContactPointRequired(endpoint, message)) throw new AccountContactPointRequired({ response, ...lastJson });
      if (_isAccountEditError(endpoint)) throw new AccountEditError({ response, ...lastJson });
      if (_isDirectMessageRequestsDisabled(endpoint, message)) throw new DirectMessageRequestsDisabled({ response, ...lastJson });
      throw new ClientError({ response, ...lastJson });
    } else if (lastJson && typeof lastJson === 'object' && 'error_title' in lastJson) {
      /* Example: {
        'error_title': 'bad image input extra:{}', <-------------
        'media': {'device_timestamp': '1588184737203', 'upload_id': '1588184737203'},
        'message': 'media_needs_reupload', <-------------
        'status': 'ok' <-------------
      } */
      throw new ClientError({ response, ...lastJson });
    }
    return lastJson;
  }

  requestLog(this: Client, response: Response): void {
    this.privateRequestLogger.info(
      '%s [%s] %s %s (%s)',
      this.username,
      response.status_code,
      response.request?.method,
      response.url,
      `${this.deviceSettings.app_version}, ${this.deviceSettings.manufacturer} ${this.deviceSettings.model}`,
    );
  }

  /**
   * Send private API request (i.instagram.com/api/v1/...).
   * `data` - POST body (object is signed unless withSignature=false); null/undefined → GET.
   */
  /** Options for downloading media files from Instagram's CDN (same User-Agent as the app). */
  _downloadRequestOptions(this: Client): { timeout: number; headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    if (this.userAgent) headers['User-Agent'] = this.userAgent;
    return { timeout: this.readTimeout, headers };
  }

  async privateRequest(this: Client, endpoint: string, data: any = null, opts: PrivateRequestOptions = {}): Promise<any> {
    let headers = opts.headers ? { ...opts.headers } : null;
    if (this.authorization) {
      if (!headers) headers = {};
      if (!('authorization' in headers)) headers.Authorization = this.authorization;
    }
    const extraArgs: PrivateRequestOptions = {
      params: opts.params ?? null,
      login: opts.login ?? false,
      withSignature: opts.withSignature ?? true,
      headers,
      extraSig: opts.extraSig ?? null,
      domain: opts.domain ?? null,
    };
    try {
      if (this.delayRange) await randomDelay(this.delayRange);
      this.privateRequestsCount += 1;
      await this._sendPrivateRequest(endpoint, data, extraArgs);
    } catch (e) {
      if (e instanceof ClientRequestTimeout) {
        this.logger.info('Wait 60 seconds and try one more time (ClientRequestTimeout)');
        await sleep(60);
        return this._sendPrivateRequest(endpoint, data, extraArgs);
      }
      if (e instanceof ClientIncompleteReadError) {
        this.logger.info('Wait 2 seconds and try one more time (ClientIncompleteReadError)');
        await sleep(2);
        return this._sendPrivateRequest(endpoint, data, extraArgs);
      }
      if (this.handleException) {
        await this.handleException(this, e);
      } else if (e instanceof ChallengeRequired) {
        if (!this.withChallengeFlow) throw e;
        await this.challengeResolve(this.lastJson);
      } else {
        throw e;
      }
      if (extraArgs.login && this.userId) {
        // After challenge resolve return last_json
        return this.lastJson;
      }
      return this._sendPrivateRequest(endpoint, data, extraArgs);
    }
    return this.lastJson;
  }
}
