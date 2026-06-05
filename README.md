# Demo Calls — EnableX Outbound Screening

A simple local web page that places an **outbound screening call** to an Indian
mobile number using the [EnableX Programmable Voice API](https://developer.enablex.io/voice/).
The questions asked on the call are generated from a **Job Profile** JSON you paste
into the page.

## How it works

```
Browser (index.html)
   │  number + Job Profile JSON
   ▼
server.js  ──POST /voice/v1/call──▶  EnableX  ──places call──▶  candidate's phone
   ▲                                    │
   └───────  webhook /event  ◀──────────┘   (drives the question-by-question IVR)
```

1. You type an Indian mobile number and a Job Profile JSON, then click **Dial Out**.
2. The server validates the number, turns the JSON into an ordered question script
   (`lib/questions.js`), and starts the call (`lib/enablex.js`).
3. The intro plays via `action_on_connect`. Each following question is played from
   the `/event` webhook; keypad (DTMF) or spoken answers are collected and shown
   live on the page.

## Job Profile JSON

Recognised fields (all optional, matched case-insensitively):

| Field | Becomes a question about |
|-------|--------------------------|
| `job_title` / `job_area` | intro line |
| `year_of_experience_required` | years of experience (keypad) |
| `type_of_industry` | industry experience (1=yes / 2=no) |
| `expected_salary_range` | salary expectation (1=yes / 2=no) |
| `notice_period_expected` | notice period (1=yes / 2=no) |
| `relocate_or_not` | willingness to relocate (1=yes / 2=no) |
| `questions` (array of strings) | extra free-form questions (spoken answer) |

Example:

```json
{
  "job_title": "Area Sales Manager",
  "job_area": "Mumbai West",
  "year_of_experience_required": 5,
  "expected_salary_range": "12 to 15 lakhs per annum",
  "notice_period_expected": "30 days",
  "type_of_industry": "FMCG",
  "relocate_or_not": "yes",
  "questions": ["What is your current job title?"]
}
```

Use **Preview Questions** to see what the caller will hear before dialing.

## Run it

```powershell
npm install
copy .env.example .env   # then fill in your EnableX credentials
npm start
```

Open http://localhost:3000.

### Webhook for the full question flow

To ask more than the intro prompt, EnableX needs a public URL to send call events
to. For local testing, run [ngrok](https://ngrok.com):

```powershell
ngrok http 3000
```

Put the `https://...` URL it gives you into `PUBLIC_WEBHOOK_URL` in `.env`, then
restart `npm start`. Without it, the call still connects and plays the intro, but
the per-question sequencing won't run.

## Configuration

All credentials live in `.env` (see `.env.example`). See the bottom of this file
for exactly which values to fill in.
