import { createHash, createHmac, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as config from '../config';
import {
  BadCredentials,
  BadPassword,
  ChallengeError,
  ClientError,
  ClientThrottledError,
  LoginRequired,
  PleaseWaitFewMinutes,
  PrivateError,
  ReloginAttemptExceeded,
  TwoFactorRequired,
  UnknownError,
} from '../exceptions';
import { CookieJar } from '../http/session';
import { ModelValidationError, UserShort, makeUserShort } from '../types';
import { genToken, generateJazoest } from '../utils/auth';
import { deepcopy, dumps, pyInt, pyJsonDumps } from '../utils/serialization';
import { now, randomChoice, randomInt } from '../utils/timing';
import type { Client } from '../client';

export type TIMELINE_FEED_REASON = 'cold_start_fetch' | 'warm_start_fetch' | 'pagination' | 'pull_to_refresh' | 'auto_refresh';
export type REELS_TRAY_REASON = 'cold_start' | 'pull_to_refresh';

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Python str() of a number that may be int or float */
export function pyNumStr(n: number, isFloat: boolean): string {
  if (!isFloat) return String(n);
  if (Number.isInteger(n)) return `${n}.0`;
  return String(n);
}

/**
 * Helpers for pre login flow
 */
export class PreLoginFlowMixin {
  /** Emulation mobile app behavior before login */
  async preLoginFlow(this: Client): Promise<boolean> {
    // this.setContactPointPrefill("prefill")
    // this.getPrefillCandidates(true)
    // this.setContactPointPrefill("prefill")
    await this.syncLauncher(true);
    // this.syncDeviceFeatures(true)
    return true;
  }

  /** Get prefill candidates value from Instagram */
  async getPrefillCandidates(this: Client, login = false): Promise<any> {
    const data: Record<string, any> = {
      android_device_id: this.androidDeviceId,
      client_contact_points: `[{"type":"omnistring","value":"${this.username}","source":"last_login_attempt"}]`,
      phone_id: this.phoneId,
      usages: '["account_recovery_omnibox"]',
      logged_in_user_ids: '[]', // "[\"123456789\",\"987654321\"]",
      device_id: this.uuid,
    };
    // if login is False:
    data._csrftoken = this.token;
    return this.privateRequest('accounts/get_prefill_candidates/', data, { login });
  }

  /** Sync device features to your Instagram account */
  async syncDeviceFeatures(this: Client, login = false): Promise<any> {
    const data: Record<string, any> = {
      id: this.uuid,
      server_config_retrieval: '1',
      // "experiments": config.LOGIN_EXPERIMENTS,
    };
    if (login === false) {
      data._uuid = this.uuid;
      data._uid = this.userIdInt;
      data._csrftoken = this.token;
    }
    // headers={"X-DEVICE-ID": self.uuid}
    return this.privateRequest('qe/sync/', data, { login });
  }

  /** Sync Launcher */
  async syncLauncher(this: Client, login = false): Promise<any> {
    const data: Record<string, any> = { id: this.uuid, server_config_retrieval: '1' };
    if (login === false) {
      data._uid = this.userIdInt;
      data._uuid = this.uuid;
      data._csrftoken = this.token;
    }
    return this.privateRequest('launcher/sync/', data, { login });
  }

  /** Contact point prefill */
  async setContactPointPrefill(this: Client, usage = 'prefill'): Promise<any> {
    const data = {
      phone_id: this.phoneId,
      usage,
      // "_csrftoken": self.token
    };
    return this.privateRequest('accounts/contact_point_prefill/', data, { login: true });
  }
}

/**
 * Helpers for post login flow
 */
export class PostLoginFlowMixin {
  /** Emulation mobile app behaivor after login */
  async loginFlow(this: Client): Promise<boolean> {
    const checkFlow: any[] = [];
    // chance = random.randint(1, 100) % 2 == 0
    // reason = "pull_to_refresh" if chance else "cold_start"
    checkFlow.push(await this.getReelsTrayFeed('cold_start'));
    checkFlow.push(await this.getTimelineFeed(['cold_start_fetch'] as any));
    return checkFlow.every((v) => pyTruthy(v));
  }

  _timelineMediaId(this: Client, media: Record<string, any>): string {
    const mediaId = media.id || media.media_id;
    if (mediaId) return String(mediaId);
    const pk = media.pk;
    const user = media.user || {};
    const userPk = user.pk || media.user_id || media.owner_id;
    if (pk && userPk) return `${pk}_${userPk}`;
    if (pk) return String(pk);
    return '';
  }

  _timelineSeenPostsFromResponse(this: Client, response: Record<string, any>): string[] {
    const mediaIds: string[] = [];
    for (const item of response?.feed_items || []) {
      if (!isDict(item)) continue;
      const media = item.media_or_ad || item.media;
      if (!isDict(media)) continue;
      const mediaId = this._timelineMediaId(media);
      if (mediaId) mediaIds.push(mediaId);
    }
    return mediaIds;
  }

  _rememberTimelineSeenPosts(this: Client, response: Record<string, any>): void {
    const remembered = [...(this._timelineSeenPosts || [])];
    const known = new Set(remembered);
    for (const mediaId of this._timelineSeenPostsFromResponse(response)) {
      if (known.has(mediaId)) continue;
      remembered.push(mediaId);
      known.add(mediaId);
    }
    this._timelineSeenPosts = remembered.slice(-200);
  }

  _joinTimelineSeenPosts(this: Client, seenPosts: string | Iterable<string> | null | undefined): string {
    if (!seenPosts) return '';
    if (typeof seenPosts === 'string') return seenPosts;
    const arr = Array.from(seenPosts);
    if (!arr.length) return '';
    return arr.filter((m) => m).map(String).join(',');
  }

  _timelineFeedViewInfo(this: Client, mediaIds: Iterable<string>): Record<string, any>[] {
    const latestTimestamp = Date.now();
    return Array.from(mediaIds, (mediaId) => ({
      media_id: String(mediaId),
      version: 24,
      media_pct: 1.0,
      time_info: { '10': 1, '25': 1, '50': 1, '75': 1 },
      latest_timestamp: latestTimestamp,
    }));
  }

  _timelineFeedViewInfoJson(this: Client, feedViewInfo: string | Record<string, any>[] | null | undefined, seenPosts: string): string {
    if (feedViewInfo !== null && feedViewInfo !== undefined) {
      if (typeof feedViewInfo === 'string') return feedViewInfo;
      return pyJsonDumps(feedViewInfo).replace(/"media_pct": 1(?=[,}])/g, '"media_pct": 1.0');
    }
    if (!seenPosts) return '[]';
    return pyJsonDumps(this._timelineFeedViewInfo(seenPosts.split(','))).replace(/"media_pct": 1(?=[,}])/g, '"media_pct": 1.0');
  }

  _timelineSessionLevelSignalsJson(this: Client): string {
    const inactiveTime = -1;
    return dumps({
      time_since_current_surface_session_start: 0,
      time_since_fg_session_start: 0,
      time_since_last_background: 0,
      num_ad_seen_current_surface_current_session: 0,
      app_entry: 'normal',
      last_surfaces_visited_current_session: [],
      video_play_count: 0,
      video_pause_count: 0,
      video_dwell_time_sum: 0,
      video_dwell_time_max: 0,
      video_view_count: 0,
      video_intentional_audio_on: 0,
      video_intentional_audio_off: 0,
      video_audio_on_count: 0,
      feed_to_reels_iv_entry: 0,
      time_since_last_ad_click: inactiveTime,
      time_since_last_ad_like: inactiveTime,
      time_since_last_organic_like: inactiveTime,
      time_since_last_like: inactiveTime,
      time_since_last_organic_business_profile_visit: inactiveTime,
      time_since_last_ad_imp: inactiveTime,
      time_since_last_search: inactiveTime,
      time_since_last_organic_engagement_event: inactiveTime,
      time_since_last_ad_profile_visit: inactiveTime,
      time_since_last_ad_cta: inactiveTime,
      time_since_last_ad_caption_more_click: inactiveTime,
      time_since_last_ad_comment_button: inactiveTime,
      time_since_last_ad_share: inactiveTime,
      time_since_last_ad_media_tap: inactiveTime,
      time_since_last_ad_gesture: inactiveTime,
      time_since_last_search_result_click: inactiveTime,
      time_since_last_serp_click: inactiveTime,
      time_since_last_organic_share: inactiveTime,
      time_since_last_organic_comment: inactiveTime,
      time_since_last_organic_caption_click: inactiveTime,
      time_since_last_organic_media_tap: inactiveTime,
      time_since_last_organic_gesture: inactiveTime,
      num_search_clicks_current_session: 0,
    });
  }

  /**
   * Get your timeline feed
   * @param reason cold_start_fetch, paginating, pull_to_refresh; Default "pull_to_refresh"
   * @param maxId cursor for the next feed chunk (response["next_max_id"])
   * @param seenPosts media ids already rendered by the caller. When omitted during pagination,
   *   ids from previous getTimelineFeed() responses are reused.
   * @param feedViewInfo JSON-serializable view telemetry.
   */
  async getTimelineFeed(
    this: Client,
    reason: TIMELINE_FEED_REASON = 'pull_to_refresh',
    maxId: string | null = null,
    seenPosts: string | Iterable<string> | null = null,
    feedViewInfo: string | Record<string, any>[] | null = null,
  ): Promise<any> {
    const headers = {
      'X-Ads-Opt-Out': '0',
      'X-DEVICE-ID': this.uuid,
      'X-CM-Bandwidth-KBPS': '-1.000', // str(random.randint(2000, 5000)),
      'X-CM-Latency': String(randomInt(1, 5)),
    };
    const requestTimeMs = String(Date.now());
    const data: Record<string, any> = {
      app_start_time: requestTimeMs,
      has_camera_permission: '1',
      feed_view_info: '[]', // e.g. [{"media_id":"2634223601739446191_7450075998","version":24,...}]
      client_recorded_request_time_ms: requestTimeMs,
      client_seen_store_media_list: '',
      client_view_state_media_list: '[]',
      device_timezone_name: this.timezoneName,
      feed_reshare_info: '',
      phone_id: this.phoneId,
      reason,
      battery_level: 100, // Random battery level is not simulating real bahaviour
      timezone_offset: String(this.timezoneOffset),
      // "_csrftoken": self.token, No longer in data
      device_id: this.uuid,
      include_attribution_ui_data: 'true',
      push_disabled: this._boolToIgString(this.pushDisabled),
      request_id: this.requestId,
      request_build_time: requestTimeMs,
      _uuid: this.uuid,
      is_charging: randomInt(0, 1),
      is_dark_mode: 1, // Random dark mode is not simulating real bahaviour
      will_sound_on: randomInt(0, 1),
      session_id: this.clientSessionId,
      session_level_signals: this._timelineSessionLevelSignalsJson(),
      bloks_versioning_id: this.bloksVersioningId,
    };
    data.is_pull_to_refresh = ['pull_to_refresh', 'auto_refresh'].includes(reason as string) ? '1' : '0';
    if (maxId) {
      data.max_id = maxId;
      data.reason = 'pagination';
      data.organic_realtime_information = '[]';
      data.pagination_source = 'feed_recs';
      data.triggered_by_visible_spinner = 'false';
      if (seenPosts === null || seenPosts === undefined) seenPosts = this._timelineSeenPosts || [];
    }
    const seenPostsValue = this._joinTimelineSeenPosts(seenPosts);
    if (seenPostsValue) data.seen_posts = seenPostsValue;
    data.feed_view_info = this._timelineFeedViewInfoJson(feedViewInfo, seenPostsValue);
    // if "push_disabled" in options: data["push_disabled"] = "true"
    // if "recovered_from_crash" in options: data["recovered_from_crash"] = "1"
    const result = await this.privateRequest('feed/timeline/', pyJsonDumps(data), { withSignature: false, headers });
    this._rememberTimelineSeenPosts(result);
    return result;
  }

  /** Get your reels tray feed. reason: cold_start, pull_to_refresh; Default "pull_to_refresh" */
  async getReelsTrayFeed(this: Client, reason: REELS_TRAY_REASON = 'pull_to_refresh'): Promise<any> {
    const data: Record<string, any> = {
      supported_capabilities_new: config.SUPPORTED_CAPABILITIES,
      reason,
      timezone_offset: String(this.timezoneOffset),
      tray_session_id: this.traySessionId,
      request_id: this.requestId,
      // "latest_preloaded_reel_ids": "[]",  # Long JSON array with reel data
      page_size: 50,
      // "_csrftoken": self.token,
      _uuid: this.uuid,
    };
    if (reason === 'cold_start') data.reel_tray_impressions = {};
    else data.reel_tray_impressions = { [String(this.userId)]: String(now()) };
    return this.privateRequest('feed/reels_tray/', data);
  }
}

export function pyTruthy(v: any): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

export class LoginMixin {
  _clearSessionState(
    this: Client,
    opts: {
      clearPrivateCookies?: boolean;
      clearPublicCookies?: boolean;
      clearAuthorizationData?: boolean;
      clearAuthorizationHeader?: boolean;
      clearLastLogin?: boolean;
      resetReloginAttempt?: boolean;
    } = {},
  ): void {
    if (opts.clearAuthorizationData) {
      this.authorizationData = {};
      this.setIgURur('');
      this.setIgWwwClaim('');
      for (const key of this.private.headers.keys()) {
        const name = key.toLowerCase();
        if (name.startsWith('ig-u-') || name === 'ig-intended-user-id' || name === 'x-ig-www-claim') this.private.headers.pop(key);
      }
      this.private.headers.update({ 'IG-INTENDED-USER-ID': '0', 'X-IG-WWW-Claim': '0' });
    }
    if (opts.clearLastLogin) this.lastLogin = null;
    if (opts.resetReloginAttempt) this.reloginAttempt = 0;
    if (opts.clearAuthorizationHeader) this.private.headers.pop('Authorization');
    if (opts.clearPrivateCookies) this.private.cookies.clear();
    if (opts.clearPublicCookies) {
      this.public.cookies.clear();
      this.graphql.cookies.clear();
    }
  }

  _findLoginResponseValue(this: Client, data: any, key: string): any {
    if (isDict(data)) {
      const value = data[key];
      if (pyTruthy(value)) return value;
      for (const child of Object.values(data)) {
        const v = this._findLoginResponseValue(child, key);
        if (pyTruthy(v)) return v;
      }
    } else if (Array.isArray(data)) {
      for (const child of data) {
        const v = this._findLoginResponseValue(child, key);
        if (pyTruthy(v)) return v;
      }
    }
    return null;
  }

  _extractTwoStepVerificationContext(this: Client, data: Record<string, any>): string {
    const value = this._findLoginResponseValue(data, 'two_step_verification_context');
    return typeof value === 'string' ? value.trim() : '';
  }

  _exceptionContext(this: Client, data: Record<string, any>): Record<string, any> {
    const context = deepcopy(data || {});
    const message = context.message;
    delete context.message;
    if (message !== undefined && message !== null) context.instagram_message = message;
    return context;
  }

  _loginResponseBool(this: Client, data: Record<string, any>, key: string): boolean {
    const value = this._findLoginResponseValue(data, key);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Boolean(value);
    if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
    return false;
  }

  _normalizeBackupCode(this: Client, code: string): string {
    return String(code).trim().replace(/[\s-]+/g, '');
  }

  _looksLikeBackupCode(this: Client, code: string): boolean {
    return /^\d{8}$/.test(this._normalizeBackupCode(code));
  }

  _inferBloksTwoFactorChallenge(this: Client, data: Record<string, any>, verificationCode = ''): string {
    if (this._looksLikeBackupCode(verificationCode)) return 'backup_codes';
    const smsEnabled = this._loginResponseBool(data, 'sms_two_factor_on');
    const totpEnabled = this._loginResponseBool(data, 'totp_two_factor_on');
    if (smsEnabled && !totpEnabled) return 'sms';
    return 'totp';
  }

  _isUnavailableCaaLoginError(this: Client, exc: ClientError): boolean {
    const statusCode = exc.response?.status_code || exc.code;
    const errorType = String(exc.error_type || '').toLowerCase();
    const message = String(exc.message || exc).toLowerCase();
    return statusCode === 404 || (errorType === 'field_exception' && message.includes('payload returned is null'));
  }

  /** Try current Android CAA login, propagating actionable login errors. */
  async _tryCaaLogin(this: Client, exc: any, verificationCode = ''): Promise<boolean> {
    let outcome: Record<string, any>;
    try {
      outcome = await this.bloksCaaLogin(verificationCode);
    } catch (caaExc: any) {
      if (caaExc instanceof ChallengeError || caaExc instanceof TwoFactorRequired) throw caaExc;
      if (caaExc instanceof ClientError) {
        if (!this._isUnavailableCaaLoginError(caaExc)) throw caaExc;
        this.logger.warning('CAA login fallback failed: %s', caaExc);
        return false;
      }
      throw caaExc;
    }
    if (outcome.logged_in) return true;
    const context = String(outcome.two_step_verification_context || '');
    if (!context) return false;
    if (!verificationCode.trim()) {
      throw new TwoFactorRequired(
        `${exc?.message ?? exc} (Instagram returned a Bloks two-factor context from the CAA login flow; ` +
          'provide verificationCode for login)',
        { response: exc?.response ?? null },
      );
    }
    return this._loginWithBloksTwoFactor(verificationCode, { two_step_verification_context: context }, exc);
  }

  async _loginWithBloksTwoFactor(this: Client, verificationCode: string, loginJson: Record<string, any>, exc: any): Promise<boolean> {
    const context = this._extractTwoStepVerificationContext(loginJson);
    if (!context) {
      throw new TwoFactorRequired(
        'Instagram rejected the legacy two-factor login endpoint and ' +
          'may require a newer Bloks-based two-factor verification flow, ' +
          'but the response did not include two_step_verification_context ' +
          'required for the Bloks two-factor fallback. Complete ' +
          'verification in the Instagram app or capture a fresh login ' +
          'response with the current app flow.',
        { response: exc?.response ?? null, ...this._exceptionContext(loginJson) },
      );
    }
    const challenge = this._inferBloksTwoFactorChallenge(loginJson, verificationCode);
    await this.bloksTwoStepVerificationEntrypoint(context);
    await this.bloksTwoStepVerificationMethodPicker(context);
    await this.bloksTwoStepVerificationSelectMethod(context, challenge);
    if (challenge === 'backup_codes') await this.bloksTwoStepVerificationEnterBackupCode(context);
    const code = challenge === 'backup_codes' ? this._normalizeBackupCode(verificationCode) : verificationCode;
    const result = await this.bloksTwoStepVerificationVerifyCode(context, code, challenge);
    if (this.bloksApplyLoginResponse(result)) return true;
    throw new TwoFactorRequired(
      'Instagram accepted the Bloks two-factor verification request, but ' +
        'the response did not include an embedded login payload. Inspect ' +
        'the raw Bloks response and retry with the selected verification ' +
        'method required by the account.',
      { response: exc?.response ?? null, ...this._exceptionContext(loginJson) },
    );
  }

  /** Initialize Login helpers */
  init(this: Client): boolean {
    if ('cookies' in this.settings) this.private.cookies = CookieJar.fromDict(this.settings.cookies);
    else this._clearSessionState({ clearPrivateCookies: true });
    this.authorizationData = this.settings.authorization_data ?? {};
    this.lastLogin = this.settings.last_login ?? null;
    const timezoneOffset = this.settings.timezone_offset ?? this.timezoneOffset;
    const timezoneName = this.settings.timezone_name ?? this.timezoneName;
    const pushDisabled = this.settings.push_disabled ?? this.pushDisabled;
    const locale = this.settings.locale ?? this.locale;
    const country = this.settings.country ?? this.country;
    const countryCode = this.settings.country_code ?? this.countryCode;
    this.setTlsVerify('tls_verify' in this.settings ? this.settings.tls_verify : this.tlsVerify);
    const publicUserAgent = 'public_user_agent' in this.settings ? this.settings.public_user_agent : this.publicUserAgent;
    const restorePublicUserAgent = 'public_user_agent' in this.settings || this._publicUserAgentConfigured;
    const publicGraphqlUserAgent =
      'public_graphql_user_agent' in this.settings ? this.settings.public_graphql_user_agent : this.publicGraphqlUserAgent;
    this.setRetryConfig({
      requestTimeout: this.settings.request_timeout ?? this.requestTimeout,
      publicRequestRetriesCount: this.settings.public_request_retries_count ?? this.publicRequestRetriesCount,
      publicRequestRetriesTimeout: this.settings.public_request_retries_timeout ?? this.publicRequestRetriesTimeout,
      sessionRetryTotal: this.settings.session_retry_total ?? this.sessionRetryTotal,
      sessionRetryBackoffFactor: this.settings.session_retry_backoff_factor ?? this.sessionRetryBackoffFactor,
      sessionRetryStatuses: this.settings.session_retry_statuses ?? this.sessionRetryStatuses,
      publicTransport: this.settings.public_transport ?? null,
      privateTransport: this.settings.private_transport ?? null,
      publicTransportImpersonate: this.settings.public_transport_impersonate ?? null,
    });
    this.setPublicUserAgent(restorePublicUserAgent ? publicUserAgent : this.publicUserAgent, publicGraphqlUserAgent);
    this.setTimezoneOffset(timezoneOffset, timezoneName || null);
    this.setPushDisabled(pushDisabled);
    this.setDevice(this.settings.device_settings ?? null, false, true);
    this.setUserAgent(this.settings.user_agent ?? '');
    this.setUuids(this.settings.uuids || {});
    this.setLocale(locale);
    this.setCountry(country);
    this.setCountryCode(countryCode);
    this.mid = 'mid' in this.settings ? this.settings.mid : this.cookieDict.mid;
    this.setIgURur(this.settings.ig_u_rur ?? null);
    this.setIgWwwClaim(this.settings.ig_www_claim ?? null);
    this.setUsdidSettings(this.settings.usdid ?? null);
    // init headers
    const headers = this.baseHeaders;
    if (this.authorization) headers.Authorization = this.authorization;
    else this.private.headers.pop('Authorization');
    if (!this.igURur) this.private.headers.pop('IG-U-RUR');
    this.private.headers.update(headers);
    return true;
  }

  async _userShortFromPrivateStream(this: Client, userId: string): Promise<UserShort> {
    userId = String(userId);
    const profile = await this.userStreamByIdFlat(userId);
    if (!isDict(profile)) throw new PrivateError('Missing private stream profile payload');
    const username = profile.username;
    if (!username) throw new PrivateError('Missing username in private stream profile');
    const pk = profile.pk || profile.pk_id || userId;
    return makeUserShort({ pk: String(pk), username });
  }

  /** Login using session id */
  async loginBySessionid(this: Client, sessionid: string): Promise<boolean> {
    if (!(typeof sessionid === 'string' && sessionid.length > 30)) throw new Error('Invalid sessionid');
    const userMatch = sessionid.match(/^\d+/);
    if (!userMatch) throw new Error('Invalid sessionid');
    this.settings.cookies = { sessionid };
    this.init();
    const userId = userMatch[0];
    this.authorizationData = { ds_user_id: userId, sessionid, should_use_header_over_cookies: true };
    let user: { pk: string; username?: string | null };
    try {
      user = await this.userInfoV1(userId);
    } catch (e) {
      if (!(e instanceof PrivateError || e instanceof ModelValidationError)) throw e;
      try {
        user = await this._userShortFromPrivateStream(userId);
      } catch (e2) {
        if (!(e2 instanceof ClientError || e2 instanceof ModelValidationError || e2 instanceof TypeError)) throw e2;
        user = await this.userShortGql(userId);
      }
    }
    this.username = user.username ?? null;
    this.authorizationData.ds_user_id = String(user.pk);
    this.private.cookies.set('ds_user_id', String(user.pk));
    this.private.headers.update(this.baseHeaders);
    this.private.headers.update({ Authorization: this.authorization });
    return true;
  }

  /** Extract CAA step/action markers from the raw Bloks login payload. */
  _caaResultActionMarkers(this: Client, outcome: Record<string, any>): string[] {
    const markers: string[] = [];
    const result = outcome.result;
    if (isDict(result)) this._bloksCollectStrings(result, markers);
    return markers.filter((m) => m.startsWith('CAA_') && m.includes(':'));
  }

  /**
   * Log in using the current Android CAA flow.
   *
   * Existing sessions are validated before reuse. Rejected sessions are cleared and refreshed through CAA.
   * When Instagram's CAA response directs the client back to the legacy accounts flow
   * (CAA_LOGIN_FALLBACK:...), this method completes that step through loginLegacy so the typed
   * failure reason surfaces; use loginLegacy to select the legacy flow directly.
   */
  async login(this: Client, username: string | null = null, password: string | null = null, relogin = false, verificationCode = ''): Promise<boolean> {
    if (username && password) {
      this.username = username;
      this.password = password;
    }
    if (this.username === null || this.password === null) throw new BadCredentials('Both username and password must be provided.');
    if (typeof this.username === 'string') this.username = this.username.trim();
    if (relogin) {
      this._clearSessionState({
        clearAuthorizationData: true,
        clearAuthorizationHeader: true,
        clearPrivateCookies: true,
        clearPublicCookies: true,
      });
      if (this.reloginAttempt > 1) throw new ReloginAttemptExceeded();
      this.reloginAttempt += 1;
    }
    if (this.userId && !relogin) {
      try {
        await this.accountInfo();
      } catch (e) {
        if (e instanceof LoginRequired) return this.login(null, null, true, verificationCode);
        throw e;
      }
      return true;
    }
    if (!this.bloksVersioningId) {
      throw new ClientError(
        'CAA login requires bloks_versioning_id for the saved app profile. ' +
          'Load settings with overrideAppVersion=true to use the supported app profile, ' +
          'or provide the matching Bloks hash.',
      );
    }
    const outcome = await this.bloksCaaLogin(verificationCode);
    let logged = Boolean(outcome.logged_in);
    if (!logged) {
      const context = this._extractTwoStepVerificationContext(outcome);
      if (context) {
        const exc = new TwoFactorRequired(
          'Instagram returned a Bloks two-factor context from the CAA login flow; provide verificationCode for login',
          { response: this.lastResponse, ...this._exceptionContext(outcome) },
        );
        if (!verificationCode.trim()) throw exc;
        logged = await this._loginWithBloksTwoFactor(verificationCode, outcome, exc);
      }
      if (!logged) {
        const markers = this._caaResultActionMarkers(outcome);
        if (markers.some((m) => m.startsWith('CAA_LOGIN_FALLBACK:'))) {
          // Keep the first CAA evidence even if legacy login or its
          // CAA retry replaces last_response/last_json before failing.
          const initialOutcome = deepcopy(outcome);
          const initialResponse = this.lastResponse;
          try {
            return await this.loginLegacy(null, null, false, verificationCode);
          } catch (exc: any) {
            if (exc instanceof ClientError) {
              exc.caa_initial_outcome = initialOutcome;
              exc.caa_initial_response = initialResponse;
              exc.add_note(
                'The initial CAA attempt returned no session. Its private response is retained ' +
                  'in caa_initial_outcome/caa_initial_response; the later error may describe ' +
                  'a different login stage. Do not publish these raw attributes.',
              );
            }
            throw exc;
          }
        }
        const excContext = this._exceptionContext(outcome);
        if (markers.length) excContext.caa_actions = markers;
        throw new ClientError(String(outcome.reason || 'CAA login did not return a session'), {
          response: this.lastResponse,
          ...excContext,
        });
      }
    }
    await this.loginFlow();
    this.lastLogin = now();
    this.reloginAttempt = 0;
    return true;
  }

  /**
   * Login using the legacy accounts endpoint and its existing fallbacks.
   * An existing session is validated before it is reused. If Instagram rejects it, the saved
   * authorization state is cleared and the supplied credentials are used to log in again.
   */
  async loginLegacy(
    this: Client,
    username: string | null = null,
    password: string | null = null,
    relogin = false,
    verificationCode = '',
  ): Promise<boolean> {
    if (username && password) {
      this.username = username;
      this.password = password;
    }
    if (this.username === null || this.password === null) throw new BadCredentials('Both username and password must be provided.');
    if (typeof this.username === 'string') this.username = this.username.trim();
    if (relogin) {
      this._clearSessionState({
        clearAuthorizationData: true,
        clearAuthorizationHeader: true,
        clearPrivateCookies: true,
        clearPublicCookies: true,
      });
      if (this.reloginAttempt > 1) throw new ReloginAttemptExceeded();
      this.reloginAttempt += 1;
    }
    if (this.userId && !relogin) {
      try {
        await this.accountInfo();
      } catch (e) {
        if (e instanceof LoginRequired) return this.loginLegacy(null, null, true, verificationCode);
        throw e;
      }
      return true;
    }
    try {
      await this.preLoginFlow();
    } catch (e) {
      if (e instanceof PleaseWaitFewMinutes || e instanceof ClientThrottledError) {
        this.logger.warning('Ignore 429: Continue login');
        // The instagram application ignores this error
        // and continues to log in (repeat this behavior)
      } else throw e;
    }
    const encPassword = await this.passwordEncrypt(this.password!);
    const data = {
      jazoest: generateJazoest(this.phoneId),
      country_codes: `[{"country_code":"${Math.trunc(Number(this.countryCode))}","source":["default"]}]`,
      phone_id: this.phoneId,
      enc_password: encPassword,
      username: this.username,
      adid: this.advertisingId,
      guid: this.uuid,
      device_id: this.androidDeviceId,
      google_tokens: '[]',
      login_attempt_count: '0',
    };
    let logged: any;
    try {
      logged = await this.privateRequest('accounts/login/', data, { login: true });
      this.authorizationData = this.parseAuthorization(this.lastResponse?.headers.get('ig-set-authorization'));
    } catch (exc: any) {
      if (exc instanceof BadPassword) {
        const loginJson = isDict(this.lastJson) ? deepcopy(this.lastJson) : {};
        const context = this._extractTwoStepVerificationContext(loginJson);
        if (!context) {
          logged = await this._tryCaaLogin(exc, verificationCode);
          if (!logged) throw exc;
        } else if (!verificationCode.trim()) {
          throw new TwoFactorRequired(
            `${exc.message} (Instagram returned a Bloks two-factor context; provide verificationCode for login)`,
            { response: exc.response ?? null, ...this._exceptionContext(loginJson) },
          );
        } else {
          logged = await this._loginWithBloksTwoFactor(verificationCode, loginJson, exc);
        }
      } else if (exc instanceof UnknownError) {
        // Newer Instagram login responses may classify an obsolete
        // legacy client as ``needs_upgrade`` instead of ``bad_password``.
        // Route only that specific login error through the existing CAA
        // flow; unrelated UnknownError responses must keep their original behavior.
        const errorType = String(exc.error_type || '').trim().toLowerCase();
        if (errorType !== 'needs_upgrade') throw exc;
        logged = await this._tryCaaLogin(exc, verificationCode);
        if (!logged) throw exc;
      } else if (exc instanceof TwoFactorRequired) {
        if (!verificationCode.trim()) throw new TwoFactorRequired(`${exc.message} (you did not provide verificationCode for login method)`);
        const twoFactorJson = isDict(this.lastJson) ? deepcopy(this.lastJson) : {};
        if (this._looksLikeBackupCode(verificationCode) && this._extractTwoStepVerificationContext(twoFactorJson)) {
          logged = await this._loginWithBloksTwoFactor(verificationCode, twoFactorJson, exc);
        } else {
          const twoFactorIdentifier = (this.lastJson.two_factor_info || {}).two_factor_identifier;
          const data2 = {
            verification_code: verificationCode,
            phone_id: this.phoneId,
            _csrftoken: this.token,
            two_factor_identifier: twoFactorIdentifier,
            username: this.username,
            trust_this_device: '0',
            guid: this.uuid,
            device_id: this.androidDeviceId,
            waterfall_id: randomUUID(),
            verification_method: '3',
          };
          let ok = false;
          try {
            logged = await this.privateRequest('accounts/two_factor_login/', data2, { login: true });
            ok = true;
          } catch (exc2: any) {
            if (exc2 instanceof UnknownError) {
              const message = exc2.message || '';
              if (message.trim().toLowerCase() === 'invalid parameters') {
                logged = await this._loginWithBloksTwoFactor(verificationCode, twoFactorJson, exc2);
              } else throw exc2;
            } else throw exc2;
          }
          if (ok) this.authorizationData = this.parseAuthorization(this.lastResponse?.headers.get('ig-set-authorization'));
        }
      } else {
        throw exc;
      }
    }
    if (pyTruthy(logged)) {
      await this.loginFlow();
      this.lastLogin = now();
      this.reloginAttempt = 0;
      return true;
    }
    return false;
  }

  /** One tap login emulation. nonce: login nonce (from Instagram, e.g. in /logout/) */
  async oneTapAppLogin(this: Client, userId: string | number, nonce: string): Promise<any> {
    const data = {
      phone_id: this.phoneId,
      user_id: Number(userId),
      adid: this.advertisingId,
      guid: this.uuid,
      device_id: this.uuid,
      login_nonce: nonce,
      _csrftoken: this.token,
    };
    return this.privateRequest('accounts/one_tap_app_login/', data);
  }

  /** Relogin helper */
  async relogin(this: Client): Promise<boolean> {
    return this.login(this.username, this.password, true);
  }

  get cookieDict(): Record<string, string> {
    return (this as unknown as Client).private.cookies.getDict();
  }

  get sessionid(): string | undefined {
    const self = this as unknown as Client;
    let sessionid = self.cookieDict.sessionid;
    if (!sessionid && pyTruthy(self.authorizationData)) sessionid = self.authorizationData.sessionid;
    return sessionid;
  }

  /** CSRF token, e.g. vUJGjpst6szjI38mZ6Pb1dROsWVerZelGSYGe0W1tuugpSUefVjRLj2Pom2SWNoA */
  get token(): string {
    const self = this as unknown as Client;
    if (!self._token) self._token = self.cookieDict.csrftoken ?? genToken(64);
    return self._token!;
  }

  get rankToken(): string {
    const self = this as unknown as Client;
    return `${self.userId}_${self.uuid}`;
  }

  /** Logged-in user id as string (Instagram ids can exceed Number.MAX_SAFE_INTEGER) */
  get userId(): string | null {
    const self = this as unknown as Client;
    let userId: any = self.cookieDict.ds_user_id;
    if (!userId && pyTruthy(self.authorizationData)) userId = self.authorizationData.ds_user_id;
    if (userId) return BigInt(String(userId).trim()).toString();
    return null;
  }

  /** user id as python int (number, or BigInt beyond the safe range) — used where python serializes the int */
  get userIdInt(): number | bigint | null {
    const self = this as unknown as Client;
    const id = self.userId;
    return id === null ? null : pyInt(id);
  }

  get device(): Record<string, any> {
    const self = this as unknown as Client;
    const out: Record<string, any> = {};
    for (const [key, val] of Object.entries(self.deviceSettings)) {
      if (['manufacturer', 'model', 'android_version', 'android_release'].includes(key)) out[key] = val;
    }
    return out;
  }

  /** Get current session settings */
  getSettings(this: Client): Record<string, any> {
    const settings: Record<string, any> = {
      uuids: {
        phone_id: this.phoneId,
        uuid: this.uuid,
        client_session_id: this.clientSessionId,
        advertising_id: this.advertisingId,
        android_device_id: this.androidDeviceId,
        // "device_id": self.uuid,
        request_id: this.requestId,
        tray_session_id: this.traySessionId,
      },
      mid: this.mid,
      ig_u_rur: this.igURur,
      ig_www_claim: this.igWwwClaim,
      authorization_data: this.authorizationData,
      cookies: this.private.cookies.getDict(),
      last_login: this.lastLogin,
      device_settings: this.deviceSettings,
      user_agent: this.userAgent,
      country: this.country,
      country_code: this.countryCode,
      locale: this.locale,
      timezone_offset: this.timezoneOffset,
      timezone_name: this.timezoneName,
      push_disabled: this.pushDisabled,
      request_timeout: this.requestTimeout,
      public_request_retries_count: this.publicRequestRetriesCount,
      public_request_retries_timeout: this.publicRequestRetriesTimeout,
      session_retry_total: this.sessionRetryTotal,
      session_retry_backoff_factor: this.sessionRetryBackoffFactor,
      session_retry_statuses: this.sessionRetryStatuses,
      public_transport: this.publicTransport,
      public_user_agent: this.publicUserAgent,
      public_graphql_user_agent: this.publicGraphqlUserAgent,
      private_transport: this.privateTransport,
      public_transport_impersonate: this.publicTransportImpersonate,
      tls_verify: this.tlsVerify,
    };
    let fbnsAuth: any = null;
    if (this.fbns && this.fbns.auth) {
      fbnsAuth = this.fbns.auth.toSettings();
      if (this.settings) this.settings.fbns_auth = deepcopy(fbnsAuth);
    } else if (this.settings && this.settings.fbns_auth !== undefined && this.settings.fbns_auth !== null) {
      fbnsAuth = deepcopy(this.settings.fbns_auth);
    }
    if (pyTruthy(fbnsAuth)) settings.fbns_auth = fbnsAuth;
    const usdidSettings = this.getUsdidSettings();
    if (pyTruthy(usdidSettings)) settings.usdid = usdidSettings;
    return settings;
  }

  /** Set session settings */
  setSettings(this: Client, settings: Record<string, any>): boolean {
    this.settings = deepcopy(settings);
    this.init();
    return true;
  }

  /**
   * Load session settings
   * @param overrideAppVersion Mismatched app_version/version_code/bloks_versioning_id may increase risk.
   *   If true, override with a known version from APP_SETTINGS (in memory). Call dumpSettings() to persist.
   */
  async loadSettings(this: Client, filePath: string, overrideAppVersion = false): Promise<Record<string, any>> {
    this.overrideAppVersion = overrideAppVersion;
    const content = await fsp.readFile(filePath, 'utf8');
    this.setSettings(JSON.parse(content));
    return this.settings;
  }

  /** Serialize and save session settings */
  async dumpSettings(this: Client, filePath: string): Promise<boolean> {
    await fsp.writeFile(filePath, pyJsonIndent(this.getSettings()));
    return true;
  }

  setTlsVerify(this: Client, tlsVerify: boolean | string): boolean {
    this.tlsVerify = tlsVerify;
    for (const session of [this.public, this.private, this.graphql]) if (session) session.verify = tlsVerify;
    if (this.settings) this.settings.tls_verify = tlsVerify;
    return true;
  }

  setRetryConfig(
    this: Client,
    opts: {
      requestTimeout?: number | null;
      publicRequestRetriesCount?: number | null;
      publicRequestRetriesTimeout?: number | null;
      sessionRetryTotal?: number | null;
      sessionRetryBackoffFactor?: number | null;
      sessionRetryStatuses?: number[] | null;
      publicTransport?: 'requests' | 'curl' | null;
      publicTransportImpersonate?: string | null;
      privateTransport?: 'requests' | 'curl' | 'utls' | null;
    } = {},
  ): boolean {
    let privateTransport = opts.privateTransport ?? null;
    if (privateTransport !== null) privateTransport = this._normalizePrivateTransport(privateTransport);
    if (opts.requestTimeout !== null && opts.requestTimeout !== undefined) this.requestTimeout = opts.requestTimeout;
    if (opts.publicRequestRetriesCount !== null && opts.publicRequestRetriesCount !== undefined) this.publicRequestRetriesCount = opts.publicRequestRetriesCount;
    if (opts.publicRequestRetriesTimeout !== null && opts.publicRequestRetriesTimeout !== undefined) this.publicRequestRetriesTimeout = opts.publicRequestRetriesTimeout;
    if (opts.sessionRetryTotal !== null && opts.sessionRetryTotal !== undefined) this.sessionRetryTotal = opts.sessionRetryTotal;
    if (opts.sessionRetryBackoffFactor !== null && opts.sessionRetryBackoffFactor !== undefined) this.sessionRetryBackoffFactor = opts.sessionRetryBackoffFactor;
    if (opts.sessionRetryStatuses !== null && opts.sessionRetryStatuses !== undefined) this.sessionRetryStatuses = [...opts.sessionRetryStatuses];
    const pt = opts.publicTransport ?? null;
    const pti = opts.publicTransportImpersonate ?? null;
    if (pt !== null) this.publicTransport = this._normalizePublicTransport(pt);
    if (pti !== null) this.publicTransportImpersonate = pti;
    if (pt !== null || pti !== null) {
      this.publicUserAgent = this._defaultPublicUserAgent(this.publicTransport, this.publicTransportImpersonate);
      this.public.headers.set('User-Agent', this.publicUserAgent);
    }
    this._configurePublicSessionRetry();
    this._configurePrivateSessionRetry(privateTransport);
    if (this.settings) {
      Object.assign(this.settings, {
        request_timeout: this.requestTimeout,
        public_request_retries_count: this.publicRequestRetriesCount,
        public_request_retries_timeout: this.publicRequestRetriesTimeout,
        session_retry_total: this.sessionRetryTotal,
        session_retry_backoff_factor: this.sessionRetryBackoffFactor,
        session_retry_statuses: this.sessionRetryStatuses,
        public_transport: this.publicTransport,
        public_user_agent: this.publicUserAgent,
        public_graphql_user_agent: this.publicGraphqlUserAgent,
        private_transport: this.privateTransport,
        public_transport_impersonate: this.publicTransportImpersonate,
      });
    }
    return true;
  }

  /**
   * Helper to set a device for login.
   *
   * Each call starts from library defaults and overlays `device`; it does not merge with the current
   * profile. For hardware-only changes, pass {...client.deviceSettings, ...hardwareUpdates}.
   */
  setDevice(this: Client, device: Record<string, any> | null = null, reset = false, hydrateAppProfile = false): boolean {
    device = device || {};
    this.deviceSettings = { ...config.DEVICE_SETTINGS, ...device };
    let seed: string | null = null;
    if (pyTruthy(this.settings)) {
      const uuids = this.settings.uuids || {};
      seed = uuids.uuid ?? null;
    }
    this.setApp(null, seed, hydrateAppProfile);
    this.setUserAgent();
    if (reset) this.setUuids({});
    return true;
  }

  /** Helper to set app version settings (version string or settings dict) */
  setApp(this: Client, app: string | Record<string, any> | null = null, seed: string | null = null, hydrateIncompleteProfile = false): boolean {
    const appKeys = ['app_version', 'version_code', 'bloks_versioning_id'];
    if (!pyTruthy(this.deviceSettings)) this.deviceSettings = { ...config.DEVICE_SETTINGS };
    if (!Object.keys(config.APP_SETTINGS).length) throw new Error('APP_SETTINGS is empty');
    const overrideAppVersion = Boolean(this.overrideAppVersion);
    const applySettings = (appSettings: Record<string, any>) => {
      for (const key of appKeys) {
        const val = appSettings[key];
        if (val) this.deviceSettings[key] = val;
      }
    };
    const pickBySeed = () => {
      const appValues = Object.values(config.APP_SETTINGS);
      if (seed) {
        const digest = createHash('sha256').update(seed, 'utf8').digest('hex');
        const idx = Number(BigInt('0x' + digest) % BigInt(appValues.length));
        return appValues[idx];
      }
      return randomChoice(appValues);
    };
    const defaultSettings = () => config.APP_SETTINGS[config.DEFAULT_APP_VERSION] || pickBySeed();
    const isCurrentOrNewerAppVersion = (value: any): boolean => {
      const parse = (v: string) => v.split('.').map((p) => {
        if (!/^\s*[+-]?\d+\s*$/.test(p)) throw new Error('ValueError');
        return parseInt(p, 10);
      });
      try {
        const version = parse(String(value));
        const def = parse(config.DEFAULT_APP_VERSION);
        for (let i = 0; i < Math.max(version.length, def.length); i++) {
          if (i >= version.length) return false;
          if (i >= def.length) return true;
          if (version[i] !== def[i]) return version[i] > def[i];
        }
        return true;
      } catch {
        return false;
      }
    };
    if (app) {
      if (typeof app === 'string') {
        const matched = config.APP_SETTINGS[app];
        if (!matched) throw new Error(`Unknown app_version: ${app}`);
        applySettings(matched);
      } else applySettings({ ...app });
    } else {
      const appVersion = this.deviceSettings.app_version;
      const matched = appVersion ? config.APP_SETTINGS[appVersion] : null;
      if (matched && !overrideAppVersion) applySettings(matched);
      else {
        const hasCompleteAppProfile = appKeys.every((k) => this.deviceSettings[k]);
        const shouldHydrate = hydrateIncompleteProfile && !hasCompleteAppProfile && isCurrentOrNewerAppVersion(appVersion);
        if (overrideAppVersion || !appVersion || shouldHydrate) applySettings(defaultSettings());
      }
    }
    if (overrideAppVersion) this.setUserAgent();
    this.bloksVersioningId = this.deviceSettings.bloks_versioning_id ?? '';
    if (this.settings) this.settings.device_settings = this.deviceSettings;
    return true;
  }

  /** Helper to set user agent */
  setUserAgent(this: Client, userAgent = '', reset = false): boolean {
    const data = { ...this.deviceSettings, locale: this.locale };
    this.userAgent = userAgent || config.formatTemplate(config.USER_AGENT_BASE, data);
    // self.private.headers.update({"User-Agent": self.user_agent})  # changed in base_headers
    this.settings.user_agent = this.userAgent;
    if (reset) this.setUuids({});
    return true;
  }

  /** Helper to set uuids */
  setUuids(this: Client, uuids: Record<string, any> = {}): boolean {
    const previousPhoneId = this.phoneId;
    this.phoneId = uuids.phone_id ?? this.generateUuid();
    this.uuid = uuids.uuid ?? this.generateUuid();
    this.clientSessionId = uuids.client_session_id ?? this.generateUuid();
    this.advertisingId = uuids.advertising_id ?? this.generateUuid();
    this.androidDeviceId = uuids.android_device_id ?? this.generateAndroidDeviceId();
    this.requestId = uuids.request_id ?? this.generateUuid();
    this.traySessionId = uuids.tray_session_id ?? this.generateUuid();
    // self.device_id = uuids.get("device_id", self.generate_uuid())
    this.settings.uuids = uuids;
    if (previousPhoneId && previousPhoneId !== this.phoneId) this.setUsdidSettings({});
    return true;
  }

  /** Helper to generate uuids */
  generateUuid(this: Client, prefix = '', suffix = ''): string {
    return `${prefix}${randomUUID()}${suffix}`;
  }

  /** Token used when DM sending and upload media */
  generateMutationToken(this: Client): string {
    const min = 6800011111111111111n;
    const max = 6800099999999999999n;
    const range = max - min + 1n;
    const rnd = BigInt('0x' + require('node:crypto').randomBytes(8).toString('hex')) % range;
    return (min + rnd).toString();
  }

  /** Helper to generate Android Device ID */
  generateAndroidDeviceId(this: Client): string {
    return 'android-' + createHash('sha256').update(String(now())).digest('hex').slice(0, 16);
  }

  /** Helper to expose */
  async expose(this: Client): Promise<any> {
    const data = { id: this.uuid, experiment: 'ig_android_profile_contextual_feed' };
    return this.privateRequest('qe/expose/', this.withDefaultData(data));
  }

  /** Helper to get extra data */
  withExtraData(this: Client, data: Record<string, any>): Record<string, any> {
    return this.withDefaultData({ phone_id: this.phoneId, _uid: String(this.userId), guid: this.uuid, ...data });
  }

  /** Helper to get default data */
  withDefaultData(this: Client, data: Record<string, any>): Record<string, any> {
    return {
      _uuid: this.uuid,
      // "_uid": str(self.user_id),
      // "_csrftoken": self.token,
      device_id: this.androidDeviceId,
      ...data,
    };
  }

  /** Helper to get action data */
  withActionData(this: Client, data: Record<string, any>): Record<string, any> {
    return { ...this.withDefaultData({ radio_type: 'wifi-none' }), ...data };
  }

  /** Helper to generate user breadcrumbs */
  genUserBreadcrumb(this: Client, size: number): string {
    const key = 'iN4$aGr0m';
    const dt = Date.now();
    const timeElapsed = randomInt(500, 1500) + size * randomInt(500, 1500);
    const divided = size / randomInt(3, 5);
    const count = divided > 1 ? pyNumStr(divided, true) : '1';
    const data = `${size} ${timeElapsed} ${count} ${dt}`;
    const sig = createHmac('sha256', Buffer.from(key, 'ascii')).update(Buffer.from(data, 'ascii')).digest('base64');
    // python formats bytes objects with "{!s}" → b'...'
    return `b'${sig}'\nb'${Buffer.from(data, 'ascii').toString('base64')}'\n`;
  }

  /** Inject sessionid from private session to public session */
  injectSessionidToPublic(this: Client): boolean {
    const sessionid = this.sessionid;
    if (sessionid) {
      this.public.cookies.set('sessionid', sessionid);
      this.graphql.cookies.set('sessionid', sessionid);
      return true;
    }
    return false;
  }

  async logout(this: Client): Promise<boolean> {
    const result = await this.privateRequest('accounts/logout/', { one_tap_app_login: true });
    if (result.status === 'ok') {
      this._clearSessionState({
        clearAuthorizationData: true,
        clearLastLogin: true,
        resetReloginAttempt: true,
        clearAuthorizationHeader: true,
        clearPrivateCookies: true,
        clearPublicCookies: true,
      });
      return true;
    }
    return false;
  }

  /** Parse authorization header */
  parseAuthorization(this: Client, authorization: string | null | undefined): Record<string, any> {
    if (!authorization) return {};
    try {
      const b64part = authorization.slice(authorization.lastIndexOf(':') + 1);
      if (!b64part) return {};
      return JSON.parse(Buffer.from(b64part, 'base64').toString('utf8'));
    } catch (e) {
      this.logger.exception(e);
    }
    return {};
  }

  /** Build authorization header. Example: Bearer IGT:2:eaW9u.....aWQiOiI0NzM5= */
  get authorization(): string {
    const self = this as unknown as Client;
    if (pyTruthy(self.authorizationData)) {
      const b64part = Buffer.from(dumps(self.authorizationData)).toString('base64');
      return `Bearer IGT:2:${b64part}`;
    }
    return '';
  }

  dumpInstaman(this: Client): string {
    // Example format: helen9151hernandez:AgcXb0GJhAP|Instagram 200.0.0.24.121 Android...
    // Long string with user credentials and device info
    const uuids = [this.androidDeviceId.replace('android-', ''), this.uuid, this.phoneId, this.clientSessionId].join(';');
    const headers: Record<string, any> = {
      'X-MID': this.mid,
      'IG-U-DS-USER-ID': this.userId,
      'IG-U-RUR': this.igURur,
      Authorization: this.authorization,
      'X-IG-WWW-Claim': this.igWwwClaim || '0',
    };
    const headersStr = Object.entries(headers)
      .map(([k, v]) => `${k}=${v === null || v === undefined ? 'None' : v}`)
      .join(';');
    return `${this.username}:${this.password}|${this.userAgent}|${uuids}|${headersStr};||`;
  }
}

/** json.dump(..., indent=4) equivalent */
export function pyJsonIndent(data: any): string {
  return JSON.stringify(data, null, 4).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
