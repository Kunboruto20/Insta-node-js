import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { ClientError, TrackNotFound } from '../core/errorClasses';
import { extractTrack } from '../parsing/responseParsers';
import { get as httpGet } from '../net/httpClient';
import { Track } from '../models/schemas';
import { jsonValue } from '../helpers/encoding';
import { ensure } from '../helpers/assertions';
import type { Client } from '../core/instaClient';

export type MUSIC_PRODUCT = 'feed_post' | 'music_in_feed' | 'story_camera_clips_v2';

export class TrackFeature {
  _trackValue(this: Client, track: Track | Record<string, any>, key: string): any {
    return (track as any)?.[key] ?? null;
  }

  _trackHighlightStart(this: Client, track: Track | Record<string, any>): number {
    const highlightTimes = this._trackValue(track, 'highlight_start_times_in_ms') || [];
    return highlightTimes.length ? Math.trunc(Number(highlightTimes[0])) : 0;
  }

  /** Download track by URL. Returns path */
  async trackDownloadByUrl(this: Client, url: string, filename = '', folder = ''): Promise<string> {
    url = String(url);
    const p = new URL(url).pathname;
    const fname = p.slice(p.lastIndexOf('/') + 1).trim();
    ensure(fname, 'The URL must contain the path to the file (m4a or mp3).');
    const name = filename ? `${filename}.${fname.slice(fname.lastIndexOf('.') + 1)}` : fname;
    const filePath = path.join(folder || '', name);
    const response = await httpGet(url, this._downloadRequestOptions());
    response.raise_for_status();
    void fsp;
    return this._downloadResponseToPath(response, filePath);
  }

  async _trackRequest(this: Client, data: Record<string, any>, requestPath = 'clips/music/'): Promise<any> {
    try {
      return await this.privateRequest(requestPath, data);
    } catch (e) {
      if (e instanceof ClientError) {
        if (!this.lastJson || !Object.keys(this.lastJson).length) {
          const kw: Record<string, any> = {};
          for (const [k, v] of Object.entries(data)) if (k === 'music_canonical_id' || k === 'original_sound_audio_asset_id') kw[k] = v;
          throw new TrackNotFound(kw);
        }
      }
      throw e;
    }
  }

  /** Retrieve music candidates for feed photo and carousel posts. */
  async musicInFeedAudioBrowser(this: Client, browseSessionId: string | null = null): Promise<any> {
    if (browseSessionId === null || browseSessionId === undefined) browseSessionId = this.generateUuid();
    return this.privateRequest(
      'music/music_in_feed_audio_browser/',
      { product: 'music_in_feed', _uuid: this.uuid, browse_session_id: browseSessionId },
      { withSignature: false },
    );
  }

  /** Retrieve trending music candidates. */
  async musicTrending(this: Client, product: MUSIC_PRODUCT = 'feed_post'): Promise<any> {
    return this.privateRequest('music/trending/', { product, _uuid: this.uuid }, { withSignature: false });
  }

  /** Retrieve top trending music candidates. */
  async musicTopTrends(this: Client, product: MUSIC_PRODUCT = 'music_in_feed', pageSize = 15): Promise<any> {
    return this.privateRequest('music/top_trends/', { product, _uuid: this.uuid, page_size: String(pageSize) }, { withSignature: false });
  }

  /** Search music through the current music/search_v2/ app endpoint. */
  async musicSearchV2(
    this: Client,
    query: string,
    product: MUSIC_PRODUCT = 'music_in_feed',
    fromTypeahead = false,
    searchSessionId: string | null = null,
    browseSessionId: string | null = null,
  ): Promise<any> {
    if (searchSessionId === null || searchSessionId === undefined) searchSessionId = this.generateUuid();
    if (browseSessionId === null || browseSessionId === undefined) browseSessionId = this.generateUuid();
    return this.privateRequest(
      'music/search_v2/',
      {
        from_typeahead: this._boolToIgString(fromTypeahead),
        search_session_id: searchSessionId,
        product,
        q: String(query),
        _uuid: this.uuid,
        browse_session_id: browseSessionId,
      },
      { withSignature: false },
    );
  }

  /** Search music keywords for typeahead. */
  async musicKeywordSearch(
    this: Client,
    query: string,
    product: MUSIC_PRODUCT = 'music_in_feed',
    numKeywords = 3,
    searchSessionId = '',
    browseSessionId: string | null = null,
  ): Promise<any> {
    if (browseSessionId === null || browseSessionId === undefined) browseSessionId = this.generateUuid();
    return this.privateRequest('music/keyword_search/', null, {
      params: { num_keywords: String(numKeywords), search_session_id: searchSessionId, product, q: String(query), browse_session_id: browseSessionId },
    });
  }

  /** Bookmark an original audio track. */
  async musicBookmark(this: Client, originalAudioId: string, surfaceRequestedFrom = 'audio_aggregation_page'): Promise<boolean> {
    const result = await this.privateRequest(
      'music/bookmark_music/',
      { original_audio_id: String(originalAudioId), _uuid: this.uuid, surface_requested_from: surfaceRequestedFrom },
      { withSignature: false },
    );
    return Boolean(result.success) || result.status === 'ok';
  }

  /** Retrieve bookmarked music tracks. */
  async musicBookmarked(this: Client, maxId = ''): Promise<any> {
    const data: Record<string, any> = { _uuid: this.uuid };
    if (maxId) data.max_id = maxId;
    return this.privateRequest('music/playlist/bookmarked/', data, { withSignature: false });
  }

  /** Retrieve music candidates for the Reels/Clips camera surface. */
  async musicClipsAudioBrowser(this: Client, product: MUSIC_PRODUCT = 'story_camera_clips_v2', browseSessionId: string | null = null): Promise<any> {
    if (browseSessionId === null || browseSessionId === undefined) browseSessionId = this.generateUuid();
    return this.privateRequest('music/clips_audio_browser/', { product, _uuid: this.uuid, browse_session_id: browseSessionId }, { withSignature: false });
  }

  /** Validate an original audio title for Reels publishing. */
  async musicVerifyOriginalAudioTitle(this: Client, originalAudioName: string): Promise<boolean> {
    const result = await this.privateRequest(
      'music/verify_original_audio_title/',
      { original_audio_name: originalAudioName, _uuid: this.uuid },
      { withSignature: false },
    );
    return Boolean(result.is_valid);
  }

  async _feedMusicParams(
    this: Client,
    track: Track | Record<string, any>,
    audioAssetStartTime: number | null = null,
    overlapDuration = 30000,
    browseSessionId: string | null = null,
    alacornSessionId: string | null = null,
  ): Promise<Record<string, any>> {
    const audioAssetId = this._trackValue(track, 'audio_asset_id') || this._trackValue(track, 'id');
    const audioClusterId = this._trackValue(track, 'audio_cluster_id');
    ensure(audioAssetId, 'track.audio_asset_id or track.id is required');
    ensure(audioClusterId, 'track.audio_cluster_id is required');
    if (audioAssetStartTime === null || audioAssetStartTime === undefined) audioAssetStartTime = this._trackHighlightStart(track);
    if (alacornSessionId === null || alacornSessionId === undefined) alacornSessionId = this._trackValue(track, 'alacorn_session_id');
    if (alacornSessionId === null || alacornSessionId === undefined) alacornSessionId = (await this.musicInFeedAudioBrowser()).alacorn_session_id;
    ensure(alacornSessionId, 'alacorn_session_id is required');
    const data: Record<string, any> = {
      audio_asset_id: audioAssetId,
      audio_cluster_id: audioClusterId,
      audio_asset_start_time_in_ms: Math.trunc(audioAssetStartTime),
      derived_content_start_time_in_ms: 0,
      overlap_duration_in_ms: Math.trunc(overlapDuration),
      browse_session_id: browseSessionId,
      product: 'music_in_feed',
      song_name: this._trackValue(track, 'title') || '',
      artist_name: this._trackValue(track, 'display_artist') || '',
      alacorn_session_id: alacornSessionId,
      audio_apply_source: 0,
    };
    const musicCanonicalId = this._trackValue(track, 'music_canonical_id');
    if (musicCanonicalId) data.music_canonical_id = musicCanonicalId;
    return data;
  }

  /** Get Track by music_canonical_id */
  async trackInfoByCanonicalId(this: Client, musicCanonicalId: string): Promise<Track> {
    const data = { tab_type: 'clips', referrer_media_id: '', _uuid: this.uuid, music_canonical_id: String(musicCanonicalId) };
    const result = await this.privateRequest('clips/music/', data);
    const track = jsonValue(result, 'metadata', 'music_info', 'music_asset_info');
    if (!track) throw new TrackNotFound({ music_canonical_id: String(musicCanonicalId) });
    return extractTrack(track);
  }

  /** Get Track by id (raw insta response json) */
  async trackInfoById(this: Client, trackId: string, maxId = ''): Promise<any> {
    const data: Record<string, any> = { audio_cluster_id: trackId, original_sound_audio_asset_id: trackId };
    if (maxId) data.max_id = maxId;
    return this._trackRequest(data);
  }

  /** Fetch the streamed clips-pivot page for a given track id (POST /clips/stream_clips_pivot_page/). */
  async trackStreamInfoById(this: Client, trackId: string, maxId = ''): Promise<any> {
    const data: Record<string, any> = {
      pivot_page_type: 'audio',
      music_page: { tab_type: 'clips', audio_asset_id: trackId, audio_cluster_id: trackId },
      _uuid: this.uuid,
    };
    if (maxId) data.music_page.max_id = maxId;
    return this._trackRequest(data, 'clips/stream_clips_pivot_page/');
  }
}
