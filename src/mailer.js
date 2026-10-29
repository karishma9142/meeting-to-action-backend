import nodemailer from "nodemailer";
import { Contact } from "./models.js";

let transporter;

// "smtp" = real sending, "test" = fake inbox with preview links, "off" = drafts only
export const mailMode = () =>
  process.env.BREVO_API_KEY ? "brevo" : process.env.SMTP_HOST ? "smtp" : process.env.MAIL_MODE === "test" ? "test" : "off";

async function getTransporter() {
  if (transporter) return transporter;
  const mode = mailMode();
  if (mode === "smtp") {
    const port = Number(process.env.SMTP_PORT || 465);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465, connectionTimeout: 10000, greetingTimeout: 10000,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } else if (mode === "test") {
    const acc = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: acc.smtp.host, port: acc.smtp.port, secure: acc.smtp.secure,
      auth: { user: acc.user, pass: acc.pass },
    });
  }
  return transporter;
}

// "Subject: ..." first line -> { subject, body }
export function splitSubject(text) {
  const m = text.match(/^\s*subject:\s*(.+)\n+/i);
  return m
    ? { subject: m[1].trim(), body: text.slice(m[0].length).trim() }
    : { subject: "Meeting follow-up", body: text.trim() };
}

// "Asha, Ravi" / "Asha and Ravi" / "Asha & Ravi" -> ["Asha", "Ravi"]
export const splitNames = (n) =>
  String(n || "").split(/\s*(?:,|&|\/|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);

// names -> email addresses from the admin's Team list
export async function emailsFor(adminId, names) {
  const contacts = await Contact.find({ admin: adminId });
  const map = new Map(contacts.map((c) => [c.name.trim().toLowerCase(), c.email]));
  return [...new Set((names || []).flatMap(splitNames).map((n) => map.get(n.toLowerCase())).filter(Boolean))];
}

// returns fields to store on the email: status, error, sentAt, previewUrl
export async function sendEmail(email, replyTo) {
  if (!email.toEmails?.length)
    return { status: "no_email", error: "No email address on file. Add it on the Team tab." };
  if (mailMode() === "brevo") {
    try {
      if (!process.env.MAIL_FROM) return { status: "failed", error: "Set MAIL_FROM to your verified Brevo sender email" };
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { name: process.env.MAIL_FROM_NAME || "Meeting Assistant", email: process.env.MAIL_FROM },
          to: email.toEmails.map((e) => ({ email: e })),
          ...(replyTo ? { replyTo: { email: replyTo } } : {}),
          subject: email.subject,
          textContent: email.body,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || `Brevo error ${r.status}`);
      return { status: "sent", error: "", sentAt: new Date(), previewUrl: "" };
    } catch (e) {
      return { status: "failed", error: e.message };
    }
  }

  const t = await getTransporter();
  if (!t) return { status: "draft", error: "Email is not configured. Set SMTP_* or MAIL_MODE=test in server/.env" };
  try {
    const info = await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER || "meeting-assistant@example.com",
      to: email.toEmails.join(", "),
      replyTo,
      subject: email.subject,
      text: email.body,
    });
    return { status: "sent", error: "", sentAt: new Date(), previewUrl: nodemailer.getTestMessageUrl(info) || "" };
  } catch (e) {
    return { status: "failed", error: e.message };
  }
}
