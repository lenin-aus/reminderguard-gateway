// Action Queue (Parse & Pause): parses a debtor's reply to a statement. Two classifiers, cheapest
// first — see paymentReceiptPlan.js and scheduleCalc.js for the same "pure logic, unit-testable"
// shape this follows.
//
// classifyLocally() is a narrow regex + chrono-node pass that only fires on a clean, unambiguous
// "will pay on <date>" sentence with no nearby dispute language; it never guesses. Anything it
// doesn't confidently match — multiple dates, no date, dispute wording, anything else — falls to
// classifyWithLlm(), which costs money and leaves the infrastructure, so it only runs on the
// minority the regex pass rejects.
const chrono = require('chrono-node');
const fetch = require('node-fetch');

const INBOUND_EMAIL_DOMAIN = process.env.INBOUND_EMAIL_DOMAIN || 'inbound.fasttrackledger.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

// Dev-only alternative to Anthropic: a model running on Ollama (free, local, nothing leaves the
// machine), so Tier 2 can be exercised offline without an API key. Never used in production —
// LLM_PROVIDER stays unset there. See dev/.env.example for how the local stack points this at the
// host machine, not the gateway's own container. Read live (a function, like xeroContext.js's
// usingFixtures()), not captured at require time, so a test can flip it without a module reload.
const llmProvider = () => process.env.LLM_PROVIDER || 'anthropic';
const ollamaBaseUrl = () => process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const ollamaModel = () => process.env.OLLAMA_MODEL || 'llama3.2';

// chase+{clientId}+{bucketKey}@inbound.fasttrackledger.com — see migrations/006_action_queue.sql.
function replyToAddress(clientId, bucketKey) {
  return `chase+${clientId}+${bucketKey}@${INBOUND_EMAIL_DOMAIN}`;
}

// Accepts a raw "To" address (may carry a display name) and returns { clientId, bucketKey }, or
// null if it doesn't match the token shape at all. Callers must still verify clientId/bucketKey
// are real before trusting this — Brevo's inbound webhook carries no signature (see server.js).
function parseReplyToken(toAddress) {
  const m = /chase\+(\d+)\+([^@\s]+)@/.exec(String(toAddress || ''));
  if (!m) return null;
  return { clientId: Number(m[1]), bucketKey: m[2] };
}

// Dates that type as "this is a promise" but nearby language says otherwise — a bare regex match on
// the date alone would misfire on these. Kept deliberately broad; the cost of a false negative here
// (falling through to the LLM) is low, the cost of a false positive (wrongly auto-staging a dispute
// as a clean promise) is not.
const DISPUTE_WORDS =
  /\b(dispute|disagree|wrong|incorrect|already paid|won'?t pay|will not pay|refuse|cannot pay|can'?t pay|not until|unless|query|queried|short[- ]?paid)\b/i;
const PROMISE_WORDS =
  /\b(will pay|will make (the )?payment|paying (this|that|it)? ?on|pay(ing)? by|paid by|scheduled (the )?payment)\b/i;

function classifyLocally(bodyText, referenceDate = new Date()) {
  const text = String(bodyText || '').trim();
  if (!text || DISPUTE_WORDS.test(text) || !PROMISE_WORDS.test(text)) return null;

  const results = chrono.parse(text, referenceDate, { forwardDate: true });
  if (results.length !== 1) return null; // no date, or more than one — too ambiguous to auto-stage

  const targetDate = results[0].start.date().toISOString().slice(0, 10);
  return {
    source: 'regex',
    intent: 'PROMISE_TO_PAY',
    confidence: 0.9,
    targetDate,
    draftReply: draftForPromise(targetDate),
  };
}

function draftForPromise(targetDateIso) {
  const pretty = new Date(`${targetDateIso}T00:00:00Z`).toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `Hi,\n\nThanks for letting us know. We've noted ${pretty} as the date to expect payment and have paused reminders until then.\n\nIf anything changes, just reply to this email.`;
}

const LLM_SYSTEM_PROMPT = `You read a debtor's email reply to an overdue-invoice statement and extract structured data. Respond with ONLY a JSON object, no prose, matching exactly:
{"intent": "PROMISE_TO_PAY" | "DISPUTE" | "OTHER", "confidence": <0 to 1>, "targetDate": "YYYY-MM-DD" | null, "draftReply": "<a short, polite reply a bookkeeper could send as-is, or edit first>"}
"targetDate" is only set when intent is PROMISE_TO_PAY and a specific date is clearly stated or inferable from context (e.g. "next Friday" relative to the email's date). If the reply disputes the amount, claims it's already paid, or is otherwise not a clean promise to pay, use DISPUTE or OTHER and leave targetDate null. Never invent a date that isn't supported by the text.`;

// Shared by both providers: turns the model's raw JSON text into the normalized shape, or null if
// it isn't usable (bad JSON, an intent outside the three allowed) — same "fail into manual review,
// never lose the reply" contract either way.
function parseLlmJson(text) {
  const parsed = JSON.parse(text);
  if (!['PROMISE_TO_PAY', 'DISPUTE', 'OTHER'].includes(parsed.intent)) return null;
  return {
    source: 'llm',
    intent: parsed.intent,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    targetDate: parsed.intent === 'PROMISE_TO_PAY' ? parsed.targetDate || null : null,
    draftReply: parsed.draftReply || '',
  };
}

async function classifyWithAnthropic(bodyText, referenceDate) {
  if (!ANTHROPIC_API_KEY) {
    console.error('classifyWithLlm: ANTHROPIC_API_KEY is not set, leaving intent for manual review');
    return null;
  }
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        system: LLM_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: `Today's date is ${referenceDate.toISOString().slice(0, 10)}.\n\nEmail reply:\n${bodyText}` },
        ],
      }),
    });
    if (!res.ok) {
      console.error('classifyWithLlm: Anthropic API error', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return parseLlmJson(data?.content?.[0]?.text);
  } catch (e) {
    console.error('classifyWithLlm: failed', e.message);
    return null;
  }
}

// Ollama's own /api/chat, not the OpenAI-compatible route: format: 'json' makes it constrain
// output to valid JSON, which a small local model otherwise gets wrong often enough to matter.
async function classifyWithOllama(bodyText, referenceDate) {
  const baseUrl = ollamaBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel(),
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: LLM_SYSTEM_PROMPT },
          { role: 'user', content: `Today's date is ${referenceDate.toISOString().slice(0, 10)}.\n\nEmail reply:\n${bodyText}` },
        ],
      }),
    });
    if (!res.ok) {
      console.error('classifyWithLlm: Ollama error', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return parseLlmJson(data?.message?.content);
  } catch (e) {
    console.error(`classifyWithLlm: failed (is Ollama running? OLLAMA_BASE_URL=${baseUrl})`, e.message);
    return null;
  }
}

// Returns null (not a thrown error) on any failure — missing key, network error, bad response — so
// a broken or unconfigured LLM never loses an inbound reply. The caller still creates an
// inbound_reply row either way; a null result just means source: 'llm', intent: 'OTHER',
// confidence: 0, and an empty draft for the bookkeeper to fill in by hand.
async function classifyWithLlm(bodyText, { referenceDate = new Date() } = {}) {
  if (llmProvider() === 'ollama') return classifyWithOllama(bodyText, referenceDate);
  return classifyWithAnthropic(bodyText, referenceDate);
}

async function classifyReply(bodyText, { referenceDate = new Date() } = {}) {
  const local = classifyLocally(bodyText, referenceDate);
  if (local) return local;
  const llm = await classifyWithLlm(bodyText, { referenceDate });
  return (
    llm || {
      source: 'llm',
      intent: 'OTHER',
      confidence: 0,
      targetDate: null,
      draftReply: '',
    }
  );
}

// The 2-day grace buffer agreed with the user: reminders stay paused slightly past the promised
// date rather than resuming right on it.
const GRACE_DAYS = 2;

function resumeAfterFor(targetDateIso) {
  if (!targetDateIso) return null;
  const d = new Date(`${targetDateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + GRACE_DAYS);
  return d;
}

// bucketKey = `${contactId}_${currencyCode}` (customerBuckets.js). Split on the last underscore:
// a Xero contact GUID never contains one, so this is unambiguous.
function parseBucketKey(bucketKey) {
  const i = String(bucketKey || '').lastIndexOf('_');
  if (i < 0) return null;
  return { contactId: bucketKey.slice(0, i), currencyCode: bucketKey.slice(i + 1) };
}

module.exports = {
  INBOUND_EMAIL_DOMAIN,
  replyToAddress,
  parseReplyToken,
  parseBucketKey,
  classifyLocally,
  classifyWithLlm,
  classifyReply,
  draftForPromise,
  resumeAfterFor,
  GRACE_DAYS,
  DISPUTE_WORDS,
  PROMISE_WORDS,
};
