import { randomInt } from 'node:crypto';

/**
 * Generate signature of POST data for Private API
 * e.g. "signed_body=SIGNATURE.test"
 */
export function generateSignature(data: string): string {
  return `signed_body=SIGNATURE.${quotePlus(data)}`;
}

/** Percent-encode for forms (spaces become '+') */
export function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

/** Percent-encode a URL component (characters in `safe` are kept) */
export function quote(value: string, safe = '/'): string {
  let out = encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  for (const ch of safe) out = out.split(encodeURIComponent(ch)).join(ch);
  return out;
}

const ASCII_LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

/** Gen CSRF or something else token */
export function genToken(size = 10, symbols = false): string {
  let chars = ASCII_LETTERS + DIGITS;
  if (symbols) chars += PUNCTUATION;
  let out = '';
  for (let i = 0; i < size; i++) out += chars[randomInt(chars.length)];
  return out;
}

/** Gen password */
export function genPassword(size = 10): string {
  return genToken(size);
}

export function generateJazoest(symbols: string): string {
  let amount = 0;
  for (const ch of symbols) amount += ch.codePointAt(0)!;
  return `2${amount}`;
}
