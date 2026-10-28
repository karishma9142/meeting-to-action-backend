import fs from "fs";
import OpenAI from "openai";

const llm = new OpenAI({ baseURL: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY });
const whisper = new OpenAI({
  baseURL: process.env.WHISPER_BASE_URL || process.env.LLM_BASE_URL,
  apiKey: process.env.WHISPER_API_KEY || process.env.LLM_API_KEY,
});

async function chat(system, user, json = true) {
  const r = await llm.chat.completions.create({
    model: process.env.LLM_MODEL,
    temperature: 0.1,
    ...(json ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  const out = r.choices[0].message.content;
  return json
    ? JSON.parse(out.replace(/```json|```/g, "").trim())
    : out.replace(/^\s*```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "").trim();
}

const sender = (name) => name || process.env.SENDER_NAME || "Meeting Assistant";
const weekday = (date) => new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" });

// 1. TRANSCRIBER
export async function transcribe(filePath) {
  const r = await whisper.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: process.env.WHISPER_MODEL || "whisper-large-v3",
    response_format: "verbose_json",
  });
  if (!r.segments) return r.text;
  return r.segments
    .map((s) => `[${String(Math.floor(s.start / 60)).padStart(2, "0")}:${String(Math.floor(s.start % 60)).padStart(2, "0")}] ${s.text.trim()}`)
    .join("\n");
}

// 2. SUMMARIZER
export const summarize = (transcript, date, attendees) =>
  chat(
    `You write meeting minutes. Return JSON: {"title": str, "summary": str (3-5 sentences), "discussionPoints": [str], "decisions": [{"decision": str, "owner": str|null}]}.
Rules:
- title: short, WITHOUT any date.
- decisions: ONLY choices the group actually agreed on (e.g. "We will use Stripe"). Do NOT put individual to-dos here (like "Ravi will fix the bug") and do NOT list topics that were postponed or left open. If nothing was decided, return an empty list.
- Do not invent facts.`,
    `Date: ${date}\nAttendees: ${attendees.join(", ")}\n\nTRANSCRIPT:\n${transcript}`
  );

// 3. ACTION-ITEM AGENT
export async function extractActions(transcript, date, attendees, alreadyOpen) {
  const r = await chat(
    `You extract ACTION ITEMS from a meeting transcript. An action item is any commitment or assignment to do something: "I will...", "I'll...", "X, please...", "can you...", "by Friday...".
Return JSON: {"actions": [{"task": str, "owner": str|null, "due": "YYYY-MM-DD"|null, "quote": str}]}.
Rules:
- Be thorough: extract EVERY commitment, even small ones.
- owner = the speaker who said "I will / I'll", or the person being asked ("Meera, please..."). Use names exactly as written in the attendees list. The transcript comes from speech recognition, so a name may be misspelled (e.g. "Mira" for "Meera"); always map it to the closest attendee name. Never assign a task to someone who did not take it on. Use null only if truly nobody is responsible.
- The meeting date is ${date} (${weekday(date)}). Convert "Friday", "next week", "October 23rd" etc. into YYYY-MM-DD. A weekday name means the next such day on or after the meeting date. Keep the meeting's year unless a year is stated. If no deadline was said, due is null; never guess.
- Do NOT create action items for undecided topics or open questions ("we need to choose a provider", "someone has to own X"). Those are tracked separately as unresolved decisions.
- SKIP anything that is already in ALREADY_OPEN (same task, even if worded differently).
Example: "Ravi: I will fix it by Friday" -> {"task":"Fix the login bug","owner":"Ravi","due":"<that Friday>","quote":"I will fix it by Friday"}`,
    `Attendees: ${attendees.join(", ")}\nALREADY_OPEN: ${JSON.stringify(alreadyOpen)}\n\nTRANSCRIPT:\n${transcript}`
  );
  return r.actions || [];
}

// 4. FOLLOW-UP AGENT (per owner)
export const draftReminder = (owner, items, title, date, from) =>
  chat(
    `You write short, friendly, professional reminder emails (subject line first, max 150 words). Write PLAIN TEXT only: no markdown, no asterisks, no bold. Never use placeholders like [Your Name]; sign off with exactly "${sender(from)}". List each task with due date and link if present. For items with slips >= 2, politely but clearly say it has been carried over multiple meetings and ask for a status or a re-plan.`,
    `Meeting: ${title} (${date})\nRecipient: ${owner}\nItems: ${JSON.stringify(items)}`,
    false
  );

// 4b. FOLLOW-UP AGENT (whole-team recap)
export const draftTeamRecap = (title, date, minutes, unowned, unresolved, from) =>
  chat(
    `You write a short professional recap email to the whole team (subject line first, max 180 words). Write PLAIN TEXT only: no markdown, no asterisks, no bold. Never use placeholders like [Your Name]; sign off with exactly "${sender(from)}". Include: a 2-sentence summary, the decisions made (if any), and clearly call out (a) action items that still have NO owner and (b) decisions that are still unresolved, asking for volunteers or a decision date. Skip a section if it is empty.`,
    `Meeting: ${title} (${date})\nSummary: ${minutes.summary}\nDecisions: ${JSON.stringify(minutes.decisions)}\nUnowned action items: ${JSON.stringify(unowned)}\nUnresolved decisions: ${JSON.stringify(unresolved)}`,
    false
  );

// 5. PROGRESS TRACKER (cross-meeting)
export async function trackProgress(transcript, openItems, date) {
  if (!openItems.length) return [];
  const r = await chat(
    `Given open action items from PREVIOUS meetings and a new transcript, decide what happened to each. Return JSON: {"updates": [{"ref": int, "status": "done"|"still_open"|"postponed"|"not_mentioned", "new_due": "YYYY-MM-DD"|null, "evidence": str}]}. Use "done" only if someone clearly says it is finished. "postponed" = deadline pushed or deprioritized.`,
    `Meeting date: ${date}\nOPEN_ITEMS: ${JSON.stringify(openItems)}\n\nTRANSCRIPT:\n${transcript}`
  );
  return r.updates || [];
}

// 6. DECISION AUDITOR
export async function auditDecisions(transcript, openTopics) {
  const r = await chat(
    `Find topics discussed but left UNRESOLVED: no decision, no owner, "let's circle back", "who owns this?", disagreement with no outcome. Return JSON: {"resolvedRefs": [int], "unresolved": [{"topic": str, "why": str, "matchesRef": int|null}]}. OPEN_TOPICS are unresolved topics from earlier meetings: put their ref in resolvedRefs if this meeting settled them; if raised again and still unsettled, return it with matchesRef set.`,
    `OPEN_TOPICS: ${JSON.stringify(openTopics)}\n\nTRANSCRIPT:\n${transcript}`
  );
  return { resolvedRefs: r.resolvedRefs || [], unresolved: r.unresolved || [] };
}
