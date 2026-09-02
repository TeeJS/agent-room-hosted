#!/usr/bin/env node
// Open WebUI <-> Agent Room bridge.
//
// Open WebUI is turn-based and has no background loop, so on its own it only
// replies when a human prompts it. This bridge supplies the missing loop: it
// long-polls a room, and whenever a new message calls for a response it asks an
// Open WebUI model to reply (OpenAI-compatible /api/chat/completions) and posts
// the answer back to the room — so the OWUI model participates on its own.
//
// Zero dependencies; needs Node 18+ (global fetch). Configure via env vars:
//
//   ARH_BASE      Agent Room base URL   (e.g. https://arh-api.schmitzplex.com)
//   ARH_TOKEN     bearer token for that instance (omit for a tokenless LAN server)
//   ARH_ROOM      room code             (e.g. AM-XXXX)
//   ARH_NAME      the bridge's name in the room                 (default "OWUI")
//   OWUI_URL      Open WebUI base URL   (e.g. http://192.168.1.25:3000)
//   OWUI_KEY      Open WebUI API key    (Settings -> Account -> API keys)
//   OWUI_MODEL    model id to use       (e.g. llama3.1:8b)
//   ARH_WAIT      long-poll seconds, 5-300                        (default 45)
//   ARH_HISTORY   transcript messages sent as context            (default 30)
//   ARH_SYSTEM    override the system prompt                      (optional)
//   ARH_ONLY_WHEN_ADDRESSED  set to 1 to reply only when named    (default off)
//
// Run: node bridges/owui-bridge.mjs

function req(key) {
  const value = process.env[key];
  if (!value) { console.error(`Missing required env var ${key}`); process.exit(1); }
  return value;
}

const cfg = {
  arhBase: req("ARH_BASE").replace(/\/+$/, ""),
  arhToken: process.env.ARH_TOKEN || "",
  room: req("ARH_ROOM").toUpperCase(),
  name: (process.env.ARH_NAME || "OWUI").trim(),
  owuiUrl: req("OWUI_URL").replace(/\/+$/, ""),
  owuiKey: req("OWUI_KEY"),
  model: req("OWUI_MODEL"),
  wait: Math.min(300, Math.max(5, Number(process.env.ARH_WAIT || 45))),
  history: Math.max(1, Number(process.env.ARH_HISTORY || 30)),
  system: process.env.ARH_SYSTEM || "",
  onlyAddressed: process.env.ARH_ONLY_WHEN_ADDRESSED === "1",
};

async function arh(method, path, body) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (cfg.arhToken) headers["authorization"] = `Bearer ${cfg.arhToken}`;
  const response = await fetch(cfg.arhBase + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error(`Agent Room ${response.status} — check ARH_TOKEN / proxy auth`);
    throw new Error(`Agent Room ${response.status} on ${path}: ${(data && data.error) || text.slice(0, 140)}`);
  }
  return data ?? {};
}

async function generateReply() {
  const room = await arh("GET", `/api/rooms/${cfg.room}`);
  const transcript = (room.messages || [])
    .slice(-cfg.history)
    .map((m) => `${m.kind === "system" ? "system" : m.sender}: ${m.content}`)
    .join("\n");
  const system = cfg.system ||
    `You are ${cfg.name}, one participant in a live multi-agent meeting titled "${room.title}". ` +
    `Objective: ${room.objective}. Reply with only your message content — no name prefix, no quotes. ` +
    `Be concise and add something useful. If you have nothing to add, reply with exactly: SKIP`;
  const response = await fetch(cfg.owuiUrl + "/api/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${cfg.owuiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Transcript so far:\n${transcript}\n\nWrite your next message as ${cfg.name}.` },
      ],
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Open WebUI ${response.status}: ${text.slice(0, 160)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Open WebUI returned non-JSON: ${text.slice(0, 120)}`); }
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content || content.toUpperCase() === "SKIP") return null;
  return content.slice(0, 20000);
}

let running = true;
async function leave() {
  try { await arh("POST", `/api/rooms/${cfg.room}/leave`, { name: cfg.name }); } catch {}
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => { running = false; console.log("\nLeaving room…"); await leave(); process.exit(0); });
}

async function main() {
  await arh("POST", `/api/rooms/${cfg.room}/join`, { name: cfg.name });
  console.log(`${cfg.name} joined ${cfg.room} at ${cfg.arhBase}; watching with model ${cfg.model}.`);
  while (running) {
    try {
      const result = await arh("GET", `/api/rooms/${cfg.room}/messages?name=${encodeURIComponent(cfg.name)}&wait=${cfg.wait}`);
      if (result.status === "closed") { console.log("Room closed. Exiting."); break; }
      const addressed = (result.messages || []).some((m) => m.addressed_to_you);
      const shouldReply = result.should_respond && (!cfg.onlyAddressed || addressed);
      if (shouldReply) {
        const reply = await generateReply();
        if (reply) { await arh("POST", `/api/rooms/${cfg.room}/messages`, { name: cfg.name, content: reply }); console.log(`→ replied (${reply.length} chars)`); }
        else { console.log("… model chose to stay quiet"); }
      }
    } catch (error) {
      console.error(`bridge error: ${error.message}`);
      if (/check ARH_TOKEN/.test(error.message)) { await leave().catch(() => {}); process.exit(1); }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch(async (error) => { console.error(`Fatal: ${error.message}`); await leave(); process.exit(1); });
