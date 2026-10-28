# Meeting → Action

Turn meeting recordings into minutes, tasks with owners and deadlines, and reminder emails that send themselves. It also tracks tasks across meetings, flags the ones that keep slipping, and catches decisions nobody made.

Built with the MERN stack (MongoDB, Express, React, Node) and free tools only.

## Features

- **Audio and video upload.** mp3, wav, m4a, mp4, mov, mkv, webm and more, up to 500 MB. Video is converted to audio with ffmpeg.
- **Transcription** with Whisper (Groq free tier).
- **Meeting minutes.** Summary, discussion points and decisions.
- **Action items.** Owners and deadlines pulled from what people said, with relative dates ("Friday") turned into real dates.
- **Tasks created automatically** as GitHub Issues or Trello cards. Marking a task done here closes the issue or completes the card.
- **Slip tracking across meetings.** Postponed or overdue tasks add a slip. At 2 slips, a task turns red on the dashboard and gets a comment on its card.
- **Unresolved decisions.** "We never decided who owns this" is flagged and counted each time it returns.
- **Automatic emails.** A reminder to each owner and a recap to the whole team, sent as soon as the meeting is processed. Optional daily reminders for overdue tasks.
- **Admin accounts.** Register and log in. Each admin only sees their own meetings, tasks and decisions.
- **Completion history.** Marking a task done or a decision resolved stores who did it and when, with an optional note on what was decided. Anything can be reopened.
- **Landing page** with light and dark mode.

## How it works

```
upload (audio/video)
   → ffmpeg           extract and compress the audio
   → Transcriber      Whisper turns speech into text
   → Summarizer       minutes, discussion points, decisions
   → Progress tracker compares open tasks from earlier meetings: done, postponed, still open
   → Decision auditor finds unresolved topics and settles earlier ones
   → Action-item agent new tasks with owner and deadline
   → Trello / GitHub  task created
   → Follow-up agent  reminder per owner + team recap
   → Mailer           emails sent to addresses from the Team tab
```

## Tech stack

| Part | Tool |
|---|---|
| Frontend | React 18, Vite |
| Backend | Node 18+, Express, Mongoose |
| Database | MongoDB (local or Atlas free tier) |
| Auth | JWT, bcryptjs |
| Speech to text | Whisper large-v3 on Groq (free tier) |
| LLM | Any OpenAI-compatible API: Groq (free) or Ollama (local) |
| Email | Nodemailer (Gmail, Outlook, Brevo, or a fake inbox for testing) |
| Scheduling | node-cron |

## Prerequisites

- Node.js 18 or newer
- MongoDB, either local or a free Atlas cluster
- A free Groq API key from https://console.groq.com
- ffmpeg, needed for video files and long recordings
  - macOS: `brew install ffmpeg`
  - Ubuntu: `sudo apt install ffmpeg`
  - Windows: `winget install ffmpeg`

## Setup

```bash
# 1. server
cd server
cp .env.example .env     # then fill in the values below
npm install
npm run dev              # http://localhost:5000

# 2. client (new terminal)
cd client
npm install
npm run dev              # http://localhost:5173
```

Open http://localhost:5173, create an account, and add your team on the **Team** tab.

## Environment variables (`server/.env`)

| Variable | Purpose |
|---|---|
| `PORT` | API port, default 5000 |
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` | Secret for login tokens. Generate with `openssl rand -hex 32` |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | The language model. Groq: `https://api.groq.com/openai/v1` and `llama-3.3-70b-versatile`. Ollama: `http://localhost:11434/v1` |
| `WHISPER_BASE_URL`, `WHISPER_API_KEY`, `WHISPER_MODEL` | Transcription. With Groq, use the same key as the LLM |
| `TASK_BACKEND` | `github`, `trello` or `none` |
| `GITHUB_TOKEN`, `GITHUB_REPO` | For GitHub Issues (`owner/repo`) |
| `TRELLO_KEY`, `TRELLO_TOKEN`, `TRELLO_LIST_ID` | For Trello cards |
| `MAIL_MODE` | `test` sends to a fake inbox and gives preview links. No real emails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Real email. These override `MAIL_MODE` |
| `DAILY_REMINDERS` | `true` emails owners their overdue tasks every day |
| `REMINDER_CRON` | Schedule for daily reminders, default `0 9 * * *` |

### Sending real emails with Gmail

1. Turn on 2-Step Verification for the Google account.
2. Create an App Password at https://myaccount.google.com/apppasswords.
3. Set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER`, `SMTP_PASS` (the 16 characters, no spaces) and `MAIL_FROM` in `server/.env`.
4. Restart the server.

Use an App Password, never your real password. Keep `.env` out of Git (the `.gitignore` already does this).

## Using the app

1. **Team tab.** Add each person's name and email. Names must match how you type attendees.
2. **New meeting.** Upload a recording or paste a transcript. Enter the date and attendees (for example `Asha, Ravi, Meera`) and leave the title empty to let the AI name it.
3. **Meeting page.** Read the minutes, new tasks and emails. Each email has a **Send** button.
4. **Dashboard.** See slipping tasks, tasks with no owner and unresolved decisions. Click **Mark done** or **Resolved** to move them to **Completed**, and **Reopen** to undo.

Upload meetings in date order. Slip detection compares due dates with the meeting date.

### Try it with sample recordings (macOS)

```bash
mkdir -p test-media && cd test-media

cat > meeting1.txt <<'TXT'
Asha: Okay team, let's start the sprint sync. Ravi, how is the login bug?
Ravi: Still working on it. I will fix it by Friday, October 23rd.
Meera: I will send the revised pricing deck to the client by Wednesday.
Asha: We need to choose a payment provider, Stripe or Razorpay?
Ravi: Razorpay has better UPI support, but Stripe has better documentation.
Asha: Let's circle back on that later. Also, someone has to own the onboarding emails. Anyone?
Meera: Not sure, let's see later.
Asha: Okay, that's all for today.
TXT

say -f meeting1.txt -o meeting1.aiff
ffmpeg -y -i meeting1.aiff -ac 1 -b:a 64k meeting1.mp3
```

Upload `meeting1.mp3` with date `2026-10-19` and attendees `Asha, Ravi, Meera`. Then create a second recording where Ravi pushes the login bug deadline again, upload it with a later date, and watch the slip count rise on the dashboard.

## API

All routes except `/api/auth/*` need an `Authorization: Bearer <token>` header.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | Create an admin or log in |
| GET | `/api/auth/me` | Current admin |
| POST | `/api/meetings` | Upload audio, video or a transcript and run the pipeline |
| GET | `/api/meetings`, `/api/meetings/:id` | List meetings, or one with its tasks |
| POST | `/api/meetings/:id/emails/:idx/send` | Send one email |
| GET | `/api/report` | Dashboard data |
| PATCH | `/api/actions/:id` | Mark a task done or reopen it (`{status}`) |
| PATCH | `/api/topics/:id/resolve`, `/api/topics/:id/reopen` | Resolve or reopen a decision |
| GET, POST, DELETE | `/api/contacts` | Team names and emails |
| POST | `/api/reminders/run` | Email overdue and slipping tasks now |
| DELETE | `/api/dev/reset` | Wipe your own data (development only) |

## Project structure

```
server/src/
  index.js         Express app and routes
  auth.js          register, login, JWT
  models.js        User, Contact, Meeting, Action, Topic
  pipeline.js      runs the agents in order
  agents.js        transcriber, summarizer, action-item, follow-up, progress tracker, decision auditor
  media.js         ffmpeg audio extraction
  mailer.js        sending and address lookup
  scheduler.js     daily reminder job
  integrations.js  GitHub Issues and Trello
client/src/
  App.jsx          login, upload, meeting page, dashboard, team
  Landing.jsx      landing page (with landing.css)
```

## Troubleshooting

| Problem | Fix |
|---|---|
| "ffmpeg not installed" | Install ffmpeg, then restart the server |
| "Missing JWT_SECRET" | Add `JWT_SECRET` to `server/.env` |
| Email shows "No email address" | Add the person on the Team tab with the same name used in attendees |
| Email shows "Failed" | Check `SMTP_USER` and `SMTP_PASS`. Gmail needs an App Password with no spaces |
| Owner is wrong or missing | Type attendee names exactly as on the Team tab. Speech recognition can misspell names |
| "No new action items" | The tasks already exist from an earlier meeting. Duplicates are skipped on purpose |
| Slips look wrong | Upload meetings in date order |
| Changes to `.env` do nothing | Restart the server |

## Limitations

- A meeting is processed during the upload request, so it can take 30 to 60 seconds. A job queue such as BullMQ would fix this for production.
- Recordings over about 100 minutes are rejected, because of the 25 MB Whisper limit after compression.
- Only video audio is used. Slides and screen content are ignored.
- All speakers sound the same to Whisper, so owners come from names mentioned in the conversation.
- Only admins can log in. Team members receive emails but have no account.
- AI output varies between runs. Check the tasks and owners before relying on them.

## Ideas for next

- Forgot-password flow
- Record from the browser (mic, webcam or screen)
- Speaker identification
- Slack notifications
- Non-admin team member accounts
- A job queue for long recordings
