/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import { ClientBase, ClientOptions } from './clientCore';
import { guardMethods } from './boomErrors';
import { PublicRequestFeature, TopSearchesPublicFeature, ProfilePublicFeature } from '../features/webApi';
import { ChallengeResolveFeature } from '../features/securityChallenge';
import { PrivateRequestFeature } from '../features/mobileApi';
import { PrivateGraphQLRequestFeature } from '../features/graphqlRequests';
import { CrossPostingFeature } from '../features/crossPost';
import { LoginFeature, PreLoginFlowFeature, PostLoginFlowFeature } from '../features/authentication';
import { ShareFeature } from '../features/shareLinks';
import { TrackFeature } from '../features/music';
import { FbSearchFeature } from '../features/search';
import { HighlightFeature } from '../features/highlights';
import { DownloadPhotoFeature, UploadPhotoFeature } from '../features/photos';
import { DownloadVideoFeature, UploadVideoFeature } from '../features/videos';
import { DownloadAlbumFeature, UploadAlbumFeature } from '../features/carousel';
import { NotificationFeature } from '../features/notificationSettings';
import { DownloadIGTVFeature, UploadIGTVFeature } from '../features/longVideo';
import { MediaFeature } from '../features/posts';
import { UserFeature } from '../features/users';
import { InsightsFeature } from '../features/analytics';
import { CollectionFeature } from '../features/savedCollections';
import { AccountFeature } from '../features/accountSettings';
import { DirectFeature } from '../features/inbox';
import { LocationFeature } from '../features/places';
import { HashtagFeature } from '../features/hashtags';
import { CommentFeature } from '../features/comments';
import { StoryFeature } from '../features/stories';
import { PasswordFeature } from '../features/passwordCrypto';
import { SignUpFeature } from '../features/registration';
import { ClipFeature, DownloadClipFeature, UploadClipFeature } from '../features/reels';
import { ReelsFeature } from '../features/feeds';
import { ExploreFeature } from '../features/discover';
import { DeviceAttestationFeature } from '../features/deviceIntegrity';
import { BloksFeature } from '../features/bloksFlows';
import { TOTPFeature } from '../features/twoFactor';
import { MultipleAccountsFeature } from '../features/linkedAccounts';
import { NoteFeature } from '../features/notes';
import { QuickSnapFeature } from '../features/instants';
import { FundraiserFeature } from '../features/fundraisers';
import { RealtimeFeature } from '../features/realtimeConnection';
import { CaptchaHandlerFeature } from '../features/captchaSolver';

/**
 * Instagram Private API client.
 *
 * All feature methods are installed on the prototype; the interface merge below gives
 * full typing (`client.userInfo(...)`, `client.directSend(...)`, ...).
 */
// prettier-ignore
export interface Client extends PublicRequestFeature,
  ChallengeResolveFeature,
  PrivateRequestFeature,
  PrivateGraphQLRequestFeature,
  CrossPostingFeature,
  TopSearchesPublicFeature,
  ProfilePublicFeature,
  LoginFeature,
  PreLoginFlowFeature,
  PostLoginFlowFeature,
  ShareFeature,
  TrackFeature,
  FbSearchFeature,
  HighlightFeature,
  DownloadPhotoFeature,
  UploadPhotoFeature,
  DownloadVideoFeature,
  UploadVideoFeature,
  DownloadAlbumFeature,
  NotificationFeature,
  UploadAlbumFeature,
  DownloadIGTVFeature,
  UploadIGTVFeature,
  MediaFeature,
  UserFeature,
  InsightsFeature,
  CollectionFeature,
  AccountFeature,
  DirectFeature,
  LocationFeature,
  HashtagFeature,
  CommentFeature,
  StoryFeature,
  PasswordFeature,
  SignUpFeature,
  ClipFeature,
  DownloadClipFeature,
  UploadClipFeature,
  ReelsFeature,
  ExploreFeature,
  DeviceAttestationFeature,
  BloksFeature,
  TOTPFeature,
  MultipleAccountsFeature,
  NoteFeature,
  QuickSnapFeature,
  FundraiserFeature,
  RealtimeFeature,
  CaptchaHandlerFeature {}

export class Client extends ClientBase {
  constructor(options: ClientOptions = {}) {
    super(options);
  }
}

export const FEATURES = [
  PublicRequestFeature,
  ChallengeResolveFeature,
  PrivateRequestFeature,
  PrivateGraphQLRequestFeature,
  CrossPostingFeature,
  TopSearchesPublicFeature,
  ProfilePublicFeature,
  LoginFeature,
  PreLoginFlowFeature,
  PostLoginFlowFeature,
  ShareFeature,
  TrackFeature,
  FbSearchFeature,
  HighlightFeature,
  DownloadPhotoFeature,
  UploadPhotoFeature,
  DownloadVideoFeature,
  UploadVideoFeature,
  DownloadAlbumFeature,
  NotificationFeature,
  UploadAlbumFeature,
  DownloadIGTVFeature,
  UploadIGTVFeature,
  MediaFeature,
  UserFeature,
  InsightsFeature,
  CollectionFeature,
  AccountFeature,
  DirectFeature,
  LocationFeature,
  HashtagFeature,
  CommentFeature,
  StoryFeature,
  PasswordFeature,
  SignUpFeature,
  ClipFeature,
  DownloadClipFeature,
  UploadClipFeature,
  ReelsFeature,
  ExploreFeature,
  DeviceAttestationFeature,
  BloksFeature,
  TOTPFeature,
  MultipleAccountsFeature,
  NoteFeature,
  QuickSnapFeature,
  FundraiserFeature,
  RealtimeFeature,
  CaptchaHandlerFeature,
];

// The first feature in FEATURES that defines a name wins, so install in reverse order.
for (const feature of [...FEATURES].reverse()) {
  for (const name of Object.getOwnPropertyNames(feature.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(Client.prototype, name, Object.getOwnPropertyDescriptor(feature.prototype, name)!);
  }
}

// Every error thrown by a client method is a Boom error.
guardMethods(Client.prototype);
guardMethods(ClientBase.prototype);

export default Client;
