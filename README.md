# Meeting → Action (MERN)

React + Express + MongoDB + Node. Audio → transcript → minutes → action items → GitHub/Trello tasks → reminder emails,
with cross-meeting slip tracking and unresolved-decision detection.

## Setup
Video files (mp4, mov, mkv, webm) and long recordings need **ffmpeg** installed on the server machine; it extracts and compresses the audio track.

Prereqs: Node 18+, MongoDB (local or free Atlas cluster), free Groq API key (https://console.groq.com).

    cd server && cp .env.example .env   # fill MONGO_URI + Groq key
    npm install && npm run dev

    cd client && npm install && npm run dev   # http://localhost:5173

## Try it
1. "New meeting" tab: paste the contents of sample-transcript.txt, attendees "Asha, Ravi, Meera", today's date.
2. Add a second meeting with a later date where Ravi again says the bug is delayed.
3. Open "Dashboard": the bug shows as slipping, the payments provider and onboarding emails as unresolved/ownerless.

## API
POST /api/meetings (multipart: audio | transcriptText, title, date, attendees)
GET  /api/meetings, /api/meetings/:id, /api/report
PATCH /api/actions/:id {status}, /api/topics/:id/resolve

## Agents (server/src/agents.js)
transcribe · summarize · extractActions · draftReminder · trackProgress · auditDecisions
