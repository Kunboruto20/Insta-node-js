/* Data models (port of instagrapi.types, pydantic models).
 *
 * Each model has a TypeScript interface and a runtime schema used by `parseModel`,
 * which reproduces pydantic's lax-mode coercion: numbers → strings for `str` fields,
 * numeric strings → numbers, unix timestamps / ISO strings → Date, URL validation,
 * required fields and defaults. Integer identifiers are kept as strings because they
 * can exceed Number.MAX_SAFE_INTEGER.
 */
import { ModelSchema, ModelValidationError, parseModel } from './models/validator';
export { ModelValidationError, parseModel } from './models/validator';
export type { ModelSchema } from './models/validator';

export type StoryResizeMode = "fill" | "fit";

export interface Resource {
  pk: string;
  video_url: string | null;
  thumbnail_url: string | null;
  media_type: number;
  usertags: Array<Usertag>;
}
export const ResourceSchema: ModelSchema = {
  name: "Resource",
  fields: {
    pk: { type: 'str' },
    video_url: { type: 'url', optional: true, default: () => (null) },
    thumbnail_url: { type: 'url', optional: true, default: () => (null) },
    media_type: { type: 'int' },
    usertags: { type: { list: () => UsertagSchema }, default: () => ([]) },
  },
};
export function makeResource(data: Record<string, any>): Resource {
  return parseModel<Resource>(ResourceSchema, data);
}

export interface BioLink {
  link_id: string | null;
  url: string;
  lynx_url: string | null;
  link_type: string | null;
  title: string | null;
  is_pinned: boolean | null;
  open_external_url_with_in_app_browser: boolean | null;
}
export const BioLinkSchema: ModelSchema = {
  name: "BioLink",
  fields: {
    link_id: { type: 'str', optional: true, default: () => (null) },
    url: { type: 'str' },
    lynx_url: { type: 'str', optional: true, default: () => (null) },
    link_type: { type: 'str', optional: true, default: () => (null) },
    title: { type: 'str', optional: true, default: () => (null) },
    is_pinned: { type: 'bool', optional: true, default: () => (null) },
    open_external_url_with_in_app_browser: { type: 'bool', optional: true, default: () => (null) },
  },
};
export function makeBioLink(data: Record<string, any>): BioLink {
  return parseModel<BioLink>(BioLinkSchema, data);
}

export interface Broadcast {
  title: string;
  thread_igid: string;
  subtitle: string;
  invite_link: string;
  is_member: boolean;
  group_image_uri: string;
  group_image_background_uri: string;
  thread_subtype: number;
  number_of_members: number;
  creator_igid: string | null;
  creator_username: string;
}
export const BroadcastSchema: ModelSchema = {
  name: "Broadcast",
  fields: {
    title: { type: 'str' },
    thread_igid: { type: 'str' },
    subtitle: { type: 'str' },
    invite_link: { type: 'str' },
    is_member: { type: 'bool' },
    group_image_uri: { type: 'str' },
    group_image_background_uri: { type: 'str' },
    thread_subtype: { type: 'int' },
    number_of_members: { type: 'int' },
    creator_igid: { type: 'str', optional: true, default: () => (null) },
    creator_username: { type: 'str' },
  },
};
export function makeBroadcast(data: Record<string, any>): Broadcast {
  return parseModel<Broadcast>(BroadcastSchema, data);
}

export interface User {
  pk: string;
  username: string;
  full_name: string;
  is_private: boolean;
  profile_pic_url: string;
  profile_pic_url_hd: string | null;
  is_verified: boolean;
  media_count: number;
  follower_count: number;
  following_count: number;
  biography: string | null;
  bio_links: Array<BioLink>;
  external_url: string | null;
  show_text_post_app_badge: boolean | null;
  text_post_app_badge_label: string | null;
  account_type: number | null;
  is_business: boolean;
  broadcast_channel: Array<Broadcast>;
  public_email: string | null;
  contact_phone_number: string | null;
  public_phone_country_code: string | null;
  public_phone_number: string | null;
  business_contact_method: string | null;
  business_category_name: string | null;
  category_name: string | null;
  category: string | null;
  address_street: string | null;
  city_id: string | null;
  city_name: string | null;
  latitude: number | null;
  longitude: number | null;
  zip: string | null;
  instagram_location_id: string | null;
  interop_messaging_user_fbid: string | null;
}
export const UserSchema: ModelSchema = {
  name: "User",
  fields: {
    pk: { type: 'str' },
    username: { type: 'str' },
    full_name: { type: 'str' },
    is_private: { type: 'bool' },
    profile_pic_url: { type: 'url' },
    profile_pic_url_hd: { type: 'url', optional: true, default: () => (null) },
    is_verified: { type: 'bool' },
    media_count: { type: 'int' },
    follower_count: { type: 'int' },
    following_count: { type: 'int' },
    biography: { type: 'str', optional: true, default: () => ("") },
    bio_links: { type: { list: () => BioLinkSchema }, default: () => ([]) },
    external_url: { type: 'str', optional: true, default: () => (null) },
    show_text_post_app_badge: { type: 'bool', optional: true, default: () => (null) },
    text_post_app_badge_label: { type: 'str', optional: true, default: () => (null) },
    account_type: { type: 'int', optional: true, default: () => (null) },
    is_business: { type: 'bool' },
    broadcast_channel: { type: { list: () => BroadcastSchema }, default: () => ([]) },
    public_email: { type: 'str', optional: true, default: () => (null) },
    contact_phone_number: { type: 'str', optional: true, default: () => (null) },
    public_phone_country_code: { type: 'str', optional: true, default: () => (null) },
    public_phone_number: { type: 'str', optional: true, default: () => (null) },
    business_contact_method: { type: 'str', optional: true, default: () => (null) },
    business_category_name: { type: 'str', optional: true, default: () => (null) },
    category_name: { type: 'str', optional: true, default: () => (null) },
    category: { type: 'str', optional: true, default: () => (null) },
    address_street: { type: 'str', optional: true, default: () => (null) },
    city_id: { type: 'str', optional: true, default: () => (null) },
    city_name: { type: 'str', optional: true, default: () => (null) },
    latitude: { type: 'float', optional: true, default: () => (null) },
    longitude: { type: 'float', optional: true, default: () => (null) },
    zip: { type: 'str', optional: true, default: () => (null) },
    instagram_location_id: { type: 'str', optional: true, default: () => (null) },
    interop_messaging_user_fbid: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeUser(data: Record<string, any>): User {
  return parseModel<User>(UserSchema, data);
}

export interface About {
  username: string | null;
  is_verified: boolean | null;
  country: string | null;
  date: string | null;
  former_usernames: string | null;
}
export const AboutSchema: ModelSchema = {
  name: "About",
  fields: {
    username: { type: 'str', optional: true, default: () => ("") },
    is_verified: { type: 'bool', optional: true, default: () => (false) },
    country: { type: 'str', optional: true, default: () => ("") },
    date: { type: 'str', optional: true, default: () => ("") },
    former_usernames: { type: 'str', optional: true, default: () => ("") },
  },
};
export function makeAbout(data: Record<string, any>): About {
  return parseModel<About>(AboutSchema, data);
}

export interface AddressBookPhone {
  phone_number: string;
}
export const AddressBookPhoneSchema: ModelSchema = {
  name: "AddressBookPhone",
  fields: {
    phone_number: { type: 'str' },
  },
};
export function makeAddressBookPhone(data: Record<string, any>): AddressBookPhone {
  return parseModel<AddressBookPhone>(AddressBookPhoneSchema, data);
}

export interface AddressBookEmail {
  email_address: string;
}
export const AddressBookEmailSchema: ModelSchema = {
  name: "AddressBookEmail",
  fields: {
    email_address: { type: 'str' },
  },
};
export function makeAddressBookEmail(data: Record<string, any>): AddressBookEmail {
  return parseModel<AddressBookEmail>(AddressBookEmailSchema, data);
}

export interface AddressBookContact {
  phone_numbers: Array<AddressBookPhone>;
  email_addresses: Array<AddressBookEmail>;
  first_name: string;
  last_name: string;
}
export const AddressBookContactSchema: ModelSchema = {
  name: "AddressBookContact",
  fields: {
    phone_numbers: { type: { list: () => AddressBookPhoneSchema }, default: () => ([]) },
    email_addresses: { type: { list: () => AddressBookEmailSchema }, default: () => ([]) },
    first_name: { type: 'str', default: () => ("") },
    last_name: { type: 'str', default: () => ("") },
  },
};
export function makeAddressBookContact(data: Record<string, any>): AddressBookContact {
  return parseModel<AddressBookContact>(AddressBookContactSchema, data);
}

export interface Account {
  pk: string;
  username: string;
  full_name: string;
  is_private: boolean;
  profile_pic_url: string;
  is_verified: boolean;
  biography: string | null;
  external_url: string | null;
  is_business: boolean;
  birthday: string | null;
  phone_number: string | null;
  gender: number | null;
  email: string | null;
}
export const AccountSchema: ModelSchema = {
  name: "Account",
  fields: {
    pk: { type: 'str' },
    username: { type: 'str' },
    full_name: { type: 'str' },
    is_private: { type: 'bool' },
    profile_pic_url: { type: 'url' },
    is_verified: { type: 'bool' },
    biography: { type: 'str', optional: true, default: () => ("") },
    external_url: { type: 'str', optional: true, default: () => (null) },
    is_business: { type: 'bool' },
    birthday: { type: 'str', optional: true, default: () => (null) },
    phone_number: { type: 'str', optional: true, default: () => (null) },
    gender: { type: 'int', optional: true, default: () => (null) },
    email: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeAccount(data: Record<string, any>): Account {
  return parseModel<Account>(AccountSchema, data);
}

export interface RelationshipShort {
  user_id: string;
  following: boolean;
  incoming_request: boolean;
  is_bestie: boolean;
  is_feed_favorite: boolean;
  is_private: boolean;
  is_restricted: boolean;
  outgoing_request: boolean;
}
export const RelationshipShortSchema: ModelSchema = {
  name: "RelationshipShort",
  fields: {
    user_id: { type: 'str' },
    following: { type: 'bool' },
    incoming_request: { type: 'bool' },
    is_bestie: { type: 'bool' },
    is_feed_favorite: { type: 'bool' },
    is_private: { type: 'bool' },
    is_restricted: { type: 'bool' },
    outgoing_request: { type: 'bool' },
  },
};
export function makeRelationshipShort(data: Record<string, any>): RelationshipShort {
  return parseModel<RelationshipShort>(RelationshipShortSchema, data);
}

export interface UserShort {
  pk: string;
  username: string | null;
  full_name: string | null;
  profile_pic_url: string | null;
  profile_pic_url_hd: string | null;
  is_private: boolean | null;
  stories: any[];
  is_verified: boolean | null;
  latest_reel_media: number | null;
  has_anonymous_profile_picture: boolean | null;
  profile_pic_id: string | null;
  fbid_v2: string | null;
  interop_messaging_user_fbid: string | null;
  strong_id__: string | null;
  account_badges: Array<Record<string, any>>;
  friendship_status: RelationshipShort | null;
}
export const UserShortSchema: ModelSchema = {
  name: "UserShort",
  fields: {
    pk: { type: 'str' },
    username: { type: 'str', optional: true, default: () => (null) },
    full_name: { type: 'str', optional: true, default: () => ("") },
    profile_pic_url: { type: 'url', optional: true, default: () => (null) },
    profile_pic_url_hd: { type: 'url', optional: true, default: () => (null) },
    is_private: { type: 'bool', optional: true, default: () => (null) },
    stories: { type: { list: 'any' }, default: () => ([]) },
    is_verified: { type: 'bool', optional: true, default: () => (null) },
    latest_reel_media: { type: 'int', optional: true, default: () => (null) },
    has_anonymous_profile_picture: { type: 'bool', optional: true, default: () => (null) },
    profile_pic_id: { type: 'str', optional: true, default: () => (null) },
    fbid_v2: { type: 'str', optional: true, default: () => (null) },
    interop_messaging_user_fbid: { type: 'str', optional: true, default: () => (null) },
    strong_id__: { type: 'str', optional: true, default: () => (null) },
    account_badges: { type: { list: 'dict' }, default: () => ([]) },
    friendship_status: { type: () => RelationshipShortSchema, optional: true, default: () => (null) },
  },
};
export function makeUserShort(data: Record<string, any>): UserShort {
  return parseModel<UserShort>(UserShortSchema, data);
}

export interface Viewer extends UserShort {
  has_liked: boolean;
  reply_text: string;
  is_spam_viewer: boolean;
}
export const ViewerSchema: ModelSchema = {
  name: "Viewer",
  base: () => UserShortSchema,
  fields: {
    has_liked: { type: 'bool', default: () => (false) },
    reply_text: { type: 'str', default: () => ("") },
    is_spam_viewer: { type: 'bool', default: () => (false) },
  },
};
export function makeViewer(data: Record<string, any>): Viewer {
  return parseModel<Viewer>(ViewerSchema, data);
}

export interface Usertag {
  user: UserShort;
  x: number;
  y: number;
}
export const UsertagSchema: ModelSchema = {
  name: "Usertag",
  fields: {
    user: { type: () => UserShortSchema },
    x: { type: 'float' },
    y: { type: 'float' },
  },
};
export function makeUsertag(data: Record<string, any>): Usertag {
  return parseModel<Usertag>(UsertagSchema, data);
}

export interface Location {
  pk: string | null;
  name: string;
  phone: string | null;
  website: string | null;
  category: string | null;
  hours: Record<string, any> | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  lng: number | null;
  lat: number | null;
  external_id: string | null;
  external_id_source: string | null;
}
export const LocationSchema: ModelSchema = {
  name: "Location",
  fields: {
    pk: { type: 'idint', optional: true, default: () => (null) },
    name: { type: 'str' },
    phone: { type: 'str', optional: true, default: () => ("") },
    website: { type: 'str', optional: true, default: () => ("") },
    category: { type: 'str', optional: true, default: () => ("") },
    hours: { type: 'dict', optional: true, default: () => ({}) },
    address: { type: 'str', optional: true, default: () => ("") },
    city: { type: 'str', optional: true, default: () => ("") },
    zip: { type: 'str', optional: true, default: () => ("") },
    lng: { type: 'float', optional: true, default: () => (null) },
    lat: { type: 'float', optional: true, default: () => (null) },
    external_id: { type: 'idint', optional: true, default: () => (null) },
    external_id_source: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeLocation(data: Record<string, any>): Location {
  return parseModel<Location>(LocationSchema, data);
}

/** Image candidate for shared media clips with video features */
export interface SharedMediaImageCandidate {
  estimated_scans_sizes: Array<number>;
  height: number;
  scans_profile: string | null;
  url: string;
  width: number;
  is_spatial_image: boolean | null;
}
export const SharedMediaImageCandidateSchema: ModelSchema = {
  name: "SharedMediaImageCandidate",
  fields: {
    estimated_scans_sizes: { type: { list: 'int' }, default: () => ([]) },
    height: { type: 'int' },
    scans_profile: { type: 'str', optional: true, default: () => (null) },
    url: { type: 'str' },
    width: { type: 'int' },
    is_spatial_image: { type: 'bool', optional: true, default: () => (null) },
  },
};
export function makeSharedMediaImageCandidate(data: Record<string, any>): SharedMediaImageCandidate {
  return parseModel<SharedMediaImageCandidate>(SharedMediaImageCandidateSchema, data);
}

/** Spritesheet information for video scrubbing */
export interface ScrubberSpritesheetInfo {
  file_size_kb: number;
  max_thumbnails_per_sprite: number;
  rendered_width: number;
  sprite_height: number;
  sprite_urls: Array<string>;
  sprite_width: number;
  thumbnail_duration: number;
  thumbnail_height: number;
  thumbnail_width: number;
  thumbnails_per_row: number;
  total_thumbnail_num_per_sprite: number;
  video_length: number;
}
export const ScrubberSpritesheetInfoSchema: ModelSchema = {
  name: "ScrubberSpritesheetInfo",
  fields: {
    file_size_kb: { type: 'int' },
    max_thumbnails_per_sprite: { type: 'int' },
    rendered_width: { type: 'int' },
    sprite_height: { type: 'int' },
    sprite_urls: { type: { list: 'str' } },
    sprite_width: { type: 'int' },
    thumbnail_duration: { type: 'float' },
    thumbnail_height: { type: 'int' },
    thumbnail_width: { type: 'int' },
    thumbnails_per_row: { type: 'int' },
    total_thumbnail_num_per_sprite: { type: 'int' },
    video_length: { type: 'float' },
  },
};
export function makeScrubberSpritesheetInfo(data: Record<string, any>): ScrubberSpritesheetInfo {
  return parseModel<ScrubberSpritesheetInfo>(ScrubberSpritesheetInfoSchema, data);
}

/** Container for spritesheet information candidates */
export interface ScrubberSpritesheetInfoCandidates {
  default: ScrubberSpritesheetInfo;
}
export const ScrubberSpritesheetInfoCandidatesSchema: ModelSchema = {
  name: "ScrubberSpritesheetInfoCandidates",
  fields: {
    default: { type: () => ScrubberSpritesheetInfoSchema },
  },
};
export function makeScrubberSpritesheetInfoCandidates(data: Record<string, any>): ScrubberSpritesheetInfoCandidates {
  return parseModel<ScrubberSpritesheetInfoCandidates>(ScrubberSpritesheetInfoCandidatesSchema, data);
}

/** Additional candidates structure in image_versions2 */
export interface AdditionalCandidates {
  first_frame: SharedMediaImageCandidate | null;
  igtv_first_frame: SharedMediaImageCandidate | null;
  smart_frame: SharedMediaImageCandidate | null;
}
export const AdditionalCandidatesSchema: ModelSchema = {
  name: "AdditionalCandidates",
  fields: {
    first_frame: { type: () => SharedMediaImageCandidateSchema, optional: true, default: () => (null) },
    igtv_first_frame: { type: () => SharedMediaImageCandidateSchema, optional: true, default: () => (null) },
    smart_frame: { type: () => SharedMediaImageCandidateSchema, optional: true, default: () => (null) },
  },
};
export function makeAdditionalCandidates(data: Record<string, any>): AdditionalCandidates {
  return parseModel<AdditionalCandidates>(AdditionalCandidatesSchema, data);
}

/** Complete image_versions2 structure for shared media clips */
export interface SharedMediaImageVersions {
  additional_candidates: AdditionalCandidates | null;
  candidates: Array<SharedMediaImageCandidate>;
  scrubber_spritesheet_info_candidates: ScrubberSpritesheetInfoCandidates | null;
}
export const SharedMediaImageVersionsSchema: ModelSchema = {
  name: "SharedMediaImageVersions",
  fields: {
    additional_candidates: { type: () => AdditionalCandidatesSchema, optional: true, default: () => (null) },
    candidates: { type: { list: () => SharedMediaImageCandidateSchema }, default: () => ([]) },
    scrubber_spritesheet_info_candidates: { type: () => ScrubberSpritesheetInfoCandidatesSchema, optional: true, default: () => (null) },
  },
};
export function makeSharedMediaImageVersions(data: Record<string, any>): SharedMediaImageVersions {
  return parseModel<SharedMediaImageVersions>(SharedMediaImageVersionsSchema, data);
}

/** Information about achievements in clips */
export interface ClipsAchievementsInfo {
  num_earned_achievements: number | null;
  show_achievements: boolean;
}
export const ClipsAchievementsInfoSchema: ModelSchema = {
  name: "ClipsAchievementsInfo",
  fields: {
    num_earned_achievements: { type: 'int', optional: true, default: () => (null) },
    show_achievements: { type: 'bool', default: () => (false) },
  },
};
export function makeClipsAchievementsInfo(data: Record<string, any>): ClipsAchievementsInfo {
  return parseModel<ClipsAchievementsInfo>(ClipsAchievementsInfoSchema, data);
}

/** Audio reattribution settings */
export interface AudioReattributionInfo {
  should_allow_restore: boolean;
}
export const AudioReattributionInfoSchema: ModelSchema = {
  name: "AudioReattributionInfo",
  fields: {
    should_allow_restore: { type: 'bool', default: () => (false) },
  },
};
export function makeAudioReattributionInfo(data: Record<string, any>): AudioReattributionInfo {
  return parseModel<AudioReattributionInfo>(AudioReattributionInfoSchema, data);
}

/** Additional audio information for clips */
export interface ClipsAdditionalAudioInfo {
  additional_audio_username: string | null;
  audio_reattribution_info: AudioReattributionInfo;
}
export const ClipsAdditionalAudioInfoSchema: ModelSchema = {
  name: "ClipsAdditionalAudioInfo",
  fields: {
    additional_audio_username: { type: 'str', optional: true, default: () => (null) },
    audio_reattribution_info: { type: () => AudioReattributionInfoSchema },
  },
};
export function makeClipsAdditionalAudioInfo(data: Record<string, any>): ClipsAdditionalAudioInfo {
  return parseModel<ClipsAdditionalAudioInfo>(ClipsAdditionalAudioInfoSchema, data);
}

/** Audio ranking information for clips */
export interface ClipsAudioRankingInfo {
  best_audio_cluster_id: string;
}
export const ClipsAudioRankingInfoSchema: ModelSchema = {
  name: "ClipsAudioRankingInfo",
  fields: {
    best_audio_cluster_id: { type: 'str' },
  },
};
export function makeClipsAudioRankingInfo(data: Record<string, any>): ClipsAudioRankingInfo {
  return parseModel<ClipsAudioRankingInfo>(ClipsAudioRankingInfoSchema, data);
}

/** Branded content tag information for clips */
export interface ClipsBrandedContentTagInfo {
  can_add_tag: boolean;
}
export const ClipsBrandedContentTagInfoSchema: ModelSchema = {
  name: "ClipsBrandedContentTagInfo",
  fields: {
    can_add_tag: { type: 'bool', default: () => (false) },
  },
};
export function makeClipsBrandedContentTagInfo(data: Record<string, any>): ClipsBrandedContentTagInfo {
  return parseModel<ClipsBrandedContentTagInfo>(ClipsBrandedContentTagInfoSchema, data);
}

/** Content appreciation information for clips */
export interface ClipsContentAppreciationInfo {
  enabled: boolean;
  entry_point_container: string | null;
}
export const ClipsContentAppreciationInfoSchema: ModelSchema = {
  name: "ClipsContentAppreciationInfo",
  fields: {
    enabled: { type: 'bool', default: () => (false) },
    entry_point_container: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeClipsContentAppreciationInfo(data: Record<string, any>): ClipsContentAppreciationInfo {
  return parseModel<ClipsContentAppreciationInfo>(ClipsContentAppreciationInfoSchema, data);
}

/** Mashup information for clips */
export interface ClipsMashupInfo {
  can_toggle_mashups_allowed: boolean;
  formatted_mashups_count: string | null;
  has_been_mashed_up: boolean;
  has_nonmimicable_additional_audio: boolean;
  is_creator_requesting_mashup: boolean;
  is_light_weight_check: boolean;
  is_light_weight_reuse_allowed_check: boolean;
  is_pivot_page_available: boolean;
  is_reuse_allowed: boolean;
  mashup_type: string | null;
  mashups_allowed: boolean;
  non_privacy_filtered_mashups_media_count: number;
  privacy_filtered_mashups_media_count: number | null;
  original_media: Record<string, any> | null;
}
export const ClipsMashupInfoSchema: ModelSchema = {
  name: "ClipsMashupInfo",
  fields: {
    can_toggle_mashups_allowed: { type: 'bool', default: () => (false) },
    formatted_mashups_count: { type: 'str', optional: true, default: () => (null) },
    has_been_mashed_up: { type: 'bool', default: () => (false) },
    has_nonmimicable_additional_audio: { type: 'bool', default: () => (false) },
    is_creator_requesting_mashup: { type: 'bool', default: () => (false) },
    is_light_weight_check: { type: 'bool', default: () => (true) },
    is_light_weight_reuse_allowed_check: { type: 'bool', default: () => (false) },
    is_pivot_page_available: { type: 'bool', default: () => (false) },
    is_reuse_allowed: { type: 'bool', default: () => (true) },
    mashup_type: { type: 'str', optional: true, default: () => (null) },
    mashups_allowed: { type: 'bool', default: () => (true) },
    non_privacy_filtered_mashups_media_count: { type: 'int', default: () => (0) },
    privacy_filtered_mashups_media_count: { type: 'int', optional: true, default: () => (null) },
    original_media: { type: 'dict', optional: true, default: () => (null) },
  },
};
export function makeClipsMashupInfo(data: Record<string, any>): ClipsMashupInfo {
  return parseModel<ClipsMashupInfo>(ClipsMashupInfoSchema, data);
}

/** Consumption information for clips original sound */
export interface ClipsConsumptionInfo {
  display_media_id: string | null;
  is_bookmarked: boolean;
  is_trending_in_clips: boolean;
  should_mute_audio_reason: string;
  should_mute_audio_reason_type: string | null;
  user_notes: string | null;
}
export const ClipsConsumptionInfoSchema: ModelSchema = {
  name: "ClipsConsumptionInfo",
  fields: {
    display_media_id: { type: 'str', optional: true, default: () => (null) },
    is_bookmarked: { type: 'bool', default: () => (false) },
    is_trending_in_clips: { type: 'bool', default: () => (false) },
    should_mute_audio_reason: { type: 'str', default: () => ("") },
    should_mute_audio_reason_type: { type: 'str', optional: true, default: () => (null) },
    user_notes: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeClipsConsumptionInfo(data: Record<string, any>): ClipsConsumptionInfo {
  return parseModel<ClipsConsumptionInfo>(ClipsConsumptionInfoSchema, data);
}

/** Facebook downstream use xpost metadata for clips */
export interface ClipsFbDownstreamUseXpostMetadata {
  downstream_use_xpost_deny_reason: string;
}
export const ClipsFbDownstreamUseXpostMetadataSchema: ModelSchema = {
  name: "ClipsFbDownstreamUseXpostMetadata",
  fields: {
    downstream_use_xpost_deny_reason: { type: 'str', default: () => ("NONE") },
  },
};
export function makeClipsFbDownstreamUseXpostMetadata(data: Record<string, any>): ClipsFbDownstreamUseXpostMetadata {
  return parseModel<ClipsFbDownstreamUseXpostMetadata>(ClipsFbDownstreamUseXpostMetadataSchema, data);
}

/** Instagram artist information for clips original sound */
export interface ClipsIgArtist {
  pk: string;
  pk_id: string;
  id: string;
  username: string;
  full_name: string;
  is_private: boolean;
  is_verified: boolean;
  profile_pic_id: string | null;
  profile_pic_url: string;
  strong_id__: string;
}
export const ClipsIgArtistSchema: ModelSchema = {
  name: "ClipsIgArtist",
  fields: {
    pk: { type: 'idint' },
    pk_id: { type: 'str' },
    id: { type: 'str' },
    username: { type: 'str' },
    full_name: { type: 'str' },
    is_private: { type: 'bool', default: () => (false) },
    is_verified: { type: 'bool', default: () => (false) },
    profile_pic_id: { type: 'str', optional: true, default: () => (null) },
    profile_pic_url: { type: 'str' },
    strong_id__: { type: 'str' },
  },
};
export function makeClipsIgArtist(data: Record<string, any>): ClipsIgArtist {
  return parseModel<ClipsIgArtist>(ClipsIgArtistSchema, data);
}

/** Original sound information for clips */
export interface ClipsOriginalSoundInfo {
  allow_creator_to_rename: boolean;
  audio_asset_id: string;
  attributed_custom_audio_asset_id: string | null;
  can_remix_be_shared_to_fb: boolean;
  can_remix_be_shared_to_fb_expansion: boolean;
  dash_manifest: string;
  duration_in_ms: number;
  formatted_clips_media_count: string | null;
  hide_remixing: boolean;
  is_audio_automatically_attributed: boolean;
  is_eligible_for_audio_effects: boolean;
  is_eligible_for_vinyl_sticker: boolean;
  is_explicit: boolean;
  is_original_audio_download_eligible: boolean;
  is_reuse_disabled: boolean;
  is_xpost_from_fb: boolean;
  music_canonical_id: string | null;
  oa_owner_is_music_artist: boolean;
  original_audio_subtype: string;
  original_audio_title: string;
  original_media_id: string;
  progressive_download_url: string;
  should_mute_audio: boolean;
  time_created: number;
  trend_rank: number | null;
  previous_trend_rank: number | null;
  overlap_duration_in_ms: number | null;
  audio_asset_start_time_in_ms: number | null;
  ig_artist: ClipsIgArtist;
  audio_filter_infos: Array<Record<string, any>> | null;
  audio_parts: Array<Record<string, any>>;
  audio_parts_by_filter: Array<Record<string, any>>;
  consumption_info: ClipsConsumptionInfo;
  xpost_fb_creator_info: Record<string, any> | null;
  fb_downstream_use_xpost_metadata: ClipsFbDownstreamUseXpostMetadata;
}
export const ClipsOriginalSoundInfoSchema: ModelSchema = {
  name: "ClipsOriginalSoundInfo",
  fields: {
    allow_creator_to_rename: { type: 'bool', default: () => (true) },
    audio_asset_id: { type: 'idint' },
    attributed_custom_audio_asset_id: { type: 'idint', optional: true, default: () => (null) },
    can_remix_be_shared_to_fb: { type: 'bool', default: () => (true) },
    can_remix_be_shared_to_fb_expansion: { type: 'bool', default: () => (true) },
    dash_manifest: { type: 'str' },
    duration_in_ms: { type: 'int' },
    formatted_clips_media_count: { type: 'str', optional: true, default: () => (null) },
    hide_remixing: { type: 'bool', default: () => (false) },
    is_audio_automatically_attributed: { type: 'bool', default: () => (false) },
    is_eligible_for_audio_effects: { type: 'bool', default: () => (true) },
    is_eligible_for_vinyl_sticker: { type: 'bool', default: () => (true) },
    is_explicit: { type: 'bool', default: () => (false) },
    is_original_audio_download_eligible: { type: 'bool', default: () => (true) },
    is_reuse_disabled: { type: 'bool', default: () => (false) },
    is_xpost_from_fb: { type: 'bool', default: () => (false) },
    music_canonical_id: { type: 'str', optional: true, default: () => (null) },
    oa_owner_is_music_artist: { type: 'bool', default: () => (false) },
    original_audio_subtype: { type: 'str', default: () => ("default") },
    original_audio_title: { type: 'str', default: () => ("Original audio") },
    original_media_id: { type: 'idint' },
    progressive_download_url: { type: 'str' },
    should_mute_audio: { type: 'bool', default: () => (false) },
    time_created: { type: 'int' },
    trend_rank: { type: 'int', optional: true, default: () => (null) },
    previous_trend_rank: { type: 'int', optional: true, default: () => (null) },
    overlap_duration_in_ms: { type: 'int', optional: true, default: () => (null) },
    audio_asset_start_time_in_ms: { type: 'int', optional: true, default: () => (null) },
    ig_artist: { type: () => ClipsIgArtistSchema },
    audio_filter_infos: { type: { list: 'dict' }, optional: true, default: () => (null) },
    audio_parts: { type: { list: 'dict' }, default: () => ([]) },
    audio_parts_by_filter: { type: { list: 'dict' }, default: () => ([]) },
    consumption_info: { type: () => ClipsConsumptionInfoSchema },
    xpost_fb_creator_info: { type: 'dict', optional: true, default: () => (null) },
    fb_downstream_use_xpost_metadata: { type: () => ClipsFbDownstreamUseXpostMetadataSchema },
  },
};
export function makeClipsOriginalSoundInfo(data: Record<string, any>): ClipsOriginalSoundInfo {
  return parseModel<ClipsOriginalSoundInfo>(ClipsOriginalSoundInfoSchema, data);
}

/** Color information for reusable text in clips */
export interface ClipsReusableTextColor {
  count: number;
  hex_rgba_color: string;
}
export const ClipsReusableTextColorSchema: ModelSchema = {
  name: "ClipsReusableTextColor",
  fields: {
    count: { type: 'int' },
    hex_rgba_color: { type: 'str' },
  },
};
export function makeClipsReusableTextColor(data: Record<string, any>): ClipsReusableTextColor {
  return parseModel<ClipsReusableTextColor>(ClipsReusableTextColorSchema, data);
}

/** Reusable text information for clips */
export interface ClipsReusableTextInfo {
  alignment: string;
  end_time_ms: number;
  font_size: number;
  height: number;
  id: string;
  is_animated: boolean;
  offset_x: number;
  offset_y: number;
  rotation_degree: number;
  scale: number;
  start_time_ms: number;
  text: string;
  text_emphasis_mode: string;
  text_format_type: string;
  width: number;
  z_index: number;
  effects: string;
  animation: string;
  colors: Array<ClipsReusableTextColor>;
}
export const ClipsReusableTextInfoSchema: ModelSchema = {
  name: "ClipsReusableTextInfo",
  fields: {
    alignment: { type: 'str' },
    end_time_ms: { type: 'float' },
    font_size: { type: 'float' },
    height: { type: 'float' },
    id: { type: 'str' },
    is_animated: { type: 'bool' },
    offset_x: { type: 'float' },
    offset_y: { type: 'float' },
    rotation_degree: { type: 'float' },
    scale: { type: 'float' },
    start_time_ms: { type: 'float' },
    text: { type: 'str' },
    text_emphasis_mode: { type: 'str' },
    text_format_type: { type: 'str' },
    width: { type: 'float' },
    z_index: { type: 'int' },
    effects: { type: 'str', default: () => ("") },
    animation: { type: 'str', default: () => ("") },
    colors: { type: { list: () => ClipsReusableTextColorSchema }, default: () => ([]) },
  },
};
export function makeClipsReusableTextInfo(data: Record<string, any>): ClipsReusableTextInfo {
  return parseModel<ClipsReusableTextInfo>(ClipsReusableTextInfoSchema, data);
}

/** Complete clips metadata structure for Media objects */
export interface ClipsMetadata {
  clips_creation_entry_point: string;
  featured_label: string | null;
  is_public_chat_welcome_video: boolean;
  professional_clips_upsell_type: number;
  show_tips: string | null;
  achievements_info: ClipsAchievementsInfo;
  additional_audio_info: ClipsAdditionalAudioInfo;
  asset_recommendation_info: Record<string, any> | null;
  audio_ranking_info: ClipsAudioRankingInfo;
  audio_type: string;
  branded_content_tag_info: ClipsBrandedContentTagInfo;
  breaking_content_info: Record<string, any> | null;
  breaking_creator_info: Record<string, any> | null;
  challenge_info: Record<string, any> | null;
  content_appreciation_info: ClipsContentAppreciationInfo;
  contextual_highlight_info: Record<string, any> | null;
  cutout_sticker_info: Array<Record<string, any>>;
  disable_use_in_clips_client_cache: boolean;
  external_media_info: Record<string, any> | null;
  is_fan_club_promo_video: boolean;
  is_shared_to_fb: boolean | null;
  mashup_info: ClipsMashupInfo | null;
  merchandising_pill_info: Record<string, any> | null;
  music_canonical_id: string;
  music_info: Record<string, any> | null;
  nux_info: Record<string, any> | null;
  original_sound_info: ClipsOriginalSoundInfo | null;
  originality_info: Record<string, any> | null;
  reels_on_the_rise_info: Record<string, any> | null;
  reusable_text_attribute_string: string | null;
  reusable_text_info: Array<ClipsReusableTextInfo> | null;
  shopping_info: Record<string, any> | null;
  show_achievements: boolean;
  template_info: Record<string, any> | null;
  may_have_template_info: Record<string, any> | null;
  viewer_interaction_settings: Record<string, any> | null;
}
export const ClipsMetadataSchema: ModelSchema = {
  name: "ClipsMetadata",
  fields: {
    clips_creation_entry_point: { type: 'str', default: () => ("clips") },
    featured_label: { type: 'str', optional: true, default: () => (null) },
    is_public_chat_welcome_video: { type: 'bool', default: () => (false) },
    professional_clips_upsell_type: { type: 'int', default: () => (0) },
    show_tips: { type: 'str', optional: true, default: () => (null) },
    achievements_info: { type: () => ClipsAchievementsInfoSchema },
    additional_audio_info: { type: () => ClipsAdditionalAudioInfoSchema },
    asset_recommendation_info: { type: 'dict', optional: true, default: () => (null) },
    audio_ranking_info: { type: () => ClipsAudioRankingInfoSchema },
    audio_type: { type: 'str', default: () => ("original_sounds") },
    branded_content_tag_info: { type: () => ClipsBrandedContentTagInfoSchema },
    breaking_content_info: { type: 'dict', optional: true, default: () => (null) },
    breaking_creator_info: { type: 'dict', optional: true, default: () => (null) },
    challenge_info: { type: 'dict', optional: true, default: () => (null) },
    content_appreciation_info: { type: () => ClipsContentAppreciationInfoSchema },
    contextual_highlight_info: { type: 'dict', optional: true, default: () => (null) },
    cutout_sticker_info: { type: { list: 'dict' }, default: () => ([]) },
    disable_use_in_clips_client_cache: { type: 'bool', default: () => (false) },
    external_media_info: { type: 'dict', optional: true, default: () => (null) },
    is_fan_club_promo_video: { type: 'bool', default: () => (false) },
    is_shared_to_fb: { type: 'bool', optional: true, default: () => (null) },
    mashup_info: { type: () => ClipsMashupInfoSchema, optional: true, default: () => (null) },
    merchandising_pill_info: { type: 'dict', optional: true, default: () => (null) },
    music_canonical_id: { type: 'str' },
    music_info: { type: 'dict', optional: true, default: () => (null) },
    nux_info: { type: 'dict', optional: true, default: () => (null) },
    original_sound_info: { type: () => ClipsOriginalSoundInfoSchema, optional: true, default: () => (null) },
    originality_info: { type: 'dict', optional: true, default: () => (null) },
    reels_on_the_rise_info: { type: 'dict', optional: true, default: () => (null) },
    reusable_text_attribute_string: { type: 'str', optional: true, default: () => (null) },
    reusable_text_info: { type: { list: () => ClipsReusableTextInfoSchema }, optional: true, default: () => (null) },
    shopping_info: { type: 'dict', optional: true, default: () => (null) },
    show_achievements: { type: 'bool', default: () => (false) },
    template_info: { type: 'dict', optional: true, default: () => (null) },
    may_have_template_info: { type: 'dict', optional: true, default: () => (null) },
    viewer_interaction_settings: { type: 'dict', optional: true, default: () => (null) },
  },
};
export function makeClipsMetadata(data: Record<string, any>): ClipsMetadata {
  return parseModel<ClipsMetadata>(ClipsMetadataSchema, data);
}

export interface MediaDimensions {
  height: number | null;
  width: number | null;
}
export const MediaDimensionsSchema: ModelSchema = {
  name: "MediaDimensions",
  fields: {
    height: { type: 'int', optional: true, default: () => (null) },
    width: { type: 'int', optional: true, default: () => (null) },
  },
};
export function makeMediaDimensions(data: Record<string, any>): MediaDimensions {
  return parseModel<MediaDimensions>(MediaDimensionsSchema, data);
}

export interface MediaDashInfo {
  is_dash_eligible: boolean | null;
  video_dash_manifest: string | null;
  number_of_qualities: number | null;
}
export const MediaDashInfoSchema: ModelSchema = {
  name: "MediaDashInfo",
  fields: {
    is_dash_eligible: { type: 'bool', optional: true, default: () => (false) },
    video_dash_manifest: { type: 'str', optional: true, default: () => (null) },
    number_of_qualities: { type: 'int', optional: true, default: () => (0) },
  },
};
export function makeMediaDashInfo(data: Record<string, any>): MediaDashInfo {
  return parseModel<MediaDashInfo>(MediaDashInfoSchema, data);
}

export interface ClipsMusicAttributionInfo {
  artist_name: string | null;
  song_name: string | null;
  uses_original_audio: boolean | null;
  should_mute_audio: boolean | null;
  should_mute_audio_reason: string | null;
  audio_id: string | null;
}
export const ClipsMusicAttributionInfoSchema: ModelSchema = {
  name: "ClipsMusicAttributionInfo",
  fields: {
    artist_name: { type: 'str', optional: true, default: () => (null) },
    song_name: { type: 'str', optional: true, default: () => (null) },
    uses_original_audio: { type: 'bool', optional: true, default: () => (null) },
    should_mute_audio: { type: 'bool', optional: true, default: () => (null) },
    should_mute_audio_reason: { type: 'str', optional: true, default: () => (null) },
    audio_id: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeClipsMusicAttributionInfo(data: Record<string, any>): ClipsMusicAttributionInfo {
  return parseModel<ClipsMusicAttributionInfo>(ClipsMusicAttributionInfoSchema, data);
}

export interface MediaInlineComment {
  pk: string;
  text: string;
  user: UserShort;
  created_at_utc: Date;
  has_liked: boolean | null;
  like_count: number | null;
  replied_to_comment_id: string | null;
  did_report_as_spam: boolean | null;
  is_restricted_pending: boolean | null;
  replies_count: number | null;
  replies: Array<MediaInlineComment>;
}
export const MediaInlineCommentSchema: ModelSchema = {
  name: "MediaInlineComment",
  fields: {
    pk: { type: 'str' },
    text: { type: 'str' },
    user: { type: () => UserShortSchema },
    created_at_utc: { type: 'datetime' },
    has_liked: { type: 'bool', optional: true, default: () => (null) },
    like_count: { type: 'int', optional: true, default: () => (null) },
    replied_to_comment_id: { type: 'str', optional: true, default: () => (null) },
    did_report_as_spam: { type: 'bool', optional: true, default: () => (null) },
    is_restricted_pending: { type: 'bool', optional: true, default: () => (null) },
    replies_count: { type: 'int', optional: true, default: () => (0) },
    replies: { type: { list: () => MediaInlineCommentSchema }, default: () => ([]) },
  },
};
export function makeMediaInlineComment(data: Record<string, any>): MediaInlineComment {
  return parseModel<MediaInlineComment>(MediaInlineCommentSchema, data);
}

export interface MediaCommentsPreview {
  count: number | null;
  has_next_page: boolean | null;
  end_cursor: string | null;
  comments: Array<MediaInlineComment>;
}
export const MediaCommentsPreviewSchema: ModelSchema = {
  name: "MediaCommentsPreview",
  fields: {
    count: { type: 'int', optional: true, default: () => (0) },
    has_next_page: { type: 'bool', optional: true, default: () => (false) },
    end_cursor: { type: 'str', optional: true, default: () => (null) },
    comments: { type: { list: () => MediaInlineCommentSchema }, default: () => ([]) },
  },
};
export function makeMediaCommentsPreview(data: Record<string, any>): MediaCommentsPreview {
  return parseModel<MediaCommentsPreview>(MediaCommentsPreviewSchema, data);
}

export interface Media {
  pk: string;
  id: string;
  code: string;
  taken_at: Date;
  media_type: number;
  image_versions2: SharedMediaImageVersions | null;
  product_type: string | null;
  thumbnail_url: string | null;
  location: Location | null;
  user: UserShort;
  comment_count: number | null;
  comments_disabled: boolean | null;
  commenting_disabled_for_viewer: boolean | null;
  like_count: number;
  play_count: number | null;
  has_liked: boolean | null;
  caption_is_edited: boolean | null;
  dimensions: MediaDimensions | null;
  has_audio: boolean | null;
  like_and_view_counts_disabled: boolean | null;
  viewer_can_reshare: boolean | null;
  viewer_has_saved: boolean | null;
  is_paid_partnership: boolean | null;
  is_affiliate: boolean | null;
  dash_info: MediaDashInfo | null;
  clips_music_attribution_info: ClipsMusicAttributionInfo | null;
  comments_preview: MediaCommentsPreview | null;
  hoisted_comments: Array<MediaInlineComment>;
  caption_text: string;
  accessibility_caption: string | null;
  usertags: Array<Usertag>;
  coauthor_producers: Array<UserShort>;
  sponsor_tags: Array<UserShort>;
  video_url: string | null;
  view_count: number | null;
  video_duration: number | null;
  title: string | null;
  resources: Array<Resource>;
  clips_metadata: ClipsMetadata | Record<string, any> | null;
  crosspost: Array<string>;
  crosspost_metadata: Record<string, any> | null;
  has_shared_to_fb: number | null;
}
export const MediaSchema: ModelSchema = {
  name: "Media",
  fields: {
    pk: { type: 'str' },
    id: { type: 'str' },
    code: { type: 'str' },
    taken_at: { type: 'datetime' },
    media_type: { type: 'int' },
    image_versions2: { type: () => SharedMediaImageVersionsSchema, optional: true, default: () => (null) },
    product_type: { type: 'str', optional: true, default: () => ("") },
    thumbnail_url: { type: 'url', optional: true, default: () => (null) },
    location: { type: () => LocationSchema, optional: true, default: () => (null) },
    user: { type: () => UserShortSchema },
    comment_count: { type: 'int', optional: true, default: () => (0) },
    comments_disabled: { type: 'bool', optional: true, default: () => (false) },
    commenting_disabled_for_viewer: { type: 'bool', optional: true, default: () => (false) },
    like_count: { type: 'int' },
    play_count: { type: 'int', optional: true, default: () => (null) },
    has_liked: { type: 'bool', optional: true, default: () => (null) },
    caption_is_edited: { type: 'bool', optional: true, default: () => (false) },
    dimensions: { type: () => MediaDimensionsSchema, optional: true, default: () => (null) },
    has_audio: { type: 'bool', optional: true, default: () => (false) },
    like_and_view_counts_disabled: { type: 'bool', optional: true, default: () => (false) },
    viewer_can_reshare: { type: 'bool', optional: true, default: () => (false) },
    viewer_has_saved: { type: 'bool', optional: true, default: () => (false) },
    is_paid_partnership: { type: 'bool', optional: true, default: () => (false) },
    is_affiliate: { type: 'bool', optional: true, default: () => (false) },
    dash_info: { type: () => MediaDashInfoSchema, optional: true, default: () => (null) },
    clips_music_attribution_info: { type: () => ClipsMusicAttributionInfoSchema, optional: true, default: () => (null) },
    comments_preview: { type: () => MediaCommentsPreviewSchema, optional: true, default: () => (null) },
    hoisted_comments: { type: { list: () => MediaInlineCommentSchema }, default: () => ([]) },
    caption_text: { type: 'str' },
    accessibility_caption: { type: 'str', optional: true, default: () => (null) },
    usertags: { type: { list: () => UsertagSchema } },
    coauthor_producers: { type: { list: () => UserShortSchema }, default: () => ([]) },
    sponsor_tags: { type: { list: () => UserShortSchema } },
    video_url: { type: 'url', optional: true, default: () => (null) },
    view_count: { type: 'int', optional: true, default: () => (0) },
    video_duration: { type: 'float', optional: true, default: () => (0.0) },
    title: { type: 'str', optional: true, default: () => ("") },
    resources: { type: { list: () => ResourceSchema }, default: () => ([]) },
    clips_metadata: { type: { union: [() => ClipsMetadataSchema, 'dict'] }, optional: true, default: () => (null) },
    crosspost: { type: { list: 'str' }, default: () => ([]) },
    crosspost_metadata: { type: 'dict', optional: true, default: () => (null) },
    has_shared_to_fb: { type: 'int', optional: true, default: () => (null) },
  },
};
export function makeMedia(data: Record<string, any>): Media {
  return parseModel<Media>(MediaSchema, data);
}

export interface MediaXma {
  video_url: string;
  title: string | null;
  preview_url: string | null;
  preview_url_mime_type: string | null;
  header_icon_url: string | null;
  header_icon_width: number | null;
  header_icon_height: number | null;
  header_title_text: string | null;
  preview_media_fbid: string | null;
}
export const MediaXmaSchema: ModelSchema = {
  name: "MediaXma",
  fields: {
    video_url: { type: 'str' },
    title: { type: 'str', optional: true, default: () => ("") },
    preview_url: { type: 'str', optional: true, default: () => (null) },
    preview_url_mime_type: { type: 'str', optional: true, default: () => (null) },
    header_icon_url: { type: 'str', optional: true, default: () => (null) },
    header_icon_width: { type: 'int', optional: true, default: () => (null) },
    header_icon_height: { type: 'int', optional: true, default: () => (null) },
    header_title_text: { type: 'str', optional: true, default: () => (null) },
    preview_media_fbid: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeMediaXma(data: Record<string, any>): MediaXma {
  return parseModel<MediaXma>(MediaXmaSchema, data);
}

export interface MediaOembed {
  title: string;
  author_name: string;
  author_url: string;
  author_id: string;
  media_id: string;
  provider_name: string;
  provider_url: string;
  type: string;
  width: number | null;
  height: number | null;
  html: string;
  thumbnail_url: string;
  thumbnail_width: number;
  thumbnail_height: number;
  can_view: boolean;
}
export const MediaOembedSchema: ModelSchema = {
  name: "MediaOembed",
  fields: {
    title: { type: 'str' },
    author_name: { type: 'str' },
    author_url: { type: 'str' },
    author_id: { type: 'str' },
    media_id: { type: 'str' },
    provider_name: { type: 'str' },
    provider_url: { type: 'url' },
    type: { type: 'str' },
    width: { type: 'int', optional: true, default: () => (null) },
    height: { type: 'int', optional: true, default: () => (null) },
    html: { type: 'str' },
    thumbnail_url: { type: 'url' },
    thumbnail_width: { type: 'int' },
    thumbnail_height: { type: 'int' },
    can_view: { type: 'bool' },
  },
};
export function makeMediaOembed(data: Record<string, any>): MediaOembed {
  return parseModel<MediaOembed>(MediaOembedSchema, data);
}

export interface Collection {
  id: string;
  name: string;
  type: string;
  media_count: number;
}
export const CollectionSchema: ModelSchema = {
  name: "Collection",
  fields: {
    id: { type: 'str' },
    name: { type: 'str' },
    type: { type: 'str' },
    media_count: { type: 'int' },
  },
};
export function makeCollection(data: Record<string, any>): Collection {
  return parseModel<Collection>(CollectionSchema, data);
}

export interface Comment {
  pk: string;
  text: string;
  user: UserShort;
  created_at_utc: Date;
  content_type: string;
  status: string;
  replied_to_comment_id: string | null;
  has_liked: boolean | null;
  like_count: number | null;
}
export const CommentSchema: ModelSchema = {
  name: "Comment",
  fields: {
    pk: { type: 'str' },
    text: { type: 'str' },
    user: { type: () => UserShortSchema },
    created_at_utc: { type: 'datetime' },
    content_type: { type: 'str' },
    status: { type: 'str' },
    replied_to_comment_id: { type: 'str', optional: true, default: () => (null) },
    has_liked: { type: 'bool', optional: true, default: () => (null) },
    like_count: { type: 'int', optional: true, default: () => (null) },
  },
};
export function makeComment(data: Record<string, any>): Comment {
  return parseModel<Comment>(CommentSchema, data);
}

export interface Hashtag {
  id: string;
  name: string;
  media_count: number | null;
  profile_pic_url: string | null;
}
export const HashtagSchema: ModelSchema = {
  name: "Hashtag",
  fields: {
    id: { type: 'str' },
    name: { type: 'str' },
    media_count: { type: 'int', optional: true, default: () => (null) },
    profile_pic_url: { type: 'url', optional: true, default: () => (null) },
  },
};
export function makeHashtag(data: Record<string, any>): Hashtag {
  return parseModel<Hashtag>(HashtagSchema, data);
}

export interface StoryMention {
  user: UserShort;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  rotation: number | null;
}
export const StoryMentionSchema: ModelSchema = {
  name: "StoryMention",
  fields: {
    user: { type: () => UserShortSchema },
    x: { type: 'float', optional: true, default: () => (null) },
    y: { type: 'float', optional: true, default: () => (null) },
    width: { type: 'float', optional: true, default: () => (null) },
    height: { type: 'float', optional: true, default: () => (null) },
    rotation: { type: 'float', optional: true, default: () => (null) },
  },
};
export function makeStoryMention(data: Record<string, any>): StoryMention {
  return parseModel<StoryMention>(StoryMentionSchema, data);
}

export interface StoryMedia {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  rotation: number;
  is_pinned: boolean | null;
  is_hidden: boolean | null;
  is_sticker: boolean | null;
  is_fb_sticker: boolean | null;
  media_pk: string;
  user_id: string | null;
  product_type: string | null;
  media_code: string | null;
}
export const StoryMediaSchema: ModelSchema = {
  name: "StoryMedia",
  fields: {
    x: { type: 'float', default: () => (0.5) },
    y: { type: 'float', default: () => (0.4997396) },
    z: { type: 'float', default: () => (0) },
    width: { type: 'float', default: () => (0.8) },
    height: { type: 'float', default: () => (0.60572916) },
    rotation: { type: 'float', default: () => (0.0) },
    is_pinned: { type: 'bool', optional: true, default: () => (null) },
    is_hidden: { type: 'bool', optional: true, default: () => (null) },
    is_sticker: { type: 'bool', optional: true, default: () => (null) },
    is_fb_sticker: { type: 'bool', optional: true, default: () => (null) },
    media_pk: { type: 'idint' },
    user_id: { type: 'idint', optional: true, default: () => (null) },
    product_type: { type: 'str', optional: true, default: () => (null) },
    media_code: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeStoryMedia(data: Record<string, any>): StoryMedia {
  return parseModel<StoryMedia>(StoryMediaSchema, data);
}

export interface StoryHashtag {
  hashtag: Hashtag;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  rotation: number | null;
}
export const StoryHashtagSchema: ModelSchema = {
  name: "StoryHashtag",
  fields: {
    hashtag: { type: () => HashtagSchema },
    x: { type: 'float', optional: true, default: () => (null) },
    y: { type: 'float', optional: true, default: () => (null) },
    width: { type: 'float', optional: true, default: () => (null) },
    height: { type: 'float', optional: true, default: () => (null) },
    rotation: { type: 'float', optional: true, default: () => (null) },
  },
};
export function makeStoryHashtag(data: Record<string, any>): StoryHashtag {
  return parseModel<StoryHashtag>(StoryHashtagSchema, data);
}

export interface StoryLocation {
  location: Location;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  rotation: number | null;
}
export const StoryLocationSchema: ModelSchema = {
  name: "StoryLocation",
  fields: {
    location: { type: () => LocationSchema },
    x: { type: 'float', optional: true, default: () => (null) },
    y: { type: 'float', optional: true, default: () => (null) },
    width: { type: 'float', optional: true, default: () => (null) },
    height: { type: 'float', optional: true, default: () => (null) },
    rotation: { type: 'float', optional: true, default: () => (null) },
  },
};
export function makeStoryLocation(data: Record<string, any>): StoryLocation {
  return parseModel<StoryLocation>(StoryLocationSchema, data);
}

export interface StoryStickerLink {
  url: string;
  link_title: string | null;
  link_type: string | null;
  display_url: string | null;
}
export const StoryStickerLinkSchema: ModelSchema = {
  name: "StoryStickerLink",
  fields: {
    url: { type: 'url' },
    link_title: { type: 'str', optional: true, default: () => (null) },
    link_type: { type: 'str', optional: true, default: () => (null) },
    display_url: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeStoryStickerLink(data: Record<string, any>): StoryStickerLink {
  return parseModel<StoryStickerLink>(StoryStickerLinkSchema, data);
}

export interface StorySticker {
  id: string | null;
  type: string | null;
  x: number;
  y: number;
  z: number | null;
  width: number;
  height: number;
  rotation: number | null;
  story_link: StoryStickerLink | null;
  extra: Record<string, any> | null;
}
export const StoryStickerSchema: ModelSchema = {
  name: "StorySticker",
  fields: {
    id: { type: 'str', optional: true, default: () => (null) },
    type: { type: 'str', optional: true, default: () => ("gif") },
    x: { type: 'float' },
    y: { type: 'float' },
    z: { type: 'int', optional: true, default: () => (1000005) },
    width: { type: 'float' },
    height: { type: 'float' },
    rotation: { type: 'float', optional: true, default: () => (0.0) },
    story_link: { type: () => StoryStickerLinkSchema, optional: true, default: () => (null) },
    extra: { type: 'dict', optional: true, default: () => ({}) },
  },
};
export function makeStorySticker(data: Record<string, any>): StorySticker {
  return parseModel<StorySticker>(StoryStickerSchema, data);
}

export interface StoryPoll {
  id: string | null;
  type: string | null;
  x: number;
  y: number;
  z: number | null;
  width: number;
  height: number;
  rotation: number | null;
  is_multi_option: boolean | null;
  is_shared_result: boolean | null;
  viewer_can_vote: boolean | null;
  finished: boolean | null;
  color: string | null;
  poll_type: string | null;
  question: string;
  options: any[];
  extra: Record<string, any> | null;
}
export const StoryPollSchema: ModelSchema = {
  name: "StoryPoll",
  fields: {
    id: { type: 'str', optional: true, default: () => (null) },
    type: { type: 'str', optional: true, default: () => ("poll") },
    x: { type: 'float' },
    y: { type: 'float' },
    z: { type: 'int', optional: true, default: () => (0) },
    width: { type: 'float' },
    height: { type: 'float' },
    rotation: { type: 'float', optional: true, default: () => (0.0) },
    is_multi_option: { type: 'bool', optional: true, default: () => (true) },
    is_shared_result: { type: 'bool', optional: true, default: () => (false) },
    viewer_can_vote: { type: 'bool', optional: true, default: () => (true) },
    finished: { type: 'bool', optional: true, default: () => (false) },
    color: { type: 'str', optional: true, default: () => ("black") },
    poll_type: { type: 'str', optional: true, default: () => ("") },
    question: { type: 'str' },
    options: { type: { list: 'any' } },
    extra: { type: 'dict', optional: true, default: () => ({}) },
  },
};
export function makeStoryPoll(data: Record<string, any>): StoryPoll {
  return parseModel<StoryPoll>(StoryPollSchema, data);
}

export interface StoryBuild {
  mentions: Array<StoryMention>;
  path: string;
  paths: Array<string>;
  stickers: Array<StorySticker>;
}
export const StoryBuildSchema: ModelSchema = {
  name: "StoryBuild",
  fields: {
    mentions: { type: { list: () => StoryMentionSchema } },
    path: { type: 'filepath' },
    paths: { type: { list: 'filepath' }, default: () => ([]) },
    stickers: { type: { list: () => StoryStickerSchema }, default: () => ([]) },
  },
};
export function makeStoryBuild(data: Record<string, any>): StoryBuild {
  return parseModel<StoryBuild>(StoryBuildSchema, data);
}

export interface StoryLink {
  webUri: string;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  rotation: number;
}
export const StoryLinkSchema: ModelSchema = {
  name: "StoryLink",
  fields: {
    webUri: { type: 'url' },
    x: { type: 'float', default: () => (0.5126011) },
    y: { type: 'float', default: () => (0.5168225) },
    z: { type: 'float', default: () => (0.0) },
    width: { type: 'float', default: () => (0.50998676) },
    height: { type: 'float', default: () => (0.25875) },
    rotation: { type: 'float', default: () => (0.0) },
  },
};
export function makeStoryLink(data: Record<string, any>): StoryLink {
  return parseModel<StoryLink>(StoryLinkSchema, data);
}

export interface Story {
  pk: string;
  id: string;
  code: string;
  taken_at: Date;
  imported_taken_at: Date | null;
  media_type: number;
  product_type: string | null;
  thumbnail_url: string | null;
  user: UserShort;
  video_url: string | null;
  video_duration: number | null;
  sponsor_tags: Array<UserShort>;
  is_paid_partnership: boolean | null;
  mentions: Array<StoryMention>;
  links: Array<StoryLink>;
  hashtags: Array<StoryHashtag>;
  locations: Array<StoryLocation>;
  stickers: Array<StorySticker>;
  medias: Array<StoryMedia>;
  polls: Array<StoryPoll>;
}
export const StorySchema: ModelSchema = {
  name: "Story",
  fields: {
    pk: { type: 'str' },
    id: { type: 'str' },
    code: { type: 'str' },
    taken_at: { type: 'datetime' },
    imported_taken_at: { type: 'datetime', optional: true, default: () => (null) },
    media_type: { type: 'int' },
    product_type: { type: 'str', optional: true, default: () => ("") },
    thumbnail_url: { type: 'url', optional: true, default: () => (null) },
    user: { type: () => UserShortSchema },
    video_url: { type: 'url', optional: true, default: () => (null) },
    video_duration: { type: 'float', optional: true, default: () => (0.0) },
    sponsor_tags: { type: { list: () => UserShortSchema } },
    is_paid_partnership: { type: 'bool', optional: true, default: () => (false) },
    mentions: { type: { list: () => StoryMentionSchema } },
    links: { type: { list: () => StoryLinkSchema } },
    hashtags: { type: { list: () => StoryHashtagSchema } },
    locations: { type: { list: () => StoryLocationSchema } },
    stickers: { type: { list: () => StoryStickerSchema } },
    medias: { type: { list: () => StoryMediaSchema }, default: () => ([]) },
    polls: { type: { list: () => StoryPollSchema }, default: () => ([]) },
  },
};
export function makeStory(data: Record<string, any>): Story {
  return parseModel<Story>(StorySchema, data);
}

export interface StoryArchiveDay {
  id: string;
  timestamp: Date;
  media_count: number;
  reel_type: string;
  latest_reel_media: number | null;
}
export const StoryArchiveDaySchema: ModelSchema = {
  name: "StoryArchiveDay",
  fields: {
    id: { type: 'str' },
    timestamp: { type: 'datetime' },
    media_count: { type: 'int' },
    reel_type: { type: 'str' },
    latest_reel_media: { type: 'int', optional: true, default: () => (null) },
  },
};
export function makeStoryArchiveDay(data: Record<string, any>): StoryArchiveDay {
  return parseModel<StoryArchiveDay>(StoryArchiveDaySchema, data);
}

export interface Guide {
  id: string | null;
  title: string | null;
  description: string;
  cover_media: Media;
  feedback_item: Record<string, any> | null;
}
export const GuideSchema: ModelSchema = {
  name: "Guide",
  fields: {
    id: { type: 'str', optional: true, default: () => (null) },
    title: { type: 'str', optional: true, default: () => (null) },
    description: { type: 'str' },
    cover_media: { type: () => MediaSchema },
    feedback_item: { type: 'dict', optional: true, default: () => (null) },
  },
};
export function makeGuide(data: Record<string, any>): Guide {
  return parseModel<Guide>(GuideSchema, data);
}

export interface DirectMedia {
  id: string;
  media_type: number;
  user: UserShort | null;
  thumbnail_url: string | null;
  video_url: string | null;
  audio_url: string | null;
}
export const DirectMediaSchema: ModelSchema = {
  name: "DirectMedia",
  fields: {
    id: { type: 'str' },
    media_type: { type: 'int' },
    user: { type: () => UserShortSchema, optional: true, default: () => (null) },
    thumbnail_url: { type: 'url', optional: true, default: () => (null) },
    video_url: { type: 'url', optional: true, default: () => (null) },
    audio_url: { type: 'url', optional: true, default: () => (null) },
  },
};
export function makeDirectMedia(data: Record<string, any>): DirectMedia {
  return parseModel<DirectMedia>(DirectMediaSchema, data);
}

/** Individual emoji reaction on a direct message */
export interface MessageReaction {
  timestamp: Date;
  client_context: string | null;
  sender_id: string;
  emoji: string;
  super_react_type: string;
}
export const MessageReactionSchema: ModelSchema = {
  name: "MessageReaction",
  fields: {
    timestamp: { type: 'datetime' },
    client_context: { type: 'str', optional: true, default: () => (null) },
    sender_id: { type: 'idint' },
    emoji: { type: 'str' },
    super_react_type: { type: 'str', default: () => ("none") },
  },
};
export function makeMessageReaction(data: Record<string, any>): MessageReaction {
  return parseModel<MessageReaction>(MessageReactionSchema, data);
}

/** Reactions structure for direct messages */
export interface MessageReactions {
  likes: Array<Record<string, any>>;
  likes_count: number | null;
  emojis: Array<MessageReaction>;
}
export const MessageReactionsSchema: ModelSchema = {
  name: "MessageReactions",
  fields: {
    likes: { type: { list: 'dict' }, default: () => ([]) },
    likes_count: { type: 'int', optional: true, default: () => (0) },
    emojis: { type: { list: () => MessageReactionSchema }, default: () => ([]) },
  },
};
export function makeMessageReactions(data: Record<string, any>): MessageReactions {
  return parseModel<MessageReactions>(MessageReactionsSchema, data);
}

/** Link context metadata for direct message links */
export interface LinkContext {
  link_url: string;
  link_title: string | null;
  link_summary: string | null;
  link_image_url: string | null;
}
export const LinkContextSchema: ModelSchema = {
  name: "LinkContext",
  fields: {
    link_url: { type: 'str' },
    link_title: { type: 'str', optional: true, default: () => ("") },
    link_summary: { type: 'str', optional: true, default: () => ("") },
    link_image_url: { type: 'str', optional: true, default: () => ("") },
  },
};
export function makeLinkContext(data: Record<string, any>): LinkContext {
  return parseModel<LinkContext>(LinkContextSchema, data);
}

/** Link structure for direct messages */
export interface MessageLink {
  text: string;
  link_context: LinkContext;
  client_context: string | null;
  mutation_token: string | null;
}
export const MessageLinkSchema: ModelSchema = {
  name: "MessageLink",
  fields: {
    text: { type: 'str' },
    link_context: { type: () => LinkContextSchema },
    client_context: { type: 'str', optional: true, default: () => (null) },
    mutation_token: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeMessageLink(data: Record<string, any>): MessageLink {
  return parseModel<MessageLink>(MessageLinkSchema, data);
}

/** Disappearing messages seen state information */
export interface DisappearingMessagesSeenState {
  item_id: string;
  timestamp: Date;
  created_at: Date;
}
export const DisappearingMessagesSeenStateSchema: ModelSchema = {
  name: "DisappearingMessagesSeenState",
  fields: {
    item_id: { type: 'str' },
    timestamp: { type: 'datetime' },
    created_at: { type: 'datetime' },
  },
};
export function makeDisappearingMessagesSeenState(data: Record<string, any>): DisappearingMessagesSeenState {
  return parseModel<DisappearingMessagesSeenState>(DisappearingMessagesSeenStateSchema, data);
}

/** Last seen information for a user in a direct thread */
export interface LastSeenInfo {
  item_id: string;
  timestamp: Date;
  created_at: Date;
  shh_seen_state: Record<string, any>;
  disappearing_messages_seen_state: DisappearingMessagesSeenState | null;
}
export const LastSeenInfoSchema: ModelSchema = {
  name: "LastSeenInfo",
  fields: {
    item_id: { type: 'str' },
    timestamp: { type: 'datetime' },
    created_at: { type: 'datetime' },
    shh_seen_state: { type: 'dict', default: () => ({}) },
    disappearing_messages_seen_state: { type: () => DisappearingMessagesSeenStateSchema, optional: true, default: () => (null) },
  },
};
export function makeLastSeenInfo(data: Record<string, any>): LastSeenInfo {
  return parseModel<LastSeenInfo>(LastSeenInfoSchema, data);
}

/** Fallback URL structure for media candidates */
export interface FallbackUrl {
  url: string;
}
export const FallbackUrlSchema: ModelSchema = {
  name: "FallbackUrl",
  fields: {
    url: { type: 'str' },
  },
};
export function makeFallbackUrl(data: Record<string, any>): FallbackUrl {
  return parseModel<FallbackUrl>(FallbackUrlSchema, data);
}

/** Image candidate for ephemeral visual media in direct messages */
export interface DirectMessageImageCandidate {
  width: number;
  height: number;
  url: string;
  scans_profile: string | null;
  fallback: FallbackUrl | null;
  url_expiration_timestamp_us: Date | null;
}
export const DirectMessageImageCandidateSchema: ModelSchema = {
  name: "DirectMessageImageCandidate",
  fields: {
    width: { type: 'int' },
    height: { type: 'int' },
    url: { type: 'str' },
    scans_profile: { type: 'str', optional: true, default: () => (null) },
    fallback: { type: () => FallbackUrlSchema, optional: true, default: () => (null) },
    url_expiration_timestamp_us: { type: 'datetime', optional: true, default: () => (null) },
  },
};
export function makeDirectMessageImageCandidate(data: Record<string, any>): DirectMessageImageCandidate {
  return parseModel<DirectMessageImageCandidate>(DirectMessageImageCandidateSchema, data);
}

/** Image versions for ephemeral visual media in direct messages */
export interface DirectMessageImageVersions {
  candidates: Array<DirectMessageImageCandidate>;
}
export const DirectMessageImageVersionsSchema: ModelSchema = {
  name: "DirectMessageImageVersions",
  fields: {
    candidates: { type: { list: () => DirectMessageImageCandidateSchema }, default: () => ([]) },
  },
};
export function makeDirectMessageImageVersions(data: Record<string, any>): DirectMessageImageVersions {
  return parseModel<DirectMessageImageVersions>(DirectMessageImageVersionsSchema, data);
}

/** Individual video version with specific resolution and quality */
export interface VideoVersion {
  id: string | null;
  type: number | null;
  width: number;
  height: number;
  url: string;
  fallback: FallbackUrl | null;
  url_expiration_timestamp_us: Date | null;
  bandwidth: number | null;
}
export const VideoVersionSchema: ModelSchema = {
  name: "VideoVersion",
  fields: {
    id: { type: 'str', optional: true, default: () => ("") },
    type: { type: 'int', optional: true, default: () => (null) },
    width: { type: 'int' },
    height: { type: 'int' },
    url: { type: 'str' },
    fallback: { type: () => FallbackUrlSchema, optional: true, default: () => (null) },
    url_expiration_timestamp_us: { type: 'datetime', optional: true, default: () => (null) },
    bandwidth: { type: 'int', optional: true, default: () => (0) },
  },
};
export function makeVideoVersion(data: Record<string, any>): VideoVersion {
  return parseModel<VideoVersion>(VideoVersionSchema, data);
}

/** Friendship status information for visual media user */
export interface FriendshipStatus {
  blocking: boolean;
  is_messaging_only_blocking: boolean;
  is_messaging_pseudo_blocking: boolean;
  is_unavailable: boolean;
}
export const FriendshipStatusSchema: ModelSchema = {
  name: "FriendshipStatus",
  fields: {
    blocking: { type: 'bool', default: () => (false) },
    is_messaging_only_blocking: { type: 'bool', default: () => (false) },
    is_messaging_pseudo_blocking: { type: 'bool', default: () => (false) },
    is_unavailable: { type: 'bool', default: () => (false) },
  },
};
export function makeFriendshipStatus(data: Record<string, any>): FriendshipStatus {
  return parseModel<FriendshipStatus>(FriendshipStatusSchema, data);
}

/** User information in visual media (enhanced UserShort) */
export interface VisualMediaUser {
  id: string;
  strong_id__: string | null;
  pk: string;
  pk_id: string;
  full_name: string;
  username: string;
  account_type: number | null;
  short_name: string | null;
  profile_pic_url: string;
  is_verified: boolean;
  interop_messaging_user_fbid: string | null;
  fbid_v2: string | null;
  has_ig_profile: boolean;
  interop_user_type: number | null;
  is_using_unified_inbox_for_direct: boolean;
  is_private: boolean;
  is_creator_agent_enabled: boolean;
  is_creator_automated_response_enabled: boolean;
  friendship_status: FriendshipStatus | null;
  is_shared_account: boolean;
  is_shared_account_with_messaging_access: boolean;
  ai_agent_banner_type: string | null;
  is_eligible_for_ai_bot_group_chats: boolean;
}
export const VisualMediaUserSchema: ModelSchema = {
  name: "VisualMediaUser",
  fields: {
    id: { type: 'str' },
    strong_id__: { type: 'str', optional: true, default: () => (null) },
    pk: { type: 'idint' },
    pk_id: { type: 'str' },
    full_name: { type: 'str' },
    username: { type: 'str' },
    account_type: { type: 'int', optional: true, default: () => (null) },
    short_name: { type: 'str', optional: true, default: () => (null) },
    profile_pic_url: { type: 'str' },
    is_verified: { type: 'bool', default: () => (false) },
    interop_messaging_user_fbid: { type: 'idint', optional: true, default: () => (null) },
    fbid_v2: { type: 'idint', optional: true, default: () => (null) },
    has_ig_profile: { type: 'bool', default: () => (true) },
    interop_user_type: { type: 'int', optional: true, default: () => (0) },
    is_using_unified_inbox_for_direct: { type: 'bool', default: () => (false) },
    is_private: { type: 'bool', default: () => (false) },
    is_creator_agent_enabled: { type: 'bool', default: () => (false) },
    is_creator_automated_response_enabled: { type: 'bool', default: () => (false) },
    friendship_status: { type: () => FriendshipStatusSchema, optional: true, default: () => (null) },
    is_shared_account: { type: 'bool', default: () => (false) },
    is_shared_account_with_messaging_access: { type: 'bool', default: () => (false) },
    ai_agent_banner_type: { type: 'str', optional: true, default: () => (null) },
    is_eligible_for_ai_bot_group_chats: { type: 'bool', default: () => (false) },
  },
};
export function makeVisualMediaUser(data: Record<string, any>): VisualMediaUser {
  return parseModel<VisualMediaUser>(VisualMediaUserSchema, data);
}

/** Summary of expiring media actions */
export interface ExpiringMediaActionSummary {
  type: string;
  timestamp: Date;
  count: number;
}
export const ExpiringMediaActionSummarySchema: ModelSchema = {
  name: "ExpiringMediaActionSummary",
  fields: {
    type: { type: 'str' },
    timestamp: { type: 'datetime' },
    count: { type: 'int' },
  },
};
export function makeExpiringMediaActionSummary(data: Record<string, any>): ExpiringMediaActionSummary {
  return parseModel<ExpiringMediaActionSummary>(ExpiringMediaActionSummarySchema, data);
}

/** Content structure for visual media (can be rich or minimal) */
export interface VisualMediaContent {
  media_type: number;
  id: string | null;
  media_id: string | null;
  image_versions2: DirectMessageImageVersions | null;
  video_versions: Array<VideoVersion> | null;
  original_width: number | null;
  original_height: number | null;
  user: VisualMediaUser | null;
  organic_tracking_token: string | null;
  video_duration: number | null;
  video_dash_manifest: string | null;
  is_dash_eligible: number | null;
  create_mode_attribution: Record<string, any> | null;
  creative_config: Record<string, any> | null;
  expiring_media_action_summary: ExpiringMediaActionSummary | null;
}
export const VisualMediaContentSchema: ModelSchema = {
  name: "VisualMediaContent",
  fields: {
    media_type: { type: 'int' },
    id: { type: 'str', optional: true, default: () => (null) },
    media_id: { type: 'idint', optional: true, default: () => (null) },
    image_versions2: { type: () => DirectMessageImageVersionsSchema, optional: true, default: () => (null) },
    video_versions: { type: { list: () => VideoVersionSchema }, optional: true, default: () => (null) },
    original_width: { type: 'int', optional: true, default: () => (null) },
    original_height: { type: 'int', optional: true, default: () => (null) },
    user: { type: () => VisualMediaUserSchema, optional: true, default: () => (null) },
    organic_tracking_token: { type: 'str', optional: true, default: () => (null) },
    video_duration: { type: 'int', optional: true, default: () => (null) },
    video_dash_manifest: { type: 'str', optional: true, default: () => (null) },
    is_dash_eligible: { type: 'int', optional: true, default: () => (null) },
    create_mode_attribution: { type: 'dict', optional: true, default: () => (null) },
    creative_config: { type: 'dict', optional: true, default: () => (null) },
    expiring_media_action_summary: { type: () => ExpiringMediaActionSummarySchema, optional: true, default: () => (null) },
  },
};
export function makeVisualMediaContent(data: Record<string, any>): VisualMediaContent {
  return parseModel<VisualMediaContent>(VisualMediaContentSchema, data);
}

/** Complete visual media structure for direct messages */
export interface VisualMedia {
  media: VisualMediaContent;
  seen_user_ids: Array<string>;
  seen_count: number;
  view_mode: string;
  replay_expiring_at_us: number | null;
  reply_type: string | null;
  url_expire_at_secs: number | null;
  story_app_attribution: Record<string, any> | null;
  playback_duration_secs: number | null;
  tap_models: Array<Record<string, any>>;
  expiring_media_action_summary: ExpiringMediaActionSummary | null;
}
export const VisualMediaSchema: ModelSchema = {
  name: "VisualMedia",
  fields: {
    media: { type: () => VisualMediaContentSchema },
    seen_user_ids: { type: { list: 'str' }, default: () => ([]) },
    seen_count: { type: 'int', default: () => (0) },
    view_mode: { type: 'str' },
    replay_expiring_at_us: { type: 'int', optional: true, default: () => (null) },
    reply_type: { type: 'str', optional: true, default: () => (null) },
    url_expire_at_secs: { type: 'int', optional: true, default: () => (null) },
    story_app_attribution: { type: 'dict', optional: true, default: () => (null) },
    playback_duration_secs: { type: 'int', optional: true, default: () => (null) },
    tap_models: { type: { list: 'dict' }, default: () => ([]) },
    expiring_media_action_summary: { type: () => ExpiringMediaActionSummarySchema, optional: true, default: () => (null) },
  },
};
export function makeVisualMedia(data: Record<string, any>): VisualMedia {
  return parseModel<VisualMedia>(VisualMediaSchema, data);
}

export interface ReplyMessage {
  id: string;
  user_id: string | null;
  timestamp: Date;
  item_type: string | null;
  is_sent_by_viewer: boolean | null;
  is_shh_mode: boolean | null;
  text: string | null;
  link: Record<string, any> | null;
  animated_media: Record<string, any> | null;
  media: DirectMedia | null;
  visual_media: VisualMedia | null;
  media_share: Media | null;
  reel_share: Record<string, any> | null;
  story_share: Record<string, any> | null;
  felix_share: Record<string, any> | null;
  xma_share: MediaXma | null;
  generic_xma: Array<MediaXma> | null;
  raw_xma: Record<string, any> | null;
  clip: Media | null;
  placeholder: Record<string, any> | null;
}
export const ReplyMessageSchema: ModelSchema = {
  name: "ReplyMessage",
  fields: {
    id: { type: 'str' },
    user_id: { type: 'str', optional: true, default: () => (null) },
    timestamp: { type: 'datetime' },
    item_type: { type: 'str', optional: true, default: () => (null) },
    is_sent_by_viewer: { type: 'bool', optional: true, default: () => (null) },
    is_shh_mode: { type: 'bool', optional: true, default: () => (null) },
    text: { type: 'str', optional: true, default: () => (null) },
    link: { type: 'dict', optional: true, default: () => (null) },
    animated_media: { type: 'dict', optional: true, default: () => (null) },
    media: { type: () => DirectMediaSchema, optional: true, default: () => (null) },
    visual_media: { type: () => VisualMediaSchema, optional: true, default: () => (null) },
    media_share: { type: () => MediaSchema, optional: true, default: () => (null) },
    reel_share: { type: 'dict', optional: true, default: () => (null) },
    story_share: { type: 'dict', optional: true, default: () => (null) },
    felix_share: { type: 'dict', optional: true, default: () => (null) },
    xma_share: { type: () => MediaXmaSchema, optional: true, default: () => (null) },
    generic_xma: { type: { list: () => MediaXmaSchema }, optional: true, default: () => (null) },
    raw_xma: { type: 'dict', optional: true, default: () => (null) },
    clip: { type: () => MediaSchema, optional: true, default: () => (null) },
    placeholder: { type: 'dict', optional: true, default: () => (null) },
  },
};
export function makeReplyMessage(data: Record<string, any>): ReplyMessage {
  return parseModel<ReplyMessage>(ReplyMessageSchema, data);
}

export interface DirectMessage {
  id: string;
  user_id: string | null;
  thread_id: string | null;
  timestamp: Date;
  item_type: string | null;
  is_sent_by_viewer: boolean | null;
  is_shh_mode: boolean | null;
  reactions: MessageReactions | null;
  text: string | null;
  reply: ReplyMessage | null;
  link: MessageLink | null;
  animated_media: Record<string, any> | null;
  media: DirectMedia | null;
  visual_media: VisualMedia | null;
  media_share: Media | null;
  reel_share: Record<string, any> | null;
  story_share: Record<string, any> | null;
  felix_share: Record<string, any> | null;
  xma_share: MediaXma | null;
  generic_xma: Array<MediaXma> | null;
  raw_xma: Record<string, any> | null;
  clip: Media | null;
  placeholder: Record<string, any> | null;
  client_context: string | null;
}
export const DirectMessageSchema: ModelSchema = {
  name: "DirectMessage",
  fields: {
    id: { type: 'str' },
    user_id: { type: 'str', optional: true, default: () => (null) },
    thread_id: { type: 'idint', optional: true, default: () => (null) },
    timestamp: { type: 'datetime' },
    item_type: { type: 'str', optional: true, default: () => (null) },
    is_sent_by_viewer: { type: 'bool', optional: true, default: () => (null) },
    is_shh_mode: { type: 'bool', optional: true, default: () => (null) },
    reactions: { type: () => MessageReactionsSchema, optional: true, default: () => (null) },
    text: { type: 'str', optional: true, default: () => (null) },
    reply: { type: () => ReplyMessageSchema, optional: true, default: () => (null) },
    link: { type: () => MessageLinkSchema, optional: true, default: () => (null) },
    animated_media: { type: 'dict', optional: true, default: () => (null) },
    media: { type: () => DirectMediaSchema, optional: true, default: () => (null) },
    visual_media: { type: () => VisualMediaSchema, optional: true, default: () => (null) },
    media_share: { type: () => MediaSchema, optional: true, default: () => (null) },
    reel_share: { type: 'dict', optional: true, default: () => (null) },
    story_share: { type: 'dict', optional: true, default: () => (null) },
    felix_share: { type: 'dict', optional: true, default: () => (null) },
    xma_share: { type: () => MediaXmaSchema, optional: true, default: () => (null) },
    generic_xma: { type: { list: () => MediaXmaSchema }, optional: true, default: () => (null) },
    raw_xma: { type: 'dict', optional: true, default: () => (null) },
    clip: { type: () => MediaSchema, optional: true, default: () => (null) },
    placeholder: { type: 'dict', optional: true, default: () => (null) },
    client_context: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeDirectMessage(data: Record<string, any>): DirectMessage {
  return parseModel<DirectMessage>(DirectMessageSchema, data);
}

export interface DirectResponse {
  unseen_count: number | null;
  unseen_count_ts: number | null;
  status: string | null;
}
export const DirectResponseSchema: ModelSchema = {
  name: "DirectResponse",
  fields: {
    unseen_count: { type: 'int', optional: true, default: () => (null) },
    unseen_count_ts: { type: 'int', optional: true, default: () => (null) },
    status: { type: 'str', optional: true, default: () => (null) },
  },
};
export function makeDirectResponse(data: Record<string, any>): DirectResponse {
  return parseModel<DirectResponse>(DirectResponseSchema, data);
}

export interface DirectShortThread {
  id: string;
  users: Array<UserShort>;
  named: boolean;
  thread_title: string;
  pending: boolean;
  thread_type: string;
  viewer_id: string;
  is_group: boolean;
}
export const DirectShortThreadSchema: ModelSchema = {
  name: "DirectShortThread",
  fields: {
    id: { type: 'str' },
    users: { type: { list: () => UserShortSchema } },
    named: { type: 'bool' },
    thread_title: { type: 'str' },
    pending: { type: 'bool' },
    thread_type: { type: 'str' },
    viewer_id: { type: 'str' },
    is_group: { type: 'bool' },
  },
};
export function makeDirectShortThread(data: Record<string, any>): DirectShortThread {
  return parseModel<DirectShortThread>(DirectShortThreadSchema, data);
}

export interface DirectThread {
  pk: string;
  id: string;
  messages: Array<DirectMessage>;
  users: Array<UserShort>;
  inviter: UserShort | null;
  left_users: Array<UserShort>;
  admin_user_ids: any[];
  last_activity_at: Date;
  muted: boolean;
  is_pin: boolean | null;
  named: boolean;
  canonical: boolean;
  pending: boolean;
  archived: boolean;
  thread_type: string;
  thread_title: string;
  folder: number;
  vc_muted: boolean;
  is_group: boolean;
  mentions_muted: boolean;
  approval_required_for_new_members: boolean;
  input_mode: number;
  business_thread_folder: number | null;
  read_state: number | null;
  is_close_friend_thread: boolean;
  assigned_admin_id: string | null;
  shh_mode_enabled: boolean | null;
  last_seen_at: Record<string, LastSeenInfo>;
  /** Have I seen this thread? (userId: your account user_id) */
  isSeen(userId: string | number | bigint): boolean;
}
export const DirectThreadSchema: ModelSchema = {
  name: "DirectThread",
  fields: {
    pk: { type: 'str' },
    id: { type: 'str' },
    messages: { type: { list: () => DirectMessageSchema } },
    users: { type: { list: () => UserShortSchema } },
    inviter: { type: () => UserShortSchema, optional: true, default: () => (null) },
    left_users: { type: { list: () => UserShortSchema }, default: () => ([]) },
    admin_user_ids: { type: { list: 'any' } },
    last_activity_at: { type: 'datetime' },
    muted: { type: 'bool' },
    is_pin: { type: 'bool', optional: true, default: () => (null) },
    named: { type: 'bool' },
    canonical: { type: 'bool' },
    pending: { type: 'bool' },
    archived: { type: 'bool' },
    thread_type: { type: 'str' },
    thread_title: { type: 'str' },
    folder: { type: 'int' },
    vc_muted: { type: 'bool' },
    is_group: { type: 'bool' },
    mentions_muted: { type: 'bool' },
    approval_required_for_new_members: { type: 'bool' },
    input_mode: { type: 'int' },
    business_thread_folder: { type: 'int', optional: true, default: () => (null) },
    read_state: { type: 'int', optional: true, default: () => (null) },
    is_close_friend_thread: { type: 'bool', default: () => (false) },
    assigned_admin_id: { type: 'idint', optional: true, default: () => (null) },
    shh_mode_enabled: { type: 'bool', optional: true, default: () => (null) },
    last_seen_at: { type: { dict: () => LastSeenInfoSchema }, default: () => ({}) },
  },
};
const DirectThreadProto = {
  isSeen(this: DirectThread, userId: string | number | bigint): boolean {
    const uid = String(userId);
    const lastSeen = this.last_seen_at || {};
    if (!(uid in lastSeen)) return false;
    const own = lastSeen[uid].timestamp.getTime() / 1000;
    const timestamps = Object.entries(lastSeen)
      .filter(([k]) => k !== uid)
      .map(([, v]) => v.timestamp.getTime() / 1000 - own > 0);
    return !timestamps.some(Boolean);
  },
};
export function makeDirectThread(data: Record<string, any>): DirectThread {
  return Object.setPrototypeOf(parseModel<DirectThread>(DirectThreadSchema, data), DirectThreadProto);
}

export interface Relationship {
  user_id: string;
  blocking: boolean;
  followed_by: boolean;
  following: boolean;
  incoming_request: boolean;
  is_bestie: boolean;
  is_blocking_reel: boolean;
  is_muting_reel: boolean;
  is_private: boolean;
  is_restricted: boolean;
  muting: boolean;
  outgoing_request: boolean;
}
export const RelationshipSchema: ModelSchema = {
  name: "Relationship",
  fields: {
    user_id: { type: 'str' },
    blocking: { type: 'bool' },
    followed_by: { type: 'bool' },
    following: { type: 'bool' },
    incoming_request: { type: 'bool' },
    is_bestie: { type: 'bool' },
    is_blocking_reel: { type: 'bool' },
    is_muting_reel: { type: 'bool' },
    is_private: { type: 'bool' },
    is_restricted: { type: 'bool' },
    muting: { type: 'bool' },
    outgoing_request: { type: 'bool' },
  },
};
export function makeRelationship(data: Record<string, any>): Relationship {
  return parseModel<Relationship>(RelationshipSchema, data);
}

export interface Highlight {
  pk: string;
  id: string;
  latest_reel_media: number;
  cover_media: Record<string, any>;
  user: UserShort;
  title: string;
  created_at: Date;
  is_pinned_highlight: boolean;
  media_count: number;
  media_ids: Array<string>;
  items: Array<Story>;
}
export const HighlightSchema: ModelSchema = {
  name: "Highlight",
  fields: {
    pk: { type: 'str' },
    id: { type: 'str' },
    latest_reel_media: { type: 'int' },
    cover_media: { type: 'dict' },
    user: { type: () => UserShortSchema },
    title: { type: 'str' },
    created_at: { type: 'datetime' },
    is_pinned_highlight: { type: 'bool' },
    media_count: { type: 'int' },
    media_ids: { type: { list: 'idint' }, default: () => ([]) },
    items: { type: { list: () => StorySchema }, default: () => ([]) },
  },
};
export function makeHighlight(data: Record<string, any>): Highlight {
  return parseModel<Highlight>(HighlightSchema, data);
}

export interface Share {
  pk: string;
  type: string;
}
export const ShareSchema: ModelSchema = {
  name: "Share",
  fields: {
    pk: { type: 'str' },
    type: { type: 'str' },
  },
};
export function makeShare(data: Record<string, any>): Share {
  return parseModel<Share>(ShareSchema, data);
}

export interface Track {
  id: string;
  title: string;
  subtitle: string;
  display_artist: string;
  audio_cluster_id: string;
  music_canonical_id: string | null;
  artist_id: string | null;
  cover_artwork_uri: string | null;
  cover_artwork_thumbnail_uri: string | null;
  progressive_download_url: string | null;
  fast_start_progressive_download_url: string | null;
  reactive_audio_download_url: string | null;
  highlight_start_times_in_ms: Array<number>;
  is_explicit: boolean;
  dash_manifest: string;
  uri: string | null;
  has_lyrics: boolean;
  audio_asset_id: string;
  duration_in_ms: number;
  dark_message: string | null;
  allows_saving: boolean;
  territory_validity_periods: Record<string, any>;
}
export const TrackSchema: ModelSchema = {
  name: "Track",
  fields: {
    id: { type: 'str' },
    title: { type: 'str' },
    subtitle: { type: 'str' },
    display_artist: { type: 'str' },
    audio_cluster_id: { type: 'idint' },
    music_canonical_id: { type: 'str', optional: true, default: () => (null) },
    artist_id: { type: 'idint', optional: true, default: () => (null) },
    cover_artwork_uri: { type: 'url', optional: true, default: () => (null) },
    cover_artwork_thumbnail_uri: { type: 'url', optional: true, default: () => (null) },
    progressive_download_url: { type: 'url', optional: true, default: () => (null) },
    fast_start_progressive_download_url: { type: 'url', optional: true, default: () => (null) },
    reactive_audio_download_url: { type: 'url', optional: true, default: () => (null) },
    highlight_start_times_in_ms: { type: { list: 'int' } },
    is_explicit: { type: 'bool' },
    dash_manifest: { type: 'str' },
    uri: { type: 'url', optional: true, default: () => (null) },
    has_lyrics: { type: 'bool' },
    audio_asset_id: { type: 'idint' },
    duration_in_ms: { type: 'int' },
    dark_message: { type: 'str', optional: true, default: () => (null) },
    allows_saving: { type: 'bool' },
    territory_validity_periods: { type: 'dict' },
  },
};
export function makeTrack(data: Record<string, any>): Track {
  return parseModel<Track>(TrackSchema, data);
}

export interface Note {
  id: string;
  text: string;
  user_id: string;
  user: UserShort;
  audience: number;
  created_at: Date;
  expires_at: Date;
  is_emoji_only: boolean;
  has_translation: boolean;
  note_style: number;
}
export const NoteSchema: ModelSchema = {
  name: "Note",
  fields: {
    id: { type: 'str' },
    text: { type: 'str' },
    user_id: { type: 'str' },
    user: { type: () => UserShortSchema },
    audience: { type: 'int' },
    created_at: { type: 'datetime' },
    expires_at: { type: 'datetime' },
    is_emoji_only: { type: 'bool' },
    has_translation: { type: 'bool' },
    note_style: { type: 'int' },
  },
};
export function makeNote(data: Record<string, any>): Note {
  return parseModel<Note>(NoteSchema, data);
}

/** A new additional profile and its separate, confidential session settings. */
export interface SecondaryAccount {
  user: UserShort;
  settings: Record<string, any>;
}
export const SecondaryAccountSchema: ModelSchema = {
  name: "SecondaryAccount",
  fields: {
    user: { type: () => UserShortSchema },
    settings: { type: 'dict' },
  },
};
export function makeSecondaryAccount(data: Record<string, any>): SecondaryAccount {
  return parseModel<SecondaryAccount>(SecondaryAccountSchema, data);
}


/** validate_external_url: allow None, URLs or any string */
export function validateExternalUrl(v: any): any {
  if (v === null || v === undefined || typeof v === 'string') return v;
  throw new ModelValidationError('external_url', [{ loc: ['external_url'], msg: 'external_url must be a URL or string' }]);
}

/** validate_url_fields: allow None, URLs or any string */
export function validateUrlFields(v: any): any {
  if (v === null || v === undefined || typeof v === 'string') return v;
  throw new ModelValidationError('url', [{ loc: ['url'], msg: 'URL field must be a URL or string' }]);
}
