'use strict';
/**
 * Rule-based Fit Score (0-100) — NO AI, pure code.
 * Compares the candidate's extracted answers against the job profile.
 * Weights: Experience 25 · Industry 25 · Salary 15 · Notice 15 · Relocation 10 · Location 10.
 */
function num(x) { const n = parseFloat(x); return isNaN(n) ? null : n; }
function parseYears(s) { const m = String(s || '').match(/(\d+)/); return m ? parseInt(m[1], 10) : null; }
function parseBand(s) {
  s = String(s || '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:to|-|–|—)\s*(\d+(?:\.\d+)?)/);
  if (m) return { min: +m[1], max: +m[2] };
  const n = s.match(/(\d+(?:\.\d+)?)/);
  return n ? { min: 0, max: +n[1] } : null;
}
function parseDays(s) {
  s = String(s || '');
  const d = s.match(/(\d+)\s*day/i); if (d) return +d[1];
  const mo = s.match(/(\d+)\s*month/i); if (mo) return +mo[1] * 30;
  const n = s.match(/(\d+)/); return n ? +n[1] : 30;
}

const STRONG = ['tile', 'building material'];
const ADJACENT = ['paint', 'cp', 'plywood', 'ply', 'consumer durable', 'fmcg', 'sanitary', 'fitting'];

function scoreFit(answers, jobProfile) {
  answers = answers || {};
  jobProfile = jobProfile || {};
  const rows = [];
  let score = 0;
  const add = (label, detail, points, max) => { rows.push({ label, detail, points, max }); score += points; };

  // Experience (25)
  const reqY = parseYears(jobProfile.experience_required) || 3;
  const y = num(answers.years_experience);
  if (y == null)          add('Experience', 'not stated', 10, 25);
  else if (y >= reqY)     add('Experience', `${y} yrs ≥ ${reqY} required`, 25, 25);
  else if (y >= reqY - 2) add('Experience', `${y} yrs (slightly below ${reqY})`, 16, 25);
  else                    add('Experience', `${y} yrs (below ${reqY})`, 7, 25);

  // Industry (25)
  const pref = String(jobProfile.industry || '').toLowerCase();
  const ind = String(answers.industry || '').toLowerCase();
  if (!ind)                                                     add('Industry', 'not stated', 10, 25);
  else if (STRONG.some(k => ind.includes(k)) || (pref && pref.includes(ind))) add('Industry', `${answers.industry} — strong fit`, 25, 25);
  else if (ADJACENT.some(k => ind.includes(k)))                 add('Industry', `${answers.industry} — adjacent`, 16, 25);
  else                                                          add('Industry', `${answers.industry} — other sector`, 8, 25);

  // Salary (15)
  const band = parseBand(jobProfile.salary_range);
  const ctc = num(answers.current_ctc_lakhs);
  if (!band || ctc == null)  add('Salary', 'not comparable', 8, 15);
  else if (ctc <= band.max)  add('Salary', `CTC ${ctc}L within/below band (≤${band.max}L)`, 15, 15);
  else                       add('Salary', `CTC ${ctc}L above band (>${band.max}L)`, 6, 15);

  // Notice period (15)
  const maxN = parseDays(jobProfile.notice_period);
  const nd = num(answers.notice_period_days);
  if (nd == null)      add('Notice period', 'not stated', 8, 15);
  else if (nd <= maxN) add('Notice period', `${nd}d ≤ ${maxN}d limit`, 15, 15);
  else if (nd <= 60)   add('Notice period', `${nd}d (manageable)`, 10, 15);
  else                 add('Notice period', `${nd}d (long)`, 5, 15);

  // Relocation (10)
  const rel = String(answers.open_to_relocation || '').toLowerCase();
  if (rel === 'yes')     add('Relocation', 'willing', 10, 10);
  else if (rel === 'no') add('Relocation', 'not willing', 3, 10);
  else                   add('Relocation', 'not stated', 5, 10);

  // Location (10)
  const area = String(jobProfile.job_location || '').toLowerCase().split(/[\s,]+/)[0];
  const loc = String(answers.current_location || '').toLowerCase();
  if (!area || !loc)         add('Location', 'not comparable', 5, 10);
  else if (loc.includes(area)) add('Location', `${answers.current_location} — in territory`, 10, 10);
  else                       add('Location', `${answers.current_location} — outside ${jobProfile.job_location}`, 4, 10);

  score = Math.round(score);
  const band_label = score >= 75 ? 'Strong fit' : score >= 50 ? 'Moderate fit' : 'Weak fit';
  return { score, band: band_label, breakdown: rows };
}

module.exports = { scoreFit };
