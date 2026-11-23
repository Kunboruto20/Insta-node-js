import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { ClientError, ClientNotFoundError, DirectMessageNotFound, DirectThreadNotFound } from '../exceptions';
import { extractDirectMedia, extractDirectMessage, extractDirectShortThread, extractDirectThread, extractUserShort } from '../extractors';
import { prepareImage } from '../imageUtil';
import { DirectMedia, DirectMessage, DirectShortThread, DirectThread, Media, UserShort } from '../types';
import { Session } from '../http/session';
import { dumps, pyFloat, pyInt } from '../utils/serialization';
import { randomInt } from '../utils/timing';
import { pyAssert } from '../utils/validation';
import { readVideoMetadata, readVideoMetadataWithFfprobe } from '../utils/video';
import type { Client } from '../client';

export const SELECTED_FILTERS = ['flagged', 'unread'] as const;
export const SEARCH_MODES = ['raven', 'universal'] as const;
export const SEND_ATTRIBUTES = ['message_button', 'inbox_search', 'inbox'] as const;
export const SEND_ATTRIBUTES_MEDIA = [
  'feed_timeline',
  'feed_contextual_chain',
  'feed_short_url',
  'feed_contextual_self_profile',
  'feed_contextual_profile',
] as const;
export const BOXES = ['general', 'primary'] as const;

export type SELECTED_FILTER = (typeof SELECTED_FILTERS)[number];
export type SEARCH_MODE = (typeof SEARCH_MODES)[number];
export type SEND_ATTRIBUTE = (typeof SEND_ATTRIBUTES)[number];
export type SEND_ATTRIBUTE_MEDIA = (typeof SEND_ATTRIBUTES_MEDIA)[number];
export type DirectMediaType = 'photo' | 'video';
export type BOX = (typeof BOXES)[number];
export type IdLike = string | number | bigint;

/** python int() list for thread / user ids (BigInt beyond the safe range, serialized as raw JSON numbers) */
export function _directIdList(ids: IdLike | IdLike[] | null | undefined): Array<number | bigint> {
  if (ids === null || ids === undefined) return [];
  if (!Array.isArray(ids)) return [pyInt(ids)];
  return ids.map((i) => pyInt(i));
}

const DEFAULT_NAV_CHAIN =
  '1qT:feed_timeline:1,1qT:feed_timeline:2,1qT:feed_timeline:3,7Az:direct_inbox:4,7Az:direct_inbox:5,5rG:direct_thread:7';

/** Helpers for managing Direct Messaging */
export class DirectMixin {
  _directRequestTrackingParams(this: Client): Record<string, string> {
    return { eb_device_id: '0', igd_request_log_tracking_id: this.generateUuid() };
  }

  /** Get direct message threads */
  async directThreads(
    this: Client,
    amount = 20,
    selectedFilter: SELECTED_FILTER | null = null,
    box: BOX | null = null,
    threadMessageLimit: number | null = null,
  ): Promise<DirectThread[]> {
    let cursor: string | null = null;
    let threads: DirectThread[] = [];
    // self.private_request("direct_v2/get_presence/")
    while (true) {
      let chunk: DirectThread[];
      [chunk, cursor] = await this.directThreadsChunk(selectedFilter, box, threadMessageLimit, cursor);
      threads.push(...chunk);
      if (!cursor || (amount && threads.length >= amount)) break;
    }
    if (amount) threads = threads.slice(0, amount);
    return threads;
  }

  /** Get direct a chunk of threads by cursor value. Returns [threads, oldest_cursor] */
  async directThreadsChunk(
    this: Client,
    selectedFilter: SELECTED_FILTER | null = null,
    box: BOX | null = null,
    threadMessageLimit: number | null = null,
    cursor: string | null = null,
  ): Promise<[DirectThread[], string | null]> {
    pyAssert(this.userId, 'Login required');
    const params: Record<string, any> = {
      ...this._directRequestTrackingParams(),
      visual_message_return_type: 'unseen',
      thread_message_limit: '10',
      persistentBadging: 'true',
      limit: '20',
      is_prefetching: 'false',
      fetch_reason: 'initial_snapshot',
      include_old_mrs: 'false',
      no_pending_badge: 'true',
      push_disabled: this._boolToIgString(this.pushDisabled),
    };
    if (selectedFilter) {
      if (!(SELECTED_FILTERS as readonly string[]).includes(selectedFilter)) throw new Error(`selected_filter must be one of ${SELECTED_FILTERS}`);
      params.selected_filter = selectedFilter;
    }
    if (box) {
      pyAssert((BOXES as readonly string[]).includes(box), `Unsupported box="${box}" ${BOXES}`);
      params.folder = box === 'general' ? '1' : '0';
    }
    if (threadMessageLimit) params.thread_message_limit = threadMessageLimit;
    if (cursor) Object.assign(params, { cursor, direction: 'older', fetch_reason: 'page_scroll' });
    const result = await this.privateRequest('direct_v2/inbox/', null, { params });
    const inbox = result.inbox || {};
    const threads = (inbox.threads || []).map((t: any) => extractDirectThread(t));
    return [threads, inbox.oldest_cursor ?? null];
  }

  /** Get direct threads of Pending inbox */
  async directPendingInbox(this: Client, amount = 20): Promise<DirectThread[]> {
    let cursor: string | null = null;
    let threads: DirectThread[] = [];
    while (true) {
      let chunk: DirectThread[];
      [chunk, cursor] = await this.directPendingChunk(cursor);
      threads.push(...chunk);
      if (!cursor || (amount && threads.length >= amount)) break;
    }
    if (amount) threads = threads.slice(0, amount);
    return threads;
  }

  /** Get Direct message request threads, also known as pending inbox or invitations. */
  async directRequests(this: Client, amount = 20): Promise<DirectThread[]> {
    return this.directPendingInbox(amount);
  }

  /** Get the lightweight Direct message requests preview (counters such as pending_requests_total). */
  async directPendingRequestsPreview(this: Client, pendingInboxFilters: string[] | null = null): Promise<any> {
    pyAssert(this.userId, 'Login required');
    return this.privateRequest('direct_v2/async_get_pending_requests_preview/', null, { params: { pending_inbox_filters: dumps(pendingInboxFilters || []) } });
  }

  /** Get direct threads of Pending inbox. Chunk. Returns [threads, oldest_cursor] */
  async directPendingChunk(this: Client, cursor: string | null = null): Promise<[DirectThread[], string | null]> {
    pyAssert(this.userId, 'Login required');
    const params: Record<string, any> = {
      visual_message_return_type: 'unseen',
      persistentBadging: 'true',
      is_prefetching: 'false',
      request_session_id: this.requestId,
    };
    if (cursor) params.cursor = cursor;
    const result = await this.privateRequest('direct_v2/pending_inbox/', null, { params });
    const inbox = result.inbox || {};
    return [(inbox.threads || []).map((t: any) => extractDirectThread(t)), inbox.oldest_cursor ?? null];
  }

  /** Approve pending direct thread */
  async directPendingApprove(this: Client, threadId: IdLike): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const result = await this.privateRequest(`direct_v2/threads/${threadId}/approve/`, { filter: 'DEFAULT', _uuid: this.uuid }, { withSignature: false });
    return (result.status ?? '') === 'ok';
  }

  /** Approve a Direct message request thread. */
  async directRequestApprove(this: Client, threadId: IdLike): Promise<boolean> {
    return this.directPendingApprove(threadId);
  }

  /** Get direct threads of Spam inbox (hidden requests) */
  async directSpamInbox(this: Client, amount = 20): Promise<DirectThread[]> {
    let cursor: string | null = null;
    let threads: DirectThread[] = [];
    while (true) {
      let chunk: DirectThread[];
      [chunk, cursor] = await this.directSpamChunk(cursor);
      threads.push(...chunk);
      if (!cursor || (amount && threads.length >= amount)) break;
    }
    if (amount) threads = threads.slice(0, amount);
    return threads;
  }

  /** Get direct threads of Spam inbox (hidden requests). Chunk. */
  async directSpamChunk(this: Client, cursor: string | null = null): Promise<[DirectThread[], string | null]> {
    pyAssert(this.userId, 'Login required');
    const params: Record<string, any> = { visual_message_return_type: 'unseen', persistentBadging: 'true', is_prefetching: 'false' };
    if (cursor) params.cursor = cursor;
    const result = await this.privateRequest('direct_v2/spam_inbox/', null, { params });
    const inbox = result.inbox || {};
    return [(inbox.threads || []).map((t: any) => extractDirectThread(t)), inbox.oldest_cursor ?? null];
  }

  /** Get all the information about a Direct Message thread */
  async directThread(this: Client, threadId: IdLike, amount = 20): Promise<DirectThread> {
    pyAssert(this.userId, 'Login required');
    const params: Record<string, any> = { visual_message_return_type: 'unseen', direction: 'older', seq_id: '40065', limit: '20' }; // 59663
    let cursor: string | null = null;
    let items: any[] = [];
    let thread: any;
    while (true) {
      if (cursor) params.cursor = cursor;
      let result: any;
      try {
        result = await this.privateRequest(`direct_v2/threads/${threadId}/`, null, { params });
      } catch (e) {
        if (e instanceof ClientNotFoundError) throw new DirectThreadNotFound(e, { ...this.lastJson, thread_id: threadId });
        throw e;
      }
      thread = result.thread;
      items.push(...thread.items);
      cursor = thread.oldest_cursor ?? null;
      if (!cursor || (amount && items.length >= amount)) break;
    }
    if (amount) items = items.slice(0, amount);
    thread.items = items;
    return extractDirectThread(thread);
  }

  /** Get all the messages from a thread */
  async directMessages(this: Client, threadId: IdLike, amount = 20): Promise<DirectMessage[]> {
    pyAssert(this.userId, 'Login required');
    return (await this.directThread(threadId, amount)).messages;
  }

  /** Get a Direct message from a thread by message id. */
  async directMessage(this: Client, threadId: IdLike, messageId: IdLike, amount = 20): Promise<DirectMessage> {
    const id = String(messageId);
    for (const message of await this.directMessages(threadId, amount)) if (message.id === id) return message;
    throw new DirectMessageNotFound(`Direct message ${id} not found in thread ${threadId}`, { thread_id: threadId, message_id: id });
  }

  /** Post a message on a Direct Message thread */
  async directAnswer(this: Client, threadId: IdLike, text: string): Promise<DirectMessage> {
    pyAssert(this.userId, 'Login required');
    return this.directSend(text, [], [pyInt(threadId)]);
  }

  /**
   * Send a direct message to list of users or threads (specify userIds or threadIds, not both).
   * navChain: non-empty printable ASCII without leading/trailing whitespace.
   */
  async directSend(
    this: Client,
    text: string,
    userIds: IdLike[] = [],
    threadIds: IdLike[] = [],
    sendAttribute: SEND_ATTRIBUTE = 'message_button',
    replyToMessage: DirectMessage | null = null,
    opts: { navChain?: string | null } = {},
  ): Promise<DirectMessage> {
    pyAssert(this.userId, 'Login required');
    const uids = _directIdList(userIds);
    const tids = _directIdList(threadIds);
    pyAssert((uids.length || tids.length) && !(uids.length && tids.length), 'Specify user_ids or thread_ids, but not both');
    pyAssert((SEND_ATTRIBUTES as readonly string[]).includes(sendAttribute), `Unsupported send_attribute="${sendAttribute}" ${SEND_ATTRIBUTES}`);
    let navChain = opts.navChain ?? null;
    if (navChain === null) navChain = DEFAULT_NAV_CHAIN;
    else if (typeof navChain !== 'string' || !navChain || navChain !== navChain.trim() || Array.from(navChain).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126)) {
      throw new Error('nav_chain must be non-empty printable ASCII without leading or trailing whitespace');
    }
    let method = 'text';
    const token = this.generateMutationToken();
    const kwargs: Record<string, any> = {
      action: 'send_item',
      is_x_transport_forward: 'false',
      send_silently: 'false',
      is_shh_mode: '0',
      send_attribution: sendAttribute,
      client_context: token,
      device_id: this.androidDeviceId,
      mutation_token: token,
      _uuid: this.uuid,
      btt_dual_send: 'false',
      nav_chain: navChain,
      is_ae_dual_send: 'false',
      offline_threading_id: token,
    };
    if (text.includes('http')) {
      method = 'link';
      kwargs.link_text = text;
      kwargs.link_urls = dumps(Array.from(text.matchAll(/(https?:\/\/[^\s]+)/g), (m) => m[1]));
    } else kwargs.text = text;
    if (tids.length) kwargs.thread_ids = dumps(tids);
    if (uids.length) kwargs.recipient_users = dumps([uids]);
    if (replyToMessage) {
      kwargs.replied_to_action_source = 'swipe';
      kwargs.replied_to_item_id = replyToMessage.id;
      kwargs.replied_to_client_context = replyToMessage.client_context;
    }
    const result = await this.privateRequest(`direct_v2/threads/broadcast/${method}/`, this.withDefaultData(kwargs), {
      withSignature: false,
      headers: { 'X-IG-Nav-Chain': navChain },
    });
    return extractDirectMessage(result.payload);
  }

  async _directMessageReaction(
    this: Client,
    threadId: IdLike,
    messageId: IdLike,
    emoji: string,
    reactionStatus: 'created' | 'deleted',
    clientContext: string | null = null,
    actionSource = 'double_tap',
    targetItemType: string | null = null,
  ): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    pyAssert(reactionStatus === 'created' || reactionStatus === 'deleted', `Unsupported reaction_status="${reactionStatus}"`);
    const token = this.generateMutationToken();
    const data: Record<string, any> = {
      action: 'send_item',
      is_x_transport_forward: 'false',
      send_silently: 'false',
      is_shh_mode: '0',
      send_attribution: 'message_reaction',
      client_context: token,
      device_id: this.androidDeviceId,
      mutation_token: token,
      btt_dual_send: 'false',
      nav_chain: DEFAULT_NAV_CHAIN,
      is_ae_dual_send: 'false',
      offline_threading_id: token,
      thread_ids: dumps([String(threadId)]),
      item_type: 'reaction',
      reaction_type: 'like',
      reaction_status: reactionStatus,
      node_type: 'item',
      item_id: String(messageId),
      emoji,
      reaction_action_source: actionSource,
    };
    if (clientContext) data.original_message_client_context = clientContext;
    if (targetItemType) data.target_item_type = targetItemType;
    const result = await this.privateRequest('direct_v2/threads/broadcast/reaction/', this.withDefaultData(data), { withSignature: false });
    return result.status === 'ok';
  }

  /** Send an emoji reaction to a Direct message item. */
  async directSendReaction(
    this: Client,
    threadId: IdLike,
    messageId: IdLike,
    emoji = '❤',
    clientContext: string | null = null,
    actionSource = 'double_tap',
    targetItemType: string | null = null,
  ): Promise<boolean> {
    return this._directMessageReaction(threadId, messageId, emoji, 'created', clientContext, actionSource, targetItemType);
  }

  /** Delete the current user's emoji reaction from a Direct message item. */
  async directDeleteReaction(
    this: Client,
    threadId: IdLike,
    messageId: IdLike,
    emoji = '❤',
    clientContext: string | null = null,
    actionSource = 'double_tap',
    targetItemType: string | null = null,
  ): Promise<boolean> {
    return this._directMessageReaction(threadId, messageId, emoji, 'deleted', clientContext, actionSource, targetItemType);
  }

  /** Like a Direct message item with a heart reaction. */
  async directMessageLike(this: Client, threadId: IdLike, messageId: IdLike, clientContext: string | null = null): Promise<boolean> {
    return this.directSendReaction(threadId, messageId, '❤', clientContext);
  }

  /** Remove the current user's heart reaction from a Direct message item. */
  async directMessageUnlike(this: Client, threadId: IdLike, messageId: IdLike, clientContext: string | null = null): Promise<boolean> {
    return this.directDeleteReaction(threadId, messageId, '❤', clientContext);
  }

  /** Send a direct photo to a list of users or threads (messenger image upload + photo_attachment). */
  async directSendPhoto(this: Client, filePath: string, userIds: IdLike[] = [], threadIds: IdLike[] = []): Promise<DirectMessage> {
    pyAssert(this.userId, 'Login required');
    const uids = _directIdList(userIds);
    let tids = _directIdList(threadIds);
    pyAssert((uids.length || tids.length) && !(uids.length && tids.length), 'Specify user_ids or thread_ids, but not both');
    if (uids.length) tids = [await this._directThreadIdFromUserIds(uids, 'photo')];
    const ext = path.extname(filePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) throw new Error('Invalid file format. Only JPG/JPEG/PNG/WEBP files are supported.');
    const [photoBytes] = await prepareImage(filePath);
    const entityName = `fb_uploader_${Date.now()}`;
    const mediaId = await this._photoRupload(photoBytes, entityName);
    const token = this.generateMutationToken();
    const data = {
      action: 'send_item',
      is_x_transport_forward: 'false',
      is_shh_mode: '0',
      thread_ids: dumps(tids),
      send_attribution: 'inbox',
      client_context: token,
      attachment_fbid: String(mediaId),
      device_id: this.androidDeviceId,
      mutation_token: token,
      _uuid: this.uuid,
      allow_full_aspect_ratio: 'true',
      btt_dual_send: 'false',
      is_ae_dual_send: 'false',
      offline_threading_id: token,
    };
    const result = await this.privateRequest('direct_v2/threads/broadcast/photo_attachment/', this.withDefaultData(data), { withSignature: false });
    return extractDirectMessage(result.payload);
  }

  async _directVideoMetadata(this: Client, filePath: string): Promise<[number, number, number]> {
    const fallback: [number, number, number] = [720, 1280, 1.0];
    let metadata;
    try {
      metadata = readVideoMetadata(filePath);
    } catch {
      try {
        metadata = await readVideoMetadataWithFfprobe(filePath);
      } catch {
        return fallback;
      }
    }
    return [metadata.width, metadata.height, metadata.duration || 1.0];
  }

  async _directThreadIdFromUserIds(this: Client, userIds: IdLike[], mediaKind: string): Promise<number | bigint> {
    const uids = _directIdList(userIds);
    let thread = await this.directThreadByParticipants(uids);
    let threadId = thread.thread_v2_id || thread.thread_id;
    if (!threadId && this.lastJson && typeof this.lastJson === 'object') {
      thread = this.lastJson.thread || {};
      threadId = thread.thread_v2_id || thread.thread_id;
    }
    if (!threadId) {
      throw new DirectThreadNotFound(
        `No existing direct thread found for participants; direct ${mediaKind} send currently requires an existing thread`,
        { ...(this.lastJson && typeof this.lastJson === 'object' ? this.lastJson : {}), user_ids: uids },
      );
    }
    return pyInt(threadId);
  }
  /**
   * Send a direct video to a list of users or threads.
   * Replicates the IG Android client's three-step protocol (FB-domain rupload → raven_attachment broadcast).
   */
  async directSendVideo(this: Client, filePath: string, userIds: IdLike[] = [], threadIds: IdLike[] = []): Promise<DirectMessage> {
    pyAssert(this.userId, 'Login required');
    const uids = _directIdList(userIds);
    let tids = _directIdList(threadIds);
    pyAssert((uids.length || tids.length) && !(uids.length && tids.length), 'Specify user_ids or thread_ids, but not both');
    if (uids.length) tids = [await this._directThreadIdFromUserIds(uids, 'video')];
    const videoBytes = await fsp.readFile(filePath);
    const size = videoBytes.length;
    const [width, height, durationSec] = await this._directVideoMetadata(filePath);
    // Steps 1 + 2: FB-domain rupload, returns media_id.
    const hexId = randomBytes(16).toString('hex');
    const ms = Date.now();
    const entity = `${hexId}-0-${size}-${ms}-${ms}`;
    const uploadId = String(randomInt(10 ** 11, 10 ** 12 - 1));
    const waterfallId = `${uploadId}_${hexId.slice(0, 12).toUpperCase()}_Mixed_0`;
    const mediaId = await this._videoRupload(videoBytes, entity, waterfallId);
    // Step 3: signed broadcast to raven_attachment/?video=1.
    const token = this.generateMutationToken();
    const data = {
      recipient_users: '[]',
      view_mode: 'permanent',
      has_camera_metadata: '1',
      camera_entry_point: '3',
      thread_ids: dumps(tids.map(String)),
      reshare_mode: 'allow_reshare',
      original_media_type: '2', // 2 = video
      send_attribution: 'direct_composer',
      client_context: token,
      camera_session_id: this.generateUuid(),
      attachment_fbid: String(mediaId),
      include_e2ee_mentioned_user_list: '1',
      hide_from_profile_grid: 'false',
      timezone_offset: '0',
      client_shared_at: String(Math.trunc(Date.now() / 1000)),
      configure_mode: '2',
      source_type: '3',
      camera_position: 'back',
      video_result: String(mediaId),
      _uid: String(this.userId),
      device_id: this.androidDeviceId,
      composition_id: this.generateUuid(),
      mutation_token: token,
      _uuid: this.uuid,
      creation_surface: 'camera',
      has_ig_camera_edits: 'false',
      capture_type: 'normal',
      audience: 'default',
      upload_id: uploadId,
      client_timestamp: String(Math.trunc(Date.now() / 1000)),
      media_transformation_info: dumps({
        width: String(width),
        height: String(height),
        x_transform: '0',
        y_transform: '0',
        zoom: '1.0',
        rotation: '0.0',
        background_coverage: '0.0',
      }),
      clips: [{ length: pyFloat(durationSec), source_type: '3', camera_position: 'back' }],
      poster_frame_index: 0,
      length: pyFloat(durationSec),
      audio_muted: false,
      edits: { filter_type: 0, filter_strength: pyFloat(1) },
      extra: { source_width: width, source_height: height },
      device: { manufacturer: 'Google', model: 'sdk_gphone_arm64', android_version: 30, android_release: '11' },
    };
    const result = await this.privateRequest('direct_v2/threads/broadcast/raven_attachment/?video=1', this.withDefaultData(data), { withSignature: true });
    return extractDirectMessage(result.payload);
  }

  _messengerRuploadHeaders(this: Client, extraHeaders: Record<string, string> | null = null): Record<string, string> {
    const bearer = this.private.headers.get('Authorization') || this.authorization;
    const userId = String(this.userId);
    const rur = this.private.headers.get('IG-U-RUR', '') || '';
    const mid = this.private.headers.get('X-MID', '') || '';
    const headers: Record<string, string> = {
      authorization: bearer,
      'ig-intended-user-id': userId,
      'ig-u-ds-user-id': userId,
      // The real client may send zstd; rupload accepts gzip for these Direct attachment flows.
      'accept-encoding': 'gzip',
      'accept-language': 'en-US',
      priority: 'u=6, i',
      'user-agent': this.userAgent || '',
      'x-fb-client-ip': 'True',
      'x-fb-friendly-name': 'undefined:media-upload',
      'x-fb-http-engine': 'Tigon/MNS/TCP',
      'x-fb-request-analytics-tags':
        '{"network_tags":{"product":"567067343352427","surface":"undefined","request_category":"media_upload","purpose":"none","retry_attempt":"0"}}',
      'x-fb-rmd': 'state=URL_ELIGIBLE',
      'x-fb-server-cluster': 'True',
      'x-tigon-is-retry': 'False',
      'x-ig-salt-ids': '51052545',
    };
    if (rur) headers['ig-u-rur'] = rur;
    if (mid) headers['x-mid'] = mid;
    if (extraHeaders) Object.assign(headers, extraHeaders);
    return headers;
  }

  _messengerSession(this: Client): Session {
    const sess = new Session();
    sess.verify = this.tlsVerify;
    if (this.proxy) sess.proxies = { ...this.private.proxies };
    return sess;
  }

  /** Upload JPEG bytes to messenger_image and return its media_id. */
  async _photoRupload(this: Client, photoBytes: Buffer, entityName: string): Promise<string> {
    const url = `https://rupload.facebook.com/messenger_image/${entityName}`;
    const sess = this._messengerSession();
    try {
      const headers = this._messengerRuploadHeaders({ image_type: 'FILE_ATTACHMENT' });
      Object.assign(headers, {
        'content-type': 'application/octet-stream',
        offset: '0',
        'x-entity-length': String(photoBytes.length),
        'x-entity-name': entityName,
        'x-entity-type': 'image/jpeg',
      });
      const response = await sess.post(url, { data: photoBytes, headers, timeout: 120 });
      if (response.status_code !== 200) throw new ClientError(`messenger_image upload POST failed: ${response.status_code} ${response.text.slice(0, 300)}`);
      try {
        return BigInt(String(response.json().media_id)).toString();
      } catch (exc) {
        throw new ClientError(`messenger_image response missing media_id: ${response.text.slice(0, 300)}`, { cause: exc });
      }
    } finally {
      sess.close();
    }
  }

  /** Resumable upload helper for messenger_video / messenger_audio */
  async _messengerResumableUpload(
    this: Client,
    url: string,
    headers: Record<string, string>,
    bytes: Buffer,
    entityName: string,
    entityType: string,
    kind: string,
    postTimeout: number,
  ): Promise<string> {
    const sess = this._messengerSession();
    try {
      // 1. fetch resumable offset
      let r = await sess.get(url, { headers, timeout: 30 });
      if (r.status_code !== 200) throw new ClientError(`${kind} offset GET failed: ${r.status_code} ${r.text.slice(0, 300)}`);
      let offset = 0;
      try {
        offset = Math.trunc(Number(r.json().offset ?? 0)) || 0;
      } catch {
        offset = 0;
      }
      // 2. POST bytes
      const postHeaders = {
        ...headers,
        'content-type': 'application/octet-stream',
        offset: String(offset),
        'x-entity-length': String(bytes.length),
        'x-entity-name': entityName,
        'x-entity-type': entityType,
      };
      r = await sess.post(url, { data: bytes.subarray(offset), headers: postHeaders, timeout: postTimeout });
      if (r.status_code !== 200) throw new ClientError(`${kind} upload POST failed: ${r.status_code} ${r.text.slice(0, 300)}`);
      try {
        return BigInt(String(r.json().media_id)).toString();
      } catch (exc) {
        throw new ClientError(`${kind} response missing media_id: ${r.text.slice(0, 300)}`, { cause: exc });
      }
    } finally {
      sess.close();
    }
  }

  /** Upload mp4 bytes to rupload.facebook.com/messenger_video/... and return the media_id used as attachment_fbid. */
  async _videoRupload(this: Client, videoBytes: Buffer, entityName: string, waterfallId: string): Promise<string> {
    const url = `https://rupload.facebook.com/messenger_video/${entityName}`;
    const headers = this._messengerRuploadHeaders({
      video_type: 'FILE_ATTACHMENT',
      'segment-start-offset': '0',
      'segment-type': '3',
      ephemeral_media_view_mode: '2',
      ig_raven_metadata: '{}',
      x_fb_video_waterfall_id: waterfallId,
    });
    return this._messengerResumableUpload(url, headers, videoBytes, entityName, 'video/mp4', 'messenger_video', 300);
  }

  /**
   * Send a voice (audio) DM to a list of users or threads.
   * waveform: list of floats (0..1); random when omitted.
   */
  async directSendVoice(this: Client, filePath: string, userIds: IdLike[] = [], threadIds: IdLike[] = [], waveform: number[] | null = null): Promise<DirectMessage> {
    pyAssert(this.userId, 'Login required');
    const uids = _directIdList(userIds);
    let tids = _directIdList(threadIds);
    pyAssert((uids.length || tids.length) && !(uids.length && tids.length), 'Specify user_ids or thread_ids, but not both');
    if (uids.length) tids = [await this._directThreadIdFromUserIds(uids, 'voice')];
    const audioBytes = await fsp.readFile(filePath);
    const uploadId = String(Date.now());
    const randKey = randomInt(-(2 ** 31), 2 ** 31 - 1);
    // Steps 1 + 2: upload to rupload.facebook.com, get media_id.
    const mediaId = await this._voiceRupload(audioBytes, uploadId, randKey);
    // Step 3: broadcast voice_attachment with media_id as attachment_fbid.
    if (waveform === null || waveform === undefined) waveform = Array.from({ length: 70 }, () => Math.round((0.2 + Math.random() * 0.75) * 1000) / 1000);
    const token = this.generateMutationToken();
    const data = {
      action: 'send_item',
      thread_ids: dumps(tids),
      send_attribution: 'inbox',
      client_context: token,
      attachment_fbid: String(mediaId),
      device_id: this.androidDeviceId,
      mutation_token: token,
      _uuid: this.uuid,
      waveform: dumps(waveform.map((w) => pyFloat(w))),
      waveform_sampling_frequency_hz: '10',
      upload_id: uploadId,
      offline_threading_id: token,
    };
    const result = await this.privateRequest('direct_v2/threads/broadcast/voice_attachment/', this.withDefaultData(data), { withSignature: false });
    return extractDirectMessage(result.payload);
  }

  /** Upload audio to rupload.facebook.com and return the media_id used as attachment_fbid. */
  async _voiceRupload(this: Client, audioBytes: Buffer, uploadId: string, randKey: number): Promise<string> {
    const entity = `${uploadId}_0_${randKey}`;
    const url = `https://rupload.facebook.com/messenger_audio/${entity}`;
    const headers = this._messengerRuploadHeaders({ audio_type: 'FILE_ATTACHMENT' });
    return this._messengerResumableUpload(url, headers, audioBytes, entity, 'audio/mp4', 'messenger_audio', 120);
  }

  /** Send a direct file (photo or video) to list of users or threads */
  async directSendFile(this: Client, filePath: string, userIds: IdLike[] = [], threadIds: IdLike[] = [], contentType: DirectMediaType = 'photo'): Promise<DirectMessage> {
    pyAssert(this.userId, 'Login required');
    const uids = _directIdList(userIds);
    const tids = _directIdList(threadIds);
    pyAssert((uids.length || tids.length) && !(uids.length && tids.length), 'Specify user_ids or thread_ids, but not both');
    if (contentType === 'photo') return this.directSendPhoto(filePath, uids, tids);
    if (contentType === 'video') return this.directSendVideo(filePath, uids, tids);
    throw new Error('content_type must be "photo" or "video"');
  }

  /** Send a cutout sticker to list of users or threads */
  async directSendCutoutSticker(this: Client, stickerPk: string, userIds: IdLike[] | null = null, threadIds: IdLike[] | null = null): Promise<DirectMessage> {
    pyAssert(this.userId, 'Login required');
    const uids = _directIdList(userIds);
    const tids = _directIdList(threadIds);
    pyAssert((uids.length || tids.length) && !(uids.length && tids.length), 'Specify user_ids or thread_ids, but not both');
    const token = this.generateMutationToken();
    const data: Record<string, any> = {
      action: 'send_item',
      embedded_ent_type: '101',
      json_params: dumps({ sticker_id: `cutout_photo_${stickerPk}`, embedded_ent_type: 101 }),
      client_context: token,
      mutation_token: token,
      device_id: this.androidDeviceId,
      _uuid: this.uuid,
      offline_threading_id: token,
    };
    if (uids.length) data.recipient_users = dumps([uids]);
    if (tids.length) data.thread_ids = dumps(tids);
    const result = await this.privateRequest('direct_v2/threads/broadcast/generic_share/', this.withDefaultData(data), { withSignature: false });
    return extractDirectMessage(result.payload);
  }

  /** Get a presence of Users */
  async directUsersPresence(this: Client, userIds: IdLike[]): Promise<any> {
    pyAssert(this.userId, 'Login Required');
    const uids = _directIdList(userIds);
    const data = { _uuid: this.uuid, subscriptions_off: 'false', request_data: dumps(uids) };
    const result = await this.privateRequest('direct_v2/fetch_and_subscribe_presence/', this.withDefaultData(data), { withSignature: false });
    pyAssert(result.status === 'ok', `Failed to retrieve presence of user_id=${uids}`);
    return result;
  }

  /** Getting active presences in Direct */
  async directActivePresence(this: Client): Promise<any> {
    const result = await this.privateRequest('direct_v2/get_presence_active_now/', null, { params: { recent_thread_limit: 0, suggested_followers_limit: 100 } });
    pyAssert(result.status === 'ok', 'Failed to retrieve active presences');
    return result.user_presence || {};
  }

  /** Mark direct message as seen */
  async directMessageSeen(this: Client, threadId: IdLike, messageId: IdLike): Promise<boolean> {
    const token = this.generateMutationToken();
    const data = { thread_id: String(threadId), action: 'mark_seen', client_context: token, _uuid: this.uuid, offline_threading_id: token };
    const result = await this.privateRequest(`direct_v2/threads/${threadId}/items/${messageId}/seen/`, data, { withSignature: false });
    return (result.status ?? '') === 'ok';
  }

  /** Mark direct thread as seen */
  async directSendSeen(this: Client, threadId: IdLike): Promise<boolean> {
    const thread = await this.directThread(threadId);
    return this.directMessageSeen(threadId, thread.messages[0].id);
  }

  /** Search threads by query (e.g. username). mode: "raven" | "universal" */
  async directSearch(this: Client, query: string, mode: SEARCH_MODE = 'universal'): Promise<UserShort[]> {
    pyAssert((SEARCH_MODES as readonly string[]).includes(mode), `Unsupported mode="${mode}" ${SEARCH_MODES}`);
    const params = {
      max_ai_bot_results: '0',
      max_ig_bus_results: '10',
      mode,
      show_threads: 'true',
      query: String(query),
      max_ig_results: '10',
      max_ibc_results: '20',
      max_fb_results: '0',
    };
    const result = await this.privateRequest('direct_v2/ranked_recipients/', null, { params });
    return (result.ranked_recipients || [])
      .filter((item: any) => 'user' in item && (item.user || {}).username !== '') // Check to exclude suggestions from FB
      .map((item: any) => extractUserShort(item.user || {}));
  }

  /** Search query mentions in direct messages. Returns [message, thread] pairs */
  async directMessageSearch(this: Client, query: string): Promise<Array<[DirectMessage, DirectShortThread]>> {
    const params = {
      hide_locked_threads: '{"message_content":"false"}',
      offsets: '{"message_content":"0","reshared_content":""}',
      query,
      result_types: '["message_content","reshared_content"]',
    };
    const result = await this.privateRequest('direct_v2/search_secondary/', null, { params });
    pyAssert((result.status ?? '') === 'ok');
    const searchResults = result.message_search_results || {};
    return (searchResults.message_search_result_items || []).map((item: any) => {
      const message = item.matched_message_info || {};
      return [extractDirectMessage(message.item_info || {}), extractDirectShortThread(item.thread || {})] as [DirectMessage, DirectShortThread];
    });
  }

  /** Check whether the account's Direct inbox has upgraded interop messaging. */
  async directHasInteropUpgraded(this: Client): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    return Boolean((await this.privateRequest('direct_v2/has_interop_upgraded/')).has_interop_upgraded);
  }

  /** Search Instagram's generated AI Direct bot suggestions. */
  async directSearchGenAiBots(this: Client, amount = 20): Promise<UserShort[]> {
    pyAssert(this.userId, 'Login required');
    const result = await this.privateRequest('direct_v2/search_gen_ai_bots/', null, { params: { num_ai_bots: String(amount) } });
    return (result.user_search_results || []).filter((i: any) => i.username).map((i: any) => extractUserShort(i));
  }

  /** Get all Direct channels for a user (defaults to the authenticated user). */
  async directChannels(this: Client, userId: IdLike | null = null, threadSubtypes: number[] | null = null): Promise<any[]> {
    pyAssert(this.userId, 'Login required');
    const params = { user_id: String(userId || this.userId), thread_subtypes: dumps(threadSubtypes || [29]) };
    return (await this.privateRequest('direct_v2/get_all_channels/', null, { params })).all_channels_list || [];
  }

  /** Get direct thread by participants */
  async directThreadByParticipants(this: Client, userIds: IdLike[]): Promise<Record<string, any>> {
    const uids = _directIdList(userIds);
    const recipientUsers = dumps(uids);
    const result = await this.privateRequest('direct_v2/threads/get_by_participants/', null, {
      params: { recipient_users: recipientUsers, seq_id: 2580572, limit: 20 },
    });
    const users: UserShort[] = [];
    for (const user of result.users || []) {
      // User dict object also contains fields like follower_count, following_count, mutual_followers_count, media_count
      users.push(
        require('../types').makeUserShort({
          pk: user.pk,
          username: user.username,
          full_name: user.full_name,
          profile_pic_url: user.profile_pic_url,
          is_private: user.is_private,
        }),
      );
    }
    result.users = users;
    return result;
  }

  /** Hide (delete) a thread. moveToSpam: move future requests to spam */
  async directThreadHide(this: Client, threadId: IdLike, moveToSpam = false): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const result = await this.privateRequest(
      `direct_v2/threads/${threadId}/hide/`,
      { should_move_future_requests_to_spam: moveToSpam, _uuid: this.uuid },
      { withSignature: false },
    );
    return (result.status ?? '') === 'ok';
  }

  /** Update a direct thread title */
  async directThreadUpdateTitle(this: Client, threadId: IdLike, title: string): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const result = await this.privateRequest(`direct_v2/threads/${threadId}/update_title/`, { _uuid: this.uuid, title }, { withSignature: false });
    return (result.status ?? '') === 'ok';
  }

  /** Add users to a group Direct thread. */
  async directThreadAddUsers(this: Client, threadId: IdLike, userIds: IdLike[]): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const uids = _directIdList(userIds);
    pyAssert(uids.length, 'At least one user_id required');
    const result = await this.privateRequest(
      `direct_v2/threads/${threadId}/add_user/`,
      { _uuid: this.uuid, user_ids: dumps(uids.map(String)) },
      { withSignature: false },
    );
    return (result.status ?? '') === 'ok';
  }

  /** Set Direct end-to-end encryption eligibility state. */
  async directSetE2eeEligibility(this: Client, e2eeEligibility = 4): Promise<boolean> {
    pyAssert(this.userId, 'Login required');
    const result = await this.privateRequest('direct_v2/set_e2ee_eligibility/', { _uuid: this.uuid, e2ee_eligibility: String(e2eeEligibility) }, { withSignature: false });
    return (result.status ?? '') === 'ok';
  }
  /** Create a group Direct thread (needs at least two recipient user_ids). Returns thread_id */
  async directThreadCreate(this: Client, userIds: IdLike[], title = ''): Promise<string> {
    pyAssert(this.userId, 'Login required');
    const uids = _directIdList(userIds);
    pyAssert(uids.length >= 2, 'Group threads require at least two recipient user_ids');
    const result = await this.privateRequest('direct_v2/create_group_thread/', {
      _uuid: this.uuid,
      _uid: String(this.userId),
      client_context: this.generateMutationToken(),
      is_partnership_folder: 'false',
      recipient_users: dumps(uids),
      thread_title: title,
    });
    const threadId = result.thread_id || (result.thread || {}).thread_id;
    if (!threadId) throw new ClientError('Create group thread response missing thread_id', { ...result });
    return String(threadId);
  }

  /** Share a media to list of users or threads */
  async directMediaShare(
    this: Client,
    mediaId: string,
    userIds: IdLike[] = [],
    threadIds: IdLike[] = [],
    sendAttribute: SEND_ATTRIBUTE_MEDIA = 'feed_timeline',
    mediaType: DirectMediaType = 'photo',
  ): Promise<DirectMessage> {
    pyAssert(this.userId, 'Login required');
    const token = this.generateMutationToken();
    const uids = _directIdList(userIds);
    const tids = _directIdList(threadIds);
    pyAssert((uids.length || tids.length) && !(uids.length && tids.length), 'Specify user_ids or thread_ids, but not both');
    const id = await this.mediaId(mediaId);
    const kwargs: Record<string, any> = {
      action: 'send_item',
      is_shh_mode: '0',
      send_attribution: sendAttribute,
      client_context: token,
      media_id: id,
      device_id: this.androidDeviceId,
      mutation_token: token,
      _uuid: this.uuid,
      btt_dual_send: 'false',
      nav_chain: DEFAULT_NAV_CHAIN,
      is_ae_dual_send: 'false',
      offline_threading_id: token,
    };
    if (uids.length) kwargs.recipient_users = dumps([uids]);
    if (tids.length) kwargs.thread_ids = dumps(tids);
    if (sendAttribute === 'feed_contextual_chain' || sendAttribute === 'feed_short_url') kwargs.inventory_source = 'recommended_explore_grid_cover_model';
    if (sendAttribute === 'feed_timeline') kwargs.inventory_source = 'media_or_ad';
    const result = await this.privateRequest('direct_v2/threads/broadcast/media_share/', this.withDefaultData(kwargs), {
      params: { media_type: mediaType },
      withSignature: false,
    });
    pyAssert((result.status ?? '') === 'ok');
    return extractDirectMessage(result.payload);
  }

  /** Share a story to list of users or threads */
  async directStoryShare(this: Client, storyId: string, userIds: IdLike[] = [], threadIds: IdLike[] = []): Promise<DirectMessage> {
    pyAssert(this.userId, 'Login required');
    const uids = _directIdList(userIds);
    const tids = _directIdList(threadIds);
    pyAssert((uids.length || tids.length) && !(uids.length && tids.length), 'Specify user_ids or thread_ids, but not both');
    const id = await this.mediaId(storyId);
    const storyPk = this.mediaPk(id);
    const token = this.generateMutationToken();
    const data: Record<string, any> = {
      action: 'send_item',
      is_shh_mode: '0',
      send_attribution: 'reel_feed_timeline',
      client_context: token,
      mutation_token: token,
      nav_chain: '1qT:feed_timeline:1,ReelViewerFragment:reel_feed_timeline:4,DirectShareSheetFragment:direct_reshare_sheet:5',
      reel_id: storyPk,
      containermodule: 'reel_feed_timeline',
      story_media_id: id,
      offline_threading_id: token,
    };
    if (uids.length) data.recipient_users = dumps([uids]);
    if (tids.length) data.thread_ids = dumps(tids);
    // params={'story_type': 'video'},
    const result = await this.privateRequest('direct_v2/threads/broadcast/story_share/', this.withDefaultData(data), { withSignature: false });
    return extractDirectMessage(result.payload);
  }

  /** Mark a thread as unread */
  async directThreadMarkUnread(this: Client, threadId: IdLike): Promise<boolean> {
    const data = this.withDefaultData({});
    delete data._uid;
    delete data.device_id;
    const result = await this.privateRequest(`direct_v2/threads/${threadId}/mark_unread/`, data);
    return result.status === 'ok';
  }

  /** Delete a message from thread */
  async directMessageDelete(this: Client, threadId: IdLike, messageId: IdLike): Promise<boolean> {
    const data = this.withDefaultData({});
    delete data._uid;
    delete data.device_id;
    const result = await this.privateRequest(`direct_v2/threads/${threadId}/items/${messageId}/delete/`, data);
    return result.status === 'ok';
  }

  /** Unsend a message from a Direct thread. */
  async directMessageUnsend(this: Client, threadId: IdLike, messageId: IdLike): Promise<boolean> {
    return this.directMessageDelete(threadId, messageId);
  }

  /** Mute the thread (revert=true to unmute) */
  async directThreadMute(this: Client, threadId: IdLike, revert = false): Promise<boolean> {
    const name = revert ? 'unmute' : 'mute';
    const result = await this.privateRequest(`direct_v2/threads/${threadId}/${name}/`, { _uuid: this.uuid });
    return result.status === 'ok';
  }

  /** Unmute the thread */
  async directThreadUnmute(this: Client, threadId: IdLike): Promise<boolean> {
    return this.directThreadMute(threadId, true);
  }

  /** Mute video call for the thread (revert=true to unmute) */
  async directThreadMuteVideoCall(this: Client, threadId: IdLike, revert = false): Promise<boolean> {
    const name = revert ? 'unmute_video_call' : 'mute_video_call';
    const result = await this.privateRequest(`direct_v2/threads/${threadId}/${name}/`, { _uuid: this.uuid });
    return result.status === 'ok';
  }

  /** Unmute video call for the thread */
  async directThreadUnmuteVideoCall(this: Client, threadId: IdLike): Promise<boolean> {
    return this.directThreadMuteVideoCall(threadId, true);
  }

  /** Share a profile to list of users or threads */
  async directProfileShare(this: Client, userId: IdLike, userIds: IdLike[] = [], threadIds: IdLike[] = []): Promise<DirectMessage> {
    pyAssert(this.userId, 'Login required');
    const uids = _directIdList(userIds);
    const tids = _directIdList(threadIds);
    pyAssert((uids.length || tids.length) && !(uids.length && tids.length), 'Specify user_ids or thread_ids, but not both');
    const token = this.generateMutationToken();
    const kwargs: Record<string, any> = {
      profile_user_id: userId,
      action: 'send_item',
      is_shh_mode: '0',
      send_attribution: 'profile',
      client_context: token,
      device_id: this.androidDeviceId,
      mutation_token: token,
      _uuid: this.uuid,
      btt_dual_send: 'false',
      nav_chain: DEFAULT_NAV_CHAIN,
      is_ae_dual_send: 'false',
      offline_threading_id: token,
    };
    if (uids.length) kwargs.recipient_users = dumps([uids]);
    if (tids.length) kwargs.thread_ids = dumps(tids);
    const result = await this.privateRequest('direct_v2/threads/broadcast/profile/', this.withDefaultData(kwargs), { withSignature: false });
    pyAssert((result.status ?? '') === 'ok');
    return extractDirectMessage(result.payload);
  }

  /** Get all the media from a thread */
  async directMedia(this: Client, threadId: IdLike, amount = 20): Promise<DirectMedia[]> {
    pyAssert(this.userId, 'Login required');
    const params: Record<string, any> = { ...this._directRequestTrackingParams(), limit: 20, media_type: 'media_shares' };
    let maxTimestamp: any = null;
    let items: DirectMedia[] = [];
    while (true) {
      if (maxTimestamp) params.max_timestamp = maxTimestamp;
      let result: any;
      try {
        result = await this.privateRequest(`direct_v2/threads/${threadId}/media/`, null, { params });
      } catch (e) {
        if (e instanceof ClientNotFoundError) throw new DirectThreadNotFound(e, { ...this.lastJson, thread_id: threadId });
        throw e;
      }
      for (const item of result.items) {
        items.push(extractDirectMedia(item.media));
        maxTimestamp = item.timestamp ?? null;
      }
      if (!result.more_available || (amount && items.length >= amount)) break;
    }
    if (amount) items = items.slice(0, amount);
    return items;
  }
}
