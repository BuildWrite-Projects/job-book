// Job Book connector — lets Claude (on the phone, in CarPlay, anywhere) work
// the Job Book by voice.
//
// It is a small MCP server (the protocol Claude connectors speak). It can only
// do what the in-app Ask Claude button does: read what's open, add an item,
// check one off, flag an item urgent or waiting, and add a job. It cannot
// delete anything, touch other tables, or change the database itself.
//
// Access: the connector's address ends in a long secret key. Only the key's
// SHA-256 fingerprint is stored here; a request without the matching key gets
// a 404 and learns nothing.
//
// Records are written in exactly the shape the app writes them, so a note
// added by voice looks and behaves like one typed on the phone, and shows up
// on the phone straight away through live sync.

import { createClient } from "npm:@supabase/supabase-js@2.117.0";

const KEY_SHA256 = "d36227d9307ab603c7a531d5ad92d4f714509b3e60cfdf8da59cee61ab487828";
// Items checked off by voice are marked done by this person (Stephen).
const DONE_BY = "5a69e9d4-0c4e-49bd-aaf1-b3b28d493c82";

function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (keys.default) return keys.default;
  } catch (_) { /* fall through */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- the book --------------------------------------------------------

type Rec = Record<string, any>;
type Row = { id: string; data: Rec };

async function all(table: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select("id,data").order("id").range(from, from + 999);
    if (error) throw new Error("Couldn't read the job book: " + error.message);
    out.push(...(data as Row[]));
    if (!data || data.length < 1000) return out;
  }
}

async function loadBook() {
  const [books, jobs, notes] = await Promise.all([all("jobbook_books"), all("jobbook_jobs"), all("jobbook_notes")]);
  books.sort((a, b) => String(a.data.createdAt ?? "").localeCompare(String(b.data.createdAt ?? "")));
  const defaultBook = books[0]?.id ?? "";
  const bookOf = (j: Row) => j.data.bookId || defaultBook;
  const live = jobs.filter((j) => !j.data.archived);
  return { books, jobs: live, notes, bookOf, defaultBook };
}

function headLine(text: string): string {
  for (const l of String(text ?? "").split("\n")) {
    const t = l.trim();
    if (t) return t.replace(/^•\s*/, "");
  }
  return "";
}

// Same order the app uses: urgent first, waiting last, otherwise oldest first.
function byHeat(a: Rec, b: Rec): number {
  const wa = !a.done && a.waiting ? 1 : 0, wb = !b.done && b.waiting ? 1 : 0;
  if (wa !== wb) return wa - wb;
  const ua = !a.done && !a.waiting && a.urgent ? 0 : 1, ub = !b.done && !b.waiting && b.urgent ? 0 : 1;
  if (ua !== ub) return ua - ub;
  return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
}

const PERMITS = [
  ["zoning", "Zoning"], ["esa", "ESA"], ["driveway", "Driveway"], ["flood", "Flood"], ["building", "Building"],
  ["electrical", "Electrical"], ["plumbing", "Plumbing"], ["mechanical", "Mechanical"], ["gas", "Gas"], ["final", "Final/CO"],
];

// ---------- matching what was said to what's in the book --------------------
// Speech comes through rough ("Kaiser" for Kiser, "Poplin full check"), so
// matching tries exact, then contains, then close spelling, word by word.

function norm(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function wordClose(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  return lev(a, b) <= (Math.max(a.length, b.length) >= 6 ? 2 : 1);
}
// How well what was said matches a name: 0 = no match, higher = better.
function score(said: string, name: string): number {
  const s = norm(said), n = norm(name);
  if (!s) return 0;
  if (s === n) return 100;
  if (n.includes(s) || s.includes(n)) return 80;
  const sw = s.split(" "), nw = n.split(" ");
  const hits = sw.filter((w) => nw.some((x) => wordClose(w, x))).length;
  if (!hits) return 0;
  return 40 + Math.round(40 * hits / sw.length);
}

function pickJob(book: Awaited<ReturnType<typeof loadBook>>, said: string): Row {
  const scored = book.jobs.map((j) => ({ j, s: score(said, j.data.name) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const names = () => book.jobs.map((j) => j.data.name).join(", ");
  if (!scored.length) throw new Error(`No job matches "${said}". Jobs in the book: ${names()}. Ask which one he means.`);
  const top = scored.filter((x) => x.s === scored[0].s);
  if (top.length > 1) {
    throw new Error(`More than one job matches "${said}": ${top.map((x) => x.j.data.name).join(", ")}. Ask which one.`);
  }
  if (scored[0].s < 60 && scored.length > 1) {
    throw new Error(`Not sure which job "${said}" is. Closest: ${scored.slice(0, 3).map((x) => x.j.data.name).join(", ")}. Ask which one.`);
  }
  return scored[0].j;
}

function pickItem(book: Awaited<ReturnType<typeof loadBook>>, job: Row, said: string): Row {
  const open = book.notes.filter((n) => n.data.jobId === job.id && !n.data.done);
  if (!open.length) throw new Error(`Nothing is open on ${job.data.name}.`);
  const want = norm(said);
  let hits = open.filter((n) => norm(n.data.text).includes(want));
  if (!hits.length) {
    const scored = open.map((n) => ({ n, s: score(said, n.data.text) })).filter((x) => x.s >= 60).sort((a, b) => b.s - a.s);
    hits = scored.filter((x) => x.s === scored[0]?.s).map((x) => x.n);
  }
  const list = () => open.map((n) => headLine(n.data.text)).join(" / ");
  if (!hits.length) throw new Error(`Nothing open on ${job.data.name} matches "${said}". Open items: ${list()}.`);
  if (hits.length > 1) throw new Error(`Several items on ${job.data.name} match: ${hits.map((n) => headLine(n.data.text)).join(" / ")}. Ask which one.`);
  return hits[0];
}

async function patch(collection: string, id: string, p: Rec) {
  const { error } = await db.rpc("jobbook_patch", { p_collection: collection, p_id: id, p_patch: p });
  if (error) throw new Error("That didn't save: " + error.message);
}

// ---------- the tools -------------------------------------------------------

const TOOLS = [
  {
    name: "list_open",
    description:
      "Read the job book: what's open on each job. Give a job to get that job's open items in full (with their detail " +
      "bullets, status and permits); leave it out to get every active job across all books with its open items. " +
      "Use this to answer 'what's open', 'what's next on X', or to find the exact job or item name before changing something.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "Optional. The job, as he said it." },
        book: { type: "string", description: "Optional. Limit to one book: Roberts & Associates, BuildWrite Projects or Personal." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_note",
    description:
      "Add an item to a job. Keep 'text' one short, actionable line; put any detail he gives in 'detail' as separate " +
      "bullets. Set urgent only if he says urgent, hot, ASAP, today, or that it's holding up the job. Set waiting " +
      "instead if it's on somebody else and he can't move it himself ('waiting on Brian', 'once the inspector signs off'). " +
      "Never both. Confirm in one short sentence, naming the job.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "The job, as he said it. Close spellings are matched." },
        text: { type: "string", description: "The item, one short actionable line." },
        detail: { type: "array", items: { type: "string" }, description: "Optional detail lines, shown as bullets under the item." },
        urgent: { type: "boolean" },
        waiting: { type: "boolean" },
      },
      required: ["job", "text"],
    },
  },
  {
    name: "complete_note",
    description: "Check off an open item on a job. Give the job and enough of the item's wording to identify it.",
    inputSchema: {
      type: "object",
      properties: { job: { type: "string" }, text: { type: "string", description: "Words from the item." } },
      required: ["job", "text"],
    },
  },
  {
    name: "flag_urgent",
    description: "Mark an open item urgent (it moves to the top, in red), or clear the flag with urgent=false.",
    inputSchema: {
      type: "object",
      properties: { job: { type: "string" }, text: { type: "string" }, urgent: { type: "boolean", description: "Defaults to true." } },
      required: ["job", "text"],
    },
  },
  {
    name: "flag_waiting",
    description:
      "Mark an open item as waiting on somebody else (it sinks to the bottom and stops counting as open work), " +
      "or clear it with waiting=false when he says he got what he was waiting on.",
    inputSchema: {
      type: "object",
      properties: { job: { type: "string" }, text: { type: "string" }, waiting: { type: "boolean", description: "Defaults to true." } },
      required: ["job", "text"],
    },
  },
  {
    name: "add_job",
    description:
      "Create a new job. Only when he asks for a new job, never to make a note fit. Goes in Roberts & Associates " +
      "unless he names another book.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        book: { type: "string", description: "Optional: Roberts & Associates, BuildWrite Projects or Personal." },
      },
      required: ["name"],
    },
  },
];

function pickBook(book: Awaited<ReturnType<typeof loadBook>>, said?: string): Row | null {
  if (!said) return null;
  const scored = book.books.map((b) => ({ b, s: score(said, b.data.name) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length) throw new Error(`No book called "${said}". Books: ${book.books.map((b) => b.data.name).join(", ")}.`);
  return scored[0].b;
}

function describeJob(book: Awaited<ReturnType<typeof loadBook>>, j: Row, full: boolean): string {
  const open = book.notes.filter((n) => n.data.jobId === j.id && !n.data.done).map((n) => n.data).sort(byHeat);
  const status = j.data.status ? ` [${j.data.status}]` : "";
  const lines = [`JOB: ${j.data.name}${status}`];
  if (full) {
    const p = j.data.permits || {};
    if (j.data.status === "contracted" || j.data.status === "active" || Object.values(p).some((v) => v)) {
      const done = PERMITS.filter(([id]) => p[id] === "done").map(([, l]) => l);
      const na = PERMITS.filter(([id]) => p[id] === "na").map(([, l]) => l);
      const left = PERMITS.filter(([id]) => !p[id]).map(([, l]) => l);
      lines.push(`  Permits: done ${done.join(", ") || "none"}; n/a ${na.join(", ") || "none"}; still open ${left.join(", ") || "none"}`);
    }
  }
  if (!open.length) lines.push("  (nothing open)");
  for (const n of open.slice(0, full ? 50 : 12)) {
    const flag = n.waiting ? "[WAITING] " : n.urgent ? "[URGENT] " : "";
    const text = String(n.text ?? "");
    if (full) {
      const [first, ...rest] = text.split("\n").map((l) => l.trim()).filter(Boolean);
      lines.push(`  - ${flag}${(first ?? "").replace(/^•\s*/, "")}`);
      for (const r of rest) lines.push(`      • ${r.replace(/^•\s*/, "")}`);
    } else {
      lines.push(`  - ${flag}${headLine(text)}`);
    }
  }
  return lines.join("\n");
}

async function callTool(name: string, a: Rec): Promise<string> {
  const book = await loadBook();
  const s = (v: unknown) => String(v ?? "").trim();

  if (name === "list_open") {
    if (s(a.job)) return describeJob(book, pickJob(book, s(a.job)), true);
    const only = pickBook(book, s(a.book) || undefined);
    const out: string[] = [];
    for (const b of book.books) {
      if (only && b.id !== only.id) continue;
      const jobs = book.jobs.filter((j) => book.bookOf(j) === b.id)
        .sort((x, y) => String(x.data.createdAt ?? "").localeCompare(String(y.data.createdAt ?? "")));
      out.push(`=== ${b.data.name} ===`);
      if (!jobs.length) out.push("(no jobs)");
      for (const j of jobs) out.push(describeJob(book, j, false));
      out.push("");
    }
    return out.join("\n").trim();
  }

  if (name === "add_note") {
    const job = pickJob(book, s(a.job));
    let body = s(a.text);
    if (!body) throw new Error("No item text given.");
    for (const d of Array.isArray(a.detail) ? a.detail : []) if (s(d)) body += "\n• " + s(d);
    const waiting = !!a.waiting, urgent = !!a.urgent && !waiting;
    const { error } = await db.from("jobbook_notes").insert({
      id: crypto.randomUUID(),
      data: {
        jobId: job.id, text: body, done: false, urgent, waiting, createdAt: new Date().toISOString(),
        assignedTo: "", doneBy: "", doneAt: "", scheduledAt: "",
      },
    });
    if (error) throw new Error("That didn't save: " + error.message);
    return `Added to ${job.data.name}${waiting ? " (waiting)" : urgent ? " (urgent)" : ""}: ${headLine(body)}`;
  }

  if (name === "complete_note") {
    const job = pickJob(book, s(a.job));
    const n = pickItem(book, job, s(a.text));
    await patch("notes", n.id, { done: true, doneBy: DONE_BY, doneAt: new Date().toISOString() });
    return `Checked off on ${job.data.name}: ${headLine(n.data.text)}`;
  }

  if (name === "flag_urgent" || name === "flag_waiting") {
    const job = pickJob(book, s(a.job));
    const n = pickItem(book, job, s(a.text));
    const key = name === "flag_urgent" ? "urgent" : "waiting";
    const on = a[key] === false ? false : true;
    await patch("notes", n.id, { [key]: on });
    return `${on ? "Flagged" : "Cleared"} ${key} on ${job.data.name}: ${headLine(n.data.text)}`;
  }

  if (name === "add_job") {
    const nm = s(a.name);
    if (!nm) throw new Error("No job name given.");
    const b = pickBook(book, s(a.book) || undefined);
    const bookId = b ? b.id : book.defaultBook;
    const dup = book.jobs.find((j) => norm(j.data.name) === norm(nm));
    if (dup) throw new Error(`There's already a job called ${dup.data.name}. Ask if he meant that one.`);
    const { error } = await db.from("jobbook_jobs").insert({
      id: crypto.randomUUID(),
      data: { name: nm, archived: false, createdAt: new Date().toISOString(), bookId, status: "", waiting: false, permits: {} },
    });
    if (error) throw new Error("That didn't save: " + error.message);
    const bn = book.books.find((x) => x.id === bookId)?.data.name ?? "the job book";
    return `Created job ${nm} in ${bn}.`;
  }

  throw new Error("Unknown tool: " + name);
}

// ---------- MCP over HTTP ---------------------------------------------------

const INSTRUCTIONS =
  "This is Stephen's Job Book: running to-do lists for each construction job (Roberts & Associates), BuildWrite " +
  "Projects and personal items. He's often driving and dictating, so read through rough speech and odd spellings. " +
  "Match the job he names to the closest one; if two could fit, ask rather than guess. Don't create a job unless he " +
  "asks. After a change, confirm in one short sentence. Answer questions about what's open from list_open, briefly. " +
  "Never invent jobs, items or dates.";

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function reply(id: unknown, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function fail(id: unknown, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handle(msg: Rec): Promise<Rec | null> {
  const id = msg.id;
  const isNote = id === undefined || id === null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "job-book", title: "Job Book", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping": return reply(id, {});
    case "tools/list": return reply(id, { tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, "Unknown tool: " + name);
      try {
        const text = await callTool(name, msg.params?.arguments ?? {});
        return reply(id, { content: [{ type: "text", text }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    case "resources/list": return reply(id, { resources: [] });
    case "prompts/list": return reply(id, { prompts: [] });
    default:
      if (isNote) return null; // notifications (e.g. notifications/initialized) need no answer
      return fail(id, -32601, "Method not found: " + msg.method);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, authorization, accept",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // The key is the last part of the address: .../functions/v1/jobbook-mcp/<key>
  // (or ?key=<key>). Wrong or missing key: a plain 404, nothing else.
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || url.pathname.split("/").filter(Boolean).pop() || "";
  if ((await sha256hex(key)) !== KEY_SHA256) return new Response("Not found", { status: 404 });

  if (req.method === "GET") return new Response("Method not allowed", { status: 405, headers: { ...CORS, Allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 200, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  let body: unknown;
  try { body = await req.json(); } catch (_) {
    return Response.json(fail(null, -32700, "Parse error"), { status: 400, headers: CORS });
  }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as Rec[];
  const out = (await Promise.all(msgs.map(handle))).filter(Boolean);
  if (!out.length) return new Response(null, { status: 202, headers: CORS });
  return Response.json(batch ? out : out[0], { headers: CORS });
});
