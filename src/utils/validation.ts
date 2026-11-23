import { ValidationError } from '../exceptions';

export function vassert(pred: unknown, message: string): asserts pred {
  if (!pred) throw new ValidationError(message);
}

/** Python `assert` equivalent */
export function pyAssert(pred: unknown, message = 'AssertionError'): asserts pred {
  if (!pred) throw new AssertionError(message);
}

export class AssertionError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'AssertionError';
  }
}
