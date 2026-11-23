import { promises as fsp } from 'node:fs';
import sharp from 'sharp';
import * as config from '../config';
import { ClientError, IGTVConfigureError, IGTVNotUpload } from '../exceptions';
import { Location, Media, Usertag } from '../types';
import { pyJsonDumps } from '../utils/serialization';
import { dateTimeOriginal, randomInt, sleep } from '../utils/timing';
import { analyzeVideoForUpload } from '../utils/video';
import { pf } from './photo';
import type { Client } from '../client';

/** Analyze and crop thumbnail if need. Returns [thumbnail, width, height, duration] */
export async function analyzeIgtvVideo(filePath: string, thumbnail: string | null = null): Promise<[string, number, number, number]> {
  return analyzeVideoForUpload(filePath, thumbnail, 'IGTV', cropThumbnail);
}

/** Crop the center of the thumbnail to a 1:1.78 portrait */
export async function cropThumbnail(filePath: string): Promise<boolean> {
  const input = await fsp.readFile(filePath);
  const meta = await sharp(input).metadata();
  const width = meta.width!;
  const height = meta.height!;
  const offset = height / 1.78 / 2;
  const center = width / 2;
  // Crop the center of the image
  const left = Math.round(center - offset);
  const right = Math.round(center + offset);
  const ext = await sharp(input)
    .extend({ left: Math.max(0, -left), right: Math.max(0, right - width), background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const cropped = await sharp(ext)
    .extract({ left: Math.max(0, left), top: 0, width: right - left, height })
    .toFormat(meta.format === 'png' ? 'png' : 'jpeg')
    .toBuffer();
  await fsp.writeFile(filePath, cropped);
  return true;
}

/** Helpers to download IGTV videos */
export class DownloadIGTVMixin {
  /** Download IGTV video */
  async igtvDownload(this: Client, mediaPk: string | number, folder = ''): Promise<string> {
    return this.videoDownload(mediaPk, folder);
  }

  /** Download IGTV video using URL */
  async igtvDownloadByUrl(this: Client, url: string, filename = '', folder = ''): Promise<string> {
    return this.videoDownloadByUrl(url, filename, folder);
  }
}

/** Helpers to upload IGTV videos */
export class UploadIGTVMixin {
  /** Upload IGTV to Instagram */
  async igtvUpload(
    this: Client,
    filePath: string,
    title: string,
    caption: string,
    thumbnail: string | null = null,
    usertags: Usertag[] = [],
    location: Location | null = null,
    configureTimeout = 10,
    extraData: Record<string, any> = {},
  ): Promise<Media> {
    const uploadId = String(Date.now());
    const [thumb, width, height, duration] = await analyzeIgtvVideo(filePath, thumbnail);
    const waterfallId = this.generateUuid();
    // upload_name example: '1576102477530_0_7823256191'
    const uploadName = `${uploadId}_0_${randomInt(1000000000, 9999999999)}`;
    const ruploadParams = {
      is_igtv_video: '1',
      retry_context: '{"num_step_auto_retry":0,"num_reupload":0,"num_step_manual_retry":0}',
      media_type: '2',
      xsharing_user_ids: pyJsonDumps([this.userIdInt]),
      upload_id: uploadId,
      upload_media_duration_ms: String(Math.trunc(duration * 1000)),
      upload_media_width: String(width),
      upload_media_height: String(height),
    };
    let headers: Record<string, string> = {
      'Accept-Encoding': 'gzip',
      'X-Instagram-Rupload-Params': pyJsonDumps(ruploadParams),
      X_FB_VIDEO_WATERFALL_ID: waterfallId,
      'X-Entity-Type': 'video/mp4',
    };
    const url = `https://${config.API_DOMAIN}/rupload_igvideo/${uploadName}`;
    let response = await this.private.get(url, { headers });
    this.requestLog(response);
    if (response.status_code !== 200) throw new IGTVNotUpload({ ...this.lastJson, response: this.lastResponse });
    const igtvData = await fsp.readFile(filePath);
    const igtvLen = String(igtvData.length);
    headers = { Offset: '0', 'X-Entity-Name': uploadName, 'X-Entity-Length': igtvLen, 'Content-Type': 'application/octet-stream', 'Content-Length': igtvLen, ...headers };
    response = await this.private.post(url, { data: igtvData, headers });
    this.requestLog(response);
    if (response.status_code !== 200) throw new IGTVNotUpload({ ...this.lastJson, response: this.lastResponse });
    // CONFIGURE
    this.igtvComposerSessionId = this.generateUuid();
    for (let attempt = 0; attempt < 50; attempt++) {
      this.logger.debug(`Attempt #${attempt} to configure IGTV: ${filePath}`);
      await sleep(configureTimeout);
      let configured: any;
      try {
        configured = await this.igtvConfigure(uploadId, thumb, width, height, duration, title, caption, usertags, location, extraData);
      } catch (e: any) {
        if (e instanceof ClientError && String(e.message).includes('Transcode not finished yet')) {
          // Response 202 status: {"message": "Transcode not finished yet.", "status": "fail"}
          await sleep(configureTimeout);
          continue;
        }
        throw e;
      }
      if (configured && Object.keys(configured).length) return this._extractConfiguredMediaOrRaise(configured, IGTVConfigureError, 'IGTV upload');
    }
    throw new IGTVConfigureError({ ...this.lastJson, response: this.lastResponse });
  }

  /** Post Configure IGTV (send caption, thumbnail and more to Instagram) */
  async igtvConfigure(
    this: Client,
    uploadId: string,
    thumbnail: string,
    width: number,
    height: number,
    duration: number,
    title: string,
    caption: string,
    usertags: Usertag[] = [],
    location: Location | null = null,
    extraData: Record<string, any> = {},
  ): Promise<any> {
    await this.photoRupload(thumbnail, uploadId);
    const tags = usertags.map((tag) => ({ user_id: tag.user.pk, position: [pf(tag.x), pf(tag.y)] }));
    const data = {
      igtv_ads_toggled_on: '0',
      filter_type: '0',
      timezone_offset: String(this.timezoneOffset),
      media_folder: 'ScreenRecorder',
      location: await this.locationBuild(location),
      source_type: '4',
      title,
      caption,
      usertags: pyJsonDumps({ in: tags }),
      date_time_original: dateTimeOriginal(),
      igtv_share_preview_to_feed: '1',
      upload_id: uploadId,
      igtv_composer_session_id: this.igtvComposerSessionId,
      device: this.device,
      length: pf(duration),
      clips: [{ length: pf(duration), source_type: '4' }],
      extra: { source_width: width, source_height: height },
      audio_muted: false,
      poster_frame_index: 70,
      ...extraData,
    };
    return this.privateRequest('media/configure_to_igtv/?video=1', this.withDefaultData(data), { withSignature: true });
  }
}
