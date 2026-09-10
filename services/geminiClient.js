// services/geminiClient.js
// Single place that talks to Gemini. Both the multilingual explanation
// (aiService) and the structured code review (reviewService) go through here,
// so timeout/retry/error behaviour is identical for both and there is exactly
// one place to change when the model id moves again.

// gemini-2.5-flash — free tier eligible, stable.
// NOTE: gemini-1.5-flash and gemini-2.0-flash were both shut down June 1, 2026.
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const DEFAULT_TIMEOUT_MS = 20000;

// gemini-2.5-flash has "thinking" ON by default, and those internal reasoning
// tokens count against maxOutputTokens — silently eating the budget before any
// visible text is generated and truncating mid-sentence. Every call here
// disables it explicitly; none of our tasks need extended reasoning.
const NO_THINKING = { thinkingBudget: 0 };

// Why the last call produced nothing.
//
// Every failure used to collapse into a bare `null`, so a caller could not
// tell an exhausted free-tier quota from a model that genuinely declined. That
// surfaced to users as "No response from the model" for all of them — which
// named the symptom and hid the cause. FATAL failures are worth stopping a
// batch for; a per-item failure is not.
let lastFailure = null;

const FATAL_STATUSES = new Set([401, 403, 429]);

function describeFailure(status, body) {
  const snippet = String(body || '');
  if (status === 429) {
    return 'Gemini quota exceeded (429) — the free tier resets daily, or the key needs billing enabled';
  }
  if (status === 401 || status === 403) {
    return `Gemini rejected the API key (${status})`;
  }
  if (status >= 500) return `Gemini is unavailable (${status})`;
  const m = /"message"\s*:\s*"([^"]{0,160})"/.exec(snippet);
  return `Gemini error ${status}${m ? ` — ${m[1]}` : ''}`;
}

/** Reason the most recent call returned nothing, or null if it succeeded. */
function lastGeminiFailure() {
  return lastFailure;
}

/** True when retrying other items is pointless — quota or a bad key. */
function isFatalGeminiFailure(reason) {
  return typeof reason === 'string'
    && /quota exceeded|rejected the API key|not configured/i.test(reason);
}

async function callGemini(prompt, {
  temperature = 0.4,
  maxOutputTokens = 1024,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  responseMimeType,
} = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[geminiClient] GEMINI_API_KEY not configured — skipping call');
    lastFailure = 'GEMINI_API_KEY is not configured on the server';
    return null;
  }

  const generationConfig = {
    temperature,
    thinkingConfig: NO_THINKING,
    maxOutputTokens,
  };
  // Asking for application/json makes Gemini emit bare JSON with no ```json
  // fence, which removes a whole class of parse failures.
  if (responseMimeType) generationConfig.responseMimeType = responseMimeType;

  try {
    const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[geminiClient] API error ${response.status}:`, errBody.slice(0, 200));
      lastFailure = describeFailure(response.status, errBody);
      return null;
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];

    if (candidate?.finishReason === 'MAX_TOKENS') {
      console.warn(`[geminiClient] hit MAX_TOKENS at ${maxOutputTokens} — output truncated`);
    }

    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
      lastFailure = candidate?.finishReason === 'MAX_TOKENS'
        ? 'the model hit its output limit before producing an answer'
        : 'the model returned an empty response';
      return null;
    }
    lastFailure = null;
    return text.trim();

  } catch (error) {
    lastFailure = error.name === 'TimeoutError'
      ? `the model did not answer within ${timeoutMs / 1000}s`
      : `could not reach the model (${error.message})`;
    console.error('[geminiClient] call failed:', error.message);
    return null;
  }
}

// Same call, but parses the reply as JSON. Returns null rather than throwing
// on malformed output — a bad model reply must never take down an analysis.
async function callGeminiJson(prompt, options = {}) {
  const raw = await callGemini(prompt, {
    ...options,
    responseMimeType: 'application/json',
  });
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    // Belt and braces: if a fence slipped through despite the mime type,
    // pull the outermost JSON object out and retry once.
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) {
      console.error('[geminiClient] reply was not JSON:', raw.slice(0, 160));
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      console.error('[geminiClient] JSON parse failed after fence strip');
      return null;
    }
  }
}

module.exports = {
  callGemini, callGeminiJson, GEMINI_MODEL,
  lastGeminiFailure, isFatalGeminiFailure, FATAL_STATUSES,
};
