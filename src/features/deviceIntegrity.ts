import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { dumps } from '../helpers/encoding';
import type { Client } from '../core/instaClient';

// IGUSDIDRegistrationMutation in the Android 428 app profile emulated by the library.
export const USDID_REGISTRATION_CLIENT_DOC_ID = '124930351917786857261002920888';
export const USDID_TOKEN_TTL = 3600;
export const USDID_REFRESH_MARGIN = 300;
export const ATTESTATION_KEYSTORE_ERROR = -1013;

function _b64u(raw: Buffer): string {
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Device signals used by the current Android CAA login flow. */
export class DeviceAttestationFeature {
  /** Return persisted USDID key material, if it has been generated. */
  getUsdidSettings(this: Client): Record<string, any> {
    if (!this.usdidPrivateKey) return {};
    return { usdid: this.usdid, kid: this.usdidKid, private_key: this.usdidPrivateKey, registered: this.usdidRegistered };
  }

  /** Restore USDID key material and reset per-login attestation state. */
  setUsdidSettings(this: Client, settings: Record<string, any> | null = null): boolean {
    settings = settings || {};
    this.usdid = String(settings.usdid || '');
    this.usdidKid = String(settings.kid || '');
    this.usdidPrivateKey = String(settings.private_key || '');
    this.usdidRegistered = Boolean(settings.registered);
    this.attestationChallengeNonce = '';
    this.attestationKeyNonce = '';
    this._usdidHeaderCache = '';
    this._usdidHeaderExpiresAt = 0;
    if (this.private) this.private.headers.pop('X-Meta-Usdid');
    return Boolean(this.usdidPrivateKey);
  }

  /** Generate the local P-256 signing identity used by X-Meta-Usdid. */
  usdidGenerate(this: Client, force = false): string {
    if (this.usdidPrivateKey && !force) return this.usdid;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.usdidPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    this.usdid = randomUUID();
    this.usdidKid = this._usdidKeyId();
    this.usdidRegistered = false;
    this._usdidHeaderCache = '';
    this._usdidHeaderExpiresAt = 0;
    return this.usdid;
  }

  _usdidKey(this: Client) {
    if (!this.usdidPrivateKey) this.usdidGenerate();
    return createPrivateKey(this.usdidPrivateKey);
  }

  _usdidSign(this: Client, message: string): Buffer {
    return sign('sha256', Buffer.from(message), { key: this._usdidKey(), dsaEncoding: 'der' });
  }

  /** DER SubjectPublicKeyInfo for the USDID P-256 public key. */
  get usdidPublicKeyDer(): Buffer {
    const self = this as unknown as Client;
    return createPublicKey(self._usdidKey()).export({ type: 'spki', format: 'der' }) as Buffer;
  }

  /** Bind the key ID to the standard Base64-encoded SPKI public key. */
  _usdidKeyId(this: Client): string {
    const publicKey = Buffer.from(this.usdidPublicKeyDer.toString('base64'));
    return _b64u(createHash('sha256').update(publicKey).digest());
  }

  /** Build the app's three-part X-Meta-Usdid signed value. */
  usdidHeader(this: Client, ttl = USDID_TOKEN_TTL): string {
    const now = Math.trunc(Date.now() / 1000);
    if (this._usdidHeaderCache && this._usdidHeaderExpiresAt - now > USDID_REFRESH_MARGIN) return this._usdidHeaderCache;
    const expiresAt = now + ttl;
    const signedPart = `${this.usdid}.${expiresAt}`;
    const value = `${signedPart}.${_b64u(this._usdidSign(signedPart))}`;
    this._usdidHeaderCache = value;
    this._usdidHeaderExpiresAt = expiresAt;
    return value;
  }

  /** Build the ES256 registration token sent by the Android app. */
  usdidRegistrationToken(this: Client, ttl = USDID_TOKEN_TTL): string {
    this.usdidKid = this._usdidKeyId();
    const now = Math.trunc(Date.now() / 1000);
    const payload = _b64u(
      Buffer.from(
        dumps({ sub: this.usdid, iat: now, aud: this.appId, exp: now + ttl, pub: this.usdidPublicKeyDer.toString('base64'), alg: 'ES256' }),
      ),
    );
    const protectedPart = _b64u(Buffer.from(dumps({ typ: 'JWT', alg: 'ES256', kid: this.usdidKid, aid: this.appId, ver: '1' })));
    const token = {
      payload,
      signatures: [{ protected: protectedPart, signature: _b64u(this._usdidSign(`${protectedPart}.${payload}`)) }],
    };
    return _b64u(Buffer.from(dumps(token)));
  }

  /** Register the local USDID public key with Instagram. */
  async usdidRegister(this: Client, clientDocId = USDID_REGISTRATION_CLIENT_DOC_ID): Promise<boolean> {
    if (!this.usdidPrivateKey) this.usdidGenerate();
    const variables = {
      input: {
        usdid_token: { sensitive_string_value: this.usdidRegistrationToken() },
        fdid: { sensitive_string_value: this.phoneId },
      },
    };
    const result = await this.privateGraphqlWwwRequest('IGUSDIDRegistrationMutation', variables, clientDocId, undefined, {
      'X-Root-Field-Name': 'usdid_registration',
      'X-Graphql-Client-Library': 'pando',
    });
    let registration: Record<string, any> = {};
    for (const [key, value] of Object.entries(result.data || {})) {
      if (key.includes('usdid_registration') && value && typeof value === 'object' && !Array.isArray(value)) {
        registration = value as Record<string, any>;
        break;
      }
    }
    this.usdidRegistered = Boolean(registration.success);
    return this.usdidRegistered;
  }

  /** Request the server nonce used by the CAA login attestation header. */
  async attestationCreateAndroidKeystore(this: Client, keyHash = '', domain: string | null = null): Promise<any> {
    const result = await this.privateRequest(
      'attestation/create_android_keystore/',
      { app_scoped_device_id: this.uuid, key_hash: keyHash },
      {
        withSignature: false,
        headers: { 'X-FB-Friendly-Name': 'IgApi: attestation/create_android_keystore/' },
        login: true,
        ...(domain ? { domain } : {}),
      },
    );
    this.attestationChallengeNonce = String(result.challenge_nonce || '');
    this.attestationKeyNonce = String(result.key_nonce || '');
    return result;
  }

  /** Build the accepted keystore-unavailable X-IG-Attest-Params state. */
  attestationParams(this: Client, challengeNonce = ''): string {
    const nonce = challengeNonce || this.attestationChallengeNonce;
    if (!nonce) return '';
    return dumps({
      attestation: [
        { version: 2, type: 'keystore', errors: [ATTESTATION_KEYSTORE_ERROR], challenge_nonce: nonce, signed_nonce: '', key_hash: '' },
      ],
    });
  }
}
