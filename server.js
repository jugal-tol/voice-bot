'use strict';

require('dotenv').config();
const path       = require('path');
const express    = require('express');
const enablex    = require('./lib/enablex');
const conv       = require('./lib/conversation');
// Additive: demo-portal SSO side-door (does not affect native client-side login)
const { ssoHandler } = require('./sso/portalSso');
// Additive: direct-login logging to the shared demo-portal Atlas collection
const { logLogin } = require('./loginLog');
// Additive: persistent call + transcript store (local JSON file; no effect on calls)
const callStore = require('./lib/callStore');
// Additive: Gemini AI helper (AI Summary etc.) — no-op if GEMINI_API_KEY unset
const ai = require('./lib/ai');
// Additive: rule-based fit scoring (no AI)
const fit = require('./lib/fit');

const app  = express();
const PORT = process.env.PORT || 3000;

// Max number of LLM (Gemini) generations allowed per call for Summary and for
// Structured Answers — caps token spend (buttons stop working after this).
const MAX_AI_RUNS = 3;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Additive: auto-login entry for visitors arriving from the demo portal.
app.get('/sso', ssoHandler);

// Additive: record a direct login on this app's login page (fire-and-forget).
app.post('/api/log-login', async (req, res) => {
  const { username, visitorId, source } = req.body || {};
  await logLogin({ username, visitorId, source: source || 'direct', req });
  res.json({ ok: true });
});

// Additive: expose the demo portal URL (if configured) so the client logout can
// route through the portal to end the portal session too.
app.get('/api/config', (req, res) => {
  res.json({ portalUrl: process.env.PORTAL_URL || '' });
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory session store, keyed by EnableX voice_id.
const sessions = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizeIndianNumber(input) {
  const digits = String(input || '').replace(/\D/g, '');
  let local;
  if (digits.length === 10)                                    local = digits;
  else if (digits.length === 12 && digits.startsWith('91'))   local = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0'))    local = digits.slice(1);
  else return null;
  if (!/^[6-9]\d{9}$/.test(local)) return null;
  return `+91${local}`;
}

function log(session, type, message) {
  const entry = { t: new Date().toISOString(), type, message };
  session.log.push(entry);
  console.log(`[${session.id}] ${type.toUpperCase()}: ${message}`);
}

// ─── POST /api/dial ────────────────────────────────────────────────────────

app.post('/api/dial', async (req, res) => {
  try {
    const to = normalizeIndianNumber(req.body.number);
    if (!to) {
      return res.status(400).json({ ok: false, error: 'Enter a valid 10-digit Indian mobile number (starting 6–9).' });
    }

    // EnableX routes the caller ID WITHOUT a leading "+" (a "+" passes validation
    // but the route silently rejects the call as "User busy"). Strip it defensively.
    const from = (process.env.ENABLEX_FROM_NUMBER || '').trim().replace(/^\+/, '');
    if (!from) {
      return res.status(500).json({ ok: false, error: 'ENABLEX_FROM_NUMBER is not set in the server config (.env).' });
    }

    // Parse the Job Profile box as JSON. We pass these keys to the call as
    // custom_data so a bot (EvueMe) can read them. If it isn't valid JSON,
    // reject with a clear message so the user fixes the JSON.
    const rawProfile = (req.body.jobProfile || '').trim();
    let jobProfileData = {};
    if (rawProfile) {
      try {
        jobProfileData = JSON.parse(rawProfile);
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'Job Profile must be valid JSON. ' + e.message });
      }
    }

    const profile = conv.buildProfile(req.body);
    const openingText = conv.getOpeningText(profile);

    const eventUrl = process.env.PUBLIC_WEBHOOK_URL
      ? `${process.env.PUBLIC_WEBHOOK_URL.replace(/\/$/, '')}/event`
      : undefined;

    // Clean, predictable variable keys for the bot. The portal agent prompt
    // should reference these exact names (e.g. {{candidate_name}}, {{job_title}}).
    const customData = {
      candidate_name:      (req.body.candidateName || '').trim(),
      job_title:           profile.jobTitle,
      company:             profile.companyName,
      job_location:        profile.jobArea,
      experience_required: String(profile.yearsRequired),
      salary_range:        profile.salaryRange,
      notice_period:       profile.noticePeriod,
      industry:            profile.industry,
    };

    const result = await enablex.makeOutboundCall({ to, from, openingText, eventUrl, customData });

    const voiceId = String(result.voice_id || result.call_id || result.id || '');
    if (!voiceId) {
      return res.status(502).json({ ok: false, error: 'EnableX did not return a call id.', detail: result });
    }

    const session = {
      id:           voiceId,
      to,
      from,
      profile,
      state:        'node1',
      language:     'en',
      deadAirCount: 0,
      pendingHangup: false,
      answers:      {},
      actions:      [],
      callbackSlot: null,
      log:          [],
      status:       'dialing',
      createdAt:    new Date().toISOString(),
    };
    sessions.set(voiceId, session);

    // Additive: persist a call record so the transcript webhook can attach to it later.
    callStore.upsertCall(voiceId, {
      to,
      candidateName: (req.body.candidateName || '').trim(),
      jobProfile:    jobProfileData,
      status:        'dialing',
    });

    log(session, 'system', `Call placed to ${to}. Profile: ${profile.jobTitle} / ${profile.jobArea}`);
    if (!eventUrl) {
      log(session, 'warn', 'No PUBLIC_WEBHOOK_URL set — Preeti will play the opening line only. Set it (ngrok) for the full conversation.');
    }

    res.json({ ok: true, callId: voiceId, to, webhook: Boolean(eventUrl) });
  } catch (e) {
    console.error('Dial error:', e);
    res.status(e.status || 500).json({ ok: false, error: e.message, detail: e.data });
  }
});

// ─── GET /api/status/:id ───────────────────────────────────────────────────

app.get('/api/status/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: 'Unknown call id.' });

  // Friendly answer labels for the UI
  const answerLabels = {
    experience:  'Years of experience',
    location:    'Current location',
    employer:    'Current employer',
    relocation:  'Open to relocation',
    ctc:         'Current CTC (lakhs)',
    noticeDays:  'Notice period (days)',
    industry:    'Industry background',
    billing:     'Max monthly billing',
  };

  const answers = Object.entries(session.answers).map(([key, val]) => ({
    label: answerLabels[key] || key,
    value: val === null ? 'No response' : String(val),
  }));

  res.json({
    ok:          true,
    callId:      session.id,
    to:          session.to,
    status:      session.status,
    state:       session.state,
    language:    session.language,
    outcome:     session.actions.length ? session.actions[session.actions.length - 1].action : null,
    answers,
    log:         session.log,
  });
});

// ─── POST /api/transcript  (Dialogs Cloud live-transcript webhook) ─────────
// EnableX posts the FULL transcript here on call disconnect (state:
// "transcript_complete"). We verify the auth header, match by voice_id, map each
// message (source -> speaker), and store it. Failure-isolated — never 500s the caller.

app.post('/api/transcript', (req, res) => {
  // Optional auth: if TRANSCRIPT_AUTH_TOKEN is set, require a matching
  // Bearer token OR x-api-key header. If unset (local dev), accept all.
  const expected = process.env.TRANSCRIPT_AUTH_TOKEN;
  if (expected) {
    const authz  = req.headers['authorization'] || '';
    const bearer = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    const apikey = (req.headers['x-api-key'] || '').trim();
    if (bearer !== expected && apikey !== expected) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const ev = req.body || {};
  const voiceId = String(ev.voice_id || ev.call_id || ev.id || '');
  if (!voiceId) return res.status(400).json({ ok: false, error: 'missing voice_id' });

  // Map EnableX messages -> our transcript turns (source: user=candidate, bot=Preeti).
  const messages = Array.isArray(ev.messages)
    ? ev.messages.map(m => ({
        speaker: m.source === 'bot' ? 'bot' : 'candidate',
        text:    m.text || '',
        ts:      m.ts || null,
      }))
    : [];

  callStore.attachTranscript(voiceId, { messages, postedAt: ev.timestamp });
  console.log(`[transcript] stored ${messages.length} message(s) for voice_id ${voiceId}`);
  res.json({ ok: true, stored: messages.length });
});

// ─── Read APIs (for the upcoming analysis sections) ────────────────────────
app.get('/api/calls', (req, res) => {
  res.json({ ok: true, calls: callStore.listCalls() });
});
app.get('/api/calls/:id', (req, res) => {
  const call = callStore.getCall(req.params.id);
  if (!call) return res.status(404).json({ ok: false, error: 'Call not found.' });
  res.json({ ok: true, call });
});

// Generate (and store) an AI summary for a call from its transcript.
app.post('/api/calls/:id/summary', async (req, res) => {
  const call = callStore.getCall(req.params.id);
  if (!call) return res.status(404).json({ ok: false, error: 'Call not found.' });
  if (!ai.isConfigured()) {
    return res.status(400).json({ ok: false, error: 'Gemini API key not set. Add GEMINI_API_KEY to .env and restart.' });
  }
  if (!(call.transcript && call.transcript.length)) {
    return res.status(400).json({ ok: false, error: 'No transcript stored for this call yet.' });
  }
  const used = call.aiSummaryCount || 0;
  if (used >= MAX_AI_RUNS) {
    return res.status(429).json({ ok: false, error: `Summary limit reached (${MAX_AI_RUNS} generations max for this call).`, count: used, remaining: 0 });
  }
  try {
    const { summary, usage } = await ai.summarizeCall(call);
    const count = used + 1;
    callStore.upsertCall(call.callId, { aiSummary: summary, aiSummaryAt: new Date().toISOString(), aiSummaryUsage: usage, aiSummaryCount: count });
    console.log(`[ai] summary tokens — prompt:${usage.promptTokens} output:${usage.outputTokens} thinking:${usage.thinkingTokens} total:${usage.totalTokens} (run ${count}/${MAX_AI_RUNS})`);
    res.json({ ok: true, summary, usage, count, remaining: MAX_AI_RUNS - count });
  } catch (e) {
    console.error('[ai] summary failed:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Extract structured answers from the transcript (via Gemini).
app.post('/api/calls/:id/answers', async (req, res) => {
  const call = callStore.getCall(req.params.id);
  if (!call) return res.status(404).json({ ok: false, error: 'Call not found.' });
  if (!ai.isConfigured()) return res.status(400).json({ ok: false, error: 'Gemini API key not set. Add GEMINI_API_KEY to .env and restart.' });
  if (!(call.transcript && call.transcript.length)) return res.status(400).json({ ok: false, error: 'No transcript stored for this call yet.' });
  const used = call.answersCount || 0;
  if (used >= MAX_AI_RUNS) {
    return res.status(429).json({ ok: false, error: `Extraction limit reached (${MAX_AI_RUNS} runs max for this call).`, count: used, remaining: 0 });
  }
  try {
    const { answers, usage } = await ai.extractAnswers(call);
    const count = used + 1;
    callStore.upsertCall(call.callId, { structuredAnswers: answers, answersAt: new Date().toISOString(), answersUsage: usage, answersCount: count });
    if (usage) console.log(`[ai] answers tokens — total:${usage.totalTokens} (run ${count}/${MAX_AI_RUNS})`);
    res.json({ ok: true, answers, usage, count, remaining: MAX_AI_RUNS - count });
  } catch (e) {
    console.error('[ai] extract answers failed:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Compute (and store) the fit score. Auto-extracts answers first if missing.
app.post('/api/calls/:id/fit', async (req, res) => {
  const call = callStore.getCall(req.params.id);
  if (!call) return res.status(404).json({ ok: false, error: 'Call not found.' });
  try {
    let answers = call.structuredAnswers;
    let usage = null;
    if (!answers) {
      if (!ai.isConfigured()) return res.status(400).json({ ok: false, error: 'No structured answers yet, and Gemini key not set to extract them.' });
      if (!(call.transcript && call.transcript.length)) return res.status(400).json({ ok: false, error: 'No transcript to analyze.' });
      const used = call.answersCount || 0;
      if (used >= MAX_AI_RUNS) return res.status(429).json({ ok: false, error: `Extraction limit reached (${MAX_AI_RUNS} runs max); cannot auto-extract answers for the fit score.` });
      const r = await ai.extractAnswers(call);
      answers = r.answers; usage = r.usage;
      callStore.upsertCall(call.callId, { structuredAnswers: answers, answersAt: new Date().toISOString(), answersUsage: usage, answersCount: used + 1 });
    }
    const result = fit.scoreFit(answers, call.jobProfile);
    callStore.upsertCall(call.callId, { fitScore: result.score, fitBand: result.band, fitBreakdown: result.breakdown, fitAt: new Date().toISOString() });
    res.json({ ok: true, ...result, answers, usage });
  } catch (e) {
    console.error('[fit] failed:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Aggregate analytics across all stored calls.
app.get('/api/analytics', (req, res) => {
  const calls = callStore.listCalls();
  const withT = calls.filter(c => c.transcript && c.transcript.length);
  const withA = calls.filter(c => c.structuredAnswers);
  const nums = (arr, f) => arr.map(f).filter(v => typeof v === 'number' && !isNaN(v));
  const avg = a => a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null;
  const exp    = nums(withA, c => parseFloat(c.structuredAnswers.years_experience));
  const ctc    = nums(withA, c => parseFloat(c.structuredAnswers.current_ctc_lakhs));
  const notice = nums(withA, c => parseFloat(c.structuredAnswers.notice_period_days));
  const fitArr = nums(calls, c => c.fitScore);
  const reloc  = withA.filter(c => String(c.structuredAnswers.open_to_relocation).toLowerCase() === 'yes').length;
  const industries = {};
  withA.forEach(c => { const k = (c.structuredAnswers.industry || 'Unknown').toString().trim() || 'Unknown'; industries[k] = (industries[k] || 0) + 1; });
  res.json({
    ok: true,
    analytics: {
      totalCalls: calls.length,
      withTranscript: withT.length,
      withAnswers: withA.length,
      avgExperience: avg(exp),
      avgCtc: avg(ctc),
      avgNoticeDays: avg(notice),
      avgFitScore: avg(fitArr),
      relocationPct: withA.length ? Math.round((reloc / withA.length) * 100) : null,
      industries,
    },
  });
});

// ─── POST /event  (EnableX webhook) ───────────────────────────────────────

app.post('/event', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  const ev = req.body || {};

  // EnableX may encrypt the payload; detect by x-algoritm header.
  // For this demo we assume unencrypted (no SSL-level signing configured).

  const voiceId = String(ev.voice_id || ev.call_id || ev.id || '');

  // Additive: whenever EnableX delivers a recording/transcription URL, persist it
  // by voice_id (works even if the in-memory session is gone).
  const recUrl = ev.recording_url || ev.record_url || ev.recording || ev.file_url || ev.url;
  if (voiceId && typeof recUrl === 'string' && /^https?:\/\//.test(recUrl)) {
    callStore.upsertCall(voiceId, { recordingUrl: recUrl });
    console.log(`[recording] stored URL for voice_id ${voiceId}`);
  }

  const session = sessions.get(voiceId);
  if (!session) {
    console.log('Webhook for unknown call:', voiceId, JSON.stringify(ev).slice(0, 120));
    return;
  }

  try {
    // ── Call state transitions ─────────────────────────────────────────
    if (ev.state === 'connected') {
      session.status = 'in-progress';
      log(session, 'system', 'Call answered — opening line playing.');
      // Additive: begin recording if enabled (URL arrives later via webhook above).
      if (process.env.ENABLE_RECORDING === 'true') {
        enablex.startRecording(voiceId)
          .then(() => log(session, 'system', 'Recording started.'))
          .catch(e => console.error('[recording] start failed:', e.message));
      }
      return;
    }

    if (ev.state === 'disconnected' || ev.state === 'callend' || ev.state === 'hangup') {
      if (session.status !== 'completed') session.status = 'ended';
      log(session, 'system', `Call ended. Final state: ${session.state}`);
      return;
    }

    // ── Play events ────────────────────────────────────────────────────

    // Goodbye text finished playing → now safe to hang up
    if (ev.playstate === 'playfinished' && session.pendingHangup) {
      session.status = 'completed';
      await enablex.hangup(voiceId).catch(() => {});
      log(session, 'system', 'Call completed and hung up.');
      return;
    }

    // Non-collecting play finished (shouldn't happen in normal flow, but guard anyway)
    if (ev.playstate === 'playfinished' && session.state !== 'ended') {
      return;
    }

    // ── Speech collected ───────────────────────────────────────────────
    const isAsr     = ev.playstate === 'speechcollected' || ev.playstate === 'asr_result';
    const isTimeout = ev.playstate === 'menutimeout'     || ev.playstate === 'collecttimeout';

    if (!isAsr && !isTimeout) return; // ignore other events

    const transcript = isTimeout ? '' : (ev.transcript || ev.asr_result || ev.text || '');

    if (session.state === 'ended') return;

    if (transcript) log(session, 'candidate', transcript);

    // ── Drive conversation ─────────────────────────────────────────────
    const result = conv.processResponse(session, transcript);

    log(session, 'bot', result.speak.replace(/\n/g, ' '));
    log(session, 'system', `State: ${session.state} → ${result.nextState}`);

    session.state = result.nextState;

    if (result.action) {
      session.actions.push({ action: result.action, at: new Date().toISOString() });
    }
    if (result.hasOwnProperty('callbackSlot')) {
      session.callbackSlot = result.callbackSlot;
    }

    if (result.hangup) {
      // Play farewell, then hang up on playfinished
      session.pendingHangup = true;
      await enablex.playPrompt(voiceId, result.speak, { asr: false, promptRef: 'farewell' });
    } else {
      await enablex.playPrompt(voiceId, result.speak, {
        asr:       true,
        promptRef: result.nextState,
        language:  session.language === 'hi' ? 'hi-IN' : undefined,
      });
    }
  } catch (e) {
    log(session, 'error', `Webhook handler: ${e.message}`);
    console.error('Webhook error:', e);
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const hasId  = Boolean(process.env.ENABLEX_APP_ID);
  const hasKey = Boolean(process.env.ENABLEX_APP_KEY);
  const hasFrom= Boolean(process.env.ENABLEX_FROM_NUMBER);
  const hook   = process.env.PUBLIC_WEBHOOK_URL;

  console.log(`\n  EvueMe Demo Calls  →  http://localhost:${PORT}`);
  console.log(`\n  Config:`);
  console.log(`    ENABLEX_APP_ID      : ${hasId  ? '✓ set' : '✗ NOT set'}`);
  console.log(`    ENABLEX_APP_KEY     : ${hasKey ? '✓ set' : '✗ NOT set'}`);
  console.log(`    ENABLEX_FROM_NUMBER : ${hasFrom? process.env.ENABLEX_FROM_NUMBER : '✗ NOT set'}`);
  console.log(`    PUBLIC_WEBHOOK_URL  : ${hook   ? hook + '/event' : '✗ not set (only opening line will play)'}`);
  console.log();
});
