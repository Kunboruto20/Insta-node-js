import { ClientGraphqlError, PrivateError } from '../exceptions';
import { extractHashtagV1, extractLocation, extractMediaV1, extractTrack, extractUserShort } from '../extractors';
import { Hashtag, Location, Media, Track, UserShort, makeHashtag } from '../types';
import { deepcopy } from '../utils/serialization';
import { pyAssert } from '../utils/validation';
import type { Client } from '../client';

/** Opaque cursor for mediaSearchTopGqlChunk (immutable) */
export class TopSerpCursor {
  constructor(
    readonly query: string,
    readonly searchIds: readonly [string, string, string],
    readonly after: string,
    readonly seenMedia: ReadonlySet<string>,
    readonly seenCursors: ReadonlySet<string>,
  ) {
    Object.freeze(this);
  }
  toString(): string {
    return 'TopSerpCursor(...)';
  }
}

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class FbSearchMixin {
  _validateFbsearchMediaGrid(this: Client, result: any): Record<string, any> {
    const response = this.lastResponse;
    if (!isDict(result)) throw new PrivateError('Malformed fbsearch/top_serp response', { response });
    const mediaGrid = result.media_grid;
    if (mediaGrid === null || mediaGrid === undefined) throw new PrivateError('Missing media_grid in fbsearch/top_serp response', { response });
    if (!isDict(mediaGrid)) throw new PrivateError('Malformed media_grid in fbsearch/top_serp response', { response });
    const sections = mediaGrid.sections;
    if (sections !== null && sections !== undefined && !Array.isArray(sections)) {
      throw new PrivateError('Malformed media_grid sections in fbsearch/top_serp response', { response });
    }
    return mediaGrid;
  }

  *_fbsearchMediaGridNodes(this: Client, mediaGrid: Record<string, any>): Generator<Record<string, any>> {
    const yieldMediaItems = function* (items: any) {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const media = isDict(item) ? item.media : null;
        if (isDict(media)) yield media;
      }
    };
    for (const section of mediaGrid.sections || []) {
      if (!isDict(section)) continue;
      const layoutContent = section.layout_content || {};
      if (!isDict(layoutContent)) continue;
      const oneByTwoItem = layoutContent.one_by_two_item || {};
      if (isDict(oneByTwoItem)) {
        const media = oneByTwoItem.media;
        if (isDict(media)) yield media;
        const clips = oneByTwoItem.clips || {};
        if (isDict(clips)) yield* yieldMediaItems(clips.items);
      }
      for (const key of ['fill_items', 'medias']) yield* yieldMediaItems(layoutContent[key]);
    }
  }

  async fbsearchPlaces(this: Client, query: string, lat = 40.74, lng = -73.94): Promise<Location[]> {
    const params = { search_surface: 'places_search_page', timezone_offset: this.timezoneOffset, lat, lng, count: 30, query };
    const result = await this.privateRequest('fbsearch/places/', null, { params });
    return result.items.map((item: any) => extractLocation(item.location)!);
  }

  /** Return account results from Instagram's web search on a saved session. The query must contain at least one non-whitespace character. */
  async webSearchUsers(this: Client, query: string): Promise<UserShort[]> {
    if (!query.trim()) throw new Error('query must not be blank');
    const data = await this.publicDocIdGraphqlRequest(
      '27706427925724183',
      {
        data: {
          context: 'blended',
          include_reel: 'true',
          query,
          rank_token: '', // This initial search ranking field is empty.
          search_session_id: this.generateUuid(),
          search_surface: 'web_top_search',
        },
        hasQuery: true,
      },
      {
        referer: 'https://www.instagram.com/explore/',
        headers: { 'X-FB-Friendly-Name': 'PolarisSearchBoxRefetchableQuery' },
        url: this.GRAPHQL_PUBLIC_WEB_API_URL,
        includeLsd: true,
        includeFbDtsg: true,
      },
    );
    const connection = isDict(data) ? data.xdt_api__v1__fbsearch__topsearch_connection : null;
    const entries = isDict(connection) ? connection.users : null;
    const error = 'Malformed web account search response';
    if (!Array.isArray(entries)) throw new ClientGraphqlError(error);
    const users: UserShort[] = [];
    for (const entry of entries) {
      const user = isDict(entry) ? entry.user : null;
      if (!isDict(user)) throw new ClientGraphqlError(error);
      const pk = String(user.pk || user.id || '');
      if (!/^\d+$/.test(pk)) throw new ClientGraphqlError(error);
      try {
        users.push(extractUserShort(deepcopy({ ...user, id: pk })));
      } catch (exc) {
        throw new ClientGraphqlError(error, { cause: exc });
      }
    }
    return users;
  }

  async webSearchTopsearch(this: Client, query: string): Promise<any> {
    const params = { search_surface: 'web_top_search', context: 'blended', include_reel: 'true', query };
    return this.privateRequest('web/search/topsearch/', null, { params });
  }

  async fbsearchTopsearchFlat(this: Client, query: string): Promise<any[]> {
    const params = { search_surface: 'top_search_page', context: 'blended', timezone_offset: this.timezoneOffset, count: 30, query };
    return (await this.privateRequest('fbsearch/topsearch_flat/', null, { params })).list;
  }

  /** Search users (overrides UserMixin.searchUsers like in python's MRO; `count` is ignored, IG returns 30) */
  async searchUsers(this: Client, query: string, _count?: number): Promise<UserShort[]> {
    const params = { search_surface: 'user_search_page', timezone_offset: this.timezoneOffset, count: 30, q: query };
    const result = await this.privateRequest('users/search/', null, { params });
    return result.users.map((u: any) => extractUserShort(u));
  }

  async searchMusic(this: Client, query: string): Promise<Track[]> {
    const params = { query, browse_session_id: this.generateUuid() };
    const result = await this.privateRequest('music/audio_global_search/', null, { params });
    return result.items.filter((i: any) => i.track).map((i: any) => extractTrack(i.track));
  }

  async searchHashtags(this: Client, query: string): Promise<Hashtag[]> {
    const params = { search_surface: 'hashtag_search_page', timezone_offset: this.timezoneOffset, count: 30, q: query };
    const result = await this.privateRequest('tags/search/', null, { params });
    return result.results.map((h: any) => extractHashtagV1(h));
  }

  async fbsearchSuggestedProfiles(this: Client, userId: string | number): Promise<UserShort[]> {
    const params = { target_user_id: userId, include_friendship_status: 'true' };
    const result = await this.privateRequest('fbsearch/accounts_recs/', null, { params });
    return result.users.map((u: any) => extractUserShort(u));
  }

  async webSearchTopsearchHashtags(this: Client, query: string): Promise<Hashtag[]> {
    const result = await this.webSearchTopsearch(query);
    return (result.hashtags || []).map((item: any) => extractHashtagV1(item.hashtag));
  }

  async fbsearchItem(
    this: Client,
    itemId: string,
    searchSurface: string,
    query: string,
    opts: {
      timezoneOffset?: number;
      count?: number;
      reelsPageIndex?: number | null;
      hasMoreReels?: string | null;
      reelsMaxId?: string | null;
      nextMaxId?: string | null;
      rankToken?: string | null;
      pageIndex?: number | null;
      pageToken?: string | null;
      pagingToken?: string | null;
    } = {},
  ): Promise<any> {
    const { timezoneOffset = 0, count = 30 } = opts;
    const params: Record<string, any> = { search_surface: searchSurface, query };
    if (timezoneOffset) params.timezone_offset = timezoneOffset;
    if (count) params.count = count;
    if (opts.reelsPageIndex !== null && opts.reelsPageIndex !== undefined) params.reels_page_index = opts.reelsPageIndex;
    if (opts.hasMoreReels) params.has_more_reels = opts.hasMoreReels;
    if (opts.reelsMaxId) params.reels_max_id = opts.reelsMaxId;
    if (opts.nextMaxId) params.next_max_id = opts.nextMaxId;
    if (opts.rankToken) params.rank_token = opts.rankToken;
    if (opts.pageIndex !== null && opts.pageIndex !== undefined) params.page_index = opts.pageIndex;
    if (opts.pageToken) params.page_token = opts.pageToken;
    if (opts.pagingToken) params.paging_token = opts.pagingToken;
    return this.privateRequest(`fbsearch/${itemId}/`, null, { params });
  }

  async fbsearchKeywordTypeahead(this: Client, query: string, timezoneOffset = 0, count = 30): Promise<any> {
    const params: Record<string, any> = { search_surface: 'typeahead_search_page', query, context: 'blended' };
    if (timezoneOffset) params.timezone_offset = timezoneOffset;
    if (count) params.count = count;
    return this.privateRequest('fbsearch/keyword_typeahead/', null, { params });
  }

  async fbsearchTypeaheadStream(this: Client, query: string, timezoneOffset = 0, count = 30): Promise<any> {
    const params: Record<string, any> = { search_surface: 'typeahead_search_page', query, context: 'blended' };
    if (timezoneOffset) params.timezone_offset = timezoneOffset;
    if (count) params.count = count;
    return this.privateRequest('fbsearch/typeahead_stream/', null, { params });
  }

  /** Retrieves recently searched results: list of [client_time, UserShort | Hashtag | keyword dict] */
  async fbsearchRecent(this: Client): Promise<Array<[number | null, UserShort | Hashtag | Record<string, any>]>> {
    const result = await this.privateRequest('fbsearch/recent_searches/');
    pyAssert((result.status ?? '') === 'ok', 'Failed to retrieve recent searches');
    const data: Array<[number | null, any]> = [];
    for (const item of result.recent || []) {
      if ('user' in item) data.push([item.client_time ?? null, extractUserShort(item.user)]);
      if ('hashtag' in item) {
        const hashtag = item.hashtag;
        hashtag.media_count = hashtag.formatted_media_count;
        delete hashtag.formatted_media_count;
        data.push([item.client_time ?? null, makeHashtag(hashtag)]);
      }
      if ('keyword' in item) data.push([item.client_time ?? null, item.keyword]);
    }
    return data;
  }

  /** Search accounts via the v2 SERP endpoint (GET /fbsearch/account_serp/). */
  async fbsearchAccountsV2(this: Client, query: string, pageToken: string | null = null): Promise<any> {
    const params: Record<string, any> = { search_surface: 'account_serp', timezone_offset: this.timezoneOffset, query };
    if (pageToken) params.page_token = pageToken;
    return this.privateRequest('fbsearch/account_serp/', null, { params });
  }

  /** Search reels via the v2 SERP endpoint (GET /fbsearch/reels_serp/). */
  async fbsearchReelsV2(this: Client, query: string, reelsMaxId: string | null = null, rankToken: string | null = null): Promise<any> {
    const params: Record<string, any> = { search_surface: 'clips_search_page', timezone_offset: this.timezoneOffset, query };
    if (reelsMaxId) params.reels_max_id = reelsMaxId;
    if (rankToken) params.rank_token = rankToken;
    return this.privateRequest('fbsearch/reels_serp/', null, { params });
  }

  /** Blended search (accounts + hashtags + media + reels) via the v2 SERP endpoint (GET /fbsearch/top_serp/). */
  async fbsearchTopsearchV2(
    this: Client,
    query: string,
    nextMaxId: string | null = null,
    reelsMaxId: string | null = null,
    rankToken: string | null = null,
  ): Promise<any> {
    const params: Record<string, any> = { search_surface: 'top_serp', timezone_offset: this.timezoneOffset, query, rank_token: this.rankToken };
    if (nextMaxId) params.next_max_id = nextMaxId;
    if (rankToken) params.rank_token = rankToken;
    if (reelsMaxId) params.reels_max_id = reelsMaxId;
    return this.privateRequest('fbsearch/top_serp/', null, { params });
  }

  _topSerpMediaPk(this: Client, item: Record<string, any>): string {
    const pk = String(item.pk || item.id || '').split('_')[0];
    return /^\d+$/.test(pk) ? pk : '';
  }

  /** Return media from the first page of mobile Top search. With amount=0, return every media item on that page. */
  async mediaSearchTopGql(this: Client, query: string, amount = 0): Promise<Media[]> {
    if (amount < 0) throw new Error('amount must be non-negative');
    const connection = await this._topSerpConnection(query, this._topSerpSearchIds());
    return this._extractTopSerpMedia(connection, new Set(), amount);
  }

  /**
   * Return one page of mobile Top search media and the cursor for the next page.
   * Pass the returned cursor with the same query and authenticated session until the cursor is null.
   */
  async mediaSearchTopGqlChunk(this: Client, query: string, cursor: TopSerpCursor | null = null): Promise<[Media[], TopSerpCursor | null]> {
    let searchIds: readonly [string, string, string];
    let after: string | null;
    let seenMedia: Set<string>;
    let seenCursors: ReadonlySet<string>;
    if (cursor === null || cursor === undefined) {
      searchIds = this._topSerpSearchIds();
      after = null;
      seenMedia = new Set();
      seenCursors = new Set();
    } else {
      if (!(cursor instanceof TopSerpCursor)) throw new TypeError('cursor must come from mediaSearchTopGqlChunk');
      if (cursor.query !== query) throw new Error('cursor belongs to a different search query');
      searchIds = cursor.searchIds;
      after = cursor.after;
      seenMedia = new Set(cursor.seenMedia);
      seenCursors = cursor.seenCursors;
    }
    const connection = await this._topSerpConnection(query, searchIds, after);
    const medias = this._extractTopSerpMedia(connection, seenMedia);
    const pageInfo = connection.page_info;
    if (!isDict(pageInfo) || pageInfo.has_next_page !== true) return [medias, null];
    const nextAfter = pageInfo.end_cursor;
    if (typeof nextAfter !== 'string' || !nextAfter || seenCursors.has(nextAfter)) return [medias, null];
    return [medias, new TopSerpCursor(query, searchIds, nextAfter, new Set(seenMedia), new Set([...seenCursors, nextAfter]))];
  }

  _topSerpSearchIds(this: Client): [string, string, string] {
    return [this.generateUuid(), this.generateUuid(), this.generateUuid()];
  }

  async _topSerpConnection(this: Client, query: string, searchIds: readonly [string, string, string], after: string | null = null): Promise<Record<string, any>> {
    const [searchSessionId, serpSessionId, journeySessionId] = searchIds;
    const variables: Record<string, any> = {
      query,
      search_session_id: searchSessionId,
      serp_session_id: serpSessionId,
      journey_session_id: journeySessionId,
      turn_id: 0,
      skip_over_fetched_user_fields: false,
      should_include_media_overlay_info_in_lightweight: true,
      in_serp_interacted_media_ids: [],
      is_pagination_request: after !== null,
      should_fetch_timeline_in_skw: false,
      serp_origination_context: { serp_origination: 'keyboard', session_state: 'typeahead', keyword_context: 'null', cdd_ranking_token: null },
      is_incremental_delivery_enabled: false,
      enable_clips_metadata_in_light_media: false,
      include_profile_update_info: true,
      search_type: 'SEARCH',
      remove_view_count_from_lightweight: true,
      remove_unused_video_subtitles_status: true,
      include_journey_header: false,
      is_page_info_fetched_in_separate_chunk: true,
      remove_unused_deprecated_owner_counts: true,
      exclude_main_user_field: false,
      enable_pando_connection: false,
      num_media_to_fetch: 10,
      remove_unused_video_subtitles_confidence: true,
      lightweight_carousel_type: 'DELAYED_METADATA',
      delay_clips_viewer_fragment: true,
      search_surface: 'TOP_SERP',
      enable_tentpole_story_previews: true,
      exclude_pinned_posts: true,
      is_discovery_grid_enabled: true,
      exclude_caption_user_field: false,
      hcm_entrypoint: 'IG_SEARCH_TYPEAHEAD_KEYBOARD_SEND',
      lightweight_carousel_count: 1,
      include_clips_viewer_fragment: true,
      remove_unused_carousel_pending_post_count: true,
      remove_paid_partnership_and_subtitles_from_lightweight: true,
      enable_thumbnails_in_light_media: false,
      include_search_engine_attributes: false,
      remove_unused_views_on_grid_status: false,
      include_search_social_context: false,
      enable_serp_clips_viewer_deduplication: true,
    };
    if (after !== null) variables.after = after;
    const result = await this.privateGraphqlRequest(
      {
        method: 'post',
        format: 'json',
        locale: 'user',
        server_timestamps: 'true',
        fb_api_req_friendly_name: 'TopSerpQuery',
        client_doc_id: '418531681916451609839969517761',
        variables: JSON.stringify(variables),
      },
      { 'X-Root-Field-Name': 'xdt_fbsearch__top_serp_graphql' },
    );
    const data = result.data;
    let connection: any = null;
    if (isDict(data)) connection = 'manual_pagination_query' in data ? data.manual_pagination_query : data.xdt_fbsearch__top_serp_graphql;
    if (!isDict(connection) || !Array.isArray(connection.edges)) throw new PrivateError('Missing TopSerpQuery edges', { response: this.lastResponse });
    return connection;
  }

  _extractTopSerpMedia(this: Client, connection: Record<string, any>, seen: Set<string>, amount = 0): Media[] {
    const medias: Media[] = [];
    for (const edge of connection.edges) {
      if (!isDict(edge)) continue;
      const node = edge.node;
      if (!isDict(node) || node.__typename !== 'XDTTopSerpMediaGridUnit') continue;
      const items = node.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!isDict(item) || item.__typename !== 'XDTMediaDict') continue;
        const mediaPk = this._topSerpMediaPk(item);
        const user = item.user;
        if (!mediaPk || seen.has(mediaPk) || !isDict(user)) continue;
        const userPk = user.id || user.pk;
        if (!userPk) continue;
        const normalized: Record<string, any> = { ...item, pk: mediaPk, id: `${mediaPk}_${userPk}`, user: { ...user, id: userPk } };
        const children = item.carousel_media;
        if (Array.isArray(children)) {
          normalized.carousel_media = children
            .filter((c: any) => isDict(c) && this._topSerpMediaPk(c))
            .map((c: any) => ({ ...c, pk: this._topSerpMediaPk(c) }));
        }
        try {
          medias.push(extractMediaV1(normalized));
        } catch {
          this.logger.warning('Skipping malformed TopSerpQuery media item');
          continue;
        }
        seen.add(mediaPk);
        if (amount && medias.length >= amount) return medias;
      }
    }
    return medias;
  }

  /** Search top media by keyword via the private fbsearch SERP. */
  async mediaSearch(this: Client, query: string, amount = 27): Promise<Media[]> {
    let medias: Media[] = [];
    let nextMaxId: string | null = null;
    let reelsMaxId: string | null = null;
    let rankToken: string | null = null;
    const seenCursors = new Set<string>();
    while (true) {
      const result = await this.fbsearchTopsearchV2(query, nextMaxId || null, reelsMaxId || null, rankToken || null);
      const mediaGrid = this._validateFbsearchMediaGrid(result);
      for (const node of this._fbsearchMediaGridNodes(mediaGrid)) {
        if (amount && medias.length >= amount) break;
        try {
          medias.push(extractMediaV1(node));
        } catch (exc: any) {
          if (exc instanceof TypeError || exc instanceof RangeError) {
            this.logger.warning('Skipping malformed fbsearch media node: %s', exc.message);
            continue;
          }
          throw exc;
        }
      }
      if (amount && medias.length >= amount) break;
      nextMaxId = mediaGrid.next_max_id || result.next_max_id || null;
      if (!mediaGrid.has_more || !nextMaxId) break;
      reelsMaxId = mediaGrid.reels_max_id || result.reels_max_id || null;
      rankToken = mediaGrid.rank_token || result.rank_token || null;
      const cursorKey = JSON.stringify([String(nextMaxId), reelsMaxId !== null && reelsMaxId !== undefined ? String(reelsMaxId) : null]);
      if (seenCursors.has(cursorKey)) break;
      seenCursors.add(cursorKey);
    }
    if (amount) medias = medias.slice(0, amount);
    return medias;
  }

  /** Typeahead user suggestions via the streaming endpoint (flattens stream_rows into users). */
  async fbsearchTypehead(this: Client, query: string): Promise<any[]> {
    const params = { search_surface: 'typeahead_search_page', timezone_offset: this.timezoneOffset, query, context: 'blended' };
    const res = await this.privateRequest('fbsearch/typeahead_stream/', null, { params });
    const rows = res.stream_rows || [];
    return rows.flatMap((row: any) => row.users || []);
  }
}
