/**
 * MQTToT (MQTT over Thrift) protocol used by Instagram realtime and FBNS.
 *
 * Pure Node implementation: `net`/`tls` sockets, `zlib` and a Thrift compact
 * protocol writer/reader. No external MQTT library is required.
 */
import * as net from 'net';
import * as tls from 'tls';
import * as zlib from 'zlib';
import { parseJson } from '../utils/json';

export const MQTToTTopics = {
  PUBSUB: '88',
  FOREGROUND_STATE: '102',
  SEND_MESSAGE: '132',
  SEND_MESSAGE_RESPONSE: '133',
  IRIS_SUB: '134',
  IRIS_SUB_RESPONSE: '135',
  MESSAGE_SYNC: '146',
  REALTIME_SUB: '149',
  REGION_HINT: '150',
} as const;

export const ThriftTypes = {
  STOP: 0x00,
  TRUE: 0x01,
  FALSE: 0x02,
  BYTE: 0x03,
  INT_16: 0x04,
  INT_32: 0x05,
  INT_64: 0x06,
  BINARY: 0x08,
  LIST: 0x09,
  MAP: 0x0b,
  STRUCT: 0x0c,
  BOOLEAN: 0xa1,
  LIST_INT_32: (0x05 << 8) | 0x09,
  LIST_BINARY: (0x08 << 8) | 0x09,
  MAP_BINARY_BINARY: (0x88 << 8) | 0x0b,
} as const;

export interface ThriftDescriptor {
  readonly name: string;
  readonly field: number;
  readonly type: number;
  readonly children: readonly ThriftDescriptor[];
}

export function ThriftDescriptor(
  name: string,
  field: number,
  type: number,
  children: readonly ThriftDescriptor[] = [],
): ThriftDescriptor {
  return Object.freeze({ name, field, type, children: Object.freeze([...children]) });
}

export class DecodedMQTToTPacket {
  packet_type: string;
  payload: Buffer;
  protocol_name: string | null = null;
  protocol_level: number | null = null;
  connect_flags: number | null = null;
  keep_alive: number | null = null;
  topic: string | null = null;
  qos = 0;
  packet_id: number | null = null;
  return_code: number | null = null;

  constructor(init: Partial<DecodedMQTToTPacket> & { packet_type: string; payload: Buffer }) {
    this.packet_type = init.packet_type;
    this.payload = init.payload;
    Object.assign(this, init);
  }
}

export class MQTToTConnection {
  client_identifier: string;
  client_info: Record<string, any>;
  password: string;
  app_specific_info: Record<string, string> | null;

  constructor(
    client_identifier: string,
    client_info: Record<string, any>,
    password: string,
    app_specific_info: Record<string, string> | null = null,
  ) {
    this.client_identifier = client_identifier;
    this.client_info = client_info;
    this.password = password;
    this.app_specific_info = app_specific_info;
  }

  static thriftDescriptors(): ThriftDescriptor[] {
    const T = ThriftTypes;
    return [
      ThriftDescriptor('clientIdentifier', 1, T.BINARY),
      ThriftDescriptor('willTopic', 2, T.BINARY),
      ThriftDescriptor('willMessage', 3, T.BINARY),
      ThriftDescriptor('clientInfo', 4, T.STRUCT, [
        ThriftDescriptor('userId', 1, T.INT_64),
        ThriftDescriptor('userAgent', 2, T.BINARY),
        ThriftDescriptor('clientCapabilities', 3, T.INT_64),
        ThriftDescriptor('endpointCapabilities', 4, T.INT_64),
        ThriftDescriptor('publishFormat', 5, T.INT_32),
        ThriftDescriptor('noAutomaticForeground', 6, T.BOOLEAN),
        ThriftDescriptor('makeUserAvailableInForeground', 7, T.BOOLEAN),
        ThriftDescriptor('deviceId', 8, T.BINARY),
        ThriftDescriptor('isInitiallyForeground', 9, T.BOOLEAN),
        ThriftDescriptor('networkType', 10, T.INT_32),
        ThriftDescriptor('networkSubtype', 11, T.INT_32),
        ThriftDescriptor('clientMqttSessionId', 12, T.INT_64),
        ThriftDescriptor('clientIpAddress', 13, T.BINARY),
        ThriftDescriptor('subscribeTopics', 14, T.LIST_INT_32),
        ThriftDescriptor('clientType', 15, T.BINARY),
        ThriftDescriptor('appId', 16, T.INT_64),
        ThriftDescriptor('overrideNectarLogging', 17, T.BOOLEAN),
        ThriftDescriptor('connectTokenHash', 18, T.BINARY),
        ThriftDescriptor('regionPreference', 19, T.BINARY),
        ThriftDescriptor('deviceSecret', 20, T.BINARY),
        ThriftDescriptor('clientStack', 21, T.BYTE),
        ThriftDescriptor('fbnsConnectionKey', 22, T.INT_64),
        ThriftDescriptor('fbnsConnectionSecret', 23, T.BINARY),
        ThriftDescriptor('fbnsDeviceId', 24, T.BINARY),
        ThriftDescriptor('fbnsDeviceSecret', 25, T.BINARY),
        ThriftDescriptor('anotherUnknown', 26, T.INT_64),
      ]),
      ThriftDescriptor('password', 5, T.BINARY),
      ThriftDescriptor('getDiffsRequests', 6, T.LIST_BINARY),
      ThriftDescriptor('zeroRatingTokenHash', 9, T.BINARY),
      ThriftDescriptor('appSpecificInfo', 10, T.MAP_BINARY_BINARY),
    ];
  }

  toThrift(): Buffer {
    const payload: Record<string, any> = {
      clientIdentifier: this.client_identifier,
      clientInfo: this.client_info,
      password: this.password,
    };
    if (this.app_specific_info && Object.keys(this.app_specific_info).length) {
      payload.appSpecificInfo = this.app_specific_info;
    }
    return writeThriftObject(payload, MQTToTConnection.thriftDescriptors());
  }
}

export function compressPayload(data: Buffer | Uint8Array): Buffer {
  return zlib.deflateSync(data, { level: 9 });
}

export function tryDecompressPayload(data: Buffer): Buffer {
  if (!data || !data.length || data[0] !== 0x78) return data;
  try {
    return zlib.inflateSync(data);
  } catch {
    return data;
  }
}

export function writeConnectPacket(connection: MQTToTConnection, keepAlive = 20): Buffer {
  const payload = compressPayload(connection.toThrift());
  const ka = Buffer.alloc(2);
  ka.writeUInt16BE(keepAlive);
  const variableHeader = Buffer.concat([writeUtf8('MQTToT'), Buffer.from([3, 0xc2]), ka]);
  const remaining = Buffer.concat([variableHeader, payload]);
  return Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(remaining.length), remaining]);
}

export function writePublishPacket(topic: string, payload: Buffer, qos = 1, packetId = 1): Buffer {
  if (qos !== 0 && qos !== 1) throw new RangeError('Only QoS 0 and QoS 1 are supported');
  let variableHeader = writeUtf8(String(topic));
  if (qos) variableHeader = Buffer.concat([variableHeader, u16(packetId)]);
  const body = Buffer.concat([variableHeader, payload]);
  const fixedHeader = Buffer.concat([Buffer.from([0x30 | (qos << 1)]), encodeRemainingLength(body.length)]);
  return Buffer.concat([fixedHeader, body]);
}

export function writeSubscribePacket(topic: string, packetId = 1, qos = 1): Buffer {
  const body = Buffer.concat([u16(packetId), writeUtf8(String(topic)), Buffer.from([qos])]);
  return Buffer.concat([Buffer.from([0x82]), encodeRemainingLength(body.length), body]);
}

export function writePingreqPacket(): Buffer {
  return Buffer.from([0xc0, 0x00]);
}

export function writeDisconnectPacket(): Buffer {
  return Buffer.from([0xe0, 0x00]);
}

/** PUBACK for a QoS 1 publish */
export function writePubackPacket(packetId: number): Buffer {
  return Buffer.concat([Buffer.from([0x40, 0x02]), u16(packetId)]);
}

export function decodePacket(packet: Buffer): DecodedMQTToTPacket {
  const packetTypeId = packet[0] >> 4;
  const flags = packet[0] & 0x0f;
  const [remainingLength, offset] = decodeRemainingLength(packet, 1);
  const body = packet.subarray(offset, offset + remainingLength);
  if (packetTypeId === 1) {
    const [protocolName, pos] = readUtf8(body, 0);
    return new DecodedMQTToTPacket({
      packet_type: 'connect',
      protocol_name: protocolName,
      protocol_level: body[pos],
      connect_flags: body[pos + 1],
      keep_alive: body.readUInt16BE(pos + 2),
      payload: body.subarray(pos + 4),
    });
  }
  if (packetTypeId === 2) {
    return new DecodedMQTToTPacket({ packet_type: 'connack', return_code: body[1], payload: body.subarray(2) });
  }
  if (packetTypeId === 3) {
    let [topic, pos] = readUtf8(body, 0);
    const qos = (flags >> 1) & 0x03;
    let packetId: number | null = null;
    if (qos) {
      packetId = body.readUInt16BE(pos);
      pos += 2;
    }
    return new DecodedMQTToTPacket({
      packet_type: 'publish',
      topic,
      qos,
      packet_id: packetId,
      payload: body.subarray(pos),
    });
  }
  if (packetTypeId === 12) return new DecodedMQTToTPacket({ packet_type: 'pingreq', payload: body });
  if (packetTypeId === 13) return new DecodedMQTToTPacket({ packet_type: 'pingresp', payload: body });
  if (packetTypeId === 14) return new DecodedMQTToTPacket({ packet_type: 'disconnect', payload: body });
  return new DecodedMQTToTPacket({ packet_type: String(packetTypeId), payload: body });
}

export function writeThriftObject(data: Record<string, any>, descriptors: readonly ThriftDescriptor[]): Buffer {
  const writer = new ThriftWriter();
  writeThriftStruct(writer, data, descriptors);
  writer.writeStop();
  return Buffer.from(writer.buffer);
}

export function readThriftObject(data: Buffer, descriptors: readonly ThriftDescriptor[]): Record<string, any> {
  return new ThriftReader(data).readStruct(descriptors);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class MQTToTTimeoutError extends Error {
  constructor(message = 'timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class MQTToTConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** Common interface implemented by transports (allows custom/fake transports in tests). */
export interface MQTToTTransport {
  connect(): Promise<void> | void;
  send(packet: Buffer): Promise<void> | void;
  recvPacket(): Promise<Buffer> | Buffer;
  disconnect(): Promise<void> | void;
}

export interface SocketTransportOptions {
  port?: number;
  /** seconds (like Python socket timeout) */
  timeout?: number;
  tlsOptions?: tls.ConnectionOptions | null;
  proxy?: string | null;
}

/** TLS socket transport with optional HTTP(S) CONNECT or SOCKS4/5 proxy. */
export class SocketMQTToTTransport implements MQTToTTransport {
  host: string;
  port: number;
  timeout: number;
  tlsOptions: tls.ConnectionOptions;
  proxy: string | null;
  sock: tls.TLSSocket | null = null;

  private _buffer: Buffer = Buffer.alloc(0);
  private _waiters: Array<() => void> = [];
  private _closed = false;
  private _error: Error | null = null;

  constructor(host: string, opts: SocketTransportOptions = {}) {
    this.host = host;
    this.port = opts.port ?? 443;
    this.timeout = opts.timeout ?? 30.0;
    this.tlsOptions = opts.tlsOptions ?? { minVersion: 'TLSv1.2' };
    this.proxy = opts.proxy ?? null;
  }

  async connect(): Promise<void> {
    const raw = this.proxy ? await this._createProxyConnection() : await this._createConnection();
    this.sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ ...this.tlsOptions, socket: raw, servername: this.host, host: this.host });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new MQTToTTimeoutError('TLS handshake timed out'));
      }, this.timeout * 1000);
      s.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    this._buffer = Buffer.alloc(0);
    this._closed = false;
    this._error = null;
    this.sock.on('data', (chunk: Buffer) => {
      this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
      this._wake();
    });
    this.sock.on('error', (e) => {
      this._error = e;
      this._wake();
    });
    this.sock.on('close', () => {
      this._closed = true;
      this._wake();
    });
  }

  private _createConnection(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new MQTToTTimeoutError('connect timed out'));
      }, this.timeout * 1000);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  async _createProxyConnection(): Promise<net.Socket> {
    let proxy = this.proxy || '';
    if (!proxy.includes('://')) proxy = `http://${proxy}`;
    let parsed: URL;
    try {
      parsed = new URL(proxy);
    } catch {
      throw new RangeError(`Unsupported realtime proxy URL: ${this.proxy}`);
    }
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    const proxyTypes: Record<string, number> = { http: 0, https: 0, socks4: 4, socks4a: 4, socks5: 5, socks5h: 5 };
    const proxyType = proxyTypes[scheme];
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (proxyType === undefined || !hostname || !parsed.port) {
      throw new RangeError(`Unsupported realtime proxy URL: ${this.proxy}`);
    }
    const username = parsed.username ? decodeURIComponent(parsed.username) : null;
    const password = parsed.password ? decodeURIComponent(parsed.password) : null;
    const port = Number(parsed.port);
    if (proxyType === 0) return this._httpConnect(hostname, port, username, password);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SocksClient } = require('socks');
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: hostname,
        port,
        type: proxyType,
        userId: username ?? undefined,
        password: password ?? undefined,
      },
      command: 'connect',
      destination: { host: this.host, port: this.port },
      timeout: this.timeout * 1000,
    });
    return socket;
  }

  private _httpConnect(host: string, port: number, username: string | null, password: string | null): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new MQTToTTimeoutError('proxy connect timed out'));
      }, this.timeout * 1000);
      const fail = (e: Error) => {
        clearTimeout(timer);
        s.destroy();
        reject(e);
      };
      s.once('error', fail);
      s.once('connect', () => {
        let req = `CONNECT ${this.host}:${this.port} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n`;
        if (username !== null) {
          const token = Buffer.from(`${username}:${password ?? ''}`).toString('base64');
          req += `Proxy-Authorization: Basic ${token}\r\n`;
        }
        s.write(req + '\r\n');
        let acc = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          acc = Buffer.concat([acc, chunk]);
          const end = acc.indexOf('\r\n\r\n');
          if (end < 0) return;
          s.removeListener('data', onData);
          const statusLine = acc.subarray(0, acc.indexOf('\r\n')).toString('latin1');
          const status = Number(statusLine.split(' ')[1]);
          if (status !== 200) {
            fail(new MQTToTConnectionError(`HTTP proxy CONNECT failed: ${statusLine}`));
            return;
          }
          clearTimeout(timer);
          s.removeListener('error', fail);
          const rest = acc.subarray(end + 4);
          if (rest.length) s.unshift(rest);
          resolve(s);
        };
        s.on('data', onData);
      });
    });
  }

  private _wake(): void {
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) w();
  }

  async send(packet: Buffer): Promise<void> {
    if (this.sock === null) throw new Error('Transport is not connected');
    const sock = this.sock;
    await new Promise<void>((resolve, reject) => {
      sock.write(packet, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Read exactly `size` bytes (raises ConnectionError on close, TimeoutError on timeout) */
  async _recvExact(size: number): Promise<Buffer> {
    const deadline = Date.now() + this.timeout * 1000;
    while (this._buffer.length < size) {
      if (this._error) throw this._error;
      if (this._closed || this.sock === null) {
        throw new MQTToTConnectionError('Socket closed while reading MQTT packet');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new MQTToTTimeoutError('timed out');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this._waiters = this._waiters.filter((w) => w !== done);
          resolve();
        }, remaining);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        this._waiters.push(done);
      });
    }
    const out = this._buffer.subarray(0, size);
    this._buffer = this._buffer.subarray(size);
    return Buffer.from(out);
  }

  async recvPacket(): Promise<Buffer> {
    if (this.sock === null) throw new Error('Transport is not connected');
    const first = await this._recvExact(1);
    const remaining: number[] = [];
    for (;;) {
      const byte = await this._recvExact(1);
      remaining.push(byte[0]);
      if ((byte[0] & 0x80) === 0) break;
    }
    const [size] = decodeRemainingLength(Buffer.from(remaining), 0);
    return Buffer.concat([first, Buffer.from(remaining), await this._recvExact(size)]);
  }

  async disconnect(): Promise<void> {
    if (this.sock === null) return;
    const sock = this.sock;
    try {
      await new Promise<void>((resolve) => {
        try {
          sock.end(() => resolve());
        } catch {
          resolve();
        }
        setTimeout(resolve, 1000).unref?.();
      });
      sock.destroy();
    } finally {
      this.sock = null;
      this._wake();
    }
  }
}

// ---------------------------------------------------------------------------
// Thrift compact protocol
// ---------------------------------------------------------------------------

export class ThriftWriter {
  buffer: number[] = [];
  private _fieldStack: number[] = [];
  private _field = 0;

  writeStop(): void {
    this.buffer.push(ThriftTypes.STOP);
    if (this._fieldStack.length) this._field = this._fieldStack.pop()!;
  }

  writeField(field: number, fieldType: number): void {
    const delta = field - this._field;
    const thriftType = fieldType & 0x0f;
    if (delta > 0 && delta <= 15) {
      this.buffer.push((delta << 4) | thriftType);
    } else {
      this.buffer.push(thriftType);
      this.writeVarint(zigzag(field, 16));
    }
    this._field = field;
  }

  writeVarint(value: number | bigint): void {
    let v = BigInt(value);
    if (v < 0n) throw new RangeError('varint must be non-negative');
    for (;;) {
      if ((v & ~0x7fn) === 0n) {
        this.buffer.push(Number(v));
        return;
      }
      this.buffer.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
  }

  writeVarbigint(value: number | bigint): void {
    this.writeVarint(value);
  }

  writeStringDirect(value: string): void {
    const raw = Buffer.from(value, 'utf8');
    this.writeVarint(raw.length);
    for (const b of raw) this.buffer.push(b);
  }

  writeString(field: number, value: string): void {
    this.writeField(field, ThriftTypes.BINARY);
    this.writeStringDirect(value);
  }

  writeBool(field: number, value: boolean): void {
    this.writeField(field, value ? ThriftTypes.TRUE : ThriftTypes.FALSE);
  }

  writeInt(field: number, value: number | bigint, bits: 8 | 16 | 32 | 64): void {
    const fieldType = { 8: ThriftTypes.BYTE, 16: ThriftTypes.INT_16, 32: ThriftTypes.INT_32, 64: ThriftTypes.INT_64 }[bits];
    this.writeField(field, fieldType);
    if (bits === 8) {
      const n = Number(value);
      if (n < -128 || n > 127) throw new RangeError('byte format requires -128 <= number <= 127');
      this.buffer.push(n & 0xff);
    } else if (bits === 64) {
      this.writeVarbigint(zigzag(value, 64));
    } else {
      this.writeVarint(zigzag(value, bits));
    }
  }

  pushStruct(field: number): void {
    this.writeField(field, ThriftTypes.STRUCT);
    this._fieldStack.push(this._field);
    this._field = 0;
  }
}

export class ThriftReader {
  data: Buffer;
  pos = 0;
  private _fieldStack: number[] = [];
  private _field = 0;

  constructor(data: Buffer) {
    this.data = data;
  }

  readStruct(descriptors: readonly ThriftDescriptor[]): Record<string, any> {
    const result: Record<string, any> = {};
    while (this.pos < this.data.length) {
      const fieldType = this.readField();
      if (fieldType === ThriftTypes.STOP) {
        if (this._fieldStack.length) this._field = this._fieldStack.pop()!;
        break;
      }
      const descriptor = findDescriptor(descriptors, this._field, fieldType);
      const value = this.readValue(fieldType, descriptor);
      if (descriptor) result[descriptor.name] = value;
    }
    return result;
  }

  readField(): number {
    const byte = this.readByte();
    if (byte === ThriftTypes.STOP) return ThriftTypes.STOP;
    const delta = (byte & 0xf0) >> 4;
    if (delta) this._field += delta;
    else this._field = Number(unzigzag(this.readVarint()));
    return byte & 0x0f;
  }

  readValue(fieldType: number, descriptor: ThriftDescriptor | null): any {
    if (fieldType === ThriftTypes.TRUE) return true;
    if (fieldType === ThriftTypes.FALSE) return false;
    if (fieldType === ThriftTypes.BYTE) return this.readBytes(1).readInt8(0);
    if (fieldType === ThriftTypes.INT_16 || fieldType === ThriftTypes.INT_32 || fieldType === ThriftTypes.INT_64) {
      return toSafe(unzigzag(this.readVarint()));
    }
    if (fieldType === ThriftTypes.BINARY) {
      const size = Number(this.readVarint());
      return new TextDecoder('utf-8', { fatal: true }).decode(this.readBytes(size));
    }
    if (fieldType === ThriftTypes.LIST) return this.readList();
    if (fieldType === ThriftTypes.MAP) return this.readMap();
    if (fieldType === ThriftTypes.STRUCT) {
      this._fieldStack.push(this._field);
      this._field = 0;
      return this.readStruct(descriptor ? [...descriptor.children] : []);
    }
    throw new RangeError(`Unsupported thrift type: ${fieldType}`);
  }

  readList(): any[] {
    const header = this.readByte();
    let size = header >> 4;
    const itemType = header & 0x0f;
    if (size === 0x0f) size = Number(this.readVarint());
    const items: any[] = [];
    for (let i = 0; i < size; i++) items.push(this.readValue(itemType, null));
    return items;
  }

  readMap(): Record<string, any> {
    const size = Number(this.readVarint());
    if (!size) return {};
    const itemTypes = this.readByte();
    const keyType = (itemTypes & 0xf0) >> 4;
    const valueType = itemTypes & 0x0f;
    const result: Record<string, any> = {};
    for (let i = 0; i < size; i++) {
      const key = this.readValue(keyType, null);
      result[key] = this.readValue(valueType, null);
    }
    return result;
  }

  readByte(): number {
    if (this.pos >= this.data.length) throw new RangeError('index out of range');
    return this.data[this.pos++];
  }

  readBytes(size: number): Buffer {
    const value = this.data.subarray(this.pos, this.pos + size);
    this.pos += size;
    return value;
  }

  readVarint(): bigint {
    let shift = 0n;
    let result = 0n;
    while (this.pos < this.data.length) {
      const byte = this.readByte();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }
}

function toInt(value: any): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  const s = String(value).trim().replace(/_/g, '');
  if (!/^[+-]?\d+$/.test(s)) throw new RangeError(`invalid literal for int() with base 10: '${value}'`);
  return BigInt(s);
}

function toSafe(v: bigint): number | bigint {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

function writeThriftStruct(writer: ThriftWriter, data: Record<string, any>, descriptors: readonly ThriftDescriptor[]): void {
  const byName = new Map(descriptors.map((d) => [d.name, d]));
  for (const [name, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    const descriptor = byName.get(name);
    if (!descriptor) throw new Error(`KeyError: '${name}'`);
    const thriftType = descriptor.type & 0xff;
    if (thriftType === ThriftTypes.BOOLEAN) writer.writeBool(descriptor.field, Boolean(value));
    else if (thriftType === ThriftTypes.BYTE) writer.writeInt(descriptor.field, toInt(value), 8);
    else if (thriftType === ThriftTypes.INT_16) writer.writeInt(descriptor.field, toInt(value), 16);
    else if (thriftType === ThriftTypes.INT_32) writer.writeInt(descriptor.field, toInt(value), 32);
    else if (thriftType === ThriftTypes.INT_64) writer.writeInt(descriptor.field, toInt(value), 64);
    else if (thriftType === ThriftTypes.BINARY) writer.writeString(descriptor.field, String(value));
    else if (thriftType === ThriftTypes.STRUCT) {
      writer.pushStruct(descriptor.field);
      writeThriftStruct(writer, value, [...descriptor.children]);
      writer.writeStop();
    } else if (thriftType === ThriftTypes.LIST) {
      writer.writeField(descriptor.field, ThriftTypes.LIST);
      writeThriftList(writer, descriptor.type >> 8, value);
    } else if (thriftType === ThriftTypes.MAP) {
      writeThriftMap(writer, descriptor.field, value);
    } else {
      throw new RangeError(`Unsupported thrift type: ${descriptor.type}`);
    }
  }
}

function writeThriftList(writer: ThriftWriter, itemType: number, values: any[]): void {
  const size = values.length;
  if (size < 0x0f) writer.buffer.push((size << 4) | itemType);
  else {
    writer.buffer.push(0xf0 | itemType);
    writer.writeVarint(size);
  }
  for (const value of values) {
    if (itemType === ThriftTypes.INT_32) writer.writeVarint(zigzag(toInt(value), 32));
    else if (itemType === ThriftTypes.BINARY) writer.writeStringDirect(String(value));
    else throw new RangeError(`Unsupported thrift list type: ${itemType}`);
  }
}

function writeThriftMap(writer: ThriftWriter, field: number, values: Record<string, any>): void {
  writer.writeField(field, ThriftTypes.MAP);
  const entries = Object.entries(values);
  writer.writeVarint(entries.length);
  if (!entries.length) return;
  writer.buffer.push((ThriftTypes.BINARY << 4) | ThriftTypes.BINARY);
  for (const [key, value] of entries) {
    writer.writeStringDirect(String(key));
    writer.writeStringDirect(String(value));
  }
}

function findDescriptor(
  descriptors: readonly ThriftDescriptor[],
  field: number,
  fieldType: number,
): ThriftDescriptor | null {
  for (const descriptor of descriptors) {
    const descriptorType = descriptor.type & 0x0f;
    if (descriptor.field !== field) continue;
    if (
      descriptorType === fieldType ||
      (descriptor.type === ThriftTypes.BOOLEAN && (fieldType === ThriftTypes.TRUE || fieldType === ThriftTypes.FALSE))
    ) {
      return descriptor;
    }
  }
  return null;
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value);
  return b;
}

export function writeUtf8(value: string): Buffer {
  const raw = Buffer.from(value, 'utf8');
  return Buffer.concat([u16(raw.length), raw]);
}

export function readUtf8(data: Buffer, offset: number): [string, number] {
  const size = data.readUInt16BE(offset);
  offset += 2;
  return [data.subarray(offset, offset + size).toString('utf8'), offset + size];
}

export function encodeRemainingLength(value: number): Buffer {
  const encoded: number[] = [];
  for (;;) {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    encoded.push(byte);
    if (!value) return Buffer.from(encoded);
  }
}

export function decodeRemainingLength(data: Buffer, offset: number): [number, number] {
  let multiplier = 1;
  let value = 0;
  for (;;) {
    if (offset >= data.length) throw new RangeError('index out of range');
    const encodedByte = data[offset++];
    value += (encodedByte & 127) * multiplier;
    if ((encodedByte & 128) === 0) return [value, offset];
    multiplier *= 128;
  }
}

/** Python: (value << 1) ^ (value >> (bits - 1)) on arbitrary precision ints */
export function zigzag(value: number | bigint, bits: number): bigint {
  const v = BigInt(value);
  return (v << 1n) ^ (v >> BigInt(bits - 1));
}

/** Python: (value >> 1) ^ -(value & 1) */
export function unzigzag(value: number | bigint): bigint {
  const v = BigInt(value);
  return (v >> 1n) ^ -(v & 1n);
}

export function parseJsonPayload(payload: Buffer): any {
  return parseJson(decodeUtf8Strict(tryDecompressPayload(payload)));
}

/** bytes.decode() — raises on invalid UTF-8 (UnicodeDecodeError) */
export function decodeUtf8Strict(data: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

export type RealtimeHandler = (payload: any) => void | Promise<void>;
