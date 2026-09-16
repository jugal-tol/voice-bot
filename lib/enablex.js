'use strict';

/**
 * Thin wrapper around the EnableX Programmable Voice REST API.
 * Auth: Basic base64(APP_ID:APP_KEY)
 * All calls use the native `fetch` built into Node 18+.
 */

const BASE_URL = process.env.ENABLEX_BASE_URL || 'https://api.enablex.io';
const TTS_LANGUAGE = () => process.env.TTS_LANGUAGE || 'en-IN';
const TTS_VOICE    = () => process.env.TTS_VOICE    || 'female';

// Two EnableX "accounts": the primary project (existing bot/S2S flow) and an
// optional ALT project that owns the second dial-out number used by the custom
// Azure+Gemini+Sarvam pipeline. Each has its own app id / app key / base url.
function creds(account) {
  if (account === 'alt') {
    const id  = process.env.ENABLEX_APP_ID_ALT;
    const key = process.env.ENABLEX_APP_KEY_ALT;
    if (!id || !key) throw new Error('ENABLEX_APP_ID_ALT / ENABLEX_APP_KEY_ALT are not set (needed for the alt dial-out number). See .env.example.');
    return { id, key, base: process.env.ENABLEX_BASE_URL_ALT || BASE_URL };
  }
  const id  = process.env.ENABLEX_APP_ID;
  const key = process.env.ENABLEX_APP_KEY;
  if (!id || !key) throw new Error('ENABLEX_APP_ID / ENABLEX_APP_KEY are not set. See .env.example.');
  return { id, key, base: BASE_URL };
}

function authHeader(account) {
  const { id, key } = creds(account);
  return `Basic ${Buffer.from(`${id}:${key}`).toString('base64')}`;
}

async function apiCall(method, path, body, account) {
  const { base } = creds(account);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: authHeader(account), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(`EnableX ${method} ${path} → ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data   = data;
    throw err;
  }
  return data;
}

/**
 * Place an outbound call.
 * The `openingText` is played immediately when the call connects (action_on_connect).
 * ASR is enabled so the candidate's first spoken response comes back via webhook.
 */
async function makeOutboundCall({ to, from, openingText, eventUrl, customData, account }) {
  const body = {
    name:      'demo-calls',
    owner_ref: 'evueme',
    to,
    from,
    // custom_data carries per-call values. NOTE: EnableX round-trips this to your
    // webhook; whether the AI Voice Agent injects it into the prompt depends on
    // the agent's variable config (confirm the field name + placeholder syntax).
    custom_data: customData || {},
    // action_on_connect makes the call valid and lets THIS app drive the
    // conversation when the number is not bound to an external bot.
    action_on_connect: {
      play: {
        text:       openingText,
        voice:      TTS_VOICE(),
        language:   TTS_LANGUAGE(),
        prompt_ref: 'node1',
        asr:        true,
      },
    },
  };
  if (eventUrl) body.event_url = eventUrl;
  return apiCall('POST', '/voice/v1/call', body, account);
}

/**
 * Play a TTS prompt on an in-progress call.
 * @param {string} voiceId    - EnableX call voice_id
 * @param {string} text       - text for Preeti to speak
 * @param {object} opts
 *   asr         {boolean}  – true = listen for spoken response (default true)
 *   promptRef   {string}   – label echoed back in webhook events
 *   language    {string}   – override TTS/ASR language (e.g. 'hi-IN')
 */
async function playPrompt(voiceId, text, opts = {}) {
  const { asr = true, promptRef = 'prompt', language, account } = opts;
  const body = {
    text,
    voice:      TTS_VOICE(),
    language:   language || TTS_LANGUAGE(),
    prompt_ref: promptRef,
  };
  if (asr) body.asr = true;
  return apiCall('PUT', `/voice/v1/call/${voiceId}/play`, body, account);
}

/** Hang up the call immediately. `account` selects which project's creds to use. */
async function hangup(voiceId, account) {
  return apiCall('DELETE', `/voice/v1/call/${voiceId}`, undefined, account);
}

/** Begin recording the active call leg. Recording URL is delivered via webhook. */
async function startRecording(voiceId, account) {
  return apiCall('POST', `/voice/v1/call/${voiceId}/record/start`, undefined, account);
}

/** Stop an active recording. */
async function stopRecording(voiceId, account) {
  return apiCall('POST', `/voice/v1/call/${voiceId}/record/stop`, undefined, account);
}

module.exports = { makeOutboundCall, playPrompt, hangup, startRecording, stopRecording };
