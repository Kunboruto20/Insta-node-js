import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Boom from '@hapi/boom';
import * as ig from '../src';

test('library error classes are Boom errors and keep instanceof', () => {
  const e = new ig.LoginRequired('login required');
  assert.ok(Boom.isBoom(e));
  assert.ok(e instanceof Boom.Boom);
  assert.ok(e instanceof ig.LoginRequired);
  assert.ok(e instanceof ig.PrivateError);
  assert.ok(e instanceof ig.ClientError);
  assert.equal(e.output.statusCode, 401);
  assert.deepEqual(e.output.payload, { statusCode: 401, error: 'Unauthorized', message: 'login required' });
  assert.equal(e.name, 'LoginRequired');
});

test('status codes per error class', () => {
  assert.equal(new ig.MediaNotFound('x').output.statusCode, 404);
  assert.ok(new ig.MediaNotFound('x') instanceof ig.MediaError);
  assert.equal(new ig.PleaseWaitFewMinutes('x').output.statusCode, 429);
  assert.equal(new ig.RateLimitError('x').output.statusCode, 429);
  assert.equal(new ig.ChallengeRequired({ message: 'challenge_required' }).output.statusCode, 403);
  assert.equal(new ig.TwoFactorRequired('x').output.statusCode, 401);
  assert.equal(new ig.ClientError('x', { response: { status_code: 418 } }).output.statusCode, 418);
  assert.equal(new ig.ClientError('x').output.statusCode, 500);
});

test('generic errors use Boom factories', async () => {
  const cl = new ig.Client();
  assert.throws(() => cl.setProxy(123 as any), (e: any) => Boom.isBoom(e, 400));
  await assert.rejects(cl.realtimeReadOnce(), (e: any) => Boom.isBoom(e, 412) && /not connected/.test(e.message));
  await assert.rejects(cl.loginBySessionid('short'), (e: any) => Boom.isBoom(e, 400));
  assert.throws(() => cl.mediaPkFromCode('!!!'), (e: any) => Boom.isBoom(e, 400));
});

test('model validation errors are Boom 422', () => {
  assert.throws(
    () => ig.makeUserShort({}),
    (e: any) => e instanceof ig.ModelValidationError && Boom.isBoom(e, 422) && e.data.errors.length > 0,
  );
});

test('errors from Node.js and dependencies are converted to Boom', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const cl = new ig.Client();
  await assert.rejects(cl.photoUpload('/definitely/missing.jpg', 'x'), (e: any) => Boom.isBoom(e, 404));
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-')), 'bad.jpg');
  fs.writeFileSync(bad, 'not an image');
  await assert.rejects(cl.photoUpload(bad, 'x'), (e: any) => Boom.isBoom(e, 415));
  const rt = new ig.Client({ proxy: 'http://127.0.0.1:9' });
  await assert.rejects(rt.fbnsConnect(), (e: any) => Boom.isBoom(e, 503) && e.name === 'ConnectionError');
});

test('async generators keep working and surface Boom errors', async () => {
  const cl = new ig.Client();
  let calls = 0;
  (cl as any).userMediasPaginated = async () => {
    calls++;
    if (calls === 1) return [[{ pk: '1' }, { pk: '2' }], 'next'];
    throw new TypeError('boom inside page 2');
  };
  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const m of cl.iterUserMedias('1', 10)) seen.push((m as any).pk);
    })(),
    (e: any) => Boom.isBoom(e) && e instanceof TypeError,
  );
  assert.deepEqual(seen, ['1', '2']);
});
