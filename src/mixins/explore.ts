import type { Client } from '../client';

/** Helpers for the explore page */
export class ExploreMixin {
  /** Get explore page */
  async explorePage(this: Client): Promise<any> {
    return this.privateRequest('discover/topical_explore/');
  }

  /** Report media in explore page. This is equivalent to the "not interested" button */
  async reportExploreMedia(this: Client, mediaPk: string | number): Promise<boolean> {
    const params = { m_pk: mediaPk };
    const result = await this.privateRequest('discover/explore_report/', null, { params });
    return result.explore_report_status === 'OK';
  }

  /**
   * Returns media information for a media item on the explore page
   * (the call that happens when you click into a media item on the explore page).
   */
  async explorePageMediaInfo(this: Client, mediaPk: string | number): Promise<any> {
    return (await this.privateRequest('/v1/discover/media_metadata/', null, { params: { media_id: mediaPk } })).media_or_ad;
  }
}
