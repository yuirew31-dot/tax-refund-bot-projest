// TaxRefund Bot — Worker: static landing + D1 demand tracking + Telegram bot (Groq AI Q&A).
//
// Secrets (set via `wrangler secret put`, NEVER hardcoded):
//   TELEGRAM_BOT_TOKEN      — token from @BotFather
//   TELEGRAM_WEBHOOK_SECRET — random string sent in Telegram's secret_token header
//   GROQ_API_KEY            — key from console.groq.com

const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';
const MAX_WEBHOOK_BODY_BYTES = 65536;
const TELEGRAM_TIMEOUT_MS = 8000;

const MAX_INTEREST_BODY_BYTES = 32768;
const MAX_REFERRER_LENGTH = 500;
const MAX_USER_AGENT_LENGTH = 500;
const ALLOWED_EVENT_TYPES = new Set([
  'quiz_start',
  'quiz_complete',
  'artifact_intent',
  'beta_interest',
  'telegram_open',
]);
const GROQ_LIMITS = Object.freeze({
  maxInputChars: 2000,
  maxOutputTokens: 600,
  maxOutputChars: 2600,
  timeoutMs: 15000,
  chatDaily: 10,
  chatTenMinutes: 5,
  globalDaily: 50,
  globalTenMinutes: 10,
  tenMinutesMs: 10 * 60 * 1000,
});

/* ============================== TAX KNOWLEDGE BASE ==============================
   Educational content based on the Internal Revenue Code (IRC) and IRS publications.
   Figures are tax-year 2025; users are told to verify current numbers at IRS.gov. */

function classifyTraffic(request, body = {}) {
  const url = (() => {
    try {
      return new URL(request.url);
    } catch (e) {
      return null;
    }
  })();

  if (url && /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.localhost)$/.test(url.hostname)) {
    return 'qa';
  }

  return 'external_unknown';
}

function parseVisitorCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)trb_visitor=([^;]+)/);
  if (!match) return null;
  const candidate = match[1].trim();
  if (!/^[A-Za-z0-9-_.]{12,128}$/.test(candidate)) return null;
  return candidate;
}

async function readJsonBody(request, maxBytes = MAX_INTEREST_BODY_BYTES) {
  const contentType = request.headers.get('content-type') || '';
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return { ok: false, status: 415, error: 'Unsupported media type' };
  }

  const reader = request.body && typeof request.body.getReader === 'function' ? request.body.getReader() : null;
  if (!reader) {
    return { ok: false, status: 400, error: 'Empty request body' };
  }

  const chunks = [];
  let totalLength = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (totalLength + value.byteLength > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: 'Request body too large' };
      }
      totalLength += value.byteLength;
      chunks.push(value);
    }
  } catch (e) {
    return { ok: false, status: 400, error: 'Malformed JSON' };
  }

  if (totalLength === 0) {
    return { ok: false, status: 400, error: 'Empty request body' };
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let rawText;
  try {
    rawText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    return { ok: false, status: 400, error: 'Malformed JSON' };
  }

  if (!rawText.trim()) {
    return { ok: false, status: 400, error: 'Empty request body' };
  }

  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'Invalid JSON body' };
    }
    return { ok: true, value: parsed };
  } catch (e) {
    return { ok: false, status: 400, error: 'Malformed JSON' };
  }
}

function normalizeInterestEvent(request, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Invalid JSON body' };
  }

  if (body.email !== undefined && body.email !== null) {
    return { ok: false, status: 400, error: 'Email collection is disabled' };
  }

  const eventType = typeof body.event_type === 'string' ? body.event_type.trim() : '';
  if (!eventType || !ALLOWED_EVENT_TYPES.has(eventType)) {
    return { ok: false, status: 400, error: 'Invalid event type' };
  }

  let ref = null;
  if (body.ref !== undefined && body.ref !== null) {
    if (typeof body.ref !== 'string') {
      return { ok: false, status: 400, error: 'Unsupported ref type' };
    }
    const trimmedRef = body.ref.trim();
    if (trimmedRef.length > MAX_REFERRER_LENGTH) {
      return { ok: false, status: 400, error: 'Ref too long' };
    }
    ref = trimmedRef || null;
  }

  if (body.ts !== undefined && body.ts !== null) {
    if (typeof body.ts !== 'number' || !Number.isFinite(body.ts) || body.ts < 0) {
      return { ok: false, status: 400, error: 'Unsupported timestamp type' };
    }
  }

  if (body.signup !== undefined && body.signup !== null && typeof body.signup !== 'boolean') {
    return { ok: false, status: 400, error: 'Unsupported signup type' };
  }

  if (body.quiz !== undefined && body.quiz !== null && typeof body.quiz !== 'boolean') {
    return { ok: false, status: 400, error: 'Unsupported quiz type' };
  }

  return {
    ok: true,
    ref,
    eventType,
    trafficType: classifyTraffic(request, { ref }),
  };
}

const QUIZ = [
  {
    key: 'status', q: 'First — how do you file your taxes?', opts: [
      { label: 'Single' },
      { label: 'Married, filing jointly' },
      { label: 'Head of household' },
      { label: 'Not sure yet' },
    ], flags: ['status:single', 'status:mfj', 'status:hoh', '']
  },
  {
    key: 'work', q: 'How do you earn your income?', opts: [
      { label: 'Employee (W-2) 💼', hint: 'Salary or wages, taxes withheld' },
      { label: 'Self-employed / freelance / gig', hint: '1099s, contracts, Uber/Upwork…' },
      { label: 'Both', hint: 'A job plus a side business' },
      { label: 'Not working right now' },
    ], flags: ['w2', 'gig', 'w2 gig', '']
  },
  {
    key: 'income', q: 'Roughly what is your yearly household income?', opts: [
      { label: 'Under $40,000' },
      { label: '$40,000 – $80,000' },
      { label: '$80,000 – $200,000' },
      { label: 'Over $200,000' },
    ], flags: ['inc:low', 'inc:mid', 'inc:high', 'inc:vhigh']
  },
  {
    key: 'kids', q: 'Do you claim dependents?', opts: [
      { label: 'Children under 17' },
      { label: 'Other dependents', hint: 'College students, elderly parents' },
      { label: 'Both' },
      { label: 'No dependents' },
    ], flags: ['kids', 'dep', 'kids dep', '']
  },
  {
    key: 'edu', q: 'Anything education-related?', opts: [
      { label: 'Paying off student loans' },
      { label: 'In college right now', hint: 'Or paying tuition' },
      { label: 'Both' },
      { label: 'Neither' },
    ], flags: ['study', 'student', 'study student', '']
  },
  {
    key: 'home', q: 'Where do you usually work?', opts: [
      { label: 'From home — self-employed' },
      { label: 'From home — company employee', hint: 'Remote or hybrid W-2' },
      { label: 'At an office / on site' },
      { label: 'Mixed' },
    ], flags: ['home', 'homeW2', '', '']
  },
  {
    key: 'retire', q: 'Are you saving for retirement?', opts: [
      { label: 'Yes — 401(k) or workplace plan' },
      { label: 'Yes — IRA', hint: 'Traditional or Roth' },
      { label: 'Both' },
      { label: 'Not yet' },
    ], flags: ['ret', 'ira', 'ret ira', '']
  },
  {
    key: 'give', q: 'Charity or big medical bills this year?', opts: [
      { label: 'I donate to charity', hint: 'Money or goods' },
      { label: 'Big medical expenses', hint: 'Bills, premiums, out-of-pocket' },
      { label: 'Both' },
      { label: 'Neither' },
    ], flags: ['give', 'medical', 'give medical', '']
  },
];

const STD_DEDUCTION = { single: '$15,750', mfj: '$31,500', hoh: '$23,625', other: '$15,750+ (depends on status)' };

// Single source of truth for the default tax year. Change this yearly; the bot
// states it explicitly and always tells users to verify the year that applies to them.
const TAX_YEAR = 2025;

// Parse a flag string like 'w2 gig' or 'inc:low' into the answers map.
function applyFlags(answers, flagStr) {
  String(flagStr || '').split(' ').forEach((f) => {
    if (!f) return;
    const kv = f.split(':');
    if (kv.length === 2) answers[kv[0]] = kv[1]; else answers[f] = true;
  });
}

/* flags -> tailored findings; each cites the IRC / IRS publication it rests on */
function evaluateAnswers(a) {
  const out = [];
  out.push({
    icon: '🧾', name: `Standard deduction (${STD_DEDUCTION[a.status || 'other']})`,
    law: 'IRC §63 · Rev. Proc. 2024-40 · Form 1040',
    desc: a.status === 'mfj'
      ? 'Married filing jointly gets $31,500 for 2025 — but itemize (Schedule A) if mortgage interest + state taxes (up to $10k) + charity + large medical beat it.'
      : `Your 2025 amount is ${STD_DEDUCTION[a.status || 'other']}. Compare it against itemizing (Schedule A): mortgage interest, state taxes up to $10,000, charity, medical over 7.5% of income.`,
  });
  if (a.gig) {
    out.push({
      icon: '💼', name: 'Self-employment deductions',
      law: 'IRC §162, §164(f) · Schedule C · IRS Pub 334',
      desc: 'Mileage (70¢/mile 2025), supplies, software, phone share, health premiums, plus half your self-employment tax — all reduce your Schedule C income.',
    });
  }
  if (a.gig && a.home) {
    out.push({
      icon: '🏠', name: 'Home office deduction',
      law: 'IRC §280A · Form 8829 · IRS Pub 587',
      desc: 'You work from home AND are self-employed — the classic qualifying combo. Simplified method: $5/sq ft up to $1,500, no receipts, if the space is used regularly & exclusively for business.',
    });
  } else if (a.homeW2 && !a.gig) {
    out.push({
      icon: 'ℹ️', name: 'Home office: honest check',
      law: 'IRC §280A · TCJA §11045',
      desc: 'Working from home as a W-2 employee does NOT qualify — the employee home-office deduction is suspended through 2025. Your win is elsewhere on this list.',
    });
  }
  if (a.kids) {
    out.push({
      icon: '👶', name: 'Child tax credit',
      law: 'IRC §24 · Schedule 8812',
      desc: 'Up to $2,200 per child under 17 (2025), up to $1,700 refundable' + (a.inc === 'vhigh' ? '. Note: it phases out above $200k income single / $400k joint.' : '.') + ' File Schedule 8812.',
    });
  }
  if (a.dep) {
    out.push({
      icon: '👨‍🎓', name: 'Credit for other dependents',
      law: 'IRC §24(h) · Schedule 8812',
      desc: 'Children 17+ and college students, or relatives you support: $500 each, non-refundable. Often missed entirely.',
    });
  }
  if (a.inc === 'low') {
    out.push({
      icon: '💵', name: 'Possible EITC review area',
      law: 'IRC §32 · IRS Pub 596',
      desc: 'This broad income range alone cannot establish eligibility. The EITC depends on earned income, filing status, qualifying-child or age/residency rules, and annual income and investment limits. Check the IRS EITC Assistant or Pub. 596 before relying on it.',
    });
  }
  if (a.study) {
    out.push({
      icon: '🎓', name: 'Student loan interest deduction',
      law: 'IRC §221 · Schedule 1',
      desc: 'A possible review area only if you actually paid interest on a qualified student loan and meet the filing-status, dependency, and annual MAGI rules. The deduction is limited to the lesser of $2,500 or qualified interest paid; itemizing is not required. See IRS Topic 456.',
    });
  }
  if (a.student) {
    out.push({
      icon: '📚', name: 'Education credits (AOTC / LLC)',
      law: 'IRC §25A · Form 8863 · IRS Pub 970',
      desc: 'American Opportunity Credit: up to $2,500/student, 40% refundable (first 4 years of college). Lifetime Learning Credit: up to $2,000, any level of study.',
    });
  }
  if (a.ret || a.ira) {
    out.push({
      icon: '📈', name: 'Saver\u2019s credit + retirement deduction',
      law: 'IRC §25B, §219 · Form 8880 · IRS Pub 590-A',
      desc: (a.inc === 'high' || a.inc === 'vhigh')
        ? 'Eligibility depends on filing status, income, age, and other rules. Eligible pre-tax workplace contributions or deductible Traditional IRA contributions may reduce current taxable income; Roth IRA contributions do not. Check the applicable 2025 limits and Form 8880 rules.'
        : 'A possible review area, not an eligibility result. The Saver\u2019s Credit depends on filing status, income, age, and other rules. Eligible pre-tax workplace contributions or deductible Traditional IRA contributions may reduce current taxable income; Roth IRA contributions do not.',
    });
  }
  if (a.give) {
    out.push({
      icon: '❤️', name: 'Charitable contributions',
      law: 'IRC §170 · Schedule A · IRS Pub 526',
      desc: 'Cash to qualified orgs up to 60% of AGI, goods at fair market value — deductible when you itemize (Schedule A). Near the standard deduction? Bunch two years of giving into one.',
    });
  }
  if (a.medical) {
    out.push({
      icon: '🩺', name: 'Medical expense deduction',
      law: 'IRC §213 · Schedule A · IRS Pub 502',
      desc: 'When itemizing, out-of-pocket costs above 7.5% of income count: premiums, dental, glasses, mileage to care (21¢/mile 2025).' + (a.inc === 'vhigh' ? ' At high income the 7.5% floor is hard to clear — HSA is usually the better play.' : ''),
    });
  }
  return out;
}

const DISCLAIMER =
  `⚖️ Educational information only — not tax, legal, or accounting advice. Default figures reflect tax year ${TAX_YEAR} (verify the year that applies to you); they change annually, so confirm at IRS.gov and consult an IRS-authorized professional (CPA, EA, or attorney).`;

const MENU_TEXT = `🇺🇸 <b>U.S. Tax Helper</b>

What can I help you understand?

💰 Income & taxes
📉 Deductions
🎁 Tax credits
💼 Jobs & freelancing
🎓 Education
₿ Crypto
🏠 Housing
🌎 International taxes
📄 Tax forms

❓ Or just ask me a question — I'll answer in plain English with real citations.`;

const SYSTEM_PROMPT = `You are "TaxRefund Bot", a friendly, clear educational assistant about U.S. federal taxes for teenagers and beginners. Your reader may be 13–17 and know nothing about taxes. Your job: help them understand fast, without fear or jargon overload.

VOICE & TONE
- Friendly, calm, encouraging. Respect the reader's intelligence; do not talk down or use baby talk.
- Explain any technical term the moment you use it (e.g., "AGI = Adjusted Gross Income — basically your income after certain adjustments").
- Use short paragraphs, headings, bullet points, numbered lists, bold key terms, and emojis as visual navigation (about 2–6 relevant emojis per answer, not spam).
- Respond in the SAME language the user writes in. If they write Russian, answer in Russian (English tax terms like "Adjusted Gross Income (AGI)" may stay in English). If English, answer in English.
- Output MARKDOWN (not HTML): use "# " for headings, "**bold**", "- " bullets, "1. " numbered lists, and \`code\` for code/forms. We convert it to Telegram formatting.

ANSWER STRUCTURE (prefer this for normal questions)
**Title**
One-sentence plain answer.
### 🔎 How it works
2–5 short bullets.
### 🧮 Example (only when useful)
### 📚 Sources
Cite primary authority only when you can identify it with confidence: Internal Revenue Code (IRC §…), Treasury Regulations, IRS.gov, IRS forms/instructions, or IRS Publications (e.g., Pub 17, 596, 970, 590-A). Do not invent or guess a citation; say when you could not verify one. Secondary blogs/sites must NOT replace primary authority.
### ⚠️ Important (only if a real limitation exists)
Explain material conditions and limitations. Never guarantee eligibility or a refund amount. Do not request Social Security numbers, bank details, complete tax returns, or identity documents. The Worker appends the educational disclaimer.

TAX YEARS — CRITICAL
- The DEFAULT tax year is 2025 (returns filed in 2026) unless the user says otherwise. State the tax year explicitly whenever you cite a dollar figure.
- Use accurate, current 2025 numbers. Do NOT use figures from other years (e.g., do not answer 2026 with 2025 numbers, or 2025 with 2024 numbers).
- If you are unsure whether a number is current, say so and point to IRS.gov. Never present an unverified number as fact.

ACCURACY & CITATIONS
- Cite a real provision that actually supports the claim. Do not cite §24 just because it is about the Child Tax Credit if the specific point needs another section — explain what the citation supports.
- NEVER invent IRC sections, tax credits, IRS programs, deductions, or federal laws. If asked about something that may not exist (e.g., "IRC §9999", a "Federal Rent Refund Act of 2026", a fake credit), say: "🔎 I couldn't verify that this is a real U.S. federal tax provision. I don't want to invent a tax rule or citation." Prefer "I couldn't verify this" over a confident guess.
- Do not overclaim. Use ✅ "Generally…", ⚠️ "This depends on…", ❓ "I'd need to know…", 🚫 "This generally does not qualify…". Conditional rules are not absolutes.
- Distinguish a <b>deduction</b> (reduces taxable income) from a <b>credit</b> (reduces tax) from an actual <b>refund</b> (only happens if you overpaid). Never imply that listing a deduction or credit guarantees money back — eligibility, income limits, and prior withholding all matter. State these limits when they apply.

LENGTH & COMPLETENESS
- Short question → short answer. Complex question → complete answer. Several questions in one message → answer ALL of them in ONE structured response with clear sections; do not drop any question.
- Do NOT artificially limit yourself to 250 words if that would make the answer incomplete. Be as concise as possible while staying complete.
- If the answer is long, organize with headings and clear sections (we will split it across messages for you). Never split a sentence or a Q&A pair mid-way.

MISSING FACTS
- If the answer truly needs a fact you don't have (e.g., which state, which tax year), ask the MINIMUM necessary questions (usually 1–2), e.g.: "I can answer this, but I need 2 details: 1️⃣ Which tax year? 2️⃣ Which state?" Do not ask ten questions.

SCOPE
- You provide general educational information only, never personalized tax advice, and never help evade taxes. If a user's situation looks like tax evasion, refuse and mention penalties (IRC §6663, §7201).
- Do not request Social Security numbers, bank details, complete tax returns, or identity documents. Ask only for minimum non-identifying facts when needed.

ACCURATE 2025 ANCHORS (verify the year if the user asks about another year)
Single standard deduction $15,750 · Married Filing Jointly $31,500 · Head of Household $23,625 · EITC up to $8,046 with 3+ qualifying children · Child Tax Credit up to $2,200 per child under 17 (up to $1,700 refundable) · Student loan interest deduction up to $2,500 · Business mileage 70¢/mile · HSA self-only $4,300 / family $8,550 · Medical expense deduction above 7.5% of AGI · 3-year refund claim window (IRC §6511).`;

/* ============================== FORMATTING HELPERS ============================== */

function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Convert LLM Markdown output into Telegram-safe HTML (the worker sends parse_mode: HTML).
function mdToTelegramHTML(md) {
  let s = escapeHTML(md);
  s = s.replace(/^###\s+(.*)$/gm, '<b>$1</b>');
  s = s.replace(/^##\s+(.*)$/gm, '<b>$1</b>');
  s = s.replace(/^#\s+(.*)$/gm, '<b>$1</b>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^\s*[-*]\s+/gm, '• ');
  return s;
}

// Split one long paragraph into sentence-bounded pieces no longer than `max`.
function splitLongParagraph(p, max) {
  const sentences = p.match(/.+?[.!?](\s|$)|.+$/g) || [p];
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length > max) {
      if (cur) out.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Split a long answer into semantic parts (by paragraph, then by sentence) — never mid-sentence.
function splitTelegramMessage(text, max = 3800) {
  const paras = String(text).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const parts = [];
  const pushPart = (part) => {
    if (part.length > max) {
      for (const sub of splitLongParagraph(part, max)) parts.push(sub);
    } else {
      parts.push(part);
    }
  };
  let cur = '';
  for (const p of paras) {
    if (!cur) { cur = p; continue; }
    if (cur.length + 2 + p.length <= max) {
      cur += '\n\n' + p;
    } else {
      pushPart(cur);
      cur = p;
    }
  }
  if (cur) pushPart(cur);
  if (parts.length <= 1) return parts;
  return parts.map((p, i) => `📦 Part ${i + 1}/${parts.length}\n\n${p}`);
}

/* ============================== GROQ HELPERS ============================== */

function readGroqConfig(env) {
  const config = { ...GROQ_LIMITS };
  const settings = [
    ['maxInputChars', 'GROQ_MAX_INPUT_CHARS', 2000, 2000],
    ['maxOutputTokens', 'GROQ_MAX_OUTPUT_TOKENS', 600, 600],
    ['maxOutputChars', 'GROQ_MAX_OUTPUT_CHARS', 2600, 2600],
    ['timeoutMs', 'GROQ_TIMEOUT_MS', 15000, 15000],
    ['chatDaily', 'GROQ_CHAT_DAILY_LIMIT', 10, 10],
    ['chatTenMinutes', 'GROQ_CHAT_10MIN_LIMIT', 5, 5],
    ['globalDaily', 'GROQ_GLOBAL_DAILY_LIMIT', 50, 500],
    ['globalTenMinutes', 'GROQ_GLOBAL_10MIN_LIMIT', 10, 100],
  ];

  for (const [key, envName, fallback, ceiling] of settings) {
    const raw = env?.[envName];
    if (raw === undefined || raw === '') {
      config[key] = fallback;
      continue;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) return null;
    config[key] = value;
  }
  return config;
}

function integrationError(source, category) {
  const error = new Error(`${source}:${category}`);
  error.source = source;
  error.category = category;
  return error;
}

function logSanitizedError(error, fallbackSource = 'application') {
  const source = error && ['telegram', 'groq'].includes(error.source) ? error.source : fallbackSource;
  const category = error && typeof error.category === 'string' ? error.category : 'unexpected';
  console.error(JSON.stringify({ event: 'integration_error', source, category }));
}

async function fetchWithTimeout(url, options, timeoutMs, source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    throw integrationError(source, controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timeout);
  }
}

function parseRetryAfter(value, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.ceil(seconds), 3600);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.min(Math.max(0, Math.ceil(timestamp / 1000 - nowSeconds)), 3600);
}

async function getGroqCooldown(env, nowSeconds) {
  const row = await env.DB.prepare(
    'SELECT retry_after FROM provider_cooldowns WHERE provider = ?'
  ).bind('groq').first();
  const retryAfter = Number(row?.retry_after || 0);
  return Number.isSafeInteger(retryAfter) && retryAfter > nowSeconds ? retryAfter : 0;
}

async function setGroqCooldown(env, retryAfter) {
  await env.DB.prepare(
    `INSERT INTO provider_cooldowns (provider, retry_after) VALUES ('groq', ?)
     ON CONFLICT(provider) DO UPDATE SET retry_after = MAX(provider_cooldowns.retry_after, excluded.retry_after)`
  ).bind(retryAfter).run();
}

async function reserveGroqUsage(env, chatId, config, now = Date.now()) {
  const isVisitor = typeof chatId === 'string';
  if (isVisitor ? !/^[A-Za-z0-9._-]{12,128}$/.test(chatId) : !Number.isSafeInteger(chatId)) {
    return { ok: false, error: 'storage_unavailable' };
  }

  const date = new Date(now);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const tenMinuteStart = now - config.tenMinutesMs;

  if (typeof env.DB?.batch !== 'function') return { ok: false, error: 'storage_unavailable' };
  const identityCondition = isVisitor
    ? 'visitor_id = ?'
    : 'visitor_id IS NULL AND chat_id = ?';
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM ai_usage WHERE reserved_at < ?').bind(dayStart),
    env.DB.prepare(
      `INSERT INTO ai_usage (chat_id, visitor_id, reserved_at)
       SELECT ?, ?, ?
       WHERE (SELECT COUNT(*) FROM ai_usage WHERE ${identityCondition} AND reserved_at >= ?) < ?
         AND (SELECT COUNT(*) FROM ai_usage WHERE ${identityCondition} AND reserved_at >= ?) < ?
         AND (SELECT COUNT(*) FROM ai_usage WHERE reserved_at >= ?) < ?
         AND (SELECT COUNT(*) FROM ai_usage WHERE reserved_at >= ?) < ?`
    ).bind(
      isVisitor ? 0 : chatId,
      isVisitor ? chatId : null,
      now,
      chatId,
      dayStart,
      config.chatDaily,
      chatId,
      tenMinuteStart,
      config.chatTenMinutes,
      dayStart,
      config.globalDaily,
      tenMinuteStart,
      config.globalTenMinutes,
    ),
  ]);
  const changes = results?.[1]?.meta?.changes;
  if (changes === 1) return { ok: true };
  if (changes === 0) return { ok: false, error: 'quota_exceeded' };
  return { ok: false, error: 'storage_unavailable' };
}

async function groqChat(env, chatId, question, messages) {
  if (!env.GROQ_API_KEY) return { error: 'no_key' };
  const config = readGroqConfig(env);
  if (!config) return { error: 'invalid_config' };
  if (question.length > config.maxInputChars) return { error: 'input_too_long' };

  const nowSeconds = Math.floor(Date.now() / 1000);
  let retryAfter;
  try {
    retryAfter = await getGroqCooldown(env, nowSeconds);
  } catch {
    return { error: 'storage_unavailable' };
  }
  if (retryAfter) return { error: 'provider_cooldown', retryAfterSeconds: retryAfter - nowSeconds };

  let reservation;
  try {
    reservation = await reserveGroqUsage(env, chatId, config);
  } catch {
    return { error: 'storage_unavailable' };
  }
  if (!reservation.ok) return { error: reservation.error };

  try {
    const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        max_tokens: config.maxOutputTokens,
        temperature: 0.3,
        messages,
      }),
    }, config.timeoutMs, 'groq');
    if (r.status === 429) {
      const delay = parseRetryAfter(r.headers.get('retry-after'), nowSeconds);
      if (delay > 0) {
        try {
          await setGroqCooldown(env, nowSeconds + delay);
        } catch {
          return { error: 'storage_unavailable' };
        }
      }
      return { error: 'provider_rate_limited', retryAfterSeconds: delay || undefined };
    }
    if (!r.ok) return { error: 'provider_http', status: r.status };

    let data;
    try {
      data = await r.json();
    } catch {
      return { error: 'provider_invalid_json' };
    }
    const content = data && Array.isArray(data.choices)
      ? data.choices[0]?.message?.content
      : null;
    if (typeof content !== 'string') return { error: 'provider_malformed' };
    const text = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!text) return { error: 'provider_empty' };
    return {
      text: text.length > config.maxOutputChars
        ? `${text.slice(0, config.maxOutputChars).trimEnd()}…`
        : text,
      truncated: text.length > config.maxOutputChars,
    };
  } catch (error) {
    return { error: error.category || 'network' };
  }
}

/* ============================== TELEGRAM API ============================== */

async function tg(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw integrationError('telegram', 'not_configured');
  if (!['getMe', 'sendMessage', 'answerCallbackQuery'].includes(method)) {
    throw integrationError('application', 'invalid_telegram_method');
  }

  const r = await fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'getMe' ? {} : { body: JSON.stringify(payload) }),
  }, TELEGRAM_TIMEOUT_MS, 'telegram');
  let data;
  try {
    data = await r.json();
  } catch {
    throw integrationError('telegram', 'invalid_json');
  }
  if (!r.ok) throw integrationError('telegram', r.status === 429 ? 'rate_limited' : 'http');
  if (!data || typeof data.ok !== 'boolean') throw integrationError('telegram', 'malformed_response');
  if (!data.ok) throw integrationError('telegram', 'api_rejected');
  return { ok: true, result: data.result };
}
const sendMsg = (env, chatId, text, keyboard) =>
  tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(keyboard && { reply_markup: keyboard }),
  });

function isExpectedTelegramSecret(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  if (expected.length !== actual.length) return false;

  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(actual);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function verifyTelegramWebhookAuth(request, env) {
  const configuredSecret = env && typeof env.TELEGRAM_WEBHOOK_SECRET === 'string'
    ? env.TELEGRAM_WEBHOOK_SECRET
    : '';

  if (!/^[A-Za-z0-9_-]{1,256}$/.test(configuredSecret)) {
    return { ok: false, status: 500, message: 'Server webhook configuration missing' };
  }

  const providedSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!providedSecret) {
    return { ok: false, status: 401, message: 'Unauthorized' };
  }

  if (!isExpectedTelegramSecret(configuredSecret, providedSecret)) {
    return { ok: false, status: 401, message: 'Unauthorized' };
  }

  return { ok: true };
}

/* ============================== BOT STATE (D1) ============================== */

async function getState(env, chatId) {
  const { results } = await env.DB
    .prepare('SELECT step, answers, session_id FROM bot_state WHERE chat_id = ?')
    .bind(chatId).all();
  if (!results.length) return { step: 'idle', answers: {}, sessionId: '' };
  const answers = JSON.parse(results[0].answers || '{}');
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw integrationError('application', 'invalid_stored_state');
  }
  return {
    step: results[0].step,
    answers,
    sessionId: results[0].session_id || '',
  };
}
async function setState(env, chatId, step, answers, sessionId = '') {
  await env.DB.prepare(
    `INSERT INTO bot_state (chat_id, step, answers, updated_at, session_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET step = excluded.step, answers = excluded.answers,
       updated_at = excluded.updated_at, session_id = excluded.session_id`
  ).bind(chatId, step, JSON.stringify(answers), new Date().toISOString(), sessionId).run();
}

async function transitionQuizAnswer(env, chatId, sessionId, expectedStep, nextStep, answers) {
  const result = await env.DB.prepare(
    `UPDATE bot_state SET answers = ?, step = ?, updated_at = ?
     WHERE chat_id = ? AND session_id = ? AND step = ?`
  ).bind(
    JSON.stringify(answers),
    nextStep,
    new Date().toISOString(),
    chatId,
    sessionId,
    expectedStep,
  ).run();
  if (result?.meta?.changes === 1) return { ok: true };
  if (result?.meta?.changes === 0) return { ok: false, error: 'stale_callback' };
  return { ok: false, error: 'storage_unavailable' };
}

async function deleteChatData(env, chatId) {
  if (typeof env.DB?.batch !== 'function') throw integrationError('application', 'storage_unavailable');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM bot_state WHERE chat_id = ?').bind(chatId),
    env.DB.prepare('DELETE FROM ai_usage WHERE chat_id = ?').bind(chatId),
  ]);
}

function makeSessionId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function parseAnswerCallback(data) {
  if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > 64) return null;
  const fields = data.split(':');
  if (fields.length !== 4 || fields[0] !== 'ans') return null;
  if (!/^[a-f0-9]{16}$/i.test(fields[1]) || !/^[a-z]+$/.test(fields[2]) || !/^[0-3]$/.test(fields[3])) return null;
  const questionIndex = QUIZ.findIndex((question) => question.key === fields[2]);
  const optionIndex = Number(fields[3]);
  if (questionIndex < 0 || optionIndex >= QUIZ[questionIndex].opts.length) return null;
  return { sessionId: fields[1], questionIndex, optionIndex };
}

function validateTelegramUpdate(update) {
  if (!update || typeof update !== 'object' || Array.isArray(update) ||
      !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    return { ok: false };
  }
  if (update.message && update.callback_query) return { ok: false };

  if (update.callback_query !== undefined) {
    const callback = update.callback_query;
    const chat = callback?.message?.chat;
    if (!callback || typeof callback !== 'object' || typeof callback.id !== 'string' ||
        !callback.id || !chat || !Number.isSafeInteger(chat.id) || typeof chat.type !== 'string' ||
        typeof callback.data !== 'string' || new TextEncoder().encode(callback.data).byteLength > 64) {
      return { ok: false };
    }
    return { ok: true, type: 'callback_query', chatType: chat.type };
  }

  if (update.message !== undefined) {
    const message = update.message;
    const chat = message?.chat;
    if (!message || typeof message !== 'object' || !chat ||
        !Number.isSafeInteger(chat.id) || typeof chat.type !== 'string' ||
        (message.text !== undefined && typeof message.text !== 'string')) {
      return { ok: false };
    }
    return { ok: true, type: 'message', chatType: chat.type };
  }

  return { ok: true, type: 'unsupported' };
}

/* ============================== BOT LOGIC ============================== */

const MAIN_MENU = {
  inline_keyboard: [
    [{ text: '✅ Start the free check', callback_data: 'cmd:check' }],
    [{ text: '📚 Full U.S. tax guide', callback_data: 'cmd:guide' }],
    [{ text: '❓ Ask a tax question', callback_data: 'cmd:ask' }],
  ],
};

async function startCheck(env, chatId) {
  const sessionId = makeSessionId();
  await setState(env, chatId, 'q:0', {}, sessionId);
  await askQuestion(env, chatId, 0, sessionId);
}

async function askQuestion(env, chatId, i, sessionId) {
  const q = QUIZ[i];
  const rows = q.opts.map((opt, oi) => [{
    text: opt.label + (opt.hint ? ` — ${opt.hint}` : ''),
    callback_data: `ans:${sessionId}:${q.key}:${oi}`,
  }]);
  await sendMsg(env, chatId,
    `<b>Question ${i + 1} of ${QUIZ.length}</b>\n\n${q.q}`,
    { inline_keyboard: rows });
}

function buildReport(answers) {
  const hits = evaluateAnswers(answers);
  const lines = hits.map((f) => `${f.icon} <b>${f.name}</b>\n<i>${f.law}</i>\n${f.desc}`);
  return `<b>🔎 Your check found ${hits.length} area${hits.length === 1 ? '' : 's'} to look at:</b>\n\n` +
    lines.join('\n\n') +
    `\n\n<b>📌 What to do next (U.S. filers):</b>` +
    `\n1️⃣ Gather your W-2s / 1099s and last year's return.` +
    `\n2️⃣ Compare standard vs. itemized (Schedule A).` +
    `\n3️⃣ File Form 1040 by the April deadline; an extension (Form 4868) extends time to file, NOT to pay.` +
    `\n4️⃣ Track your refund: <b>IRS.gov/refunds</b> ("Where's My Refund?").` +
    `\n5️⃣ Missed a refund in a past year? You generally have <b>3 years</b> from the filing deadline to claim it (IRC §6511) — file Form 1040-X to amend.` +
    `\n\n${DISCLAIMER}\n\n❓ Reply with any question, or /ask — I can explain any of these in plain English.`;
}

const GUIDE = `📚 <b>U.S. TAX REFUNDS — FULL GUIDE (tax year ${TAX_YEAR})</b>

<b>1. How refunds happen</b> — A refund means you overpaid: too much withholding (Form W-2, box 2) or estimated tax (Form 1040-ES). Refunds are issued by direct deposit, typically within 21 days of e-filing (IRS.gov/refunds).

<b>2. Who must file</b> — Depends on filing status, age, and gross income (IRC §6012; IRS Pub 17). Even below the threshold, FILE if you had withholding — that's the only way to get it back.

<b>3. Refundable credits — money even with zero tax liability</b>
• EITC (IRC §32): up to $8,046 with 3+ qualifying children (${TAX_YEAR}) — the most-missed credit in America. IRS Pub 596 / IRS.gov/eitc.
• Child Tax Credit (§24): up to $2,200/child, up to $1,700 refundable. Schedule 8812.
• American Opportunity Credit (§25A): up to $2,500, 40% refundable.

<b>4. Above-the-line deductions (no itemizing needed)</b>
• Student loan interest up to $2,500 (§221) · Traditional IRA (§219) · HSA contributions (§223, up to $4,300/$8,550) · Educator expenses $300 (§62(a)(2)(D)).

<b>5. Itemize if it beats the standard deduction</b> ($15,750 single / $31,500 MFJ for 2025): mortgage interest, state & local taxes up to $10,000 (§164(b)(6)), charity (§170), medical over 7.5% AGI (§213).

<b>6. Deadlines & the 3-year window</b> — File by April 15; extension Form 4868 extends filing, not payment. To claim a refund you generally must file within 3 years of the later of the original due date or the date you filed — and no later than 2 years from the date you paid the tax, whichever is later (§6511(a)). Amending: Form 1040-X.

<b>7. Free help</b> — IRS Free File (IRS.gov/freefile), VITA/TCE free in-person help (IRS.gov/vita, 1-800-906-9887), and IRS.gov/ippin to protect against identity theft.

${DISCLAIMER}`;

async function handleUpdate(env, update) {
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const privateChat = cb.message.chat.type === 'private';
    try {
      await tg(env, 'answerCallbackQuery', {
        callback_query_id: cb.id,
        ...(!privateChat && {
          text: 'Please use this bot in a private chat.',
          show_alert: true,
        }),
      });
    } catch (error) {
      logSanitizedError(error);
    }
    if (!privateChat) return;

    const data = cb.data;
    if (data.startsWith('cmd:')) {
      const cmd = data.slice(4);
      if (cmd === 'check') return startCheck(env, chatId);
      if (cmd === 'guide') return sendMsg(env, chatId, GUIDE, MAIN_MENU);
      if (cmd === 'ask') {
        await setState(env, chatId, 'ask', {});
        return sendMsg(env, chatId, '❓ <b>Ask me anything about U.S. taxes</b>\n\ne.g. "Can I deduct my laptop?", "What is the EITC?", "I lost my W-2 — what now?"\n\nI answer with citations to the tax code (educational info, not advice). /menu to exit.', MAIN_MENU);
      }
      return;
    }
    const answer = parseAnswerCallback(data);
    if (!answer) return;

    const state = await getState(env, chatId);
    const expectedStep = `q:${answer.questionIndex}`;
    if (state.sessionId !== answer.sessionId || state.step !== expectedStep) return;

    const answers = { ...state.answers };
    applyFlags(answers, QUIZ[answer.questionIndex].flags[answer.optionIndex]);
    const isFinal = answer.questionIndex === QUIZ.length - 1;
    const nextStep = isFinal ? 'done' : `q:${answer.questionIndex + 1}`;
    const transition = await transitionQuizAnswer(
      env,
      chatId,
      answer.sessionId,
      expectedStep,
      nextStep,
      answers,
    );
    if (!transition.ok) {
      if (transition.error === 'storage_unavailable') {
        throw integrationError('application', 'state_transition_failed');
      }
      return;
    }
    if (isFinal) return sendMsg(env, chatId, buildReport(answers), MAIN_MENU);
    return askQuestion(env, chatId, answer.questionIndex + 1, answer.sessionId);
  }

  const msg = update.message;
  if (!msg || typeof msg.text !== 'string' || msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  if (!text) return;
  const commandMatch = text.match(/^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i);
  const command = commandMatch ? commandMatch[1].toLowerCase() : '';

  if (command === 'delete') {
    await deleteChatData(env, chatId);
    return sendMsg(env, chatId,
      'Your TaxRefund Bot application data was deleted: saved quiz state and this chat\u2019s AI usage counters. This does not delete Telegram chat history or records, or records held by Groq or other providers.');
  }

  if (command === 'start') {
    await setState(env, chatId, 'idle', {});
    return sendMsg(env, chatId,
      `👋 <b>Welcome to TaxRefund Bot</b> — your friendly U.S. tax helper.\n\nI explain U.S. taxes in plain English for teens and beginners, with real citations to the tax code. No jargon, no lectures.\n\n${MENU_TEXT}`,
      MAIN_MENU);
  }
  if (command === 'menu' || text === '/start over') {
    await setState(env, chatId, 'idle', {});
    return sendMsg(env, chatId, MENU_TEXT, MAIN_MENU);
  }
  if (command === 'check') return startCheck(env, chatId);
  if (command === 'guide') return sendMsg(env, chatId, GUIDE, MAIN_MENU);
  if (command === 'ask') {
    await setState(env, chatId, 'ask', {});
    return sendMsg(env, chatId,
      '❓ <b>Ask one U.S. tax question</b>\n\nDo not include SSNs, bank details, a complete return, or identity documents. /menu to exit.',
      MAIN_MENU);
  }

  const state = await getState(env, chatId);
  if (state.step && state.step.startsWith('q:')) {
    const index = Number(state.step.slice(2));
    if (Number.isInteger(index) && index >= 0 && index < QUIZ.length) {
      return askQuestion(env, chatId, index, state.sessionId);
    }
    throw integrationError('application', 'invalid_quiz_step');
  }

  const config = readGroqConfig(env);
  if (!config) {
    logSanitizedError({ source: 'groq', category: 'invalid_config' });
    return sendMsg(env, chatId,
      '⚠️ AI questions are temporarily unavailable because the beta limits are misconfigured. The quiz remains available.',
      MAIN_MENU);
  }
  if (text.length > config.maxInputChars) {
    return sendMsg(env, chatId,
      `Please shorten the question to ${config.maxInputChars} characters or fewer. Do not send sensitive tax or identity information.`,
      MAIN_MENU);
  }

  const res = await groqChat(env, chatId, text, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: text },
  ]);
  if (res && res.error) {
    logSanitizedError({ source: 'groq', category: res.error });
    let message = '⚠️ <b>AI answers are temporarily unavailable</b>\n\nYour question was not saved by this app. Please try later; the free quiz remains available.';
    if (res.error === 'no_key') {
      message = '⚠️ <b>AI answers are not configured yet</b>\n\nThe free quiz remains available.';
    } else if (res.error === 'quota_exceeded') {
      message = '⏳ <b>Beta AI request limit reached</b>\n\nPlease wait before asking another question. The free quiz remains available.';
    } else if (res.error === 'provider_cooldown' || res.error === 'provider_rate_limited') {
      const seconds = Number.isSafeInteger(res.retryAfterSeconds) ? res.retryAfterSeconds : 0;
      message = `⏳ <b>AI provider rate limit reached</b>\n\nPlease try again${seconds ? ` in about ${seconds} seconds` : ' later'}.`;
    } else if (res.error === 'input_too_long') {
      message = `Please shorten the question to ${config.maxInputChars} characters or fewer.`;
    } else if (res.error === 'storage_unavailable') {
      message = '⚠️ <b>AI answers are paused</b>\n\nThe beta usage limit could not be checked safely. Please try later.';
    }
    return sendMsg(env, chatId,
      message,
      MAIN_MENU);
  }
  const content = res.text
    .replace(/⚖️?\s*Educational information only[^\n]*/gi, '')
    .trim();
  const htmlParts = splitTelegramMessage(`${content}\n\n${DISCLAIMER}`, 3200).map(mdToTelegramHTML);
  for (let k = 0; k < htmlParts.length; k++) {
    await sendMsg(env, chatId, htmlParts[k], MAIN_MENU);
  }
}

/* ============================== HTTP ROUTER ============================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === TELEGRAM_WEBHOOK_PATH) {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
      }

      const auth = verifyTelegramWebhookAuth(request, env);
      if (!auth.ok) {
        return new Response(auth.message || 'Unauthorized', { status: auth.status || 401 });
      }

      const parsed = await readJsonBody(request, MAX_WEBHOOK_BODY_BYTES);
      if (!parsed.ok) {
        return new Response(parsed.error, { status: parsed.status });
      }
      const validation = validateTelegramUpdate(parsed.value);
      if (!validation.ok) return new Response('Invalid Telegram update', { status: 400 });
      if (validation.type === 'unsupported') return new Response('OK');

      const task = handleUpdate(env, parsed.value).catch((error) => {
        logSanitizedError(error);
      });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
      else await task;
      return new Response('OK');
    }

    if (url.pathname === '/api/bot-info') {
      if (request.method !== 'GET') {
        return Response.json({ ok: false, error: 'Method not allowed' }, {
          status: 405,
          headers: { Allow: 'GET', 'Cache-Control': 'no-store' },
        });
      }
      if (!env.TELEGRAM_BOT_TOKEN) {
        return Response.json({ ok: false }, { headers: { 'Cache-Control': 'no-store' } });
      }
      try {
        const result = await tg(env, 'getMe');
        return Response.json({ ok: true, username: result.result?.username ?? null }, {
          headers: { 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        logSanitizedError(error);
        return Response.json({ ok: false }, { headers: { 'Cache-Control': 'no-store' } });
      }
    }

    if (url.pathname === '/api/chat') {
      const noStore = { 'Cache-Control': 'no-store' };
      const respondError = (status, error) =>
        Response.json({ ok: false, error }, { status, headers: noStore });

      if (request.method !== 'POST') {
        return Response.json({ ok: false, error: 'Method not allowed' }, {
          status: 405,
          headers: { ...noStore, Allow: 'POST' },
        });
      }
      if (request.headers.get('origin') !== url.origin) {
        return respondError(403, 'forbidden');
      }

      const parsed = await readJsonBody(request, MAX_INTEREST_BODY_BYTES);
      if (!parsed.ok) return respondError(parsed.status, parsed.error);
      if (Object.keys(parsed.value).some((key) => key !== 'question') ||
          typeof parsed.value.question !== 'string') {
        return respondError(400, 'invalid_request');
      }

      const question = parsed.value.question.trim();
      if (!question) return respondError(400, 'question_required');

      const config = readGroqConfig(env);
      if (!config) {
        logSanitizedError({ source: 'groq', category: 'invalid_config' });
        return respondError(503, 'unavailable');
      }
      if (question.length > config.maxInputChars) {
        return respondError(400, 'question_too_long');
      }

      const cookieValue = parseVisitorCookie(request.headers.get('cookie') || '');
      if (!cookieValue) return respondError(401, 'visitor_required');

      let visitor;
      try {
        visitor = await env.DB.prepare(
          'SELECT visitor_id FROM visitors WHERE visitor_id = ? LIMIT 1'
        ).bind(cookieValue).first();
      } catch {
        logSanitizedError({ source: 'groq', category: 'storage_unavailable' });
        return respondError(503, 'unavailable');
      }
      if (!visitor) return respondError(401, 'visitor_required');

      const result = await groqChat(env, visitor.visitor_id, question, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question },
      ]);
      if (result.error) {
        logSanitizedError({ source: 'groq', category: result.error });
        let status = 503;
        let error = result.error === 'no_key' ? 'not_configured' : 'unavailable';
        if (result.error === 'quota_exceeded') {
          status = 429;
          error = 'limit_reached';
        } else if (result.error === 'input_too_long') {
          status = 400;
          error = 'question_too_long';
        }

        const headers = new Headers(noStore);
        if (Number.isSafeInteger(result.retryAfterSeconds) && result.retryAfterSeconds > 0) {
          headers.set('Retry-After', String(Math.min(result.retryAfterSeconds, 3600)));
        }
        return Response.json({ ok: false, error }, { status, headers });
      }

      return Response.json({
        ok: true,
        answer: result.text,
        disclaimer: DISCLAIMER,
      }, { headers: noStore });
    }

    if (url.pathname === '/api/interest') {
      if (request.method !== 'POST') {
        return Response.json({ ok: false, error: 'Method not allowed' }, {
          status: 405,
          headers: { Allow: 'POST' },
        });
      }

      const parsedBody = await readJsonBody(request, MAX_INTEREST_BODY_BYTES);
      if (!parsedBody.ok) {
        return Response.json({ ok: false, error: parsedBody.error }, { status: parsedBody.status });
      }

      const normalized = normalizeInterestEvent(request, parsedBody.value);
      if (!normalized.ok) {
        return Response.json({ ok: false, error: normalized.error }, { status: normalized.status });
      }

      const cookieValue = parseVisitorCookie(request.headers.get('cookie') || '');
      let visitorId = null;
      if (cookieValue) {
        try {
          const row = await env.DB.prepare(
            'SELECT visitor_id FROM visitors WHERE visitor_id = ? LIMIT 1'
          ).bind(cookieValue).all();
          if (Array.isArray(row?.results) && row.results.length > 0) {
            visitorId = row.results[0].visitor_id;
          }
        } catch {
          return Response.json({ ok: false, error: 'storage_unavailable' }, { status: 500 });
        }
      }

      try {
        await env.DB.prepare(
          `INSERT INTO interest_events
           (created_at, referrer, user_agent, email, event_type, traffic_type, visitor_id)
           VALUES (?, ?, ?, NULL, ?, ?, ?)`
        ).bind(
          new Date().toISOString(),
          normalized.ref,
          (request.headers.get('user-agent') || '').slice(0, MAX_USER_AGENT_LENGTH),
          normalized.eventType,
          normalized.trafficType,
          visitorId,
        ).run();
      } catch {
        return Response.json({ ok: false, error: 'storage_unavailable' }, { status: 500 });
      }

      return Response.json({ ok: true });
    }

    if (url.pathname === '/api/visit') {
      if (request.method !== 'POST') {
        return Response.json({ ok: false, error: 'Method not allowed' }, {
          status: 405,
          headers: { Allow: 'POST' },
        });
      }

      const parsedBody = await readJsonBody(request, MAX_INTEREST_BODY_BYTES);
      if (!parsedBody.ok) {
        return Response.json({ ok: false, error: parsedBody.error }, { status: parsedBody.status });
      }

      const headerRef = request.headers.get('referer');
      const bodyRef = typeof parsedBody.value.ref === 'string' ? parsedBody.value.ref : '';
      const ref = (headerRef || bodyRef).trim().slice(0, MAX_REFERRER_LENGTH) || null;

      const cookieValue = parseVisitorCookie(request.headers.get('cookie') || '');
      let existingVisitorId = null;
      if (cookieValue) {
        try {
          const row = await env.DB.prepare('SELECT visitor_id FROM visitors WHERE visitor_id = ? LIMIT 1').bind(cookieValue).all();
          if (row && Array.isArray(row.results) && row.results.length > 0) {
            existingVisitorId = row.results[0].visitor_id;
          }
        } catch (e) {
          return Response.json({ ok: false, error: 'storage_unavailable' }, { status: 500 });
        }
      }

      if (existingVisitorId) {
        return Response.json({ ok: true, newVisitor: false }, {
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      const visitorId = crypto.randomUUID();
      const trafficType = classifyTraffic(request, { ref });
      try {
        if (typeof env.DB.batch !== 'function') {
          throw new Error('D1 batch unavailable');
        }

        await env.DB.batch([
          env.DB.prepare(
            'INSERT INTO visitors (created_at, visitor_id, referrer, user_agent) VALUES (?, ?, ?, ?)'
          ).bind(
            new Date().toISOString(),
            visitorId,
            ref,
            (request.headers.get('user-agent') || '').slice(0, MAX_USER_AGENT_LENGTH),
          ),
          env.DB.prepare(
            `INSERT INTO interest_events
             (created_at, referrer, user_agent, event_type, traffic_type, visitor_id)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(
            new Date().toISOString(),
            ref,
            (request.headers.get('user-agent') || '').slice(0, MAX_USER_AGENT_LENGTH),
            'real_visit',
            trafficType,
            visitorId,
          ),
        ]);
      } catch (e) {
        return Response.json({ ok: false, error: 'storage_unavailable' }, { status: 500 });
      }

      const headers = new Headers({
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
      });
      const cookieValueHeader = `trb_visitor=${visitorId}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${url.protocol === 'https:' ? '; Secure' : ''}`;
      headers.append('Set-Cookie', cookieValueHeader);
      return Response.json({ ok: true, newVisitor: true }, { headers });
    }

    return new Response('Not found', { status: 404 });
  },
};

// Execution context `ctx` (3rd fetch arg) is used via ctx.waitUntil to keep the async handler alive.

// Test hook: workerd only allows function/default exports from the entry module,
// so internals for unit tests are exposed through this accessor.
export function __testables() {
  return {
    mdToTelegramHTML, escapeHTML, splitTelegramMessage, splitLongParagraph,
    buildReport, evaluateAnswers, applyFlags, SYSTEM_PROMPT, QUIZ, STD_DEDUCTION,
    GUIDE, MAIN_MENU, MENU_TEXT, DISCLAIMER, TAX_YEAR, classifyTraffic,
    parseAnswerCallback, validateTelegramUpdate, readGroqConfig, reserveGroqUsage,
    groqChat, tg, parseRetryAfter, transitionQuizAnswer, deleteChatData,
  };
}
