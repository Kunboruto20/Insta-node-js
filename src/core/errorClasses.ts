/* eslint-disable max-classes-per-file */
/**
 * Error classes.
 *
 * Some errors belong to several categories (e.g. `MediaNotFound` is both a `NotFoundError`
 * and a `MediaError`). Additional bases are registered with `registerBases` and `instanceof`
 * honours them: `err instanceof MediaError` is true for MediaNotFound.
 *
 * Every error is a Boom error (see ./errors): `err.isBoom === true` and
 * `err.output.statusCode` holds the class status (`static statusCode`), or the HTTP status
 * of the Instagram response when the class has none, or 500.
 */

import { boomifyError } from './boomErrors';

const EXTRA_BASES = new WeakMap<Function, Function[]>();

export function registerBases(cls: Function, bases: Function[]): void {
  EXTRA_BASES.set(cls, bases);
}

function isSubclass(ctor: any, target: Function): boolean {
  while (ctor && ctor !== Function.prototype) {
    if (ctor === target) return true;
    const extra = EXTRA_BASES.get(ctor);
    if (extra && extra.some((b) => isSubclass(b, target))) return true;
    ctor = Object.getPrototypeOf(ctor);
  }
  return false;
}

const RESERVED = new Set(['name', 'stack', 'constructor', 'toString']);

export class ClientError extends Error {
  static defaultMessage = '';
  static defaultReason?: string;
  /** HTTP-like status used for `err.output.statusCode` (inherited by subclasses) */
  static statusCode?: number;

  static [Symbol.hasInstance](instance: any): boolean {
    if (instance === null || (typeof instance !== 'object' && typeof instance !== 'function')) return false;
    return isSubclass(instance.constructor, this);
  }

  response: any = null;
  code: any = null;
  reason?: string;
  error_type?: string;
  [key: string]: any;

  /**
   * new ClientError(message?, fields?)
   * new ClientError(fields)  — when the only argument is a plain object
   */
  constructor(...args: any[]) {
    let extraArgs: Record<string, any> = {};
    if (args.length && isPlainObject(args[args.length - 1]) && !(args.length === 1 && args[0] instanceof Error)) {
      extraArgs = { ...args.pop() };
    }
    super();
    const ctor = new.target as any;
    this.name = ctor.name;
    if (ctor.defaultReason !== undefined) this.reason = ctor.defaultReason;
    let message: string = ctor.defaultMessage || '';
    if (args.length > 0) {
      const first = args.shift();
      message = first instanceof Error ? first.message : String(first);
    }
    this.message = message;
    for (const key of Object.keys(extraArgs)) {
      if (RESERVED.has(key)) continue;
      (this as any)[key] = extraArgs[key];
    }
    if ('message' in extraArgs) this.message = extraArgs.message === null || extraArgs.message === undefined ? '' : String(extraArgs.message);
    if (!this.message) {
      const vars: Record<string, any> = {};
      for (const k of Object.keys(this)) if (!['response', 'message', 'name', 'code', 'reason'].includes(k)) vars[k] = (this as any)[k];
      const body = this.error_type ?? safeJson(vars);
      this.message = `${this.reason ?? 'Unknown'} (${body})`;
    }
    this.code = this.response?.status_code ?? this.code;
    const status = ctor.statusCode ?? (typeof this.code === 'number' && this.code >= 400 ? this.code : 500);
    boomifyError(this, status);
  }

  /** Attach an extra note to the error (stored in `notes`). */
  addNote(note: string): void {
    (this as any).notes = [...((this as any).notes || []), note];
  }

  toString(): string {
    return this.message;
  }
}

function isPlainObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

function safeJson(v: any): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** An additional-profile flow stopped; a submitted creation must not be retried blindly. */
export class SecondaryAccountError extends ClientError {
  static statusCode = 409;
  stage!: string;
  creation_may_have_succeeded!: boolean;
  constructor(stage: string, creationMayHaveSucceeded = false) {
    let message = `Additional-profile flow stopped at ${stage}.`;
    if (creationMayHaveSucceeded) message += ' Creation may have succeeded; verify the account before trying again.';
    super(message);
    this.stage = stage;
    this.creation_may_have_succeeded = creationMayHaveSucceeded;
  }
}

export class ClientUnknownError extends ClientError {
}

export class WrongCursorError extends ClientError {
  static statusCode = 400;
  static defaultMessage = 'You specified a non-existent cursor';
}

export class ClientStatusFail extends ClientError {
}

export class ClientErrorWithTitle extends ClientError {
}

export class ResetPasswordError extends ClientError {
}

/** Sorry, there was a problem with your request */
export class GenericRequestError extends ClientError {
}

/** Raised due to graphql issues */
export class ClientGraphqlError extends ClientError {
  static statusCode = 502;
}

/** Raised due to json decoding issues */
export class ClientJSONDecodeError extends ClientError {
  static statusCode = 502;
}

/** Raised due to network connectivity-related issues */
export class ClientConnectionError extends ClientError {
  static statusCode = 503;
}

/** Raised due to a HTTP 400 response */
export class ClientBadRequestError extends ClientError {
  static statusCode = 400;
}

/** Raised due to a HTTP 401 response */
export class ClientUnauthorizedError extends ClientError {
  static statusCode = 401;
}

/** Raised due to a HTTP 403 response */
export class ClientForbiddenError extends ClientError {
  static statusCode = 403;
}

/** Raised due to a HTTP 404 response */
export class ClientNotFoundError extends ClientError {
  static statusCode = 404;
}

/** Raised due to a HTTP 429 response */
export class ClientThrottledError extends ClientError {
  static statusCode = 429;
}

/** Raised due to a HTTP 408 response */
export class ClientRequestTimeout extends ClientError {
  static statusCode = 408;
}

/** Raised due to incomplete read HTTP response */
export class ClientIncompleteReadError extends ClientError {
  static statusCode = 502;
}

/** Instagram redirect to https://www.instagram.com/accounts/login/ */
export class ClientLoginRequired extends ClientError {
  static statusCode = 401;
}

export class ReloginAttemptExceeded extends ClientError {
  static statusCode = 401;
}

/** For Private API and last_json logic */
export class PrivateError extends ClientError {
}

export class NotFoundError extends PrivateError {
  static statusCode = 404;
  static defaultReason = 'Not found';
}

export class FeedbackRequired extends PrivateError {
  static statusCode = 403;
}

/** Raised when Instagram rejects the legacy signup flow as spam. */
export class SignupSpamError extends FeedbackRequired {
}

export class ChallengeError extends PrivateError {
  static statusCode = 403;
}

export class ChallengeRedirection extends ChallengeError {
}

export class ChallengeRequired extends ChallengeError {
  static BLOKS_REDIRECT_ACTION = 'com.bloks.www.ig.challenge.redirect.async';
  declare raw_message?: string;

  constructor(...args: any[]) {
    let extraArgs: Record<string, any> | undefined;
    if (args.length && isPlainObject(args[args.length - 1])) extraArgs = { ...args.pop() };
    if (extraArgs) {
      const rawMessage = extraArgs.message;
      if (args.length && rawMessage === 'challenge_required') {
        extraArgs.raw_message = rawMessage;
        delete extraArgs.message;
      } else if (rawMessage === 'challenge_required') {
        extraArgs.raw_message = rawMessage;
        extraArgs.message = ChallengeRequired._message_for_payload(extraArgs);
      }
      super(...args, extraArgs);
    } else {
      super(...args);
    }
  }

  static _challenge_api_path(data: Record<string, any>): string {
    const challenge = data.challenge;
    if (isPlainObject(challenge)) return String(challenge.api_path || '');
    return String(data.api_path || '');
  }

  static _message_for_payload(data: Record<string, any>): string {
    const apiPath = ChallengeRequired._challenge_api_path(data);
    const stepName = data.step_name;
    const bloksAction = data.bloks_action;
    const challenge = data.challenge;
    const nativeFlow = isPlainObject(challenge) && Boolean(challenge.native_flow);
    const isLegacy = ['/challenge/', '/api/challenge/', '/api/v1/challenge/'].some((p) => apiPath.startsWith(p));

    if (apiPath.startsWith('/auth_platform/') || apiPath.startsWith('auth_platform/')) {
      return (
        'Manual verification required via Instagram auth platform flow. ' +
        'This challenge is not supported automatically; open the official Instagram app or web flow ' +
        'on a trusted device, complete the checkpoint, then retry with the same saved client settings, ' +
        'device identifiers, and proxy/IP.'
      );
    }
    if (bloksAction === ChallengeRequired.BLOKS_REDIRECT_ACTION || stepName === 'STEP_NAME') {
      return (
        'Manual verification required via Instagram Bloks redirect checkpoint. ' +
        'Confirm the login in the official Instagram app or web flow on a trusted device. ' +
        'If you keep the same client instance alive, call challengeBloksRedirectDismiss() after approval; ' +
        'otherwise retry with the same saved client settings, device identifiers, and proxy/IP.'
      );
    }
    if (nativeFlow && isLegacy) {
      return (
        'Manual verification required via Instagram native challenge flow. ' +
        'This checkpoint is not handled by challengeCodeHandler or changePasswordHandler; ' +
        'complete it in the official Instagram app or web flow on a trusted device. ' +
        'Retry with the same saved client settings, device identifiers, and proxy/IP.'
      );
    }
    if (isLegacy) {
      return (
        'Instagram returned a legacy challenge flow. Configure challengeCodeHandler or ' +
        'changePasswordHandler for supported email/SMS/password steps, or complete the checkpoint manually. ' +
        'Retry with the same saved client settings, device identifiers, and proxy/IP.'
      );
    }
    if (stepName) {
      return (
        `Instagram requires additional verification at challenge step \`${stepName}\`. ` +
        'Configure challengeCodeHandler or changePasswordHandler if this is a supported ' +
        'code/password step, or complete the checkpoint manually in the official Instagram app or web flow. ' +
        'Retry with the same saved client settings, device identifiers, and proxy/IP.'
      );
    }
    return (
      'Instagram requires additional verification for this account/session. ' +
      'Open the official Instagram app or web flow on a trusted device, complete the checkpoint there, ' +
      'then retry with the same saved client settings, device identifiers, and proxy/IP. ' +
      'Automatic challenge resolution is only available for supported code/password-reset flows; ' +
      'Bloks redirect checkpoints usually require manual approval.'
    );
  }
}

export class AccountSuspended extends ClientError {
  static statusCode = 403;
}

export class ChallengeSelfieCaptcha extends ChallengeError {
}

export class ChallengeUnknownStep extends ChallengeError {
}

export class SelectContactPointRecoveryForm extends ChallengeError {
}

export class RecaptchaChallengeForm extends ChallengeError {
}

export class SubmitPhoneNumberForm extends ChallengeError {
}

export class LegacyForceSetNewPasswordForm extends ChallengeError {
}

/** Instagram request relogin Example: {'message': 'login_required', 'response': <Response [403]>, 'error_title': "You've Been Logged Out", 'error_body': 'Please log back in.', 'logout_reason': 8, 'status': 'fail'} */
export class LoginRequired extends PrivateError {
  static statusCode = 401;
}

export class SentryBlock extends PrivateError {
  static statusCode = 403;
}

export class RateLimitError extends PrivateError {
  static statusCode = 429;
}

/** Instagram has blocked your IP address, use a quality proxy provider (not free, not shared) */
export class ProxyAddressIsBlocked extends PrivateError {
  static statusCode = 403;
}

export class BadPassword extends PrivateError {
  static statusCode = 401;
}

export class BadCredentials extends PrivateError {
  static statusCode = 401;
}

export class PleaseWaitFewMinutes extends PrivateError {
  static statusCode = 429;
}

export class UnknownError extends PrivateError {
}

/** Instagram returned HTTP 400 with error_type=needs_upgrade. */
export class ClientNeedsUpgradeError extends UnknownError {
  static statusCode = 426;
}

export class AccountEditError extends PrivateError {
}

export class AccountContactPointRequired extends AccountEditError {
  static statusCode = 400;
}

export class TrackNotFound extends NotFoundError {
}

export class MediaError extends PrivateError {
}

export class MediaNotFound extends NotFoundError {
}
registerBases(MediaNotFound, [MediaError]);

export class StoryNotFound extends NotFoundError {
}
registerBases(StoryNotFound, [MediaError]);

export class UserError extends PrivateError {
}

export class UserNotFound extends NotFoundError {
}
registerBases(UserNotFound, [UserError]);

export class CollectionError extends PrivateError {
}

export class CollectionNotFound extends NotFoundError {
}
registerBases(CollectionNotFound, [CollectionError]);

export class DirectError extends PrivateError {
}

export class DirectThreadNotFound extends NotFoundError {
}
registerBases(DirectThreadNotFound, [DirectError]);

export class DirectMessageNotFound extends NotFoundError {
}
registerBases(DirectMessageNotFound, [DirectError]);

/** Raised when recipient privacy settings reject a new Direct message request. */
export class DirectMessageRequestsDisabled extends DirectError {
  static statusCode = 403;
}

export class VideoTooLongException extends PrivateError {
  static statusCode = 400;
}

export class VideoNotDownload extends PrivateError {
}

export class VideoNotUpload extends PrivateError {
}

export class VideoConfigureError extends VideoNotUpload {
}

export class VideoConfigureStoryError extends VideoConfigureError {
}

export class PhotoNotUpload extends PrivateError {
}

export class PhotoConfigureError extends PhotoNotUpload {
}

export class PhotoConfigureStoryError extends PhotoConfigureError {
}

export class IGTVNotUpload extends PrivateError {
}

export class IGTVConfigureError extends IGTVNotUpload {
}

export class ClipNotUpload extends PrivateError {
}

export class ClipConfigureError extends ClipNotUpload {
}

export class AlbumNotDownload extends PrivateError {
}

export class AlbumUnknownFormat extends PrivateError {
  static statusCode = 400;
}

export class AlbumConfigureError extends PrivateError {
}

export class HashtagError extends PrivateError {
}

export class HashtagNotFound extends NotFoundError {
}
registerBases(HashtagNotFound, [HashtagError]);

export class LocationError extends PrivateError {
}

export class LocationNotFound extends NotFoundError {
}
registerBases(LocationNotFound, [LocationError]);

export class TwoFactorRequired extends PrivateError {
  static statusCode = 401;
}

export class HighlightNotFound extends NotFoundError {
}
registerBases(HighlightNotFound, [PrivateError]);

export class NoteNotFound extends NotFoundError {
  static defaultReason = 'Not found';
}

/** This Account is Private */
export class PrivateAccount extends PrivateError {
  static statusCode = 403;
}

/** Invalid target user */
export class InvalidTargetUser extends PrivateError {
  static statusCode = 400;
}

/** Invalid media_id */
export class InvalidMediaId extends PrivateError {
  static statusCode = 400;
}

/** Media is unavailable */
export class MediaUnavailable extends PrivateError {
  static statusCode = 404;
}

/** Comment is unavailable */
export class CommentUnavailable extends PrivateError {
  static statusCode = 404;
}

export class CommentNotFound extends PrivateError {
  static statusCode = 404;
  static defaultMessage = 'Comment not found';
}

export class CommentsDisabled extends PrivateError {
  static statusCode = 403;
  static defaultMessage = 'Comments disabled by author';
}

/** Raised by vassert() when a value check fails. */
export class ValidationError extends Error {
  constructor(message?: string) {
    super(message || 'Validation failed');
    this.name = 'ValidationError';
    boomifyError(this, 400, { code: 'INVALID_VALUE' });
  }
}

export class EmailInvalidError extends ClientError {
  static statusCode = 400;
}

export class EmailNotAvailableError extends ClientError {
  static statusCode = 409;
}

export class EmailVerificationSendError extends ClientError {
}

export class AgeEligibilityError extends ClientError {
  static statusCode = 403;
}

/** Captcha challenge required, and no solver is configured or available. */
export class CaptchaChallengeRequired extends ClientError {
  static statusCode = 403;
  challenge_details: Record<string, any>;
  constructor(
    message = 'Captcha challenge required, but no solver configured or available.',
    challengeDetails: Record<string, any> | null = null,
    extraArgs: Record<string, any> = {},
  ) {
    super(message, extraArgs);
    this.challenge_details = challengeDetails || {};
  }
}

/** Raised by user_related_profiles_gql when IG returns no related profiles. Used as a retry signal — the method raises it only if the caller has opted in by setting ``client.num_retry`` below 4; otherwise it returns an empty list. */
export class RelatedProfileRequired extends ClientError {
}
