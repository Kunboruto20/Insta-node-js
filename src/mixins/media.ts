import { promises as fsp } from 'node:fs';
import sharp from 'sharp';
import {
  ClientError,
  ClientForbiddenError,
  ClientGraphqlError,
  ClientLoginRequired,
  ClientNotFoundError,
  ClientUnauthorizedError,
  MediaNotFound,
  PrivateError,
  WrongCursorError,
} from '../exceptions';
import {
  extractDirectMessage,
  extractLocation,
  extractMediaGql,
  extractMediaOembed,
  extractMediaV1,
  extractUserShort,
} from '../extractors';
import { GQL_STUFF } from './graphql';
import { DirectMessage, Location, Media, MediaOembed, Story, StoryMedia, UserShort, Usertag, makeStory, makeStoryMedia } from '../types';
import { generateJazoest } from '../utils/auth';
import { makeTmpPath } from '../utils/ffmpeg';
import { InstagramIdCodec } from '../utils/ids';
import { iterPaginated } from '../utils/iterators';
import { deepcopy, dumps, jsonValue } from '../utils/serialization';
import { sleep } from '../utils/timing';
import { pyAssert } from '../utils/validation';
import type { Client } from '../client';

export const MEDIA_INFO_DOC_ID = '27830990013244856';
export const IG_PROFILE_TIMELINE_DOC_ID = '56030350814417327502004290437';
const _MEDIA_CURSOR_PREFIX = 'ig-route:';

export function _splitMediaCursor(cursor: any): [string, any] {
  if (typeof cursor === 'string' && cursor.startsWith(_MEDIA_CURSOR_PREFIX)) {
    const rest = cursor.slice(_MEDIA_CURSOR_PREFIX.length);
    const idx = rest.indexOf(':');
    const route = idx >= 0 ? rest.slice(0, idx) : rest;
    const raw = idx >= 0 ? rest.slice(idx + 1) : '';
    if (!route || idx < 0 || !raw) throw new WrongCursorError('Malformed routed media cursor');
    return [route, raw];
  }
  return ['', cursor];
}

export function _mediaPageWithRoute(page: [Media[], string | null], route: string): [Media[], string | null] {
  let [medias, cursor] = page;
  if (cursor && !cursor.startsWith(_MEDIA_CURSOR_PREFIX)) cursor = `${_MEDIA_CURSOR_PREFIX}${route}:${cursor}`;
  return [medias, cursor];
}

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

type ExcCls = new (...args: any[]) => Error;

/** Helpers for media */
export class MediaMixin {
  async _mediaShareStoryBackground(this: Client): Promise<string> {
    const p = makeTmpPath('.jpg', 'instagrapi_story_share_');
    try {
      await sharp({ create: { width: 720, height: 1280, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg({ quality: 95 }).toFile(p);
    } catch (e) {
      await fsp.unlink(p).catch(() => undefined);
      throw e;
    }
    return p;
  }

  _findProfileTimelinePayload(this: Client, data: any): Record<string, any> | null {
    if (!isDict(data)) return null;
    if ('profile_grid_items' in data) return data;
    for (const value of Object.values(data)) {
      const found = this._findProfileTimelinePayload(value);
      if (found && Object.keys(found).length) return found;
    }
    return null;
  }

  _normalizeXdtProfileMedia(this: Client, mediaIn: Record<string, any>): Record<string, any> {
    const media = deepcopy(mediaIn);
    const user = media.user || {};
    if (!('pk' in user) && user.id) user.pk = user.id;
    media.user = user;
    const mediaId = String(media.id || media.pk || '');
    if (!('pk' in media) && mediaId) media.pk = mediaId.split('_')[0];
    if (mediaId && !mediaId.includes('_') && user.pk) media.id = `${mediaId}_${user.pk}`;
    if (!('taken_at' in media) && '1ltaken_at' in media) media.taken_at = media['1ltaken_at'];
    if (media.carousel_media && media.carousel_media.length) {
      media.carousel_media = media.carousel_media.map((item: any) => this._normalizeXdtProfileMedia(item));
    }
    return media;
  }

  _normalizeXdtMediaInfo(this: Client, mediaIn: Record<string, any>): Record<string, any> {
    const media = deepcopy(mediaIn);
    const user = media.user || {};
    if (!('pk' in user) && user.id) user.pk = user.id;
    media.user = user;
    let mediaPk = String(media.pk || '');
    const mediaId = String(media.id || '');
    if (!mediaPk && mediaId) {
      mediaPk = mediaId.split('_')[0];
      media.pk = mediaPk;
    } else if (mediaPk.includes('_')) {
      mediaPk = mediaPk.split('_')[0];
      media.pk = mediaPk;
    }
    if (mediaId && !mediaId.includes('_') && user.pk) media.id = `${mediaId}_${user.pk}`;
    else if (!mediaId && mediaPk && user.pk) media.id = `${mediaPk}_${user.pk}`;
    if (!('code' in media) && media.shortcode) media.code = media.shortcode;
    if (!('taken_at' in media) && 'taken_at_timestamp' in media) media.taken_at = media.taken_at_timestamp;
    if (!media.media_type) {
      if (media.carousel_media && media.carousel_media.length) media.media_type = 8;
      else if (media.video_versions && media.video_versions.length) media.media_type = 2;
      else media.media_type = 1;
    }
    if (typeof media.caption === 'string') media.caption = { text: media.caption };
    else if ('caption_text' in media && !('caption' in media)) {
      media.caption = { text: media.caption_text || '' };
      delete media.caption_text;
    } else if ('caption_text' in media) delete media.caption_text;
    if (media.carousel_media && media.carousel_media.length) {
      media.carousel_media = media.carousel_media.map((item: any) => this._normalizeXdtMediaInfo(item));
    }
    return media;
  }

  async _userMediasPaginatedAppGql(this: Client, userId: string | number, amount = 0, endCursor: any = null): Promise<[Media[], string | null]> {
    const count = !amount || amount > 50 ? 50 : amount;
    const variables: Record<string, any> = {
      request_media_chunk: true,
      skip_clips_captions_fields: false,
      fetch_profile_grid_items: true,
      exclude_comment: 'false',
      request_hints_chunk: false,
      include_unseen_media_ids: false,
      exclude_pinned_posts: false,
      enable_carousel_media_count_in_deferred: true,
      include_fb_mentioned_users: false,
      include_attribution_ui_data: true,
      include_profile_grid_rendering_option: false,
      count,
      initial_count_carousel_media: 5,
      exclude_collaborative_posts: false,
      include_is_photo_comments_composer_enabled_for_author: false,
      include_associated_highlights: false,
      include_attribution_ui_data_v2: true,
      include_media_notes_fields: true,
      include_eligible_insights_entrypoints: false,
      include_accessibility_caption_for_carousel: true,
      defer_maybe_non_essential_lightweight_fields: false,
      num_previews_for_associated_highlights: 3,
      include_videos_for_associated_highlights: false,
      exclude_user: false,
      defer_hints_chunk: false,
      exclude_highlights: true,
      include_ring_creator_fields: false,
      include_timeline_ordered_edge: false,
      user_id: String(userId),
      exclude_besties_content: true,
      force_compute_user_tags: false,
      enable_profile_fm_integration: false,
      include_is_unseen_by_viewer: false,
    };
    if (endCursor) variables.max_id = endCursor;
    const data = {
      method: 'post',
      pretty: 'false',
      format: 'json',
      server_timestamps: 'true',
      locale: this.locale,
      fb_api_req_friendly_name: 'IGProfileTimelineQuery',
      fb_api_caller_class: 'graphservice',
      client_doc_id: IG_PROFILE_TIMELINE_DOC_ID,
      variables: JSON.stringify(variables),
    };
    const response = await this.privateGraphqlRequest(data, { 'X-FB-Friendly-Name': 'IGProfileTimelineQuery' });
    const timeline = this._findProfileTimelinePayload(response.data ?? response);
    if (!timeline) throw new ClientGraphqlError('Missing profile timeline payload in IGProfileTimelineQuery response');
    let medias: Media[] = [];
    for (const item of timeline.profile_grid_items || []) {
      const media = isDict(item) ? item.media : null;
      if (!media) continue;
      medias.push(extractMediaV1(this._normalizeXdtProfileMedia(media)));
    }
    let cursor: string | null = null;
    if (timeline.more_available) cursor = timeline.next_max_id || timeline.profile_grid_items_cursor || null;
    if (amount) medias = medias.slice(0, amount);
    return [medias, cursor];
  }

  async _userMediasPaginatedPublicGql(this: Client, userId: string | number, amount = 0, endCursor: any = null): Promise<[Media[], string | null]> {
    amount = Math.trunc(Number(amount));
    let medias: any[] = [];
    const variables: Record<string, any> = { id: BigInt(String(userId)).toString(), first: !amount || amount > 50 ? 50 : amount };
    variables.id = Number.isSafeInteger(Number(variables.id)) ? Number(variables.id) : variables.id;
    variables.after = endCursor;
    const data = await this.publicGraphqlRequest(variables, { queryHash: 'e7e2f4da4b02303f74f0841279e52d76' });
    const pageInfo = jsonValue(data, 'user', 'edge_owner_to_timeline_media', 'page_info', { default: {} });
    const edges = jsonValue(data, 'user', 'edge_owner_to_timeline_media', 'edges', { default: [] });
    for (const edge of edges) medias.push(edge.node);
    const cursor = pageInfo.end_cursor ?? null;
    if (amount) medias = medias.slice(0, amount);
    return [medias.map((m) => extractMediaGql(m)), cursor];
  }

  _extractConfiguredMedia(this: Client, configured: any): Media | null {
    let media: any = null;
    if (isDict(configured)) media = configured.media ?? null;
    if (media === null || media === undefined) media = isDict(this.lastJson) ? this.lastJson.media ?? null : null;
    if (media === null || media === undefined) return null;
    return extractMediaV1(media);
  }

  _extractConfiguredMediaOrRaise(this: Client, configured: any, ExceptionCls: ExcCls, context: string): Media {
    const media = this._extractConfiguredMedia(configured);
    if (media === null) {
      throw new ExceptionCls(`${context} configure succeeded without media payload`, {
        response: this.lastResponse,
        ...(isDict(this.lastJson) ? this.lastJson : {}),
      });
    }
    return media;
  }

  async _currentMediaIds(this: Client, amount = 20): Promise<Set<string> | null> {
    const userId = this.userId;
    if (!userId) return null;
    try {
      return new Set((await this.userMediasV1(userId, amount)).map((m) => String(m.id)));
    } catch (e) {
      this.logger.debug('Unable to read current feed media before upload: %s', e);
      return null;
    }
  }

  async _newMediaAfterUpload(this: Client, previousMediaIds: Set<string> | null, attempts = 5, delay = 3, amount = 20): Promise<Media | null> {
    const userId = this.userId;
    if (previousMediaIds === null || !userId) return null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const medias = await this.userMediasV1(userId, amount);
        for (const media of medias) if (!previousMediaIds.has(String(media.id))) return media;
      } catch (e) {
        this.logger.debug('Unable to read uploaded feed media on attempt %s: %s', attempt, e);
      }
      if (attempt < attempts - 1) await sleep(delay);
    }
    return null;
  }

  async _extractConfiguredMediaOrRecent(
    this: Client,
    configured: any,
    ExceptionCls: ExcCls,
    context: string,
    previousMediaIds: Set<string> | null,
  ): Promise<Media> {
    let media = this._extractConfiguredMedia(configured);
    if (media !== null) return media;
    media = await this._newMediaAfterUpload(previousMediaIds);
    if (media !== null) return media;
    throw new ExceptionCls(`${context} configure succeeded without media payload and uploaded media was not visible`, {
      response: this.lastResponse,
      ...(isDict(this.lastJson) ? this.lastJson : {}),
    });
  }

  async _currentStoryIds(this: Client, amount = 20): Promise<Set<string> | null> {
    const userId = this.userId;
    if (!userId) return null;
    try {
      return new Set((await this.userStories(userId, amount)).map((s) => String(s.id)));
    } catch (e) {
      this.logger.debug('Unable to read current stories before upload: %s', e);
      return null;
    }
  }

  async _newStoryAfterUpload(this: Client, previousStoryIds: Set<string> | null, attempts = 5, delay = 3, amount = 20): Promise<Story | null> {
    const userId = this.userId;
    if (previousStoryIds === null || !userId) return null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const stories = await this.userStories(userId, amount);
        for (const story of stories) if (!previousStoryIds.has(String(story.id))) return story;
      } catch (e) {
        this.logger.debug('Unable to read uploaded story on attempt %s: %s', attempt, e);
      }
      if (attempt < attempts - 1) await sleep(delay);
    }
    return null;
  }

  async _extractConfiguredStoryOrRecent(
    this: Client,
    configured: any,
    ExceptionCls: ExcCls,
    context: string,
    previousStoryIds: Set<string> | null,
    storyKwargs: Record<string, any>,
  ): Promise<Story> {
    const media = this._extractConfiguredMedia(configured);
    if (media !== null) return makeStory({ ...media, ...storyKwargs });
    const story = await this._newStoryAfterUpload(previousStoryIds);
    if (story !== null) return { ...story, ...storyKwargs } as Story;
    throw new ExceptionCls(`${context} configure succeeded without media payload and uploaded story was not visible`, {
      response: this.lastResponse,
      ...(isDict(this.lastJson) ? this.lastJson : {}),
    });
  }

  _extractConfiguredDirectMessageOrRaise(this: Client, configured: any, ExceptionCls: ExcCls, context: string): DirectMessage {
    let messageMetadata: any[] = [];
    if (isDict(configured)) messageMetadata = configured.message_metadata || [];
    if (!messageMetadata.length && isDict(this.lastJson)) messageMetadata = this.lastJson.message_metadata || [];
    if (!messageMetadata.length) {
      throw new ExceptionCls(`${context} configure succeeded without message_metadata payload`, {
        response: this.lastResponse,
        ...(isDict(this.lastJson) ? this.lastJson : {}),
      });
    }
    return extractDirectMessage(messageMetadata[0]);
  }

  /** Get full media id. Example: 2277033926878261772 -> 2277033926878261772_1903424587 */
  async mediaId(this: Client, mediaPk: string | number): Promise<string> {
    let mediaId = String(mediaPk);
    if (!mediaId.includes('_')) {
      pyAssert(/^\d+$/.test(mediaId), `media_id must been contain digits, now ${mediaId}`);
      const user = await this.mediaUser(mediaId);
      mediaId = `${mediaId}_${user.pk}`;
    }
    return mediaId;
  }

  /** Get short media id. Example: 2277033926878261772_1903424587 -> 2277033926878261772 */
  mediaPk(this: Client, mediaId: string | number): string {
    let mediaPk = String(mediaId);
    if (mediaPk.includes('_')) {
      const parts = mediaPk.split('_');
      if (parts.length !== 2) throw new Error('ValueError: too many values to unpack (expected 2)');
      mediaPk = parts[0];
    }
    return String(mediaPk);
  }

  /**
   * Share an existing feed media as a story.
   * background: 9:16 background image; when omitted, a black 720x1280 image is generated temporarily.
   */
  async mediaShareToStory(
    this: Client,
    mediaId: string | number,
    background: string | null = null,
    caption = '',
    x = 0.5,
    y = 0.4997396,
    width = 0.8,
    height = 0.60572916,
    rotation = 0.0,
    extraData: Record<string, string> | null = null,
  ): Promise<Story> {
    pyAssert(this.userId, 'Login required');
    const id = String(mediaId);
    const mediaPk = this.mediaPk(id);
    let mediaOwnerId: string | null = null;
    if (id.includes('_')) {
      const ownerId = id.slice(id.indexOf('_') + 1);
      mediaOwnerId = /^\d+$/.test(ownerId) ? ownerId : null;
    }
    let generatedBackground: string | null = null;
    if (background === null || background === undefined) {
      generatedBackground = await this._mediaShareStoryBackground();
      background = generatedBackground;
    }
    try {
      return await this.photoUploadToStory(background, caption, {
        medias: [makeStoryMedia({ media_pk: mediaPk, user_id: mediaOwnerId, x, y, width, height, rotation })],
        extraData: extraData || {},
      });
    } finally {
      if (generatedBackground) await fsp.unlink(generatedBackground).catch(() => undefined);
    }
  }

  /** Get Code from Media PK. Example: 2110901750722920960 -> B1LbfVPlwIA */
  mediaCodeFromPk(this: Client, mediaPk: string | number): string {
    return InstagramIdCodec.encode(mediaPk);
  }

  /** Get Media PK from Code. Example: B1LbfVPlwIA -> 2110901750722920960 */
  mediaPkFromCode(this: Client, code: string): string {
    return String(InstagramIdCodec.decode(code.slice(0, 11)));
  }
  /**
   * Get Media PK from URL.
   * Example: https://instagram.com/p/B1LbfVPlwIA/ -> 2110901750722920960
   */
  async mediaPkFromUrl(this: Client, url: string): Promise<string> {
    const path = new URL(url, 'http://placeholder').pathname;
    const parts = path.split('/').filter((p) => p);
    if (parts[0] === 'share' && parts[1] === 'p' && parts.length >= 3) {
      const response = await this.public.get(url, { proxies: this.public.proxies, timeout: this.readTimeout, allowRedirects: false });
      const location = response.headers.get('Location') || response.headers.get('location');
      if (location) return this.mediaPkFromUrl(location);
    }
    const last = parts.pop();
    if (last === undefined) throw new RangeError('pop from empty list');
    return this.mediaPkFromCode(last);
  }

  /** Get Media from PK through the modern public GraphQL doc_id query */
  async mediaInfoGql(this: Client, mediaPk: string | number): Promise<Media> {
    const pk = this.mediaPk(mediaPk);
    const shortcode = this.mediaCodeFromPk(pk);
    const data = await this.publicDocIdGraphqlRequest(
      MEDIA_INFO_DOC_ID,
      {
        shortcode,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
        __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
      },
      {
        referer: `https://www.instagram.com/p/${shortcode}/`,
        url: this.GRAPHQL_PUBLIC_WEB_API_URL,
        includeLsd: true,
        includeFbDtsg: true,
        headers: { 'X-FB-Friendly-Name': 'PolarisPostRootQuery' },
      },
    );
    const media = data.xdt_shortcode_media || data.shortcode_media;
    if (media) return extractMediaGql(media);
    const mediaItems = jsonValue(data, 'xdt_api__v1__media__shortcode__web_info', 'items', { default: [] });
    if (!mediaItems.length) throw new MediaNotFound({ ...data, media_pk: pk });
    return extractMediaV1(this._normalizeXdtMediaInfo(mediaItems[0]));
  }

  async _mediaInfoPublic(this: Client, mediaPk: string): Promise<Media> {
    try {
      return await this.mediaInfoGql(mediaPk);
    } catch (e) {
      if (e instanceof ClientLoginRequired) {
        if (!this.injectSessionidToPublic()) throw e;
        return this.mediaInfoGql(mediaPk);
      }
      throw e;
    }
  }

  /** Get Media from PK by Private Mobile API */
  async mediaInfoV1(this: Client, mediaPk: string | number): Promise<Media> {
    let result: any;
    try {
      result = await this.privateRequest(`media/${mediaPk}/info/`);
    } catch (e: any) {
      if (e instanceof ClientNotFoundError) throw new MediaNotFound(e, { ...this.lastJson, media_pk: mediaPk });
      if (e instanceof ClientError && String(e.message).includes('Media not found')) throw new MediaNotFound(e, { ...this.lastJson, media_pk: mediaPk });
      throw e;
    }
    const items = result.items;
    if (!items || !items.length) throw new RangeError('pop from empty list');
    return extractMediaV1(items.pop());
  }

  /**
   * Get media via the discover-style metadata endpoint (GET /discover/media_metadata/?media_id={pk}).
   * Useful as a fallback when mediaInfoV1 fails on certain ad-tagged or sponsored media.
   */
  async mediaInfoV2(this: Client, mediaId: string | number): Promise<Media> {
    const id = String(mediaId).split('_')[0];
    const result = await this.privateRequest('discover/media_metadata/', null, { params: { media_id: id } });
    const media = result.media_or_ad;
    if (!media) throw new MediaNotFound({ ...(this.lastJson || {}), media_id: id });
    return extractMediaV1(media);
  }

  /** Get Media Information from PK */
  async mediaInfo(this: Client, mediaPk: string | number, useCache = true): Promise<Media> {
    const pk = this.mediaPk(mediaPk);
    if (!useCache || !(pk in this._medias_cache)) {
      let media: Media;
      if (this._hasPrivateAuth()) {
        try {
          media = await this.mediaInfoV1(pk);
        } catch (e) {
          if (!(e instanceof ClientError)) this.logger.exception(e); // Register unknown error
          media = await this._mediaInfoPublic(pk);
        }
      } else {
        try {
          media = await this._mediaInfoPublic(pk);
        } catch (e) {
          if (!(e instanceof ClientError)) this.logger.exception(e); // Register unknown error
          // Restricted Video: This video is not available in your country. Or private account
          media = await this.mediaInfoV1(pk);
        }
      }
      this._medias_cache[pk] = media;
    }
    return deepcopy(this._medias_cache[pk]); // return copy of cache (dict changes protection)
  }

  /** Delete media by Media ID */
  async mediaDelete(this: Client, mediaId: string | number): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const id = await this.mediaId(mediaId);
    const result = await this.privateRequest(`media/${id}/delete/`, this.withDefaultData({ media_id: id }));
    delete this._medias_cache[this.mediaPk(id)];
    return result.did_delete ?? null;
  }

  /** Edit caption (and usertags/location; title for IGTV) for media */
  async mediaEdit(
    this: Client,
    mediaId: string | number,
    caption: string,
    title = '',
    usertags: Usertag[] = [],
    location: Location | null = null,
  ): Promise<any> {
    pyAssert(this.userId, 'Login required');
    const id = await this.mediaId(mediaId);
    const media = await this.mediaInfo(id); // from cache
    const tags = usertags.map((tag) => ({ user_id: tag.user.pk, position: [tag.x, tag.y] }));
    let data: Record<string, any> = {
      caption_text: caption,
      container_module: 'edit_media_info',
      feed_position: '0',
      location: this.locationBuild(location),
      usertags: require('../utils/serialization').pyJsonDumps({ in: tags }),
      is_carousel_bumped_post: 'false',
    };
    if (media.product_type === 'igtv') {
      if (!title) {
        const nl = caption.indexOf('\n');
        if (nl >= 0) {
          title = caption.slice(0, nl);
          caption = caption.slice(nl + 1);
        } else title = caption.slice(0, 75);
      }
      data = { caption_text: caption, title, igtv_ads_toggled_on: '0' };
    }
    delete this._medias_cache[this.mediaPk(id)]; // clean cache
    return this.privateRequest(`media/${id}/edit_media/`, this.withDefaultData(data));
  }

  /** Link one Reel to another Reel ("Watch Next" button). */
  async mediaLinkReel(this: Client, mediaId: string | number, targetMediaId: string | number, linkName = 'Watch Next'): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const id = await this.mediaId(mediaId);
    const target = await this.mediaId(targetMediaId);
    const data = {
      _uid: String(this.userId),
      _uuid: this.uuid,
      linked_media_info: dumps({ media_id: target, link_name: linkName }),
    };
    delete this._medias_cache[this.mediaPk(id)];
    const result = await this.privateRequest(`media/${id}/edit_media/`, this.withActionData(data));
    return result.status === 'ok';
  }

  /** Get author of the media */
  async mediaUser(this: Client, mediaPk: string | number): Promise<UserShort> {
    return (await this.mediaInfoV1(mediaPk)).user;
  }

  /** Return info about media and user from post URL */
  async mediaOembed(this: Client, url: string): Promise<MediaOembed> {
    return extractMediaOembed(await this.privateRequest(`oembed?url=${url}`));
  }

  /** Like a media (revert=true to unlike) */
  async mediaLike(this: Client, mediaId: string | number, revert = false): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const id = String(mediaId);
    const data = {
      inventory_source: 'media_or_ad',
      media_id: id,
      _uid: String(this.userId),
      radio_type: 'wifi-none',
      delivery_class: 'organic',
      tap_source: 'button',
      is_2m_enabled: 'false',
      is_from_swipe: 'false',
      is_carousel_bumped_post: 'false',
      floating_context_items: '[]',
      media_pct_watched: '0',
      container_module: 'feed_timeline',
      feed_position: String(Math.floor(Math.random() * 7)),
    };
    const name = revert ? 'unlike' : 'like';
    const result = await this.privateRequest(`media/${id}/${name}/`, this.withActionData(data));
    return result.status === 'ok';
  }

  /** Unlike a media */
  async mediaUnlike(this: Client, mediaId: string | number): Promise<boolean> {
    return this.mediaLike(mediaId, true);
  }

  /**
   * Create a note attached to a media item (media/create_note/v2/ flow for notes attached to posts/Reels).
   * mediaId: full media id e.g. "3884795301060104481_52448022913".
   */
  async mediaNoteCreate(
    this: Client,
    mediaId: string,
    text = '',
    audience = 7,
    noteStyle = 13,
    extraData: Record<string, any> | null = null,
  ): Promise<any> {
    pyAssert(this.userId, 'Login required');
    const data: Record<string, any> = {
      inventory_source: 'recommended_clips_chaining_model',
      media_client_position: '0',
      media_id: String(mediaId),
      note_style: String(noteStyle),
      carousel_index: '-1',
      text,
      _uuid: this.uuid,
      audience: String(audience),
      event_source: 'ufi',
      container_module: 'clips_viewer_clips_tab',
    };
    if (extraData) Object.assign(data, extraData);
    return this.privateRequest('media/create_note/v2/', data, { withSignature: false });
  }

  /** Delete a note attached to a media item. */
  async mediaNoteDelete(this: Client, noteId: string, extraData: Record<string, any> | null = null): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const data: Record<string, any> = {
      inventory_source: 'recommended_clips_chaining_model',
      carousel_index: '-1',
      _uuid: this.uuid,
      event_source: 'ufi',
      container_module: 'clips_viewer_clips_tab',
      note_id: String(noteId),
    };
    if (extraData) Object.assign(data, extraData);
    const result = await this.privateRequest('media/delete_note/', data, { withSignature: false });
    return (result.status ?? '') === 'ok';
  }

  /**
   * Get a page of a user's media via private app GraphQL, with anonymous first-page public fallback on
   * endpoint/schema errors. Returns [medias, next end_cursor].
   */
  async userMediasPaginatedGql(this: Client, userId: string | number, amount = 0, _sleep = 2, endCursor: any = null): Promise<[Media[], string | null]> {
    let route: string;
    [route, endCursor] = _splitMediaCursor(endCursor);
    if (route) {
      if (route !== 'timeline-public' || this._hasPrivateAuth()) {
        throw new WrongCursorError('Use the same method and authentication for a routed public cursor');
      }
      return _mediaPageWithRoute(await this._userMediasPaginatedPublicGql(userId, Math.trunc(amount), endCursor), route);
    }
    amount = Math.trunc(amount);
    try {
      return await this._userMediasPaginatedAppGql(userId, amount, endCursor);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      if (this._hasPrivateAuth() || endCursor || !this._canUsePrivateGraphqlFallback(error)) throw error;
      return _mediaPageWithRoute(await this._userMediasPaginatedPublicGql(userId, amount, endCursor), 'timeline-public');
    }
  }

  /** Compatibility alias for the original chunk naming. */
  async userMediasChunkGql(this: Client, userId: string | number, sleepSec = 2, endCursor: any = null, amount = 0): Promise<[Media[], string | null]> {
    return this.userMediasPaginatedGql(userId, amount, sleepSec, endCursor);
  }

  /** Get a user's media via private app GraphQL (with anonymous public fallback). amount=0 → all medias */
  async userMediasGql(this: Client, userId: string | number, amount = 0, sleepSec = 0): Promise<Media[]> {
    amount = Math.trunc(amount);
    sleepSec = Math.trunc(sleepSec);
    let medias: Media[] = [];
    let endCursor: string | null = null;
    while (true) {
      this.logger.info(`user_medias_gql: ${amount}, ${endCursor}`);
      if (!sleepSec) sleepSec = 1 + Math.floor(Math.random() * 3);
      let page: Media[];
      [page, endCursor] = await this.userMediasPaginatedGql(userId, amount, sleepSec, endCursor);
      medias.push(...page);
      if (!endCursor || page.length === 0) break;
      if (amount && medias.length >= amount) break;
      await sleep(sleepSec);
    }
    if (amount) medias = medias.slice(0, amount);
    return medias;
  }

  /** Get a page of user's video by Private Mobile API. Returns [medias, next end_cursor]. */
  async userVideosPaginatedV1(this: Client, userId: string | number, amount = 50, endCursor = ''): Promise<[Media[], string | null]> {
    let items: any[] = [];
    amount = Math.trunc(amount);
    const id = BigInt(String(userId)).toString();
    let medias: any[] = [];
    try {
      const resp = await this.privateRequest('igtv/channel/', null, { params: { id: `uservideo_${id}`, count: 50 } });
      items = resp.items;
    } catch (e) {
      if (e instanceof PrivateError) throw e;
      this.logger.exception(e);
      return [[], null];
    }
    medias.push(...items);
    const nextMaxId = this.lastJson.next_max_id ?? '';
    void endCursor;
    if (amount) medias = medias.slice(0, amount);
    return [medias.map((m) => extractMediaV1(m)), nextMaxId];
  }
  /** Compatibility alias for the original chunk naming. */
  async userVideosChunkV1(this: Client, userId: string | number, endCursor = ''): Promise<[Media[], string | null]> {
    return this.userVideosPaginatedV1(userId, 50, endCursor);
  }

  /** Get a user's video by Private Mobile API */
  async userVideosV1(this: Client, userId: string | number, amount = 0): Promise<Media[]> {
    amount = Math.trunc(amount);
    let medias: Media[] = [];
    let nextMaxId: string | null = '';
    while (true) {
      let page: Media[];
      try {
        [page, nextMaxId] = await this.userVideosPaginatedV1(userId, amount, nextMaxId || '');
      } catch (e) {
        if (e instanceof PrivateError) throw e;
        this.logger.exception(e);
        break;
      }
      medias.push(...page);
      if (!nextMaxId) break;
      if (amount && medias.length >= amount) break;
    }
    if (amount) medias = medias.slice(0, amount);
    return medias;
  }

  /** Get a page of user's media by Private Mobile API. Returns [medias, next end_cursor]. */
  async userMediasPaginatedV1(this: Client, userId: string | number, amount = 33, endCursor: string | null = ''): Promise<[Media[], string | null]> {
    amount = Math.trunc(amount);
    const id = BigInt(String(userId)).toString();
    let medias: any[] = [];
    const items = (
      await this.privateRequest(`feed/user/${id}/`, null, {
        params: { max_id: endCursor, count: amount, min_timestamp: null, rank_token: this.rankToken, ranked_content: 'true' },
      })
    ).items;
    medias.push(...items);
    const nextMaxId = this.lastJson.next_max_id ?? '';
    if (amount) medias = medias.slice(0, amount);
    return [medias.map((m) => extractMediaV1(m)), nextMaxId];
  }

  /** Compatibility alias for the original chunk naming. */
  async userMediasChunkV1(this: Client, userId: string | number, endCursor = ''): Promise<[Media[], string | null]> {
    return this.userMediasPaginatedV1(userId, 33, endCursor);
  }

  /** Get a user's media by Private Mobile API (amount=0 → all medias) */
  async userMediasV1(this: Client, userId: string | number, amount = 0): Promise<Media[]> {
    amount = Math.trunc(amount);
    let medias: Media[] = [];
    let nextMaxId: string | null = '';
    while (true) {
      let page: Media[];
      [page, nextMaxId] = await this.userMediasPaginatedV1(userId, amount, nextMaxId);
      medias.push(...page);
      if (!nextMaxId) break;
      if (amount && medias.length >= amount) break;
    }
    if (amount) medias = medias.slice(0, amount);
    return medias;
  }

  /** Get a page of user's media. Returns [medias, next end_cursor]. */
  async userMediasPaginated(this: Client, userId: string | number, amount = 0, endCursor: any = ''): Promise<[Media[], string | null]> {
    let route: string;
    [route, endCursor] = _splitMediaCursor(endCursor);
    if (route) {
      let page: [Media[], string | null];
      if (route === 'timeline-app') page = await this._userMediasPaginatedAppGql(userId, Math.trunc(amount), endCursor);
      else if (route === 'timeline-public' && !this._hasPrivateAuth()) page = await this._userMediasPaginatedPublicGql(userId, Math.trunc(amount), endCursor);
      else if (route === 'timeline-v1') page = await this.userMediasPaginatedV1(userId, Math.trunc(amount), endCursor);
      else throw new WrongCursorError('Use the same method and authentication for a routed media cursor');
      return _mediaPageWithRoute(page, route);
    }
    const publicLookup = async (): Promise<[Media[], string | null]> => {
      try {
        return await this.userMediasPaginatedGql(userId, amount, 2, endCursor);
      } catch (e) {
        if (e instanceof ClientLoginRequired) {
          if (!this.injectSessionidToPublic()) throw e;
          return this.userMediasPaginatedGql(userId, amount, 2, endCursor);
        }
        throw e;
      }
    };
    const endCursorIsV1 = Boolean(endCursor && String(endCursor).includes('_'));
    let medias: Media[];
    if (this._hasPrivateAuth() || endCursorIsV1) {
      try {
        [medias, endCursor] = await this.userMediasPaginatedV1(userId, amount, endCursor);
      } catch (e) {
        if (e instanceof PrivateError) throw e;
        if (endCursor || !this._canUsePrivateGraphqlFallback(e)) throw e;
        if (endCursorIsV1) throw e;
        if (!(e instanceof ClientError)) this.logger.exception(e);
        [medias, endCursor] = _mediaPageWithRoute(await publicLookup(), 'timeline-app');
      }
    } else {
      try {
        [medias, endCursor] = _mediaPageWithRoute(await publicLookup(), 'timeline-app');
      } catch (e) {
        if (e instanceof PrivateError) throw e;
        if (endCursor || !this._canUsePrivateGraphqlFallback(e)) throw e;
        if (!(e instanceof ClientError)) this.logger.exception(e);
        [medias, endCursor] = _mediaPageWithRoute(await this.userMediasPaginatedV1(userId, amount, endCursor), 'timeline-v1');
      }
    }
    return [medias, endCursor];
  }

  /** Compatibility alias for the original chunk naming. */
  async userMediasChunk(this: Client, userId: string | number, endCursor = ''): Promise<[Media[], string | null]> {
    return this.userMediasPaginated(userId, 0, endCursor);
  }

  /** Iterate over a user's media (async iterator). pageSize=0 keeps the endpoint default. */
  iterUserMedias(this: Client, userId: string | number, amount = 0, pageSize = 0): AsyncGenerator<Media> {
    const id = String(userId);
    const fetchPage = (cursor: any, pageAmount: number) => this.userMediasPaginated(id, pageAmount, cursor);
    return iterPaginated<Media>(fetchPage, amount, pageSize, '');
  }

  /** Get a pinned medias */
  async userPinnedMedias(this: Client, userId: string | number): Promise<Media[]> {
    const id = String(userId);
    const navChain = 'MainFeedFragment:feed_timeline:12:main_home::,UserDetailFragment:profile:13:button::';
    const medias = await this.privateRequest(`feed/user/${id}/`, null, {
      params: { exclude_comment: 'true', only_fetch_first_carousel_media: 'false' },
      headers: { 'X-IG-Nav-Chain': navChain },
    });
    const pinned: Media[] = [];
    for (const media of medias.items) {
      const pinnedUserIds = media.timeline_pinned_user_ids || [];
      if (pinnedUserIds.map(String).includes(id)) pinned.push(extractMediaV1(media));
    }
    return pinned;
  }

  /** Get a user's media (private API with public fallback, or vice versa) */
  async userMedias(this: Client, userId: string | number, amount = 0, sleepSec = 0): Promise<Media[]> {
    amount = Math.trunc(amount);
    sleepSec = Math.trunc(sleepSec);
    const publicLookup = async (): Promise<Media[]> => {
      try {
        return await this.userMediasGql(userId, amount, sleepSec);
      } catch (e) {
        if (e instanceof ClientLoginRequired) {
          if (!this.injectSessionidToPublic()) throw e;
          return this.userMediasGql(userId, amount, sleepSec); // retry
        }
        throw e;
      }
    };
    if (this._hasPrivateAuth()) {
      try {
        return await this.userMediasV1(userId, amount);
      } catch (e) {
        if (e instanceof PrivateError) throw e;
        if (!this._canUsePrivateGraphqlFallback(e)) throw e;
        if (!(e instanceof ClientError)) this.logger.exception(e);
        return publicLookup();
      }
    }
    try {
      return await publicLookup();
    } catch (e) {
      if (e instanceof PrivateError) throw e;
      if (!this._canUsePrivateGraphqlFallback(e)) throw e;
      if (!(e instanceof ClientError)) this.logger.exception(e);
      // User may been private, attempt via Private API
      // (You can check is_private, but there may be other reasons, it is better to try through a Private API)
      return this.userMediasV1(userId, amount);
    }
  }

  /** Get a page of user's clip (reels) by Private Mobile API. Returns [medias, next end_cursor]. */
  async userClipsPaginatedV1(this: Client, userId: string | number, amount = 50, endCursor: string | null = ''): Promise<[Media[], string | null]> {
    amount = Math.trunc(amount);
    const id = BigInt(String(userId)).toString();
    let medias: any[] = [];
    let items: any[];
    try {
      items = (
        await this.privateRequest('clips/user/', {
          target_user_id: Number.isSafeInteger(Number(id)) ? Number(id) : BigInt(id),
          max_id: endCursor,
          page_size: amount, // default from app: 12
          include_feed_video: 'true',
        })
      ).items;
    } catch (e) {
      if (e instanceof PrivateError) throw e;
      this.logger.exception(e);
      return [[], null];
    }
    medias.push(...items);
    const nextMaxId = jsonValue(this.lastJson, 'paging_info', 'max_id', { default: '' });
    if (amount) medias = medias.slice(0, amount);
    return [medias.map((m) => extractMediaV1(m.media)), nextMaxId];
  }

  /** Compatibility alias for the original chunk naming. */
  async userClipsChunkV1(this: Client, userId: string | number, endCursor = ''): Promise<[Media[], string | null]> {
    return this.userClipsPaginatedV1(userId, 50, endCursor);
  }

  /** Get a user's clip (reels) by Private Mobile API */
  async userClipsV1(this: Client, userId: string | number, amount = 0): Promise<Media[]> {
    amount = Math.trunc(amount);
    let medias: Media[] = [];
    let nextMaxId: string | null = '';
    while (true) {
      let page: Media[];
      try {
        [page, nextMaxId] = await this.userClipsPaginatedV1(userId, 50, nextMaxId);
      } catch (e) {
        if (e instanceof PrivateError) throw e;
        this.logger.exception(e);
        break;
      }
      medias.push(...page);
      if (!nextMaxId) break;
      if (amount && medias.length >= amount) break;
    }
    if (amount) medias = medias.slice(0, amount);
    return medias;
  }

  /** Get a user's clip (reels) */
  async userClips(this: Client, userId: string | number, amount = 0): Promise<Media[]> {
    return this.userClipsV1(userId, Math.trunc(amount));
  }

  /** Mark medias as seen */
  async mediaSeen(this: Client, mediaIds: Array<string | number>, skippedMediaIds: Array<string | number> = []): Promise<boolean> {
    const gen = async (ids: Array<string | number>) => {
      const result: Record<string, string[]> = {};
      for (const mid of ids) {
        const [mediaPk, userId] = (await this.mediaId(mid)).split('_');
        const end = Math.trunc(Date.now() / 1000);
        const begin = end - (100 + Math.floor(Math.random() * 2901));
        result[`${mediaPk}_${userId}_${userId}`] = [`${begin}_${end}`];
      }
      return result;
    };
    const data = {
      container_module: 'feed_timeline',
      live_vods_skipped: {},
      nuxes_skipped: {},
      nuxes: {},
      reels: await gen(mediaIds),
      live_vods: {},
      reel_media_skipped: await gen(skippedMediaIds),
    };
    const result = await this.privateRequest('/v2/media/seen/?reel=1&live_vod=0', this.withDefaultData(data));
    return result.status === 'ok';
  }

  /** Get media likers */
  async mediaLikers(this: Client, mediaId: string | number): Promise<UserShort[]> {
    const id = await this.mediaId(mediaId);
    const result = await this.privateRequest(`media/${id}/likers/`);
    return result.users.map((u: any) => extractUserShort(u));
  }

  /** Get media likers through the web GraphQL doc_id endpoint. */
  async mediaLikersGqlChunk(this: Client, mediaPk: string, endCursor = ''): Promise<any[]> {
    void endCursor;
    const data = {
      variables: dumps({ id: mediaPk }),
      doc_id: '24452425501069647',
      fb_dtsg: await this.getFbDtsg(),
      jazoest: generateJazoest(this.phoneId),
      ...GQL_STUFF,
    };
    const resp = await this.graphqlRequest({ data });
    return ((resp.data || {}).xdt_api__v1__likes__media_id__likers || {}).users || [];
  }

  /** Get media likers through the web GraphQL doc_id endpoint. */
  async mediaLikersGql(this: Client, mediaPk: string | number, amount = 0): Promise<any[]> {
    let likers = await this.mediaLikersGqlChunk(this.mediaPk(mediaPk));
    if (amount) likers = likers.slice(0, amount);
    return likers;
  }

  /** Archive a media (revert=true to unarchive) */
  async mediaArchive(this: Client, mediaId: string | number, revert = false): Promise<boolean> {
    const id = await this.mediaId(mediaId);
    const name = revert ? 'undo_only_me' : 'only_me';
    const result = await this.privateRequest(`media/${id}/${name}/`, this.withActionData({ media_id: id }));
    return result.status === 'ok';
  }

  /** Unarchive a media */
  async mediaUnarchive(this: Client, mediaId: string | number): Promise<boolean> {
    return this.mediaArchive(mediaId, true);
  }

  /** Get a page of your archived medias by Private Mobile API. Returns [medias, next end_cursor]. */
  async archiveMediasPaginatedV1(this: Client, amount = 0, endCursor = ''): Promise<[Media[], string]> {
    amount = Math.trunc(amount);
    const params = endCursor ? { max_id: endCursor } : {};
    const result = await this.privateRequest('feed/only_me_feed/', null, { params });
    let items: any[] = result.items || [];
    if (amount) items = items.slice(0, amount);
    const medias = items.map((item) => extractMediaV1(item.media ?? item));
    return [medias, result.max_id || ''];
  }
  /** Get your archived medias by Private Mobile API */
  async archiveMediasV1(this: Client, amount = 0): Promise<Media[]> {
    amount = Math.trunc(amount);
    let medias: Media[] = [];
    let nextMaxId = '';
    while (true) {
      let page: Media[];
      [page, nextMaxId] = await this.archiveMediasPaginatedV1(amount, nextMaxId);
      medias.push(...page);
      if (!nextMaxId) break;
      if (amount && medias.length >= amount) break;
    }
    if (amount) medias = medias.slice(0, amount);
    return medias;
  }

  /** Get your archived medias */
  async archiveMedias(this: Client, amount = 0): Promise<Media[]> {
    return this.archiveMediasV1(amount);
  }

  _gqlUserId(this: Client, userId: string | number): number | string {
    const id = BigInt(String(userId)).toString();
    return Number.isSafeInteger(Number(id)) ? Number(id) : id;
  }

  /** Get medias where a user is tagged (by Public GraphQL API) */
  async usertagMediasGql(this: Client, userId: string | number, amount = 0, sleepSec = 2): Promise<Media[]> {
    amount = Math.trunc(amount);
    let medias: any[] = [];
    let endCursor: string | null = null;
    const variables: Record<string, any> = { id: this._gqlUserId(userId), first: !amount || amount > 50 ? 50 : amount };
    while (true) {
      if (endCursor) variables.after = endCursor;
      const data = await this.publicGraphqlRequest(variables, { queryHash: 'be13233562af2d229b008d2976b998b5' });
      const pageInfo = jsonValue(data, 'user', 'edge_user_to_photos_of_you', 'page_info', { default: {} });
      const edges = jsonValue(data, 'user', 'edge_user_to_photos_of_you', 'edges', { default: [] });
      for (const edge of edges) medias.push(edge.node);
      endCursor = pageInfo.end_cursor ?? null;
      if (!pageInfo.has_next_page || !endCursor || edges.length === 0) break;
      if (amount && medias.length >= amount) break;
      await sleep(sleepSec);
    }
    if (amount) medias = medias.slice(0, amount);
    return medias.map((m) => extractMediaGql(m));
  }

  /** Get a page of medias where a user is tagged (by Public GraphQL API). Returns [medias, end_cursor]. */
  async usertagMediasPaginatedGql(this: Client, userId: string | number, amount = 0, _sleep = 2, endCursor: string | null = null): Promise<[Media[], string | null]> {
    amount = Math.trunc(amount);
    const variables: Record<string, any> = { id: this._gqlUserId(userId), first: !amount || amount > 50 ? 50 : amount };
    if (endCursor) variables.after = endCursor;
    const data = await this.publicGraphqlRequest(variables, { queryHash: 'be13233562af2d229b008d2976b998b5' });
    const pageInfo = jsonValue(data, 'user', 'edge_user_to_photos_of_you', 'page_info', { default: {} });
    const edges = jsonValue(data, 'user', 'edge_user_to_photos_of_you', 'edges', { default: [] });
    let medias = edges.map((e: any) => e.node);
    if (amount) medias = medias.slice(0, amount);
    return [medias.map((m: any) => extractMediaGql(m)), pageInfo.end_cursor ?? null];
  }

  /** Get a page of medias where a user is tagged (by Private Mobile API). Returns [medias, next_max_id]. */
  async usertagMediasPaginatedV1(this: Client, userId: string | number, amount = 0, endCursor: string | null = ''): Promise<[Media[], string]> {
    amount = Math.trunc(amount);
    const id = BigInt(String(userId)).toString();
    const result = await this.privateRequest(`usertags/${id}/feed/`, null, { params: { max_id: endCursor } });
    let items: any[] = result.items || [];
    if (amount) items = items.slice(0, amount);
    return [items.map((m) => extractMediaV1(m)), result.next_max_id || ''];
  }

  /** Compatibility alias for the original chunk naming. */
  async usertagMediasV1Chunk(this: Client, userId: string | number, maxId = ''): Promise<[Media[], string]> {
    return this.usertagMediasPaginatedV1(userId, 0, maxId);
  }

  /** Get medias where a user is tagged (by Private Mobile API) */
  async usertagMediasV1(this: Client, userId: string | number, amount = 0): Promise<Media[]> {
    amount = Math.trunc(amount);
    const id = BigInt(String(userId)).toString();
    let medias: any[] = [];
    let nextMaxId = '';
    while (true) {
      const items = (await this.privateRequest(`usertags/${id}/feed/`, null, { params: { max_id: nextMaxId } })).items;
      medias.push(...items);
      if (!this.lastJson.more_available) break;
      if (amount && medias.length >= amount) break;
      nextMaxId = this.lastJson.next_max_id ?? '';
    }
    if (amount) medias = medias.slice(0, amount);
    return medias.map((m) => extractMediaV1(m));
  }

  /** Get a page of medias where a user is tagged. Returns [medias, end_cursor]. */
  async usertagMediasPaginated(this: Client, userId: string | number, amount = 0, endCursor: any = ''): Promise<[Media[], string | null]> {
    let route: string;
    [route, endCursor] = _splitMediaCursor(endCursor);
    if (route) {
      if (route !== 'tagged-v1') throw new WrongCursorError('Use the same method for a routed tagged-media cursor');
      return _mediaPageWithRoute(await this.usertagMediasPaginatedV1(userId, Math.trunc(amount), endCursor), route);
    }
    amount = Math.trunc(amount);
    if (this._hasPrivateAuth()) return this.usertagMediasPaginatedV1(userId, amount, endCursor);
    try {
      return await this.usertagMediasPaginatedGql(userId, amount, 2, endCursor);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      if (endCursor || !this._canUsePrivateGraphqlFallback(error)) throw error;
      return _mediaPageWithRoute(await this.usertagMediasPaginatedV1(userId, amount, endCursor), 'tagged-v1');
    }
  }

  /** Get medias where a user is tagged */
  async usertagMedias(this: Client, userId: string | number, amount = 0): Promise<Media[]> {
    amount = Math.trunc(amount);
    if (this._hasPrivateAuth()) return this.usertagMediasV1(userId, amount);
    try {
      return await this.usertagMediasGql(userId, amount);
    } catch (error) {
      if (!(error instanceof ClientError)) throw error;
      if (!this._canUsePrivateGraphqlFallback(error)) throw error;
      return this.usertagMediasV1(userId, amount);
    }
  }

  /**
   * Configure an uploaded photo as a Cutout Sticker.
   * manualBox: [x, y, w, h] normalized (0.0..1.0); [0,0,1,1] selects the full image (bypass AI).
   * useAiDetection: asks Instagram to detect the subject (server-side AI).
   */
  async mediaConfigureToCutoutSticker(
    this: Client,
    uploadId: string,
    sourceType = 'library',
    manualBox: number[] | null = null,
    useAiDetection = false,
    extraData: Record<string, string> | null = null,
  ): Promise<Media> {
    const data: Record<string, any> = {
      upload_id: uploadId,
      source_type: sourceType,
      sticker_type: 'cutout_sticker',
      _uuid: this.uuid,
      _uid: this.userIdInt,
    };
    if (extraData) Object.assign(data, extraData);
    if (manualBox && manualBox.length) {
      data.cutout_sticker_data = require('../utils/serialization').pyJsonDumps({ manual_mask: { box: manualBox } });
    } else if (useAiDetection) data.detect_subject = 'true';
    const result = await this.privateRequest('media/configure_to_cutout_sticker/', data);
    return this._extractConfiguredMediaOrRaise(result, PrivateError, 'Cutout sticker upload');
  }

  /** Pin post to user profile (revert=true to unpin) */
  async mediaPin(this: Client, mediaPk: string | number, revert = false): Promise<boolean> {
    const data = this.withActionData({ post_id: mediaPk, _uuid: this.uuid });
    const name = revert ? 'unpin' : 'pin';
    const result = await this.privateRequest(`users/${name}_timeline_media/`, data);
    return result.status === 'ok';
  }

  /** Unpin post from user profile */
  async mediaUnpin(this: Client, mediaPk: string | number): Promise<boolean> {
    return this.mediaPin(mediaPk, true);
  }

  /** Fetch a clip template (remix-from-template) for a clip media. */
  async mediaTemplateV1(this: Client, mediaId: string): Promise<any> {
    return this.privateRequest('clips/template/', { should_show_friends_media_at_top: 'false', template_clips_media_id: mediaId, _uuid: this.uuid });
  }

  /**
   * Poll the processing status of an async upload (media/get_upload_status_REST/).
   * Returns raw response with posts and medias entries, each carrying status (PENDING, COMPLETED, ...) and error_info.
   */
  async mediaUploadStatus(this: Client, postClientId: string): Promise<any> {
    return this.privateRequest('media/get_upload_status_REST/', { post_client_id: String(postClientId) }, { withSignature: true });
  }

  /** Refresh the playable video resources of a media (fresh video_versions + DASH manifest). */
  async videoRefreshResources(this: Client, mediaId: string, shouldFetchAllLanguageVariants = false): Promise<any> {
    return this.privateRequest(`video/refresh_resources/${mediaId}/`, null, {
      params: { should_fetch_all_language_variants: String(shouldFetchAllLanguageVariants).toLowerCase() },
    });
  }

  /** Create a new live broadcast. Returns {broadcast_id, stream_server, stream_key}. */
  async mediaCreateLivestream(this: Client, title = 'Instagram Live'): Promise<Record<string, any> | undefined> {
    const data = {
      _uuid: this.uuid,
      _uid: this.userIdInt,
      preview_height: 1920,
      preview_width: 1080,
      broadcast_message: title,
      broadcast_type: 'RTMP',
      internal_only: 0,
      _csrftoken: this.token,
    };
    try {
      const response = await this.privateRequest('live/create/', data);
      const broadcastId = response.broadcast_id;
      const uploadUrl = String(response.upload_url).split(String(broadcastId));
      if (uploadUrl.length >= 2) {
        return { broadcast_id: broadcastId, stream_server: uploadUrl[0], stream_key: `${broadcastId}${uploadUrl[1]}` };
      }
      return undefined;
    } catch (e: any) {
      this.logger.error(`Error creating live broadcast: ${e?.message ?? e}`);
      throw e;
    }
  }

  /** Start a live broadcast. */
  async mediaStartLivestream(this: Client, broadcastId: string): Promise<boolean> {
    const data = { _uuid: this.uuid, _uid: this.userIdInt, should_send_notifications: 1, _csrftoken: this.token };
    try {
      const response = await this.privateRequest(`live/${broadcastId}/start/`, data);
      return response.status === 'ok';
    } catch (e: any) {
      this.logger.error(`Error starting live broadcast: ${e?.message ?? e}`);
      return false;
    }
  }

  /** End a live broadcast. */
  async mediaEndLivestream(this: Client, broadcastId: string): Promise<boolean> {
    const data = { _uuid: this.uuid, _uid: this.userIdInt, _csrftoken: this.token };
    try {
      const response = await this.privateRequest(`live/${broadcastId}/end_broadcast/`, data);
      return response.status === 'ok';
    } catch (e: any) {
      this.logger.error(`Error ending live broadcast: ${e?.message ?? e}`);
      return false;
    }
  }

  /** Retrieve information about the live broadcast. */
  async mediaGetLivestreamInfo(this: Client, broadcastId: string): Promise<any> {
    try {
      return await this.privateRequest(`live/${broadcastId}/info/`);
    } catch (e: any) {
      this.logger.error(`Error retrieving live info: ${e?.message ?? e}`);
      throw e;
    }
  }

  /** Retrieve comments from the live broadcast. */
  async mediaGetLivestreamComments(this: Client, broadcastId: string): Promise<Array<{ username: string; text: string }>> {
    try {
      const response = await this.privateRequest(`live/${broadcastId}/get_comment/`);
      if ('comments' in response) return response.comments.map((c: any) => ({ username: c.user.username, text: c.text }));
      return [];
    } catch (e: any) {
      this.logger.error(`Error retrieving live comments: ${e?.message ?? e}`);
      throw e;
    }
  }

  /** Retrieve the list of viewers of the live broadcast. */
  async mediaGetLivestreamViewers(this: Client, broadcastId: string): Promise<Array<{ username: string; pk: any }>> {
    try {
      const response = await this.privateRequest(`live/${broadcastId}/get_viewer_list/`);
      return (response.users || []).map((u: any) => ({ username: u.username, pk: u.pk }));
    } catch (e: any) {
      this.logger.error(`Error retrieving live viewers: ${e?.message ?? e}`);
      throw e;
    }
  }
}
