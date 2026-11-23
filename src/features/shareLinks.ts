import * as Boom from '@hapi/boom';
import { Share, makeShare } from '../models/schemas';
import type { Client } from '../core/instaClient';

export class ShareFeature {
  /** Get Share object by code */
  shareInfo(this: Client, code: string | Buffer): Share {
    const raw = typeof code === 'string' ? Buffer.from(code) : code;
    // ignore example from instagram: b'highli\xb1\xdb\x1dght:17988089629383770'
    const decoded = Buffer.from(raw.toString('latin1'), 'base64');
    const text = decodeUtf8Ignore(decoded).replace(/\x1d/g, '');
    const data = text.split(':');
    return makeShare({ type: data[0], pk: data[1] });
  }

  /** Get Share object by URL */
  shareInfoByUrl(this: Client, url: string): Share {
    return this.shareInfo(this.shareCodeFromUrl(url));
  }

  /** Get Share code from URL */
  shareCodeFromUrl(this: Client, url: string): string {
    const path = new URL(url, 'http://placeholder').pathname;
    const parts = path.split('/').filter((p) => p);
    const last = parts.pop();
    if (last === undefined) throw Boom.badRequest('Invalid share URL');
    return last;
  }
}

/** bytes.decode("utf-8", errors="ignore") */
function decodeUtf8Ignore(buf: Buffer): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/�/g, '');
}
