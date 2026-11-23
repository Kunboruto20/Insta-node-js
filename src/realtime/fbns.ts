/**
 * FBNS (Facebook Notification Service) push client over MQTToT (mqtt-mini.facebook.com).
 */
import { randomUUID } from 'crypto';
import {
  DecodedMQTToTPacket,
  MQTToTConnection,
  MQTToTConnectionError,
  MQTToTTimeoutError,
  MQTToTTransport,
  RealtimeHandler,
  SocketMQTToTTransport,
  compressPayload,
  decodePacket,
  tryDecompressPayload,
  writeConnectPacket,
  writeDisconnectPacket,
  writePingreqPacket,
  writePubackPacket,
  writePublishPacket,
  writeSubscribePacket,
} from './mqttot';
import { dumps, pyRepr } from '../utils/serialization';
import { isDict, jsonLoads, nextPacketId } from './client';
import type { Client } from '../client';

export const FBNS_HOST = 'mqtt-mini.facebook.com';
export const IG_FBNS_APP_ID = 567310203415052;
export const FBNS_PACKAGE_NAME = 'com.instagram.android';
export const FBNS_SUBSCRIBE_TOPICS = [76, 80, 231];

export const FBNSTopics = {
  MESSAGE: '76',
  REG_REQUEST: '79',
  REG_RESPONSE: '80',
  EXP_LOGGING: '231',
  PP: '34',
} as const;

export interface FbnsDeviceAuthSettings {
  client_id: string;
  user_id: number | bigint;
  password: string;
  device_id: string;
  device_secret: string;
  server_region: string;
  region_hint: string;
  raw: Record<string, any>;
}

export class FbnsDeviceAuth {
  client_id = '';
  user_id: number | bigint = 0;
  password = '';
  device_id = '';
  device_secret = '';
  server_region = '';
  region_hint = '';
  raw: Record<string, any> = {};

  constructor(init: Partial<FbnsDeviceAuthSettings> = {}) {
    Object.assign(this, init);
    this.raw = init.raw ?? {};
  }

  static fromClient(client: Client | any): FbnsDeviceAuth {
    const settings = (client && client.settings) || {};
    const stored = settings.fbns_auth || {};
    const phoneId: string = (client && client.phoneId) || '';
    const userId = optionalInt(stored.user_id || 0);
    if (userId === null) {
      throw new RangeError(`invalid literal for int() with base 10: ${pyRepr(stored.user_id)}`);
    }
    return new FbnsDeviceAuth({
      client_id: stored.client_id || phoneId.slice(0, 20),
      user_id: userId,
      password: stored.password || '',
      device_id: stored.device_id || '',
      device_secret: stored.device_secret || '',
      server_region: stored.server_region || '',
      region_hint: stored.region_hint || '',
      raw: stored.raw || {},
    });
  }

  read(payload: Buffer | string | Record<string, any>): Record<string, any> {
    let data: Record<string, any>;
    if (Buffer.isBuffer(payload)) {
      data = !payload.length ? {} : jsonLoads(stripLengthPrefixedJson(payload));
    } else if (typeof payload === 'string') {
      data = payload ? jsonLoads(payload) : {};
    } else {
      data = { ...payload };
    }
    Object.assign(this.raw, data);
    if ('ck' in data) this.user_id = optionalInt(data.ck) || this.user_id;
    if ('cs' in data) this.password = String(data.cs || '');
    if ('di' in data) {
      this.device_id = String(data.di || '');
      this.client_id = this.device_id.slice(0, 20);
    }
    if ('ds' in data) this.device_secret = String(data.ds || '');
    if ('sr' in data) this.server_region = String(data.sr || '');
    if ('rc' in data) this.region_hint = String(data.rc || '');
    return data;
  }

  save(client: Client | any): void {
    const settings = client ? client.settings : null;
    if (settings !== null && settings !== undefined) settings.fbns_auth = this.toSettings();
  }

  toSettings(): FbnsDeviceAuthSettings {
    return {
      client_id: this.client_id,
      user_id: this.user_id,
      password: this.password,
      device_id: this.device_id,
      device_secret: this.device_secret,
      server_region: this.server_region,
      region_hint: this.region_hint,
      raw: this.raw,
    };
  }
}

export class FbnsClient {
  client: Client;
  transport: MQTToTTransport;
  auth: FbnsDeviceAuth;
  connected = false;
  _handlers: Map<string, RealtimeHandler[]> = new Map();
  _packetId = 0;

  constructor(client: Client, transport: MQTToTTransport | null = null, auth: FbnsDeviceAuth | null = null) {
    this.client = client;
    this.transport = transport || new SocketMQTToTTransport(FBNS_HOST, { proxy: (client as any).proxy ?? null });
    this.auth = auth || FbnsDeviceAuth.fromClient(client);
  }

  on(event: string, handler: RealtimeHandler): void {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event)!.push(handler);
  }

  async connect(register = true): Promise<void> {
    await this.transport.connect();
    await this._send(this.connectPacket());
    const packet = decodePacket(await this._recvPacket());
    if (packet.packet_type !== 'connack' || packet.return_code !== 0) {
      throw new MQTToTConnectionError(`FBNS MQTT connect failed: ${pyRepr(packet.return_code)}`);
    }
    this.auth.read(packet.payload);
    this.auth.save(this.client);
    await this.emit('auth', this.auth.toSettings());
    this.connected = true;
    if (register) {
      await this.subscribe(FBNSTopics.MESSAGE);
      const token = await this.registerToken();
      const response = await this.registerPushToken(token);
      await this.emit('registered', { token, response });
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.connected) {
        try {
          await this._send(writeDisconnectPacket());
        } catch {
          // suppressed
        }
      }
      await this.transport.disconnect();
    } finally {
      this.connected = false;
    }
  }

  buildConnection(): MQTToTConnection {
    const phoneId: string = this.client.phoneId || '';
    const clientId = this.auth.client_id || phoneId.slice(0, 20);
    if (!clientId) throw new Error('AssertionError: Client phone_id is required');
    const userAgent = this.client.userAgent ?? '';
    const clientInfo: Record<string, any> = {
      userId: this.auth.user_id,
      userAgent,
      clientCapabilities: 183,
      endpointCapabilities: 128,
      publishFormat: 1,
      noAutomaticForeground: true,
      makeUserAvailableInForeground: false,
      deviceId: this.auth.device_id,
      isInitiallyForeground: false,
      networkType: 1,
      networkSubtype: 0,
      clientMqttSessionId: Date.now() % 0x100000000,
      subscribeTopics: FBNS_SUBSCRIBE_TOPICS,
      clientType: 'device_auth',
      appId: IG_FBNS_APP_ID,
      deviceSecret: this.auth.device_secret,
      clientStack: 3,
      anotherUnknown: -1,
    };
    if (this.auth.password) clientInfo.fbnsConnectionSecret = this.auth.password;
    if (this.auth.device_id) clientInfo.fbnsDeviceId = this.auth.device_id;
    if (this.auth.device_secret) clientInfo.fbnsDeviceSecret = this.auth.device_secret;
    return new MQTToTConnection(clientId, clientInfo, this.auth.password);
  }

  connectPacket(): Buffer {
    return writeConnectPacket(this.buildConnection(), 60);
  }

  async subscribe(topic: string): Promise<void> {
    this._packetId = nextPacketId(this._packetId);
    await this._send(writeSubscribePacket(topic, this._packetId));
  }

  async registerToken(maxPackets = 10): Promise<string> {
    await this._publishBytes(
      FBNSTopics.REG_REQUEST,
      Buffer.from(dumps({ pkg_name: FBNS_PACKAGE_NAME, appid: IG_FBNS_APP_ID })),
    );
    for (let i = 0; i < maxPackets; i++) {
      const packet = decodePacket(await this._recvPacket());
      if (packet.packet_type !== 'publish') continue;
      if (packet.topic === FBNSTopics.REG_RESPONSE) {
        const response = FbnsClient.parsePacketPayload(packet.payload);
        await this._ack(packet);
        await this.emit('reg_response', response);
        const error = isDict(response) ? response.error : null;
        if (error) throw new Error(`FBNS registration failed: ${typeof error === 'string' ? error : pyRepr(error)}`);
        const token = isDict(response) ? response.token : null;
        if (!token) throw new Error('FBNS registration response did not include token');
        return String(token);
      }
      await this.dispatchPacket(packet.topic as string, packet.payload);
      await this._ack(packet);
    }
    throw new MQTToTTimeoutError('FBNS registration response was not received');
  }

  async registerPushToken(token: string): Promise<any> {
    const data = {
      device_type: 'android_mqtt',
      is_main_push_channel: true,
      device_sub_type: 2,
      device_token: token,
      _csrftoken: this.client.token,
      guid: this.client.uuid,
      uuid: this.client.uuid,
      users: String(this.client.userId),
      family_device_id: randomUUID(),
    };
    return this.client.privateRequest('push/register/', data, { withSignature: false });
  }

  async readOnce(): Promise<any> {
    const packet = decodePacket(await this._recvPacket());
    if (packet.packet_type !== 'publish' || packet.topic === null) return packet;
    const payload = await this.dispatchPacket(packet.topic, packet.payload);
    await this._ack(packet);
    return payload;
  }

  async ping(maxPackets = 5): Promise<boolean> {
    if (!this.connected) throw new Error('FBNS client is not connected');
    await this._send(writePingreqPacket());
    for (let i = 0; i < maxPackets; i++) {
      const packet = decodePacket(await this._recvPacket());
      if (packet.packet_type === 'pingresp') return true;
      if (packet.packet_type !== 'publish' || packet.topic === null) return false;
      await this.dispatchPacket(packet.topic, packet.payload);
      await this._ack(packet);
    }
    return false;
  }

  async dispatchPacket(topic: string, payload: Buffer): Promise<any> {
    let parsed = FbnsClient.parsePacketPayload(payload);
    if (topic === FBNSTopics.MESSAGE) parsed = await this.dispatchFbnsMessage(parsed);
    else if (topic === FBNSTopics.REG_RESPONSE) await this.emit('reg_response', parsed);
    else if (topic === FBNSTopics.EXP_LOGGING) await this.emit('logging', parsed);
    else if (topic === FBNSTopics.PP) await this.emit('pp', parsed);
    else await this.emit('message', parsed);
    await this.emit('receive', { topic, payload: parsed });
    return parsed;
  }

  async dispatchFbnsMessage(payload: any): Promise<any> {
    if (!isDict(payload)) {
      await this.emit('message', payload);
      return payload;
    }
    let push = payload.fbpushnotif;
    if (push === null || push === undefined) {
      await this.emit('message', payload);
      return payload;
    }
    if (typeof push === 'string') {
      try {
        push = jsonLoads(push);
      } catch {
        push = { value: push };
      }
    }
    await this.emit('push', push);
    if (isDict(push)) {
      const collapseKey = push.collapse_key;
      if (collapseKey) await this.emit(String(collapseKey), push);
    }
    return push;
  }

  static parsePacketPayload(payload: Buffer): any {
    const body = stripLengthPrefixedJson(payload);
    try {
      return jsonLoads(body);
    } catch {
      return body;
    }
  }

  async _publishBytes(topic: string, payload: Buffer): Promise<void> {
    this._packetId = nextPacketId(this._packetId);
    await this._send(writePublishPacket(topic, compressPayload(payload), 1, this._packetId));
  }

  async _ack(packet: DecodedMQTToTPacket): Promise<void> {
    if (packet.qos === 1 && packet.packet_id !== null) await this._send(writePubackPacket(packet.packet_id));
  }

  async _send(packet: Buffer): Promise<void> {
    try {
      await this.transport.send(packet);
    } catch (e) {
      this.connected = false;
      throw e;
    }
  }

  async _recvPacket(): Promise<Buffer> {
    try {
      return await this.transport.recvPacket();
    } catch (e) {
      if (e instanceof MQTToTTimeoutError) throw e;
      this.connected = false;
      throw e;
    }
  }

  async emit(event: string, payload: any): Promise<void> {
    for (const handler of this._handlers.get(event) || []) {
      await handler(payload);
    }
  }
}

export function optionalInt(value: any): number | bigint | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  const s = String(value).trim().replace(/_/g, '');
  if (!/^[+-]?\d+$/.test(s)) return null;
  const b = BigInt(s);
  return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
}

export function stripLengthPrefixedJson(payload: Buffer): Buffer {
  const body = tryDecompressPayload(payload);
  if (body.length < 3) return body;
  const size = body.readUInt16BE(0);
  if (size === body.length - 2 && (body[2] === 0x7b || body[2] === 0x5b)) return body.subarray(2);
  return body;
}
