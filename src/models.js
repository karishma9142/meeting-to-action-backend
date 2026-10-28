import mongoose from "mongoose";
const { Schema, model } = mongoose;
const ref = (m) => ({ type: Schema.Types.ObjectId, ref: m, index: true });

export const User = model("User", new Schema({
  name: String,
  email: { type: String, unique: true, lowercase: true, trim: true },
  passwordHash: String,
  role: { type: String, default: "admin" },
}, { timestamps: true }));

// Team members: name -> email, used to send emails automatically
export const Contact = model("Contact", new Schema({
  admin: ref("User"),
  name: String,
  email: String,
}, { timestamps: true }));

export const Meeting = model("Meeting", new Schema({
  admin: ref("User"),
  title: String,
  date: String, // YYYY-MM-DD
  attendees: [String],
  transcript: String,
  minutes: {
    summary: String,
    discussionPoints: [String],
    decisions: [{ decision: String, owner: String }],
  },
  emails: [{
    to: String,            // label shown in the UI
    names: [String],       // names used to look up addresses
    toEmails: [String],
    subject: String,
    body: String,
    status: { type: String, default: "draft" }, // draft | sent | failed | no_email
    error: String,
    sentAt: Date,
    previewUrl: String,
  }],
}, { timestamps: true }));

export const Action = model("Action", new Schema({
  admin: ref("User"),
  meeting: { type: Schema.Types.ObjectId, ref: "Meeting" },
  task: String,
  owner: { type: String, default: null },
  due: { type: String, default: null },
  quote: String,
  status: { type: String, enum: ["open", "done"], default: "open" },
  slips: { type: Number, default: 0 },
  extId: String,
  extUrl: String,
  doneAt: Date,
  doneBy: String,
}, { timestamps: true }));

export const Topic = model("Topic", new Schema({
  admin: ref("User"),
  meeting: { type: Schema.Types.ObjectId, ref: "Meeting" },
  topic: String,
  why: String,
  resolved: { type: Boolean, default: false },
  raised: { type: Number, default: 1 },
  resolvedAt: Date,
  resolvedBy: String,
  resolution: String,
}, { timestamps: true }));
