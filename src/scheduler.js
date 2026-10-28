import cron from "node-cron";
import { User, Action, Contact } from "./models.js";
import { sendEmail } from "./mailer.js";

export function startScheduler() {
  if (process.env.DAILY_REMINDERS !== "true") return;
  cron.schedule(process.env.REMINDER_CRON || "0 9 * * *", () => runDailyReminders());
  console.log("Daily reminders enabled");
}

// Emails each owner their overdue or repeatedly slipping tasks.
export async function runDailyReminders(onlyAdminId) {
  const today = new Date().toISOString().slice(0, 10);
  let sent = 0, skipped = 0;
  const admins = onlyAdminId ? await User.find({ _id: onlyAdminId }) : await User.find();
  for (const admin of admins) {
    const contacts = await Contact.find({ admin: admin._id });
    const actions = await Action.find({
      admin: admin._id, status: "open", owner: { $nin: [null, ""] },
      $or: [{ due: { $lt: today, $ne: null } }, { slips: { $gte: 2 } }],
    });
    const byOwner = {};
    for (const a of actions) (byOwner[a.owner] ||= []).push(a);
    for (const [owner, items] of Object.entries(byOwner)) {
      const c = contacts.find((x) => x.name.trim().toLowerCase() === owner.trim().toLowerCase());
      if (!c) { skipped++; continue; }
      const lines = items.map((a) =>
        `- ${a.task} (due ${a.due || "not set"}${a.slips ? `, slipped ${a.slips}x` : ""})${a.extUrl ? " " + a.extUrl : ""}`);
      const r = await sendEmail({
        toEmails: [c.email],
        subject: `Reminder: ${items.length} task(s) need attention`,
        body: `Hi ${owner},\n\nThese tasks are overdue or have slipped several times:\n\n${lines.join("\n")}\n\nPlease update their status or reply with a new date.\n\n${admin.name}`,
      }, admin.email);
      r.status === "sent" ? sent++ : skipped++;
    }
  }
  return { sent, skipped };
}
