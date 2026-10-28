import fs from "fs";
import * as agents from "./agents.js";
import { prepareAudio } from "./media.js";
import { createTask, flagSlip, closeTask } from "./integrations.js";
import { Meeting, Action, Topic } from "./models.js";
import { splitSubject, emailsFor, sendEmail } from "./mailer.js";

export async function runPipeline({ admin, title, date, attendees, audioPath, transcriptText, autoSend = true }) {
  const adminId = admin._id;

  // 1. transcribe (audio or video)
  let transcript = transcriptText?.trim();
  if (!transcript) {
    const prep = await prepareAudio(audioPath);
    try {
      transcript = await agents.transcribe(prep.path);
    } finally {
      if (prep.temp) fs.unlink(prep.path, () => {});
    }
  }

  // 2. minutes
  const m = await agents.summarize(transcript, date, attendees);
  const meetingTitle = title || m.title || "Meeting";
  const meeting = await Meeting.create({
    admin: adminId, title: meetingTitle, date, attendees, transcript,
    minutes: {
      summary: m.summary,
      discussionPoints: (m.discussionPoints || []).filter((p) => p && p.trim()),
      decisions: (m.decisions || []).filter((d) => d && d.decision && d.decision.trim()),
    },
  });

  // 3. progress on earlier open items (cross-meeting tracking)
  const open = await Action.find({ admin: adminId, status: "open" });
  const openForLLM = open.map((a, ref) => ({ ref, task: a.task, owner: a.owner, due: a.due, slips: a.slips }));
  const updates = await agents.trackProgress(transcript, openForLLM, date);
  for (const u of updates) {
    const a = open[u.ref];
    if (!a) continue;
    const overdue = !!a.due && a.due < date;
    if (u.status === "done") {
      a.status = "done";
      a.doneAt = new Date();
      a.doneBy = `Auto-detected in "${meetingTitle}"`;
      await closeTask(a.extId, true);
    } else if (u.status === "postponed" || (overdue && ["still_open", "not_mentioned"].includes(u.status))) {
      a.slips += 1;
      if (u.new_due) a.due = u.new_due;
      await flagSlip(a.extId, `⚠️ Slipped again in "${meetingTitle}" (${date}). Total slips: ${a.slips}. Due: ${a.due || "not set"}`);
    }
    await a.save();
  }

  // 4. unresolved decisions
  const openTopics = await Topic.find({ admin: adminId, resolved: false });
  const topicsForLLM = openTopics.map((t, ref) => ({ ref, topic: t.topic, raised: t.raised }));
  const audit = await agents.auditDecisions(transcript, topicsForLLM);
  for (const ref of audit.resolvedRefs) {
    if (openTopics[ref])
      await Topic.updateOne({ _id: openTopics[ref]._id },
        { resolved: true, resolvedAt: new Date(), resolvedBy: `Auto-detected in "${meetingTitle}"` });
  }
  for (const u of audit.unresolved) {
    const match = u.matchesRef != null ? openTopics[u.matchesRef] : null;
    if (match) await Topic.updateOne({ _id: match._id }, { $inc: { raised: 1 } });
    else await Topic.create({ admin: adminId, meeting: meeting._id, topic: u.topic, why: u.why });
  }

  // 5. new action items -> DB + Trello/GitHub
  const fresh = await agents.extractActions(transcript, date, attendees, openForLLM);
  for (const item of fresh) {
    const ext = await createTask(item, meetingTitle);
    await Action.create({
      admin: adminId, meeting: meeting._id,
      task: item.task, owner: item.owner || null, due: item.due || null, quote: item.quote, ...ext,
    });
  }

  // 6. emails: one per owner + one recap for the whole team
  const relevant = await Action.find({ admin: adminId, status: "open" });
  const byOwner = {};
  for (const a of relevant) {
    if (!a.owner) continue;
    (byOwner[a.owner] ||= []).push({ task: a.task, due: a.due, slips: a.slips, link: a.extUrl });
  }
  const emails = [];
  for (const [owner, items] of Object.entries(byOwner)) {
    const mail = splitSubject(await agents.draftReminder(owner, items, meetingTitle, date, admin.name));
    emails.push({ to: owner, names: [owner], toEmails: await emailsFor(adminId, [owner]), ...mail });
  }

  const unowned = (await Action.find({ admin: adminId, status: "open", $or: [{ owner: null }, { owner: "" }] }))
    .map((a) => ({ task: a.task, due: a.due }));
  const unresolved = (await Topic.find({ admin: adminId, resolved: false }))
    .map((t) => ({ topic: t.topic, why: t.why, raised: t.raised }));
  const recap = splitSubject(await agents.draftTeamRecap(meetingTitle, date, m, unowned, unresolved, admin.name));
  emails.push({
    to: `Whole team (${attendees.join(", ") || "no attendees listed"})`,
    names: attendees, toEmails: await emailsFor(adminId, attendees), ...recap,
  });

  for (const e of emails) e.status = e.toEmails.length ? "draft" : "no_email";
  meeting.emails = emails;
  await meeting.save();

  // 7. send automatically
  if (autoSend) {
    for (const e of meeting.emails) {
      if (e.toEmails.length) e.set(await sendEmail(e, admin.email));
    }
    await meeting.save();
  }
  return meeting;
}
