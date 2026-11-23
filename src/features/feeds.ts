import { extractMediaV1 } from '../parsing/responseParsers';
import { Media } from '../models/schemas';
import type { Client } from '../core/instaClient';

/** Helpers for Reels */
export class ReelsFeature {
  /** Get connected reels media. lastMediaPk: last PK user has seen, returns medias after this pk */
  async reels(this: Client, amount = 10, lastMediaPk: string | number = 0): Promise<Media[]> {
    return this.reelsTimelineMedia('reels', amount, lastMediaPk);
  }

  /** Get discover reels media */
  async exploreReels(this: Client, amount = 10, lastMediaPk: string | number = 0): Promise<Media[]> {
    return this.reelsTimelineMedia('explore_reels', amount, lastMediaPk);
  }

  /** Get Friends tab reels media */
  async friendsReels(this: Client, amount = 10, lastMediaPk: string | number = 0): Promise<Media[]> {
    return this.reelsTimelineMedia('friends_reels', amount, lastMediaPk);
  }

  /** Get reels timeline media in a collection ("reels" | "explore_reels" | "friends_reels") */
  async reelsTimelineMedia(this: Client, collectionPk: string, amount = 10, lastMediaPk: string | number = 0): Promise<Media[]> {
    const endpoint = ({ reels: 'clips/connected/', explore_reels: 'clips/discover/', friends_reels: 'clips/discover/social/' } as Record<string, string>)[
      collectionPk
    ];
    if (!endpoint) {
      this.logger.warning('Unsupported reels timeline collection: %s', collectionPk);
      return [];
    }
    const lastPk = lastMediaPk && String(lastMediaPk) !== '0' ? BigInt(String(lastMediaPk)).toString() : null;
    const totalItems: Media[] = [];
    let nextMaxId = '';
    const seenCursors = new Set([nextMaxId]);
    while (true) {
      if (totalItems.length >= amount) return totalItems.slice(0, amount);
      let result: any;
      try {
        result = await this.privateRequest(endpoint, ' ', { params: { max_id: nextMaxId } });
      } catch (e) {
        this.logger.exception(e);
        return totalItems;
      }
      const items = result.items || result.items_with_ads || [];
      for (const item of items) {
        const media = item.media;
        if (!media) continue;
        if (lastPk && lastPk === String(media.pk)) return totalItems;
        totalItems.push(extractMediaV1(media));
        if (totalItems.length >= amount) return totalItems.slice(0, amount);
      }
      if (!(result.paging_info || {}).more_available) return totalItems;
      nextMaxId = (result.paging_info || {}).max_id ?? '';
      if (!nextMaxId || seenCursors.has(nextMaxId)) return totalItems;
      seenCursors.add(nextMaxId);
    }
  }
}
