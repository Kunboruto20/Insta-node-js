import * as Boom from '@hapi/boom';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as config from '../core/defaults';
import { ClientError, ClipConfigureError, ClipNotUpload } from '../core/errorClasses';
import { Location, Media, Track, Usertag } from '../models/schemas';
import { FfmpegUnavailableError, ffmpeg, makeTmpPath, probe } from '../media/ffmpegRunner';
import { dumps, floatValue, jsonDumps } from '../helpers/encoding';
import { dateTimeOriginal, randomInt, sleep } from '../helpers/delays';
import { FFMPEG_INSTALL_MESSAGE, analyzeVideoForUpload } from '../media/mp4Metadata';
import { ensure } from '../helpers/assertions';
import { pf } from './photos';
import { MUSIC_PRODUCT } from './music';
import type { Client } from '../core/instaClient';

export const CLIP_FB_CROSSPOSTING_UNIFIED_CONFIG_CLIENT_DOC_ID = '216179630714134719310007237117';
export const CLIP_FB_CROSSPOSTING_UNIFIED_CONFIG_FRIENDLY_NAME = 'CrosspostingUnifiedConfigsQuery';
export const CLIP_FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD = 'xcxp_unified_crossposting_configs_root';
export const CLIP_FB_STORY_CROSSPOSTING_SURFACE = { source_surface: 'STORY', destination_app: 'FB', destination_surface: 'STORY' };
export const CLIP_FB_FEED_CROSSPOSTING_SURFACE = { source_surface: 'FEED', destination_app: 'FB', destination_surface: 'FEED' };
export const CLIP_FB_REELS_CROSSPOSTING_SURFACE = { source_surface: 'REELS', destination_app: 'FB', destination_surface: 'REELS' };
export const CLIP_FB_CROSSPOSTING_SURFACES = [CLIP_FB_STORY_CROSSPOSTING_SURFACE, CLIP_FB_FEED_CROSSPOSTING_SURFACE, CLIP_FB_REELS_CROSSPOSTING_SURFACE];
export const CLIP_FB_CROSSPOSTING_SURFACE_FALLBACKS = [
  [CLIP_FB_REELS_CROSSPOSTING_SURFACE],
  [CLIP_FB_REELS_CROSSPOSTING_SURFACE, CLIP_FB_STORY_CROSSPOSTING_SURFACE, CLIP_FB_FEED_CROSSPOSTING_SURFACE],
];
export type ClipFbDestinationType = 'USER' | 'PAGE';

export function _clipFeedShowValue(showPreviewInFeed: boolean, feedShow: string | null = null): string {
  if (feedShow !== null && feedShow !== undefined) return String(feedShow);
  return showPreviewInFeed ? '1' : '0';
}

export interface ClipUploadOptions {
  thumbnail?: string | null;
  usertags?: Usertag[];
  location?: Location | null;
  configureTimeout?: number;
  feedShow?: string | null;
  extraData?: Record<string, any>;
  trial?: boolean;
  trialGraduationStrategy?: string;
  shareToFacebook?: boolean;
  fbDestinationId?: string | null;
  fbDestinationType?: ClipFbDestinationType | null;
  fbDestinationAudienceType?: string | null;
  fbXpostSurface?: string;
  fbValidationCheckBypass?: boolean | string[] | string | null;
  topics?: Array<string | number> | null;
  showPreviewInFeed?: boolean;
  shareToThreads?: boolean;
  threadsDestinationId?: string | null;
  threadsValidationBypass?: string[] | null;
}

/** Analyze and crop thumbnail if need. Returns [thumbnail, width, height, duration] */
export async function analyzeClipVideo(filePath: string, thumbnail: string | null = null): Promise<[string, number, number, number]> {
  const { cropThumbnail } = require('./longVideo');
  return analyzeVideoForUpload(filePath, thumbnail, 'CLIP', cropThumbnail);
}

function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Helpers for CLIP/Reel actions */
export class ClipFeature {
  _raiseClipUploadError(this: Client, response: any, stage: string): never {
    this.lastResponse = response;
    const statusCode = response?.status_code ?? null;
    const responseText = response?.text || '';
    let errorResponse: Record<string, any> = {};
    let parsed: any = null;
    try {
      parsed = response.json();
    } catch {
      parsed = null;
    }
    if (isDict(parsed)) {
      errorResponse = parsed;
      this.lastJson = parsed;
    } else this.lastJson = {};
    const details = responseText || JSON.stringify(errorResponse);
    throw new ClipNotUpload(`Clip upload failed during ${stage}: HTTP ${statusCode}: ${details}`, {
      response,
      stage,
      status_code: statusCode,
      error_response: errorResponse,
      response_text: responseText,
    });
  }

  /** Fetch Reel remix/reuse availability metadata. */
  async clipMashupInfo(this: Client, mediaPk: string | number): Promise<any> {
    ensure(this.userId, 'Login required');
    return this.privateRequest('clips/get_mashup_info_for_media/', { media_id: String(mediaPk), _uid: String(this.userId), _uuid: this.uuid });
  }

  /** Mark Clips/Reels as seen using Instagram's Clips seen-state endpoint. */
  async clipSeen(this: Client, mediaIds: Array<string | number>, blendMediaIds: Array<string | number> | null = null): Promise<boolean> {
    ensure(this.userId, 'Login required');
    const mediaPks = mediaIds.map((m) => this.mediaPk(m));
    const blendMediaPks = (blendMediaIds || []).map((m) => this.mediaPk(m));
    const result = await this.privateRequest('clips/write_seen_state/', {
      impressions: JSON.stringify(mediaPks),
      _uid: String(this.userId),
      _uuid: this.uuid,
      blend_impressions: JSON.stringify(blendMediaPks),
    });
    return result.status === 'ok';
  }

  /** Pin Reel to the Reels tab/profile Reels grid (revert=true to unpin) */
  async clipPin(this: Client, mediaPk: string | number, revert = false): Promise<boolean> {
    const name = revert ? 'unpin' : 'pin';
    const result = await this.privateRequest(`users/${name}_timeline_media/`, { post_id: String(mediaPk), profile_grid: 'clips' });
    return result.status === 'ok';
  }

  /** Unpin Reel from the Reels tab/profile Reels grid */
  async clipUnpin(this: Client, mediaPk: string | number): Promise<boolean> {
    return this.clipPin(mediaPk, true);
  }

  /** Change cover image for a published Reel */
  async clipChangeCover(this: Client, mediaPk: string | number, coverPath: string): Promise<boolean> {
    const [uploadId] = await this.photoRupload(coverPath);
    const result = await this.privateRequest('media/configure_to_clips_cover_image/', { upload_id: String(uploadId), clips_media_id: String(mediaPk) });
    return Boolean(result.success) || result.status === 'ok';
  }
}

/** Helpers to download CLIP videos */
export class DownloadClipFeature {
  /** Download CLIP video */
  async clipDownload(this: Client, mediaPk: string | number, folder = ''): Promise<string> {
    return this.videoDownload(mediaPk, folder);
  }

  /** Download CLIP video using URL */
  async clipDownloadByUrl(this: Client, url: string, filename = '', folder = ''): Promise<string> {
    return this.videoDownloadByUrl(url, filename, folder);
  }
}

/** Helpers to upload CLIP videos */
export class UploadClipFeature {
  _defaultVideoDeviceStatus(this: Client): Record<string, any> {
    return {
      hw_av1_dec: false,
      hw_vp9_dec: false,
      hw_avc_dec: false,
      '10bit_hw_av1_dec': false,
      '10bit_hw_vp9_dec': false,
      is_hlg_supported: false,
      chip_vendor: 'others',
      chip_name: 'unknown',
      core_count: 0,
      max_ghz_sum: 0,
      min_ghz_sum: 0,
    };
  }

  /** Get Reel creation preflight configuration for the current user. */
  async clipInfoForCreation(this: Client, deviceStatus: Record<string, any> | null = null): Promise<any> {
    deviceStatus = deviceStatus || this._defaultVideoDeviceStatus();
    return this.privateRequest('clips/clips_info_for_creation/', null, { params: { device_status: jsonDumps(deviceStatus) } });
  }

  /** Get Reel topic catalog items accepted by clipUpload(..., {topics}). */
  async clipInterestTopics(this: Client): Promise<Record<string, any>[]> {
    const result = await this.privateRequest('interest_nux/list_all/', null, { params: { caller: 'INTEREST_NUX' }, withSignature: false });
    return result.sub_interests || [];
  }

  /** Check whether Reel creation preflight reports Trial Reels enabled. */
  async clipTrialEligible(this: Client): Promise<boolean> {
    const result = await this.clipInfoForCreation();
    const trialConfig = result.trial_config || {};
    return Boolean(trialConfig.is_enabled);
  }

  /** Get Reel Facebook sharing configuration for the current user. */
  async clipShareToFbConfig(this: Client, deviceStatus: Record<string, any> | null = null): Promise<any> {
    deviceStatus = deviceStatus || this._defaultVideoDeviceStatus();
    return this.privateRequest('clips/user/share_to_fb_config/', null, { params: { device_status: jsonDumps(deviceStatus) } });
  }

  /** Get the Android cross-posting unified config used by the Reel composer. */
  async clipShareToFbUnifiedConfig(this: Client, crosspostAppSurfaceList: Array<Record<string, string>> | null = null): Promise<any> {
    const variables = { configs_request: { source_app: 'IG', crosspost_app_surface_list: crosspostAppSurfaceList || CLIP_FB_CROSSPOSTING_SURFACES } };
    const result = await this.privateGraphqlWwwRequest(
      CLIP_FB_CROSSPOSTING_UNIFIED_CONFIG_FRIENDLY_NAME,
      variables,
      CLIP_FB_CROSSPOSTING_UNIFIED_CONFIG_CLIENT_DOC_ID,
      config.API_DOMAIN,
      { 'X-Root-Field-Name': CLIP_FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD, Priority: 'u=3, i', 'X-FB-RMD': 'state=URL_ELIGIBLE' },
      null,
    );
    if (!('status' in result)) result.status = 'ok';
    return result;
  }

  _clipShareToFbUnifiedRoot(this: Client, cfg: Record<string, any>): any {
    const data = (cfg || {}).data;
    if (isDict(data)) {
      const root = data[CLIP_FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD];
      if (root !== null && root !== undefined) return root;
      for (const [key, value] of Object.entries(data)) if (key.includes(CLIP_FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD)) return value;
    }
    return cfg || {};
  }

  *_clipShareToFbIterDicts(this: Client, value: any): Generator<Record<string, any>> {
    if (isDict(value)) {
      yield value;
      for (const child of Object.values(value)) yield* this._clipShareToFbIterDicts(child);
    } else if (Array.isArray(value)) for (const child of value) yield* this._clipShareToFbIterDicts(child);
  }

  _clipShareToFbCandidateValue(this: Client, cfg: Record<string, any>, keys: string[]): any {
    for (const key of keys) {
      const value = cfg[key];
      if (value !== null && value !== undefined && value !== '') return value;
    }
    return null;
  }

  _clipShareToFbReelsFbCandidate(this: Client, cfg: Record<string, any>): boolean {
    const sourceSurface = String(cfg.source_surface || '').toUpperCase();
    const destinationSurface = String(cfg.destination_surface || '').toUpperCase();
    const destinationApp = String(cfg.destination_app || '').toUpperCase();
    if (sourceSurface && sourceSurface !== 'REELS' && sourceSurface !== 'CLIPS') return false;
    if (destinationSurface && destinationSurface !== 'REELS' && destinationSurface !== 'CLIPS') return false;
    if (destinationApp && destinationApp !== 'FB' && destinationApp !== 'FACEBOOK') return false;
    return Boolean(sourceSurface || destinationSurface || destinationApp);
  }

  *_clipShareToFbUnifiedDestinationCandidates(this: Client, cfg: Record<string, any>): Generator<Record<string, any>> {
    for (const candidate of this._clipShareToFbIterDicts(this._clipShareToFbUnifiedRoot(cfg))) {
      if (!this._clipShareToFbReelsFbCandidate(candidate)) continue;
      const merged: Record<string, any> = { ...candidate };
      for (const key of ['destination', 'fb_destination', 'reels_destination', 'crosspost_destination', 'crossposting_destination', 'xpost_destination']) {
        const nested = candidate[key];
        if (isDict(nested)) Object.assign(merged, nested);
      }
      yield merged;
    }
  }

  async *_clipShareToFbUnifiedConfigVariants(this: Client): AsyncGenerator<any> {
    yield await this.clipShareToFbUnifiedConfig();
    for (const surfaceList of CLIP_FB_CROSSPOSTING_SURFACE_FALLBACKS) yield await this.clipShareToFbUnifiedConfig(surfaceList);
  }

  /** Resolve a confirmed Reel Facebook destination from unified config. */
  async clipShareToFbUnifiedDestination(this: Client, cfg: Record<string, any> | null = null): Promise<Record<string, any>> {
    const unifiedConfigs: AsyncIterable<any> | any[] = cfg !== null && cfg !== undefined ? [cfg] : this._clipShareToFbUnifiedConfigVariants();
    for await (const unifiedConfig of unifiedConfigs as AsyncIterable<any>) {
      for (const candidate of this._clipShareToFbUnifiedDestinationCandidates(unifiedConfig || {})) {
        try {
          return await this.clipShareToFbDestination(candidate, null, null, null, null, false);
        } catch (e) {
          if (e instanceof ClientError) continue;
          throw e;
        }
      }
    }
    if (cfg === null || cfg === undefined) {
      const connectedServicesConfig = await this.mediaShareToFbConnectedServicesConfig();
      for (const candidate of this._fbConnectedServicesDestinationCandidates(connectedServicesConfig, 'REELS')) {
        try {
          return await this.clipShareToFbDestination(candidate, null, null, null, null, false);
        } catch (e) {
          if (e instanceof ClientError) continue;
          throw e;
        }
      }
    }
    throw new ClientError('Facebook Reel cross-posting config has no confirmed Reel Facebook destination');
  }

  /** Resolve the Facebook Reel sharing destination from confirmed fields. */
  async clipShareToFbDestination(
    this: Client,
    cfg: Record<string, any> | null = null,
    destinationId: string | null = null,
    destinationType: ClipFbDestinationType | null = null,
    destinationAudienceType: string | null = null,
    validationCheckBypass: boolean | string[] | string | null = null,
    useUnifiedConfig = true,
  ): Promise<Record<string, any>> {
    const fbConfig = (cfg !== null && cfg !== undefined ? cfg : await this.clipShareToFbConfig()) || {};
    if (fbConfig.enabled === false || fbConfig.is_account_linked === false) {
      throw new ClientError('Facebook Reel sharing is not enabled or no Facebook account is linked');
    }
    const explicitDestination = Boolean(destinationId || destinationType);
    const destId =
      destinationId ||
      this._clipShareToFbCandidateValue(fbConfig, [
        'share_to_fb_destination_id',
        'obfuscated_identity_id',
        'identity_id',
        'reels_destination_id',
        'crosspost_destination_id',
        'crossposting_destination_id',
        'xpost_destination_id',
        'destination_id',
      ]);
    const destinationTypeValue =
      destinationType ||
      this._clipShareToFbCandidateValue(fbConfig, [
        'share_to_fb_destination_type',
        'identity_type',
        'crosspost_destination_type',
        'crossposting_destination_type',
        'xpost_destination_type',
        'destination_type',
        'posting_type',
      ]);
    let destinationTypeText: string | null = destinationTypeValue !== null && destinationTypeValue !== undefined ? String(destinationTypeValue) : null;
    const audienceType =
      destinationAudienceType ||
      this._clipShareToFbCandidateValue(fbConfig, [
        'share_to_fb_destination_audience_type',
        'reels_destination_audience_type',
        'destination_audience_type',
        'audience_type',
      ]);
    let bypassValue: any = validationCheckBypass;
    let validationBypassProvided = bypassValue !== null && bypassValue !== undefined;
    if (!validationBypassProvided) {
      bypassValue = this._clipShareToFbCandidateValue(fbConfig, [
        'share_to_facebook_validation_bypass',
        'validation_bypass',
        'validation_check_bypass',
        'reels_cross_app_share_fb_validation_check_bypass',
        'cross_app_share_fb_validation_check_bypass',
      ]);
      validationBypassProvided = bypassValue !== null && bypassValue !== undefined;
    }
    const hasDestination = Boolean(destId && destinationTypeText);
    let validationBypass: string[] | null;
    if (bypassValue === true) validationBypass = ['AUTO_CROSSPOST_SETTING'];
    else if (bypassValue === false) validationBypass = null;
    else validationBypass = this._crosspostingValidationBypass(bypassValue);
    if (
      !validationBypassProvided &&
      validationBypass === null &&
      hasDestination &&
      (fbConfig.share_to_fb_unavailable === true || fbConfig.default_share_to_fb_enabled === false)
    ) {
      validationBypass = ['AUTO_CROSSPOST_SETTING'];
    }
    if (!hasDestination && useUnifiedConfig && (cfg === null || cfg === undefined) && !explicitDestination) {
      let discovered: Record<string, any> | null = null;
      try {
        discovered = await this.clipShareToFbUnifiedDestination();
      } catch (e) {
        if (!(e instanceof ClientError)) throw e;
      }
      if (discovered) {
        if (validationBypassProvided) {
          if (validationBypass && validationBypass.length) {
            discovered.validation_bypass = validationBypass;
            discovered.validation_check_bypass = true;
          } else {
            delete discovered.validation_bypass;
            discovered.validation_check_bypass = false;
          }
        } else if (!('validation_bypass' in discovered) && (fbConfig.share_to_fb_unavailable === true || fbConfig.default_share_to_fb_enabled === false)) {
          discovered.validation_bypass = ['AUTO_CROSSPOST_SETTING'];
          discovered.validation_check_bypass = true;
        }
        return discovered;
      }
    }
    if (fbConfig.share_to_fb_unavailable && !hasDestination) {
      throw new ClientError(
        'Facebook Reel sharing is unavailable from the Reel preflight response. ' +
          'If the Instagram app can still cross-post manually, pass destination_id and destination_type explicitly.',
      );
    }
    if (!destId) {
      throw new ClientError('Facebook Reel sharing configuration has no destination. Link a Facebook account/page in the Instagram app or pass destination_id.');
    }
    if (!destinationTypeText) throw new ClientError('Facebook Reel sharing configuration has no destination type. Pass destination_type as USER or PAGE.');
    destinationTypeText = destinationTypeText.toUpperCase();
    if (destinationTypeText.startsWith('FB_')) destinationTypeText = destinationTypeText.slice(3);
    if (destinationTypeText !== 'USER' && destinationTypeText !== 'PAGE') {
      throw new ClientError('Facebook Reel sharing destination type must be USER or PAGE. Do not pass reels_cross_app_share_type here.');
    }
    const destination: Record<string, any> = { destination_id: String(destId), destination_type: destinationTypeText };
    if (audienceType) destination.destination_audience_type = String(audienceType);
    if (validationBypass && validationBypass.length) {
      destination.validation_bypass = validationBypass;
      destination.validation_check_bypass = true;
    } else if (validationBypassProvided) destination.validation_check_bypass = false;
    return destination;
  }

  /** Build configure fields for sharing a Reel to Facebook (XPlatformParams fields). */
  async clipShareToFbExtraData(
    this: Client,
    cfg: Record<string, any> | null = null,
    destinationId: string | null = null,
    destinationType: ClipFbDestinationType | null = null,
    destinationAudienceType: string | null = null,
    xpostSurface = 'IG_REELS_COMPOSER',
    validationCheckBypass: boolean | string[] | string | null = null,
    attemptId: string | null = null,
  ): Promise<Record<string, any>> {
    const destination = await this.clipShareToFbDestination(cfg, destinationId, destinationType, destinationAudienceType, validationCheckBypass);
    const data: Record<string, any> = {
      share_to_facebook: '1',
      is_reel_shared_to_fb: true,
      share_to_facebook_reels: true,
      cross_app_share_type: '2',
      share_to_fb_destination_id: destination.destination_id,
      share_to_fb_destination_type: destination.destination_type,
      xpost_surface: xpostSurface,
      no_token_crosspost: '1',
      attempt_id: attemptId || randomUUID(),
    };
    if (destination.destination_audience_type) data.share_to_fb_destination_audience_type = destination.destination_audience_type;
    if (destination.validation_bypass) data.share_to_facebook_validation_bypass = JSON.stringify(destination.validation_bypass);
    return data;
  }
  /**
   * Upload CLIP (Reel) to Instagram.
   * showPreviewInFeed / feedShow control "clips_share_preview_to_feed"; trial uploads a Trial Reel;
   * topics: interest topics from clipInterestTopics().
   */
  async clipUpload(this: Client, filePath: string, caption: string, opts: ClipUploadOptions = {}): Promise<Media> {
    const {
      thumbnail = null,
      usertags = [],
      location = null,
      configureTimeout = 10,
      extraData = {},
      trial = false,
      trialGraduationStrategy = 'manual',
      shareToFacebook = false,
      fbDestinationId = null,
      fbDestinationType = null,
      fbDestinationAudienceType = null,
      fbXpostSurface = 'IG_REELS_COMPOSER',
      fbValidationCheckBypass = null,
      topics = null,
      showPreviewInFeed = true,
      shareToThreads = false,
      threadsDestinationId = null,
      threadsValidationBypass = null,
    } = opts;
    const uploadId = String(Date.now());
    const [thumb, width, height, duration] = await analyzeClipVideo(filePath, thumbnail);
    const clipData = await fsp.readFile(filePath);
    const clipLen = String(clipData.length);
    let feedShow = _clipFeedShowValue(showPreviewInFeed, opts.feedShow ?? null);
    let configureExtraData: Record<string, any> = { ...(extraData || {}) };
    if (shareToFacebook) {
      const fbExtraData = await this.clipShareToFbExtraData(null, fbDestinationId, fbDestinationType, fbDestinationAudienceType, fbXpostSurface, fbValidationCheckBypass);
      configureExtraData = { ...fbExtraData, ...configureExtraData };
    }
    if (shareToThreads) {
      const threadsExtraData = await this.mediaShareToThreadsExtraData(null, threadsDestinationId, threadsValidationBypass);
      configureExtraData = { ...threadsExtraData, ...configureExtraData };
    }
    if (trial) {
      feedShow = '0';
      if (!('trial_params' in configureExtraData)) configureExtraData.trial_params = { graduation_strategy: trialGraduationStrategy };
    }
    if (topics !== null && topics !== undefined && !('interest_topics' in configureExtraData)) configureExtraData.interest_topics = topics.map(String);
    const durationMs = String(Math.trunc(duration * 1000));
    const composerSessionId = randomUUID();
    const assetId = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
    const targetId = this.userIdInt;
    const uploadContext: Record<string, any> = { source_attribution: null, enable_video_dimension_upscale: false, source_type: 'clips', quality: '' };
    if (targetId) uploadContext.target_id = targetId;
    const uploadTimestampMs = uploadId;
    const uploadName = `${randomUUID().replace(/-/g, '')}-0-${clipLen}-${uploadTimestampMs}-${uploadTimestampMs}`;
    const uploadSettings = {
      composer_session_id: composerSessionId,
      upload_setting_properties: {
        upload_settings_version: 'v0.1',
        codec: {},
        context: uploadContext,
        video: {
          video_height: height,
          video_gop_size_sec: 0,
          video_rotation_angle: 0,
          video_width: width,
          source_video_codec: null,
          video_partial_frame_size_bytes: 0,
          asset_id: assetId,
          video_key_frame_size_bytes: 0,
          target_duration: Math.trunc(duration),
          video_original_file_size: Number(clipLen),
          video_duration_milliseconds: Number(durationMs),
          audio_bit_rate_bps: -1,
          video_bit_rate_bps: 0,
          audio_codec_type: null,
          video_fps: 30,
        },
        creative_tools: { transmuxing_eligible: false, transcoding_required: true },
        network: {
          download_latency_connection_quality: 'ig_dummy',
          network_connection_name: 'ig_dummy',
          download_bandwidth_connection_quality: 'ig_dummy',
        },
      },
      preview_spec: { spec_version: 1, video_dur_ms: Number(durationMs), audio_dur_ms: Number(durationMs) },
    };
    const uploadSettingsData = jsonDumps(uploadSettings);
    const uploadSettingsLen = String(Buffer.byteLength(uploadSettingsData, 'utf8'));
    let headers: Record<string, string> = this.privateHeaders({
      'Accept-Encoding': 'gzip',
      'Content-Type': 'application/json',
      'Content-Length': uploadSettingsLen,
      Offset: '0',
      'X-Entity-Length': uploadSettingsLen,
      'X-Entity-Name': 'upload_settings',
      'X-Entity-Type': 'application/json',
      X_FB_VIDEO_WATERFALL_ID: `${composerSessionId}_settings`,
    });
    let response = await this.private.post(`https://${config.API_DOMAIN}/upload_settings/${composerSessionId}`, { data: uploadSettingsData, headers });
    this.requestLog(response);
    if (response.status_code !== 200) this._raiseClipUploadError(response, 'upload_settings');
    const ruploadParams = {
      provenance_metadata: jsonDumps({ origin: ['EXTERNAL'] }),
      upload_media_height: String(height),
      share_type: 'reels',
      debug_segment_id: '0',
      extract_cover_frame: '1',
      upload_engine_config_enum: '0',
      xsharing_user_ids: '[]',
      upload_media_width: String(width),
      stella_data: '{}',
      is_clips_video: '1',
      is_optimistic_upload: 'true',
      upload_media_duration_ms: durationMs,
      content_tags: 'use_default_cover',
      upload_id: uploadId,
      retry_context: '{"num_reupload":0,"num_step_manual_retry":0,"num_step_auto_retry":0}',
      session_id: uploadId,
      media_type: '2',
    };
    headers = this.privateHeaders({
      'Accept-Encoding': 'gzip',
      'X-Instagram-Rupload-Params': jsonDumps(ruploadParams),
      X_FB_VIDEO_WATERFALL_ID: `${composerSessionId}_${assetId}_Mixed_0`,
      'X-Entity-Type': 'video/mp4',
      'Segment-Start-Offset': '0',
      'Segment-Type': '3',
    });
    const url = `https://${config.API_DOMAIN}/rupload_igvideo/${uploadName}`;
    response = await this.private.get(url, { headers });
    this.requestLog(response);
    if (response.status_code !== 200) this._raiseClipUploadError(response, 'rupload_init');
    headers = { Offset: '0', 'X-Entity-Name': uploadName, 'X-Entity-Length': clipLen, 'Content-Type': 'application/octet-stream', 'Content-Length': clipLen, ...headers };
    response = await this.private.post(url, { data: clipData, headers });
    this.requestLog(response);
    if (response.status_code !== 200) this._raiseClipUploadError(response, 'rupload_upload');
    // CONFIGURE
    for (let attempt = 0; attempt < 50; attempt++) {
      this.logger.debug(`Attempt #${attempt} to configure CLIP: ${filePath}`);
      await sleep(configureTimeout);
      let configured: any;
      try {
        configured = await this.clipConfigure(uploadId, thumb, width, height, duration, caption, usertags, location, feedShow, configureExtraData);
      } catch (e: any) {
        if (e instanceof ClientError && String(e.message).includes('Transcode not finished yet')) {
          // Response 202 status: {"message": "Transcode not finished yet.", "status": "fail"}
          await sleep(configureTimeout);
          continue;
        }
        throw e;
      }
      if (configured && Object.keys(configured).length) return this._extractConfiguredMediaOrRaise(configured, ClipConfigureError, 'Clip upload');
    }
    throw new ClipConfigureError({ ...this.lastJson, response: this.lastResponse });
  }

  /**
   * Upload CLIP as reel with music metadata. It also adds the music under the video, therefore a mute video is required.
   * If you just want to add music metadata, use clipUploadWithMusic.
   */
  async clipUploadAsReelWithMusic(this: Client, filePath: string, caption: string, track: Track, extraData: Record<string, any> = {}): Promise<Media> {
    let tmpaudio = makeTmpPath('.m4a');
    tmpaudio = await this.trackDownloadByUrl(String(track.uri), 'track', path.dirname(tmpaudio));
    let tmpvideo: string | null = null;
    const highlightStartTime = (track.highlight_start_times_in_ms || [])[0] ?? 0;
    try {
      // get all media to create the reel
      let videoInfo;
      let audioDuration: number | null = null;
      try {
        videoInfo = await probe(filePath);
        try {
          audioDuration = Number((await probe(tmpaudio)).duration) || null;
        } catch {
          audioDuration = null;
        }
      } catch (e) {
        if (e instanceof FfmpegUnavailableError) throw Boom.failedDependency(`clipUploadAsReelWithMusic() requires ffmpeg. ${FFMPEG_INSTALL_MESSAGE}`);
        throw e;
      }
      // set the start time of the audio and create the actual media
      const videoDuration = Number(videoInfo.duration);
      let start = highlightStartTime / 1000;
      let end = start + videoDuration;
      if (audioDuration && end > audioDuration) {
        start = Math.max(0.0, audioDuration - videoDuration);
        end = audioDuration;
      }
      const audioAssetStartTime = Math.trunc(start * 1000);
      const overlapDuration = Math.trunc((end - start) * 1000);
      // save the media in tmp folder
      tmpvideo = makeTmpPath('.mp4');
      await ffmpeg(['-i', filePath, '-ss', String(start), '-t', String(end - start), '-i', tmpaudio, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', tmpvideo]);
      // create the extra data to upload with it
      const data = this.clipMusicExtraData(track, extraData, audioAssetStartTime, overlapDuration, 0.0);
      return await this.clipUpload(tmpvideo, caption, { extraData: data });
    } finally {
      for (const p of [tmpvideo, tmpaudio]) if (p) await fsp.unlink(p).catch(() => undefined);
    }
  }

  /** Build Reel music metadata for clipUpload(..., {extraData}). Only adds metadata fields; does not mux audio. */
  clipMusicExtraData(
    this: Client,
    track: Track | Record<string, any>,
    extraData: Record<string, any> = {},
    audioAssetStartTime: number | null = null,
    overlapDuration = 30000,
    originalVolume = 1.0,
    musicVolume = 1.0,
    product: MUSIC_PRODUCT = 'story_camera_clips_v2',
    alacornSessionId = 'null',
  ): Record<string, any> {
    const audioAssetId = this._trackValue(track, 'audio_asset_id') || this._trackValue(track, 'id');
    const audioClusterId = this._trackValue(track, 'audio_cluster_id');
    ensure(audioAssetId, 'track.audio_asset_id or track.id is required');
    ensure(audioClusterId, 'track.audio_cluster_id is required');
    if (audioAssetStartTime === null || audioAssetStartTime === undefined) audioAssetStartTime = this._trackHighlightStart(track);
    const artistName = this._trackValue(track, 'display_artist') || '';
    const trackName = this._trackValue(track, 'title') || '';
    const data: Record<string, any> = { ...(extraData || {}) };
    data.clips_audio_metadata = {
      original: { volume_level: floatValue(originalVolume) },
      song: {
        volume_level: floatValue(musicVolume),
        is_saved: '0',
        artist_name: artistName,
        audio_asset_id: audioAssetId,
        audio_cluster_id: audioClusterId,
        track_name: trackName,
        is_picked_precapture: '1',
      },
    };
    data.music_params = {
      audio_asset_id: audioAssetId,
      audio_cluster_id: audioClusterId,
      audio_asset_start_time_in_ms: Math.trunc(audioAssetStartTime),
      derived_content_start_time_in_ms: 0,
      overlap_duration_in_ms: Math.trunc(overlapDuration),
      product,
      song_name: trackName,
      artist_name: artistName,
      alacorn_session_id: alacornSessionId,
    };
    const musicCanonicalId = this._trackValue(track, 'music_canonical_id');
    if (musicCanonicalId) {
      data.clips_audio_metadata.song.music_canonical_id = musicCanonicalId;
      data.music_params.music_canonical_id = musicCanonicalId;
    }
    return data;
  }

  /** Upload a Reel with music metadata without local audio muxing. */
  async clipUploadWithMusic(
    this: Client,
    filePath: string,
    caption: string,
    track: Track | Record<string, any>,
    opts: ClipUploadOptions & {
      audioAssetStartTime?: number | null;
      overlapDuration?: number;
      originalVolume?: number;
      musicVolume?: number;
      product?: MUSIC_PRODUCT;
      alacornSessionId?: string;
    } = {},
  ): Promise<Media> {
    const data = this.clipMusicExtraData(
      track,
      opts.extraData ?? {},
      opts.audioAssetStartTime ?? null,
      opts.overlapDuration ?? 30000,
      opts.originalVolume ?? 1.0,
      opts.musicVolume ?? 1.0,
      opts.product ?? 'story_camera_clips_v2',
      opts.alacornSessionId ?? 'null',
    );
    return this.clipUpload(filePath, caption, { ...opts, extraData: data });
  }

  /** Post Configure CLIP (send caption, thumbnail and more to Instagram) */
  async clipConfigure(
    this: Client,
    uploadId: string,
    thumbnail: string,
    width: number,
    height: number,
    duration: number,
    caption: string,
    usertags: Usertag[] = [],
    location: Location | null = null,
    feedShow: string | null = null,
    extraData: Record<string, any> = {},
    showPreviewInFeed = true,
  ): Promise<any> {
    feedShow = _clipFeedShowValue(showPreviewInFeed, feedShow);
    await this.photoRupload(thumbnail, uploadId, false, true);
    const tags = usertags.map((tag) => ({ user_id: tag.user.pk, position: [pf(tag.x), pf(tag.y)] }));
    const data = {
      // "igtv_ads_toggled_on": "0",
      filter_type: '0',
      timezone_offset: String(this.timezoneOffset),
      location: await this.locationBuild(location),
      source_type: '4',
      // "title": title,
      caption,
      usertags: jsonDumps({ in: tags }),
      clips_share_preview_to_feed: feedShow,
      upload_id: uploadId,
      // "igtv_composer_session_id": self.igtv_composer_session_id,
      device: this.device,
      length: pf(duration),
      clips_segments_metadata: {
        num_segments: 1,
        clips_segments: [
          {
            index: 0,
            face_effect_id: null,
            speed: 100,
            source_type: 4,
            duration_ms: Math.trunc(duration * 1000),
            audio_type: 'original',
            from_draft: 0,
            camera_position: -1,
            media_folder: null,
            media_type: 'video',
            original_media_type: 2,
            original_segment_hash: null,
            is_remix: false,
            has_reusable_template_asset: false,
          },
        ],
      },
      clips_audio_metadata: { original: { volume_level: floatValue(1) } },
      additional_audio_info: { has_voiceover_attribution: 0 },
      edits: { filter_type: 0, filter_strength: floatValue(1) },
      capture_type: 'clips_v2',
      clips_creation_entry_point: 'clips',
      camera_entry_point: '71',
      audience: 'default',
      include_e2ee_mentioned_user_list: '1',
      hide_from_profile_grid: 'false',
      original_width: width,
      original_height: height,
      extra: { source_width: width, source_height: height },
      audio_muted: false,
      poster_frame_index: 70,
      ...extraData,
    };
    return this.privateRequest('media/configure_to_clips/?video=1', this.withDefaultData(data), { withSignature: true });
  }
}
