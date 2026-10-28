// Auto-create tasks in GitHub Issues or Trello (both free).
const backend = () => process.env.TASK_BACKEND || "none";

export async function createTask(a, meetingTitle) {
  const body = `**From meeting:** ${meetingTitle}\n**Owner:** ${a.owner || "UNASSIGNED"}\n**Due:** ${a.due || "not set"}\n\n> ${a.quote || ""}`;
  try {
    if (backend() === "github") {
      const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/issues`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: a.task, body }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message);
      return { extId: String(j.number), extUrl: j.html_url };
    }
    if (backend() === "trello") {
      const p = new URLSearchParams({
        key: process.env.TRELLO_KEY, token: process.env.TRELLO_TOKEN,
        idList: process.env.TRELLO_LIST_ID, name: a.task, desc: body,
        ...(a.due ? { due: a.due } : {}),
      });
      const r = await fetch(`https://api.trello.com/1/cards?${p}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(j));
      return { extId: j.id, extUrl: j.shortUrl };
    }
  } catch (e) {
    console.error("createTask failed:", e.message);
  }
  return {};
}

// Comment on the existing task when it slips again.
export async function flagSlip(extId, message) {
  if (!extId) return;
  try {
    if (backend() === "github") {
      await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/issues/${extId}/comments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ body: message }),
      });
    } else if (backend() === "trello") {
      const p = new URLSearchParams({ key: process.env.TRELLO_KEY, token: process.env.TRELLO_TOKEN, text: message });
      await fetch(`https://api.trello.com/1/cards/${extId}/actions/comments?${p}`, { method: "POST" });
    }
  } catch (e) {
    console.error("flagSlip failed:", e.message);
  }
}

// Keep GitHub/Trello in sync when the admin marks a task done (or reopens it).
export async function closeTask(extId, done = true) {
  if (!extId) return;
  try {
    if (backend() === "github") {
      await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/issues/${extId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: done ? "closed" : "open" }),
      });
    } else if (backend() === "trello") {
      const p = new URLSearchParams({ key: process.env.TRELLO_KEY, token: process.env.TRELLO_TOKEN, dueComplete: String(done) });
      await fetch(`https://api.trello.com/1/cards/${extId}?${p}`, { method: "PUT" });
    }
  } catch (e) {
    console.error("closeTask failed:", e.message);
  }
}
