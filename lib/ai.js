'use strict';
/**
 * Gemini AI helper (ADDITIVE). Powers AI Summary + Structured Answers.
 *
 * Uses Google's Generative Language REST API (no SDK needed — native fetch).
 * Safe: if GEMINI_API_KEY is unset, isConfigured() is false and callers no-op.
 *
 *   GEMINI_API_KEY   your Google Gemini API key (secret; set in .env)
 *   GEMINI_MODEL     model id (default: gemini-2.0-flash)
 */
const KEY   = () => (process.env.GEMINI_API_KEY || '').trim();
const MODEL = () => (process.env.GEMINI_MODEL || 'gemini-flash-latest').trim();

function isConfigured() { return !!KEY(); }

/** Low-level: send a text prompt to Gemini, return the text response. */
async function generate(prompt, { json = false } = {}) {
  const key = KEY();
  if (!key) throw new Error('GEMINI_API_KEY is not set.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: json ? { responseMimeType: 'application/json' } : {},
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
    throw new Error(`Gemini API error: ${msg}`);
  }
  const parts = data && data.candidates && data.candidates[0] &&
                data.candidates[0].content && data.candidates[0].content.parts;
  const text = (parts || []).map(p => p.text || '').join('').trim();
  const um = data.usageMetadata || {};
  const usage = {
    promptTokens:   um.promptTokenCount || 0,      // input
    outputTokens:   um.candidatesTokenCount || 0,  // visible answer
    thinkingTokens: um.thoughtsTokenCount || 0,    // model's internal reasoning
    totalTokens:    um.totalTokenCount || 0,       // sum of all
  };
  return { text, usage };
}

/** Render a stored transcript array into readable "Speaker: text" lines. */
function transcriptToText(transcript) {
  return (transcript || [])
    .map(m => `${m.speaker === 'bot' ? 'Preeti (bot)' : 'Candidate'}: ${m.text}`)
    .join('\n');
}

/** Produce a short recruiter-facing summary of a call. */
async function summarizeCall(call) {
  const convo = transcriptToText(call.transcript);
  if (!convo) return null;
  const jp = call.jobProfile || {};
  const prompt =
`You are assisting a recruiter reviewing a phone screening call.

Role: ${jp.job_title || 'N/A'} at ${jp.company || 'N/A'} (${jp.job_location || 'N/A'}).
Candidate: ${call.candidateName || 'Unknown'}.

Below is the transcript between the screening bot (Preeti) and the candidate.
Write a concise summary as 4-6 short bullet points covering: total experience, current
role/company, salary and notice period, relocation and industry fit, and an overall
impression. Use ONLY facts stated in the transcript — do not invent anything. Keep it
factual and neutral. Output plain text bullets starting with "- ".

Transcript:
${convo}`;
  const { text, usage } = await generate(prompt);
  return { summary: text, usage };
}

/** Extract the candidate's answers into clean structured fields (via Gemini JSON). */
async function extractAnswers(call) {
  const convo = transcriptToText(call.transcript);
  if (!convo) return { answers: null, usage: null };
  const prompt =
`From the screening-call transcript below, extract the CANDIDATE's answers as JSON with
EXACTLY these keys (use null if a field was not answered — do NOT guess):
{
  "years_experience": number|null,
  "current_location": string|null,
  "current_employer": string|null,
  "open_to_relocation": "yes"|"no"|null,
  "current_ctc_lakhs": number|null,
  "notice_period_days": number|null,
  "industry": string|null,
  "max_monthly_billing_lakhs": number|null
}
Convert phrases to numbers (e.g. "seven years" -> 7, "thirty days" -> 30, "nine lakhs" -> 9).
Return ONLY the JSON object.

Transcript:
${convo}`;
  const { text, usage } = await generate(prompt, { json: true });
  let answers = null;
  try { answers = JSON.parse(text); }
  catch (e) {
    // strip any code fences and retry
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { answers = JSON.parse(cleaned); } catch (_) { throw new Error('Could not parse extracted answers as JSON.'); }
  }
  return { answers, usage };
}

module.exports = { isConfigured, generate, transcriptToText, summarizeCall, extractAnswers };
