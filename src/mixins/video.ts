import * as Boom from '@hapi/boom';
import { existsSync, mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as config from '../config';
import { VideoConfigureError, VideoConfigureStoryError, VideoNotUpload } from '../exceptions';
import { get as httpGet } from '../http/session';
import { StoryBuilder } from '../story';
import {
  DirectMessage,
  Location,
  Media,
  Story,
  StoryHashtag,
  StoryLink,
  StoryLocation,
  StoryMedia,
  StoryMention,
  StoryPoll,
  StorySticker,
  Track,
  Usertag,
  makeStorySticker,
} from '../types';
import { FfmpegUnavailableError, ffmpeg, probe } from '../utils/ffmpeg';
import { dumps, floatValue } from '../utils/serialization';
import { dateTimeOriginal, randomInt, sleep } from '../utils/timing';
import { withCoauthorUserIds } from '../utils/upload';
import { FFMPEG_INSTALL_MESSAGE, analyzeVideoForUpload } from '../utils/video';
import { ensure } from '../utils/validation';
import { pf, round7, PhotoUploadOptions, StoryMusicOptions, StoryUploadOptions } from './photo';
import type { Client } from '../client';

export interface VideoUploadOptions extends Omit<PhotoUploadOptions, 'uploadId'> {
  thumbnail?: string | null;
}

/** Story Configure helper: returns [width, height, duration, thumbnail] */
export async function analyzeVideo(filePath: string, thumbnail: string | null = null): Promise<[number, number, number, string]> {
  const [thumb, width, height, duration] = await analyzeVideoForUpload(filePath, thumbnail, 'video');
  return [width, height, duration, thumb];
}

function isTranscodePending(e: any): boolean {
  return String(e?.message ?? e).includes('Transcode not finished yet');
}

/** Helpers for downloading video */
export class DownloadVideoMixin {
  /** Download video using media pk */
  async videoDownload(this: Client, mediaPk: string | number, folder = '', overwrite = true): Promise<string> {
    const media = await this.mediaInfoV1(mediaPk);
    ensure(media.media_type === 2, 'Must been video');
    const filename = `${media.user.username}_${mediaPk}`;
    return this.videoDownloadByUrl(String(media.video_url), filename, folder, overwrite);
  }

  /** Download video using URL */
  async videoDownloadByUrl(this: Client, url: string, filename = '', folder = '', overwrite = true): Promise<string> {
    url = String(url);
    const p = new URL(url).pathname;
    const fname = p.slice(p.lastIndexOf('/') + 1);
    const name = filename ? `${filename}.${fname.slice(fname.lastIndexOf('.') + 1)}` : fname;
    const filePath = path.join(folder || '', name);
    if (existsSync(filePath) && !overwrite) return path.resolve(filePath);
    const response = await httpGet(url, { timeout: this.readTimeout });
    response.raise_for_status();
    return this._downloadResponseToPath(response, filePath);
  }

  /** Download video using URL, returns bytes */
  async videoDownloadByUrlOrigin(this: Client, url: string): Promise<Buffer> {
    const response = await httpGet(url, { timeout: this.readTimeout });
    response.raise_for_status();
    return this._downloadResponseBytes(response, url);
  }
}

/** Helpers for uploading video */
export class UploadVideoMixin {
  _storyMusicTrackUrl(this: Client, track: Track | Record<string, any>): string {
    const trackUrl =
      this._trackValue(track, 'uri') ||
      this._trackValue(track, 'progressive_download_url') ||
      this._trackValue(track, 'fast_start_progressive_download_url') ||
      this._trackValue(track, 'reactive_audio_download_url');
    ensure(
      trackUrl,
      'track.uri, track.progressive_download_url, track.fast_start_progressive_download_url or track.reactive_audio_download_url is required',
    );
    return String(trackUrl);
  }

  /** Mux the music track into the story media with ffmpeg. Returns media duration in seconds. */
  async _renderStoryVideoWithMusic(
    this: Client,
    filePath: string,
    track: Track | Record<string, any>,
    outputPath: string,
    audioAssetStartTime: number,
    isPhoto = false,
    duration: number | null = null,
    musicVolume = 1.0,
  ): Promise<number> {
    const tmpaudio = await this.trackDownloadByUrl(this._storyMusicTrackUrl(track), 'track', path.dirname(outputPath));
    try {
      let mediaDuration: number;
      const start = audioAssetStartTime / 1000;
      const volume = musicVolume !== 1.0 ? ['-af', `volume=${musicVolume}`] : [];
      if (isPhoto) {
        mediaDuration = Number(duration || 15.0);
        await ffmpeg([
          '-loop', '1', '-framerate', '30', '-i', filePath,
          '-ss', String(start), '-t', String(mediaDuration), '-i', tmpaudio,
          '-map', '0:v', '-map', '1:a', '-t', String(mediaDuration),
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-c:a', 'aac', ...volume, outputPath,
        ]);
      } else {
        mediaDuration = Number((await probe(filePath)).duration);
        await ffmpeg([
          '-i', filePath, '-ss', String(start), '-t', String(mediaDuration), '-i', tmpaudio,
          '-map', '0:v', '-map', '1:a', '-t', String(mediaDuration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...volume, outputPath,
        ]);
      }
      return mediaDuration;
    } catch (e) {
      if (e instanceof FfmpegUnavailableError) throw Boom.failedDependency(`story upload with music requires ffmpeg. ${FFMPEG_INSTALL_MESSAGE}`);
      throw e;
    }
  }

  /**
   * Build Story music metadata for story upload configure requests.
   * Use photoUploadToStoryWithMusic or videoUploadToStoryWithMusic to also mux the audio.
   */
  storyMusicExtraData(
    this: Client,
    track: Track | Record<string, any>,
    extraData: Record<string, any> = {},
    audioAssetStartTime: number | null = null,
    overlapDuration = 30000,
    originalVolume = 0.0,
    musicVolume = 1.0,
    product = 'story_camera_music_overlay_post_capture',
    alacornSessionId = 'null',
    audioOverlayUuid: string | null = null,
  ): Record<string, any> {
    let audioAssetId = this._trackValue(track, 'audio_asset_id') || this._trackValue(track, 'id');
    let audioClusterId = this._trackValue(track, 'audio_cluster_id');
    ensure(audioAssetId, 'track.audio_asset_id or track.id is required');
    ensure(audioClusterId, 'track.audio_cluster_id is required');
    if (audioAssetStartTime === null || audioAssetStartTime === undefined) audioAssetStartTime = this._trackHighlightStart(track);
    audioAssetId = String(audioAssetId);
    audioClusterId = String(audioClusterId);
    const artistName = this._trackValue(track, 'display_artist') || '';
    const trackName = this._trackValue(track, 'title') || '';
    audioOverlayUuid = audioOverlayUuid || this.generateUuid();
    const data: Record<string, any> = { ...(extraData || {}) };
    data.music_burnin_params = dumps({ asset_fbid: audioAssetId, offset_ms: Math.trunc(audioAssetStartTime) });
    data.audio_muted = false;
    data.has_original_sound = originalVolume === 0 ? '0' : '1';
    data.music_params = {
      audio_asset_id: audioAssetId,
      audio_cluster_id: audioClusterId,
      audio_asset_start_time_in_ms: Math.trunc(audioAssetStartTime),
      overlap_duration_in_ms: Math.trunc(overlapDuration),
      product,
      song_name: trackName,
      artist_name: artistName,
      alacorn_session_id: alacornSessionId,
    };
    const musicCanonicalId = this._trackValue(track, 'music_canonical_id');
    if (musicCanonicalId) data.music_params.music_canonical_id = musicCanonicalId;
    const edits: Record<string, any> = { ...(data.edits || {}) };
    edits.audio_state_edits = {
      has_music_sticker: true,
      is_music_burned_into_video: true,
      is_video_muted: false,
      did_user_mute_audio: false,
      force_play_video_audio: true,
    };
    const mediaAudioOverlayInfo: Record<string, any> = { ...(edits.media_audio_overlay_info || {}) };
    Object.assign(mediaAudioOverlayInfo, {
      audio_mix_burned_in: true,
      video_volume: floatValue(originalVolume),
      media_audio_overlays: [
        {
          audio_asset_id: audioAssetId,
          audio_overlay_uuid: audioOverlayUuid,
          audio_volume: floatValue(musicVolume),
          seek_time_ms: Math.trunc(audioAssetStartTime),
          start_at_time_ms: 0,
          audio_duration_ms: Math.trunc(overlapDuration),
          media_audio_overlay_type: 'audio_track',
        },
      ],
    });
    edits.media_audio_overlay_info = mediaAudioOverlayInfo;
    data.edits = edits;
    return data;
  }

  async _uploadStoryWithMusic(
    this: Client,
    filePath: string,
    caption: string,
    track: Track | Record<string, any>,
    opts: StoryMusicOptions = {},
    isPhoto = false,
  ): Promise<Story> {
    let audioAssetStartTime = opts.audioAssetStartTime ?? null;
    if (audioAssetStartTime === null) audioAssetStartTime = this._trackHighlightStart(track);
    const dir = mkdtempSync(path.join(tmpdir(), 'insta-node-story-'));
    try {
      const outputPath = path.join(dir, 'story-with-music.mp4');
      const mediaDuration = await this._renderStoryVideoWithMusic(
        filePath,
        track,
        outputPath,
        audioAssetStartTime,
        isPhoto,
        opts.duration ?? null,
        opts.musicVolume ?? 1.0,
      );
      const musicExtra = this.storyMusicExtraData(
        track,
        opts.extraData ?? {},
        audioAssetStartTime,
        opts.overlapDuration || Math.trunc(mediaDuration * 1000),
        opts.originalVolume ?? 0.0,
        opts.musicVolume ?? 1.0,
        opts.product ?? 'story_camera_music_overlay_post_capture',
        opts.alacornSessionId ?? 'null',
      );
      return await this.videoUploadToStory(outputPath, caption, { ...opts, extraData: musicExtra, resizeMode: 'fill' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Upload video to Instagram (rupload_igvideo).
   * Returns [upload_id, width, height, duration, thumbnail]. thumbnail is generated automatically when null.
   */
  async videoRupload(
    this: Client,
    filePath: string,
    thumbnail: string | null = null,
    toAlbum = false,
    toStory = false,
    toDirect = false,
  ): Promise<[string, number, number, number, string]> {
    ensure(typeof filePath === 'string', `Path must been Path, now ${filePath} (${typeof filePath})`);
    const uploadId = String(Date.now());
    const [width, height, duration, thumb] = await analyzeVideo(filePath, thumbnail);
    const waterfallId = this.generateUuid();
    // upload_name example: '1576102477530_0_7823256191'
    const uploadName = `${uploadId}_0_${randomInt(1000000000, 9999999999)}`;
    let ruploadParams: Record<string, any> = {
      retry_context: '{"num_step_auto_retry":0,"num_reupload":0,"num_step_manual_retry":0}',
      media_type: '2',
      xsharing_user_ids: dumps([this.userIdInt]),
      upload_id: uploadId,
      upload_media_duration_ms: String(Math.trunc(duration * 1000)),
      upload_media_width: String(width),
      upload_media_height: String(height), // "1138" for Mi5s
    };
    if (toDirect) ruploadParams.direct_v2 = '1'; // "hflip": "false", "rotate":"3",
    if (toAlbum) ruploadParams.is_sidecar = '1';
    if (toStory) ruploadParams = { extract_cover_frame: '1', content_tags: 'has-overlay', for_album: '1', ...ruploadParams };
    let headers: Record<string, string> = {
      'Accept-Encoding': 'gzip, deflate',
      'X-Instagram-Rupload-Params': dumps(ruploadParams),
      X_FB_VIDEO_WATERFALL_ID: waterfallId,
      // "X_FB_VIDEO_WATERFALL_ID": "88732215909430_55CF262450C9_Mixed_0",  # ALBUM
      // "X_FB_VIDEO_WATERFALL_ID": "1594919079102",  # VIDEO
    };
    if (toAlbum) headers = { 'Segment-Start-Offset': '0', 'Segment-Type': '3', ...headers };
    const url = `https://${config.API_DOMAIN}/rupload_igvideo/${uploadName}`;
    let response = await this.private.get(url, { headers });
    this.requestLog(response);
    if (response.status_code !== 200) throw new VideoNotUpload(response.text, { ...this.lastJson, response });
    const videoData = await fsp.readFile(filePath);
    const videoLen = String(videoData.length);
    headers = {
      Offset: '0',
      'X-Entity-Name': uploadName,
      'X-Entity-Length': videoLen,
      'Content-Type': 'application/octet-stream',
      'Content-Length': videoLen,
      'X-Entity-Type': 'video/mp4',
      ...headers,
    };
    response = await this.private.post(url, { data: videoData, headers });
    this.requestLog(response);
    if (response.status_code !== 200) throw new VideoNotUpload(response.text, { ...this.lastJson, response });
    return [uploadId, width, height, duration, thumb];
  }

  /** Upload video and configure to feed */
  async videoUpload(this: Client, filePath: string, caption: string, opts: VideoUploadOptions = {}): Promise<Media> {
    const usertags = opts.usertags ?? [];
    const location = opts.location ?? null;
    let extraData = withCoauthorUserIds(opts.extraData ?? {}, opts.coauthorUserIds ?? null);
    extraData = this._scheduledExtraData(extraData, opts.scheduleAt ?? null);
    extraData = await this._mediaCrosspostingExtraData(extraData, opts);
    const [uploadId, width, height, duration, thumbnail] = await this.videoRupload(filePath, opts.thumbnail ?? null, false, false);
    for (let attempt = 0; attempt < 50; attempt++) {
      this.logger.debug(`Attempt #${attempt} to configure Video: ${filePath}`);
      await sleep(3);
      let configured: any;
      try {
        configured = await this.videoConfigure(uploadId, width, height, duration, thumbnail, caption, usertags, location, extraData);
      } catch (e) {
        if (isTranscodePending(e)) {
          // Response 202 status: {"message": "Transcode not finished yet.", "status": "fail"}
          await sleep(10);
          continue;
        }
        throw e;
      }
      if (configured && Object.keys(configured).length) return this._extractConfiguredMediaOrRaise(configured, VideoConfigureError, 'Video upload');
    }
    throw new VideoConfigureError({ ...this.lastJson, response: this.lastResponse });
  }

  /** Upload video and create a Cutout Sticker. bypassAi=true selects full image */
  async videoUploadToCutoutSticker(this: Client, filePath: string, bypassAi = true): Promise<Media> {
    // videoRupload returns (upload_id, width, height, duration, thumbnail)
    const res = await this.videoRupload(filePath);
    const manualBox = bypassAi ? [floatValue(0), floatValue(0), floatValue(1), floatValue(1)] : null;
    return this.mediaConfigureToCutoutSticker(res[0], 'library', manualBox as any, !bypassAi);
  }

  /** Post Configure Video (send caption, thumbnail and more to Instagram) */
  async videoConfigure(
    this: Client,
    uploadId: string,
    width: number,
    height: number,
    duration: number,
    thumbnail: string,
    caption: string,
    usertags: Usertag[] = [],
    location: Location | null = null,
    extraData: Record<string, any> = {},
  ): Promise<any> {
    await this.photoRupload(thumbnail, uploadId, false, true);
    const tags = usertags.map((tag) => ({ user_id: tag.user.pk, position: [pf(tag.x), pf(tag.y)] }));
    const data = {
      multi_sharing: '1',
      creation_logger_session_id: this.clientSessionId,
      upload_id: uploadId,
      source_type: '4',
      location: await this.locationBuild(location),
      poster_frame_index: 0,
      length: pf(duration),
      audio_muted: false,
      usertags: dumps({ in: tags }),
      filter_type: '0',
      date_time_original: dateTimeOriginal(),
      timezone_offset: String(this.timezoneOffset),
      clips: [{ length: pf(duration), source_type: '4' }],
      extra: { source_width: width, source_height: height },
      device: this.device,
      caption,
      ...extraData,
    };
    return this.privateRequest('media/configure/?video=1', this.withDefaultData(data));
  }

  /** Upload video as a story and configure it. resizeMode "fit" renders a 720x1280 canvas without cropping. */
  async videoUploadToStory(this: Client, filePath: string, caption = '', opts: StoryUploadOptions & { thumbnail?: string | null } = {}): Promise<Story> {
    const { mentions = [], locations = [], links = [], hashtags = [], stickers = [], medias = [], polls = [], extraData = {}, resizeMode = 'fill' } = opts;
    if (resizeMode !== 'fill' && resizeMode !== 'fit') throw Boom.badRequest('resizeMode must be "fill" or "fit"');
    let renderedStory: { path: string; paths: string[] } | null = null;
    let uploadPath = filePath;
    let uploadThumbnail = opts.thumbnail ?? null;
    try {
      if (resizeMode === 'fit') {
        renderedStory = await new StoryBuilder(filePath).videoFit();
        uploadPath = renderedStory.path;
        uploadThumbnail = null;
      }
      const [uploadId, width, height, duration, thumbnail] = await this.videoRupload(uploadPath, uploadThumbnail, false, true);
      const previousStoryIds = await this._currentStoryIds();
      const storyExtra = { links, mentions, hashtags, locations, stickers, medias, polls };
      for (let attempt = 0; attempt < 50; attempt++) {
        this.logger.debug(`Attempt #${attempt} to configure Video: ${filePath}`);
        await sleep(3);
        let configured: any;
        try {
          configured = await this.videoConfigureToStory(
            uploadId, width, height, duration, thumbnail, caption, mentions, locations, links, hashtags, stickers, medias, polls, [], extraData,
          );
        } catch (e) {
          if (isTranscodePending(e)) {
            await sleep(10);
            continue;
          }
          throw e;
        }
        if (configured && Object.keys(configured).length) {
          return this._extractConfiguredStoryOrRecent(configured, VideoConfigureStoryError, 'Video story upload', previousStoryIds, storyExtra);
        }
      }
      throw new VideoConfigureStoryError({ ...this.lastJson, response: this.lastResponse });
    } finally {
      if (renderedStory) {
        for (const item of [renderedStory.path, ...renderedStory.paths, `${renderedStory.path}.jpg`]) {
          await fsp.unlink(item).catch(() => undefined);
        }
      }
    }
  }

  /** Upload video as a story with a selected music track (locally muxed + Story music metadata). */
  async videoUploadToStoryWithMusic(this: Client, filePath: string, caption: string, track: Track | Record<string, any>, opts: StoryMusicOptions = {}): Promise<Story> {
    return this._uploadStoryWithMusic(filePath, caption, track, { product: 'story_camera_music_overlay_post_capture', alacornSessionId: 'null', ...opts }, false);
  }

  /** Story configure for video (optionally sends to direct threads via threadIds) */
  async videoConfigureToStory(
    this: Client,
    uploadId: string,
    width: number,
    height: number,
    duration: number,
    thumbnail: string,
    caption: string,
    mentions: StoryMention[] = [],
    locations: StoryLocation[] = [],
    links: StoryLink[] = [],
    hashtags: StoryHashtag[] = [],
    stickers: StorySticker[] = [],
    medias: StoryMedia[] = [],
    polls: StoryPoll[] = [],
    threadIds: Array<string | number> = [],
    extraData: Record<string, any> = {},
  ): Promise<any> {
    void thumbnail;
    void caption;
    const timestamp = Math.trunc(Date.now() / 1000);
    mentions = [...mentions];
    locations = [...locations];
    links = [...links];
    hashtags = [...hashtags];
    stickers = [...stickers];
    medias = [...medias];
    polls = [...polls];
    threadIds = [...threadIds];
    const storyStickerIds: string[] = [];
    const data: Record<string, any> = {
      // USE extraData TO EXTEND THE SETTINGS OF THE LOADED STORY (direct/segment-mode properties)
      _uid: String(this.userId),
      supported_capabilities_new: dumps(config.SUPPORTED_CAPABILITIES),
      has_original_sound: '1',
      filter_type: '0',
      camera_session_id: this.clientSessionId,
      camera_entry_point: String(randomInt(35, 164)),
      composition_id: this.generateUuid(),
      timezone_offset: String(this.timezoneOffset),
      client_timestamp: String(timestamp),
      client_shared_at: String(timestamp - 7), // 7 seconds ago
      date_time_original: dateTimeOriginal(),
      configure_mode: '1',
      // "configure_mode": "2", <- when direct
      source_type: '3',
      video_result: '',
      creation_surface: 'camera',
      capture_type: 'normal',
      upload_id: uploadId,
      original_media_type: 'video',
      camera_position: 'back',
      device: this.device,
      length: pf(duration),
      clips: [{ length: pf(duration), source_type: '3', camera_position: 'back' }],
      media_transformation_info: dumps({
        width: String(width),
        height: String(height),
        x_transform: '0',
        y_transform: '0',
        zoom: '1.0',
        rotation: '0.0',
        background_coverage: '0.0',
      }),
      extra: { source_width: width, source_height: height },
      audio_muted: false,
      poster_frame_index: 0,
    };
    Object.assign(data, extraData);
    const tapModels: any[] = [];
    const staticModels: any[] = [];
    if (mentions.length) {
      const reelMentions: any[] = [];
      const textMetadata: any[] = [];
      for (const mention of mentions) {
        reelMentions.push({
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
          tap_state: 0,
          tap_state_str_id: 'mention_text',
        });
        textMetadata.push({
          font_size: floatValue(24),
          scale: floatValue(1),
          width: floatValue(366),
          height: floatValue(102),
          x: pf(mention.x),
          y: pf(mention.y),
          rotation: floatValue(0),
        });
      }
      data.text_metadata = dumps(textMetadata);
      // data["reel_mentions"] = dumps(reel_mentions)
      tapModels.push(...reelMentions);
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
          x: pf(round7(sticker.x)),
          y: pf(round7(sticker.y)),
          z: sticker.z,
          width: pf(round7(sticker.width)),
          height: pf(round7(sticker.height)),
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
    if (threadIds.length) {
      // Send to direct thread
      const token = this.generateMutationToken();
      Object.assign(data, {
        configure_mode: '2',
        allow_multi_configures: '1',
        client_context: token,
        is_shh_mode: '0',
        mutation_token: token,
        nav_chain:
          '1qT:feed_timeline:1,1qT:feed_timeline:7,ReelViewerFragment:reel_feed_timeline:21,' +
          '5HT:attribution_quick_camera_fragment:22,4ji:reel_composer_preview:23,' +
          '8wg:direct_story_audience_picker:24,4ij:reel_composer_camera:25,' +
          'ReelViewerFragment:reel_feed_timeline:26',
        recipient_users: '[]',
        send_attribution: 'direct_story_audience_picker',
        thread_ids: dumps(threadIds.map(String)),
        view_mode: 'replayable',
      });
    }
    if (tapModels.length) data.tap_models = dumps(tapModels);
    if (staticModels.length) data.static_models = dumps(staticModels);
    if (storyStickerIds.length) data.story_sticker_ids = storyStickerIds.join(',');
    return this.privateRequest('media/configure_to_story/?video=1', this.withDefaultData(data));
  }

  /** Upload video to direct thread as a story and configure it */
  async videoUploadToDirect(
    this: Client,
    filePath: string,
    caption = '',
    thumbnail: string | null = null,
    mentions: StoryMention[] = [],
    medias: StoryMedia[] = [],
    threadIds: Array<string | number> = [],
    extraData: Record<string, any> = {},
  ): Promise<DirectMessage> {
    const [uploadId, width, height, duration, thumb] = await this.videoRupload(filePath, thumbnail, false, true);
    for (let attempt = 0; attempt < 50; attempt++) {
      this.logger.debug(`Attempt #${attempt} to configure Video: ${filePath}`);
      await sleep(3);
      let configured: any;
      try {
        configured = await this.videoConfigureToStory(uploadId, width, height, duration, thumb, caption, mentions, [], [], [], [], medias, [], threadIds, extraData);
      } catch (e) {
        if (isTranscodePending(e)) {
          await sleep(10);
          continue;
        }
        throw e;
      }
      if (configured && Object.keys(configured).length && threadIds.length) {
        return this._extractConfiguredDirectMessageOrRaise(configured, VideoConfigureStoryError, 'Video direct upload');
      }
    }
    throw new VideoConfigureStoryError({ ...this.lastJson, response: this.lastResponse });
  }
}
