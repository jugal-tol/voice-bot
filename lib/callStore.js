'use strict';
/**
 * Persistent call + transcript + analysis store.
 *
 * Backend: MongoDB (collection "calls") when CALLS_MONGODB_URI is set; otherwise a
 * local JSON file (data/calls.json). One document per call, keyed by callId (the
 * EnableX voice_id), holding EVERYTHING about that call — profile, transcript, and
 * all analysis (summary, structured answers, fit score).
 *
 * The public interface stays SYNCHRONOUS (getCall/listCalls read an in-memory cache
 * that is hydrated from Mongo at startup and kept in sync on every write), so the
 * rest of the app needs no changes. Writes also persist to Mongo asynchronously.
 *
 *   CALLS_MONGODB_URI   Atlas/company connection string (secret; in .env)
 *   CALLS_DB_NAME       database name (default: vectra)
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Build a mongodb:// URI from individual parts (used only if no full conn string).
// Credentials are URL-encoded automatically (handles @, #, / etc. in the password).
function buildFromParts() {
  const host = (process.env.MONGODB_HOST_NAME || process.env.MONGODB_HOST || '').trim();
  if (!host) return '';
  const port = (process.env.MONGODB_PORT || '27017').trim();
  const un   = (process.env.MONGODB_UN || '').trim();
  const pw   = (process.env.MONGODB_PW || '').trim();
  const auth = un ? `${encodeURIComponent(un)}:${encodeURIComponent(pw)}@` : '';
  return `mongodb://${auth}${host}:${port}/`;
}

// Connection string priority: MONGO_CONN_STRING → built-from-parts → CALLS_MONGODB_URI (legacy/Atlas).
const URI = (process.env.MONGO_CONN_STRING || '').trim()
  || buildFromParts()
  || (process.env.CALLS_MONGODB_URI || '').trim();
// DB name priority: MONGODB_NAME → CALLS_DB_NAME → 'vectra'.
const DB  = (process.env.MONGODB_NAME || process.env.CALLS_DB_NAME || 'vectra').trim();
const USE_MONGO = !!URI;

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'calls.json');

let mem = {};       // in-memory cache, keyed by callId (source for sync reads)
let Call = null;    // mongoose model (Mongo mode)

let resolveReady;
const ready = new Promise(r => { resolveReady = r; });   // resolves once the backend is loaded

const now = () => new Date().toISOString();
// Human-readable IST timestamp: "DD/MM/YYYY, HH:mm:ss" (Asia/Kolkata, 24-hour).
function istStamp(d) {
  return (d || new Date()).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// ── File backend ───────────────────────────────────────────────────────────
function fileLoad() {
  try { return fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8') || '{}') : {}; }
  catch (e) { console.error('[callStore] file load failed:', e.message); return {}; }
}
function fileSave() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(mem, null, 2));
  } catch (e) { console.error('[callStore] file save failed:', e.message); }
}

// ── Init ─────────────────────────────────────────────────────────────────────
if (USE_MONGO) {
  const conn = mongoose.createConnection(URI, { dbName: DB });
  const schema = new mongoose.Schema(
    { callId: { type: String, unique: true, index: true } },
    { strict: false, minimize: false, collection: 'calls' }
  );
  Call = conn.model('Call', schema);
  conn.asPromise()
    .then(async () => {
      try {
        const docs = await Call.find({}).lean();
        // Merge, never clobber: keep any entry already written in-memory (avoids a
        // startup race where hydration overwrites fresh writes).
        docs.forEach(d => { const o = { ...d }; delete o._id; delete o.__v; if (mem[o.callId] === undefined) mem[o.callId] = o; });
        console.log(`[callStore] MongoDB connected (db="${DB}") — loaded ${docs.length} call(s).`);
      } catch (e) { console.error('[callStore] hydrate failed:', e.message); }
      resolveReady();
    })
    .catch(e => { console.error('[callStore] Mongo connection failed:', e.message); resolveReady(); });
} else {
  mem = fileLoad();
  console.log('[callStore] using local JSON file (CALLS_MONGODB_URI not set).');
  resolveReady();
}

// Persist one call. Returns a promise (Mongo) so scripts can await; server ignores it.
function persist(callId) {
  if (USE_MONGO) {
    if (!Call) return Promise.resolve();
    const doc = { ...mem[callId] }; delete doc._id;   // snapshot; never $set _id
    return Call.updateOne({ callId }, { $set: doc }, { upsert: true })
      .catch(e => console.error('[callStore] mongo upsert failed:', e.message));
  }
  fileSave();
  return Promise.resolve();
}

// ── Public API (sync reads; writes update cache immediately + persist) ───────
function upsertCall(callId, fields) {
  if (!callId) return null;
  const existing = mem[callId] || { callId, createdAt: now(), dateandtime: istStamp(), transcript: [] };
  mem[callId] = Object.assign(existing, fields || {}, { updatedAt: now() });
  persist(callId);
  return mem[callId];
}

function attachTranscript(voiceId, { messages, postedAt } = {}) {
  if (!voiceId) return null;
  const rec = mem[voiceId] || { callId: voiceId, createdAt: now(), dateandtime: istStamp(), transcript: [] };
  rec.transcript = Array.isArray(messages) ? messages : [];
  rec.transcriptComplete = true;
  rec.transcriptPostedAt = postedAt || now();
  rec.updatedAt = now();
  mem[voiceId] = rec;
  persist(voiceId);
  return rec;
}

function getCall(callId) { return mem[callId] || null; }
function listCalls() {
  return Object.values(mem).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

// For scripts/tests: await this to be sure pending Mongo writes have flushed.
function flush(callId) { return persist(callId); }

module.exports = { upsertCall, attachTranscript, getCall, listCalls, flush, ready };
