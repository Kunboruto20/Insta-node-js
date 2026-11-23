import * as Boom from '@hapi/boom';
import { existsSync, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { loadSharp } from '../media/sharpLoader';
import * as config from '../core/defaults';
import { ClientError, PhotoConfigureError, PhotoConfigureStoryError, PhotoNotUpload } from '../core/errorClasses';
import { prepareImage, prepareStoryImageFit } from '../media/imageTools';
import {
  Location,
  Media,
  Story,
  StoryHashtag,
  StoryLink,
  StoryLocation,
  StoryMedia,
  StoryMention,
  StoryPoll,
  StoryResizeMode,
  StorySticker,
  Track,
  Usertag,
  makeStorySticker,
} from '../models/schemas';
import { dumps, floatValue, jsonDumps } from '../helpers/encoding';
import { dateTimeOriginal, randomInt, sleep } from '../helpers/delays';
import { withCoauthorUserIds } from '../helpers/uploadData';
import { ensure } from '../helpers/assertions';
import { CrosspostingOptions } from './crossPost';
import type { Client } from '../core/instaClient';

/** float value (null stays null) */
export function pf(v: number | null | undefined): any {
  return v === null || v === undefined ? null : floatValue(v);
}

/** round to 7 decimals (half-to-even) */
export function round7(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}

export interface PhotoUploadOptions extends CrosspostingOptions {
  uploadId?: string;
  usertags?: Usertag[];
  location?: Location | null;
  extraData?: Record<string, any>;
  scheduleAt?: number | Date | null;
  coauthorUserIds?: Array<string | number> | null;
}

export interface StoryUploadOptions {
  uploadId?: string;
  mentions?: StoryMention[];
  locations?: StoryLocation[];
  links?: StoryLink[];
  hashtags?: StoryHashtag[];
  stickers?: StorySticker[];
  medias?: StoryMedia[];
  polls?: StoryPoll[];
  extraData?: Record<string, any>;
  resizeMode?: StoryResizeMode;
}

export interface StoryMusicOptions extends StoryUploadOptions {
  thumbnail?: string | null;
  duration?: number;
  audioAssetStartTime?: number | null;
  overlapDuration?: number | null;
  originalVolume?: number;
  musicVolume?: number;
  product?: string;
  alacornSessionId?: string;
}

/** Helpers for downloading photo */
export class DownloadPhotoFeature {
  async _photoDownloadMediaInfo(this: Client, mediaPk: string): Promise<Media> {
    let media: Media | null;
    try {
      media = await this.mediaInfoGql(mediaPk);
    } catch (e) {
      if (!(e instanceof ClientError)) throw e;
      media = null;
    }
    if (media && media.media_type === 1 && media.thumbnail_url) return media;
    return this.mediaInfo(mediaPk);
  }

  /** Download photo using media pk. Returns path of the downloaded file */
  async photoDownload(this: Client, mediaPk: string | number, folder = '', overwrite = true): Promise<string> {
    const pk = this.mediaPk(String(mediaPk));
    const media = await this._photoDownloadMediaInfo(pk);
    ensure(media.media_type === 1, 'Must been photo');
    if (!media.thumbnail_url) throw Boom.badData('Photo thumbnail URL is empty');
    const filename = `${media.user.username}_${pk}`;
    return this.photoDownloadByUrl(String(media.thumbnail_url), filename, folder, overwrite);
  }

  /** Download photo using URL */
  async photoDownloadByUrl(this: Client, url: string, filename = '', folder = '', overwrite = true): Promise<string> {
    url = String(url);
    const p = new URL(url).pathname;
    const fname = p.slice(p.lastIndexOf('/') + 1);
    const name = filename ? `${filename}.${fname.slice(fname.lastIndexOf('.') + 1)}` : fname;
    const filePath = path.join(folder || '', name);
    if (existsSync(filePath) && !overwrite) return path.resolve(filePath);
    const response = await this._downloadGet(url);
    response.raise_for_status();
    return this._downloadResponseToPath(response, filePath);
  }

  /** Download photo using URL, returns bytes */
  async photoDownloadByUrlOrigin(this: Client, url: string): Promise<Buffer> {
    url = String(url);
    const response = await this._downloadGet(url);
    response.raise_for_status();
    return this._downloadResponseBytes(response, url);
  }
}

/** Helpers for uploading photo */
export class UploadPhotoFeature {
  /**
   * Upload photo to Instagram (rupload_igphoto). Returns [upload_id, width, height].
   * resizeMode "fit" is only supported for story uploads.
   */
  async photoRupload(
    this: Client,
    filePath: string,
    uploadId = '',
    toAlbum = false,
    forStory = false,
    resizeMode: StoryResizeMode = 'fill',
  ): Promise<[string, number, number]> {
    ensure(typeof filePath === 'string', `Path must been Path, now ${filePath} (${typeof filePath})`);
    if (resizeMode !== 'fill' && resizeMode !== 'fit') throw Boom.badRequest('resizeMode must be "fill" or "fit"');
    if (resizeMode === 'fit' && !forStory) throw Boom.badRequest('resizeMode "fit" is only supported for story uploads');
    const ext = path.extname(filePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) throw Boom.unsupportedMediaType('Invalid file format. Only JPG/JPEG/PNG/WEBP files are supported.');
    let imageType = 'image/jpeg';
    if (ext === '.png') imageType = 'image/png';
    else if (ext === '.webp') imageType = 'image/webp';
    // upload_id = 516057248854759
    uploadId = uploadId || String(Date.now());
    ensure(filePath, 'Not specified path to photo');
    const waterfallId = this.generateUuid();
    // upload_name example: '1576102477530_0_7823256191'
    const uploadName = `${uploadId}_0_${randomInt(1000000000, 9999999999)}`;
    // media_type: "2" when from video/igtv/album thumbnail, "1" - upload photo only
    const ruploadParams: Record<string, any> = {
      retry_context: '{"num_step_auto_retry":0,"num_reupload":0,"num_step_manual_retry":0}',
      media_type: '1', // "2" if upload_id else "1",
      xsharing_user_ids: '[]',
      upload_id: uploadId,
      image_compression: jsonDumps({ lib_name: 'moz', lib_version: '3.1.m', quality: '80' }),
    };
    if (toAlbum) ruploadParams.is_sidecar = '1';
    let photoData: Buffer;
    let photoSize: [number, number];
    const source = await this._loadMediaSource(filePath);
    if (forStory && resizeMode === 'fit') [photoData, photoSize] = await prepareStoryImageFit(source);
    else if (forStory) [photoData, photoSize] = await prepareImage(source, [1080, 1920], [9 / 16, 90 / 47]);
    else [photoData, photoSize] = await prepareImage(source);
    const photoLen = String(photoData.length);
    const headers = this.privateHeaders({
      'Accept-Encoding': 'gzip',
      'X-Instagram-Rupload-Params': jsonDumps(ruploadParams),
      X_FB_PHOTO_WATERFALL_ID: waterfallId,
      'X-Entity-Type': imageType,
      Offset: '0',
      'X-Entity-Name': uploadName,
      'X-Entity-Length': photoLen,
      'Content-Type': 'application/octet-stream',
      'Content-Length': photoLen,
    });
    const response = await this.private.post(`https://${config.API_DOMAIN}/rupload_igphoto/${uploadName}`, { data: photoData, headers });
    this.requestLog(response);
    if (response.status_code !== 200) {
      this.logger.error('Photo Upload failed with the following response: %s', response.status_code);
      const lastJson = this.lastJson; // local variable for read in sentry
      throw new PhotoNotUpload(response.text, { ...lastJson, response });
    }
    let width: number;
    let height: number;
    if (forStory && resizeMode === 'fit') [width, height] = photoSize;
    else {
      const meta = await loadSharp()(filePath).metadata();
      // PIL reports the stored (un-rotated) dimensions
      [width, height] = [meta.width!, meta.height!];
    }
    return [uploadId, width, height];
  }

  /** Upload photo and configure to feed */
  async photoUpload(this: Client, filePath: string, caption: string, opts: PhotoUploadOptions = {}): Promise<Media> {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) throw Boom.unsupportedMediaType('Invalid file format. Only JPG/JPEG/PNG/WEBP files are supported.');
    const usertags = opts.usertags ?? [];
    const location = opts.location ?? null;
    let extraData = withCoauthorUserIds(opts.extraData ?? {}, opts.coauthorUserIds ?? null);
    extraData = this._scheduledExtraData(extraData, opts.scheduleAt ?? null);
    extraData = await this._mediaCrosspostingExtraData(extraData, opts);
    const previousMediaIds = await this._currentMediaIds();
    const [uploadId, width, height] = await this.photoRupload(filePath, opts.uploadId ?? '');
    for (let attempt = 0; attempt < 10; attempt++) {
      this.logger.debug(`Attempt #${attempt} to configure Photo: ${filePath}`);
      await sleep(3);
      const configured = await this.photoConfigure(uploadId, width, height, caption, usertags, location, extraData);
      if (configured && Object.keys(configured).length) {
        const media = await this._extractConfiguredMediaOrRecent(configured, PhotoConfigureError, 'Photo upload', previousMediaIds);
        return this._photoUploadApplyUsertagsIfNeeded(media, caption, usertags, location, extraData.publish_mode !== 'scheduled');
      }
    }
    throw new PhotoConfigureError({ ...this.lastJson, response: this.lastResponse });
  }

  _mediaContainsUsertags(this: Client, media: Media, usertags: Usertag[]): boolean {
    if (!usertags.length) return true;
    const key = (t: Usertag) => `${t.user.pk}|${t.x}|${t.y}`;
    const existing = new Set(media.usertags.map(key));
    return usertags.every((t) => existing.has(key(t)));
  }

  async _photoUploadApplyUsertagsIfNeeded(
    this: Client,
    media: Media,
    caption: string,
    usertags: Usertag[],
    location: Location | null = null,
    canEdit = true,
  ): Promise<Media> {
    if (!canEdit || this._mediaContainsUsertags(media, usertags)) return media;
    let edited: any;
    try {
      edited = await this.mediaEdit(media.id, caption, '', usertags, location);
    } catch (e) {
      this.logger.debug('Unable to apply photo usertags with media_edit: %s', e);
      return media;
    }
    const updated = this._extractConfiguredMedia(edited);
    if (updated !== null) return updated;
    try {
      return await this.mediaInfoV1(media.pk);
    } catch (e) {
      this.logger.debug('Unable to refresh photo after media_edit usertags: %s', e);
      return media;
    }
  }

  /** Upload a feed photo with attached music (track from music search). */
  async photoUploadWithMusic(
    this: Client,
    filePath: string,
    caption: string,
    track: Track | Record<string, any>,
    opts: PhotoUploadOptions & {
      audioAssetStartTime?: number | null;
      overlapDuration?: number;
      browseSessionId?: string | null;
      alacornSessionId?: string | null;
    } = {},
  ): Promise<Media> {
    const data: Record<string, any> = { ...(opts.extraData || {}) };
    data.music_params = await this._feedMusicParams(
      track,
      opts.audioAssetStartTime ?? null,
      opts.overlapDuration ?? 30000,
      opts.browseSessionId ?? null,
      opts.alacornSessionId ?? null,
    );
    return this.photoUpload(filePath, caption, { ...opts, extraData: data });
  }

  _scheduledExtraData(this: Client, extraData: Record<string, any>, scheduleAt: number | Date | null): Record<string, any> {
    const data = { ...(extraData || {}) };
    if (scheduleAt === null || scheduleAt === undefined) return data;
    const scheduledPublishTime = this._scheduledPublishTime(scheduleAt);
    data.publish_mode = 'scheduled';
    data.content_scheduling_metadata = JSON.stringify({ scheduled_publish_time: scheduledPublishTime });
    return data;
  }

  _scheduledPublishTime(this: Client, scheduleAt: number | Date): number {
    return Math.trunc(scheduleAt instanceof Date ? scheduleAt.getTime() / 1000 : Number(scheduleAt));
  }

  /** Post Configure Photo (send caption to Instagram) */
  async photoConfigure(
    this: Client,
    uploadId: string,
    width: number,
    height: number,
    caption: string,
    usertags: Usertag[] = [],
    location: Location | null = null,
    extraData: Record<string, any> = {},
  ): Promise<any> {
    const tags = usertags.map((tag) => ({ user_id: tag.user.pk, position: [pf(tag.x), pf(tag.y)] }));
    const data = {
      timezone_offset: String(this.timezoneOffset),
      camera_model: this.device.model ?? '',
      camera_make: this.device.manufacturer ?? '',
      scene_type: '?',
      nav_chain:
        '8rL:self_profile:4,ProfileMediaTabFragment:self_profile:5,' +
        'UniversalCreationMenuFragment:universal_creation_menu:7,' +
        'ProfileMediaTabFragment:self_profile:8,' +
        'MediaCaptureFragment:tabbed_gallery_camera:9,' +
        'Dd3:photo_filter:10,' +
        'FollowersShareFragment:metadata_followers_share:11',
      date_time_original: dateTimeOriginal(),
      date_time_digitalized: dateTimeOriginal(),
      creation_logger_session_id: this.clientSessionId,
      scene_capture_type: 'standard',
      software: config.formatTemplate(config.SOFTWARE, this.deviceSettings),
      multi_sharing: '1',
      location: await this.locationBuild(location),
      media_folder: 'Camera',
      source_type: '4',
      caption,
      upload_id: uploadId,
      device: this.device,
      usertags: jsonDumps({ in: tags }),
      edits: { crop_original_size: [floatValue(width), floatValue(height)], crop_center: [floatValue(0), floatValue(0)], crop_zoom: floatValue(1) },
      extra: { source_width: width, source_height: height },
      ...extraData,
    };
    return this.privateRequest('media/configure/', this.withDefaultData(data));
  }

  /** Upload photo as a story and configure it */
  async photoUploadToStory(this: Client, filePath: string, caption = '', opts: StoryUploadOptions = {}): Promise<Story> {
    const { mentions = [], locations = [], links = [], hashtags = [], stickers = [], medias = [], polls = [], extraData = {}, resizeMode = 'fill' } = opts;
    const [uploadId, width, height] = await this.photoRupload(filePath, opts.uploadId ?? '', false, true, resizeMode);
    const previousStoryIds = await this._currentStoryIds();
    const storyExtra = { links, mentions, hashtags, locations, stickers, medias, polls };
    for (let attempt = 0; attempt < 10; attempt++) {
      this.logger.debug(`Attempt #${attempt} to configure Photo: ${filePath}`);
      await sleep(3);
      const configured = await this.photoConfigureToStory(uploadId, width, height, caption, mentions, locations, links, hashtags, stickers, medias, polls, extraData);
      if (configured && Object.keys(configured).length) {
        return this._extractConfiguredStoryOrRecent(configured, PhotoConfigureStoryError, 'Photo story upload', previousStoryIds, storyExtra);
      }
    }
    throw new PhotoConfigureStoryError({ ...this.lastJson, response: this.lastResponse });
  }

  /**
   * Upload photo as a story with a selected music track. Story photos cannot carry a baked audio track by
   * themselves, so this helper renders the photo into a short video and uploads it with music.
   */
  async photoUploadToStoryWithMusic(this: Client, filePath: string, caption: string, track: Track | Record<string, any>, opts: StoryMusicOptions = {}): Promise<Story> {
    return this._uploadStoryWithMusic(filePath, caption, track, { duration: 15.0, product: 'story_camera_music_overlay_post_capture', alacornSessionId: 'null', ...opts }, true);
  }

  /** Upload photo and create a Cutout Sticker. bypassAi=true selects the full image. */
  async photoUploadToCutoutSticker(this: Client, filePath: string, bypassAi = true): Promise<Media> {
    const [uploadId] = await this.photoRupload(filePath);
    const manualBox = bypassAi ? [floatValue(0), floatValue(0), floatValue(1), floatValue(1)] : null;
    return this.mediaConfigureToCutoutSticker(uploadId, 'library', manualBox as any, !bypassAi);
  }

  /** Post configure photo story */
  async photoConfigureToStory(
    this: Client,
    uploadId: string,
    width: number,
    height: number,
    caption: string,
    mentions: StoryMention[] = [],
    locations: StoryLocation[] = [],
    links: StoryLink[] = [],
    hashtags: StoryHashtag[] = [],
    stickers: StorySticker[] = [],
    medias: StoryMedia[] = [],
    polls: StoryPoll[] = [],
    extraData: Record<string, any> = {},
  ): Promise<any> {
    const timestamp = Math.trunc(Date.now() / 1000);
    mentions = [...mentions];
    locations = [...locations];
    links = [...links];
    hashtags = [...hashtags];
    stickers = [...stickers];
    medias = [...medias];
    polls = [...polls];
    const storyStickerIds: string[] = [];
    const data: Record<string, any> = {
      text_metadata:
        '[{"font_size":40.0,"scale":1.0,"width":611.0,"height":169.0,' +
        '"x":0.51414347,"y":0.8487708,"rotation":0.0,' +
        '"format_type":"modern_refreshed_v2","effects":["default"]}]',
      supported_capabilities_new: jsonDumps(config.SUPPORTED_CAPABILITIES),
      has_original_sound: '1',
      camera_session_id: this.clientSessionId,
      scene_capture_type: '',
      timezone_offset: String(this.timezoneOffset),
      client_shared_at: String(timestamp - 5), // 5 seconds ago
      story_sticker_ids: '',
      media_folder: 'Camera',
      configure_mode: '1',
      source_type: '4',
      creation_surface: 'camera',
      imported_taken_at: timestamp - 3 * 24 * 3600, // 3 days ago
      capture_type: 'normal',
      rich_text_format_types: '["modern_refreshed_v2"]',
      upload_id: uploadId,
      client_timestamp: String(timestamp),
      device: this.device,
      _uid: this.userIdInt,
      _uuid: this.uuid,
      device_id: this.androidDeviceId,
      composition_id: this.generateUuid(),
      app_attribution_android_namespace: '',
      media_transformation_info: dumps({
        width: String(width),
        height: String(height),
        x_transform: '0',
        y_transform: '0',
        zoom: '1.0',
        rotation: '0.0',
        background_coverage: '0.0',
      }),
      original_media_type: 'photo',
      camera_entry_point: String(randomInt(25, 164)), // e.g. 25
      edits: {
        crop_original_size: [floatValue(width), floatValue(height)],
        // "crop_center": [0.0, 0.0],
        // "crop_zoom": 1.0,
        filter_type: 0,
        filter_strength: floatValue(1),
      },
      extra: { source_width: width, source_height: height },
    };
    if (caption) data.caption = caption;
    Object.assign(data, extraData);
    await this._storyTapModels(data, storyStickerIds, mentions, locations, links, hashtags, stickers, medias, polls);
    return this.privateRequest('media/configure_to_story/', this.withDefaultData(data));
  }

  /**
   * Shared story sticker/tap-model builder used by photo and video story configure requests
   * (mutates `data` and `storyStickerIds`).
   */
  async _storyTapModels(
    this: Client,
    data: Record<string, any>,
    storyStickerIds: string[],
    mentions: StoryMention[],
    locations: StoryLocation[],
    links: StoryLink[],
    hashtags: StoryHashtag[],
    stickers: StorySticker[],
    medias: StoryMedia[],
    polls: StoryPoll[],
    opts: { mentionsAsTapModelsOnly?: boolean } = {},
  ): Promise<void> {
    const tapModels: any[] = [];
    const staticModels: any[] = [];
    void opts;
    if (mentions.length) {
      for (const mention of mentions) {
        const reelMentions = [
          {
            x: pf(mention.x),
            y: pf(mention.y),
            z: 0,
            width: pf(mention.width),
            height: pf(mention.height),
            rotation: floatValue(0),
            type: 'mention',
            user_id: String(mention.user.pk),
            is_sticker: false,
            display_type: 'mention_username',
          },
        ];
        data.reel_mentions = jsonDumps(reelMentions);
        tapModels.push(...reelMentions);
      }
    }
    if (hashtags.length) {
      storyStickerIds.push('hashtag_sticker');
      for (const mention of hashtags) {
        tapModels.push({
          x: pf(mention.x),
          y: pf(mention.y),
          z: 0,
          width: pf(mention.width),
          height: pf(mention.height),
          rotation: floatValue(0),
          type: 'hashtag',
          tag_name: mention.hashtag.name,
          is_sticker: true,
          tap_state: 0,
          tap_state_str_id: 'hashtag_sticker_gradient',
        });
      }
    }
    if (locations.length) {
      storyStickerIds.push('location_sticker');
      for (const mention of locations) {
        mention.location = await this.locationComplete(mention.location);
        tapModels.push({
          x: pf(mention.x),
          y: pf(mention.y),
          z: 0,
          width: pf(mention.width),
          height: pf(mention.height),
          rotation: floatValue(0),
          type: 'location',
          location_id: this.locationStoryStickerId(mention.location),
          is_sticker: true,
          tap_state: 0,
          tap_state_str_id: 'location_sticker_vibrant',
        });
      }
    }
    if (links.length) {
      // instagram allow one link now
      const link = links[0];
      await this.privateRequest('media/validate_reel_url/', { url: String(link.webUri), _uid: String(this.userId), _uuid: String(this.uuid) });
      stickers.push(
        makeStorySticker({
          type: 'story_link',
          x: link.x,
          y: link.y,
          z: link.z,
          width: link.width,
          height: link.height,
          rotation: link.rotation,
          extra: { link_type: 'web', url: String(link.webUri), tap_state_str_id: 'link_sticker_default' },
        }),
      );
      storyStickerIds.push('link_sticker_default');
    }
    if (stickers.length) {
      for (const sticker of stickers) {
        const stickerExtra = sticker.extra || {};
        if (sticker.id) {
          stickerExtra.str_id = sticker.id;
          storyStickerIds.push(sticker.id);
        }
        tapModels.push({
          x: pf(sticker.x),
          y: pf(sticker.y),
          z: sticker.z,
          width: pf(sticker.width),
          height: pf(sticker.height),
          rotation: pf(sticker.rotation),
          type: sticker.type,
          is_sticker: true,
          selected_index: 0,
          tap_state: 0,
          ...stickerExtra,
        });
        if (sticker.type === 'gif') data.has_animated_sticker = '1';
      }
    }
    if (medias.length) {
      let feedMedia: StoryMedia | null = null;
      for (feedMedia of medias) {
        ensure(feedMedia.media_pk, 'Required StoryMedia.media_pk');
        tapModels.push({
          x: pf(feedMedia.x),
          y: pf(feedMedia.y),
          z: pf(feedMedia.z),
          width: pf(feedMedia.width),
          height: pf(feedMedia.height),
          rotation: pf(feedMedia.rotation),
          type: 'feed_media',
          media_id: String(feedMedia.media_pk),
          media_owner_id: String(feedMedia.user_id || ''),
          product_type: 'feed',
          is_sticker: true,
          tap_state: 0,
          tap_state_str_id: 'feed_post_sticker_square',
        });
      }
      data.reshared_media_id = String(feedMedia!.media_pk);
    }
    if (polls.length) {
      storyStickerIds.push('polling_sticker_v2');
      for (const poll of polls) {
        const pollExtra = poll.extra || {};
        tapModels.push({
          x: pf(round7(poll.x)),
          y: pf(round7(poll.y)),
          z: poll.z,
          width: pf(round7(poll.width)),
          height: pf(round7(poll.height)),
          rotation: pf(poll.rotation),
          type: poll.type,
          poll_type: poll.poll_type,
          is_sticker: true,
          tap_state: 0,
          tap_state_str_id: 'polling_sticker_v2',
          is_multi_option_poll: poll.is_multi_option,
          is_shared_result: poll.is_shared_result,
          viewer_can_vote: poll.viewer_can_vote,
          finished: poll.finished,
          color: poll.color,
          question: poll.question,
          tallies: poll.options.map((o: any) => ({ count: 0, font_size: floatValue(39), text: o })),
          ...pollExtra,
        });
      }
    }
    if (tapModels.length) data.tap_models = dumps(tapModels);
    if (staticModels.length) data.static_models = dumps(staticModels);
    if (storyStickerIds.length) data.story_sticker_ids = storyStickerIds.join(',');
  }
}
void fsp;
