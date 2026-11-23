import { boomifyError } from '../errors';
import { ValidationError } from '../exceptions';

export function vassert(pred: unknown, message: string): asserts pred {
  if (!pred) throw new ValidationError(message);
}

/** Throw an AssertionError (Boom 400, or 401 for "Login required") when `pred` is falsy */
export function ensure(pred: unknown, message = 'Assertion failed'): asserts pred {
  if (!pred) throw new AssertionError(message);
}

/** A precondition check failed (Boom 400; 401 when the message is about login). */
export class AssertionError extends Error {
  constructor(message?: string) {
    super(message || 'Assertion failed');
    this.name = 'AssertionError';
    boomifyError(this, /login required/i.test(this.message) ? 401 : 400, { code: 'INVALID_VALUE' });
  }
}
