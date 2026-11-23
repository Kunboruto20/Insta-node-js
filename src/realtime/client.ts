/**
 * Instagram realtime (edge-mqtt.facebook.com) MQTToT client.
 */
import * as Boom from '@hapi/boom';
import { randomUUID } from 'crypto';
import {
  MQTToTConnection,
  MQTToTConnectionError,
  MQTToTTopics,
  MQTToTTransport,
  RealtimeHandler,
  SocketMQTToTTransport,
  ThriftDescriptor,
  ThriftTypes,
  compressPayload,
  decodePacket,
  decodeUtf8Strict,
  parseJsonPayload,
  tryDecompressPayload,
  writeConnectPacket,
  writeDisconnectPacket,
  writePingreqPacket,
  writePubackPacket,
  writePublishPacket,
  writeThriftObject,
} from './mqttot';
import { parseJson } from '../utils/json';
import { dumps, jsonDumps, reprValue } from '../utils/serialization';
import type { Client } from '../client';

export const REALTIME_HOST = 'edge-mqtt.facebook.com';
export const IG_REALTIME_APP_ID = 567067343352427;
export const REALTIME_SUBSCRIBE_TOPICS = [88, 135, 149, 150, 133, 146];

export function isDict(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);
}

/** Parse JSON from a string or Buffer (big integers kept exact) */
export function jsonLoads(value: string | Buffer): any {
  return parseJson(typeof value === 'string' ? value : decodeUtf8Strict(value));
}

export function sortKeysDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isDict(value)) {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

export function nextPacketId(current: number): number {
  return current >= 0xffff ? 1 : current + 1;
}

export class RealtimeClient {
  client: Client;
  transport: MQTToTTransport;
  connected = false;
  _handlers: Map<string, RealtimeHandler[]> = new Map();
  _packetId = 0;

  constructor(client: Client, transport: MQTToTTransport | null = null) {
    this.client = client;
    this.transport = transport || new SocketMQTToTTransport(REALTIME_HOST, { proxy: (client as any).proxy ?? null });
    this.connected = false;
    this._handlers = new Map();
    this._packetId = 0;
  }

  on(event: string, handler: RealtimeHandler): void {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event)!.push(handler);
  }

  async connect(): Promise<void> {
    await this.transport.connect();
    if (this.transport instanceof SocketMQTToTTransport) {
      await this.transport.send(writeConnectPacket(this.buildConnection()));
      const packet = decodePacket(await this.transport.recvPacket());
      if (packet.packet_type !== 'connack' || packet.return_code !== 0) {
        throw new MQTToTConnectionError(`Realtime MQTT connect failed: ${reprValue(packet.return_code)}`);
      }
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.transport instanceof SocketMQTToTTransport && this.connected) {
      await this.transport.send(writeDisconnectPacket());
    }
    await this.transport.disconnect();
    this.connected = false;
  }

  buildConnection(): MQTToTConnection {
    const sessionid = this.client.sessionid;
    if (!sessionid) throw Boom.unauthorized('Login required');
    const deviceId = this.client.phoneId;
    if (!deviceId) throw Boom.preconditionFailed('Client phoneId is required');
    const userAgent = this.client.userAgent;
    const appVersion = this.clientAppVersion();
    const capabilities = (this.client as any).capabilities ?? '3brTv10=';
    const locale: string = (this.client as any).locale ?? 'en_US';
    const userId = this.client.userIdInt;
    if (userId === null || userId === undefined) {
      throw Boom.unauthorized('Login required: user id is missing');
    }
    return new MQTToTConnection(
      deviceId.slice(0, 20),
      {
        userId,
        userAgent,
        clientCapabilities: 183,
        endpointCapabilities: 0,
        publishFormat: 1,
        noAutomaticForeground: false,
        makeUserAvailableInForeground: true,
        deviceId,
        isInitiallyForeground: true,
        networkType: 1,
        networkSubtype: 0,
        clientMqttSessionId: Date.now() % 0x100000000,
        subscribeTopics: REALTIME_SUBSCRIBE_TOPICS,
        clientType: 'cookie_auth',
        appId: IG_REALTIME_APP_ID,
        deviceSecret: '',
        clientStack: 3,
      },
      `sessionid=${sessionid}`,
      {
        app_version: appVersion,
        'X-IG-Capabilities': capabilities,
        everclear_subscriptions: dumps({
          inapp_notification_subscribe_comment: '17899377895239777',
          inapp_notification_subscribe_comment_mention_and_reply: '17899377895239777',
          video_call_participant_state_delivery: '17977239895057311',
          presence_subscribe: '17846944882223835',
        }),
        'User-Agent': String(userAgent),
        'Accept-Language': locale.replace(/_/g, '-'),
        platform: 'android',
        ig_mqtt_route: 'django',
        pubsub_msg_type_blacklist: 'direct, typing_type',
        auth_cache_enabled: '0',
      },
    );
  }

  async graphQlSubscribe(subscriptions: string | Iterable<string>): Promise<void> {
    const subs = typeof subscriptions === 'string' ? [subscriptions] : [...subscriptions];
    await this.publishJson(MQTToTTopics.REALTIME_SUB, { sub: subs });
  }

  async skywalkerSubscribe(subscriptions: string | Iterable<string>): Promise<void> {
    const subs = typeof subscriptions === 'string' ? [subscriptions] : [...subscriptions];
    await this.publishJson(MQTToTTopics.PUBSUB, { sub: subs });
  }

  async irisSubscribe(seqId: number | bigint | string, snapshotAtMs: number | bigint | string, snapshotAppVersion: string | null = null): Promise<void> {
    await this.publishJson(MQTToTTopics.IRIS_SUB, {
      seq_id: seqId,
      snapshot_at_ms: snapshotAtMs,
      snapshot_app_version: snapshotAppVersion || this.clientAppVersion(),
    });
  }

  async directSubscribe(amount = 1): Promise<{ seq_id: any; snapshot_at_ms: any }> {
    await this.client.directThreads(amount);
    const last = this.client.lastJson || {};
    const seqId = last.seq_id;
    const snapshotAtMs = last.snapshot_at_ms;
    if (seqId === undefined || seqId === null || snapshotAtMs === undefined || snapshotAtMs === null) {
      throw Boom.badGateway('Direct inbox did not return realtime sync state');
    }
    const state = { seq_id: seqId, snapshot_at_ms: snapshotAtMs };
    await this.irisSubscribe(state.seq_id, state.snapshot_at_ms);
    return state;
  }

  async directSendText(threadId: number | bigint | string, text: string, clientContext: string | null = null): Promise<Record<string, any>> {
    return this._publishDirectCommand(
      'send_item',
      threadId,
      { item_type: 'text', text },
      clientContext || RealtimeClient.newClientContext(),
    );
  }

  async directSendReaction(
    threadId: number | bigint | string,
    itemId: string,
    emoji = '',
    reactionType = 'like',
    reactionStatus = 'created',
    targetItemType = 'text',
    clientContext: string | null = null,
  ): Promise<Record<string, any>> {
    return this._publishDirectCommand(
      'send_item',
      threadId,
      {
        item_type: 'reaction',
        item_id: itemId,
        node_type: 'item',
        reaction_type: reactionType,
        reaction_status: reactionStatus,
        target_item_type: targetItemType,
        emoji,
      },
      clientContext || RealtimeClient.newClientContext(),
    );
  }

  async directMarkSeen(threadId: number | bigint | string, itemId: string): Promise<Record<string, any>> {
    return this._publishDirectCommand('mark_seen', threadId, { item_id: itemId });
  }

  async directIndicateActivity(
    threadId: number | bigint | string,
    isActive = true,
    clientContext: string | null = null,
  ): Promise<Record<string, any>> {
    return this._publishDirectCommand(
      'indicate_activity',
      threadId,
      { activity_status: isActive ? '1' : '0' },
      clientContext || RealtimeClient.newClientContext(),
    );
  }

  async sendForegroundState(
    opts: {
      inForegroundApp?: boolean | null;
      inForegroundDevice?: boolean | null;
      keepAliveTimeout?: number | null;
      subscribeTopics?: string[] | null;
      subscribeGenericTopics?: string[] | null;
      unsubscribeTopics?: string[] | null;
      unsubscribeGenericTopics?: string[] | null;
      requestId?: number | bigint | null;
    } = {},
  ): Promise<Record<string, any>> {
    const full: Record<string, any> = {
      inForegroundApp: opts.inForegroundApp,
      inForegroundDevice: opts.inForegroundDevice,
      keepAliveTimeout: opts.keepAliveTimeout,
      subscribeTopics: opts.subscribeTopics,
      subscribeGenericTopics: opts.subscribeGenericTopics,
      unsubscribeTopics: opts.unsubscribeTopics,
      unsubscribeGenericTopics: opts.unsubscribeGenericTopics,
      requestId: opts.requestId,
    };
    const state: Record<string, any> = {};
    for (const [k, v] of Object.entries(full)) if (v !== null && v !== undefined) state[k] = v;
    await this._publishBytes(
      MQTToTTopics.FOREGROUND_STATE,
      compressPayload(Buffer.concat([Buffer.from([0]), writeThriftObject(state, RealtimeClient.foregroundStateDescriptors())])),
    );
    return state;
  }

  async _publishDirectCommand(
    action: string,
    threadId: number | bigint | string,
    data: Record<string, any>,
    clientContext: string | null = null,
  ): Promise<Record<string, any>> {
    const payload: Record<string, any> = { action, thread_id: String(threadId), ...data };
    if (clientContext) payload.client_context = clientContext;
    await this._publishBytes(MQTToTTopics.SEND_MESSAGE, compressPayload(Buffer.from(dumps(payload))));
    const state: Record<string, any> = { thread_id: String(threadId), action };
    if (clientContext) state.client_context = clientContext;
    return state;
  }

  async publishJson(topic: string, data: Record<string, any>): Promise<void> {
    await this._publishBytes(topic, compressPayload(Buffer.from(dumps(data))));
  }

  async _publishBytes(topic: string, payload: Buffer): Promise<void> {
    this._packetId = nextPacketId(this._packetId);
    const packet = writePublishPacket(topic, payload, 1, this._packetId);
    await this.transport.send(packet);
  }

  async readOnce(): Promise<any> {
    const packet = decodePacket(await this.transport.recvPacket());
    if (packet.packet_type !== 'publish') return packet;
    if (packet.topic === null) return packet;
    const payload = await this.dispatchPacket(packet.topic, packet.payload);
    if (packet.qos === 1 && packet.packet_id !== null) {
      await this.transport.send(writePubackPacket(packet.packet_id));
    }
    return payload;
  }

  async ping(maxPackets = 5): Promise<boolean> {
    if (!this.connected) throw Boom.preconditionFailed('Realtime client is not connected');
    await this.transport.send(writePingreqPacket());
    for (let i = 0; i < maxPackets; i++) {
      const packet = decodePacket(await this.transport.recvPacket());
      if (packet.packet_type === 'pingresp') return true;
      if (packet.packet_type !== 'publish' || packet.topic === null) return false;
      await this.dispatchPacket(packet.topic, packet.payload);
      if (packet.qos === 1 && packet.packet_id !== null) {
        await this.transport.send(writePubackPacket(packet.packet_id));
      }
    }
    return false;
  }

  async dispatchPacket(topic: string, payload: Buffer): Promise<any> {
    const body = tryDecompressPayload(payload);
    let parsed: any = null;
    if (
      [
        MQTToTTopics.SEND_MESSAGE_RESPONSE,
        MQTToTTopics.IRIS_SUB_RESPONSE,
        MQTToTTopics.REALTIME_SUB,
        MQTToTTopics.MESSAGE_SYNC,
      ].includes(topic as any)
    ) {
      try {
        parsed = jsonLoads(body);
      } catch {
        parsed = body;
      }
    } else {
      try {
        parsed = parseJsonPayload(payload);
      } catch {
        parsed = body;
      }
    }
    await this.emit('receive', { topic, payload: parsed });
    if (topic === MQTToTTopics.SEND_MESSAGE_RESPONSE) await this.emit('send_response', parsed);
    if (topic === MQTToTTopics.IRIS_SUB_RESPONSE) await this.emit('iris_sub_response', parsed);
    if (topic === MQTToTTopics.MESSAGE_SYNC) await this.dispatchMessageSync(parsed);
    if (topic === MQTToTTopics.REALTIME_SUB) await this.dispatchRealtimeSub(parsed);
    return parsed;
  }

  async dispatchMessageSync(payload: any): Promise<void> {
    if (!Array.isArray(payload)) {
      await this.emit('message', payload);
      return;
    }
    for (const item of payload) {
      if (!isDict(item)) {
        await this.emit('iris', item);
        continue;
      }
      const patches = item.data;
      if (!Array.isArray(patches)) {
        await this.emit('iris', item);
        continue;
      }
      const meta: Record<string, any> = {};
      for (const [k, v] of Object.entries(item)) if (k !== 'data') meta[k] = v;
      for (const patch of patches) {
        if (!isDict(patch)) {
          await this.emit('iris', { ...meta, data: patch });
          continue;
        }
        const path = patch.path;
        const rawValue = patch.value;
        if (!path || rawValue === null || rawValue === undefined) {
          await this.emit('iris', { ...meta, ...patch });
          continue;
        }
        let value: any;
        if (typeof rawValue === 'string') {
          try {
            value = jsonLoads(rawValue);
          } catch {
            value = { value: rawValue };
          }
        } else {
          value = rawValue;
        }
        const wrapper = {
          ...meta,
          message: {
            path,
            op: patch.op ?? null,
            thread_id: RealtimeClient.threadIdFromMessageSyncPath(path),
            ...(isDict(value) ? value : { value }),
          },
        };
        if (String(path).startsWith('/direct_v2/threads/')) await this.emit('message', wrapper);
        else await this.emit('thread_update', wrapper);
        await this.dispatchDirectRealtimeEvent({ path, op: patch.op ?? null, value });
      }
    }
  }

  async dispatchRealtimeSub(payload: any): Promise<void> {
    await this.emit('realtime_sub', payload);
    if (!isDict(payload)) return;
    const message = payload.message;
    if (typeof message === 'string') {
      let decoded: any;
      try {
        decoded = jsonLoads(message);
      } catch {
        return;
      }
      await this.dispatchDirectRealtimePayload(decoded);
      return;
    }
    if (!isDict(message)) return;
    if (message.topic !== 'direct') return;
    let directPayload = message.json || message.payload;
    if (typeof directPayload === 'string') {
      try {
        directPayload = jsonLoads(directPayload);
      } catch {
        directPayload = { value: directPayload };
      }
    }
    await this.dispatchDirectRealtimePayload(directPayload);
  }

  async dispatchDirectRealtimePayload(payload: any): Promise<void> {
    if (!isDict(payload)) {
      await this.dispatchDirectRealtimeEvent({ value: payload ?? null });
      return;
    }
    const data = payload.data;
    if (!Array.isArray(data)) {
      await this.dispatchDirectRealtimeEvent(payload);
      return;
    }
    const meta: Record<string, any> = {};
    for (const [k, v] of Object.entries(payload)) if (k !== 'data') meta[k] = v;
    for (const item of data) {
      if (isDict(item)) await this.dispatchDirectRealtimeEvent({ ...meta, ...item });
      else await this.dispatchDirectRealtimeEvent({ ...meta, value: item });
    }
  }

  async dispatchDirectRealtimeEvent(event: Record<string, any>): Promise<void> {
    event = { ...event };
    let value = event.value ?? null;
    if (typeof value === 'string') {
      try {
        value = jsonLoads(value);
      } catch {
        // keep raw string
      }
    }
    event.value = value;
    const path = event.path;
    if (path && !('thread_id' in event)) event.thread_id = RealtimeClient.threadIdFromMessageSyncPath(path);
    await this.emit('direct', event);
    const kind = RealtimeClient.directRealtimeEventKind(event);
    if (kind) await this.emit(kind, event);
  }

  static directRealtimeEventKind(event: Record<string, any>): string | null {
    const path = textValue(event.path || '').toLowerCase();
    const action = textValue(event.action || '').toLowerCase();
    const value = event.value ?? null;
    const valueText = (isDict(value) ? jsonDumps(sortKeysDeep(value)) : textValue(value)).toLowerCase();
    if (valueText.includes('activity_status') || path.includes('activity_indicator') || path.includes('typing')) {
      return 'typing';
    }
    if (path.includes('presence') || valueText.includes('is_active') || valueText.includes('last_active')) {
      return 'presence';
    }
    if (
      action === 'mark_seen' ||
      path.includes('/seen') ||
      path.includes('seen_') ||
      path.includes('read') ||
      valueText.includes('seen')
    ) {
      return 'seen';
    }
    return null;
  }

  static threadIdFromMessageSyncPath(path: string): string | null {
    let prefix = '/direct_v2/threads/';
    if (path.startsWith(prefix)) return path.slice(prefix.length).split('/', 1)[0];
    prefix = '/direct_v2/inbox/threads/';
    if (path.startsWith(prefix)) return path.slice(prefix.length).split('/', 1)[0];
    return null;
  }

  clientAppVersion(): string {
    const deviceSettings = (this.client as any).deviceSettings || {};
    return (this.client as any).app_version || (this.client as any).appVersion || deviceSettings.app_version || '';
  }

  static foregroundStateDescriptors(): ThriftDescriptor[] {
    return [
      ThriftDescriptor('inForegroundApp', 1, ThriftTypes.BOOLEAN),
      ThriftDescriptor('inForegroundDevice', 2, ThriftTypes.BOOLEAN),
      ThriftDescriptor('keepAliveTimeout', 3, ThriftTypes.INT_32),
      ThriftDescriptor('subscribeTopics', 4, ThriftTypes.LIST_BINARY),
      ThriftDescriptor('subscribeGenericTopics', 5, ThriftTypes.LIST_BINARY),
      ThriftDescriptor('unsubscribeTopics', 6, ThriftTypes.LIST_BINARY),
      ThriftDescriptor('unsubscribeGenericTopics', 7, ThriftTypes.LIST_BINARY),
      ThriftDescriptor('requestId', 8, ThriftTypes.INT_64),
    ];
  }

  static newClientContext(): string {
    return randomUUID();
  }

  async emit(event: string, payload: any): Promise<void> {
    for (const handler of this._handlers.get(event) || []) {
      await handler(payload);
    }
  }
}

/** Text form of a value (strings as-is, other values via reprValue) */
export function textValue(value: any): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return `b${reprValue(value.toString('latin1'))}`;
  return reprValue(value);
}
