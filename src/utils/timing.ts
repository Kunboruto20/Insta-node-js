export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
}

export function randomUniform(a: number, b: number): number {
  return a + (b - a) * Math.random();
}

/** Python random.randint (inclusive) */
export function randomInt(a: number, b: number): number {
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

export function randomChoice<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** time.strftime("%Y%m%dT%H%M%S.000Z", localtime) */
export function dateTimeOriginal(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}T${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.000Z`;
}

/** Trigger sleep of a random floating number in range min_sleep to max_sleep */
export function randomDelay(delayRange: number[]): Promise<void> {
  return sleep(randomUniform(delayRange[0], delayRange[1]));
}

/** time.time() */
export function now(): number {
  return Date.now() / 1000;
}
