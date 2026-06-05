'use strict';

// ─── Intent Classification ─────────────────────────────────────────────────

const INTENT_MAP = [
  ['WRONG_NUMBER',    ['wrong number','galat number','wrong','galat','different person','not me']],
  ['WHO_IS_THIS',     ['who is this','who are you','kaun bol','kaun hai','kaun']],
  ['WHAT_JOB',        ['what job','which job','kya job','tell me about the job','what role','which role','what kind']],
  ['HOW_LONG',        ['how long','kitna time','how many questions','how much time','kitne sawaal']],
  ['BUSY',            ['busy','bad time','not a good time','not now','later','call back','call me later',
                       'baad mein','abhi nahi','in a meeting','occupied','driving','will call back','thoda baad']],
  ['SALARY_QUERY',    ['salary','ctc','pay','package','compensation','kitna milega','how much earn','what is the salary']],
  ['LOCATION_QUERY',  ['location','where','kahan','which city','place','posting','city','territory']],
  ['TELL_MORE',       ['tell me more','more details','more information','explain','what does','what will','elaborate']],
  ['WITHDRAW',        ['withdraw','remove my','don\'t process','do not process','not process','cancel']],
  ['NO',              ['no','nope','nah','nahi','naa','not interested','not looking','happy where','happy with current',
                       'don\'t want','dont want','mat karo','rehne do']],
  ['YES',             ['yes','yeah','yep','sure','okay','ok','go ahead','please','of course','absolutely',
                       'definitely','haan','ha','ji','bilkul','theek hai','theek h','achha','acha','ji haan',
                       'proceed','fine','alright','sounds good','carry on','chalo','chal']],
];

function classifyIntent(transcript) {
  if (!transcript || !transcript.trim()) return 'NO_RESPONSE';
  const t = transcript.toLowerCase();
  for (const [intent, patterns] of INTENT_MAP) {
    if (patterns.some(p => t.includes(p))) return intent;
  }
  return 'OPEN_ANSWER';
}

// ─── Language Detection ────────────────────────────────────────────────────

const HINDI_MARKERS = ['haan','nahi','kaun','kya','theek','bilkul','achha','acha','saal',
  'lakh','baad','abhi','main','aap','baat','hai','naa','nahin','kyun','kab','yaar','bhai'];

function detectLanguage(transcript) {
  if (!transcript) return null;
  const t = transcript.toLowerCase();
  const count = HINDI_MARKERS.filter(w => t.includes(w)).length;
  if (count >= 3) return 'hi';
  if (count >= 1) return 'hinglish';
  return 'en';
}

// ─── Number Extraction ─────────────────────────────────────────────────────

const WORD_NUMS = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17,
  eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40, fifty:50, sixty:60,
  ek:1, do:2, teen:3, char:4, paanch:5, chhe:6, saat:7, aath:8, nau:9, das:10,
};

function extractNumber(t) {
  if (!t) return null;
  const m = t.match(/\b(\d+(?:\.\d+)?)\b/);
  if (m) return parseFloat(m[1]);
  for (const [word, num] of Object.entries(WORD_NUMS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(t)) return num;
  }
  return null;
}

function extractYears(t) {
  if (!t) return null;
  const m = t.match(/(\d+)\s*(?:year|yr|saal)/i);
  if (m) return parseInt(m[1]);
  return extractNumber(t);
}

function extractLakhs(t) {
  if (!t) return null;
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:lakh|lac|lakhs|lpa|l\.p\.a)/i);
  if (m) return parseFloat(m[1]);
  return extractNumber(t);
}

function extractNoticeDays(t) {
  if (!t) return null;
  if (/immediate|joining now|right away|right now|abhi se/i.test(t)) return 0;
  const d = t.match(/(\d+)\s*(?:day|din)/i);
  if (d) return parseInt(d[1]);
  const mo = t.match(/(\d+)\s*(?:month|mahina|mahine)/i);
  if (mo) return parseInt(mo[1]) * 30;
  const n = extractNumber(t);
  // bare numbers ≤ 5 are likely months; ≥ 7 are likely days
  if (n !== null) return n <= 5 ? n * 30 : n;
  return null;
}

function matchIndustry(t) {
  if (!t) return 'other';
  t = t.toLowerCase();
  if (/tile|ceramic|vitrif|porcelain/.test(t))                        return 'tiles';
  if (/building material|construction material|cement|aggregate/.test(t)) return 'building_materials';
  if (/paint|coating|berger|nerolac|asian paint/.test(t))             return 'paints';
  if (/\bcp\b|plumbing|sanitary|bathroom fitting/.test(t))            return 'cp_fittings';
  if (/plywood|\bply\b|laminate|wood panel/.test(t))                  return 'plywood';
  if (/consumer durable|appliance|electronics|washing machine|fridge/.test(t)) return 'consumer_durables';
  if (/fmcg|fast moving|consumer good/.test(t))                       return 'fmcg';
  if (/pharma|medicine|medical|healthcare/.test(t))                   return 'pharma';
  if (/auto|automobile|vehicle/.test(t))                              return 'automobile';
  if (/insurance|banking|finance|nbfc/.test(t))                       return 'bfsi';
  if (/telecom|mobile|network/.test(t))                               return 'telecom';
  return 'other';
}

// ─── Fit Signals ───────────────────────────────────────────────────────────

function parseBand(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)/);
  if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  const n = String(s).match(/(\d+(?:\.\d+)?)/);
  return n ? { min: 0, max: parseFloat(n[1]) } : null;
}

function maxNoticeDays(s) {
  if (!s) return 30;
  const d = String(s).match(/(\d+)\s*day/i);
  if (d) return parseInt(d[1]);
  const mo = String(s).match(/(\d+)\s*month/i);
  if (mo) return parseInt(mo[1]) * 30;
  return 30;
}

function fitExperience(years, required) {
  const req = parseInt(required) || 3;
  if (years === null) return "Thank you, I have noted that.";
  if (years >= req)  return "Good, that fits the profile we are looking for.";
  if (years < 2)    return "Noted. This role typically looks for a bit more experience, but I will still pass on your details.";
  return `Noted. The role ideally requires around ${req} years, but I will share your profile with the team.`;
}

function fitLocation(transcript, jobArea) {
  if (!jobArea) return "Okay, noted.";
  const area = jobArea.toLowerCase().split(/[\s,]+/)[0]; // first word of area
  const inArea = transcript.toLowerCase().includes(area);
  return inArea
    ? "That works well for this role."
    : `Okay, noted. The role is based in ${jobArea}. We will factor that in.`;
}

function fitSalary(lakhs, band) {
  const b = parseBand(band);
  if (!b || lakhs === null) return "Thank you, I have noted your current CTC.";
  if (lakhs >= b.min && lakhs <= b.max) return "That is in a range we can work with.";
  if (lakhs < b.min)  return "Good, there may be a strong upside here for you.";
  return `Noted. I will be transparent — the offered range for this role is ${band}. I will still share your profile and let the team decide.`;
}

function fitNotice(days, maxAllowed) {
  const max = maxNoticeDays(maxAllowed);
  if (days === null) return "Thank you, I have noted your notice period.";
  if (days === 0)   return "Wonderful, that works perfectly.";
  if (days <= max)  return "That works well for our timelines.";
  if (days <= 60)   return "Manageable. Most teams can plan around that.";
  return "Noted. I will flag it. Sometimes the hiring team can accommodate a longer joining date.";
}

function fitIndustry(detected, preferred) {
  const STRONG   = ['tiles', 'building_materials'];
  const ADJACENT = ['paints', 'cp_fittings', 'plywood', 'consumer_durables', 'fmcg'];
  if (STRONG.includes(detected))   return "Strong fit. That background maps very well to this role.";
  if (ADJACENT.includes(detected)) return "Relevant experience. The domain is adjacent enough.";
  // Check against user-supplied preference string
  const pref = (preferred || '').toLowerCase();
  if (pref && detected !== 'other' && pref.includes(detected.replace('_', ' ')))
    return "Strong fit. That background maps very well to this role.";
  return "Noted. The team sometimes considers strong sales professionals from other sectors too.";
}

// ─── FAQ Matching ──────────────────────────────────────────────────────────

function matchFAQ(transcript, profile) {
  const t = (transcript || '').toLowerCase();
  const area = profile.jobArea    || 'the designated territory';
  const sal  = profile.salaryRange || 'competitive, based on experience';
  const co   = profile.companyName || 'the company';
  const role = profile.jobTitle   || 'this role';

  if (/(salary|ctc|pay|package|how much earn|compensation|kitna milega)/.test(t))
    return `The offered CTC range for this role is ${sal}. The exact number depends on your current salary and the interview outcome.`;

  if (/(location|where|territory|posting|which city|kahan)/.test(t))
    return `This role is based in ${area}. You would be covering the assigned geographic region.`;

  if (/(growth|career|promot|next step|progress|future|long.?term|hierarchy)/.test(t))
    return `${co} has a structured progression for sales roles. The next step from ${role} is typically a Regional or Senior Sales Manager. The timeline depends on performance. The hiring manager can give you a more specific picture.`;

  if (/(tilekart|platform|app|digital|portal|software)/.test(t))
    return `Tilekart is Orient Bell's digital platform for channel partners. It enables order placement, delivery tracking, and lead access. As an Area Sales Manager, you would use it to drive secondary sales for your channel partners.`;

  if (/(team|report|boss|head|subordinate|junior|who do i report)/.test(t))
    return `You would report to the Regional Sales Manager for your territory. The team structure depends on the territory, and the hiring manager will walk you through that in the interview.`;

  if (/(when|how soon|timeline|shortlist|hear back|how many days|joining)/.test(t))
    return `The team is actively hiring. If your profile is shortlisted, someone will reach out within 3 to 5 working days.`;

  if (/(interview|process|round|selection|step|procedure)/.test(t))
    return `Typically it involves an HR round followed by one or two rounds with the business team. The exact process will be confirmed when the team connects with you.`;

  if (/(field|office|outdoor|indoor|travel|remote|wfh|work from)/.test(t))
    return `This is largely a field-based role with daily visits to architects, contractors, and channel partners. There will be periodic reporting, but this is a frontline sales role.`;

  if (/(product|brand|range|portfolio|what sell|what to sell|category)/.test(t))
    return `The product range covers ceramic and vitrified tiles across residential and commercial segments. You would be responsible for the full portfolio in your territory.`;

  if (/(benefit|allowance|reimburs|incentive|perk|bonus|variable|hike)/.test(t))
    return `Yes, field sales roles typically include travel reimbursements and a standard benefits package. The specifics will be shared during the interview.`;

  if (/(permanent|contract|full.?time|tenure|temp|probation)/.test(t))
    return `This is a permanent, full-time role.`;

  if (/(contact|reach|email|number|touch|get back)/.test(t))
    return `The team will reach out to you directly. You will also receive the interview details on WhatsApp and email shortly.`;

  return null; // no match — pass to HR
}

// ─── Script Texts (Preeti's lines) ────────────────────────────────────────

function T(key, p) {
  const name     = p.candidateName ? p.candidateName : 'there';
  const nameComma= p.candidateName ? `, ${p.candidateName}` : '';
  const co       = p.companyName   || 'our company';
  const role     = p.jobTitle      || 'the position';
  const area     = p.jobArea       || 'the designated territory';
  const sal      = p.salaryRange   || 'competitive';
  const yrs      = p.yearsRequired || '3';

  const MAP = {
    node1:
      `Hello, am I speaking to ${name}? Please note this call may be recorded for quality and training purposes.`,

    node2:
      `My name is Preeti, and I am calling from ${co}. This call is about a job opening in our company. Is this a good time to speak?`,

    node2_callback:
      `No problem. Can I call you back in a couple of hours, or would tomorrow morning at 10 AM be convenient?`,

    node2_whatjob:
      `It is for the role of ${role}. Let me take just 3 minutes to explain, and you can decide if it is relevant for you. Is that okay?`,

    node3:
      `${co} is a leading company in its sector. This call is for the role of ${role}, based in ${area}. ` +
      `In this role you would be responsible for driving sales through channel partners, managing key client relationships, ` +
      `meeting your monthly revenue and collection targets, and building strong relationships with architects, contractors, and key influencers. ` +
      `Does this sound like something you would want to explore?`,

    node3_more:
      `The role covers a defined territory with a mix of project and retail accounts. You would work closely with channel partners ` +
      `and report to the Regional Sales Manager. Does that sound like a fit for you?`,

    node4:
      `Thank you. May I ask you a few quick questions to check if this role is a good match for your profile?`,

    node4_howlong:
      `It will take around 4 to 5 minutes, and there are 8 questions. Shall we go ahead?`,

    node5_q1: `How many years of work experience do you have in total?`,
    node5_q2: `Which city or location are you currently based in?`,
    node5_q3: `Which organisation are you currently working with?`,
    node5_q4: `If selected, would you be open to relocation with your family, as per company requirements? A simple yes or no works.`,
    node5_q5: `What is your current annual CTC, in lakhs?`,
    node5_q6: `What is the minimum notice period you can negotiate with your current employer, if you are selected for this role?`,
    node5_q7: `Most of your professional experience has been in which of these industries? I will read them out: Tiles, Building Materials, Paints, CP Fittings, Plywood, Consumer Durables, or None of these.`,
    node5_q8: `In your professional career, what is the maximum monthly billing you have handled, in terms of sales value? An approximate figure is perfectly fine.`,

    node5a:
      `Thank you for answering those. Do you have any questions for me about this role or the company?`,

    node5a_followup:
      `Is there anything else you would like to know?`,

    node6:
      `Thank you${nameComma}. That covers everything from my end. Your profile has been shortlisted for an interview with us. ` +
      `I am going to send you a WhatsApp message and an email with the interview details. Is that okay with you?`,

    node6_confirmed:
      `Wonderful. Please check your WhatsApp and email shortly. All the best, and have a great day.`,

    node6_call_instead:
      `Absolutely. Someone from the team will reach out to confirm. ` +
      `You will still receive the interview details on WhatsApp and email for your reference. Have a great day.`,

    node6_withdraw:
      `Of course. I have noted that your profile should not be processed further. Thank you for your time, and take care. Goodbye.`,

    not_interested:
      `Understood. Would it be okay if I kept your profile on file in case something better-suited comes up later? ` +
      `Thank you, and have a good day.`,

    defer_query:
      `We will cover both compensation and location details in the next couple of minutes, as part of the quick screening. May I go ahead?`,

    polite_end:
      `That is fine. I will note that you are open to future opportunities. Have a good day.`,

    wrong_number:
      `My sincere apologies for the trouble. Have a good day.`,

    no_response_end:
      `I hope you have a great day. Goodbye.`,
  };
  return MAP[key] || '';
}

// Returns the current question text for "are you still there?" replays.
function getCurrentQuestion(state, p) {
  const questionStates = {
    node1:'node1', node2:'node2', node3:'node3', node4:'node4',
    node5_q1:'node5_q1', node5_q2:'node5_q2', node5_q3:'node5_q3', node5_q4:'node5_q4',
    node5_q5:'node5_q5', node5_q6:'node5_q6', node5_q7:'node5_q7', node5_q8:'node5_q8',
    node5a:'node5a', node6:'node6',
  };
  const key = questionStates[state];
  return key ? T(key, p) : null;
}

// ─── Main State Machine ────────────────────────────────────────────────────

/**
 * Call this on every webhook ASR event.
 * Returns { speak, nextState, hangup, action }
 *   speak     – text Preeti says next
 *   nextState – new session.state
 *   hangup    – true = play speak then end the call
 *   action    – side-effect label to log ('shortlisted'|'callback'|'not_interested'|'withdrawn')
 */
function processResponse(session, transcript) {
  const p = session.profile;

  // ── Dead air ────────────────────────────────────────────────────────────
  if (!transcript || !transcript.trim()) {
    session.deadAirCount = (session.deadAirCount || 0) + 1;
    if (session.deadAirCount >= 2) {
      return { speak: T('no_response_end', p), nextState: 'ended', hangup: true };
    }
    const q = getCurrentQuestion(session.state, p);
    const retry = q
      ? `Are you still there? Let me repeat: ${q}`
      : 'Are you still there?';
    return { speak: retry, nextState: session.state };
  }
  session.deadAirCount = 0;

  // ── Language detection (mirror) ─────────────────────────────────────────
  const lang = detectLanguage(transcript);
  if (lang && lang !== 'en') session.language = lang;

  const intent = classifyIntent(transcript);

  // ── State handlers ──────────────────────────────────────────────────────
  switch (session.state) {

    // Node 1 – Identity confirmation
    case 'node1': {
      if (intent === 'WRONG_NUMBER')
        return { speak: T('wrong_number', p), nextState: 'ended', hangup: true };
      // "Who is this?" → jump straight to Node 2 intro (Node 2 already introduces Preeti)
      return { speak: T('node2', p), nextState: 'node2' };
    }

    // Node 2 – Purpose + good time?
    case 'node2': {
      if (intent === 'BUSY')
        return { speak: T('node2_callback', p), nextState: 'node2_callback', action: 'callback' };
      if (intent === 'WHAT_JOB')
        return { speak: T('node2_whatjob', p), nextState: 'node2_whatjob' };
      if (intent === 'NO')
        return { speak: T('not_interested', p), nextState: 'ended', hangup: true, action: 'not_interested' };
      return { speak: T('node3', p), nextState: 'node3' };
    }

    case 'node2_callback': {
      session.callbackSlot = transcript;
      return {
        speak: `Great, I have noted that. Someone from the team will arrange a callback. Have a good day.`,
        nextState: 'ended', hangup: true, action: 'callback',
      };
    }

    case 'node2_whatjob': {
      if (intent === 'NO')
        return { speak: T('not_interested', p), nextState: 'ended', hangup: true, action: 'not_interested' };
      return { speak: T('node3', p), nextState: 'node3' };
    }

    // Node 3 – Role brief
    case 'node3':
    case 'node3_more':
    case 'node3_defer': {
      if (intent === 'TELL_MORE' && session.state === 'node3')
        return { speak: T('node3_more', p), nextState: 'node3_more' };
      if (intent === 'NO' || /not looking|happy where|happy with current/i.test(transcript))
        return { speak: T('not_interested', p), nextState: 'ended', hangup: true, action: 'not_interested' };
      if ((intent === 'SALARY_QUERY' || intent === 'LOCATION_QUERY') && session.state === 'node3')
        return { speak: T('defer_query', p), nextState: 'node3_defer' };
      return { speak: T('node4', p), nextState: 'node4' };
    }

    // Node 4 – Screening consent
    case 'node4': {
      if (intent === 'NO')
        return { speak: T('polite_end', p), nextState: 'ended', hangup: true };
      if (intent === 'HOW_LONG')
        return { speak: T('node4_howlong', p), nextState: 'node4_howlong' };
      return { speak: T('node5_q1', p), nextState: 'node5_q1' };
    }

    case 'node4_howlong': {
      if (intent === 'NO')
        return { speak: T('polite_end', p), nextState: 'ended', hangup: true };
      return { speak: T('node5_q1', p), nextState: 'node5_q1' };
    }

    // ── Node 5: Screening Questions ──────────────────────────────────────

    case 'node5_q1': {
      const years = extractYears(transcript);
      session.answers.experience = years;
      const sig = fitExperience(years, p.yearsRequired);
      return { speak: `${sig} ${T('node5_q2', p)}`, nextState: 'node5_q2' };
    }

    case 'node5_q2': {
      session.answers.location = transcript;
      const sig = fitLocation(transcript, p.jobArea);
      return { speak: `${sig} ${T('node5_q3', p)}`, nextState: 'node5_q3' };
    }

    case 'node5_q3': {
      session.answers.employer = transcript;
      return { speak: `Thank you, that is helpful context. ${T('node5_q4', p)}`, nextState: 'node5_q4' };
    }

    case 'node5_q4': {
      const yes = intent === 'YES' || /yes|open|willing|sure|okay|bilkul|haan/i.test(transcript);
      session.answers.relocation = yes ? 'yes' : 'no';
      const sig = yes
        ? 'Good to know, that works for this role.'
        : 'Understood. Some postings may be local, so your profile is still relevant.';
      return { speak: `${sig} ${T('node5_q5', p)}`, nextState: 'node5_q5' };
    }

    case 'node5_q5': {
      const lakhs = extractLakhs(transcript);
      session.answers.ctc = lakhs;
      const sig = fitSalary(lakhs, p.salaryRange);
      return { speak: `${sig} ${T('node5_q6', p)}`, nextState: 'node5_q6' };
    }

    case 'node5_q6': {
      const days = extractNoticeDays(transcript);
      session.answers.noticeDays = days;
      const sig = fitNotice(days, p.noticePeriod);
      return { speak: `${sig} ${T('node5_q7', p)}`, nextState: 'node5_q7' };
    }

    case 'node5_q7': {
      const ind = matchIndustry(transcript);
      session.answers.industry = ind;
      const sig = fitIndustry(ind, p.industry);
      return { speak: `${sig} ${T('node5_q8', p)}`, nextState: 'node5_q8' };
    }

    case 'node5_q8': {
      session.answers.billing = transcript;
      const billing = extractLakhs(transcript);
      const sig = billing !== null
        ? (billing >= 50 ? 'That is a solid track record. Relevant for this role.' : 'Okay, noted. I will share your profile with the team.')
        : 'Thank you, I have noted that.';
      return { speak: `${sig} ${T('node5a', p)}`, nextState: 'node5a' };
    }

    // ── Node 5A: Candidate FAQ ────────────────────────────────────────────

    case 'node5a':
    case 'node5a_followup': {
      const noMore = intent === 'NO'
        || /no question|i('m| am) good|that('s| is) all|no more|nothing|thats it/i.test(transcript);
      if (noMore)
        return { speak: T('node6', p), nextState: 'node6', action: 'shortlist' };

      const ans = matchFAQ(transcript, p);
      if (ans)
        return { speak: `${ans} ${T('node5a_followup', p)}`, nextState: 'node5a_followup' };

      // Out of scope question
      return {
        speak: `That is a good question. I will make sure to pass it on to the HR team, and they will address it when they reach out to you. ${T('node6', p)}`,
        nextState: 'node6', action: 'shortlist',
      };
    }

    // ── Node 6: Close ─────────────────────────────────────────────────────

    case 'node6': {
      if (intent === 'WITHDRAW' || /withdraw|remove|don't proceed|do not proceed/i.test(transcript))
        return { speak: T('node6_withdraw', p), nextState: 'ended', hangup: true, action: 'withdrawn' };

      // Candidate asks one more question before confirming
      const faqAns = matchFAQ(transcript, p);
      if (faqAns)
        return { speak: `${faqAns} ${T('node6', p)}`, nextState: 'node6' };

      // "Call me instead" request
      if (/call me|phone me|speak to someone|someone call/i.test(transcript))
        return { speak: T('node6_call_instead', p), nextState: 'ended', hangup: true, action: 'shortlisted' };

      // Any positive / open answer → confirmed
      return { speak: T('node6_confirmed', p), nextState: 'ended', hangup: true, action: 'shortlisted' };
    }

    default:
      return { speak: 'Thank you. Have a great day. Goodbye.', nextState: 'ended', hangup: true };
  }
}

// ─── Profile Builder ───────────────────────────────────────────────────────

/**
 * Parse free-form text (key: value lines OR JSON) into a structured map.
 * Handles both formats transparently.
 */
function parseJobProfileText(raw) {
  if (!raw || !raw.trim()) return {};

  // Try JSON first
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* not JSON */ }

  // Free-form text: extract "Label: value" pairs (case-insensitive, colon or dash separator)
  const result = {};
  const lines = raw.split(/\n/);
  for (const line of lines) {
    const m = line.match(/^([^:\-]+?)\s*[:\-]\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, '_');
    result[key] = m[2].trim();
  }

  // Also scan free text for patterns that weren't on label:value lines
  if (!result.year_of_experience_required && !result.experience_required && !result.experience) {
    const m = raw.match(/(\d+)\+?\s*years?\s*(?:of\s+)?(?:experience|exp)/i);
    if (m) result.year_of_experience_required = m[1];
  }
  if (!result.expected_salary_range && !result.salary_range && !result.salary) {
    const m = raw.match(/(\d+\s*(?:to|-)\s*\d+\s*(?:lakh|lac|lakhs|lpa))/i);
    if (m) result.expected_salary_range = m[1];
  }
  return result;
}

/** Case-insensitive key lookup across multiple possible key names. */
function getField(map, ...keys) {
  const norm = {};
  for (const [k, v] of Object.entries(map)) {
    norm[k.toLowerCase().replace(/[\s_\-]/g, '')] = v;
  }
  for (const k of keys) {
    const v = norm[k.toLowerCase().replace(/[\s_\-]/g, '')];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * Accepts either:
 *   { candidateName, jobProfile }   ← new simple UI (textarea)
 *   { candidateName, companyName, jobTitle, jobArea, ... }  ← old individual fields
 */
function buildProfile(data) {
  let fields = {};

  if (data.jobProfile !== undefined) {
    // New UI: parse the textarea content
    fields = parseJobProfileText(data.jobProfile || '');
  } else {
    // Old individual-field format — treat as-is
    fields = data;
  }

  return {
    candidateName: (data.candidateName || '').trim(),
    companyName:   getField(fields, 'company_name','company','companyname','organisation','organization','firm') || 'our company',
    jobTitle:      getField(fields, 'job_title','jobtitle','title','role','position','designation') || 'the open position',
    jobArea:       getField(fields, 'job_area','jobarea','job_location','joblocation','area','territory','location','city','based_in') || '',
    yearsRequired: parseInt(getField(fields, 'year_of_experience_required','years_of_experience_required',
                            'experience_required','experience','years_required','years','exp')) || 3,
    salaryRange:   getField(fields, 'expected_salary_range','salary_range','salary','ctc','package','compensation') || '',
    noticePeriod:  getField(fields, 'notice_period_expected','notice_period','notice','joining_period') || '30 days',
    industry:      getField(fields, 'type_of_industry','industry','sector','industry_type','background') || '',
  };
}

/** Text for the very first play delivered via action_on_connect. */
function getOpeningText(profile) {
  return T('node1', profile);
}

module.exports = { processResponse, buildProfile, getOpeningText, classifyIntent, detectLanguage, T };
