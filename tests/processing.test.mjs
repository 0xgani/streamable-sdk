import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { StreamableClient, StreamableError, ProcessingError, ProcessingTimeoutError } from '../dist/index.js';

const client = () => new StreamableClient('', '');

test('legacy numeric timeout returns a recoverable error with the saved video identity', async () => {
  const c = client();
  c.getVideo = async () => ({ status: 1 });
  await assert.rejects(c.waitForReady('existing', () => {}, 10), error => {
    assert.ok(error instanceof ProcessingTimeoutError);
    assert.ok(error instanceof StreamableError);
    assert.equal(error.shortcode, 'existing');
    assert.equal(error.url, 'https://streamable.com/existing');
    assert.equal(error.lastStatus, 1);
    return true;
  });
});

test('a disabled deadline survives temporary lookup errors and eventually becomes ready', async () => {
  const c = client();
  let calls = 0;
  const logs = [];
  c.getVideo = async () => {
    calls++;
    if (calls === 1) throw new Error('temporary network failure');
    return { status: calls === 2 ? 1 : 2 };
  };
  assert.equal((await c.waitForReady('existing', m => logs.push(m), { timeoutMs: null, pollIntervalMs: 1 })).status, 2);
  assert.equal(calls, 3);
  assert.ok(logs[0].includes('unavailable'));
});

test('explicit processing failure has its own error type and is never retried as an upload', async () => {
  const c = client();
  c.getVideo = async () => ({ status: 3, message: 'rejected' });
  await assert.rejects(c.waitForReady('existing'), error => {
    assert.ok(error instanceof ProcessingError);
    assert.ok(!(error instanceof ProcessingTimeoutError));
    assert.equal(error.shortcode, 'existing');
    return true;
  });
});

test('processing deadline cancels a hung status request', async () => {
  const original = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  try {
    await assert.rejects(client().waitForReady('existing', () => {}, { timeoutMs: 10 }), ProcessingTimeoutError);
    assert.equal(aborted, true);
  } finally { globalThis.fetch = original; }
});

test('callers can cancel an unlimited wait during a request', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const reason = new Error('stop waiting');
  globalThis.fetch = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    controller.abort(reason);
  });
  try {
    await assert.rejects(client().waitForReady('existing', () => {}, { timeoutMs: null, signal: controller.signal }), error => error === reason);
  } finally { globalThis.fetch = original; }
});

test('callers can cancel an unlimited wait during the polling delay', async () => {
  const c = client(), controller = new AbortController(), reason = new Error('stop');
  c.getVideo = async () => ({status:1});
  await assert.rejects(c.waitForReady('existing', () => controller.abort(reason), { timeoutMs: null, signal: controller.signal }), error => error === reason);
});

test('default wait and legacy null deadline preserve ready-video behavior', async () => {
  const c = client();
  c.getVideo = async () => ({status:2});
  assert.equal((await c.waitForReady('existing')).status, 2);
  assert.equal((await c.waitForReady('existing', undefined, null)).status, 2);
});

test('invalid processing settings and pre-aborted signals fail before any upload request', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('must not make a request'); };
  try {
    for (const timeoutMs of [-1, NaN, Infinity, 2 ** 31]) {
      await assert.rejects(client().upload(new Blob(['video']), { waitForReady: true, processing: { timeoutMs } }), RangeError);
    }
    await assert.rejects(client().waitForReady('existing', undefined, { pollIntervalMs: 0 }), RangeError);
    const signal = AbortSignal.abort(new Error('cancelled'));
    await assert.rejects(client().upload(new Blob(['video']), { waitForReady: true, processing: { signal } }), /cancelled/);
    await assert.rejects(client().waitForReady('existing', undefined, 0), ProcessingTimeoutError);
  } finally { globalThis.fetch = original; }
});

test('upload forwards processing options after upload confirmation and no-wait skips polling', async () => {
  const original = globalThis.fetch;
  let uploads = 0, waits = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/uploads/shortcode')) return Response.json({shortcode:'saved',url:'https://s3.example/upload',fields:{},transcoder_options:{}});
    if (url.hostname === 's3.example') uploads++;
    return Response.json({});
  };
  try {
    const c = client(); c.user = {};
    const processing = { timeoutMs: null };
    c.waitForReady = async (shortcode, _log, options) => {
      waits++;
      assert.equal(shortcode, 'saved');assert.equal(options, processing);assert.equal(uploads, 1);
      throw new ProcessingTimeoutError(shortcode, 1);
    };
    await assert.rejects(c.upload(new Blob(['video']), {waitForReady:true,processing}), ProcessingTimeoutError);
    assert.equal((await c.upload(new Blob(['video']), {waitForReady:false})).shortcode, 'saved');
    assert.equal(waits, 1);assert.equal(uploads, 2);
  } finally { globalThis.fetch = original; }
});

test('CLI documents optional processing deadline and rejects invalid input before login', () => {
  const help = spawnSync(process.execPath, ['dist/cli.js','--help'], {encoding:'utf8'});
  assert.equal(help.status, 0);assert.match(help.stdout, /--processing-timeout/);
  for (const input of ['-1','NaN','Infinity','']) {
    const result = spawnSync(process.execPath, ['dist/cli.js','upload','nonexistent.mp4','--email','fake','--password','fake',`--processing-timeout=${input}`], {encoding:'utf8'});
    assert.equal(result.status, 1);assert.match(result.stderr, /--processing-timeout must/);
  }
});
