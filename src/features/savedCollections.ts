import { CollectionNotFound } from '../core/errorClasses';
import { extractCollection, extractMediaV1 } from '../parsing/responseParsers';
import { Collection, Media } from '../models/schemas';
import { ensure } from '../helpers/assertions';
import type { Client } from '../core/instaClient';

/** Helpers for collection */
export class CollectionFeature {
  /** Get collections */
  async collections(this: Client): Promise<Collection[]> {
    let nextMaxId = '';
    const totalItems: Collection[] = [];
    while (true) {
      let result: any;
      try {
        result = await this.privateRequest('collections/list/', null, {
          params: { collection_types: '["ALL_MEDIA_AUTO_COLLECTION","PRODUCT_AUTO_COLLECTION","MEDIA"]', max_id: nextMaxId },
        });
      } catch (e) {
        this.logger.exception(e);
        return totalItems;
      }
      for (const item of result.items) totalItems.push(extractCollection(item));
      if (!result.more_available) return totalItems;
      nextMaxId = result.next_max_id || result.max_id || '';
    }
  }

  /** Get collection_pk by name */
  async collectionPkByName(this: Client, name: string): Promise<string> {
    for (const item of await this.collections()) if (item.name === name) return item.id;
    throw new CollectionNotFound({ name });
  }

  /** Get medias by collection name */
  async collectionMediasByName(this: Client, name: string, amount = 21, lastMediaPk: string | number = 0): Promise<Media[]> {
    return this.collectionMedias(await this.collectionPkByName(name), amount, lastMediaPk);
  }

  /** Get media you have liked */
  async likedMedias(this: Client, amount = 21, lastMediaPk: string | number = 0): Promise<Media[]> {
    return this.collectionMedias('liked', amount, lastMediaPk);
  }

  /** Get media in a collection by collection_pk ("liked", "saved"/other name, or numeric pk). Returns [medias, next max_id] */
  async collectionMediasV1Chunk(this: Client, collectionPk: string | number, maxId = ''): Promise<[Media[], string]> {
    let endpoint: string;
    if (typeof collectionPk === 'number' || /^\d+$/.test(collectionPk)) endpoint = `feed/collection/${collectionPk}/`;
    else if (collectionPk.toLowerCase() === 'liked') endpoint = 'feed/liked/';
    else endpoint = 'feed/saved/posts/';
    const params: Record<string, any> = { include_igtv_preview: 'false' };
    if (maxId) params.max_id = maxId;
    const result = await this.privateRequest(endpoint, null, { params });
    const items = result.items.map((m: any) => extractMediaV1(m.media ?? m));
    return [items, result.next_max_id || result.max_id || ''];
  }

  /** Get media in a collection by collection_pk. lastMediaPk: stop when this pk is reached */
  async collectionMediasV1(this: Client, collectionPk: string | number, amount = 21, lastMediaPk: string | number = 0): Promise<Media[]> {
    const lastPk = lastMediaPk && String(lastMediaPk) !== '0' ? String(lastMediaPk) : null;
    const totalItems: Media[] = [];
    let nextMaxId = '';
    amount = Math.trunc(amount);
    let foundLastMediaPk = false;
    while (true) {
      let items: Media[];
      [items, nextMaxId] = await this.collectionMediasV1Chunk(collectionPk, nextMaxId);
      for (const item of items) {
        if (lastPk && lastPk === String(item.pk)) {
          foundLastMediaPk = true;
          break;
        }
        totalItems.push(item);
      }
      if ((amount && totalItems.length >= amount) || foundLastMediaPk) break;
      if (!items.length || !nextMaxId) break;
    }
    return amount ? totalItems.slice(0, amount) : totalItems;
  }

  /** Get media in a collection by collection_pk */
  async collectionMedias(this: Client, collectionPk: string | number, amount = 21, lastMediaPk: string | number = 0): Promise<Media[]> {
    return this.collectionMediasV1(collectionPk, amount, lastMediaPk);
  }

  /** Save a media to collection (revert=true to unsave) */
  async mediaSave(this: Client, mediaId: string | number, collectionPk: string | number | null = null, revert = false): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const pk = this.mediaPk(mediaId);
    const data: Record<string, any> = { module_name: 'feed_timeline', radio_type: 'wifi-none' };
    if (collectionPk) data.added_collection_ids = `[${BigInt(String(collectionPk))}]`;
    const name = revert ? 'unsave' : 'save';
    const result = await this.privateRequest(`media/${pk}/${name}/`, this.withActionData(data));
    return result.status === 'ok';
  }

  /** Unsave a media */
  async mediaUnsave(this: Client, mediaId: string | number, collectionPk: string | number | null = null): Promise<boolean> {
    return this.mediaSave(mediaId, collectionPk, true);
  }
}
