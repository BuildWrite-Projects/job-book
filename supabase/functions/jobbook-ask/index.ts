// Job Book — Ask Claude.
//
// Job Book's Ask Claude panel sends the conversation (the book as it stands,
// plus what the person said) and the list of actions the panel can do (add a
// note, flag urgent, check off...). This passes it to Claude and hands back
// Claude's reply as it comes: either words, or the actions it wants run. The
// panel runs those actions itself, signed in as the person, so this function
// never touches the book. The Anthropic key lives only here, as the
// ANTHROPIC_API_KEY secret, shared with the receipt reader.
//
// Only signed-in people on a team may use it. Teams other than the founding
// one have a monthly limit (teams.settings.askCapMonth, default 300 calls).
//
// Body: { messages: [...Anthropic messages], tools: [{name, description, input_schema}] }
//   -> { ok, content, stop_reason }   or   { ok:false, code, message }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = Deno.env.get("JOBBOOK_ASK_MODEL") || "claude-haiku-5-5";
const ORIGINS = ["https://buildwrite-projects.github.io", "http://localhost:8768"];
const DEFAULT_CAP = 300;

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function reply(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}
function fail(req: Request, code: string, message: string) {
  return reply(req, { ok: false, code, message });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return fail(req, "invalid_argument", "POST only");

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";

  // --- who is asking ---
  const auth = req.headers.get("Authorization") || "";
  const asUser = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: who, error: whoErr } = await asUser.auth.getUser();
  if (whoErr || !who?.user) return fail(req, "not_granted", "Sign in first");
  const admin = createClient(url, service);
  const { data: membership } = await admin.from("team_members").select("team_id, teams(founding, settings)")
    .eq("user_id", who.user.id).order("added_at").limit(1).maybeSingle();
  if (!membership) return fail(req, "not_granted", "This account isn't on a team yet.");
  const teamId = (membership as any).team_id as string;
  const team = (membership as any).teams || {};
  if (!apiKey) return fail(req, "not_granted", "Ask Claude has no API key yet");

  // --- the monthly limit (not for the founding team) ---
  if (!team.founding) {
    const cap = Number(team.settings?.askCapMonth ?? DEFAULT_CAP);
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const { count } = await admin.from("ask_log").select("id", { count: "exact", head: true })
      .eq("team_id", teamId).gte("at", monthStart.toISOString());
    if ((count ?? 0) >= cap) return fail(req, "monthly_cap", `This team has used its ${cap} Ask Claude requests for the month.`);
  }

  let body: any;
  try { body = await req.json(); } catch { return fail(req, "invalid_argument", "Bad request body"); }
  const messages = Array.isArray(body?.messages) ? body.messages.slice(-24) : [];
  const tools = Array.isArray(body?.tools) ? body.tools.slice(0, 16).map((t: any) => ({
    name: String(t.name).slice(0, 64), description: String(t.description || "").slice(0, 1024), input_schema: t.input_schema,
  })) : [];
  if (!messages.length) return fail(req, "invalid_argument", "Nothing to ask");
  if (JSON.stringify(messages).length > 200000) return fail(req, "invalid_argument", "Too long");

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages, ...(tools.length ? { tools } : {}) }),
    });
  } catch {
    return fail(req, "network", "Could not reach Claude");
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(out?.error?.message || res.statusText);
    console.log("ask failed", res.status, msg);
    if (res.status === 429 || res.status === 529) return fail(req, "rate_limited", msg);
    if (/credit balance/i.test(msg)) return fail(req, "no_credit", msg);
    return fail(req, "ask_failed", msg);
  }

  await admin.from("ask_log").insert({ team_id: teamId, user_id: who.user.id,
    tokens_in: out.usage?.input_tokens ?? null, tokens_out: out.usage?.output_tokens ?? null });
  console.log(JSON.stringify({ model: MODEL, stop: out.stop_reason, in: out.usage?.input_tokens, out: out.usage?.output_tokens }));
  return reply(req, { ok: true, content: out.content || [], stop_reason: out.stop_reason || null });
});
