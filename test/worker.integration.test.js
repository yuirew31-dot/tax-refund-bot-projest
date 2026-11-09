import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { __testables } from '../src/worker.js';

const {
  QUIZ,
  groqChat,
  readGroqConfig,
  reserveGroqUsage,
  tg,
} = __testables();
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schema);

  function prepare(sql) {
    let params = [];
    const statement = {
      sql,
      bind(...values) {
        params = values;
        return statement;
      },
      all() {
        return { results: sqlite.prepare(sql).all(...params) };
      },
      first() {
        return sqlite.prepare(sql).get(...params) ?? null;
      },
      run() {
        const result = sqlite.prepare(sql).run(...params);
        return { meta: { changes: Number(result.changes) } };
      },
    };
    return statement;
  }

  return {
    sqlite,
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      sqlite.close();
    },
  };
}

function makeEnv(DB, overrides = {}) {
  return {
    DB,
    TELEGRAM_BOT_TOKEN: 'test-telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
    ...overrides,
  };
}

async function callWebhook(env, update) {
  const tasks = [];
  const response = await worker.fetch(new Request('https://example.test/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  }), env, {
    waitUntil(task) {
      tasks.push(task);
    },
  });
  await Promise.all(tasks);
  return response;
}

function telegramUpdate(updateId, chatId, text) {
  return {
    update_id: updateId,
    message: { message_id: updateId, chat: { id: chatId, type: 'private' }, text },
  };
}

function callbackUpdate(updateId, chatId, callbackData) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      data: callbackData,
      message: { message_id: updateId, chat: { id: chatId, type: 'private' } },
    },
  };
}

async function withMockFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('local SQL adapter preserves visitor attribution and keeps email unset', async () => {
  const DB = createD1();
  try {
    const env = makeEnv(DB);
    const visit = await worker.fetch(new Request('https://example.test/api/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }), env);
    assert.equal(visit.status, 200);
    const cookie = visit.headers.get('set-cookie');
    assert.match(cookie, /^trb_visitor=[A-Za-z0-9-]+;/);

    const visitorId = cookie.match(/^trb_visitor=([^;]+)/)[1];
    const event = await worker.fetch(new Request('https://example.test/api/interest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie.split(';', 1)[0],
      },
      body: JSON.stringify({ event_type: 'artifact_intent', ref: '/beta' }),
    }), env);
    assert.equal(event.status, 200);

    const rows = DB.sqlite.prepare(
      'SELECT event_type, email, visitor_id FROM interest_events ORDER BY id'
    ).all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].event_type, 'real_visit');
    assert.equal(rows[0].visitor_id, visitorId);
    assert.equal(rows[1].event_type, 'artifact_intent');
    assert.equal(rows[1].email, null);
    assert.equal(rows[1].visitor_id, visitorId);
  } finally {
    DB.close();
  }
});

test('webhook enforces the exact route, method, body limit, and Telegram update shape', async () => {
  const DB = createD1();
  let outboundCalls = 0;
  try {
    const env = makeEnv(DB);
    await withMockFetch(async () => {
      outboundCalls += 1;
      return Response.json({ ok: true, result: {} });
    }, async () => {
      const request = (path, method, body) => worker.fetch(new Request(`https://example.test${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': env.TELEGRAM_WEBHOOK_SECRET,
        },
        body,
      }), env, { waitUntil() {} });

      assert.equal((await request('/telegram/old-secret-path', 'POST', '{}')).status, 404);
      assert.equal((await request('/telegram/webhook', 'GET')).status, 405);
      assert.equal((await request('/telegram/webhook', 'POST', ' '.repeat(65537))).status, 413);
      assert.equal((await request('/telegram/webhook', 'POST', '{"update_id":-1}')).status, 400);
      assert.equal((await request('/telegram/webhook', 'POST', '{"update_id":1,"edited_message":{}}')).status, 200);
      assert.equal(outboundCalls, 0);
      assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM bot_state').get().count, 0);
    });
  } finally {
    DB.close();
  }
});

test('quiz callbacks are session-bound, atomic, replay-safe, and /delete clears app state', async () => {
  const DB = createD1();
  const sends = [];
  let updateId = 1;
  try {
    const env = makeEnv(DB);
    await withMockFetch(async (input, options) => {
      const method = new URL(input).pathname.split('/').at(-1);
      const payload = options.body ? JSON.parse(options.body) : {};
      if (method === 'sendMessage') sends.push(payload);
      return Response.json({ ok: true, result: { message_id: sends.length } });
    }, async () => {
      const chatId = 745;
      assert.equal((await callWebhook(env, telegramUpdate(updateId++, chatId, '/check'))).status, 200);
      const firstCallback = sends.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
      const oldSessionId = firstCallback.split(':')[1];

      await Promise.all([
        callWebhook(env, callbackUpdate(updateId++, chatId, firstCallback)),
        callWebhook(env, callbackUpdate(updateId++, chatId, firstCallback)),
      ]);
      assert.equal(sends.length, 2);
      let state = DB.sqlite.prepare(
        'SELECT step, answers, session_id FROM bot_state WHERE chat_id = ?'
      ).get(chatId);
      assert.equal(state.step, 'q:1');
      assert.equal(JSON.parse(state.answers).status, 'single');

      await callWebhook(env, callbackUpdate(updateId++, chatId, firstCallback));
      assert.equal(sends.length, 2);

      await callWebhook(env, telegramUpdate(updateId++, chatId, '/check'));
      const newFirstCallback = sends.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
      const newSessionId = newFirstCallback.split(':')[1];
      assert.notEqual(newSessionId, oldSessionId);
      await callWebhook(env, callbackUpdate(updateId++, chatId, firstCallback));
      state = DB.sqlite.prepare(
        'SELECT step, session_id FROM bot_state WHERE chat_id = ?'
      ).get(chatId);
      assert.equal(state.step, 'q:0');
      assert.equal(state.session_id, newSessionId);

      let finalCallback;
      for (let questionIndex = 0; questionIndex < QUIZ.length; questionIndex += 1) {
        const callbackData = sends.at(-1).reply_markup.inline_keyboard[0][0].callback_data;
        assert.ok(Buffer.byteLength(callbackData, 'utf8') <= 64);
        if (questionIndex === QUIZ.length - 1) finalCallback = callbackData;
        await callWebhook(env, callbackUpdate(updateId++, chatId, callbackData));
      }
      const reportSendCount = sends.length;
      assert.match(sends.at(-1).text, /Educational information only/);
      state = DB.sqlite.prepare(
        'SELECT step, session_id FROM bot_state WHERE chat_id = ?'
      ).get(chatId);
      assert.equal(state.step, 'done');
      assert.equal(state.session_id, newSessionId);

      await callWebhook(env, callbackUpdate(updateId++, chatId, finalCallback));
      assert.equal(sends.length, reportSendCount);

      DB.sqlite.prepare('INSERT INTO ai_usage (chat_id, reserved_at) VALUES (?, ?)').run(chatId, Date.now());
      await callWebhook(env, telegramUpdate(updateId++, chatId, '/delete'));
      assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM bot_state WHERE chat_id = ?').get(chatId).count, 0);
      assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM ai_usage WHERE chat_id = ?').get(chatId).count, 0);
      assert.match(sends.at(-1).text, /does not delete Telegram chat history/);
    });
  } finally {
    DB.close();
  }
});

test('private-chat AI replies are escaped, include the disclaimer, and never persist question text', async () => {
  const DB = createD1();
  const groqRequests = [];
  const telegramSends = [];
  try {
    const env = makeEnv(DB, { GROQ_API_KEY: 'test-groq-key' });
    await withMockFetch(async (input, options) => {
      const url = String(input);
      if (url.includes('api.groq.com')) {
        const body = JSON.parse(options.body);
        groqRequests.push(body);
        return Response.json({
          choices: [{ message: { content: 'A tax answer with <script>alert(1)</script>.' } }],
        });
      }

      const method = new URL(input).pathname.split('/').at(-1);
      if (method === 'sendMessage') telegramSends.push(JSON.parse(options.body));
      return Response.json({ ok: true, result: { message_id: telegramSends.length } });
    }, async () => {
      const question = 'Can I deduct my laptop?';
      const response = await callWebhook(env, telegramUpdate(1, 909, question));
      assert.equal(response.status, 200);
    });

    assert.equal(groqRequests.length, 1);
    assert.equal(groqRequests[0].messages.at(-1).content, 'Can I deduct my laptop?');
    assert.equal(telegramSends.length, 1);
    assert.match(telegramSends[0].text, /Educational information only/);
    assert.match(telegramSends[0].text, /&lt;script&gt;/);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM ai_usage').get().count, 1);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM bot_state').get().count, 0);
    assert.doesNotMatch(JSON.stringify(DB.sqlite.prepare('SELECT * FROM ai_usage').all()), /laptop/i);
  } finally {
    DB.close();
  }
});

test('website AI answers use the verified visitor quota and do not persist question text', async () => {
  const DB = createD1();
  const visitorId = 'web-visitor-1234';
  const question = 'Synthetic question about keeping business records?';
  const groqRequests = [];
  try {
    DB.sqlite.prepare(
      'INSERT INTO visitors (created_at, visitor_id) VALUES (?, ?)'
    ).run(new Date().toISOString(), visitorId);
    const env = makeEnv(DB, {
      GROQ_API_KEY: 'test-groq-key',
      GROQ_CHAT_10MIN_LIMIT: '1',
    });
    const makeRequest = (text) => new Request('https://example.test/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://example.test',
        Cookie: `trb_visitor=${visitorId}`,
      },
      body: JSON.stringify({ question: text }),
    });

    await withMockFetch(async (input, options) => {
      assert.match(String(input), /^https:\/\/api\.groq\.com\//);
      groqRequests.push(JSON.parse(options.body));
      return Response.json({
        choices: [{ message: { content: 'Keep receipts and mileage records.' } }],
      });
    }, async () => {
      const response = await worker.fetch(makeRequest(question), env);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.answer, 'Keep receipts and mileage records.');
      assert.match(body.disclaimer, /Educational information only/);

      const limited = await worker.fetch(makeRequest('Another synthetic question?'), env);
      assert.equal(limited.status, 429);
      assert.deepEqual(await limited.json(), { ok: false, error: 'limit_reached' });
    });

    assert.equal(groqRequests.length, 1);
    assert.equal(groqRequests[0].model, 'openai/gpt-oss-120b');
    assert.equal(groqRequests[0].messages.at(-1).content, question);
    const usage = DB.sqlite.prepare(
      'SELECT chat_id, visitor_id FROM ai_usage'
    ).all();
    assert.equal(usage.length, 1);
    assert.equal(usage[0].chat_id, 0);
    assert.equal(usage[0].visitor_id, visitorId);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM bot_state').get().count, 0);
    assert.doesNotMatch(JSON.stringify(DB.sqlite.prepare('SELECT * FROM ai_usage').all()), /Synthetic|records/i);
  } finally {
    DB.close();
  }
});

test('website AI route rejects cross-origin, unknown visitor, and over-limit inputs before Groq', async () => {
  const DB = createD1();
  const visitorId = 'web-visitor-5678';
  let outboundCalls = 0;
  try {
    DB.sqlite.prepare(
      'INSERT INTO visitors (created_at, visitor_id) VALUES (?, ?)'
    ).run(new Date().toISOString(), visitorId);
    const env = makeEnv(DB, {
      GROQ_API_KEY: 'test-groq-key',
      GROQ_MAX_INPUT_CHARS: '12',
    });
    const makeRequest = (question, overrides = {}) => new Request('https://example.test/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://example.test',
        Cookie: `trb_visitor=${visitorId}`,
        ...overrides,
      },
      body: JSON.stringify({ question }),
    });

    await withMockFetch(async () => {
      outboundCalls += 1;
      return Response.json({ choices: [{ message: { content: 'answer' } }] });
    }, async () => {
      assert.equal((await worker.fetch(makeRequest('short question', {
        Origin: 'https://attacker.example',
      }), env)).status, 403);
      assert.equal((await worker.fetch(makeRequest('short', {
        Cookie: '',
      }), env)).status, 401);
      assert.equal((await worker.fetch(makeRequest('question is too long', {}), env)).status, 400);
    });

    assert.equal(outboundCalls, 0);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM ai_usage').get().count, 0);
  } finally {
    DB.close();
  }
});

test('website AI provider failures return a generic response and do not echo provider details', async () => {
  const DB = createD1();
  const visitorId = 'web-visitor-9012';
  const question = 'Synthetic question with no personal information.';
  try {
    DB.sqlite.prepare(
      'INSERT INTO visitors (created_at, visitor_id) VALUES (?, ?)'
    ).run(new Date().toISOString(), visitorId);
    const env = makeEnv(DB, { GROQ_API_KEY: 'test-groq-key' });
    const request = new Request('https://example.test/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://example.test',
        Cookie: `trb_visitor=${visitorId}`,
      },
      body: JSON.stringify({ question }),
    });

    await withMockFetch(async () => new Response('provider-private-error-detail', { status: 500 }), async () => {
      const response = await worker.fetch(request, env);
      assert.equal(response.status, 503);
      const body = await response.text();
      assert.equal(body, '{"ok":false,"error":"unavailable"}');
      assert.doesNotMatch(body, /provider-private|Synthetic question/);
    });
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM ai_usage').get().count, 1);
    assert.doesNotMatch(JSON.stringify(DB.sqlite.prepare('SELECT * FROM ai_usage').all()), /Synthetic|personal/i);
  } finally {
    DB.close();
  }
});

test('D1 quota reservations enforce chat/global windows under concurrent calls and reset at UTC boundaries', async () => {
  const DB = createD1();
  try {
    const config = readGroqConfig({
      GROQ_CHAT_DAILY_LIMIT: '5',
      GROQ_CHAT_10MIN_LIMIT: '2',
      GROQ_GLOBAL_DAILY_LIMIT: '10',
      GROQ_GLOBAL_10MIN_LIMIT: '10',
    });
    const start = Date.UTC(2026, 10, 7, 23, 40);
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => reserveGroqUsage({ DB }, 101, config, start))
    );
    assert.equal(concurrent.filter((result) => result.ok).length, 2);

    const afterWindow = await Promise.all([
      reserveGroqUsage({ DB }, 101, config, start + config.tenMinutesMs + 1),
      reserveGroqUsage({ DB }, 101, config, start + config.tenMinutesMs + 2),
    ]);
    assert.equal(afterWindow.filter((result) => result.ok).length, 2);

    const nextDay = Date.UTC(2026, 10, 8, 0, 1);
    const reset = await reserveGroqUsage({ DB }, 101, config, nextDay);
    assert.equal(reset.ok, true);
    const count = DB.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM ai_usage WHERE reserved_at >= ?'
    ).get(Date.UTC(2026, 10, 8)).count;
    assert.equal(count, 1);

    const webDb = createD1();
    try {
      const visitorId = 'web-quota-visitor-1';
      webDb.sqlite.prepare(
        'INSERT INTO visitors (created_at, visitor_id) VALUES (?, ?)'
      ).run(new Date().toISOString(), visitorId);
      const webConfig = readGroqConfig({
        GROQ_CHAT_DAILY_LIMIT: '5',
        GROQ_CHAT_10MIN_LIMIT: '2',
        GROQ_GLOBAL_DAILY_LIMIT: '10',
        GROQ_GLOBAL_10MIN_LIMIT: '10',
      });
      const webConcurrent = await Promise.all(
        Array.from({ length: 8 }, () => reserveGroqUsage({ DB: webDb }, visitorId, webConfig, start))
      );
      assert.equal(webConcurrent.filter((result) => result.ok).length, 2);
      assert.equal(webDb.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM ai_usage WHERE visitor_id = ?'
      ).get(visitorId).count, 2);
    } finally {
      webDb.close();
    }

    const globalDb = createD1();
    try {
      const globalConfig = readGroqConfig({
        GROQ_CHAT_DAILY_LIMIT: '10',
        GROQ_CHAT_10MIN_LIMIT: '5',
        GROQ_GLOBAL_DAILY_LIMIT: '3',
        GROQ_GLOBAL_10MIN_LIMIT: '3',
      });
      const globalResults = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          reserveGroqUsage({ DB: globalDb }, 200 + index, globalConfig, start))
      );
      assert.equal(globalResults.filter((result) => result.ok).length, 3);
      assert.equal(globalResults.filter((result) => result.error === 'quota_exceeded').length, 2);
    } finally {
      globalDb.close();
    }
  } finally {
    DB.close();
  }
});

test('Groq requests enforce configured quotas, output bounds, and provider cooldowns', async () => {
  const DB = createD1();
  const requests = [];
  try {
    const env = makeEnv(DB, {
      GROQ_API_KEY: 'test-groq-key',
      GROQ_MAX_OUTPUT_CHARS: '5',
      GROQ_CHAT_DAILY_LIMIT: '2',
      GROQ_CHAT_10MIN_LIMIT: '2',
      GROQ_GLOBAL_DAILY_LIMIT: '2',
      GROQ_GLOBAL_10MIN_LIMIT: '2',
    });
    await withMockFetch(async (input, options) => {
      requests.push({ url: String(input), options, body: JSON.parse(options.body) });
      return Response.json({
        choices: [{ message: { content: '123456789' } }],
      });
    }, async () => {
      const messages = [{ role: 'user', content: 'short question' }];
      const first = await groqChat(env, 202, 'short question', messages);
      assert.equal(first.text, '12345…');
      assert.equal(first.truncated, true);
      assert.equal(requests[0].body.max_tokens, 600);
      assert.equal(requests[0].options.headers.Authorization, 'Bearer test-groq-key');
      assert.equal(requests[0].body.messages[0].content, 'short question');

      assert.equal((await groqChat(env, 202, 'second question', messages)).truncated, true);
      assert.equal((await groqChat(env, 202, 'third question', messages)).error, 'quota_exceeded');
      assert.equal(requests.length, 2);
      assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS count FROM ai_usage').get().count, 2);
    });

    const cooldownDb = createD1();
    try {
      const cooldownEnv = makeEnv(cooldownDb, { GROQ_API_KEY: 'test-groq-key' });
      let attempts = 0;
      await withMockFetch(async () => {
        attempts += 1;
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '60' },
        });
      }, async () => {
        assert.equal((await groqChat(cooldownEnv, 303, 'question', [])).error, 'provider_rate_limited');
        assert.equal((await groqChat(cooldownEnv, 303, 'question', [])).error, 'provider_cooldown');
      });
      assert.equal(attempts, 1);
      assert.ok(cooldownDb.sqlite.prepare(
        'SELECT retry_after FROM provider_cooldowns WHERE provider = ?'
      ).get('groq').retry_after > Math.floor(Date.now() / 1000));
    } finally {
      cooldownDb.close();
    }
  } finally {
    DB.close();
  }
});

test('Groq timeout and Telegram network errors are bounded and sanitized', async () => {
  const DB = createD1();
  try {
    const env = makeEnv(DB, { GROQ_API_KEY: 'test-groq-key', GROQ_TIMEOUT_MS: '5' });
    await withMockFetch(async (_input, options) => new Promise((_resolve, reject) => {
      const fail = () => reject(new Error('sensitive request content'));
      if (options.signal.aborted) fail();
      else options.signal.addEventListener('abort', fail, { once: true });
    }), async () => {
      assert.equal((await groqChat(env, 404, 'question', [])).error, 'timeout');
    });

    await withMockFetch(async () => {
      throw new Error('sensitive request content');
    }, async () => {
      await assert.rejects(
        tg(env, 'sendMessage', { text: 'do not log this' }),
        (error) => error.category === 'network' && !error.message.includes('sensitive'),
      );
    });

    await withMockFetch(async () => new Response('not-json', { status: 200 }), async () => {
      await assert.rejects(tg(env, 'sendMessage', {}), (error) => error.category === 'invalid_json');
    });
    await withMockFetch(async () => Response.json({ ok: false }, { status: 429 }), async () => {
      await assert.rejects(tg(env, 'sendMessage', {}), (error) => error.category === 'rate_limited');
    });
  } finally {
    DB.close();
  }
});
