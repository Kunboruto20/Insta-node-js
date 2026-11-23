import * as Boom from '@hapi/boom';
import {
  ClientError,
  ClientGraphqlError,
  ClientJSONDecodeError,
  ClientLoginRequired,
  ClientNotFoundError,
  InvalidTargetUser,
  RelatedProfileRequired,
  UnknownError,
  UserNotFound,
} from '../core/errorClasses';
import { extractAboutV1, extractGuideV1, extractUserGql, extractUserShort, extractUserV1 } from '../parsing/responseParsers';
import { JSONDecodeError, RequestException } from '../net/httpClient';
import {
  About,
  AddressBookContact,
  Guide,
  Relationship,
  RelationshipShort,
  User,
  UserShort,
  makeRelationship,
  makeRelationshipShort,
} from '../models/schemas';
import { iterPaginated } from '../helpers/pagination';
import { getLogger } from '../helpers/logger';
import { deepcopy, dumps, jsonValue } from '../helpers/encoding';
import { ensure } from '../helpers/assertions';
import { PUBLIC_WEB_APP_ID, PUBLIC_WEB_ASBD_ID } from './webApi';
import type { Client } from '../core/instaClient';

export const MAX_USER_COUNT = 200;
export const INFO_FROM_MODULES = ['self_profile', 'feed_timeline', 'reel_feed_timeline'] as const;
export const FOLLOWERS_ORDERS = ['date_followed_latest', 'date_followed_earliest'] as const;
export const USER_WEB_PROFILE_DOC_ID = '28036671149327607';
export const USER_INFO_V2_DOC_ID = USER_WEB_PROFILE_DOC_ID;
export const USER_INFO_BY_USERNAME_V2_DOC_ID = '26347858941511777';
export const ADDRESS_BOOK_DEFAULT_INCLUDE = ['extra_display_name', 'thumbnails'];
export const USER_REPORT_REASONS: Record<string, [string, string, string]> = {
  spam: ['ig_report_account', 'ig_its_inappropriate', 'ig_spam_v3'],
};

const logger = getLogger('insta-node-js.user');

export type INFO_FROM_MODULE = (typeof INFO_FROM_MODULES)[number];
export type FOLLOWERS_ORDER = (typeof FOLLOWERS_ORDERS)[number];
export type USER_REPORT_REASON = 'spam';
export type UserBlockSurface = 'profile' | 'direct_thread_info';

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function withoutKeys(obj: any, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj || {})) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** Helpers to manage user */
export class UserFeature {
  _normalizeUsername(this: Client, username: string): string {
    return String(username).trim().replace(/^@+/, '').trim().toLowerCase();
  }

  _hasPrivateAuth(this: Client): boolean {
    return Boolean(this.authorization || this.sessionid);
  }

  /** Allow endpoint/schema fallback, never restriction or transport recovery. */
  _canUsePrivateGraphqlFallback(this: Client, error: unknown): boolean {
    return (
      (error instanceof Error && error.constructor === ClientError) ||
      error instanceof ClientGraphqlError ||
      error instanceof ClientJSONDecodeError ||
      error instanceof ClientNotFoundError
    );
  }

  async _userInfoByUsernamePublic(this: Client, username: string): Promise<User> {
    try {
      return await this.userInfoByUsernameV2Gql(username);
    } catch (e) {
      if (e instanceof ClientLoginRequired) {
        if (!this.injectSessionidToPublic()) throw e;
        return this.userInfoByUsernameV2Gql(username);
      }
      throw e;
    }
  }

  async _userInfoPublic(this: Client, userId: string): Promise<User> {
    try {
      return await this.userInfoGql(userId);
    } catch (e) {
      if (e instanceof ClientLoginRequired) {
        if (!this.injectSessionidToPublic()) throw e;
        return this.userInfoGql(userId);
      }
      throw e;
    }
  }

  /** Get user id (pk) from username. Example: 'example' -> '1903424587' */
  async userIdFromUsername(this: Client, username: string): Promise<string> {
    username = this._normalizeUsername(username);
    return String((await this.userInfoByUsername(username)).pk);
  }

  /** Get UserShort by user id (web profile GraphQL) */
  async userShortGql(this: Client, userId: string | number, useCache = true): Promise<UserShort> {
    const key = String(userId);
    if (useCache) {
      const cache = this._userhorts_cache[key];
      if (cache) return cache;
    }
    const user = extractUserShort(await this.userWebProfileInfoGql(key));
    this._userhorts_cache[key] = user;
    return user;
  }

  async fetchFbDtsg(this: Client): Promise<string | null> {
    this.injectSessionidToPublic();
    const response = await this.public.get(this.PUBLIC_API_URL, { proxies: this.public.proxies, timeout: this.readTimeout });
    const html = response.text;
    if (html) {
      const start = html.indexOf('__eqmc');
      if (start >= 0) {
        const chunk = html.slice(start).slice(0, 5000);
        const chunkStart = chunk.indexOf('{');
        const chunkEnd = chunk.indexOf('</script>');
        if (chunkStart >= 0 && chunkEnd > chunkStart) return JSON.parse(chunk.slice(chunkStart, chunkEnd)).f ?? null;
      }
    }
    return null;
  }

  async getFbDtsg(this: Client): Promise<string | null> {
    if (!this._fbDtsg) this._fbDtsg = await this.fetchFbDtsg();
    return this._fbDtsg;
  }

  async userWebProfileInfoGql(this: Client, userId: string | number): Promise<Record<string, any>> {
    const id = String(userId);
    if (!this.injectSessionidToPublic()) throw new ClientLoginRequired('Session is required for web profile GraphQL');
    const variables = {
      enable_integrity_filters: true,
      id,
      render_surface: 'PROFILE',
      __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
      __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
      __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
      __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: false,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
    };
    const data = await this.publicDocIdGraphqlRequest(USER_WEB_PROFILE_DOC_ID, variables, { referer: `https://www.instagram.com/${id}/` });
    if (!data || !data.user) throw new UserNotFound({ user_id: id, ...(data || {}) });
    return data.user;
  }

  /** Get username from user id (GraphQL). Example: 1903424587 -> 'example' */
  async usernameFromUserIdGql(this: Client, userId: string | number): Promise<string> {
    return (await this.userShortGql(String(userId))).username!;
  }

  /** Get username from user id. Example: 1903424587 -> 'example' */
  async usernameFromUserId(this: Client, userId: string | number): Promise<string> {
    const id = String(userId);
    if (this._hasPrivateAuth()) {
      try {
        return (await this.userInfoV1(id)).username;
      } catch (e) {
        if (e instanceof ClientError) return this.usernameFromUserIdGql(id);
        throw e;
      }
    }
    try {
      return await this.usernameFromUserIdGql(id);
    } catch (e) {
      if (e instanceof ClientError) return (await this.userInfoV1(id)).username;
      throw e;
    }
  }

  /** Get user object from user name (web_profile_info) */
  async userInfoByUsernameGql(this: Client, username: string): Promise<User> {
    username = this._normalizeUsername(username);
    const temporaryPublicHeaders = {
      Host: 'www.instagram.com',
      'X-Requested-With': 'XMLHttpRequest',
      'Sec-Ch-Prefers-Color-Scheme': 'dark',
      'Sec-Ch-Ua-Platform': '"Linux"',
      'X-Ig-App-Id': PUBLIC_WEB_APP_ID,
      'Sec-Ch-Ua-Model': '""',
      'Sec-Ch-Ua-Mobile': '?0',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.112 Safari/537.36',
      Accept: '*/*',
      'X-Asbd-Id': PUBLIC_WEB_ASBD_ID,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      Referer: 'https://www.instagram.com/',
      'Accept-Language': 'en-US,en;q=0.9',
      Priority: 'u=1, i',
    };
    const text = await this.publicRequest(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
      headers: temporaryPublicHeaders,
      updateHeaders: false,
    });
    return extractUserGql(require('../helpers/bigJson').parseJson(text).data.user);
  }

  _injectSessionidForV2Gql(this: Client): void {
    try {
      this.injectSessionidToPublic();
    } catch (exc) {
      logger.debug('Unable to inject sessionid into public session: %s', exc);
    }
  }

  /** Get user object via the PolarisProfilePageContentQuery doc_id. */
  async userInfoV2Gql(this: Client, userId: string | number): Promise<User> {
    const variables = {
      enable_integrity_filters: true,
      id: String(userId),
      render_surface: 'PROFILE',
      __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
      __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
      __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
      __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: false,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
    };
    this._injectSessionidForV2Gql();
    const data = await this.publicDocIdGraphqlRequest(USER_INFO_V2_DOC_ID, variables);
    const userData = (data || {}).user;
    if (userData === null || userData === undefined) throw new UserNotFound('User not found', { user_id: userId });
    return extractUserV1(this._normalizePolarisProfile(userData));
  }

  /** Resolve username via doc_id search, then fetch profile by user id. */
  async userInfoByUsernameV2Gql(this: Client, username: string): Promise<User> {
    username = this._normalizeUsername(username);
    this._injectSessionidForV2Gql();
    const data = await this.publicDocIdGraphqlRequest(USER_INFO_BY_USERNAME_V2_DOC_ID, { hasQuery: true, query: username });
    const users = ((data || {}).xdt_api__v1__fbsearch__non_profiled_serp || {}).users || [];
    for (const user of users) {
      if ((user.username || '').toLowerCase() === username) return this.userInfoV2Gql(user.pk || user.id);
    }
    throw new UserNotFound('User not found', { username });
  }

  _normalizePolarisProfile(this: Client, userData: Record<string, any>): Record<string, any> {
    const normalized = { ...userData };
    if (!('pk' in normalized) && 'id' in normalized) normalized.pk = normalized.id;
    if (!('is_business' in normalized) && 'is_business_account' in normalized) normalized.is_business = normalized.is_business_account;
    if (!('category' in normalized) && 'category_name' in normalized) normalized.category = normalized.category_name;
    const friendship = normalized.friendship_status || {};
    if (!('followed_by_viewer' in normalized)) normalized.followed_by_viewer = friendship.following ?? false;
    if (!('follows_viewer' in normalized)) normalized.follows_viewer = friendship.followed_by ?? false;
    return normalized;
  }

  /** Get user object from user name (Private API) */
  async userInfoByUsernameV1(this: Client, username: string): Promise<User> {
    username = this._normalizeUsername(username);
    let result: any;
    try {
      result = await this.privateRequest(`users/${username}/usernameinfo/`);
    } catch (e: any) {
      if (e instanceof ClientNotFoundError) throw new UserNotFound(e, { ...this.lastJson, username });
      if (e instanceof ClientError && String(e.message).includes('User not found')) throw new UserNotFound(e, { ...this.lastJson, username });
      throw e;
    }
    return extractUserV1(result.user);
  }

  /** Get user object from username */
  async userInfoByUsername(this: Client, username: string, useCache = true): Promise<User> {
    username = this._normalizeUsername(username);
    if (!useCache || !(username in this._usernames_cache)) {
      let user: User;
      if (this._hasPrivateAuth()) {
        try {
          user = await this.userInfoByUsernameV1(username);
        } catch (e) {
          if (!(e instanceof ClientError)) this.logger.exception(e);
          user = await this._userInfoByUsernamePublic(username);
        }
      } else {
        try {
          user = await this._userInfoByUsernamePublic(username);
        } catch (e) {
          if (e instanceof RequestException) this.logger.warning('Public user lookup failed, falling back to private API: %s', e);
          else if (!(e instanceof ClientError)) this.logger.exception(e); // Register unknown error
          user = await this.userInfoByUsernameV1(username);
        }
      }
      this._users_cache[user.pk] = user;
      this._usernames_cache[user.username] = user.pk;
    }
    return this.userInfo(this._usernames_cache[username]);
  }

  /** Get user object from user id (public GraphQL) */
  async userInfoGql(this: Client, userId: string | number): Promise<User> {
    const id = String(userId);
    try {
      return await this.userInfoV2Gql(id);
    } catch (e) {
      if (e instanceof JSONDecodeError) throw new ClientJSONDecodeError(e, { user_id: id });
      throw e;
    }
  }

  /**
   * Get user object from user id (Private API)
   * fromModule: which module triggered request: self_profile, feed_timeline, reel_feed_timeline.
   * isAppStart: profile is being retrieved on app launch
   */
  async userInfoV1(this: Client, userId: string | number, fromModule: INFO_FROM_MODULE = 'self_profile', isAppStart = false): Promise<User> {
    const id = String(userId);
    let result: any;
    try {
      const params: Record<string, any> = {
        is_prefetch: 'false',
        entry_point: 'self_profile',
        from_module: fromModule,
        is_app_start: isAppStart,
      };
      ensure((INFO_FROM_MODULES as readonly string[]).includes(fromModule), `Unsupported send_attribute="${fromModule}" ${INFO_FROM_MODULES}`);
      if (fromModule !== 'self_profile') params.entry_point = 'profile';
      result = await this.privateRequest(`users/${id}/info/`, null, { params });
    } catch (e: any) {
      if (e instanceof ClientNotFoundError) throw new UserNotFound(e, { ...this.lastJson, user_id: id });
      if (e instanceof ClientError && String(e.message).includes('User not found')) throw new UserNotFound(e, { ...this.lastJson, user_id: id });
      throw e;
    }
    return extractUserV1(result.user);
  }

  /** Get about info from user id. */
  async userAboutV1(this: Client, userId: string | number): Promise<About> {
    const id = String(userId);
    const bk = dumps({ bloks_version: this.bloksVersioningId, styles_id: 'instagram' });
    const data = { referer_type: 'ProfileMore', target_user_id: id, bk_client_context: bk, bloks_versioning_id: this.bloksVersioningId };
    try {
      await this.bloksAction('com.instagram.interactions.about_this_account', data);
    } catch (e: any) {
      if (e instanceof ClientNotFoundError) throw new UserNotFound(e, { ...this.lastJson, user_id: id });
      if (e instanceof ClientError && String(e.message).includes('User not found')) throw new UserNotFound(e, { ...this.lastJson, user_id: id });
      throw e;
    }
    return extractAboutV1(this.lastJson);
  }

  /** Get user object from user id */
  async userInfo(this: Client, userId: string | number, useCache = true): Promise<User> {
    const id = String(userId);
    if (!useCache || !(id in this._users_cache)) {
      let user: User;
      if (this._hasPrivateAuth()) {
        try {
          user = await this.userInfoV1(id);
        } catch (e) {
          if (!(e instanceof ClientError)) this.logger.exception(e);
          user = await this._userInfoPublic(id);
        }
      } else {
        try {
          user = await this._userInfoPublic(id);
        } catch (e) {
          if (!(e instanceof ClientError)) this.logger.exception(e);
          user = await this.userInfoV1(id);
        }
      }
      this._users_cache[id] = user;
      this._usernames_cache[user.username] = user.pk;
    }
    return deepcopy(this._users_cache[id]); // return copy of cache (dict changes protection)
  }

  /** Check if new feed exist (after login or load settings always returns false) */
  async newFeedExist(this: Client): Promise<boolean> {
    const results = await this.privateRequest('feed/new_feed_posts_exist/');
    return results.new_feed_posts_exist ?? false;
  }

  /** Get user friendship status for many users */
  async userFriendshipsV1(this: Client, userIds: Array<string | number>): Promise<RelationshipShort[]> {
    const userIdsStr = userIds.map(String).join(',');
    const result = await this.privateRequest('friendships/show_many/', { user_ids: userIdsStr, _uuid: this.uuid }, { withSignature: false });
    ensure((result.status ?? '') === 'ok');
    const relationships: RelationshipShort[] = [];
    for (const [userId, status] of Object.entries(result.friendship_statuses || {})) {
      relationships.push(makeRelationshipShort({ ...(status as any), user_id: userId }));
    }
    return relationships;
  }

  /** Get user friendship status */
  async userFriendshipV1(this: Client, userId: string | number): Promise<Relationship | null> {
    try {
      const params = { is_external_deeplink_profile_view: 'false' };
      const result = await this.privateRequest(`friendships/show/${userId}/`, null, { params });
      ensure((result.status ?? '') === 'ok');
      return makeRelationship({ ...result, user_id: userId });
    } catch (e) {
      if (e instanceof ClientError) {
        this.logger.exception(e);
        return null;
      }
      throw e;
    }
  }

  /** Search users by a query (Private Mobile API) */
  async searchUsersV1(this: Client, query: string, count: number): Promise<UserShort[]> {
    const results = await this.privateRequest('users/search/', null, { params: { query, count } });
    return (results.users || []).map((u: any) => extractUserShort(u));
  }

  /** Search users by a query */
  async searchUsers(this: Client, query: string, count = 50): Promise<UserShort[]> {
    return this.searchUsersV1(query, count);
  }

  /** Search users by followers (Private Mobile API) */
  async searchFollowersV1(this: Client, userId: string | number, query: string): Promise<UserShort[]> {
    const results = await this.privateRequest(`friendships/${userId}/followers/`, null, {
      params: { search_surface: 'follow_list_page', query, enable_groups: 'true' },
    });
    return (results.users || []).map((u: any) => extractUserShort(u));
  }

  /** Search by followers */
  async searchFollowers(this: Client, userId: string | number, query: string): Promise<UserShort[]> {
    return this.searchFollowersV1(userId, query);
  }

  /** Search following users (Private Mobile API) */
  async searchFollowingV1(this: Client, userId: string | number, query: string): Promise<UserShort[]> {
    const results = await this.privateRequest(`friendships/${userId}/following/`, null, {
      params: { includes_hashtags: 'false', search_surface: 'follow_list_page', query, enable_groups: 'true' },
    });
    return (results.users || []).map((u: any) => extractUserShort(u));
  }

  /** Search by following */
  async searchFollowing(this: Client, userId: string | number, query: string): Promise<UserShort[]> {
    return this.searchFollowingV1(userId, query);
  }

  async userFollowingGqlChunk(this: Client, userId: string | number, maxAmount = 0, endCursor: string | null = null): Promise<[UserShort[], string | null]> {
    const users: UserShort[] = [];
    const variables: Record<string, any> = { id: userId, include_reel: true, fetch_mutual: false, first: 24 };
    this.injectSessionidToPublic();
    while (true) {
      if (endCursor) variables.after = endCursor;
      const data = await this.publicGraphqlRequest(variables, { queryHash: '58712303d941c6855d4e888c5f0cd22f' });
      if (!data.user && !users.length) throw new UserNotFound({ ...data, user_id: userId });
      const pageInfo = jsonValue(data, 'user', 'edge_follow', 'page_info', { default: {} });
      const edges = jsonValue(data, 'user', 'edge_follow', 'edges', { default: [] });
      for (const edge of edges) users.push(extractUserShort(edge.node));
      endCursor = pageInfo.end_cursor ?? null;
      if (!pageInfo.has_next_page || !endCursor) break;
      if (maxAmount && users.length >= maxAmount) break;
    }
    return [users, endCursor];
  }

  /** Get user's following users information by Public Graphql API */
  async userFollowingGql(this: Client, userId: string | number, amount = 0): Promise<UserShort[]> {
    let [users] = await this.userFollowingGqlChunk(String(userId), amount);
    if (amount) users = users.slice(0, amount);
    return users;
  }

  /**
   * Get user's following users information by Private GraphQL API and max_id.
   * Returns [users, next max_id cursor]
   */
  async userFollowingPrivateGqlChunk(
    this: Client,
    userId: string | number,
    maxAmount = 0,
    maxId: string | null = null,
    rankToken: string | null = null,
    order: FOLLOWERS_ORDER | null = null,
    priority = 'u=3, i',
  ): Promise<[UserShort[], string | null]> {
    const id = String(userId);
    const result = await this.privateGraphqlFollowingList(id, rankToken || this.rankToken, undefined, maxId, priority, order);
    const following = this._privateGraphqlRoot(result, 'xdt_api__v1__friendships__following');
    if (!Object.keys(following).length) throw new ClientGraphqlError('Missing private GraphQL following payload');
    const users: UserShort[] = [];
    for (const user of following.users || []) {
      users.push(extractUserShort(user));
      if (maxAmount && users.length >= maxAmount) break;
    }
    return [users, following.next_max_id ?? null];
  }

  /** Get user's following users information by Private GraphQL API. */
  async userFollowingPrivateGql(
    this: Client,
    userId: string | number,
    amount = 0,
    rankToken: string | null = null,
    order: FOLLOWERS_ORDER | null = null,
    priority = 'u=3, i',
  ): Promise<UserShort[]> {
    let users: UserShort[] = [];
    let maxId: string | null = null;
    while (true) {
      const chunkAmount = amount ? Math.max(amount - users.length, 0) : 0;
      let chunk: UserShort[];
      [chunk, maxId] = await this.userFollowingPrivateGqlChunk(userId, chunkAmount, maxId, rankToken, order, priority);
      users.push(...chunk);
      if (amount && users.length >= amount) break;
      if (!maxId || !chunk.length) break;
    }
    if (amount) users = users.slice(0, amount);
    return users;
  }

  /** Get user's following users information by Private Mobile API and max_id (cursor) */
  async userFollowingV1Chunk(this: Client, userId: string | number, maxAmount = 0, maxId: string | null = ''): Promise<[UserShort[], string | null]> {
    const uniqueSet = new Set<string>();
    const users: UserShort[] = [];
    while (true) {
      let count = MAX_USER_COUNT;
      if (maxAmount) count = Math.min(maxAmount - users.length, MAX_USER_COUNT);
      const params: Record<string, any> = {
        count,
        rank_token: this.rankToken,
        search_surface: 'follow_list_page',
        query: '',
        enable_groups: 'true',
      };
      if (maxId) params.max_id = maxId;
      const result = await this.privateRequest(`friendships/${userId}/following/`, null, { params });
      for (const u of result.users) {
        const user = extractUserShort(u);
        if (uniqueSet.has(user.pk)) continue;
        uniqueSet.add(user.pk);
        users.push(user);
      }
      maxId = result.next_max_id ?? null;
      if (!maxId || (maxAmount && users.length >= maxAmount)) break;
    }
    return [users, maxId];
  }

  /** Get user's following users formation by Private Mobile API */
  async userFollowingV1(this: Client, userId: string | number, amount = 0): Promise<UserShort[]> {
    let [users] = await this.userFollowingV1Chunk(String(userId), amount);
    if (amount) users = users.slice(0, amount);
    return users;
  }

  /** Iterate over user's following users by Private Mobile API (async iterator of unique UserShort). */
  iterUserFollowingV1(this: Client, userId: string | number, amount = 0, pageSize = MAX_USER_COUNT): AsyncGenerator<UserShort> {
    const id = String(userId);
    const fetchPage = (maxId: any, maxAmount: number) => this.userFollowingV1Chunk(id, maxAmount, maxId);
    return iterPaginated<UserShort>(fetchPage, amount, pageSize, '', { itemKey: (u) => u.pk });
  }

  /** Get user's following information. Returns Map of user_id → UserShort (insertion ordered). */
  async userFollowing(this: Client, userId: string | number, useCache = true, amount = 0): Promise<Map<string, UserShort>> {
    const id = String(userId);
    const cached: Map<string, UserShort> | undefined = this._users_following[id];
    if (!useCache || !cached || !cached.size || (amount && cached.size < amount)) {
      let users: UserShort[];
      if (this._hasPrivateAuth()) {
        try {
          users = await this.userFollowingV1(id, amount);
        } catch (error) {
          if (!this._canUsePrivateGraphqlFallback(error)) throw error;
          users = await this.userFollowingPrivateGql(id, amount);
        }
      } else {
        try {
          users = await this.userFollowingGql(id, amount);
        } catch (e) {
          if (!this._canUsePrivateGraphqlFallback(e)) throw e;
          if (!(e instanceof ClientError)) this.logger.exception(e);
          users = await this.userFollowingV1(id, amount);
        }
      }
      this._users_following[id] = new Map(users.map((u) => [u.pk, u]));
    }
    let following: Map<string, UserShort> = this._users_following[id];
    if (amount && following.size > amount) following = new Map(Array.from(following).slice(0, amount));
    return following;
  }

  /** Get user's followers information by Public Graphql API and end_cursor */
  async userFollowersGqlChunk(this: Client, userId: string | number, maxAmount = 0, endCursor: string | null = null): Promise<[UserShort[], string | null]> {
    const id = String(userId);
    const users: UserShort[] = [];
    const variables: Record<string, any> = { id, include_reel: true, fetch_mutual: false, first: 12 };
    this.injectSessionidToPublic();
    while (true) {
      if (endCursor) variables.after = endCursor;
      const data = await this.publicGraphqlRequest(variables, { queryHash: '37479f2b8209594dde7facb0d904896a' });
      if (!data.user && !users.length) throw new UserNotFound({ ...data, user_id: id });
      const pageInfo = jsonValue(data, 'user', 'edge_followed_by', 'page_info', { default: {} });
      const edges = jsonValue(data, 'user', 'edge_followed_by', 'edges', { default: [] });
      for (const edge of edges) users.push(extractUserShort(edge.node));
      endCursor = pageInfo.end_cursor ?? null;
      if (!pageInfo.has_next_page || !endCursor) break;
      if (maxAmount && users.length >= maxAmount) break;
    }
    return [users, endCursor];
  }

  /** Get user's followers information by Public Graphql API */
  async userFollowersGql(this: Client, userId: string | number, amount = 0): Promise<UserShort[]> {
    let [users] = await this.userFollowersGqlChunk(String(userId), amount);
    if (amount) users = users.slice(0, amount);
    return users;
  }

  /** Get user's followers information by Private Mobile API and max_id (cursor) */
  async userFollowersV1Chunk(
    this: Client,
    userId: string | number,
    maxAmount = 0,
    maxId: string | null = '',
    order: FOLLOWERS_ORDER | null = null,
  ): Promise<[UserShort[], string | null]> {
    const uniqueSet = new Set<string>();
    const users: UserShort[] = [];
    while (true) {
      let count = MAX_USER_COUNT;
      if (maxAmount) count = Math.min(maxAmount - users.length, MAX_USER_COUNT);
      const params: Record<string, any> = {
        count,
        rank_token: this.rankToken,
        search_surface: 'follow_list_page',
        query: '',
        enable_groups: 'true',
      };
      if (order) params.order = order;
      if (maxId) params.max_id = maxId;
      const result = await this.privateRequest(`friendships/${userId}/followers/`, null, { params });
      for (const u of result.users) {
        const user = extractUserShort(u);
        if (uniqueSet.has(user.pk)) continue;
        uniqueSet.add(user.pk);
        users.push(user);
      }
      maxId = result.next_max_id ?? null;
      if (!maxId || (maxAmount && users.length >= maxAmount)) break;
    }
    return [users, maxId];
  }

  /** Get user's followers information by Private Mobile API */
  async userFollowersV1(this: Client, userId: string | number, amount = 0, order: FOLLOWERS_ORDER | null = null): Promise<UserShort[]> {
    let [users] = await this.userFollowersV1Chunk(String(userId), amount, '', order);
    if (amount) users = users.slice(0, amount);
    return users;
  }

  /** Iterate over user's followers by Private Mobile API (async iterator of unique UserShort). */
  iterUserFollowersV1(
    this: Client,
    userId: string | number,
    amount = 0,
    pageSize = MAX_USER_COUNT,
    order: FOLLOWERS_ORDER | null = null,
  ): AsyncGenerator<UserShort> {
    const id = String(userId);
    const fetchPage = (maxId: any, maxAmount: number) =>
      order ? this.userFollowersV1Chunk(id, maxAmount, maxId, order) : this.userFollowersV1Chunk(id, maxAmount, maxId);
    return iterPaginated<UserShort>(fetchPage, amount, pageSize, '', { itemKey: (u) => u.pk });
  }

  _privateGraphqlRoot(this: Client, data: Record<string, any>, rootFieldName: string): Record<string, any> {
    const payload = (data && data.data) || data;
    if (!isDict(payload)) return {};
    const root = payload[rootFieldName];
    if (isDict(root)) return root;
    for (const [key, value] of Object.entries(payload)) {
      if (String(key).includes(rootFieldName) && isDict(value)) return value;
    }
    return {};
  }

  /** Get user's followers information by Private GraphQL API and max_id. Returns [users, next max_id]. */
  async userFollowersPrivateGqlChunk(
    this: Client,
    userId: string | number,
    maxAmount = 0,
    maxId: string | null = null,
    rankToken: string | null = null,
    order: FOLLOWERS_ORDER | null = null,
    priority = 'u=3, i',
  ): Promise<[UserShort[], string | null]> {
    const id = String(userId);
    const result = await this.privateGraphqlFollowersList(id, rankToken || this.rankToken, undefined, maxId, priority, order);
    const followers = this._privateGraphqlRoot(result, 'xdt_api__v1__friendships__followers');
    if (!Object.keys(followers).length) throw new ClientGraphqlError('Missing private GraphQL followers payload');
    const users: UserShort[] = [];
    for (const user of followers.users || []) {
      users.push(extractUserShort(user));
      if (maxAmount && users.length >= maxAmount) break;
    }
    return [users, followers.next_max_id ?? null];
  }

  /** Get user's followers information by Private GraphQL API. */
  async userFollowersPrivateGql(
    this: Client,
    userId: string | number,
    amount = 0,
    rankToken: string | null = null,
    order: FOLLOWERS_ORDER | null = null,
    priority = 'u=3, i',
  ): Promise<UserShort[]> {
    let users: UserShort[] = [];
    let maxId: string | null = null;
    while (true) {
      const chunkAmount = amount ? Math.max(amount - users.length, 0) : 0;
      let chunk: UserShort[];
      [chunk, maxId] = await this.userFollowersPrivateGqlChunk(userId, chunkAmount, maxId, rankToken, order, priority);
      users.push(...chunk);
      if (amount && users.length >= amount) break;
      if (!maxId || !chunk.length) break;
    }
    if (amount) users = users.slice(0, amount);
    return users;
  }

  /**
   * Get user's followers. Returns Map of user_id → UserShort (insertion ordered).
   * order: date_followed_latest or date_followed_earliest. Sorted requests use the private mobile endpoint and bypass cache.
   */
  async userFollowers(
    this: Client,
    userId: string | number,
    useCache = true,
    amount = 0,
    order: FOLLOWERS_ORDER | null = null,
  ): Promise<Map<string, UserShort>> {
    const id = String(userId);
    if (order) {
      const users = await this.userFollowersV1(id, amount, order);
      return new Map(users.map((u) => [u.pk, u]));
    }
    const cached: Map<string, UserShort> | undefined = this._users_followers[id];
    if (!useCache || !cached || !cached.size || (amount && cached.size < amount)) {
      let users: UserShort[] = [];
      if (this._hasPrivateAuth()) {
        let limited: boolean;
        try {
          users = await this.userFollowersV1(id, amount);
          limited = Boolean(this.lastJson.should_limit_list_of_followers) && (!amount || users.length < amount);
        } catch (error) {
          if (!this._canUsePrivateGraphqlFallback(error)) throw error;
          limited = true;
        }
        if (limited) users = await this.userFollowersPrivateGql(id, amount);
      } else {
        try {
          users = await this.userFollowersGql(id, amount);
        } catch (e) {
          if (!this._canUsePrivateGraphqlFallback(e)) throw e;
          if (!(e instanceof ClientError)) this.logger.exception(e);
          users = await this.userFollowersV1(id, amount);
        }
      }
      this._users_followers[id] = new Map(users.map((u) => [u.pk, u]));
    }
    let followers: Map<string, UserShort> = this._users_followers[id];
    if (amount && followers.size > amount) followers = new Map(Array.from(followers).slice(0, amount));
    return followers;
  }

  /** Get pending incoming follow requests by Private Mobile API. Returns [users, max_id cursor]. */
  async userFollowRequestsChunk(this: Client, maxAmount = 0, maxId: string | null = ''): Promise<[UserShort[], string | null]> {
    ensure(this.userId, 'Login required');
    const users: UserShort[] = [];
    const uniqueSet = new Set<string>();
    while (true) {
      const params: Record<string, any> = { count: maxAmount || MAX_USER_COUNT };
      if (maxId) params.max_id = maxId;
      const result = await this.privateRequest('friendships/pending/', null, { params });
      for (const u of result.users || []) {
        const user = extractUserShort(u);
        if (uniqueSet.has(user.pk)) continue;
        uniqueSet.add(user.pk);
        users.push(user);
      }
      maxId = result.next_max_id ?? null;
      if (!maxId || (maxAmount && users.length >= maxAmount)) break;
    }
    return [users, maxId];
  }
  /** Get pending incoming follow requests by Private Mobile API */
  async userFollowRequests(this: Client, amount = 0): Promise<UserShort[]> {
    let [users] = await this.userFollowRequestsChunk(amount);
    if (amount) users = users.slice(0, amount);
    return users;
  }

  /** Approve a pending incoming follow request */
  async userFollowRequestApprove(this: Client, userId: string | number): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const result = await this.privateRequest(`friendships/approve/${id}/`, this.withActionData({ user_id: id }));
    const friendshipStatus = result.friendship_status || {};
    if ('followed_by' in friendshipStatus) return friendshipStatus.followed_by === true;
    return result.status === 'ok';
  }

  /** Decline a pending incoming follow request */
  async userFollowRequestDecline(this: Client, userId: string | number): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const result = await this.privateRequest(`friendships/ignore/${id}/`, this.withActionData({ user_id: id }));
    const friendshipStatus = result.friendship_status || {};
    if ('followed_by' in friendshipStatus) return friendshipStatus.followed_by === false;
    return result.status === 'ok';
  }

  /** Approve pending incoming follow requests. Returns {user_id: result} */
  async userFollowRequestsApprove(this: Client, userIds: Array<string | number>): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const id of userIds) out[String(id)] = await this.userFollowRequestApprove(String(id));
    return out;
  }

  /** Decline pending incoming follow requests. Returns {user_id: result} */
  async userFollowRequestsDecline(this: Client, userIds: Array<string | number>): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const id of userIds) out[String(id)] = await this.userFollowRequestDecline(String(id));
    return out;
  }

  /** Follow a user */
  async userFollow(this: Client, userId: string | number): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const currentUserId = String(this.userId);
    const followingCache: Map<string, UserShort> | undefined = this._users_following[currentUserId];
    if (followingCache && followingCache.has(id)) {
      this.logger.debug('User %s already followed', id);
      return false;
    }
    let relationship: Relationship | null;
    try {
      relationship = await this.userFriendshipV1(id);
    } catch (e) {
      logger.debug('Unable to pre-check friendship for %s before follow: %s', id, e);
      relationship = null;
    }
    if (relationship && (relationship.following || relationship.outgoing_request)) {
      this.logger.debug('User %s already followed or requested', id);
      return false;
    }
    const data = this.withActionData({
      user_id: id,
      _uid: String(this.userId),
      include_follow_friction_check: '1',
      container_module: 'profile',
    });
    const result = await this.privateRequest(`friendships/create/${id}/`, data);
    const friendshipStatus = result.friendship_status;
    const followed = friendshipStatus.following === true || friendshipStatus.outgoing_request === true;
    if (followed && followingCache) {
      followingCache.set(id, this._userhorts_cache[id] || require('../models/schemas').makeUserShort({ pk: id }));
    }
    return followed;
  }

  /** Unfollow a user */
  async userUnfollow(this: Client, userId: string | number): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const data = this.withActionData({ user_id: id, _uid: String(this.userId), container_module: 'profile' });
    const result = await this.privateRequest(`friendships/destroy/${id}/`, data);
    const cache: Map<string, UserShort> | undefined = this._users_following[String(this.userId)];
    if (cache) cache.delete(id);
    return result.friendship_status.following === false;
  }

  /**
   * Block a User. surface: "profile" (default) or "direct_thread_info" from Direct thread info.
   */
  async userBlock(this: Client, userId: string | number, surface: UserBlockSurface = 'profile'): Promise<boolean> {
    const data: Record<string, any> = { surface, is_auto_block_enabled: 'false', user_id: userId, _uid: this.userIdInt, _uuid: this.uuid };
    if (surface === 'direct_thread_info') data.client_request_id = this.requestId;
    const result = await this.privateRequest(`friendships/block/${userId}/`, data);
    ensure((result.status ?? '') === 'ok');
    return (result.friendship_status || {}).blocking === true;
  }

  /** Unblock a User. surface: "profile" (default) or "direct_thread_info". */
  async userUnblock(this: Client, userId: string | number, surface: UserBlockSurface = 'profile'): Promise<boolean> {
    const data: Record<string, any> = { container_module: surface, user_id: userId, _uid: this.userIdInt, _uuid: this.uuid };
    if (surface === 'direct_thread_info') data.client_request_id = this.requestId;
    const result = await this.privateRequest(`friendships/unblock/${userId}/`, data);
    ensure((result.status ?? '') === 'ok');
    return (result.friendship_status || {}).blocking === false;
  }

  /** Report a User. reason: currently supports "spam". Returns true if Instagram returns the report confirmation state. */
  async userReport(this: Client, userId: string | number, reason: USER_REPORT_REASON = 'spam'): Promise<boolean> {
    const id = String(userId);
    if (!(reason in USER_REPORT_REASONS)) {
      throw Boom.badRequest(`Unsupported user report reason "${reason}". Supported reasons: ${Object.keys(USER_REPORT_REASONS)}`);
    }
    let result = await this.privateRequest(
      'reports/get_frx_prompt/',
      {
        _uuid: this.uuid,
        container_module: 'profile',
        entry_point: '1',
        frx_prompt_request_type: '1',
        is_dark_mode: 'false',
        location: '2',
        nua_action: '',
        object_id: id,
        object_type: '5',
      },
      { withSignature: false },
    );
    let response = result.response ?? result;
    let context = response.context;
    if (!context) throw new ClientError('Instagram report flow did not return an initial context', { ...result });
    for (const tag of USER_REPORT_REASONS[reason]) {
      result = await this.privateRequest(
        'reports/get_frx_prompt/',
        {
          _uuid: this.uuid,
          context,
          frx_prompt_request_type: '2',
          is_dark_mode: 'false',
          nua_action: '',
          selected_tag_types: dumps([tag]),
        },
        { withSignature: false },
      );
      response = result.response ?? result;
      context = response.context;
      if (!context) throw new ClientError(`Instagram report flow did not return context after tag "${tag}"`, { ...result });
    }
    return Boolean(response.follow_up_actions && (!Array.isArray(response.follow_up_actions) || response.follow_up_actions.length));
  }

  /** Remove a follower */
  async userRemoveFollower(this: Client, userId: string | number): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const result = await this.privateRequest(`friendships/remove_follower/${id}/`, this.withActionData({ user_id: id }));
    const cache: Map<string, UserShort> | undefined = this._users_followers[String(this.userId)];
    if (cache) cache.delete(id);
    return result.friendship_status.followed_by === false;
  }

  /** Mute posts from following user (revert=true to unmute) */
  async mutePostsFromFollow(this: Client, userId: string | number, revert = false): Promise<boolean> {
    const name = revert ? 'unmute' : 'mute';
    const result = await this.privateRequest(`friendships/${name}_posts_or_story_from_follow/`, {
      // "media_id": media_pk,  # when feed_timeline
      target_posts_author_id: String(userId),
      container_module: 'media_mute_sheet', // or "feed_timeline"
    });
    return result.status === 'ok';
  }

  /** Unmute posts from following user */
  async unmutePostsFromFollow(this: Client, userId: string | number): Promise<boolean> {
    return this.mutePostsFromFollow(userId, true);
  }

  /** Mute stories from following user (revert=true to unmute) */
  async muteStoriesFromFollow(this: Client, userId: string | number, revert = false): Promise<boolean> {
    const name = revert ? 'unmute' : 'mute';
    const result = await this.privateRequest(`friendships/${name}_posts_or_story_from_follow/`, {
      target_reel_author_id: String(userId),
      container_module: 'media_mute_sheet', // or "feed_timeline"
    });
    return result.status === 'ok';
  }

  /** Unmute stories from following user */
  async unmuteStoriesFromFollow(this: Client, userId: string | number): Promise<boolean> {
    return this.muteStoriesFromFollow(userId, true);
  }

  /** Enable post notifications of a user (disable=true to unfavorite) */
  async enablePostsNotifications(this: Client, userId: string | number, disable = false): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const name = disable ? 'unfavorite' : 'favorite';
    const result = await this.privateRequest(`friendships/${name}/${id}/`, this.withActionData({ user_id: id, _uid: this.userIdInt }));
    return result.status === 'ok';
  }

  /** Disable post notifications of a user */
  async disablePostsNotifications(this: Client, userId: string | number): Promise<boolean> {
    return this.enablePostsNotifications(userId, true);
  }

  /** Enable videos notifications of a user */
  async enableVideosNotifications(this: Client, userId: string | number, revert = false): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const name = revert ? 'unfavorite' : 'favorite';
    const result = await this.privateRequest(`friendships/${name}_for_igtv/${id}/`, this.withActionData({ user_id: id, _uid: this.userIdInt }));
    return result.status === 'ok';
  }

  /** Disable videos notifications of a user */
  async disableVideosNotifications(this: Client, userId: string | number): Promise<boolean> {
    return this.enableVideosNotifications(userId, true);
  }

  /** Enable reels notifications of a user */
  async enableReelsNotifications(this: Client, userId: string | number, revert = false): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const name = revert ? 'unfavorite' : 'favorite';
    const result = await this.privateRequest(`friendships/${name}_for_clips/${id}/`, this.withActionData({ user_id: id, _uid: this.userIdInt }));
    return result.status === 'ok';
  }

  /** Disable reels notifications of a user */
  async disableReelsNotifications(this: Client, userId: string | number): Promise<boolean> {
    return this.enableReelsNotifications(userId, true);
  }

  /** Enable stories notifications of a user */
  async enableStoriesNotifications(this: Client, userId: string | number, revert = false): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const name = revert ? 'unfavorite' : 'favorite';
    const result = await this.privateRequest(`friendships/${name}_for_stories/${id}/`, this.withActionData({ user_id: id, _uid: this.userIdInt }));
    return result.status === 'ok';
  }

  /** Disable stories notifications of a user */
  async disableStoriesNotifications(this: Client, userId: string | number): Promise<boolean> {
    return this.enableStoriesNotifications(userId, true);
  }

  /** Add to Close Friends List */
  async closeFriendAdd(this: Client, userId: string | number): Promise<any> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const data = {
      block_on_empty_thread_creation: 'false',
      module: 'CLOSE_FRIENDS_V2_SEARCH',
      source: 'audience_manager',
      _uid: this.userIdInt,
      _uuid: this.uuid,
      remove: [],
      add: [id],
    };
    const result = await this.privateRequest('friendships/set_besties/', data);
    return jsonValue(result, 'friendship_statuses', id, 'is_bestie') ?? null;
  }

  /** Remove from Close Friends List */
  async closeFriendRemove(this: Client, userId: string | number): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const id = String(userId);
    const data = {
      block_on_empty_thread_creation: 'false',
      module: 'CLOSE_FRIENDS_V2_SEARCH',
      source: 'audience_manager',
      _uid: this.userIdInt,
      _uuid: this.uuid,
      remove: [id],
      add: [],
    };
    const result = await this.privateRequest('friendships/set_besties/', data);
    return jsonValue(result, 'friendship_statuses', id, 'is_bestie') === false;
  }

  /**
   * Retrieves Creator's information.
   * entryPoint: default direct_thread; when passing self_profile, own user_id must be provided.
   * Returns [user, creatorInfo]
   */
  async creatorInfo(this: Client, userId: string | number, entryPoint = 'direct_thread'): Promise<[UserShort, Record<string, any>]> {
    ensure(this.userId, 'Login required');
    const params = { entry_point: entryPoint, surface_type: 'android', user_id: userId };
    const result = await this.privateRequest('creator/creator_info/', null, { params });
    ensure((result.status ?? '') === 'ok');
    const user = result.user || {};
    const creatorInfo = user.creator_info ?? {};
    delete user.creator_info;
    return [extractUserShort(user), creatorInfo];
  }

  /** Get guides by user_id. */
  async userGuidesV1(this: Client, userId: string | number): Promise<Guide[]> {
    const id = BigInt(String(userId)).toString();
    const result = await this.privateRequest(`guides/user/${id}/`);
    return (result.guides || []).map((item: any) => extractGuideV1(item));
  }

  /**
   * Get suggested users for a target user_id (discover/chaining/ — the "Suggested for you" carousel).
   * Throws InvalidTargetUser when Instagram refuses chaining ("Not eligible for chaining.").
   */
  async chaining(this: Client, userId: string | number): Promise<any> {
    const params = { module: 'profile', target_id: String(userId), profile_chaining_check: 'false', eligible_for_threads_cta: 'false' };
    try {
      return await this.privateRequest('discover/chaining/', null, { params });
    } catch (e: any) {
      if (e instanceof UnknownError && e.message === 'Not eligible for chaining.') {
        throw new InvalidTargetUser('Not eligible for chaining.', { cause: e });
      }
      throw e;
    }
  }

  /**
   * Fetch expanded details for chained suggestion ids (comma-separated user pks from chaining()['users']).
   */
  async fetchSuggestionDetails(this: Client, userId: string | number, chainedIds: string): Promise<any> {
    const params = { target_id: String(userId), chained_ids: chainedIds, include_social_context: '1' };
    return this.privateRequest('discover/fetch_suggestion_details/', null, { params });
  }

  /**
   * Get suggested profiles ("Suggested for you") for a target user_id.
   * With expandSuggestion=true it feeds the chained pks back into fetchSuggestionDetails.
   */
  async userSuggestedProfiles(this: Client, userId: string | number, expandSuggestion = false): Promise<any> {
    const chained = await this.chaining(userId);
    if (!expandSuggestion) return chained;
    const chainedIds = (chained.users || [])
      .filter((u: any) => u.pk)
      .map((u: any) => String(u.pk))
      .join(',');
    if (!chainedIds) return chained;
    return this.fetchSuggestionDetails(userId, chainedIds);
  }

  _serializeAddressBookContacts(this: Client, contacts: Array<AddressBookContact | Record<string, any>>): Record<string, any>[] {
    const stripNone = (v: any): any => {
      if (Array.isArray(v)) return v.map(stripNone);
      if (isDict(v)) {
        const out: Record<string, any> = {};
        for (const [k, val] of Object.entries(v)) if (val !== null && val !== undefined) out[k] = stripNone(val);
        return out;
      }
      return v;
    };
    return contacts.map((c) => stripNone(c));
  }

  _serializeAddressBookInclude(this: Client, include: string | string[]): string {
    if (typeof include === 'string') return include;
    return include.map(String).join(',');
  }

  /**
   * Upload/link address book contacts and return Instagram's raw suggestions response.
   * contacts: e.g. {phone_numbers: [{phone_number: "+15555550123"}], email_addresses: [], first_name: "Test", last_name: "Contact"}
   */
  async addressBookLink(
    this: Client,
    contacts: Array<AddressBookContact | Record<string, any>>,
    include: string | string[] = ADDRESS_BOOK_DEFAULT_INCLUDE,
  ): Promise<any> {
    const includeValue = this._serializeAddressBookInclude(include);
    const data: Record<string, any> = { contacts: JSON.stringify(this._serializeAddressBookContacts(contacts)), _uuid: this.uuid };
    if (this.userId) data._uid = String(this.userId);
    return this.privateRequest('address_book/link/', data, { params: includeValue ? { include: includeValue } : null });
  }

  /** Disconnect the uploaded address book from the current account. */
  async addressBookUnlink(this: Client): Promise<any> {
    return this.privateRequest('address_book/unlink/', { _uuid: this.uuid });
  }

  /** Get the streamed profile envelope by username (POST /users/{username}/usernameinfo_stream/). */
  async userStreamByUsernameV1(this: Client, username: string): Promise<any> {
    username = this._normalizeUsername(username);
    const data = { is_prefetch: false, entry_point: 'profile', from_module: 'feed_timeline' };
    try {
      return await this.privateRequest(`users/${username}/usernameinfo_stream/`, data);
    } catch (e) {
      if (e instanceof ClientError) throw new UserNotFound(e, { ...this.lastJson, username });
      throw e;
    }
  }

  /** Get the streamed profile envelope by pk (POST /users/{user_id}/info_stream/). */
  async userStreamByIdV1(this: Client, userId: string | number): Promise<any> {
    const data = { is_prefetch: false, entry_point: 'profile', from_module: 'feed_timeline' };
    try {
      return await this.privateRequest(`users/${userId}/info_stream/`, data);
    } catch (e) {
      if (e instanceof ClientJSONDecodeError) {
        const responseText = this.lastResponse?.text || '';
        for (let line of responseText.split(/\r?\n/)) {
          line = line.trim();
          if (!line) continue;
          try {
            return require('../helpers/bigJson').parseJson(line);
          } catch {
            break;
          }
        }
        logger.exception('Unable to parse streamed user response for user_id %s', userId);
        throw new UserNotFound('User not found');
      }
      if (e instanceof ClientError) {
        logger.exception('Client error user_stream_by_id_v1, exception: %s, user_id %s', e, userId);
        throw new UserNotFound('User not found');
      }
      throw e;
    }
  }

  /**
   * Collapse a stream_rows envelope into a single flat user dict (later rows override earlier ones).
   * Falls back to one extra fetch if the first response was empty.
   */
  async _userStreamCollector(this: Client, resp: any, id: string | null = null, username: string | null = null): Promise<any> {
    const data: Record<string, any> = {};
    if (isDict(resp.user)) Object.assign(data, resp.user);
    for (const urow of resp.stream_rows || []) Object.assign(data, urow.user || {});
    if (Object.keys(data).length) {
      data.pk = data.pk ?? data.pk_id ?? null;
      return data;
    }
    logger.error('user_stream_collector: empty stream_rows, falling back: %s', resp);
    if (username) await this.userStreamByUsernameV1(username);
    else if (id) await this.userStreamByIdV1(id);
    else throw new UserNotFound({ code_error: 1257 });
    return this.lastJson;
  }

  /** Flatten the streamed profile envelope for a target user pk into a single user dict. */
  async userStreamByIdFlat(this: Client, userId: string | number): Promise<any> {
    const resp = await this.userStreamByIdV1(userId);
    return this._userStreamCollector(resp, String(userId));
  }

  /** Flatten the streamed profile envelope for a target username into a single user dict. */
  async userStreamByUsernameFlat(this: Client, username: string): Promise<any> {
    username = this._normalizeUsername(username);
    const resp = await this.userStreamByUsernameV1(username);
    return this._userStreamCollector(resp, null, username);
  }

  /** Web-scraper-style profile fetch via the private API (GET /users/web_profile_info/). Returns response['data']. */
  async userWebProfileInfoV1(this: Client, username: string): Promise<any> {
    username = this._normalizeUsername(username);
    let result: any;
    try {
      result = await this.privateRequest('users/web_profile_info/', null, { params: { username } });
    } catch (e) {
      if (e instanceof ClientError) throw new UserNotFound(e, { ...this.lastJson, username });
      throw e;
    }
    const data = result.data ?? {};
    if (data && Object.keys(data).length) return data;
    throw new UserNotFound('Username not found', { ...this.lastJson, username });
  }

  /** Fetch the streamed feed for a user. */
  async feedUserStreamItem(this: Client, itemId: string, isPullToRefresh = false): Promise<any> {
    const data: Record<string, any> = { _uuid: this.uuid };
    if (isPullToRefresh) data.is_pull_to_refresh = 'true';
    return this.privateRequest(`feed/user_stream/${itemId}/`, data);
  }

  async privateGraphqlFollowersList(
    this: Client,
    userId: string | number,
    rankToken: string,
    clientDocId = '284797047911918316998205836755',
    maxId: string | number | null = null,
    priority: string | null = null,
    order: FOLLOWERS_ORDER | null = null,
    excludeFieldIsFavorite: boolean | null = null,
    excludeUnusedFields: boolean | null = null,
  ): Promise<any> {
    const variables: Record<string, any> = {
      user_id: String(userId),
      skip_suggested_users: true,
      skip_more_groups_available: true,
      skip_friendship_followers_fields: true,
      request_data: { rank_token: rankToken, enableGroups: true },
      skip_page_size: true,
      skip_pending_admins: true,
      skip_has_more: true,
      search_surface: 'follow_list_page',
      query: '',
      skip_big_list: true,
      include_unseen_count: true,
    };
    if (excludeFieldIsFavorite !== null) variables.exclude_field_is_favorite = excludeFieldIsFavorite;
    if (maxId !== null && maxId !== undefined) variables.max_id = maxId;
    if (order !== null && order !== undefined) variables.order = order;
    if (excludeUnusedFields !== null) variables.exclude_unused_fields = excludeUnusedFields;
    return this.privateGraphqlQueryRequest('FollowersList', 'xdt_api__v1__friendships__followers', variables, clientDocId, priority, {
      'X-FB-RMD': 'state=URL_ELIGIBLE',
    });
  }

  async privateGraphqlFollowingList(
    this: Client,
    userId: string | number,
    rankToken: string,
    clientDocId = '16104639286363954576550227636',
    maxId: string | number | null = null,
    priority: string | null = null,
    order: FOLLOWERS_ORDER | null = null,
    excludeFieldIsFavorite: boolean | null = null,
    excludeUnusedFields: boolean | null = null,
    skipPreviewHashtags = true,
    skipHashtagCount = true,
  ): Promise<any> {
    const variables: Record<string, any> = {
      user_id: String(userId),
      skip_use_clickable_see_more: true,
      skip_preview_hashtags: skipPreviewHashtags,
      skip_should_limit_list_of_followers: true,
      skip_pending_admins: true,
      skip_more_groups_available: true,
      skip_friendship_followers_fields: false,
      request_data: { search_surface: 'follow_list_page', rank_token: rankToken, includes_hashtags: true },
      skip_page_size: true,
      skip_friend_requests: true,
      skip_big_list: true,
      query: '',
      include_profile_update_info: true,
      skip_suggested_users: true,
      include_unseen_count: true,
      skip_has_more: true,
      enable_groups: true,
      skip_hashtag_count: skipHashtagCount,
    };
    if (excludeFieldIsFavorite !== null) variables.exclude_field_is_favorite = excludeFieldIsFavorite;
    if (maxId !== null && maxId !== undefined) variables.max_id = maxId;
    if (order !== null && order !== undefined) variables.order = order;
    if (excludeUnusedFields !== null) variables.exclude_unused_fields = excludeUnusedFields;
    return this.privateGraphqlQueryRequest('FollowingList', 'xdt_api__v1__friendships__following', variables, clientDocId, priority, {
      'X-FB-RMD': 'state=URL_ELIGIBLE',
    });
  }

  async privateGraphqlClipsProfile(
    this: Client,
    targetUserId: string | number,
    clientDocId = '209049231614685382737238866578',
    priority: string | null = null,
    initialStreamCount = 6,
    pageSize = 12,
    noOfMediasInEachChunk = 6,
  ): Promise<any> {
    const innerData: Record<string, any> = {
      target_user_id: String(targetUserId),
      should_stream_response: false,
      sort_by_views: false,
      max_id: null,
      include_feed_video: true,
      audience: null,
    };
    if (pageSize) innerData.page_size = pageSize;
    if (noOfMediasInEachChunk) innerData.no_of_medias_in_each_chunk = noOfMediasInEachChunk;
    const variables: Record<string, any> = {
      use_stream: false,
      use_defer: false,
      enable_video_versions_in_light_media: true,
      exclude_caption_user_field: false,
      enable_thumbnails_in_light_media: false,
      enable_audience_in_light_media: false,
      enable_clips_metadata_in_light_media: false,
      exclude_main_user_field: false,
      enable_likers_in_full_media: false,
      data: innerData,
      stream_use_customized_batch: false,
    };
    if (initialStreamCount) variables.initial_stream_count = initialStreamCount;
    return this.privateGraphqlQueryRequest('ClipsProfileQuery', 'xdt_user_clips_graphql', variables, clientDocId, priority);
  }

  async privateGraphqlInboxTrayForUser(
    this: Client,
    userId: string | number,
    clientDocId = '2035639076042015234490020607',
    priority: string | null = null,
  ): Promise<any> {
    const variables = { user_id: String(userId), should_fetch_content_note_stack_video_info: false };
    return this.privateGraphqlQueryRequest('InboxTrayRequestForUserQuery', 'xdt_get_inbox_tray_items', variables, clientDocId, priority);
  }

  /**
   * Get business-category-similar accounts for a target user:
   * fetch the target's profile via userStreamByIdV1 to extract category_id, then call
   * discover/recommended_accounts_for_category/.
   */
  async discoverRecommendedAccountsForCategoryV1(this: Client, userId: string | number): Promise<any> {
    const userInfo = await this.userStreamByIdV1(userId);
    let categoryId: any = null;
    for (const row of userInfo.stream_rows || []) {
      const cid = (row.user || {}).category_id;
      if (cid !== null && cid !== undefined) {
        categoryId = cid;
        break;
      }
    }
    return this.privateRequest('discover/recommended_accounts_for_category/', null, { params: { target_id: userId, category_id: categoryId } });
  }

  /**
   * Get related profiles for a target user via the public GraphQL edge_chaining field.
   * Throws RelatedProfileRequired on empty result if client.numRetry is set below 4 (opt-in retry signal).
   */
  async userRelatedProfilesGql(this: Client, userId: string | number): Promise<UserShort[]> {
    this.injectSessionidToPublic();
    const variables = { user_id: String(userId), include_chaining: true };
    const data = await this.publicGraphqlRequest(variables, { queryHash: 'ad99dd9d3646cc3c0dda65debcd266a7' });
    if (!data.user) throw new UserNotFound('User not found');
    const edges = jsonValue(data, 'user', 'edge_chaining', 'edges', { default: [] });
    const res = edges.filter((e: any) => 'node' in e).map((e: any) => extractUserShort(e.node));
    if (!res.length && this.numRetry !== undefined && this.numRetry !== null && this.numRetry < 4) throw new RelatedProfileRequired();
    return res;
  }
}
