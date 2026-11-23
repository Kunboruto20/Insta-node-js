import * as path from 'node:path';
import { AlbumConfigureError, AlbumNotDownload, AlbumUnknownFormat } from '../exceptions';
import { Location, Media, Track, Usertag } from '../types';
import { dumps, pyFloat } from '../utils/serialization';
import { dateTimeOriginal, sleep } from '../utils/timing';
import { withCoauthorUserIds } from '../utils/upload';
import { pyAssert } from '../utils/validation';
import { CrosspostingOptions } from './crossposting';
import { pf } from './photo';
import type { Client } from '../client';

export type AlbumConfigureHandler = (
  children: Record<string, any>[],
  caption: string,
  usertags: Usertag[] | Usertag[][],
  location: Location | null,
  extraData: Record<string, any>,
) => Promise<any> | any;

export interface AlbumUploadOptions extends CrosspostingOptions {
  usertags?: Usertag[] | Usertag[][];
  location?: Location | null;
  configureTimeout?: number;
  configureHandler?: AlbumConfigureHandler | null;
  configureException?: (new (...args: any[]) => Error) | null;
  toStory?: boolean;
  extraData?: Record<string, any>;
  scheduleAt?: number | Date | null;
  coauthorUserIds?: Array<string | number> | null;
}

/** Helper class to download album */
export class DownloadAlbumMixin {
  /** Download your album. Returns list of paths */
  async albumDownload(this: Client, mediaPk: string | number, folder = '', overwrite = true): Promise<string[]> {
    const media = await this.mediaInfo(mediaPk);
    pyAssert(media.media_type === 8, 'Must been album');
    const paths: string[] = [];
    for (const resource of media.resources) {
      const filename = `${media.user.username}_${resource.pk}`;
      if (resource.media_type === 1) paths.push(await this.photoDownloadByUrl(String(resource.thumbnail_url), filename, folder, overwrite));
      else if (resource.media_type === 2) paths.push(await this.videoDownloadByUrl(String(resource.video_url), filename, folder, overwrite));
      else throw new AlbumNotDownload('Media type "{resource.media_type}" unknown for album (resource={resource.pk})');
    }
    return paths;
  }

  /** Download your album using specified URLs */
  async albumDownloadByUrls(this: Client, urls: string[], folder = '', overwrite = true): Promise<string[]> {
    const paths: string[] = [];
    for (const url of urls) {
      const p = new URL(url).pathname;
      const fileName = p.slice(p.lastIndexOf('/') + 1);
      const lower = fileName.toLowerCase();
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) paths.push(await this.photoDownloadByUrl(url, fileName, folder, overwrite));
      else if (lower.endsWith('.mp4')) paths.push(await this.videoDownloadByUrl(url, fileName, folder, overwrite));
      else throw new AlbumUnknownFormat();
    }
    return paths;
  }

  /** Download your album as bytes */
  async albumDownloadOrigin(this: Client, mediaPk: string | number): Promise<Buffer[]> {
    const media = await this.mediaInfo(mediaPk);
    pyAssert(media.media_type === 8, 'Must been album');
    const files: Buffer[] = [];
    for (const resource of media.resources) {
      if (resource.media_type === 1) files.push(await this.photoDownloadByUrlOrigin(String(resource.thumbnail_url)));
      else if (resource.media_type === 2) files.push(await this.videoDownloadByUrlOrigin(String(resource.video_url)));
      else throw new AlbumNotDownload('Media type "{resource.media_type}" unknown for album (resource={resource.pk})');
    }
    return files;
  }
}

export class UploadAlbumMixin {
  /**
   * Upload album to feed.
   * usertags: list of Usertag for the first item, or list of lists (one per child).
   */
  async albumUpload(this: Client, paths: string[], caption: string, opts: AlbumUploadOptions = {}): Promise<Media> {
    if (!paths.length) throw new AlbumUnknownFormat('Album upload requires at least one media path.');
    const usertags = opts.usertags ?? [];
    const location = opts.location ?? null;
    const configureTimeout = opts.configureTimeout ?? 3;
    const ConfigureException = opts.configureException || AlbumConfigureError;
    let extraData = withCoauthorUserIds(opts.extraData ?? {}, opts.coauthorUserIds ?? null);
    extraData = this._scheduledExtraData(extraData, opts.scheduleAt ?? null);
    extraData = await this._mediaCrosspostingExtraData(extraData, opts);
    const children: Record<string, any>[] = [];
    for (const p of paths) {
      const ext = path.extname(p).toLowerCase();
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        const [uploadId, width, height] = await this.photoRupload(p, '', true);
        children.push({
          upload_id: uploadId,
          edits: dumps({ crop_original_size: [width, height], crop_center: [pyFloat(0), pyFloat(-0)], crop_zoom: pyFloat(1) }),
          extra: dumps({ source_width: width, source_height: height }),
          scene_capture_type: '',
          scene_type: null,
        });
      } else if (ext === '.mp4') {
        const [uploadId, width, height, duration, thumbnail] = await this.videoRupload(p, null, true);
        children.push({
          upload_id: uploadId,
          clips: dumps([{ length: pf(duration), source_type: '4' }]),
          extra: dumps({ source_width: width, source_height: height }),
          length: pf(duration),
          poster_frame_index: '0',
          filter_type: '0',
          video_result: '',
          date_time_original: dateTimeOriginal(),
          audio_muted: 'false',
        });
        await this.photoRupload(thumbnail, uploadId);
      } else {
        throw new AlbumUnknownFormat(`Unsupported album media format "${ext}" for "${path.basename(p)}".`);
      }
    }
    const handler: AlbumConfigureHandler = opts.configureHandler || ((c, cap, u, l, e) => this.albumConfigure(c, cap, u, l, e));
    for (let attempt = 0; attempt < 50; attempt++) {
      this.logger.debug(`Attempt #${attempt} to configure Album: ${paths}`);
      await sleep(configureTimeout);
      let configured: any;
      try {
        configured = await handler(children, caption, usertags, location, extraData);
      } catch (e: any) {
        if (String(e?.message ?? e).includes('Transcode not finished yet')) {
          // Response 202 status: {"message": "Transcode not finished yet.", "status": "fail"}
          await sleep(configureTimeout);
          continue;
        }
        throw e;
      }
      if (configured && Object.keys(configured).length) return this._extractConfiguredMediaOrRaise(configured, ConfigureException, 'Album upload');
    }
    throw new ConfigureException({ ...this.lastJson, response: this.lastResponse });
  }

  /** Upload a feed album/carousel with attached music. */
  async albumUploadWithMusic(
    this: Client,
    paths: string[],
    caption: string,
    track: Track | Record<string, any>,
    opts: AlbumUploadOptions & {
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
    return this.albumUpload(paths, caption, { ...opts, extraData: data });
  }

  /** Post Configure Album */
  async albumConfigure(
    this: Client,
    childs: Record<string, any>[],
    caption: string,
    usertags: Usertag[] | Usertag[][] = [],
    location: Location | null = null,
    extraData: Record<string, any> = {},
  ): Promise<any> {
    const uploadId = String(Date.now());
    if (usertags.length) {
      if (Array.isArray(usertags[0])) {
        (usertags as Usertag[][]).forEach((childUsertags, i) => {
          if (i >= childs.length || !childUsertags || !childUsertags.length) return;
          childs[i].usertags = dumps({ in: childUsertags.map((tag) => ({ user_id: tag.user.pk, position: [pf(tag.x), pf(tag.y)] })) });
        });
      } else {
        const childUsertags = (usertags as Usertag[]).map((tag) => ({ user_id: tag.user.pk, position: [pf(tag.x), pf(tag.y)] }));
        childs[0].usertags = dumps({ in: childUsertags });
      }
    }
    const data = {
      timezone_offset: String(this.timezoneOffset),
      source_type: '4',
      creation_logger_session_id: this.clientSessionId,
      location: await this.locationBuild(location),
      caption,
      client_sidecar_id: uploadId,
      upload_id: uploadId,
      // "location": self.build_location(name, lat, lng, address),
      suggested_venue_position: -1,
      device: this.device,
      is_suggested_venue: false,
      children_metadata: childs.map((child) => ({
        source_type: '4',
        timezone_offset: String(this.timezoneOffset),
        device: dumps(this.device),
        ...child,
      })),
      ...extraData,
    };
    return this.privateRequest('media/configure_sidecar/', this.withDefaultData(data));
  }
}
