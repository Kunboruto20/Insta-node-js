import {
  About, Account, Broadcast, Collection, Comment, DirectMedia, DirectMessage, DirectResponse, DirectShortThread,
  DirectThread, Guide, Hashtag, Highlight, Location, Media, MediaOembed, MediaXma, ReplyMessage, Resource, Story,
  StoryArchiveDay, StoryLink, StoryMedia, StoryMention, StoryPoll, Track, User, UserShort, Usertag, Viewer,
  makeAbout, makeAccount, makeBroadcast, makeCollection, makeComment, makeDirectMedia, makeDirectMessage,
  makeDirectResponse, makeDirectShortThread, makeDirectThread, makeGuide, makeHashtag, makeHighlight, makeLocation,
  makeMedia, makeMediaOembed, makeMediaXma, makeReplyMessage, makeResource, makeStory, makeStoryArchiveDay,
  makeStoryHashtag, makeStoryLink, makeStoryLocation, makeStoryMedia, makeStoryMention, makeStoryPoll, makeTrack,
  makeUser, makeUserShort, makeUsertag, makeViewer,
} from './types';
import { InstagramIdCodec } from './utils/ids';
import { deepcopy, htmlUnescape, jsonValue, pyJsonDumps, pyRepr } from './utils/serialization';
import { pyAssert } from './utils/validation';

export const MEDIA_TYPES_GQL: Record<string, number> = { GraphImage: 1, GraphVideo: 2, GraphSidecar: 8, StoryVideo: 2 };
export const XDT_MEDIA_TYPES_GQL: Record<string, string> = {
  XDTGraphImage: 'GraphImage',
  XDTGraphVideo: 'GraphVideo',
  XDTGraphSidecar: 'GraphSidecar',
};

type Dict = Record<string, any>;

function has(o: any, k: string): boolean {
  return o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
}
/** dict.get(k, default) */
function get(o: any, k: string, def: any = null): any {
  return has(o, k) ? o[k] : def;
}
function truthy(v: any): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object' && !(v instanceof Date)) return Object.keys(v).length > 0;
  return true;
}
/** sorted(items, key=...)[-1] */
function maxBy<T>(items: T[], key: (o: T) => number): T {
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  if (!sorted.length) throw new RangeError('list index out of range');
  return sorted[sorted.length - 1];
}
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function _normalizeMediaGqlTypename(data: Dict): void {
  data.__typename = XDT_MEDIA_TYPES_GQL[data.__typename] ?? get(data, '__typename');
}

/** Extract media from Private API */
export function extractMediaV1(data: Dict): Media {
  const media = deepcopy(data);
  if (get(media, 'crosspost') === null) media.crosspost = [];
  if (truthy(media.video_versions)) {
    // Select Best Quality by Resolutiuon
    media.video_url = maxBy(media.video_versions, (o: any) => o.height * o.width).url;
  }
  if (media.media_type === 2 && !media.product_type) media.product_type = 'feed';
  if (has(media, 'image_versions2')) {
    media.thumbnail_url = maxBy(media.image_versions2.candidates, (o: any) => o.height * o.width).url;
    const scrubber = media.image_versions2.scrubber_spritesheet_info_candidates || {};
    if (truthy(scrubber.default) && !truthy(scrubber.default.sprite_urls)) {
      delete media.image_versions2.scrubber_spritesheet_info_candidates;
    }
  }
  if (media.media_type === 8) {
    // remove thumbnail_url and video_url for albums
    // see resources
    delete media.thumbnail_url;
    delete media.video_url;
  }
  const location = get(media, 'location');
  media.location = truthy(location) ? extractLocation(location) : location;
  media.user = extractUserShort(get(media, 'user'));
  const usertags = media.usertags || {};
  media.usertags = (get(usertags, 'in', []) as any[]).map(extractUsertag).sort((a, b) => cmpStr(a.user.pk, b.user.pk));
  media.like_count = get(media, 'like_count', 0);
  media.has_liked = get(media, 'has_liked', false);
  media.sponsor_tags = (media.sponsor_tags || []).map((tag: any) => extractUserShort(tag.sponsor));
  media.view_count = get(media, 'view_count', get(media, 'video_view_count', 0));
  media.play_count = get(media, 'play_count', get(media, 'video_play_count', 0));
  if (get(media, 'coauthor_producers') === null) media.coauthor_producers = [];
  media.coauthor_producers = (get(media, 'coauthor_producers', []) as any[]).map((u) => extractUserShort(u));
  return makeMedia({
    ...media,
    caption_text: get(media.caption || {}, 'text', ''),
    resources: (media.carousel_media || []).map((edge: any) => extractResourceV1(edge)),
  });
}

/** Extract media from Private API (XMA) */
export function extractMediaV1Xma(data: Dict): MediaXma | null {
  const media = deepcopy(data);
  if (!media.target_url) return null;
  // media["media_type"] = 10
  media.video_url = media.target_url;
  media.title = get(media, 'title_text', '');
  media.preview_url = get(media, 'preview_url', '');
  media.preview_url_mime_type = get(media, 'preview_url_mime_type', '');
  media.header_icon_url = media.header_icon_url || null;
  media.header_icon_width = get(media, 'header_icon_width', 0);
  media.header_icon_height = get(media, 'header_icon_height', 0);
  media.header_title_text = get(media, 'header_title_text', '');
  media.preview_media_fbid = get(media, 'preview_media_fbid', '');
  return makeMediaXma(media);
}

/** Extract media from GraphQL */
export function extractMediaGql(data: Dict): Media {
  const media = deepcopy(data);
  _normalizeMediaGqlTypename(media);
  const user = extractUserShort(media.owner);
  media.media_type = has(MEDIA_TYPES_GQL, media.__typename) ? MEDIA_TYPES_GQL[media.__typename] : 0;
  if (media.media_type === 2 && !media.product_type) media.product_type = 'feed';
  // display_resources - user feed, thumbnail_resources - hashtag feed
  const sortedResources = [...(get(media, 'display_resources', get(media, 'thumbnail_resources', [])) as any[])].sort(
    (a, b) => a.config_width * a.config_height - b.config_width * b.config_height,
  );
  if (sortedResources.length) media.thumbnail_url = sortedResources[sortedResources.length - 1].src;
  else if (has(media, 'thumbnail_src')) media.thumbnail_url = media.thumbnail_src;
  if (media.media_type === 8) {
    delete media.thumbnail_url;
    delete media.video_url;
  }
  const location = get(media, 'location');
  delete media.location;
  const mediaId = get(media, 'id');
  media.pk = mediaId;
  media.id = `${mediaId}_${user.pk}`;
  return makeMedia({
    ...media,
    code: get(media, 'shortcode'),
    taken_at: get(media, 'taken_at_timestamp'),
    location: truthy(location) ? extractLocation(location) : null,
    user,
    view_count: get(media, 'video_view_count', 0),
    play_count: get(media, 'play_count', get(media, 'video_play_count')),
    has_liked: get(media, 'has_liked', get(media, 'viewer_has_liked')),
    comment_count: jsonValue(media, 'edge_media_to_comment', 'count', {
      default: jsonValue(media, 'edge_media_preview_comment', 'count', { default: 0 }),
    }),
    like_count: jsonValue(media, 'edge_media_preview_like', 'count') ?? null,
    caption_text: jsonValue(media, 'edge_media_to_caption', 'edges', 0, 'node', 'text', { default: '' }),
    usertags: (get(get(media, 'edge_media_to_tagged_user', {}), 'edges', []) as any[])
      .map((u) => extractUsertag(u.node))
      .sort((a, b) => cmpStr(a.user.pk, b.user.pk)),
    resources: (get(get(media, 'edge_sidecar_to_children', {}), 'edges', []) as any[]).map((edge) => extractResourceGql(edge.node)),
    sponsor_tags: (get(get(media, 'edge_media_to_sponsor_user', {}), 'edges', []) as any[]).map((edge) => extractUserShort(edge.node.sponsor)),
    comments_preview: extractMediaCommentsPreviewGql(media.edge_media_to_parent_comment || media.edge_media_preview_comment),
    hoisted_comments: (get(get(media, 'edge_media_to_hoisted_comment', {}), 'edges', []) as any[]).map((edge) =>
      extractMediaInlineCommentGql(edge.node),
    ),
  });
}

export function extractMediaCommentsPreviewGql(data: Dict | null | undefined): Dict | null {
  if (!truthy(data)) return null;
  const pageInfo = data!.page_info || {};
  return {
    count: get(data, 'count', 0),
    has_next_page: get(pageInfo, 'has_next_page', false),
    end_cursor: get(pageInfo, 'end_cursor'),
    comments: (get(data, 'edges', []) as any[]).map((edge) => extractMediaInlineCommentGql(edge.node)),
  };
}

export function extractMediaInlineCommentGql(data: Dict, repliedToCommentId: string | null = null): Dict {
  const comment = deepcopy(data);
  comment.pk = String(get(comment, 'id'));
  comment.user = extractUserShort(get(comment, 'owner'));
  comment.created_at_utc = get(comment, 'created_at');
  comment.has_liked = get(comment, 'has_liked', get(comment, 'viewer_has_liked'));
  comment.like_count = jsonValue(comment, 'edge_liked_by', 'count') ?? null;
  if (repliedToCommentId !== null && repliedToCommentId !== undefined) comment.replied_to_comment_id = String(repliedToCommentId);
  const threaded = comment.edge_threaded_comments || {};
  comment.replies_count = get(threaded, 'count', 0);
  comment.replies = (get(threaded, 'edges', []) as any[]).map((edge) => extractMediaInlineCommentGql(edge.node, comment.pk));
  return comment;
}

export function extractResourceV1(data: Dict): Resource {
  data = deepcopy(data);
  if (truthy(data.video_versions)) data.video_url = maxBy(data.video_versions, (o: any) => o.height * o.width).url;
  const candidates: any[] = get(get(data, 'image_versions2', {}), 'candidates', []);
  data.thumbnail_url = candidates.length ? maxBy(candidates, (o: any) => o.height * o.width).url : null;
  const usertags = data.usertags || {};
  data.usertags = (get(usertags, 'in', []) as any[]).map(extractUsertag).sort((a, b) => cmpStr(a.user.pk, b.user.pk));
  return makeResource(data);
}

export function extractResourceGql(data: Dict): Resource {
  data = deepcopy(data);
  _normalizeMediaGqlTypename(data);
  if (!has(MEDIA_TYPES_GQL, data.__typename)) throw new Error(`KeyError: ${data.__typename}`);
  data.media_type = MEDIA_TYPES_GQL[data.__typename];
  return makeResource({ ...data, pk: data.id, thumbnail_url: data.display_url });
}

/** Extract user tag */
export function extractUsertag(data: Dict): Usertag {
  const [x, y] = get(data, 'position', [get(data, 'x'), get(data, 'y')]);
  return makeUsertag({ user: extractUserShort(data.user), x, y });
}

/** Extract User Short info (mutates `data` like the python version) */
export function extractUserShort(data: Dict): UserShort {
  data.pk = get(data, 'id', get(data, 'pk', null));
  pyAssert(truthy(data.pk), `User without pk "${pyRepr(data)}"`);
  if (!has(data, 'latest_reel_media') && has(data, '1llatest_reel_media')) data.latest_reel_media = data['1llatest_reel_media'];
  const fs = get(data, 'friendship_status');
  if (fs && typeof fs === 'object' && !Array.isArray(fs)) {
    const defaults: Dict = {
      user_id: String(data.pk),
      following: false,
      incoming_request: false,
      is_bestie: false,
      is_feed_favorite: false,
      is_private: false,
      is_restricted: false,
      outgoing_request: false,
    };
    for (const [k, v] of Object.entries(defaults)) if (!has(fs, k)) fs[k] = v;
  }
  return makeUserShort(data);
}

/** Extract Viewer info */
export function extractViewer(data: Dict): Viewer {
  const user = data.user;
  delete data.user;
  user.pk = get(user, 'id', get(user, 'pk', null));
  pyAssert(truthy(user.pk), `User without pk "${pyRepr(user)}"`);
  return makeViewer({ ...user, ...data });
}

/** Extract broadcast channel infos */
export function extractBroadcastChannel(data: Dict): Broadcast[] {
  const channels: any[] = get(get(data, 'pinned_channels_info', {}), 'pinned_channels_list', []);
  return channels.map((c) => makeBroadcast(c));
}

/** For Public GraphQL API */
export function extractUserGql(data: Dict): User {
  data.broadcast_channel = extractBroadcastChannel(data);
  return makeUser({
    ...data,
    pk: data.id,
    media_count: data.edge_owner_to_timeline_media.count,
    follower_count: data.edge_followed_by.count,
    following_count: data.edge_follow.count,
    is_business: data.is_business_account,
    public_email: data.business_email,
    contact_phone_number: data.business_phone_number,
  });
}

/** For Private API */
export function extractUserV1(data: Dict): User {
  data.broadcast_channel = extractBroadcastChannel(data);
  data.external_url = data.external_url || null;
  data.public_email = data.public_email || get(data, 'business_email');
  data.contact_phone_number = data.contact_phone_number || get(data, 'business_phone_number');
  const versions = get(data, 'hd_profile_pic_versions');
  const picHd = truthy(versions) ? versions[versions.length - 1] : get(data, 'hd_profile_pic_url_info', {});
  data.profile_pic_url_hd = get(picHd, 'url');
  return makeUser(data);
}

/** Extract location info */
export function extractLocation(data: Dict | null | undefined): Location | null {
  if (!truthy(data)) return null;
  let d = data as Dict;
  if (has(d, 'place') && d.place && typeof d.place === 'object' && !Array.isArray(d.place)) {
    const placeLocation = get(d.place, 'location');
    if (truthy(placeLocation)) d = placeLocation;
  }
  d.pk = get(d, 'id', get(d, 'pk', get(d, 'location_id', null)));
  const externalId = d.external_id || get(d, 'facebook_places_id');
  if (externalId === null || externalId === undefined || externalId === '' || externalId === 'None') d.external_id = null;
  else d.external_id = BigInt(String(externalId).trim()).toString();
  d.external_id_source = get(d, 'external_id_source', get(d, 'external_source'));
  d.address = get(d, 'address', get(d, 'location_address'));
  d.city = get(d, 'city', get(d, 'location_city'));
  d.zip = get(d, 'zip', get(d, 'location_zip'));
  const addressJson = get(d, 'address_json', '{}');
  if (typeof addressJson === 'string') {
    const address = JSON.parse(addressJson);
    if (address && typeof address === 'object' && !Array.isArray(address) && Object.keys(address).length) {
      d.address = get(address, 'street_address');
      d.city = get(address, 'city_name');
      d.zip = get(address, 'zip_code');
    }
  }
  return makeLocation(d);
}

/** Extract comment */
export function extractComment(data: Dict): Comment {
  data.has_liked = get(data, 'has_liked_comment');
  data.like_count = get(data, 'comment_like_count');
  return makeComment(data);
}

/**
 * Extract collection for authorized account
 * Example: {'collection_id': '17851406186124602', 'collection_name': 'Repost', 'collection_type': 'MEDIA', ...}
 */
export function extractCollection(data: Dict): Collection {
  const out: Dict = {};
  for (const [key, val] of Object.entries(data)) out[key.split('collection_').join('')] = val;
  return makeCollection(out);
}

/** Return short version of Media */
export function extractMediaOembed(data: Dict): MediaOembed {
  return makeMediaOembed(data);
}

export function _directTimestampFromMicroseconds(timestamp: any): Date {
  const seconds = BigInt(String(timestamp).trim().split('.')[0]) / 1000000n;
  return new Date(Number(seconds) * 1000);
}

export function extractDirectThread(data: Dict): DirectThread {
  data.pk = get(data, 'thread_v2_id');
  data.id = get(data, 'thread_id');
  data.messages = [];
  for (const item of data.items) {
    item.thread_id = data.id;
    data.messages.push(extractDirectMessage(item));
  }
  data.users = data.users.map((u: any) => extractUserShort(u));
  const inviter = get(data, 'inviter');
  data.inviter = truthy(inviter) ? extractUserShort(inviter) : null;
  data.left_users = (get(data, 'left_users', []) as any[]).map((u) => extractUserShort(u));
  if (!has(data, 'is_close_friend_thread')) data.is_close_friend_thread = false;
  data.last_activity_at = _directTimestampFromMicroseconds(data.last_activity_at);
  // Convert last_seen_at timestamps
  const lastSeenAt = get(data, 'last_seen_at', {});
  for (const seenInfo of Object.values(lastSeenAt || {}) as any[]) {
    if (has(seenInfo, 'timestamp')) seenInfo.timestamp = _directTimestampFromMicroseconds(seenInfo.timestamp);
    if (has(seenInfo, 'created_at')) seenInfo.created_at = _directTimestampFromMicroseconds(seenInfo.created_at);
    // Convert disappearing messages seen state timestamps
    const ds = get(seenInfo, 'disappearing_messages_seen_state');
    if (truthy(ds)) {
      if (has(ds, 'timestamp')) ds.timestamp = _directTimestampFromMicroseconds(ds.timestamp);
      if (has(ds, 'created_at')) ds.created_at = _directTimestampFromMicroseconds(ds.created_at);
    }
  }
  return makeDirectThread(data);
}

export function extractDirectShortThread(data: Dict): DirectShortThread {
  data.users = data.users.map((u: any) => extractUserShort(u));
  data.id = get(data, 'thread_id');
  return makeDirectShortThread(data);
}

export function extractDirectResponse(data: Dict): DirectResponse {
  return makeDirectResponse(data);
}

function _preserveDirectRawXma(data: Dict): void {
  const rawXma: Dict = {};
  for (const key of ['xma_clip', 'xma_media_share', 'xma_story_share', 'xma_profile', 'generic_xma']) {
    if (truthy(get(data, key))) rawXma[key] = deepcopy(data[key]);
  }
  if (Object.keys(rawXma).length) data.raw_xma = rawXma;
}

function _convertDirectVisualMediaTimestamps(visualMedia: Dict | null | undefined): void {
  if (!truthy(visualMedia)) return;
  const vm = visualMedia as Dict;
  if (has(vm, 'media') && truthy(vm.media)) {
    const media = vm.media;
    if (has(media, 'expiring_media_action_summary') && truthy(media.expiring_media_action_summary)) {
      media.expiring_media_action_summary.timestamp = _directTimestampFromMicroseconds(media.expiring_media_action_summary.timestamp);
    }
    if (has(media, 'image_versions2') && truthy(media.image_versions2)) {
      for (const candidate of get(media.image_versions2, 'candidates', []) as any[]) {
        if (has(candidate, 'url_expiration_timestamp_us') && truthy(candidate.url_expiration_timestamp_us)) {
          candidate.url_expiration_timestamp_us = _directTimestampFromMicroseconds(candidate.url_expiration_timestamp_us);
        }
      }
    }
    if (has(media, 'video_versions') && truthy(media.video_versions)) {
      for (const vv of media.video_versions) {
        if (has(vv, 'url_expiration_timestamp_us') && truthy(vv.url_expiration_timestamp_us)) {
          vv.url_expiration_timestamp_us = _directTimestampFromMicroseconds(vv.url_expiration_timestamp_us);
        }
      }
    }
  }
  if (has(vm, 'expiring_media_action_summary') && truthy(vm.expiring_media_action_summary)) {
    vm.expiring_media_action_summary.timestamp = _directTimestampFromMicroseconds(vm.expiring_media_action_summary.timestamp);
  }
}

export function extractReplyMessage(data: Dict): ReplyMessage {
  data.id = get(data, 'item_id');
  _preserveDirectRawXma(data);
  if (has(data, 'media_share')) {
    const ms = data.media_share;
    if (!ms.code) ms.code = InstagramIdCodec.encode(String(ms.id).split('_')[0]);
    data.media_share = extractMediaV1(ms);
  }
  if (has(data, 'media')) data.media = extractDirectMedia(data.media);
  let clip = get(data, 'clip', {});
  if (truthy(clip)) {
    if (has(clip, 'clip')) clip = clip.clip; // Instagram ¯\_(ツ)_/¯
    data.clip = extractMediaV1(clip);
  }
  const genericXma = get(data, 'generic_xma', []);
  if (truthy(genericXma)) data.generic_xma = genericXma.map((i: any) => extractMediaV1Xma(i)).filter((i: any) => i);
  const visualMedia = get(data, 'visual_media', {});
  if (truthy(visualMedia)) _convertDirectVisualMediaTimestamps(visualMedia);
  data.timestamp = _directTimestampFromMicroseconds(data.timestamp);
  data.user_id = pyStr(data.user_id);
  return makeReplyMessage(data);
}

function pyStr(v: any): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

export function extractDirectMessage(data: Dict): DirectMessage {
  data.id = get(data, 'item_id');
  _preserveDirectRawXma(data);
  if (has(data, 'replied_to_message')) data.reply = extractReplyMessage(data.replied_to_message);
  if (has(data, 'media_share')) {
    const ms = data.media_share;
    if (!ms.code) ms.code = InstagramIdCodec.encode(String(ms.id).split('_')[0]);
    data.media_share = extractMediaV1(ms);
  }
  if (has(data, 'media')) data.media = extractDirectMedia(data.media);
  if (has(data, 'voice_media') && has(data.voice_media, 'media')) data.media = extractDirectMedia(data.voice_media.media);
  let clip = get(data, 'clip', {});
  if (truthy(clip)) {
    if (has(clip, 'clip')) clip = clip.clip; // Instagram ¯\_(ツ)_/¯
    data.clip = extractMediaV1(clip);
  }
  // Handle xma_clip (new Instagram API format for clip/reel shares)
  const xmaClip = get(data, 'xma_clip', {});
  if (truthy(xmaClip)) {
    const xmaShare = extractMediaV1Xma(xmaClip[0]);
    if (xmaShare) data.xma_share = xmaShare;
  }
  // Handle xma_media_share (only if xma_share not already set above by xma_clip)
  if (!has(data, 'xma_share') || data.xma_share === null) {
    const xmaMediaShare = get(data, 'xma_media_share', {});
    if (truthy(xmaMediaShare)) {
      const xmaShare = extractMediaV1Xma(xmaMediaShare[0]);
      if (xmaShare) data.xma_share = xmaShare;
    }
  }
  const genericXma = get(data, 'generic_xma', []);
  if (truthy(genericXma)) data.generic_xma = genericXma.map((i: any) => extractMediaV1Xma(i)).filter((i: any) => i);
  // Convert main timestamp
  data.timestamp = _directTimestampFromMicroseconds(data.timestamp);
  data.user_id = pyStr(get(data, 'user_id', ''));
  data.client_context = get(data, 'client_context', '');
  // Convert reaction timestamps
  const reactions = get(data, 'reactions', {});
  if (truthy(reactions) && has(reactions, 'emojis')) {
    for (const emoji of reactions.emojis) {
      if (has(emoji, 'timestamp')) emoji.timestamp = _directTimestampFromMicroseconds(emoji.timestamp);
    }
  }
  // Convert visual media timestamps
  const visualMedia = get(data, 'visual_media', {});
  if (truthy(visualMedia)) _convertDirectVisualMediaTimestamps(visualMedia);
  return makeDirectMessage(data);
}

export function extractDirectMedia(data: Dict): DirectMedia {
  const media = deepcopy(data);
  if (truthy(media.video_versions)) media.video_url = maxBy(media.video_versions, (o: any) => o.height * o.width).url;
  if (has(media, 'image_versions2')) media.thumbnail_url = maxBy(media.image_versions2.candidates, (o: any) => o.height * o.width).url;
  if (has(media, 'user')) media.user = extractUserShort(media.user);
  if (has(media, 'audio')) media.audio_url = get(media.audio, 'audio_src');
  return makeDirectMedia(media);
}

export function extractAccount(data: Dict): Account {
  data.pk = String(data.pk);
  data.external_url = data.external_url || null;
  return makeAccount(data);
}

export function extractHashtagGql(data: Dict): Hashtag {
  data.media_count = get(get(data, 'edge_hashtag_to_media', {}), 'count');
  data.profile_pic_url = data.profile_pic_url || null;
  return makeHashtag(data);
}

export function extractHashtagV1(data: Dict): Hashtag {
  data.allow_following = get(data, 'allow_following') === 1;
  data.profile_pic_url = data.profile_pic_url || null;
  return makeHashtag(data);
}

export function extractStoryWeb(data: Dict): Story {
  const story = deepcopy(data);
  if (get(story, 'pk') === null) throw new Error('KeyError: pk');
  const user = get(story, 'user');
  if (!user || typeof user !== 'object' || Array.isArray(user) || (get(user, 'pk') === null && get(user, 'id') === null)) {
    throw new Error('KeyError: user.pk');
  }
  for (const field of ['story_locations', 'story_hashtags', 'story_cta', 'sponsor_tags', 'story_feed_media', 'story_link_stickers']) {
    if (get(story, field) === null) story[field] = [];
  }
  for (const feedMedia of story.story_feed_media) {
    if (has(feedMedia, 'media_id')) continue;
    if (feedMedia.media_code) feedMedia.media_id = InstagramIdCodec.decode(feedMedia.media_code);
    else if (get(feedMedia, 'id') !== null) feedMedia.media_id = String(feedMedia.id).split('_')[0];
  }
  const versions: any[] = story.video_versions || [];
  if (versions.length && versions.some((c) => !has(c, 'height') || !has(c, 'width'))) {
    story.video_url = versions.find((c) => c.url)?.url ?? null;
    delete story.video_versions;
  }
  return extractStoryV1(story);
}

/** Extract story from Private API */
export function extractStoryV1(data: Dict): Story {
  const story = deepcopy(data);
  story.pk = pyStr(get(story, 'pk'));
  if (truthy(story.video_versions)) story.video_url = maxBy(story.video_versions, (o: any) => o.height * o.width).url;
  if (story.media_type === 2 && !story.product_type) story.product_type = 'story';
  if (has(story, 'image_versions2')) story.thumbnail_url = maxBy(story.image_versions2.candidates, (o: any) => o.height * o.width).url;
  story.mentions = (get(story, 'reel_mentions', []) as any[]).map((m) => makeStoryMention(m));
  story.locations = (get(story, 'story_locations', []) as any[]).map((l) => makeStoryLocation(l));
  story.hashtags = (get(story, 'story_hashtags', []) as any[]).map((h) => makeStoryHashtag(h));
  story.stickers = data.story_link_stickers || [];
  story.polls = [] as StoryPoll[];
  for (const poll of story.story_polls || []) {
    const ps = poll.poll_sticker || poll;
    const tallies: any[] = ps.tallies || [];
    const options = tallies.filter((i) => get(i, 'text') !== null).map((i) => i.text);
    story.polls.push(
      makeStoryPoll({
        id: ps.poll_id || get(ps, 'id'),
        type: poll.type || ps.type || 'poll',
        x: get(poll, 'x', get(ps, 'x', 0.5)),
        y: get(poll, 'y', get(ps, 'y', 0.5)),
        z: get(poll, 'z', get(ps, 'z', 0)),
        width: get(poll, 'width', get(ps, 'width', 0.0)),
        height: get(poll, 'height', get(ps, 'height', 0.0)),
        rotation: get(poll, 'rotation', get(ps, 'rotation', 0.0)),
        is_multi_option: get(ps, 'is_multi_option', get(ps, 'is_multi_option_poll', true)),
        is_shared_result: get(ps, 'is_shared_result', false),
        viewer_can_vote: get(ps, 'viewer_can_vote', true),
        finished: get(ps, 'finished', false),
        color: get(ps, 'color', 'black'),
        poll_type: get(ps, 'poll_type', ''),
        question: get(ps, 'question', ''),
        options: options.length ? options : ps.options || [],
        extra: ps,
      }),
    );
  }
  const feedMedias: StoryMedia[] = [];
  for (const feedMedia of data.story_feed_media || []) {
    feedMedia.media_pk = BigInt(String(feedMedia.media_id).trim()).toString();
    feedMedias.push(makeStoryMedia(feedMedia));
  }
  story.medias = feedMedias;
  story.links = [] as StoryLink[];
  for (const sticker of get(story, 'story_link_stickers', []) as any[]) {
    const storyLink = sticker.story_link || {};
    const url = get(storyLink, 'url');
    if (url) story.links.push(makeStoryLink({ webUri: url }));
  }
  for (const cta of get(story, 'story_cta', []) as any[]) {
    for (const link of get(cta, 'links', []) as any[]) story.links.push(makeStoryLink(link));
  }
  story.user = extractUserShort(get(story, 'user'));
  story.sponsor_tags = (get(story, 'sponsor_tags', []) as any[]).map((tag) => extractUserShort(tag.sponsor));
  story.is_paid_partnership = get(story, 'is_paid_partnership');
  if (!story.code) story.code = InstagramIdCodec.encode(story.pk);
  if (!story.taken_at) story.taken_at = story.device_timestamp || get(story, 'taken_at_timestamp');
  return makeStory(story);
}

/** Extract story archive day from Private API */
export function extractStoryArchiveDay(data: Dict): StoryArchiveDay {
  return makeStoryArchiveDay(deepcopy(data));
}

/** Extract story from Public API */
export function extractStoryGql(data: Dict): Story {
  const story = deepcopy(data);
  if (has(story, 'video_resources')) {
    story.video_url = maxBy(story.video_resources, (o: any) => o.config_height * o.config_width).src;
  }
  story.product_type = 'story';
  story.thumbnail_url = get(story, 'display_url');
  story.mentions = [] as StoryMention[];
  story.medias = [] as StoryMedia[];
  for (const item of get(story, 'tappable_objects', []) as any[]) {
    if (item.__typename === 'GraphTappableMention') {
      item.id = 1;
      item.user = extractUserShort(item);
      story.mentions.push(makeStoryMention(item));
    }
    if (item.__typename === 'GraphTappableFeedMedia') {
      const media = get(item, 'media');
      if (truthy(media)) {
        item.media_pk = BigInt(String(media.id)).toString();
        item.media_code = media.shortcode;
      }
      story.medias.push(makeStoryMedia(item));
    }
  }
  story.locations = [];
  story.hashtags = [];
  story.stickers = [];
  story.links = [];
  const storyCtaUrl = get(story, 'story_cta_url', []);
  if (truthy(storyCtaUrl)) story.links = [makeStoryLink({ webUri: storyCtaUrl })];
  story.user = extractUserShort(get(story, 'owner'));
  story.pk = String(story.id);
  story.id = `${story.id}_${story.owner.id}`;
  story.code = InstagramIdCodec.encode(story.pk);
  story.taken_at = story.taken_at_timestamp;
  story.media_type = story.is_video ? 2 : 1;
  story.sponsor_tags = (get(get(story, 'edge_media_to_sponsor_user', {}), 'edges', []) as any[]).map((edge) =>
    extractUserShort(edge.node.sponsor),
  );
  return makeStory(story);
}

export function extractHighlightV1(data: Dict): Highlight {
  const highlight = deepcopy(data);
  highlight.pk = String(highlight.id).split(':')[1];
  if (highlight.user && typeof highlight.user === 'object' && !Array.isArray(highlight.user)) highlight.user = extractUserShort(highlight.user);
  highlight.items = (get(highlight, 'items', []) as any[]).map((i) => extractStoryV1(i));
  return makeHighlight(highlight);
}

export function extractGuideV1(data: Dict): Guide {
  const item = deepcopy(data.summary || {});
  item.cover_media = extractMediaV1(item.cover_media);
  return makeGuide(item);
}

export function extractTrack(data: Dict): Track {
  data.cover_artwork_uri = data.cover_artwork_uri || null;
  data.cover_artwork_thumbnail_uri = data.cover_artwork_thumbnail_uri || null;
  const items = Array.from(String(data.dash_manifest).matchAll(/<BaseURL>(.+?)<\/BaseURL>/g), (m) => m[1]);
  data.uri = items.length ? htmlUnescape(items[0]) : null;
  data.territory_validity_periods = data.territory_validity_periods || {};
  return makeTrack(data);
}

function _extractAboutLispy(c: string, data: Dict): About {
  const params: Dict = {};
  const parts = String(c).split('"');
  if (parts.length > 1) params.country = parts[1];
  const sp = pyRepr(data).split('space_evenly');
  if (sp.length > 1) {
    const s = sp[1].split('stretch');
    try {
      params.username = idx(idx(idx(idx(s, 1).split('center'), 1).split(": '"), 1).split("',"), 0);
    } catch {
      /* IndexError */
    }
    try {
      params.date = idx(idx(idx(s, 4).split('&'), 1).split("'"), 2);
    } catch {
      /* IndexError */
    }
  }
  return makeAbout(params);
}

function idx<T>(arr: T[], i: number): T {
  if (i >= arr.length) throw new RangeError('IndexError');
  return arr[i];
}

export function extractAboutV1(data: Dict): About {
  const c = jsonValue(data, 'layout', 'bloks_payload', 'data', 0, 'data');
  const params: Dict = {};
  if (truthy(c)) {
    if (typeof c === 'object' && 'initial_lispy' in c) return _extractAboutLispy(c.initial_lispy, data);
    params.country = c.initial;
  }
  let dateFinded = false;
  const dumped = pyJsonDumps(data);
  params.is_verified = dumped.includes('"Verified"');
  const ddata = dumped.split('")":');
  ddata.forEach((v, i) => {
    if (v.includes('"bold"}')) params.username = v.trim().split(',')[0].slice(1, -1);
    if (dateFinded) params.date = v.trim().split(',')[0].slice(1, -1);
    if (v.includes('Former usernames')) params.former_usernames = idx(ddata, i + 2).trim().split(',')[0].slice(1, -1);
    dateFinded = v.includes('"Date joined"');
  });
  return makeAbout(params);
}
