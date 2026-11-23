import { constants, createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';
import { ClientError } from '../exceptions';
import { HTTPError } from '../http/session';
import type { Client } from '../client';

export class PasswordMixin {
  async passwordEncrypt(this: Client, password: string): Promise<string> {
    const [publickeyid, publickey] = await this.passwordPublickeys();
    const sessionKey = randomBytes(32);
    const iv = randomBytes(12);
    const timestamp = String(Math.trunc(Date.now() / 1000));
    const decodedPublickey = Buffer.from(publickey, 'base64').toString('utf8');
    const rsaEncrypted = publicEncrypt({ key: decodedPublickey, padding: constants.RSA_PKCS1_PADDING }, sessionKey);
    const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
    cipher.setAAD(Buffer.from(timestamp));
    const aesEncrypted = Buffer.concat([cipher.update(Buffer.from(password, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const sizeBuffer = Buffer.alloc(2);
    sizeBuffer.writeUInt16LE(rsaEncrypted.length);
    const payload = Buffer.concat([Buffer.from([1, publickeyid & 0xff]), iv, sizeBuffer, rsaEncrypted, tag, aesEncrypted]).toString('base64');
    return `#PWD_INSTAGRAM:4:${timestamp}:${payload}`;
  }

  async passwordPublickeys(this: Client): Promise<[number, string]> {
    let failure: unknown = null;
    try {
      // Inspect the first response before retry/challenge handling can replace it.
      this.privateRequestsCount += 1;
      await this._sendPrivateRequest(
        'launcher/sync/',
        { id: this.uuid, server_config_retrieval: '1' },
        { login: true, headers: this.authorization ? { Authorization: this.authorization } : null, returnResponse: true },
      );
    } catch (error) {
      if (error instanceof ClientError) failure = error;
      else throw error;
    }
    const headers = this.lastResponse ? this.lastResponse.headers : null;
    const publickeyid = headers?.get('ig-set-password-encryption-key-id');
    const publickey = headers?.get('ig-set-password-encryption-pub-key');
    if (!publickeyid || !publickey) {
      if (this.lastResponse) {
        try {
          this.lastResponse.raise_for_status();
        } catch (error) {
          if (error instanceof HTTPError) failure = error;
          else throw error;
        }
      }
      throw new ClientError('Instagram did not return the password encryption key', { response: this.lastResponse, cause: failure });
    }
    return [parseInt(publickeyid, 10), publickey];
  }
}
