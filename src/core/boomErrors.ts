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

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_SOCKET_CLOSED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

/** HTTP-like status for an error raised by Node.js or a dependency. */
function nativeStatus(err: any): number {
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? '');
  if (code === 'ENOENT' || code === 'ENOTDIR' || /input file is missing/i.test(message)) return 404;
  if (code === 'EACCES' || code === 'EPERM') return 403;
  if (/unsupported image format|corrupt|bad seek|invalid (?:jpeg|png|webp)/i.test(message)) return 415;
  if (NETWORK_CODES.has(code)) return 503;
  return 500;
}

/**
 * Return `err` as a Boom error: Boom errors are returned unchanged, other Error objects are
 * boomified in place (class, message, `code` and stack are kept), anything else is wrapped.
 */
export function toBoom(err: unknown): Boom.Boom {
  if (Boom.isBoom(err)) return err;
  if (err instanceof Error) return boomifyError(err, nativeStatus(err));
  return Boom.internal(typeof err === 'string' ? err : 'Unknown error', { value: err });
}

const GUARDED = Symbol('insta-node-js.boomGuard');

/** Wrap a returned async iterator so errors raised while iterating are Boom errors. */
async function* guardAsyncIterator<T>(iterator: AsyncIterator<T> & AsyncIterable<T>): AsyncGenerator<T> {
  try {
    return yield* iterator;
  } catch (e) {
    throw toBoom(e);
  }
}

/**
 * Wrap every method of `proto` so that any error it throws (synchronously, from a returned
 * promise, or while iterating a returned generator) is a Boom error.
 */
export function guardMethods(proto: object, skip: readonly string[] = []): void {
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor' || skip.includes(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name)!;
    const fn = descriptor.value;
    if (typeof fn !== 'function' || fn[GUARDED]) continue;
    const kind = fn.constructor?.name;
    let wrapped: any;
    if (kind === 'AsyncGeneratorFunction') {
      wrapped = async function* (this: any, ...args: any[]) {
        try {
          return yield* fn.apply(this, args);
        } catch (e) {
          throw toBoom(e);
        }
      };
    } else if (kind === 'GeneratorFunction') {
      wrapped = function* (this: any, ...args: any[]) {
        try {
          return yield* fn.apply(this, args);
        } catch (e) {
          throw toBoom(e);
        }
      };
    } else {
      wrapped = function (this: any, ...args: any[]) {
        let result: any;
        try {
          result = fn.apply(this, args);
        } catch (e) {
          throw toBoom(e);
        }
        if (result && typeof result.then === 'function') {
          return result.then(undefined, (e: unknown) => {
            throw toBoom(e);
          });
        }
        if (result && typeof result[Symbol.asyncIterator] === 'function' && typeof result.next === 'function') {
          return guardAsyncIterator(result);
        }
        return result;
      };
    }
    Object.defineProperty(wrapped, 'name', { value: fn.name });
    wrapped[GUARDED] = true;
    Object.defineProperty(proto, name, { ...descriptor, value: wrapped });
  }
}
