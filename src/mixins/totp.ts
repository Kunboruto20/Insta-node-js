import { createHmac } from 'node:crypto';
import type { Client } from '../client';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Non-base32 digit found');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Base class for OTP handlers. */
export class TOTP {
  digits: number;
  digest: string;
  secret: string;
  name: string;
  issuer: string | null;
  interval = 30;

  constructor(s: string, digits = 6, digest = 'sha1', name: string | null = null, issuer: string | null = null) {
    this.digits = digits;
    this.digest = digest;
    this.secret = s;
    this.name = name || 'Secret';
    this.issuer = issuer;
  }

  /** input: the HMAC counter value (counter, or computed integer based on the Unix timestamp) */
  generateOtp(input: number): string {
    if (input < 0) throw new Error('input must be positive integer');
    const hmacHash = createHmac(this.digest, this.byteSecret()).update(TOTP.intToBytestring(input)).digest();
    const offset = hmacHash[hmacHash.length - 1] & 0xf;
    const code =
      ((hmacHash[offset] & 0x7f) << 24) |
      ((hmacHash[offset + 1] & 0xff) << 16) |
      ((hmacHash[offset + 2] & 0xff) << 8) |
      (hmacHash[offset + 3] & 0xff);
    let strCode = String(code % 10 ** this.digits);
    while (strCode.length < this.digits) strCode = '0' + strCode;
    return strCode;
  }

  byteSecret(): Buffer {
    let secret = this.secret;
    const missingPadding = secret.length % 8;
    if (missingPadding !== 0) secret += '='.repeat(8 - missingPadding);
    return base32Decode(secret);
  }

  /** Turns an integer to the OATH specified bytestring, which is fed to the HMAC along with the secret */
  static intToBytestring(i: number, padding = 8): Buffer {
    const result: number[] = [];
    let n = BigInt(i);
    while (n !== 0n) {
      result.push(Number(n & 0xffn));
      n >>= 8n;
    }
    const bytes = Buffer.from(result.reverse());
    return bytes.length >= padding ? bytes : Buffer.concat([Buffer.alloc(padding - bytes.length), bytes]);
  }

  /** Generate TOTP code */
  code(): string {
    const timecode = Math.trunc(Math.trunc(Date.now() / 1000) / this.interval);
    return this.generateOtp(timecode);
  }
}

export class TOTPMixin {
  /** Generate 2FA TOTP seed (also known as "token" and "secret key") */
  async totpGenerateSeed(this: Client): Promise<string> {
    const result = await this.privateRequest('accounts/generate_two_factor_totp_key/', this.withDefaultData({}));
    return result.totp_seed;
  }

  /** Enable TOTP 2FA. Returns backup codes */
  async totpEnable(this: Client, verificationCode: string): Promise<string[]> {
    const result = await this.privateRequest('accounts/enable_totp_two_factor/', this.withDefaultData({ verification_code: verificationCode }));
    return result.backup_codes;
  }

  /** Disable TOTP 2FA */
  async totpDisable(this: Client): Promise<boolean> {
    const result = await this.privateRequest('accounts/disable_totp_two_factor/', this.withDefaultData({}));
    return result.status === 'ok';
  }

  /** Generate 2FA TOTP code from seed (token, secret key) */
  totpGenerateCode(this: Client, seed: string): string {
    return new TOTP(seed).code();
  }
}
