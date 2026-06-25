// services/aiService.js
// Generates a code explanation using Gemini, in any language defined in
// languageConfig.js. No language is hardcoded here — this file reads the
// config dynamically, so adding a new language requires zero changes here.

const { getLanguageConfig, isSupportedLanguage } = require('./languageConfig');

// gemini-2.5-flash — free tier eligible, stable.
// NOTE: gemini-1.5-flash and gemini-2.0-flash were both shut down June 1, 2026.
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL    = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAX_FLOWS_IN_PROMPT = 40;
const MAX_CODE_CONTEXT_CHARS = 6000;

// ── Build a compact, readable summary of flows ────────────────────────────
function summarizeFlows(flows) {
  return flows
    .slice(0, MAX_FLOWS_IN_PROMPT)
    .map(f => {
      let line = `${f.from} → ${f.to}`;
      if (f.mismatch)         line += ' [TYPE MISMATCH]';
      if (f.brokenDependency) line += ' [BROKEN — target was deleted in this PR]';
      if (f.deletedSource)    line += ' [SOURCE was deleted in this PR]';
      return line;
    })
    .join('\n');
}

// ── Build the full prompt for a given language ────────────────────────────
function buildPrompt(languageCode, { prTitle, codeLanguage, flows, stats, codeContext }) {
  const langConfig = getLanguageConfig(languageCode);
  const flowSummary = summarizeFlows(flows);
  const truncatedNote = flows.length > MAX_FLOWS_IN_PROMPT
    ? `\n(${flows.length - MAX_FLOWS_IN_PROMPT} additional flows omitted for brevity)`
    : '';

  const codeBlock = codeContext
    ? `\nRelevant code from this PR:\n\`\`\`\n${codeContext.slice(0, MAX_CODE_CONTEXT_CHARS)}\n\`\`\`\n`
    : '';

  return `You are explaining a GitHub pull request's code to a developer reviewing it.

PR Title: ${prTitle || 'Untitled'}
Code language: ${codeLanguage || 'unknown'}
Stats: ${stats.totalNodes} nodes, ${stats.totalEdges} edges, ${stats.mismatches} type mismatches, ${stats.brokenDependencies || 0} broken dependencies, ${stats.deletedClasses || 0} deleted classes

Code flow (from → to):
${flowSummary}${truncatedNote}
${codeBlock}
${langConfig.styleInstruction}

Write a genuine code explanation (5-8 sentences) covering:
1. What this PR actually does, grounded in the real code shown above — not just the flow arrows
2. The execution path: entry point → business logic → data layer
3. Any risks worth flagging (type mismatches, broken dependencies) — only if present

Do not use markdown headers or bullet points. Write in flowing paragraphs. Be direct — this is for a busy developer doing code review.`;
}

// ── Call Gemini API ─────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[aiService] GEMINI_API_KEY not configured — skipping AI explanation');
    return null;
  }

  try {
    const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          // ✅ FIX: gemini-2.5-flash has "thinking" ON by default, and those
          // internal reasoning tokens count against maxOutputTokens — silently
          // eating the budget before any visible text is generated, causing
          // mid-sentence truncation. We don't need extended reasoning for a
          // straightforward explanation task, so disable it entirely.
          thinkingConfig: { thinkingBudget: 0 },
          // Raised from 600 → 1024 as a safety margin in case thinking
          // budget is partially ignored on some requests (known API quirk).
          maxOutputTokens: 1024,
        },
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[aiService] Gemini API error ${response.status}:`, errBody.slice(0, 200));
      return null;
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];

    // Log if we still hit the token limit, so it's visible in server logs
    if (candidate?.finishReason === 'MAX_TOKENS') {
      console.warn('[aiService] Response hit MAX_TOKENS — consider raising maxOutputTokens further');
    }

    const text = candidate?.content?.parts?.[0]?.text;
    return text ? text.trim() : null;

  } catch (error) {
    console.error('[aiService] Gemini call failed:', error.message);
    return null;
  }
}

// ── Public API — generate explanation in any supported language ──────────
// Returns null if: no nodes, unsupported language, no API key, or call fails.
// Callers must treat null as "no explanation available" — never throw.
async function generateExplanation(languageCode, { prTitle, codeLanguage, flows, stats, codeContext }) {
  if (!isSupportedLanguage(languageCode)) {
    console.warn(`[aiService] Unsupported language requested: ${languageCode}`);
    return null;
  }
  if (!stats || stats.totalNodes === 0) {
    return null;
  }
  if (!flows || flows.length === 0) {
    return null;
  }

  const prompt = buildPrompt(languageCode, { prTitle, codeLanguage, flows, stats, codeContext });
  return callGemini(prompt);
}

module.exports = { generateExplanation };