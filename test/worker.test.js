import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { __testables } from '../src/worker.js';

const {
  escapeHTML, mdToTelegramHTML, splitLongParagraph, splitTelegramMessage,
  buildReport, evaluateAnswers, applyFlags, SYSTEM_PROMPT, QUIZ, STD_DEDUCTION,
  MENU_TEXT, DISCLAIMER, GUIDE, TAX_YEAR,
  classifyTraffic,
} = __testables();

const MAX_REQUEST_BODY_BYTES = 32768;

function makeInterestPayload(byteLength) {
  const prefix = '{"event_type":"artifact_intent","pad":"';
  const suffix = '"}';
  return `${prefix}${'x'.repeat(byteLength - prefix.length - suffix.length)}${suffix}`;
}

function makeInstrumentedStream(bytes, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }

  const stats = {
    chunksPulled: 0,
    bytesDelivered: 0,
    cancelled: false,
    completed: false,
  };
  let nextChunk = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (nextChunk === chunks.length) {
        stats.completed = true;
        controller.close();
        return;
      }

      const chunk = chunks[nextChunk];
      nextChunk += 1;
      stats.chunksPulled += 1;
      stats.bytesDelivered += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      stats.cancelled = true;
    },
  }, { highWaterMark: 0 });

  return { stream, stats, chunkCount: chunks.length };
}

function makeStreamingInterestRequest(bodyBytes, chunkSize, contentType = 'application/json') {
  const instrumented = makeInstrumentedStream(bodyBytes, chunkSize);
  const request = new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: instrumented.stream,
    duplex: 'half',
  });
  return { request, ...instrumented };
}

test('classifyTraffic does not trust client-described QA metadata and only treats localhost as verified QA', () => {
  assert.equal(classifyTraffic(new Request('https://example.test'), { ref: 'smoke-test' }), 'external_unknown');
  assert.equal(classifyTraffic(new Request('https://example.test'), { email: 'tyu433911@gmail.com' }), 'external_unknown');
  assert.equal(classifyTraffic(new Request('https://example.test', { headers: { 'User-Agent': 'Playwright/1.0' } }), {}), 'external_unknown');
  assert.equal(classifyTraffic(new Request('https://localhost:8787/test'), {}), 'qa');
});

async function callWebhook(env, pathname = '/telegram/webhook', headers = {}, body = '{}') {
  const request = new Request(`https://example.test${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body,
  });

  const backgroundTasks = [];
  const response = await worker.fetch(request, env, {
    waitUntil(task) { backgroundTasks.push(task); },
  });
  await Promise.all(backgroundTasks);
  return { response, bodyText: await response.text() };
}

test('telegram webhook rejects empty and invalid secrets before any D1 or handler work', async () => {
  let dbCalls = 0;
  const emptySecretEnv = {
    TELEGRAM_WEBHOOK_SECRET: '',
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { all() { return { results: [] }; }, run() { return {}; } }; } };
      },
    },
  };

  let current = await callWebhook(emptySecretEnv, '/telegram/webhook', {
    'X-Telegram-Bot-Api-Secret-Token': 'expected-secret',
  }, JSON.stringify({ update_id: 1 }));
  assert.equal(current.response.status, 500);
  assert.equal(current.bodyText, 'Server webhook configuration missing');
  assert.equal(dbCalls, 0);

  const badHeaderEnv = {
    TELEGRAM_WEBHOOK_SECRET: 'expected-secret',
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { all() { return { results: [] }; }, run() { return {}; } }; } };
      },
    },
  };

  current = await callWebhook(badHeaderEnv, '/telegram/webhook', {}, JSON.stringify({ update_id: 1 }));
  assert.equal(current.response.status, 401);
  assert.equal(current.bodyText, 'Unauthorized');
  assert.equal(dbCalls, 0);

  current = await callWebhook(badHeaderEnv, '/telegram/webhook', { 'X-Telegram-Bot-Api-Secret-Token': '' }, JSON.stringify({ update_id: 1 }));
  assert.equal(current.response.status, 401);
  assert.equal(current.bodyText, 'Unauthorized');
  assert.equal(dbCalls, 0);

  current = await callWebhook(badHeaderEnv, '/telegram/webhook', { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' }, JSON.stringify({ update_id: 1 }));
  assert.equal(current.response.status, 401);
  assert.equal(current.bodyText, 'Unauthorized');
  assert.equal(dbCalls, 0);
});

test('telegram webhook rejects malformed JSON without invoking the bot handler', async () => {
  const originalFetch = globalThis.fetch;
  let botCalls = 0;
  const env = {
    TELEGRAM_WEBHOOK_SECRET: 'expected-secret',
    TELEGRAM_BOT_TOKEN: 'TESTTOKEN',
    DB: {
      prepare() {
        return { bind() { return { all() { return { results: [] }; }, run() { return {}; } }; } };
      },
    },
  };

  globalThis.fetch = async () => {
    botCalls += 1;
    return { json: async () => ({ ok: true }) };
  };

  try {
    const { response, bodyText } = await callWebhook(env, '/telegram/webhook', {
      'X-Telegram-Bot-Api-Secret-Token': 'expected-secret',
    }, '{bad-json');

    assert.equal(response.status, 400);
    assert.equal(bodyText, 'Malformed JSON');
    assert.equal(botCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streaming request parsing rejects oversized JSON before database writes', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { run() { return {}; } }; } };
      },
    },
  };

  const oversized = JSON.stringify({ a: 'x'.repeat(32768 - JSON.stringify({ a: '' }).length + 1) });
  const response = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: oversized,
  }), env, { waitUntil: () => {} });

  assert.equal(response.status, 413);
  assert.equal(dbCalls, 0);
});

test('readJsonBody accepts the JSON media type with charset and rejects invalid UTF-8 bytes', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { run() { return {}; } }; } };
      },
    },
  };

  const valid = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ event_type: 'artifact_intent', email: null }),
  }), env, { waitUntil: () => {} });
  assert.equal(valid.status, 200);
  dbCalls = 0;

  const invalidUtf8 = new Uint8Array([0xef, 0xbf, 0xff]);
  const invalid = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: invalidUtf8,
  }), env, { waitUntil: () => {} });
  assert.equal(invalid.status, 400);
  assert.equal(dbCalls, 0);
});

test('/api/interest accepts a streamed body exactly at 32 KB and rejects one byte over', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { run() { return {}; } }; } };
      },
    },
  };

  const exactBytes = new TextEncoder().encode(makeInterestPayload(MAX_REQUEST_BODY_BYTES));
  assert.equal(exactBytes.byteLength, MAX_REQUEST_BODY_BYTES);
  const exact = makeStreamingInterestRequest(exactBytes, 4096, 'application/json; charset=utf-8');
  const exactResponse = await worker.fetch(exact.request, env, { waitUntil: () => {} });
  assert.equal(exactResponse.status, 200);
  assert.equal(dbCalls, 1);
  assert.equal(exact.stats.bytesDelivered, MAX_REQUEST_BODY_BYTES);
  assert.equal(exact.stats.completed, true);

  const overBytes = new TextEncoder().encode(makeInterestPayload(MAX_REQUEST_BODY_BYTES + 1));
  assert.equal(overBytes.byteLength, MAX_REQUEST_BODY_BYTES + 1);
  const over = makeStreamingInterestRequest(overBytes, 4096);
  const overResponse = await worker.fetch(over.request, env, { waitUntil: () => {} });
  assert.equal(overResponse.status, 413);
  assert.equal(dbCalls, 1);
  assert.equal(over.stats.cancelled, true);
});

test('/api/interest cancels a large stream as soon as the size limit is crossed', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { run() { return {}; } }; } };
      },
    },
  };
  const bodyBytes = new TextEncoder().encode(makeInterestPayload(128 * 1024));
  const chunksInBody = Math.ceil(bodyBytes.byteLength / 4096);
  const oversized = makeStreamingInterestRequest(bodyBytes, 4096);
  assert.equal(oversized.chunkCount, 32);

  const originalParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = function (...args) {
    parseCalls += 1;
    return originalParse.apply(this, args);
  };

  let response;
  try {
    response = await worker.fetch(oversized.request, env, { waitUntil: () => {} });
  } finally {
    JSON.parse = originalParse;
  }

  assert.equal(response.status, 413);
  assert.equal(parseCalls, 0);
  assert.equal(dbCalls, 0);
  assert.equal(oversized.stats.cancelled, true);
  assert.equal(oversized.stats.completed, false);
  assert.equal(oversized.stats.chunksPulled, 9);
  assert.equal(oversized.stats.bytesDelivered, MAX_REQUEST_BODY_BYTES + 4096);
  assert.ok(oversized.stats.bytesDelivered < bodyBytes.byteLength);
  assert.equal(chunksInBody - oversized.stats.chunksPulled, 23);
});

test('/api/interest rejects an empty body and application/jsonp before D1 operations', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { run() { return {}; } }; } };
      },
    },
  };

  const empty = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '',
  }), env, { waitUntil: () => {} });
  assert.equal(empty.status, 400);

  const jsonp = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/jsonp' },
    body: JSON.stringify({ event_type: 'artifact_intent' }),
  }), env, { waitUntil: () => {} });
  assert.equal(jsonp.status, 415);
  assert.equal(dbCalls, 0);
});

test('/api/visit validates the cookie against D1 before treating it as a returning visitor', async () => {
  let lookups = 0;
  const lookupMap = new Map([
    ['9f2f56789abc', { results: [{ visitor_id: '9f2f56789abc' }] }],
    ['9f2f56789abc99999999999999999999999', { results: [] }],
  ]);

  const env = {
    DB: {
      prepare(sql) {
        if (sql.includes('SELECT visitor_id FROM visitors WHERE visitor_id = ? LIMIT 1')) {
          return {
            bind(candidate) {
              return {
                all() {
                  lookups += 1;
                  return lookupMap.get(candidate) || { results: [] };
                },
              };
            },
          };
        }
        return {
          bind() {
            return {
              run() { return {}; },
              all() { return { results: [] }; },
            };
          },
        };
      },
      batch() {
        return Promise.resolve();
      },
    },
  };

  const existing = await worker.fetch(new Request('https://example.test/api/visit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'trb_visitor=9f2f56789abc',
    },
    body: JSON.stringify({ ref: 'https://example.com/landing' }),
  }), env, { waitUntil: () => {} });
  assert.equal(existing.status, 200);
  assert.deepEqual(await existing.json(), { ok: true, newVisitor: false });
  assert.equal(lookups, 1);

  const missing = await worker.fetch(new Request('https://example.test/api/visit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'trb_visitor=9f2f56789abc99999999999999999999999',
    },
    body: JSON.stringify({ ref: 'https://example.com/landing' }),
  }), env, { waitUntil: () => {} });
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).newVisitor, true);

  const invalid = await worker.fetch(new Request('https://example.test/api/visit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'trb_visitor=bad-cookie',
    },
    body: JSON.stringify({ ref: 'https://example.com/landing' }),
  }), env, { waitUntil: () => {} });
  assert.equal(invalid.status, 200);
  assert.equal((await invalid.json()).newVisitor, true);
});

test('/api/visit fails closed when the cookie lookup hits D1 storage failure', async () => {
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              all() { throw new Error('db failure'); },
            };
          },
        };
      },
    },
  };

  const response = await worker.fetch(new Request('https://example.test/api/visit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'trb_visitor=9f2f56789abc',
    },
    body: JSON.stringify({ ref: 'https://example.com/landing' }),
  }), env, { waitUntil: () => {} });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: 'storage_unavailable' });
});

test('telegram webhook rejects requests when the server secret is missing', async () => {
  const dbCalls = [];
  const env = {
    DB: {
      prepare(sql) {
        dbCalls.push(sql);
        return { bind() { return { all() { return { results: [] }; }, run() { return {}; } }; } };
      },
    },
  };

  const { response, bodyText } = await callWebhook(env, '/telegram/webhook', {
    'X-Telegram-Bot-Api-Secret-Token': 'expected-secret',
  }, JSON.stringify({ update_id: 1 }));

  assert.equal(response.status, 500);
  assert.equal(bodyText, 'Server webhook configuration missing');
  assert.equal(dbCalls.length, 0);
});

test('telegram webhook rejects unauthorized or malformed payloads before JSON parsing', async () => {
  let dbCalls = 0;
  const env = {
    TELEGRAM_WEBHOOK_SECRET: 'expected-secret',
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { all() { return { results: [] }; }, run() { return {}; } }; } };
      },
    },
  };

  const { response, bodyText } = await callWebhook(env, '/telegram/webhook', {}, '{bad-json');

  assert.equal(response.status, 401);
  assert.equal(bodyText, 'Unauthorized');
  assert.equal(dbCalls, 0);
});

test('telegram webhook accepts valid authentication on the stable endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const env = {
    TELEGRAM_BOT_TOKEN: 'TESTTOKEN',
    TELEGRAM_WEBHOOK_SECRET: 'expected-secret',
    DB: {
      prepare(sql) {
        if (sql.includes('SELECT step, answers')) {
          return {
            bind() {
              return {
                all() { return { results: [] }; },
              };
            },
          };
        }
        return {
          bind() {
            return {
              run() { return {}; },
            };
          },
        };
      },
    },
  };

  globalThis.fetch = async (url, init) => {
    calls.push(url);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const { response } = await callWebhook(env, '/telegram/webhook', {
      'X-Telegram-Bot-Api-Secret-Token': 'expected-secret',
    }, JSON.stringify({ update_id: 1, message: { chat: { id: 42, type: 'private' }, text: '/start' } }));

    assert.equal(response.status, 200);
    assert.ok(calls.some((url) => url.includes('/botTESTTOKEN/sendMessage')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('classifyTraffic never trusts client-supplied metadata as proof of ownership or automation', () => {
  assert.equal(classifyTraffic(new Request('https://example.test'), { email: 'tyu433911@gmail.com' }), 'external_unknown');
  assert.equal(classifyTraffic(new Request('https://example.test', { headers: { referer: 'https://example.com/owner/landing' } }), {}), 'external_unknown');
  assert.equal(classifyTraffic(new Request('https://example.test', { headers: { 'User-Agent': 'Playwright/1.0' } }), {}), 'external_unknown');
  assert.equal(classifyTraffic(new Request('https://localhost:8787/test'), {}), 'qa');
});

test('/api/interest rejects unsupported methods and invalid JSON contracts before D1 writes', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return {
          bind() {
            return { run() { return {}; } };
          },
        };
      },
    },
  };

  const getResp = await worker.fetch(new Request('https://example.test/api/interest', { method: 'GET' }), env, { waitUntil: () => {} });
  assert.equal(getResp.status, 405);
  assert.equal(dbCalls, 0);

  const wrongType = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
  }), env, { waitUntil: () => {} });
  assert.equal(wrongType.status, 415);
  assert.equal(dbCalls, 0);

  const malformed = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad-json',
  }), env, { waitUntil: () => {} });
  assert.equal(malformed.status, 400);
  assert.equal(dbCalls, 0);

  const oversize = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'artifact_intent', ref: 'x'.repeat(60000) }),
  }), env, { waitUntil: () => {} });
  assert.equal(oversize.status, 413);
  assert.equal(dbCalls, 0);
});

test('/api/interest rejects invalid event types and invalid email values', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { run() { return {}; } }; } };
      },
    },
  };

  const invalidEvent = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'unknown_event' }),
  }), env, { waitUntil: () => {} });
  assert.equal(invalidEvent.status, 400);
  assert.equal(dbCalls, 0);

  const invalidEmail = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'artifact_intent', email: 'not-an-email' }),
  }), env, { waitUntil: () => {} });
  assert.equal(invalidEmail.status, 400);
  assert.equal(dbCalls, 0);
});

test('/api/interest accepts the supported frontend event contract and persists a single event', async () => {
  const calls = [];
  const env = {
    DB: {
      prepare(sql) {
        calls.push(sql);
        return {
          bind(...args) {
            calls.push(args);
            return { run() { return {}; } };
          },
        };
      },
    },
  };

  const response = await worker.fetch(new Request('https://example.test/api/interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'artifact_intent', ref: 'https://example.com/landing' }),
  }), env, { waitUntil: () => {} });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.match(String(calls[0]), /INSERT INTO interest_events/);
});

test('/api/visit rejects GET and performs no D1 writes', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { run() { return {}; } }; } };
      },
    },
  };

  const response = await worker.fetch(new Request('https://example.test/api/visit?ref=https%3A%2F%2Fexample.com', { method: 'GET' }), env, { waitUntil: () => {} });
  assert.equal(response.status, 405);
  assert.equal(dbCalls, 0);
});

test('/api/visit creates a valid visitor record and sets secure cookie attributes on HTTPS', async () => {
  const actions = [];
  const env = {
    DB: {
      prepare(sql) {
        actions.push(sql);
        return {
          bind(...args) {
            actions.push(args);
            return { run() { return {}; } };
          },
        };
      },
      batch(statements) {
        actions.push('batch');
        return Promise.resolve(statements);
      },
    },
  };

  const response = await worker.fetch(new Request('https://example.test/api/visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'https://example.com/landing' }),
  }), env, { waitUntil: () => {} });

  const cookie = response.headers.get('set-cookie');
  assert.equal(response.status, 200);
  assert.match(cookie, /trb_visitor=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.ok(actions.some((entry) => String(entry).includes('INSERT INTO visitors')));
  assert.ok(actions.some((entry) => String(entry).includes('INSERT INTO interest_events')));
});

test('/api/visit reuses an existing valid visitor cookie without creating a second unique visitor', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare(sql) {
        if (sql.includes('SELECT visitor_id')) {
          return { bind() { return { all() { dbCalls += 1; return { results: [{ visitor_id: '1234567890ab' }] }; } }; } };
        }
        return { bind() { return { run() { return {}; } }; } };
      },
      batch() { return Promise.resolve(); },
    },
  };

  const visitorId = '1234567890ab';
  const response = await worker.fetch(new Request('https://example.test/api/visit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `trb_visitor=${visitorId}`,
    },
    body: JSON.stringify({ ref: 'https://example.com/landing' }),
  }), env, { waitUntil: () => {} });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, newVisitor: false });
  assert.equal(dbCalls, 1);
});

test('/api/visit ignores invalid cookie values and still creates a new visitor record', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return { bind() { return { run() { return {}; } }; } };
      },
      batch() { return Promise.resolve(); },
    },
  };

  const response = await worker.fetch(new Request('https://example.test/api/visit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'trb_visitor=bad-cookie; other=value',
    },
    body: JSON.stringify({ ref: 'https://example.com/landing' }),
  }), env, { waitUntil: () => {} });

  assert.equal(response.status, 200);
  assert.equal(dbCalls, 2);
});

test('anonymous requests cannot access public analytics data through /api/stats', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return {
          bind() {
            return {
              all() { return { results: [{ event_type: 'real_visit', traffic_type: 'external_unknown', c: 7 }] }; },
              run() { return {}; },
            };
          },
        };
      },
    },
  };

  const request = new Request('https://example.test/api/stats', { method: 'GET' });
  const response = await worker.fetch(request, env, { waitUntil: () => {} });
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.equal(body, 'Not found');
  assert.equal(dbCalls, 0);
});

test('unsupported methods to /api/stats are rejected without leaking database records', async () => {
  let dbCalls = 0;
  const env = {
    DB: {
      prepare() {
        dbCalls += 1;
        return {
          bind() {
            return {
              all() { return { results: [{ event_type: 'real_visit', traffic_type: 'external_unknown', c: 2 }] }; },
              run() { return {}; },
            };
          },
        };
      },
    },
  };

  const request = new Request('https://example.test/api/stats', { method: 'POST' });
  const response = await worker.fetch(request, env, { waitUntil: () => {} });
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.equal(body, 'Not found');
  assert.equal(dbCalls, 0);
});

test('escapeHTML escapes special chars', () => {
  assert.equal(escapeHTML('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

test('mdToTelegramHTML: bold, heading, bullet, code', () => {
  const out = mdToTelegramHTML('# Title\n\n**bold** and *italic* and `code`\n- one\n- two');
  assert.match(out, /<b>Title<\/b>/);
  assert.match(out, /<b>bold<\/b>/);
  assert.match(out, /<i>italic<\/i>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /• one/);
  assert.match(out, /• two/);
});

test('mdToTelegramHTML does not leak raw markdown markers', () => {
  const out = mdToTelegramHTML('**bold**');
  assert.ok(!out.includes('**'));
});

test('splitLongParagraph respects sentence boundaries and max', () => {
  const parts = splitLongParagraph('Alpha beta gamma. Delta epsilon zeta.', 30);
  assert.equal(parts.length, 2);
  for (const p of parts) assert.ok(p.length <= 30);
  assert.ok(parts[0].includes('Alpha beta gamma.'));
  assert.ok(parts[1].includes('Delta epsilon zeta.'));
});

test('splitTelegramMessage: short text => single part, no Part label', () => {
  const parts = splitTelegramMessage('Just a short answer.');
  assert.equal(parts.length, 1);
  assert.ok(!parts[0].includes('Part'));
});

test('splitTelegramMessage: long text => multiple labeled parts, none over max', () => {
  const para = 'Sentence one about taxes. Sentence two about deductions. Sentence three about credits. Sentence four about refunds. Sentence five about forms. Sentence six about deadlines. Sentence seven about IRS. Sentence eight about state taxes. Sentence nine about crypto. Sentence ten about income.';
  const parts = splitTelegramMessage(para, 200);
  assert.ok(parts.length >= 2);
  // every part carries a correct "Part X/Y" label
  const labelRe = /^📦 Part \d+\/\d+\n\n/;
  for (const p of parts) assert.match(p, labelRe);
  // no part exceeds max by a wide margin (label adds ~20 chars)
  for (const p of parts) assert.ok(p.length <= 230);
  // the original sentences are all preserved (none dropped)
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const joined = parts.join('\n');
  for (const w of words) {
    assert.ok(joined.includes(`Sentence ${w} about`), `missing Sentence ${w}`);
  }
});

test('splitTelegramMessage never splits a paragraph mid-sentence', () => {
  const text = 'Alpha beta gamma. Delta epsilon zeta.';
  const parts = splitTelegramMessage(text, 30);
  for (const p of parts) {
    // a part may not end with a dangling word fragment of a sentence
    assert.ok(/\S/.test(p), 'part is non-empty');
  }
  // combined content preserves every original sentence intact (no mid-sentence cut)
  const joined = parts.map((p) => p.replace(/^📦 Part \d+\/\d+\n\n/, '')).join('\n');
  assert.ok(joined.includes('Alpha beta gamma.'));
  assert.ok(joined.includes('Delta epsilon zeta.'));
});

test('buildReport with no answers still shows the standard deduction + disclaimer', () => {
  const r = buildReport({});
  assert.match(r, /Standard deduction/);
  assert.match(r, /\$15,750/);
  assert.match(r, /Educational information only/);
});

test('buildReport with gig + home office answers includes both findings', () => {
  const answers = {};
  applyFlags(answers, 'status:hoh');
  applyFlags(answers, 'gig');
  applyFlags(answers, 'inc:low');
  applyFlags(answers, 'home');
  const r = buildReport(answers);
  assert.match(r, /Self-employment deductions/);
  assert.match(r, /Home office deduction/);
  assert.match(r, /Possible EITC review area/);
  assert.match(r, /\$23,625/);
});

test('W-2 remote worker gets the honest home-office notice, not the deduction', () => {
  const answers = {};
  applyFlags(answers, 'homeW2');
  const names = evaluateAnswers(answers).map((f) => f.name);
  assert.ok(names.includes('Home office: honest check'));
  assert.ok(!names.includes('Home office deduction'));
});

test('2025 figures regression: correct amounts present, stale ones absent', () => {
  const blob = JSON.stringify({ QUIZ, STD_DEDUCTION, report: buildReport({ status: 'mfj', gig: true, kids: true, study: true, give: true, medical: true, ret: true }) });
  assert.match(blob, /\$15,750/);
  assert.match(blob, /\$31,500/);
  assert.match(blob, /\$23,625/);
  assert.match(blob, /70¢/);
  assert.ok(!blob.includes('$15,000'));
  assert.ok(!blob.includes('$30,000'));
  assert.ok(!blob.includes('$22,500'));
  assert.ok(!blob.includes('$8,291')); // 2023-era EITC max
});

test('quiz has 8 multiselect questions with up to 4 options and flag arrays', () => {
  assert.equal(QUIZ.length, 8);
  for (const q of QUIZ) {
    assert.ok(q.opts.length >= 2 && q.opts.length <= 4, `${q.key}: 2-4 options`);
    assert.equal(q.flags.length, q.opts.length, `${q.key}: flags match options`);
  }
});

test('SYSTEM_PROMPT enforces required policies', () => {
  assert.match(SYSTEM_PROMPT, /teenager|teen|beginner/i);
  assert.match(SYSTEM_PROMPT, /never.*invent|couldn't verify|fabricate/i);
  assert.match(SYSTEM_PROMPT, /tax year.*2025|2025.*tax year/i);
  assert.match(SYSTEM_PROMPT, /MARKDOWN/i);
  assert.match(SYSTEM_PROMPT, /same language|Russian|respond in the SAME/i);
  assert.match(SYSTEM_PROMPT, /Worker appends the educational disclaimer/);
  assert.match(SYSTEM_PROMPT, /Do not request Social Security numbers/);
  assert.match(SYSTEM_PROMPT, /250 words/i); // explicitly tells it NOT to cap at 250
});

test('MENU_TEXT lists teen-friendly categories', () => {
  assert.match(MENU_TEXT, /💰/);
  assert.match(MENU_TEXT, /📉/);
  assert.match(MENU_TEXT, /🎁/);
  assert.match(MENU_TEXT, /💼/);
  assert.match(MENU_TEXT, /🎓/);
});

test('TAX_YEAR is the single source of truth and is not 2026', () => {
  assert.equal(TAX_YEAR, 2025);
  assert.notEqual(TAX_YEAR, 2026);
  assert.match(DISCLAIMER, new RegExp(`tax year ${TAX_YEAR}`));
  assert.match(GUIDE, new RegExp(`tax year ${TAX_YEAR}`));
});

test('User-facing content uses 2025, not a hardcoded 2026 tax year', () => {
  const blob = JSON.stringify({
    QUIZ, STD_DEDUCTION,
    report: buildReport({ status: 'mfj', gig: true, kids: true, study: true, give: true, medical: true, ret: true }),
    DISCLAIMER, GUIDE,
  });
  assert.ok(!/tax year 2026|for 2026|2026\)/.test(blob), 'no 2026 tax-year claim in user-facing text');
  assert.match(blob, /\$15,750/);
  assert.match(blob, /\$31,500/);
  assert.match(blob, /\$23,625/);
});

test('EITC finding does not infer eligibility from the income bracket alone', () => {
  const r = buildReport({ status: 'mfj', kids: true, inc: 'low' });
  assert.match(r, /Possible EITC review area/);
  assert.match(r, /cannot establish eligibility/);
  assert.doesNotMatch(r, /\$8,046/);
});

test('SYSTEM_PROMPT distinguishes deduction vs credit vs refund', () => {
  assert.match(SYSTEM_PROMPT, /deduction.*credit.*refund|refund.*deduction|deduction.*refund/i);
  assert.match(SYSTEM_PROMPT, /guarantees? money back|guarantee.*money/i);
});
