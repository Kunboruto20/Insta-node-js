/**
 * Shared client state and constructor (initializes the state used by every mixin).
 */
import * as Boom from '@hapi/boom';
import * as config from './config';
import { Session, Proxies, Response } from './http/session';
import { getLogger, Logger } from './utils/logging';
import { deepcopy } from './utils/serialization';
import type { Client } from './client';

export type ChallengeCodeHandler = (username: string, choice?: any) => string | Promise<string> | null | undefined;
export type ChangePasswordHandler = (username: string) => string | Promise<string> | null | undefined;
export type HandleException = (client: Client, error: unknown) => void | Promise<void>;

export interface ClientOptions {
  /** saved settings (the JSON object produced by getSettings()/dumpSettings()) */
  settings?: Record<string, any> | null;
  /** e.g. "http://user:pass@host:port" or "socks5://host:port" */
  proxy?: string | null;
  /** random delay between requests in seconds, e.g. [1, 3] */
  delayRange?: number[] | null;
  logger?: Logger;
  overrideAppVersion?: boolean;
  tlsVerify?: boolean | string;
  requestTimeout?: number;
  publicRequestRetriesCount?: number;
  publicRequestRetriesTimeout?: number;
  sessionRetryTotal?: number;
  sessionRetryBackoffFactor?: number;
  sessionRetryStatuses?: number[];
  timezoneOffset?: number;
  timezoneName?: string;
  pushDisabled?: boolean;
  publicTransport?: 'http1' | 'http2';
  publicTransportImpersonate?: string;
  publicUserAgent?: string;
  publicGraphqlUserAgent?: string | null;
  publicAcceptLanguage?: string;
  withChallengeFlow?: boolean;
  privateTransport?: 'http1' | 'http2' | 'mobile';
  email?: string | null;
  phoneNumber?: string | null;
}

export const PUBLIC_HTTP2_USER_AGENTS: Record<string, string> = {
  chrome136: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
};
export const DEFAULT_PUBLIC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/11.1.2 Safari/605.1.15';
export const DEFAULT_PUBLIC_GRAPHQL_USER_AGENT =
  'Instagram 273.0.0.16.70 (iPhone15,2; iOS 17_5_1; en_US; en-US; scale=3.00; 1290x2796; 470085518)';

export class ClientBase {
  // ---- Client caches
  _users_cache: Record<string, any> = {};
  _userhorts_cache: Record<string, any> = {};
  _usernames_cache: Record<string, any> = {};
  _users_following: Record<string, any> = {};
  _users_followers: Record<string, any> = {};
  _medias_cache: Record<string, any> = {};
  _stories_cache: Record<string, any> = {};

  proxy: string | null = null;
  tlsVerify: boolean | string = true;
  requestTimeout = 1;
  readTimeout = 25;
  publicRequestRetriesCount = 3;
  publicRequestRetriesTimeout = 2;
  sessionRetryTotal = 3;
  sessionRetryBackoffFactor = 2;
  sessionRetryStatuses: number[] = [429, 500, 502, 503, 504];
  timezoneOffset = -14400; // New York, GMT-4 in seconds
  timezoneName = '';
  pushDisabled = true;
  settings: Record<string, any> = {};
  overrideAppVersion = false;
  logger: Logger;
  delayRange: number[] | null = null;

  // ---- PublicRequestMixin
  static PUBLIC_API_URL = 'https://www.instagram.com/';
  static GRAPHQL_PUBLIC_API_URL = 'https://www.instagram.com/graphql/query/';
  static GRAPHQL_PUBLIC_WEB_API_URL = 'https://www.instagram.com/api/graphql';
  PUBLIC_API_URL = ClientBase.PUBLIC_API_URL;
  GRAPHQL_PUBLIC_API_URL = ClientBase.GRAPHQL_PUBLIC_API_URL;
  GRAPHQL_PUBLIC_WEB_API_URL = ClientBase.GRAPHQL_PUBLIC_WEB_API_URL;
  public: Session;
  publicRequestsCount = 0;
  lastPublicResponse: Response | null = null;
  lastPublicJson: any = {};
  publicRequestLogger: Logger = getLogger('public_request');
  lastResponseTs = 0;
  publicTransport: 'http1' | 'http2' = 'http1';
  publicTransportImpersonate = 'chrome136';
  publicUserAgent: string = DEFAULT_PUBLIC_USER_AGENT;
  publicGraphqlUserAgent: string | null = DEFAULT_PUBLIC_GRAPHQL_USER_AGENT;
  publicAcceptLanguage = 'en-US';
  _publicUserAgentConfigured = false;

  // ---- PrivateRequestMixin
  private: Session;
  privateRequestsCount = 0;
  handleException: HandleException | null = null;
  withChallengeFlow = true;
  challengeCodeHandler!: ChallengeCodeHandler;
  changePasswordHandler!: ChangePasswordHandler;
  privateRequestLogger: Logger = getLogger('private_request');
  privateTransport: 'http1' | 'http2' | 'mobile' = 'http2';
  _privateAdapterTransport: string | null = null;
  domain = config.API_DOMAIN;
  lastResponse: Response | null = null;
  lastJson: any = {};
  _pigeonSessionId = '';
  email: string | null = null;
  phoneNumber: string | null = null;

  // ---- PrivateGraphQLRequestMixin
  graphql: Session;
  _fbDtsg: string | null = null;
  graphqlRequestsCount = 0;
  lastGraphqlResponse: Response | null = null;
  lastGraphqlJson: any = {};
  requestLogger: Logger = getLogger('graphql_request');

  // ---- LoginMixin
  username: string | null = null;
  password: string | null = null;
  authorizationData: Record<string, any> = {}; // decoded authorization header
  lastLogin: number | null = null;
  reloginAttempt = 0;
  deviceSettings: config.DeviceSettings = {};
  clientSessionId = '';
  traySessionId = '';
  advertisingId = '';
  androidDeviceId = '';
  requestId = '';
  phoneId = '';
  appId = '567067343352427';
  uuid = '';
  mid = '';
  country = 'US';
  countryCode = 1; // Phone code, default USA
  locale = 'en_US';
  // Example: CLN,49897488153,1666640702:01f7bdb93090f4f773516fc2cf1424178a58a2295b4c754090ba02cb0a834e2d1f731e20
  igURur = '';
  igWwwClaim = ''; // e.g. hmac.AR2uidim8es5kYgDiNxY0UG_ZhffFFSt8TGCV5eA1VYYsMNx
  bloksVersioningId = '';
  userAgent: string | null = null;
  _token: string | null = null;
  _timelineSeenPosts: string[] = [];

  // ---- DeviceAttestationMixin
  usdid = '';
  usdidKid = '';
  usdidPrivateKey = '';
  usdidRegistered = false;
  attestationChallengeNonce = '';
  attestationKeyNonce = '';
  _usdidHeaderCache = '';
  _usdidHeaderExpiresAt = 0;

  // ---- BloksMixin
  caaAac = '';
  caaWaterfallId = '';

  // ---- RealtimeMixin
  realtime: any = null;
  fbns: any = null;

  // ---- SignUpMixin
  waterfallId: string = cryptoUuid();
  adid: string = cryptoUuid();
  waitSeconds = 5;

  // ---- CaptchaHandlerMixin
  _captchaHandlerInstance: ((details: Record<string, any>) => string | Promise<string>) | null = null;

  /** IGTV composer session id (set by igtvUpload) */
  igtvComposerSessionId = '';

  /** used by userRelatedProfilesGql retry signal */
  numRetry?: number;

  constructor(options: ClientOptions = {}) {
    const self = this as unknown as Client;
    // ---- client state
    this.tlsVerify = options.tlsVerify ?? true;
    this.requestTimeout = options.requestTimeout ?? 1;
    this.publicRequestRetriesCount = options.publicRequestRetriesCount ?? 3;
    this.publicRequestRetriesTimeout = options.publicRequestRetriesTimeout ?? 2;
    this.sessionRetryTotal = options.sessionRetryTotal ?? 3;
    this.sessionRetryBackoffFactor = options.sessionRetryBackoffFactor ?? 2;
    this.sessionRetryStatuses = [...(options.sessionRetryStatuses ?? [429, 500, 502, 503, 504])];
    this.timezoneOffset = options.timezoneOffset ?? -14400;
    this.timezoneName = options.timezoneName ?? '';
    this.pushDisabled = options.pushDisabled ?? true;
    this.logger = options.logger ?? getLogger('insta-node-js');

    // ---- public (web) request state
    this.public = new Session();
    this.public.verify = this.tlsVerify;
    this.publicTransport = self._normalizePublicTransport(options.publicTransport ?? this.publicTransport);
    this.publicTransportImpersonate = options.publicTransportImpersonate ?? this.publicTransportImpersonate;
    this._publicUserAgentConfigured = options.publicUserAgent !== undefined;
    this.publicUserAgent =
      options.publicUserAgent ?? ClientBase._defaultPublicUserAgent(this.publicTransport, this.publicTransportImpersonate);
    if (options.publicGraphqlUserAgent !== undefined) this.publicGraphqlUserAgent = options.publicGraphqlUserAgent;
    this.publicAcceptLanguage = options.publicAcceptLanguage ?? this.publicAcceptLanguage;
    this.public.headers.update({
      Connection: 'Keep-Alive',
      Accept: '*/*',
      'Accept-Encoding': 'gzip,deflate',
      'Accept-Language': this.publicAcceptLanguage,
      'User-Agent': this.publicUserAgent,
    });
    self._configurePublicSessionRetry();

    // ---- private (mobile API) request state
    this.withChallengeFlow = options.withChallengeFlow ?? this.withChallengeFlow;
    this._pigeonSessionId = self.generateUuid('UFS-', '-1');
    this.private = new Session();
    this.private.verify = this.tlsVerify;
    this.privateTransport = self._normalizePrivateTransport(options.privateTransport ?? this.privateTransport);
    this.email = options.email ?? null;
    this.phoneNumber = options.phoneNumber ?? null;
    self._configurePrivateSessionRetry();
    this.challengeCodeHandler = (username, choice) => self.manualInputCode(username, choice);
    this.changePasswordHandler = (username) => self.manualChangePassword(username);

    // ---- private GraphQL request state
    this.graphql = new Session();
    this.graphql.verify = this.tlsVerify;
    this.graphql.headers.update({
      Connection: 'Keep-Alive',
      Accept: '*/*',
      'Accept-Encoding': 'gzip,deflate',
      'Accept-Language': 'en-US,en;q=0.9',
      origin: 'https://www.instagram.com',
      authority: 'www.instagram.com',
      'sec-fetch-site': 'same-origin',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    });

    // ---- login state
    this.bloksVersioningId = config.APP_SETTINGS[config.DEFAULT_APP_VERSION].bloks_versioning_id;
    this.userAgent = null;

    // ---- options
    this.settings = deepcopy(options.settings || {});
    this.overrideAppVersion = options.overrideAppVersion ?? false;
    this.delayRange = options.delayRange ?? null;
    self.setProxy(options.proxy ?? null);
    self.init();
  }

  static _defaultPublicUserAgent(publicTransport: string, impersonate: string): string {
    if (publicTransport === 'http2') return PUBLIC_HTTP2_USER_AGENTS[impersonate] ?? PUBLIC_HTTP2_USER_AGENTS.chrome136;
    return DEFAULT_PUBLIC_USER_AGENT;
  }

  setProxy(dsn: string | null | undefined): boolean {
    if (dsn) {
      if (typeof dsn !== 'string') throw Boom.badRequest(`Proxy must be a string (URL), got "${dsn}" (${typeof dsn})`);
      this.proxy = dsn;
      const proxyHref = /^[a-z][a-z0-9+.-]*:\/\//i.test(dsn) ? dsn : `http://${dsn}`;
      const proxies: Proxies = { http: proxyHref, https: proxyHref };
      this.public.proxies = { ...proxies };
      this.private.proxies = { ...proxies };
      if (this.graphql) this.graphql.proxies = { ...proxies };
      return true;
    }
    this.public.proxies = {};
    this.private.proxies = {};
    if (this.graphql) this.graphql.proxies = {};
    return false;
  }
}

function cryptoUuid(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:crypto').randomUUID();
}
