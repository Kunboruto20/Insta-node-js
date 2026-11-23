/**
 * insta-node-js — Instagram Private API client for Node.js (TypeScript)
 * with realtime MQTT (MQTToT) and FBNS push support.
 */
import { Client } from './core/instaClient';

export { Client, FEATURES } from './core/instaClient';
export { ClientBase, ClientOptions } from './core/clientCore';
export type { ChallengeCodeHandler, ChangePasswordHandler, HandleException } from './core/clientCore';
export { ChallengeChoice } from './features/securityChallenge';
export { NoteAudience } from './features/notes';
export type { CaptchaHandler } from './features/captchaSolver';
export type { PhotoUploadOptions, StoryUploadOptions } from './features/photos';
export type { VideoUploadOptions } from './features/videos';
export type { AlbumUploadOptions } from './features/carousel';
export type { ClipUploadOptions } from './features/reels';
export type { CrosspostingOptions } from './features/crossPost';
export * from './core/errorClasses';
export { Boom, boomifyError, refreshBoom, isInvalidInput } from './core/boomErrors';
export * from './models/schemas';
export { ModelValidationError } from './models/validate';
export * as defaults from './core/defaults';
export * as parsers from './parsing/responseParsers';
export * as timezones from './helpers/timezones';
export * as accountsCenter from './features/accountsCenterFlow';
export { StoryBuilder } from './media/storyComposer';
export * as imageTools from './media/imageTools';
export * as mqtt from './mqtt';
export { RealtimeClient, FbnsClient, FbnsDeviceAuth } from './mqtt';
export * as net from './net/httpClient';
export { Session } from './net/httpClient';

// utilities
export * as signing from './helpers/signing';
export * as shortcode from './helpers/shortcode';
export * as encoding from './helpers/encoding';
export * as bigJson from './helpers/bigJson';
export * as pagination from './helpers/pagination';
export * as logger from './helpers/logger';
export * as delays from './helpers/delays';
export * as assertions from './helpers/assertions';

export const VERSION: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version as string;
  } catch {
    return '0.0.0';
  }
})();

export default Client;
