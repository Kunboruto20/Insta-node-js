import { isInvalidInput } from '../core/boomErrors';
import * as Boom from '@hapi/boom';
import { ClientError, ClientLoginRequired, HashtagNotFound, PrivateError, WrongCursorError } from '../core/errorClasses';
import { extractHashtagGql, extractHashtagV1, extractMediaGql, extractMediaV1 } from '../parsing/responseParsers';
import { Hashtag, Media, makeHashtag } from '../models/schemas';
import { iterPaginated } from '../helpers/pagination';
import { parseJson } from '../helpers/bigJson';
import { dumps, jsonDumps } from '../helpers/encoding';
import { ensure } from '../helpers/assertions';
import type { Client } from '../core/instaClient';

export type HashtagTab = 'top' | 'recent' | 'clips';

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Helpers for managing Hashtag */
export class HashtagFeature {
  *_hashtagSectionMediaNodes(this: Client, section: Record<string, any>): Generator<any> {
    const layoutContent = section.layout_content || {};
    const oneByTwoItem = layoutContent.one_by_two_item || {};
    if (isDict(oneByTwoItem)) {
      const clips = oneByTwoItem.clips || {};
      if (isDict(clips)) for (const node of clips.items || []) yield node;
    }
    for (const key of ['fill_items', 'medias']) for (const node of layoutContent[key] || []) yield node;
  }

  _normalizeHashtagName(this: Client, name: string): string {
    let normalized = name.trim();
    if (normalized.startsWith('#')) {
      normalized = normalized.replace(/^#+/, '').trim();
      if (!normalized) throw Boom.badRequest('Hashtag name cannot be empty');
      process.emitWarning(`Hashtag names should not include a leading '#'; normalized to '${normalized}'.`, 'UserWarning');
    }
    if (!normalized) throw Boom.badRequest('Hashtag name cannot be empty');
    return normalized;
  }

  /** Get information about a hashtag by Public Graphql API */
  async hashtagInfoGql(this: Client, name: string, amount = 12, endCursor: string | null = null): Promise<Hashtag> {
    name = this._normalizeHashtagName(name);
    const variables: Record<string, any> = { tag_name: name, show_ranked: false, first: Math.trunc(amount) };
    if (endCursor) variables.after = endCursor;
    const data = await this.publicGraphqlRequest(variables, { queryHash: 'f92f56d47dc7a55b606908374b43a314' });
    if (!data.hashtag) throw new HashtagNotFound({ ...data, name });
    return extractHashtagGql(data.hashtag);
  }

  /** Get information about a hashtag by Private Mobile API */
  async hashtagInfoV1(this: Client, name: string): Promise<Hashtag> {
    name = this._normalizeHashtagName(name);
    return extractHashtagV1(await this.privateRequest(`tags/${name}/info/`));
  }

  /** Get information about a hashtag */
  async hashtagInfo(this: Client, name: string): Promise<Hashtag> {
    return this.hashtagInfoV1(this._normalizeHashtagName(name));
  }

  /** Get chunk of medias for a hashtag and max_id (cursor) by Private Mobile API. Returns [medias, next cursor] */
  async hashtagMediasV1Chunk(this: Client, name: string, maxAmount = 27, tabKey: HashtagTab = 'top', maxId: string | null = null): Promise<[Media[], string | null]> {
    name = this._normalizeHashtagName(name);
    ensure(['top', 'recent', 'clips'].includes(tabKey), 'You must specify one of the options for "tab_key" ("top", "recent", "clips")');
    const mediaRecencyFilter: Record<string, string> = { top: 'default', recent: 'top_recent_posts' };
    const data: Record<string, any> = {
      tab: tabKey,
      media_recency_filter: mediaRecencyFilter[tabKey] ?? tabKey,
      // "page": 1,
      _uuid: this.uuid,
      include_persistent: 'false',
      rank_token: this.rankToken,
    };
    if (maxId) {
      let pageId: any;
      let nmIds: any;
      try {
        const decoded = parseJson(Buffer.from(maxId, 'base64').toString('utf8'));
        if (!Array.isArray(decoded) || decoded.length !== 2) throw Boom.badRequest('Invalid cursor');
        [pageId, nmIds] = decoded;
      } catch {
        throw new WrongCursorError();
      }
      data.max_id = pageId;
      data.next_media_ids = dumps(nmIds);
    }
    const medias: Media[] = [];
    const result = await this.privateRequest(`tags/${name}/sections/`, data, { withSignature: false });
    let nextMaxId: string | null = null;
    if (result.next_max_id) {
      nextMaxId = Buffer.from(jsonDumps([result.next_max_id, result.next_media_ids ?? null])).toString('base64');
    }
    for (const section of result.sections) {
      for (const node of this._hashtagSectionMediaNodes(section)) {
        if (maxAmount && medias.length >= maxAmount) break;
        let media: Media;
        try {
          if (!node || node.media === undefined) throw Boom.badData('Missing field: media');
          media = extractMediaV1(node.media);
        } catch (exc: any) {
          if (isInvalidInput(exc)) {
            this.logger.warning('Skipping malformed hashtag node: %s', exc.message);
            continue;
          }
          throw exc;
        }
        // check contains hashtag in caption
        // if f"#{name}" not in media.caption_text: continue
        medias.push(media);
      }
    }
    if (!result.more_available) nextMaxId = null; // stop
    return [medias, nextMaxId];
  }

  _isHashtagV1Cursor(this: Client, cursor: string | null | undefined): boolean {
    if (!cursor) return false;
    try {
      const value = parseJson(Buffer.from(cursor, 'base64').toString('utf8'));
      return Array.isArray(value) && value.length === 2;
    } catch {
      return false;
    }
  }

  /** Get a page of medias for a hashtag by Public GraphQL API. Returns [medias, next cursor] */
  async hashtagMediasPaginatedGql(this: Client, name: string, amount = 27, endCursor: string | null = null): Promise<[Media[], string | null]> {
    name = this._normalizeHashtagName(name);
    amount = Math.trunc(amount);
    const variables: Record<string, any> = { tag_name: name, show_ranked: false, first: amount };
    if (endCursor) variables.after = endCursor;
    const data = await this.publicGraphqlRequest(variables, { queryHash: 'f92f56d47dc7a55b606908374b43a314' });
    if (!data.hashtag) throw new HashtagNotFound({ ...data, name });
    const mediaEdge = data.hashtag.edge_hashtag_to_media || {};
    const pageInfo = mediaEdge.page_info || {};
    const nextCursor = pageInfo.has_next_page ? pageInfo.end_cursor ?? null : null;
    let medias: Media[] = [];
    for (const edge of mediaEdge.edges || []) {
      try {
        medias.push(extractMediaGql(edge.node));
      } catch (exc: any) {
        if (isInvalidInput(exc)) this.logger.warning('Skipping malformed hashtag GraphQL node: %s', exc.message);
        else throw exc;
      }
    }
    if (amount) medias = medias.slice(0, amount);
    return [medias, nextCursor];
  }

  /** Get a page of medias for a hashtag by Private Mobile API */
  async hashtagMediasPaginatedV1(this: Client, name: string, amount = 27, tabKey: HashtagTab = 'recent', endCursor: string | null = null): Promise<[Media[], string | null]> {
    name = this._normalizeHashtagName(name);
    return this.hashtagMediasV1Chunk(name, Math.trunc(amount), tabKey, endCursor);
  }

  /** Get a page of medias for a hashtag */
  async hashtagMediasPaginated(this: Client, name: string, amount = 27, tabKey: HashtagTab = 'recent', endCursor: string | null = null): Promise<[Media[], string | null]> {
    name = this._normalizeHashtagName(name);
    amount = Math.trunc(amount);
    const endCursorIsV1 = this._isHashtagV1Cursor(endCursor);
    const privateRequired = tabKey !== 'recent' || endCursorIsV1;
    const publicLookup = async () => {
      try {
        return await this.hashtagMediasPaginatedGql(name, amount, endCursor);
      } catch (e) {
        if (e instanceof ClientLoginRequired) {
          if (!this.injectSessionidToPublic()) throw e;
          return this.hashtagMediasPaginatedGql(name, amount, endCursor);
        }
        throw e;
      }
    };
    const privateLookup = () => this.hashtagMediasPaginatedV1(name, amount, tabKey, endCursor);
    if (this._hasPrivateAuth() || privateRequired) return privateLookup();
    try {
      return await publicLookup();
    } catch (e) {
      if (e instanceof PrivateError) throw e;
      if (endCursor || !this._canUsePrivateGraphqlFallback(e)) throw e;
      if (!(e instanceof ClientError)) this.logger.exception(e);
      return privateLookup();
    }
  }

  /** Iterate over medias for a hashtag (async iterator) */
  iterHashtagMedias(this: Client, name: string, amount = 0, pageSize = 27, tabKey: HashtagTab = 'recent'): AsyncGenerator<Media> {
    name = this._normalizeHashtagName(name);
    const fetchPage = (cursor: any, pageAmount: number) => this.hashtagMediasPaginated(name, pageAmount, tabKey, cursor);
    return iterPaginated<Media>(fetchPage, amount, pageSize, null);
  }

  /** Get medias for a hashtag by Private Mobile API */
  async hashtagMediasV1(this: Client, name: string, amount = 27, tabKey: HashtagTab = 'top'): Promise<Media[]> {
    name = this._normalizeHashtagName(name);
    let medias: Media[] = [];
    let maxId: string | null = null;
    while (true) {
      let items: Media[];
      [items, maxId] = await this.hashtagMediasV1Chunk(name, amount, tabKey, maxId);
      medias.push(...items);
      if (amount && medias.length >= amount) break;
      if (!maxId) break;
    }
    if (amount) medias = medias.slice(0, amount);
    return medias;
  }

  /** Get top medias for a hashtag by Private Mobile API */
  async hashtagMediasTopV1(this: Client, name: string, amount = 9): Promise<Media[]> {
    return this.hashtagMediasV1(this._normalizeHashtagName(name), amount, 'top');
  }

  /** Get top medias for a hashtag */
  async hashtagMediasTop(this: Client, name: string, amount = 9): Promise<Media[]> {
    return this.hashtagMediasTopV1(this._normalizeHashtagName(name), amount);
  }

  /** Get recent medias for a hashtag by Private Mobile API */
  async hashtagMediasRecentV1(this: Client, name: string, amount = 27): Promise<Media[]> {
    return this.hashtagMediasV1(this._normalizeHashtagName(name), amount, 'recent');
  }

  /** Get recent medias for a hashtag */
  async hashtagMediasRecent(this: Client, name: string, amount = 27): Promise<Media[]> {
    return this.hashtagMediasRecentV1(this._normalizeHashtagName(name), amount);
  }

  /** Get reels medias for a hashtag by Private Mobile API */
  async hashtagMediasReelsV1(this: Client, name: string, amount = 27): Promise<Media[]> {
    return this.hashtagMediasV1(this._normalizeHashtagName(name), amount, 'clips');
  }

  /** Follow to hashtag (unfollow=true to unfollow) */
  async hashtagFollow(this: Client, hashtag: string, unfollow = false): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const name = unfollow ? 'unfollow' : 'follow';
    const data = this.withActionData({ user_id: this.userIdInt });
    const result = await this.privateRequest(`web/tags/${name}/${hashtag}/`, data, { domain: 'www.instagram.com' });
    return result.status === 'ok';
  }

  /** Get hashtags followed by the authenticated account (amount=0 → all) */
  async hashtagFollowing(this: Client, amount = 0): Promise<Hashtag[]> {
    ensure(this.userId, 'Login required');
    const result = await this.privateGraphqlFollowingList(String(this.userId), this.rankToken, undefined, null, 'u=3, i', null, null, null, false, false);
    const data = result.data || {};
    let following: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (isDict(value) && key.includes('xdt_api__v1__friendships__following')) {
        following = value;
        break;
      }
    }
    let hashtags: Hashtag[] = [];
    for (const item of following.preview_hashtags || []) {
      if (!isDict(item)) continue;
      let node = item.hashtag || item.node || item;
      if (!isDict(node) || !Object.keys(node).length) continue;
      node = { ...node };
      node.id = node.id || node.pk;
      node.media_count = node.media_count || node.post_count || node.postCount;
      node.profile_pic_url = node.profile_pic_url || node.profilePictureUrl || null;
      if (!node.id || !node.name) continue;
      hashtags.push(makeHashtag(node));
    }
    if (amount) hashtags = hashtags.slice(0, amount);
    return hashtags;
  }

  /** Unfollow to hashtag */
  async hashtagUnfollow(this: Client, hashtag: string): Promise<boolean> {
    return this.hashtagFollow(hashtag, true);
  }
}
