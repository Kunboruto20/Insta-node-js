import * as Boom from '@hapi/boom';
import * as config from '../config';
import { HighlightNotFound } from '../exceptions';
import { extractHighlightV1 } from '../extractors';
import { Highlight } from '../types';
import { dumps, jsonDumps } from '../utils/serialization';
import { randomInt } from '../utils/timing';
import { vassert } from '../utils/validation';
import type { Client } from '../client';

export class HighlightMixin {
  /** Get Highlight PK from URL. Example: https://www.instagram.com/stories/highlights/17983407089364361/ -> 17983407089364361 */
  highlightPkFromUrl(this: Client, url: string): string {
    vassert(url.includes('/highlights/'), "URL must contain '/highlights/'");
    const p = new URL(url, 'http://placeholder').pathname;
    const parts = p.split('/').filter((x) => x && /^\d+$/.test(x));
    if (!parts.length) throw Boom.badRequest('Invalid highlight URL');
    return String(parts[0]);
  }

  /** Get a user's highlights (Private API) */
  async userHighlightsV1(this: Client, userId: string | number, amount = 0): Promise<Highlight[]> {
    amount = Math.trunc(amount);
    const id = BigInt(String(userId)).toString();
    const params = {
      supported_capabilities_new: jsonDumps(config.SUPPORTED_CAPABILITIES),
      phone_id: this.phoneId,
      battery_level: randomInt(25, 100),
      panavision_mode: '',
      is_charging: randomInt(0, 1),
      is_dark_mode: randomInt(0, 1),
      will_sound_on: randomInt(0, 1),
    };
    const result = await this.privateRequest(`highlights/${id}/highlights_tray/`, null, { params });
    let tray: any[] = result.tray || [];
    if (amount > 0) tray = tray.slice(0, amount);
    return tray.map((h) => extractHighlightV1(h));
  }

  /** Get a user's highlights */
  async userHighlights(this: Client, userId: string | number, amount = 0): Promise<Highlight[]> {
    return this.userHighlightsV1(userId, amount);
  }

  /** Get Highlight by pk or id (by Private Mobile API) */
  async highlightInfoV1(this: Client, highlightPk: string | number): Promise<Highlight> {
    const highlightId = `highlight:${highlightPk}`;
    const data = {
      exclude_media_ids: '[]',
      supported_capabilities_new: jsonDumps(config.SUPPORTED_CAPABILITIES),
      source: 'profile',
      _uid: String(this.userId),
      _uuid: this.uuid,
      user_ids: [highlightId],
    };
    const result = await this.privateRequest('feed/reels_media/', data);
    const reels = result.reels;
    if (!(highlightId in reels)) throw new HighlightNotFound({ ...reels, highlight_pk: highlightPk });
    return extractHighlightV1(reels[highlightId]);
  }

  /** Get Highlight by pk or id */
  async highlightInfo(this: Client, highlightPk: string | number): Promise<Highlight> {
    return this.highlightInfoV1(highlightPk);
  }

  /** Create highlight. coverStoryId: story used as cover, default is first of storyIds */
  async highlightCreate(
    this: Client,
    title: string,
    storyIds: Array<string | number>,
    coverStoryId: string | number = '',
    cropRect: number[] = [0.0, 0.21830457, 1.0, 0.78094524],
  ): Promise<Highlight> {
    if (!coverStoryId) coverStoryId = storyIds[0];
    const mediaIds: string[] = [];
    for (const sid of storyIds) mediaIds.push(await this.mediaId(sid));
    const data = {
      supported_capabilities_new: jsonDumps(config.SUPPORTED_CAPABILITIES),
      source: 'self_profile',
      creation_id: String(Math.trunc(Date.now() / 1000)),
      _uid: String(this.userId),
      _uuid: this.uuid,
      cover: dumps({ media_id: await this.mediaId(coverStoryId), crop_rect: formatCropRect(cropRect) }),
      title,
      media_ids: dumps(mediaIds),
    };
    const result = await this.privateRequest('highlights/create_reel/', data);
    return extractHighlightV1(result.reel);
  }

  async highlightEdit(
    this: Client,
    highlightPk: string | number,
    title = '',
    cover: Record<string, any> = {},
    addedMediaIds: string[] = [],
    removedMediaIds: string[] = [],
  ): Promise<Highlight> {
    const data: Record<string, any> = {
      supported_capabilities_new: jsonDumps(config.SUPPORTED_CAPABILITIES),
      source: 'self_profile',
      _uid: String(this.userId),
      _uuid: this.uuid,
      added_media_ids: dumps(addedMediaIds),
      removed_media_ids: dumps(removedMediaIds),
    };
    if (title) data.title = title;
    if (cover && Object.keys(cover).length) data.cover = dumps(cover);
    const result = await this.privateRequest(`highlights/highlight:${highlightPk}/edit_reel/`, data);
    return extractHighlightV1(result.reel);
  }

  /** Change title for highlight */
  async highlightChangeTitle(this: Client, highlightPk: string | number, title: string): Promise<Highlight> {
    return this.highlightEdit(highlightPk, title);
  }

  /** Change cover for highlight */
  async highlightChangeCover(this: Client, highlightPk: string | number, coverPath: string): Promise<Highlight> {
    const [uploadId] = await this.photoRupload(coverPath);
    return this.highlightEdit(highlightPk, '', { upload_id: String(uploadId), crop_rect: '[0.0,0.0,1.0,1.0]' });
  }

  /** Add stories to highlight */
  async highlightAddStories(this: Client, highlightPk: string | number, addedMediaIds: string[]): Promise<Highlight> {
    return this.highlightEdit(highlightPk, '', {}, addedMediaIds);
  }

  /** Remove stories from highlight */
  async highlightRemoveStories(this: Client, highlightPk: string | number, removedMediaIds: string[]): Promise<Highlight> {
    return this.highlightEdit(highlightPk, '', {}, [], removedMediaIds);
  }

  /** Delete highlight */
  async highlightDelete(this: Client, highlightPk: string | number): Promise<boolean> {
    const result = await this.privateRequest(`highlights/highlight:${highlightPk}/delete_reel/`, { _uid: String(this.userId), _uuid: this.uuid });
    return result.status === 'ok';
  }
}

/** Serialize a float list keeping the ".0" suffix (e.g. [0.0,0.21830457,1.0,0.78094524]) */
function formatCropRect(rect: number[]): string {
  return '[' + rect.map((n) => (Number.isInteger(n) ? `${n}.0` : String(n))).join(',') + ']';
}
