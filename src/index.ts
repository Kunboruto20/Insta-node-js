/**
 * insta-node-js — Instagram Private API client for Node.js (TypeScript)
 * with realtime MQTT (MQTToT) and FBNS push support.
 */
import { Client } from './client';

export { Client, MIXINS } from './client';
export { ClientBase, ClientOptions } from './base';
export type { ChallengeCodeHandler, ChangePasswordHandler, HandleException } from './base';
export { ChallengeChoice } from './mixins/challenge';
export { NoteAudience } from './mixins/note';
export type { CaptchaHandler } from './mixins/captcha';
export type { PhotoUploadOptions, StoryUploadOptions } from './mixins/photo';
export type { VideoUploadOptions } from './mixins/video';
export type { AlbumUploadOptions } from './mixins/album';
export type { ClipUploadOptions } from './mixins/clip';
export type { CrosspostingOptions } from './mixins/crossposting';
export * from './exceptions';
export { Boom, boomifyError, refreshBoom, isInvalidInput } from './errors';
export * from './types';
export { ModelValidationError } from './models/validator';
export * as config from './config';
export * as extractors from './extractors';
export * as zones from './zones';
export * as secondary from './secondary';
export { StoryBuilder } from './story';
export * as imageUtil from './imageUtil';
export * as realtime from './realtime';
export { RealtimeClient, FbnsClient, FbnsDeviceAuth } from './realtime';
export * as http from './http/session';
export { Session } from './http/session';

// utilities
export * as utils from './utils/auth';
export * as ids from './utils/ids';
export * as serialization from './utils/serialization';
export * as json from './utils/json';
export * as iterators from './utils/iterators';
export * as logging from './utils/logging';
export * as timing from './utils/timing';
export * as validation from './utils/validation';

export const VERSION: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version as string;
  } catch {
    return '0.0.0';
  }
})();

export default Client;
