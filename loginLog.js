'use strict';
/**
 * ADDITIVE login logging → demo-portal shared Atlas collection (login_events).
 *
 * Uses a SEPARATE mongoose connection (this app otherwise has no database). Writes
 * one document per direct login on this app's login page, for cross-app reporting.
 * If LOG_MONGODB_URI is not set, every call is a safe no-op.
 *
 *   LOG_MONGODB_URI  Atlas connection string (secret — set in backend env, never committed)
 *   LOG_DB_NAME      shared database (default: portal_db)
 *   LOG_APP_ID       this app's id in the report (default: evueme)
 */
const mongoose = require('mongoose');

const APP_ID = process.env.LOG_APP_ID || 'evueme';
const LOG_URI = process.env.LOG_MONGODB_URI || '';
const LOG_DB = process.env.LOG_DB_NAME || 'portal_db';

let conn = null;
let LoginEvent = null;
function ensure() {
  if (!LOG_URI) return false;
  if (conn) return true;
  conn = mongoose.createConnection(LOG_URI, { dbName: LOG_DB });
  LoginEvent = conn.model(
    'LoginEvent',
    new mongoose.Schema(
      {
        app: String,
        username: String,
        success: Boolean,
        source: String, // direct | portal-sso
        ip: String,
        userAgent: String,
        device: { browser: String, os: String, deviceType: String },
        visitorId: String,
        at: { type: Date, default: Date.now },
        atIST: String,
      },
      { collection: 'login_events' }
    )
  );
  return true;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const raw = (Array.isArray(fwd) ? fwd[0] : (fwd || '').split(',')[0]) || req.socket.remoteAddress || '';
  return raw.replace('::ffff:', '').trim();
}

// Dependency-free User-Agent → { browser, os, deviceType }.
function deviceFrom(ua) {
  ua = ua || '';
  const browser = /Edg/i.test(ua) ? 'Edge'
    : /OPR|Opera/i.test(ua) ? 'Opera'
    : /Chrome/i.test(ua) ? 'Chrome'
    : /Firefox/i.test(ua) ? 'Firefox'
    : /Safari/i.test(ua) ? 'Safari' : 'Unknown';
  const os = /Windows/i.test(ua) ? 'Windows'
    : /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /Linux/i.test(ua) ? 'Linux' : 'Unknown';
  const deviceType = /Mobi|Android|iPhone/i.test(ua) ? 'mobile'
    : /iPad|Tablet/i.test(ua) ? 'tablet' : 'desktop';
  return { browser, os, deviceType };
}

// Human-readable IST timestamp: "DD/MM/YYYY, HH:mm:ss" (Asia/Kolkata).
function istStamp(d) {
  return (d || new Date()).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

async function logLogin({ username, visitorId, source = 'direct', req }) {
  if (!ensure()) return;
  try {
    const ua = req.headers['user-agent'];
    await LoginEvent.create({
      app: APP_ID,
      username: username || null,
      success: true,
      source,
      ip: clientIp(req),
      userAgent: ua,
      device: deviceFrom(ua),
      visitorId: visitorId || null,
      atIST: istStamp(),
    });
  } catch (e) {
    console.error('[login-log] failed:', e.message);
  }
}

module.exports = { logLogin };
