import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ig from '../src';

test('client exposes the full API surface', () => {
  const cl = new ig.Client();
  for (const name of [
    'login', 'relogin', 'loginBySessionid', 'getSettings', 'setSettings', 'dumpSettings', 'loadSettings',
    'userInfo', 'userInfoByUsername', 'userFollowers', 'userFollowing', 'mediaInfo', 'mediaLike', 'mediaComment',
    'photoUpload', 'videoUpload', 'albumUpload', 'clipUpload', 'igtvUpload', 'photoUploadToStory',
    'directThreads', 'directSend', 'directMessages', 'storyInfo', 'highlightInfo', 'hashtagInfo', 'locationInfo',
    'challengeResolve', 'totpGenerateSeed', 'createNote', 'searchUsers', 'realtimeConnect', 'fbnsConnect',
    'attestationCreateAndroidKeystore', 'attestationCreateAndroidPlayIntegrity',
  ]) {
    assert.equal(typeof (cl as any)[name], 'function', name);
  }
});

test('media code <-> pk conversion', () => {
  const cl = new ig.Client();
  assert.equal(cl.mediaCodeFromPk('2110901750722920960'), 'B1LbfVPlwIA');
  assert.equal(String(cl.mediaPkFromCode('B1LbfVPlwIA')), '2110901750722920960');
});

test('settings roundtrip via dump/load', async () => {
  const cl = new ig.Client();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-')), 'settings.json');
  await cl.dumpSettings(file);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.uuids.phone_id, cl.phoneId);
  const cl2 = new ig.Client();
  await cl2.loadSettings(file);
  assert.equal(cl2.phoneId, cl.phoneId);
  assert.equal(cl2.uuid, cl.uuid);
  assert.equal(cl2.userAgent, cl.userAgent);
});

test('exception hierarchy', () => {
  const e = new ig.LoginRequired('login required');
  assert.ok(e instanceof ig.ClientError);
  assert.ok(e instanceof Error);
  assert.equal(e.message, 'login required');
  assert.ok(new ig.ChallengeRequired() instanceof ig.ClientError);
});

test('bigint-safe json parsing keeps ids exact', () => {
  const data = ig.bigJson.parseJson('{"pk": 3141592653589793238, "n": 1}');
  assert.equal(String(data.pk), '3141592653589793238');
  assert.equal(data.n, 1);
});

test('DirectThread.isSeen', () => {
  const t = ig.makeDirectThread({
    pk: '1', id: '1', messages: [], users: [], inviter: null, left_users: [], admin_user_ids: [],
    last_activity_at: 1700000000, muted: false, named: false, canonical: true, pending: false,
    archived: false, thread_type: 'private', thread_title: 'x', folder: 0, vc_muted: false,
    is_group: false, mentions_muted: false, approval_required_for_new_members: false,
    input_mode: 0, business_thread_folder: 0, read_state: 0, is_close_friend_thread: false,
    assigned_admin_id: 0, shh_mode_enabled: false,
    last_seen_at: {
      '10': { item_id: 'a', timestamp: 1700000100, created_at: 1700000100, shh_seen_state: {} },
      '20': { item_id: 'b', timestamp: 1700000000, created_at: 1700000000, shh_seen_state: {} },
    },
  });
  assert.equal(t.isSeen('10'), true);
  assert.equal(t.isSeen(20), false);
  assert.equal(t.isSeen('99'), false);
  assert.ok(!('isSeen' in JSON.parse(JSON.stringify(t))));
});

test('mobile transport is a pure-Node profile needing no native helper', () => {
  const cl = new ig.Client({ privateTransport: 'mobile' });
  assert.equal(cl.privateTransport, 'mobile');
  assert.equal(cl.private.transport, 'mobile');
  assert.equal(cl.public.transport, 'http1');
  assert.throws(() => new ig.Client({ privateTransport: 'bogus' as any }), /privateTransport must be/);
});

test('media downloads send the Instagram app User-Agent', async () => {
  const http = await import('node:http');
  let seen: string | undefined;
  const server = http.createServer((req, res) => {
    seen = req.headers['user-agent'];
    res.end('data');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  try {
    const cl = new ig.Client();
    const bytes = await cl.photoDownloadByUrlOrigin(`http://127.0.0.1:${port}/photo.jpg`);
    assert.equal(bytes.toString(), 'data');
    assert.equal(seen, cl.userAgent);
    assert.match(seen!, /^Instagram \d+\.\d+\.\d+\.\d+\.\d+ Android/);
  } finally {
    server.close();
  }
});

test('media downloads go through the client proxy', async () => {
  const net = await import('node:net');
  const hits: string[] = [];
  const proxy = net.createServer((s) =>
    s.once('data', (d) => {
      hits.push(d.toString().split('\r\n')[0]);
      s.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }),
  );
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const port = (proxy.address() as any).port;
  try {
    const cl = new ig.Client({ proxy: `http://127.0.0.1:${port}` });
    await assert.rejects(cl.photoDownloadByUrlOrigin('https://cdn.example.invalid/photo.jpg'));
    await assert.rejects(cl.videoDownloadByUrlOrigin('https://cdn.example.invalid/video.mp4'));
    assert.deepEqual(hits, ['CONNECT cdn.example.invalid:443 HTTP/1.1', 'CONNECT cdn.example.invalid:443 HTTP/1.1']);
  } finally {
    proxy.close();
  }
});
