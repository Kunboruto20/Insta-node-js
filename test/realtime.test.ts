import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'zlib';
import {
  MQTToTConnection,
  compressPayload,
  decodePacket,
  readThriftObject,
  writePublishPacket,
  writeSubscribePacket,
  writeThriftObject,
  MQTToTTransport,
} from '../src/mqtt/protocol';
import { RealtimeClient } from '../src/mqtt/realtimeClient';
import { FbnsClient, FbnsDeviceAuth } from '../src/mqtt/pushClient';
import { Client } from '../src/core/instaClient';

// Known-good reference encodings.
const CONNECT_THRIFT =
  '18146162636465666768696a6b6c6d6e6f70717273743c168eaedad68b95ee2b1805554120c89b16ee021600150212111803646576111502150016feffffff1f29f512b0018e02aa02ac028a02a402b0018e02aa02ac028a02a402b0018e02aa02ac028a02a402180b636f6f6b69655f6175746816d6c983f9d4ef810248001303560100180b73657373696f6e69643d785b028801610162015802c3bc00';

function sampleConnection(): MQTToTConnection {
  const topics = [88, 135, 149, 150, 133, 146];
  return new MQTToTConnection(
    'abcdefghijklmnopqrst',
    {
      userId: 12345678901234567n,
      userAgent: 'UA ț',
      clientCapabilities: 183,
      endpointCapabilities: 0,
      publishFormat: 1,
      noAutomaticForeground: false,
      makeUserAvailableInForeground: true,
      deviceId: 'dev',
      isInitiallyForeground: true,
      networkType: 1,
      networkSubtype: 0,
      clientMqttSessionId: 4294967295,
      subscribeTopics: [...topics, ...topics, ...topics],
      clientType: 'cookie_auth',
      appId: 567067343352427,
      deviceSecret: '',
      clientStack: 3,
      anotherUnknown: -1,
    },
    'sessionid=x',
    { a: 'b', X: 'ü' },
  );
}

test('thrift connect payload matches reference byte-for-byte', () => {
  const t = sampleConnection().toThrift();
  assert.equal(t.toString('hex'), CONNECT_THRIFT);
  const back = readThriftObject(t, MQTToTConnection.thriftDescriptors());
  assert.equal(back.clientInfo.userId, 12345678901234567n);
  assert.equal(back.clientInfo.anotherUnknown, -1);
  assert.equal(back.clientInfo.userAgent, 'UA ț');
  assert.deepEqual(back.appSpecificInfo, { a: 'b', X: 'ü' });
});

test('foreground state / publish / subscribe packets match reference', () => {
  const st = { inForegroundApp: true, keepAliveTimeout: -60, subscribeTopics: ['a', 'b'], requestId: -5 };
  assert.equal(writeThriftObject(st, RealtimeClient.foregroundStateDescriptors()).toString('hex'), '112577192801610162460900');
  const pub = writePublishPacket('132', Buffer.alloc(200, 'x'), 1, 7);
  assert.equal(pub.subarray(0, 10).toString('hex'), '32cf0100033133320007');
  assert.equal(writeSubscribePacket('76', 3).toString('hex'), '820700030002373601');
  assert.equal(compressPayload(Buffer.from('{"a":1}')).toString('hex'), '78daab564a54b232ac0500082a0209');
  const decoded = decodePacket(pub);
  assert.equal(decoded.packet_type, 'publish');
  assert.equal(decoded.topic, '132');
  assert.equal(decoded.packet_id, 7);
  assert.equal(decoded.payload.length, 200);
});

test('direct realtime event classification', () => {
  assert.equal(RealtimeClient.directRealtimeEventKind({ path: '/x', value: [1, 'Seen', null] }), 'seen');
  assert.equal(RealtimeClient.directRealtimeEventKind({ value: { b: { is_active: 1 } } }), 'presence');
  assert.equal(RealtimeClient.directRealtimeEventKind({ path: '/direct_v2/threads/1/activity_indicator_id/x' }), 'typing');
  assert.equal(RealtimeClient.threadIdFromMessageSyncPath('/direct_v2/threads/340282/items/1'), '340282');
  assert.equal(RealtimeClient.threadIdFromMessageSyncPath('/other'), null);
});

class FakeTransport implements MQTToTTransport {
  sent: Buffer[] = [];
  incoming: Buffer[] = [];
  connected = false;
  connect() {
    this.connected = true;
  }
  send(packet: Buffer) {
    this.sent.push(packet);
  }
  recvPacket(): Buffer {
    const p = this.incoming.shift();
    if (!p) throw new Error('no packets');
    return p;
  }
  disconnect() {
    this.connected = false;
  }
}

test('realtime client dispatches message sync patches and acks QoS1', async () => {
  const cl = new Client();
  const transport = new FakeTransport();
  const events: Record<string, any[]> = {};
  for (const ev of ['receive', 'message', 'direct', 'typing']) {
    cl.realtimeOn(ev, (p) => {
      (events[ev] ||= []).push(p);
    });
  }
  const rt = await cl.realtimeConnect(transport);
  assert.equal(rt.connected, true);
  const body = JSON.stringify([
    {
      event: 'patch',
      data: [
        { op: 'add', path: '/direct_v2/threads/111/items/222', value: JSON.stringify({ item_id: '222', text: 'hi' }) },
        { op: 'add', path: '/direct_v2/threads/111/activity_indicator_id/1', value: '{"activity_status":1}' },
      ],
    },
  ]);
  transport.incoming.push(writePublishPacket('146', zlib.deflateSync(Buffer.from(body)), 1, 9));
  await cl.realtimeReadOnce();
  assert.equal(events.receive.length, 1);
  assert.equal(events.message.length, 2);
  assert.equal(events.message[0].message.thread_id, '111');
  assert.equal(events.message[0].message.text, 'hi');
  assert.equal(events.direct.length, 2);
  assert.equal(events.typing.length, 1);
  assert.equal(transport.sent.at(-1)!.toString('hex'), '40020009');

  const state = await rt.directSendText('111', 'salut', 'ctx');
  assert.deepEqual(state, { thread_id: '111', action: 'send_item', client_context: 'ctx' });
  const sent = decodePacket(transport.sent.at(-1)!);
  assert.equal(sent.topic, '132');
  assert.deepEqual(JSON.parse(zlib.inflateSync(sent.payload).toString()), {
    action: 'send_item',
    thread_id: '111',
    item_type: 'text',
    text: 'salut',
    client_context: 'ctx',
  });
  await cl.realtimeDisconnect();
  assert.equal(cl.realtime, null);
});

test('fbns device auth reads connack payload and push messages', async () => {
  const auth = new FbnsDeviceAuth();
  const json = Buffer.from('{"ck":12345678901234567,"cs":"secret","di":"device-id-0123456789abc","ds":"dsec","sr":"ATN"}');
  const prefixed = Buffer.concat([Buffer.from([0, json.length]), json]);
  auth.read(prefixed);
  assert.equal(auth.user_id, 12345678901234567n);
  assert.equal(auth.password, 'secret');
  assert.equal(auth.client_id, 'device-id-0123456789');
  assert.equal(auth.server_region, 'ATN');

  const cl = new Client();
  const fb = new FbnsClient(cl, new FakeTransport(), auth);
  const pushes: any[] = [];
  fb.on('push', (p) => pushes.push(p));
  fb.on('direct_v2_message', (p) => pushes.push(['collapse', p.collapse_key]));
  const payload = Buffer.from(JSON.stringify({ fbpushnotif: JSON.stringify({ collapse_key: 'direct_v2_message', m: 'x' }) }));
  const parsed = await fb.dispatchPacket('76', zlib.deflateSync(payload));
  assert.equal(parsed.collapse_key, 'direct_v2_message');
  assert.equal(pushes.length, 2);
});
