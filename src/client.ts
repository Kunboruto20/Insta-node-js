/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import { ClientBase, ClientOptions } from './base';
import { PublicRequestMixin, TopSearchesPublicMixin, ProfilePublicMixin } from './mixins/public';
import { ChallengeResolveMixin } from './mixins/challenge';
import { PrivateRequestMixin } from './mixins/private';
import { PrivateGraphQLRequestMixin } from './mixins/graphql';
import { CrossPostingMixin } from './mixins/crossposting';
import { LoginMixin, PreLoginFlowMixin, PostLoginFlowMixin } from './mixins/auth';
import { ShareMixin } from './mixins/share';
import { TrackMixin } from './mixins/track';
import { FbSearchMixin } from './mixins/fbsearch';
import { HighlightMixin } from './mixins/highlight';
import { DownloadPhotoMixin, UploadPhotoMixin } from './mixins/photo';
import { DownloadVideoMixin, UploadVideoMixin } from './mixins/video';
import { DownloadAlbumMixin, UploadAlbumMixin } from './mixins/album';
import { NotificationMixin } from './mixins/notification';
import { DownloadIGTVMixin, UploadIGTVMixin } from './mixins/igtv';
import { MediaMixin } from './mixins/media';
import { UserMixin } from './mixins/user';
import { InsightsMixin } from './mixins/insights';
import { CollectionMixin } from './mixins/collection';
import { AccountMixin } from './mixins/account';
import { DirectMixin } from './mixins/direct';
import { LocationMixin } from './mixins/location';
import { HashtagMixin } from './mixins/hashtag';
import { CommentMixin } from './mixins/comment';
import { StoryMixin } from './mixins/story';
import { PasswordMixin } from './mixins/password';
import { SignUpMixin } from './mixins/signup';
import { ClipMixin, DownloadClipMixin, UploadClipMixin } from './mixins/clip';
import { ReelsMixin } from './mixins/timeline';
import { ExploreMixin } from './mixins/explore';
import { DeviceAttestationMixin } from './mixins/attestation';
import { BloksMixin } from './mixins/bloks';
import { TOTPMixin } from './mixins/totp';
import { MultipleAccountsMixin } from './mixins/multipleAccounts';
import { NoteMixin } from './mixins/note';
import { QuickSnapMixin } from './mixins/quicksnap';
import { FundraiserMixin } from './mixins/fundraiser';
import { RealtimeMixin } from './mixins/realtime';
import { CaptchaHandlerMixin } from './mixins/captcha';

/**
 * Instagram Private API client.
 *
 * All mixin methods are installed on the prototype; the interface merge below gives
 * full typing (`client.userInfo(...)`, `client.directSend(...)`, ...).
 */
// prettier-ignore
export interface Client extends PublicRequestMixin,
  ChallengeResolveMixin,
  PrivateRequestMixin,
  PrivateGraphQLRequestMixin,
  CrossPostingMixin,
  TopSearchesPublicMixin,
  ProfilePublicMixin,
  LoginMixin,
  PreLoginFlowMixin,
  PostLoginFlowMixin,
  ShareMixin,
  TrackMixin,
  FbSearchMixin,
  HighlightMixin,
  DownloadPhotoMixin,
  UploadPhotoMixin,
  DownloadVideoMixin,
  UploadVideoMixin,
  DownloadAlbumMixin,
  NotificationMixin,
  UploadAlbumMixin,
  DownloadIGTVMixin,
  UploadIGTVMixin,
  MediaMixin,
  UserMixin,
  InsightsMixin,
  CollectionMixin,
  AccountMixin,
  DirectMixin,
  LocationMixin,
  HashtagMixin,
  CommentMixin,
  StoryMixin,
  PasswordMixin,
  SignUpMixin,
  ClipMixin,
  DownloadClipMixin,
  UploadClipMixin,
  ReelsMixin,
  ExploreMixin,
  DeviceAttestationMixin,
  BloksMixin,
  TOTPMixin,
  MultipleAccountsMixin,
  NoteMixin,
  QuickSnapMixin,
  FundraiserMixin,
  RealtimeMixin,
  CaptchaHandlerMixin {}

export class Client extends ClientBase {
  constructor(options: ClientOptions = {}) {
    super(options);
  }
}

export const MIXINS = [
  PublicRequestMixin,
  ChallengeResolveMixin,
  PrivateRequestMixin,
  PrivateGraphQLRequestMixin,
  CrossPostingMixin,
  TopSearchesPublicMixin,
  ProfilePublicMixin,
  LoginMixin,
  PreLoginFlowMixin,
  PostLoginFlowMixin,
  ShareMixin,
  TrackMixin,
  FbSearchMixin,
  HighlightMixin,
  DownloadPhotoMixin,
  UploadPhotoMixin,
  DownloadVideoMixin,
  UploadVideoMixin,
  DownloadAlbumMixin,
  NotificationMixin,
  UploadAlbumMixin,
  DownloadIGTVMixin,
  UploadIGTVMixin,
  MediaMixin,
  UserMixin,
  InsightsMixin,
  CollectionMixin,
  AccountMixin,
  DirectMixin,
  LocationMixin,
  HashtagMixin,
  CommentMixin,
  StoryMixin,
  PasswordMixin,
  SignUpMixin,
  ClipMixin,
  DownloadClipMixin,
  UploadClipMixin,
  ReelsMixin,
  ExploreMixin,
  DeviceAttestationMixin,
  BloksMixin,
  TOTPMixin,
  MultipleAccountsMixin,
  NoteMixin,
  QuickSnapMixin,
  FundraiserMixin,
  RealtimeMixin,
  CaptchaHandlerMixin,
];

// The first mixin in MIXINS that defines a name wins, so install in reverse order.
for (const mixin of [...MIXINS].reverse()) {
  for (const name of Object.getOwnPropertyNames(mixin.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(Client.prototype, name, Object.getOwnPropertyDescriptor(mixin.prototype, name)!);
  }
}

export default Client;
