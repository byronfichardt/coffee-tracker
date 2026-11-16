import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, parseModelJson, normaliseCoffee } from '../server.js';

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

/** A stand-in for OpenRouter that records what it was sent. */
async function fakeOpenRouter(reply, status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  return { url: await listen(server), seen, close: () => server.close() };
}

async function start(config) {
  const server = createApp({ apiKey: '', model: 'test/model', baseUrl: '', appPassword: '', ...config });
  return { url: await listen(server), close: () => server.close() };
}

const post = (url, body, headers = {}) => fetch(`${url}/api/extract`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('health check and static files', async (t) => {
  const app = await start();
  t.after(app.close);

  const up = await fetch(`${app.url}/up`);
  assert.equal(up.status, 200);

  const index = await fetch(`${app.url}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Coffee Tracker/);

  const manifest = await fetch(`${app.url}/manifest.webmanifest`);
  assert.match(manifest.headers.get('content-type'), /manifest\+json/);

  assert.equal((await fetch(`${app.url}/nope.js`)).status, 404);
  // Raw request so the client cannot normalise the path away.
  const traversal = await new Promise((resolve) => {
    http.get(`${app.url}/..%2f..%2fserver.js`, (res) => resolve(res.statusCode));
  });
  assert.equal(traversal, 404);
});

test('config reports whether photo reading is available, never the key', async (t) => {
  const off = await start();
  const on = await start({ apiKey: 'sk-secret', appPassword: 'pw' });
  t.after(off.close);
  t.after(on.close);

  assert.deepEqual(await (await fetch(`${off.url}/api/config`)).json(), { ai: false, model: '', passwordRequired: false });
  const body = await (await fetch(`${on.url}/api/config`)).text();
  assert.deepEqual(JSON.parse(body), { ai: true, model: 'test/model', passwordRequired: true });
  assert.doesNotMatch(body, /sk-secret|pw/);
});

test('extract sends the photos to OpenRouter and returns clean fields', async (t) => {
  const upstream = await fakeOpenRouter({
    choices: [{ message: { content: '```json\n{"name":"La Esperanza","roaster":"April","origin":"Colombia","tastingNotes":["plum","cocoa"],"roastDate":"2026-11-02","weight":null,"extra":"x"}\n```' } }],
  });
  const app = await start({ apiKey: 'sk-secret', baseUrl: upstream.url });
  t.after(upstream.close);
  t.after(app.close);

  const res = await post(app.url, { images: [PHOTO, PHOTO] });
  assert.equal(res.status, 200);
  const { coffee } = await res.json();
  assert.equal(coffee.name, 'La Esperanza');
  assert.equal(coffee.tastingNotes, 'plum, cocoa');
  assert.equal(coffee.roastDate, '2026-11-02');
  assert.equal(coffee.weight, '');
  assert.equal(coffee.extra, undefined);

  const [call] = upstream.seen;
  assert.equal(call.url, '/chat/completions');
  assert.equal(call.auth, 'Bearer sk-secret');
  assert.equal(call.body.model, 'test/model');
  assert.equal(call.body.messages[1].content.filter((part) => part.type === 'image_url').length, 2);
});

test('extract refuses when it should', async (t) => {
  const upstream = await fakeOpenRouter({ error: { message: 'No such model' } }, 400);
  const off = await start();
  const locked = await start({ apiKey: 'k', baseUrl: upstream.url, appPassword: 'beans' });
  t.after(upstream.close);
  t.after(off.close);
  t.after(locked.close);

  assert.equal((await post(off.url, { images: [PHOTO] })).status, 503);
  assert.equal((await post(locked.url, { images: [PHOTO] })).status, 401);
  assert.equal((await post(locked.url, { images: [PHOTO] }, { 'X-App-Password': 'wrong' })).status, 401);

  const ok = { 'X-App-Password': 'beans' };
  assert.equal((await post(locked.url, 'not json', ok)).status, 400);
  assert.equal((await post(locked.url, { images: [] }, ok)).status, 400);
  assert.equal((await post(locked.url, { images: ['https://example.com/a.jpg'] }, ok)).status, 400);
  assert.equal((await post(locked.url, { images: [PHOTO, PHOTO, PHOTO] }, ok)).status, 400);
  assert.equal(upstream.seen.length, 0, 'nothing reaches OpenRouter until a request is valid');

  const failed = await post(locked.url, { images: [PHOTO] }, ok);
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).error, /No such model/);
});

test('model replies are parsed leniently and normalised strictly', () => {
  assert.deepEqual(parseModelJson('Here you go: {"name":"A"} hope that helps'), { name: 'A' });
  assert.throws(() => parseModelJson('no json here'));
  const clean = normaliseCoffee({ name: '  Kii  ', roastDate: '02/11/2026', origin: { a: 1 }, variety: ['SL28', 'SL34'] });
  assert.equal(clean.name, 'Kii');
  assert.equal(clean.roastDate, '');
  assert.equal(clean.origin, '');
  assert.equal(clean.variety, 'SL28, SL34');
});
