import * as Boom from '@hapi/boom';
import * as path from 'node:path';
import * as config from '../config';
import { ClientError, ClientGraphqlError, ClientNotFoundError, StoryNotFound, UserNotFound } from '../exceptions';
import { extractStoryArchiveDay, extractStoryV1, extractStoryWeb, extractUserShort, extractViewer } from '../extractors';
import { Story, StoryArchiveDay, UserShort, Viewer } from '../types';
import { deepcopy } from '../utils/serialization';
import { ensure } from '../utils/validation';
import type { Client } from '../client';

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class StoryMixin {
  /** Get Story (media) PK from URL. Example: https://www.instagram.com/stories/dhbastards/2581281926631793076/ -> 2581281926631793076 */
  storyPkFromUrl(this: Client, url: string): string {
    const p = new URL(url, 'http://placeholder').pathname;
    const parts = p.split('/').filter((x) => x && /^\d+$/.test(x));
    if (!parts.length) throw Boom.badRequest('Invalid story URL');
    return String(parts[0]);
  }

  /** Get Story by pk or id */
  async storyInfoV1(this: Client, storyPk: string | number): Promise<Story> {
    const storyId = await this.mediaId(storyPk);
    const [pk, userId] = storyId.split('_');
    const stories = await this.userStoriesV1(userId);
    for (const story of stories) this._stories_cache[story.pk] = story;
    if (!(pk in this._stories_cache)) throw new StoryNotFound({ ...this.lastJson, story_pk: pk });
    return deepcopy(this._stories_cache[pk]);
  }

  /** Get Story by pk or id */
  async storyInfo(this: Client, storyPk: string | number, useCache = true): Promise<Story> {
    const key = String(storyPk);
    if (!useCache || !(key in this._stories_cache)) {
      const story = await this.storyInfoV1(key);
      this._stories_cache[key] = story;
    }
    return deepcopy(this._stories_cache[key]);
  }

  /** Delete story */
  async storyDelete(this: Client, storyPk: string | number): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const mediaId = await this.mediaId(storyPk);
    delete this._stories_cache[this.mediaPk(mediaId)];
    return this.mediaDelete(mediaId);
  }

  /** Get users' stories (web GraphQL). Returns UserShort list with `stories` populated. */
  async usersStoriesGql(this: Client, userIds: Array<string | number>, amount = 0): Promise<UserShort[]> {
    ensure(Array.isArray(userIds), 'user_ids should be a list of user_id');
    if (userIds !== null && !userIds.length) return [];
    const users: UserShort[] = [];
    for (let start = 0; start < userIds.length; start += 25) {
      const batch = userIds.slice(start, start + 25).map(String);
      const body = await this.graphqlRequest({
        data: {
          variables: require('../utils/serialization').jsonDumps({
            reel_ids_arr: batch,
            __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true,
          }),
          doc_id: '29184890191114309',
          fb_dtsg: await this.getFbDtsg(),
          fb_api_caller_class: 'RelayModern',
          fb_api_req_friendly_name: 'PolarisStoriesV3ReelPageStandaloneQuery',
          server_timestamps: 'true',
        },
      });
      const root = body?.data?.xdt_api__v1__feed__reels_media;
      if (body?.data === undefined || root === undefined) throw new ClientGraphqlError('Malformed web stories response');
      if (!isDict(root) || !Array.isArray(root.reels_media)) throw new ClientGraphqlError('Malformed web stories response');
      for (const reel of root.reels_media) {
        if (!isDict(reel) || !Array.isArray(reel.items)) throw new ClientGraphqlError('Malformed web stories response');
        const items = amount ? reel.items.slice(0, amount) : reel.items;
        if (!items.length) continue;
        const stories = items.map((item: any) => extractStoryWeb(item));
        const user = deepcopy(stories[0].user);
        user.stories = stories;
        users.push(user);
      }
    }
    return users;
  }

  /** Get a user's stories (Public API) */
  async userStoriesGql(this: Client, userId: string | number, amount: number | null = null): Promise<Story[]> {
    const users = await this.usersStoriesGql([userId], amount || 0);
    if (!users.length) throw Boom.badData('No users in reel response', { code: 'EMPTY_REEL' });
    let stories = deepcopy(users[0].stories) as Story[];
    if (amount) stories = stories.slice(0, amount);
    return stories;
  }

  /** Get a user's stories through the modern web GraphQL API. */
  async userStoriesWeb(this: Client, userId: string | number, amount: number | null = null): Promise<Story[]> {
    const data = {
      variables: require('../utils/serialization').jsonDumps({
        reel_ids_arr: [String(userId)],
        __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true,
      }),
      doc_id: '29184890191114309',
      fb_dtsg: await this.getFbDtsg(),
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'PolarisStoriesV3ReelPageStandaloneQuery',
      server_timestamps: 'true',
    };
    const body = await this.graphqlRequest({ data });
    const root = body?.data?.xdt_api__v1__feed__reels_media;
    if (body?.data === undefined || root === undefined) throw new ClientGraphqlError('Malformed web stories response');
    if (!isDict(root) || !Array.isArray(root.reels_media)) throw new ClientGraphqlError('Malformed web stories response');
    const reels = root.reels_media;
    if (reels.some((r: any) => !isDict(r) || !Array.isArray(r.items))) throw new ClientGraphqlError('Malformed web stories response');
    let stories: Story[] = reels.flatMap((reel: any) => reel.items.map((item: any) => extractStoryWeb(item)));
    if (amount) stories = stories.slice(0, Math.trunc(amount));
    return stories;
  }

  async _userStoriesPublic(this: Client, userId: string | number, amount: number | null = null): Promise<Story[]> {
    try {
      return await this.userStoriesGql(userId, amount);
    } catch (e) {
      if (e instanceof ClientNotFoundError) throw new UserNotFound(e, { ...this.lastJson, user_id: userId });
      if (Boom.isBoom(e) && (e.data as any)?.code === 'EMPTY_REEL') return [];
      throw e;
    }
  }

  /** Get a user's stories (Private API) */
  async userStoriesV1(this: Client, userId: string | number, amount: number | null = null): Promise<Story[]> {
    const params = { supported_capabilities_new: require('../utils/serialization').jsonDumps(config.SUPPORTED_CAPABILITIES) };
    const id = BigInt(String(userId)).toString();
    const reel = (await this.privateRequest(`feed/user/${id}/story/`, null, { params })).reel || {};
    let stories: Story[] = (reel.items || []).map((item: any) => extractStoryV1(item));
    if (amount) stories = stories.slice(0, Math.trunc(amount));
    return stories;
  }

  /** Get a user's stories */
  async userStories(this: Client, userId: string | number, amount: number | null = null): Promise<Story[]> {
    if (this._hasPrivateAuth()) return this.userStoriesV1(userId, amount);
    try {
      return await this._userStoriesPublic(userId, amount);
    } catch (e) {
      if (e instanceof UserNotFound) throw e;
      if (!this.userId) {
        if (e instanceof ClientGraphqlError) throw e;
        throw new ClientGraphqlError('Anonymous story fetch failed via public API and private fallback requires login', { cause: e });
      }
      return this.userStoriesV1(userId, amount);
    }
  }

  /** Get a page of your story archive days by Private Mobile API. Returns [days, next max_id]. */
  async archiveStoryDaysPaginatedV1(
    this: Client,
    amount = 0,
    endCursor = '',
    includeMemories = true,
    reelId = '',
  ): Promise<[StoryArchiveDay[], string]> {
    amount = Math.trunc(amount);
    const params: Record<string, any> = { timezone_offset: this.timezoneOffset, include_memories: includeMemories ? '1' : '0' };
    if (endCursor) params.max_id = endCursor;
    if (reelId) params.reel_id = reelId;
    const result = await this.privateRequest('archive/reel/day_shells_paginated/', null, { params });
    let items: any[] = result.items || [];
    if (amount) items = items.slice(0, amount);
    return [items.map((i) => extractStoryArchiveDay(i)), result.max_id || ''];
  }

  /** Get your story archive days by Private Mobile API */
  async archiveStoryDaysV1(this: Client, amount = 0, includeMemories = true): Promise<StoryArchiveDay[]> {
    amount = Math.trunc(amount);
    let days: StoryArchiveDay[] = [];
    let nextMaxId = '';
    while (true) {
      let page: StoryArchiveDay[];
      [page, nextMaxId] = await this.archiveStoryDaysPaginatedV1(amount, nextMaxId, includeMemories);
      days.push(...page);
      if (!nextMaxId) break;
      if (amount && days.length >= amount) break;
    }
    if (amount) days = days.slice(0, amount);
    return days;
  }

  /** Get your story archive days */
  async archiveStoryDays(this: Client, amount = 0, includeMemories = true): Promise<StoryArchiveDay[]> {
    return this.archiveStoryDaysV1(amount, includeMemories);
  }

  _archiveStoryReels(this: Client, response: Record<string, any>): Record<string, any>[] {
    const reels = response.reels || response.reels_media || [];
    if (isDict(reels)) return Object.values(reels);
    if (Array.isArray(reels) ? reels.length : reels) return reels;
    return Object.entries(response)
      .filter(([k]) => String(k).startsWith('archiveDay:'))
      .map(([, v]) => v);
  }

  /** Get your archived stories by Private Mobile API */
  async archiveStoriesV1(this: Client, amount = 0): Promise<Story[]> {
    amount = Math.trunc(amount);
    const days = await this.archiveStoryDaysV1(0);
    const stories: Story[] = [];
    for (let start = 0; start < days.length; start += 50) {
      const dayIds = days.slice(start, start + 50).map((d) => d.id);
      if (!dayIds.length) continue;
      const data = this.withDefaultData({ reel_ids: dayIds, reason: 'on_tap', source: 'archive', batch_size: dayIds.length });
      const result = await this.privateRequest('feed/reels_media_stream/', data);
      for (const reel of this._archiveStoryReels(result)) {
        for (const item of reel.items || []) {
          const story = extractStoryV1(item);
          this._stories_cache[story.pk] = story;
          stories.push(story);
          if (amount && stories.length >= amount) return stories;
        }
      }
    }
    return stories;
  }

  /** Get your archived stories */
  async archiveStories(this: Client, amount = 0): Promise<Story[]> {
    return this.archiveStoriesV1(amount);
  }

  /** Mark stories as seen */
  async storySeen(this: Client, storyPks: Array<string | number>, skippedStoryPks: Array<string | number> = []): Promise<boolean> {
    ensure(Array.isArray(storyPks), 'story_pks should be a list of story.pk');
    const ids: string[] = [];
    for (const mid of storyPks) ids.push(await this.mediaId(mid));
    const skipped: string[] = [];
    for (const mid of skippedStoryPks) skipped.push(await this.mediaId(mid));
    return this.mediaSeen(ids, skipped);
  }

  /** Download story media by media_type. Returns path for the file downloaded */
  async storyDownload(this: Client, storyPk: string | number, filename = '', folder = ''): Promise<string> {
    const story = await this.storyInfo(storyPk);
    const url = String(story.media_type === 1 ? story.thumbnail_url : story.video_url);
    return this.storyDownloadByUrl(url, filename, folder);
  }

  /** Download story media using URL */
  async storyDownloadByUrl(this: Client, url: string, filename = '', folder = ''): Promise<string> {
    url = String(url);
    const urlPath = new URL(url).pathname;
    const fname = urlPath.slice(urlPath.lastIndexOf('/') + 1).trim();
    ensure(
      fname,
      'The URL must contain the path to the file (mp4 or jpg).',
    );
    const name = filename ? `${filename}.${fname.slice(fname.lastIndexOf('.') + 1)}` : fname;
    const filePath = path.join(folder || '', name);
    const response = await this._sendPublicRequest(url, { stream: true, timeout: this.readTimeout });
    response.raise_for_status();
    return this._downloadResponseToPath(response, filePath);
  }

  async storyViewersChunk(this: Client, storyPk: string | number, maxAmount = 0, maxId: string | null = ''): Promise<[Viewer[], string | null]> {
    const uniqueSet = new Set<string>();
    const viewers: Viewer[] = [];
    const pk = this.mediaPk(storyPk);
    const params: Record<string, any> = { supported_capabilities_new: require('../utils/serialization').jsonDumps(config.SUPPORTED_CAPABILITIES) };
    while (true) {
      if (maxId) params.max_id = maxId;
      const result = await this.privateRequest(`media/${pk}/list_reel_media_viewer/`, null, { params });
      for (const item of result.viewers) {
        const viewer = extractViewer(item);
        if (uniqueSet.has(viewer.pk)) continue;
        uniqueSet.add(viewer.pk);
        viewers.push(viewer);
      }
      maxId = result.next_max_id ?? null;
      if (!maxId || (maxAmount && viewers.length >= maxAmount)) break;
    }
    return [viewers, maxId];
  }

  /** List of story viewers (Private API) */
  async storyViewers(this: Client, storyPk: string | number, amount = 0): Promise<Viewer[]> {
    let [viewers] = await this.storyViewersChunk(storyPk, amount);
    if (amount) viewers = viewers.slice(0, amount);
    return viewers;
  }

  async storyLikersChunk(this: Client, storyPk: string | number, maxAmount = 0, maxId: string | null = ''): Promise<[UserShort[], string | null]> {
    const uniqueSet = new Set<string>();
    const likers: UserShort[] = [];
    const pk = this.mediaPk(storyPk);
    const params: Record<string, any> = { supported_capabilities_new: require('../utils/serialization').jsonDumps(config.SUPPORTED_CAPABILITIES) };
    while (true) {
      if (maxId) params.max_id = maxId;
      const result = await this.privateRequest(`media/${pk}/list_reel_media_viewer/`, null, { params });
      for (const item of result.viewers || []) {
        if (!item.has_liked) continue;
        const liker = extractUserShort(item.user);
        if (uniqueSet.has(liker.pk)) continue;
        uniqueSet.add(liker.pk);
        likers.push(liker);
      }
      maxId = result.next_max_id ?? null;
      if (!maxId || (maxAmount && likers.length >= maxAmount)) break;
    }
    return [likers, maxId];
  }

  /** List of story likers (Private API) */
  async storyLikers(this: Client, storyPk: string | number, amount = 0): Promise<UserShort[]> {
    let [likers] = await this.storyLikersChunk(storyPk, amount);
    if (amount) likers = likers.slice(0, amount);
    return likers;
  }

  /** Like a story (revert=true to unlike). markSeen: mark story as seen before liking */
  async storyLike(this: Client, storyId: string | number, revert = false, markSeen = true): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const mediaId = await this.mediaId(storyId);
    if (markSeen && !revert) await this.storySeen([this.mediaPk(mediaId)]);
    const data = {
      media_id: mediaId,
      _uid: String(this.userId),
      source_of_like: 'button',
      tray_session_id: this.traySessionId,
      viewer_session_id: this.clientSessionId,
      container_module: 'reel_feed_timeline',
    };
    const name = revert ? 'unsend' : 'send';
    const result = await this.privateRequest(`story_interactions/${name}_story_like`, this.withActionData(data));
    return result.status === 'ok';
  }

  /** Unlike a story */
  async storyUnlike(this: Client, storyId: string | number): Promise<boolean> {
    return this.storyLike(storyId, true);
  }

  /** Vote in a story poll. vote: poll option index (0-based) */
  async storyPollVote(this: Client, storyId: string | number, pollId: string, vote: number): Promise<boolean> {
    ensure(this.userId, 'Login required');
    if (!Number.isInteger(vote) || vote < 0) throw Boom.badRequest('vote must be a non-negative option index');
    const mediaId = await this.mediaId(storyId);
    const data = { _uid: String(this.userId), _csrftoken: this.token, vote: String(vote) };
    const result = await this.privateRequest(`media/${mediaId}/${pollId}/story_poll_vote/`, this.withActionData(data));
    return result.status === 'ok';
  }

  /** Getting a sticker tray from Instagram */
  async stickerTray(this: Client): Promise<any> {
    const data = { _uid: this.userIdInt, type: 'static_stickers', _uuid: this.uuid };
    const result = await this.privateRequest('creatives/sticker_tray/', data, { withSignature: true });
    ensure(result.status === 'ok');
    return result;
  }
}
void ClientError;
