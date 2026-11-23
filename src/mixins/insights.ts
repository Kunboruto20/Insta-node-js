import { ClientError, MediaError, UserError } from '../exceptions';
import { jsonValue } from '../utils/serialization';
import { sleep } from '../utils/timing';
import { ensure } from '../utils/validation';
import type { Client } from '../client';

export const POST_TYPES = ['ALL', 'CAROUSEL_V2', 'IMAGE', 'SHOPPING', 'VIDEO'] as const;
export const TIME_FRAMES = ['ONE_WEEK', 'ONE_MONTH', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR', 'TWO_YEARS'] as const;
export const DATA_ORDERS = [
  'REACH_COUNT',
  'LIKE_COUNT',
  'FOLLOW',
  'SHARE_COUNT',
  'BIO_LINK_CLICK',
  'COMMENT_COUNT',
  'IMPRESSION_COUNT',
  'PROFILE_VIEW',
  'VIDEO_VIEW_COUNT',
  'SAVE_COUNT',
] as const;
export const EMPTY_GRAPHQL_QUERY_PARAM = ''; // Instagram GraphQL uses this as an empty access_token placeholder.

export type POST_TYPE = (typeof POST_TYPES)[number];
export type TIME_FRAME = (typeof TIME_FRAMES)[number];
export type DATA_ORDERING = (typeof DATA_ORDERS)[number];

/** Helper class to get insights */
export class InsightsMixin {
  /** Get insights for all medias from feed with page iteration with cursor and sleep timeout */
  async insightsMediaFeedAll(
    this: Client,
    postType: POST_TYPE = 'ALL',
    timeFrame: TIME_FRAME = 'TWO_YEARS',
    dataOrdering: DATA_ORDERING = 'REACH_COUNT',
    count = 0,
    sleepSec = 2,
  ): Promise<any[]> {
    ensure((POST_TYPES as readonly string[]).includes(postType), `Unsupported post_type="${postType}" ${POST_TYPES}`);
    ensure((TIME_FRAMES as readonly string[]).includes(timeFrame), `Unsupported time_frame="${timeFrame}" ${TIME_FRAMES}`);
    ensure((DATA_ORDERS as readonly string[]).includes(dataOrdering), `Unsupported data_ordering="${dataOrdering}" ${DATA_ORDERS}`);
    ensure(this.userId, 'Login required');
    let medias: any[] = [];
    let cursor: string | null = null;
    const data = { surface: 'post_grid', doc_id: 2345520318892697, locale: 'en_US', vc_policy: 'insights_policy', strip_nulls: false, strip_defaults: false };
    const queryParams: Record<string, any> = {
      IgInsightsGridMediaImage_SIZE: 480,
      count: 200, // TODO Try to detect max allowed value
      // "cursor": "0",
      dataOrdering,
      postType,
      timeframe: timeFrame,
      search_base: 'USER',
      is_user: 'true',
      queryParams: { access_token: EMPTY_GRAPHQL_QUERY_PARAM, id: this.userIdInt },
    };
    while (true) {
      if (cursor) queryParams.cursor = cursor;
      const result = await this.privateRequest('ads/graphql/', this.withQueryParams(data, queryParams));
      if (!jsonValue(result, 'data', 'shadow_instagram_user', 'business_manager', { default: null })) {
        throw new UserError('Account is not business account', { ...this.lastJson });
      }
      const stats = jsonValue(result, 'data', 'shadow_instagram_user', 'business_manager', 'top_posts_unit', 'top_posts');
      cursor = stats.page_info.end_cursor;
      medias.push(...stats.edges);
      if (!stats.page_info.has_next_page) break;
      if (count && medias.length >= count) break;
      await sleep(sleepSec);
    }
    if (count) medias = medias.slice(0, count);
    return medias;
  }

  /** Get insights for account */
  async insightsAccount(this: Client): Promise<any> {
    ensure(this.userId, 'Login required');
    const data = { surface: 'account', doc_id: 2449243051851783, locale: 'en_US', vc_policy: 'insights_policy', strip_nulls: false, strip_defaults: false };
    const queryParams = {
      IgInsightsGridMediaImage_SIZE: 360,
      activityTab: true,
      audienceTab: true,
      contentTab: true,
      query_params: { access_token: EMPTY_GRAPHQL_QUERY_PARAM, id: this.userIdInt },
    };
    const result = await this.privateRequest('ads/graphql/', this.withQueryParams(data, queryParams));
    const res = jsonValue(result, 'data', 'shadow_instagram_user', 'business_manager');
    if (!res) throw new UserError('Account is not business account', { ...this.lastJson });
    return res;
  }

  /** Get insights data for media */
  async insightsMedia(this: Client, mediaPk: string | number): Promise<any> {
    ensure(this.userId, 'Login required');
    const pk = this.mediaPk(mediaPk);
    const data = { surface: 'post', doc_id: 3221905377882880, locale: 'en_US', vc_policy: 'insights_policy', strip_nulls: false, strip_defaults: false };
    const queryParams = { query_params: { access_token: EMPTY_GRAPHQL_QUERY_PARAM, id: pk } };
    try {
      const result = await this.privateRequest('ads/graphql/', this.withQueryParams(data, queryParams));
      const media = jsonValue(result, 'data', 'instagram_post_by_igid', { default: null });
      if (!media) throw new MediaError('Instagram did not return insight data for media', { ...(this.lastJson || {}), media_pk: pk });
      if (!media.inline_insights_node) {
        throw new MediaError('Instagram returned media metadata without inline insights data', { ...(this.lastJson || {}), media_pk: pk });
      }
      return media;
    } catch (e: any) {
      if (e instanceof MediaError) throw e;
      if (e instanceof ClientError) throw new MediaError(e.message, { ...(this.lastJson || {}), media_pk: pk });
      throw e;
    }
  }
}
