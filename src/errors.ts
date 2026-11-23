/**
 * Error handling based on @hapi/boom.
 *
 * Every error thrown by insta-node-js is a Boom error:
 *
 *   - `Boom.isBoom(err) === true` and `err instanceof Boom.Boom === true`
 *   - `err.output.statusCode` is an HTTP-like status (401 login, 404 not found, 429 rate limit, ...)
 *   - `err.output.payload` is a ready-to-send `{ statusCode, error, message }` object
 *   - `err.data` carries extra details when available
 *
 * Generic errors are created with the Boom factories (`Boom.badRequest`, `Boom.badData`,
 * `Boom.preconditionFailed`, ...). The library's own error classes (LoginRequired,
 * MediaNotFound, ...) keep working with `instanceof`: they are created as normal classes
 * and then boomified in place with `boomifyError`.
 */
import * as Boom from '@hapi/boom';

export { Boom };

/**
 * Turn an Error instance into a Boom error in place (its class and `instanceof` are kept).
 * Status codes outside 400-599 are not valid for Boom and fall back to 500.
 */
export function boomifyError<T extends Error>(err: T, statusCode = 500, data?: unknown): T & Boom.Boom {
  const code = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
  Boom.boomify(err, { statusCode: code, ...(data !== undefined ? { data } : {}), override: true });
  return err as T & Boom.Boom;
}

/** Re-sync `err.output.payload.message` after `err.message` was changed. */
export function refreshBoom(err: Error): void {
  if (Boom.isBoom(err)) err.reformat();
}

/**
 * True for errors that mean "bad input data": Boom 400 / 422 errors and native
 * TypeError / RangeError raised at runtime (e.g. reading a property of undefined in an
 * unexpected response).
 */
export function isInvalidInput(err: unknown): boolean {
  if (err instanceof TypeError || err instanceof RangeError) return true;
  return Boom.isBoom(err, 400) || Boom.isBoom(err, 422);
}
