import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import mongoose from "mongoose";
import { Meeting, Action, Topic, Contact } from "./models.js";
import { runPipeline } from "./pipeline.js";
import { auth, requireAuth, wrap } from "./auth.js";
import { sendEmail, emailsFor, mailMode, splitNames } from "./mailer.js";
import { closeTask } from "./integrations.js";
import { startScheduler, runDailyReminders } from "./scheduler.js";

if (!process.env.JWT_SECRET) throw new Error("Missing JWT_SECRET in server/.env");

fs.mkdirSync("uploads", { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: "uploads",
    filename: (_req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(audio|video)\//.test(file.mimetype) ||
      /\.(mp3|wav|m4a|ogg|flac|aac|mp4|mov|mkv|webm|avi)$/i.test(file.originalname);
    const err = new Error("Please upload an audio or video file");
    err.status = 400;
    cb(ok ? null : err, ok);
  },
});

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", auth);
app.use("/api", requireAuth); // everything below needs a logged-in admin

app.get("/api/status", (_req, res) => res.json({ mail: mailMode() }));

// ---- meetings
app.post("/api/meetings", upload.single("audio"), wrap(async (req, res) => {
  try {
    const { title, date, attendees = "", transcriptText, autoSend } = req.body;
    if (!req.file && !transcriptText) return res.status(400).json({ error: "Provide audio/video or a transcript" });
    const meeting = await runPipeline({
      admin: req.user,
      title,
      date: date || new Date().toISOString().slice(0, 10),
      attendees: attendees.split(",").map((s) => s.trim()).filter(Boolean),
      audioPath: req.file?.path,
      transcriptText,
      autoSend: autoSend !== "false",
    });
    res.json(meeting);
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
}));

app.get("/api/meetings", wrap(async (req, res) =>
  res.json(await Meeting.find({ admin: req.user._id }).select("-transcript").sort({ date: -1, createdAt: -1 }))));

app.get("/api/meetings/:id", wrap(async (req, res) => {
  const meeting = await Meeting.findOne({ _id: req.params.id, admin: req.user._id });
  if (!meeting) return res.status(404).json({ error: "Not found" });
  res.json({ meeting, actions: await Action.find({ meeting: meeting._id }) });
}));

// send or resend one email of a meeting
app.post("/api/meetings/:id/emails/:idx/send", wrap(async (req, res) => {
  const meeting = await Meeting.findOne({ _id: req.params.id, admin: req.user._id });
  const e = meeting?.emails[Number(req.params.idx)];
  if (!e) return res.status(404).json({ error: "Email not found" });
  // look the addresses up again: contacts may have been added or fixed since
  const names = (e.names?.length ? e.names : [e.to]).flatMap(splitNames);
  e.toEmails = await emailsFor(req.user._id, names);
  const result = await sendEmail(e, req.user.email);
  if (result.status === "no_email")
    result.error = `No email address found for: ${names.join(", ")}. Add each person on the Team tab (the name must match).`;
  e.set(result);
  meeting.markModified("emails");
  await meeting.save();
  console.log(`[mail] "${e.subject}" -> ${e.toEmails.join(", ") || "nobody"}: ${result.status} ${result.error || ""}`);
  res.json(meeting);
}));

// ---- dashboard
app.get("/api/report", wrap(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const q = { admin: req.user._id };
  const [slipping, unowned, unresolved, completedActions, resolvedTopics] = await Promise.all([
    Action.find({ ...q, status: "open", $or: [{ slips: { $gte: 2 } }, { due: { $lt: today, $ne: null } }] }).sort({ slips: -1 }),
    Action.find({ ...q, status: "open", $or: [{ owner: null }, { owner: "" }] }),
    Topic.find({ ...q, resolved: false }).sort({ raised: -1 }),
    Action.find({ ...q, status: "done" }).sort({ doneAt: -1 }).limit(50),
    Topic.find({ ...q, resolved: true }).sort({ resolvedAt: -1 }).limit(50),
  ]);
  res.json({ slipping, unowned, unresolved, completedActions, resolvedTopics });
}));

// ---- mark done / resolved (stores who + when)
app.patch("/api/actions/:id", wrap(async (req, res) => {
  const a = await Action.findOne({ _id: req.params.id, admin: req.user._id });
  if (!a) return res.status(404).json({ error: "Not found" });
  if (req.body.status === "done") {
    a.status = "done"; a.doneAt = new Date(); a.doneBy = req.user.name;
    await closeTask(a.extId, true);
  } else {
    a.status = "open"; a.doneAt = null; a.doneBy = null;
    await closeTask(a.extId, false);
  }
  await a.save();
  res.json(a);
}));

app.patch("/api/topics/:id/resolve", wrap(async (req, res) => {
  const t = await Topic.findOneAndUpdate(
    { _id: req.params.id, admin: req.user._id },
    { resolved: true, resolvedAt: new Date(), resolvedBy: req.user.name, resolution: (req.body.resolution || "").trim() },
    { new: true });
  if (!t) return res.status(404).json({ error: "Not found" });
  res.json(t);
}));

app.patch("/api/topics/:id/reopen", wrap(async (req, res) => {
  const t = await Topic.findOneAndUpdate(
    { _id: req.params.id, admin: req.user._id },
    { resolved: false, resolvedAt: null, resolvedBy: null, resolution: "" },
    { new: true });
  if (!t) return res.status(404).json({ error: "Not found" });
  res.json(t);
}));

// ---- team contacts (name -> email)
app.get("/api/contacts", wrap(async (req, res) =>
  res.json(await Contact.find({ admin: req.user._id }).sort({ name: 1 }))));

app.post("/api/contacts", wrap(async (req, res) => {
  const { name, email } = req.body;
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || "")) return res.status(400).json({ error: "Enter a name and a valid email" });
  res.json(await Contact.create({ admin: req.user._id, name: name.trim(), email: email.trim().toLowerCase() }));
}));

app.delete("/api/contacts/:id", wrap(async (req, res) => {
  await Contact.deleteOne({ _id: req.params.id, admin: req.user._id });
  res.json({ ok: true });
}));

// ---- reminders for overdue / slipping tasks (also runs daily if DAILY_REMINDERS=true)
app.post("/api/reminders/run", wrap(async (req, res) => res.json(await runDailyReminders(req.user._id))));

// DEV ONLY: wipe this admin's meetings, tasks and decisions (contacts are kept)
if (process.env.NODE_ENV !== "production") {
  app.delete("/api/dev/reset", wrap(async (req, res) => {
    const q = { admin: req.user._id };
    await Promise.all([Meeting.deleteMany(q), Action.deleteMany(q), Topic.deleteMany(q)]);
    res.json({ ok: true });
  }));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || (["MulterError", "CastError"].includes(err.name) ? 400 : 500);
  res.status(status).json({ error: err.message });
});

await mongoose.connect(process.env.MONGO_URI);
startScheduler();
app.listen(process.env.PORT || 5000, () => console.log("API on :" + (process.env.PORT || 5000)));
