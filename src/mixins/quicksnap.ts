import { ClientGraphqlError } from '../exceptions';
import { ensure } from '../utils/validation';
import type { Client } from '../client';

export const QUICKSNAP_HISTORY_CLIENT_DOC_ID = '202528380816979569862257718136';
export const QUICKSNAP_HISTORY_FRIENDLY_NAME = 'IGQuickSnapGetHistoryPaginatedQuery';
export const QUICKSNAP_CLIENT_ENDPOINT = 'InsightsHostImpl:quick_snap_audience_picker';

export class QuickSnapMixin {
  _quickSnapHistoryFromGraphqlResult(this: Client, result: Record<string, any>): Record<string, any> {
    const viewer = (result.data || {}).viewer || {};
    for (const [key, value] of Object.entries(viewer)) {
      if (key.includes('quick_snap_paginated_history') && value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, any>;
      }
    }
    throw new ClientGraphqlError('Failed to retrieve QuickSnap history');
  }

  _quickSnapNavChain(this: Client): string {
    const t = Date.now() / 1000;
    const f = (n: number) => n.toFixed(3);
    return (
      `DirectInboxFragment:direct_inbox:2:main_direct:${f(t - 55)}:::${f(t - 55)},` +
      `QuickSnapUnifiedFragment:quicksnap_unified_fragment:3:button:${f(t - 20)}:::${f(t - 20)},` +
      `ConstAnalyticsModule:quick_snap_camera:4:button:${f(t - 19)}:::${f(t - 19)},` +
      `${QUICKSNAP_CLIENT_ENDPOINT}:6:button:${f(t - 5)}:::${f(t - 5)}`
    );
  }

  /** Retrieve paginated QuickSnap history (raw quick_snap_paginated_history payload with edges and page_info). */
  async quicksnapHistory(this: Client, amount = 20, endCursor: string | null = null): Promise<Record<string, any>> {
    ensure(this.userId, 'Login required');
    const variables: Record<string, any> = { first: amount };
    if (endCursor) variables.after = endCursor;
    const result = await this.privateGraphqlWwwRequest(QUICKSNAP_HISTORY_FRIENDLY_NAME, variables, QUICKSNAP_HISTORY_CLIENT_DOC_ID);
    return this._quickSnapHistoryFromGraphqlResult(result);
  }

  /** Upload and publish a photo as a QuickSnap. Returns raw media/configure_to_quick_snap/ response. */
  async quicksnapSend(this: Client, photoPath: string, audience = 'mutual_followers', uploadId = ''): Promise<any> {
    ensure(this.userId, 'Login required');
    const [upId] = uploadId ? await this.photoRupload(photoPath, uploadId) : await this.photoRupload(photoPath);
    const navChain = this._quickSnapNavChain();
    const data = {
      original_height: '0',
      original_width: '0',
      include_e2ee_mentioned_user_list: '1',
      hide_from_profile_grid: 'false',
      timezone_offset: String(this.timezoneOffset),
      source_type: '3',
      _uid: String(this.userId),
      async_publish: '1',
      device_id: this.androidDeviceId,
      _uuid: this.uuid,
      nav_chain: navChain,
      audience,
      upload_id: upId,
      bottom_camera_dial_selected: '11',
      publish_id: '1',
      product_type: 'quick_snap',
      device: this.device,
      quick_snap_data: {},
    };
    return this.privateRequest('media/configure_to_quick_snap/', this.withDefaultData(data), {
      headers: { 'X-IG-Client-Endpoint': QUICKSNAP_CLIENT_ENDPOINT, 'X-IG-Nav-Chain': navChain },
    });
  }

  /** Soft-delete an active QuickSnap. */
  async quicksnapDelete(this: Client, mediaId: string): Promise<boolean> {
    ensure(this.userId, 'Login required');
    mediaId = String(mediaId);
    const result = await this.privateRequest(`media/${mediaId}/soft_delete/`, { media_id: mediaId, _uuid: this.uuid });
    return result.did_delete === true;
  }
}
