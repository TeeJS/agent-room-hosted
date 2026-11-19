// Concurrency tests for the Agent Room server's state persistence.
//
// The server does read-modify-write on a single rooms.json. Without serialization,
// concurrent requests each load the same snapshot and the later save clobbers the
// earlier one (lost update). withLock() serializes writes and reloads fresh state
// inside the lock, so every concurrent mutation is preserved. These tests fire many
// simultaneous requests and assert nothing is dropped.
//
// Run: node --test scripts/agent_room.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "agent_room.mjs");
const PORT = 7399;
const BASE = `http://127.0.0.1:${PORT}`;
let home;
let server;

function api(method, endpoint, body) {
  return fetch(BASE + endpoint, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function waitForHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "arh-test-"));
  server = spawn(process.execPath, [SCRIPT, "serve"], {
    env: {
      ...process.env,
      AGENT_ROOM_HOME: home,
      AGENT_ROOM_TRANSCRIPT_DIR: path.join(home, "transcripts"),
      AGENT_ROOM_ATTACH_DIR: path.join(home, "attachments"),
      AGENT_ROOM_PORT: String(PORT),
      AGENT_ROOM_BIND_HOST: "127.0.0.1",
      AGENT_ROOM_VIEWER_ACTIVE_MS: "1500", // lets the presence tests watch "connected" expire in seconds
    },
    stdio: "ignore",
  });
  await waitForHealth();
});

after(async () => {
  if (server) server.kill("SIGTERM");
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

test("concurrent sends from distinct agents are not lost", async () => {
  const created = await (await api("POST", "/api/rooms", { title: "race", name: "Chair" })).json();
  const code = created.code;
  const N = 30;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      api("POST", `/api/rooms/${code}/messages`, { name: `Agent${i}`, content: `msg-${i}` }).then((r) => r.status)
    )
  );
  assert.ok(results.every((s) => s === 201), "every concurrent send should return 201");

  const room = await (await api("GET", `/api/rooms/${code}`)).json();
  const agentMessages = room.messages.filter((m) => m.kind === "agent");
  assert.equal(agentMessages.length, N, `all ${N} messages must persist (got ${agentMessages.length})`);
  for (let i = 0; i < N; i += 1) {
    assert.ok(agentMessages.some((m) => m.content === `msg-${i}`), `msg-${i} must be present`);
  }
  // Every distinct sender must have been added as a participant.
  const participants = new Set(room.participants.map((p) => p.name.toLowerCase()));
  for (let i = 0; i < N; i += 1) assert.ok(participants.has(`agent${i}`), `Agent${i} must be a participant`);
});

test("message ids are unique and contiguous under concurrency", async () => {
  const created = await (await api("POST", "/api/rooms", { title: "ids", name: "Chair" })).json();
  const code = created.code;
  const N = 25;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      api("POST", `/api/rooms/${code}/messages`, { name: "Solo", content: `c-${i}` })
    )
  );
  const room = await (await api("GET", `/api/rooms/${code}`)).json();
  const ids = room.messages.map((m) => m.id).sort((a, b) => a - b);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "no duplicate message ids");
  for (let i = 1; i < ids.length; i += 1) {
    assert.equal(ids[i], ids[i - 1] + 1, "message ids must be contiguous (no id reused/skipped)");
  }
});

test("concurrent joins all register", async () => {
  const created = await (await api("POST", "/api/rooms", { title: "joins", name: "Chair" })).json();
  const code = created.code;
  const N = 20;
  await Promise.all(
    Array.from({ length: N }, (_, i) => api("POST", `/api/rooms/${code}/join`, { name: `Joiner${i}` }))
  );
  const room = await (await api("GET", `/api/rooms/${code}`)).json();
  const names = new Set(room.participants.map((p) => p.name.toLowerCase()));
  for (let i = 0; i < N; i += 1) assert.ok(names.has(`joiner${i}`), `Joiner${i} must be present`);
});

test("a send concurrent with close is consistent (no partial write)", async () => {
  const created = await (await api("POST", "/api/rooms", { title: "close-race", name: "Chair" })).json();
  const code = created.code;
  // Fire a burst of sends and a close at the same time.
  const ops = [
    ...Array.from({ length: 10 }, (_, i) => api("POST", `/api/rooms/${code}/messages`, { name: "Chair", content: `pre-${i}` })),
    api("POST", `/api/rooms/${code}/close`, { name: "Chair", summary: "done" }),
  ];
  await Promise.all(ops);
  const room = await (await api("GET", `/api/rooms/${code}`)).json();
  assert.equal(room.status, "closed", "room ends closed");
  // Whatever landed before the close must be intact JSON (state never half-written).
  assert.ok(Array.isArray(room.messages), "messages array intact");
  assert.ok(room.messages.every((m) => typeof m.id === "number"), "every message well-formed");
});

// ---- Viewer presence + seen asks ---------------------------------------------------
// The human reads only the browser viewer's Needs-you tray, so agents must be able to tell
// whether it is open and whether an ask has actually been shown. These drive the real
// endpoints and the real CLI; the browser end is covered by driving the actual page.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const viewerPoll = (code) => api("GET", `/api/rooms/${code}/messages?after=0&wait=0&viewer=1`);
const status = async (code) => (await api("GET", `/api/rooms/${code}/status`)).json();
function cli(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, AGENT_ROOM_HOME: home, AGENT_ROOM_REMOTE_URL: BASE, AGENT_ROOM_PORT: String(PORT), AGENT_ROOM_TOKEN_FILE: path.join(home, "no-token") },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr }));
  });
}

test("a fresh room reports the viewer's name and that they have not connected", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "p1", name: "Chair", user_name: "T.J." })).json();
  assert.equal(room.viewer_name, "T.J.");
  assert.equal(room.viewer_connected, false);
  assert.equal(room.viewer_last_seen, null);
  const s = await status(room.code);
  assert.equal(s.viewer_name, "T.J.");
  assert.equal(s.viewer_connected, false);
});

test("a viewer poll marks the viewer connected, then it expires", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "p2", name: "Chair", user_name: "T.J." })).json();
  assert.equal((await viewerPoll(room.code)).status, 200);
  let s = await status(room.code);
  assert.equal(s.viewer_connected, true);
  assert.ok(s.viewer_last_seen, "last seen is recorded");
  await sleep(1800); // > AGENT_ROOM_VIEWER_ACTIVE_MS
  s = await status(room.code);
  assert.equal(s.viewer_connected, false, "no poll for a while means not connected");
  assert.ok(s.viewer_last_seen, "but the last-seen time is kept");
});

test("an agent poll, even one that claims viewer=1, does not count as the human", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "p3", name: "Chair", user_name: "T.J." })).json();
  await api("GET", `/api/rooms/${room.code}/messages?name=Chair&wait=0`);
  await api("GET", `/api/rooms/${room.code}/messages?name=Chair&wait=0&viewer=1`);
  await api("GET", `/api/rooms/${room.code}/messages?after=0&wait=0`); // nameless but not the viewer
  assert.equal((await status(room.code)).viewer_connected, false);
});

test("a closed tab does not extend its own presence by its last long-poll", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "p4", name: "Chair", user_name: "T.J." })).json();
  const controller = new AbortController();
  const pending = fetch(`${BASE}/api/rooms/${room.code}/messages?after=999&wait=3&viewer=1`, { signal: controller.signal }).catch(() => {});
  await sleep(200);
  controller.abort(); // the tab closes mid-poll
  await pending;
  // The server's wait ends 3s after the poll began. Look just after that, while a stamp
  // wrongly renewed at the end of the wait (window 1.5s) would still be fresh; the stamp
  // from the poll's start is long expired by then.
  await sleep(3400);
  assert.equal((await status(room.code)).viewer_connected, false);
});

test("an ask reports viewer state, starts unseen, and is marked seen only for the ids reported", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "p5", name: "Chair", user_name: "T.J." })).json();
  const a1 = await (await api("POST", `/api/rooms/${room.code}/ask`, { name: "Sol", content: "first?" })).json();
  const a2 = await (await api("POST", `/api/rooms/${room.code}/ask`, { name: "Sol", content: "second?" })).json();
  assert.equal(a1.viewer_name, "T.J.");
  assert.equal(a1.viewer_connected, false);
  assert.equal(a1.ask.seen_at, undefined);
  const seen = await (await api("POST", `/api/rooms/${room.code}/asks/seen`, { ids: [a1.ask.id, 99999, "x"] })).json();
  const byId = Object.fromEntries(seen.asks.map((a) => [a.id, a]));
  assert.ok(byId[a1.ask.id].seen_at, "reported ask is marked seen");
  assert.equal(byId[a2.ask.id].seen_at, undefined, "unreported ask stays unseen");
  const first = byId[a1.ask.id].seen_at;
  await sleep(1100);
  const again = await (await api("POST", `/api/rooms/${room.code}/asks/seen`, { ids: [a1.ask.id] })).json();
  assert.equal(again.asks.find((a) => a.id === a1.ask.id).seen_at, first, "seen time is not overwritten");
  assert.equal((await status(room.code)).asks.find((a) => a.id === a1.ask.id).seen_at, first, "agents read it from status");
});

test("seen does not change what agents are woken by", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "p6", name: "Chair", user_name: "T.J." })).json();
  const a = await (await api("POST", `/api/rooms/${room.code}/ask`, { name: "Sol", content: "q?" })).json();
  const before = (await status(room.code)).latest_message_id;
  await api("POST", `/api/rooms/${room.code}/asks/seen`, { ids: [a.ask.id] });
  assert.equal((await status(room.code)).latest_message_id, before, "no new message id");
});

test("an @-mention send returns the ask it raised and the viewer state", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "p7", name: "Chair", user_name: "T.J." })).json();
  const plain = await (await api("POST", `/api/rooms/${room.code}/messages`, { name: "Sol", content: "no mention" })).json();
  assert.equal(plain.ask, undefined);
  const mention = await (await api("POST", `/api/rooms/${room.code}/messages`, { name: "Sol", content: "@T.J. milestone reached" })).json();
  assert.ok(mention.ask && mention.ask.implicit);
  assert.equal(mention.viewer_name, "T.J.");
  assert.equal(mention.viewer_connected, false);
});

test("CLI join, status, ask and send print the viewer's name and connection state", async () => {
  const created = await cli("create", "--title", "cli", "--name", "Chair", "--user-name", "T.J.");
  const code = /rooms\/(AM-[A-Z0-9]+)/.exec(created.out)[1];

  let r = await cli("join", code, "--name", "Sol");
  assert.match(r.out, /Human: T\.J\. is NOT connected \(viewer not opened since the server started\)/);
  assert.match(r.out, /mention as @T\.J\./);
  assert.match(r.out, /Viewer URL: .*\/rooms\/AM-/);

  r = await cli("ask", code, "--name", "Sol", "Approve the plan?");
  const askId = Number(/Asked #(\d+)/.exec(r.out)[1]);
  assert.match(r.out, /T\.J\. is NOT connected/);
  assert.match(r.out, /invisible to them until they open/);

  r = await cli("status", code);
  assert.match(r.out, /Human: T\.J\. is NOT connected/);
  assert.match(r.out, /Open asks in the tray:\n- #\d+ from Sol: NOT seen yet/);

  await viewerPoll(code);
  r = await cli("status", code);
  assert.match(r.out, /Human: T\.J\. is connected \(viewer last active \d+s ago; mention as @T\.J\.\)/);

  r = await cli("send", code, "--name", "Sol", "--message", "@T.J. quick status");
  assert.match(r.out, /now ask #\d+ in their Needs-you tray\. T\.J\. is connected \(viewer last active/);

  await api("POST", `/api/rooms/${code}/asks/seen`, { ids: [askId] });
  r = await cli("status", code);
  assert.match(r.out, /from Sol: seen \d+s ago/);
});

// ---- Viewer escaping (v0.11.1) ---------------------------------------------------
// The viewer builds HTML strings from room data and assigns them to innerHTML, with
// values placed inside double-quoted attributes (data-name, title, alt, download,
// placeholder). Its esc() used to be the DOM text-serialization trick, which leaves
// quotes alone, so a participant name or attachment filename containing a double quote
// could add attributes such as onerror to the element. These tests pin the fix: esc()
// escapes all five HTML-significant characters, and no room-data value reaches the
// markup without passing through it.

async function viewerScript(code) {
  const html = await (await fetch(`${BASE}/rooms/${code}`)).text();
  const script = /<script>([\s\S]*)<\/script>/.exec(html);
  assert.ok(script, "viewer page has an inline script");
  return script[1];
}

test("the viewer's esc() escapes quotes as well as angle brackets and ampersands", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "esc", name: "Chair" })).json();
  const evilName = 'x" autofocus onfocus="alert(1)';
  await api("POST", `/api/rooms/${room.code}/join`, { name: evilName });
  const script = await viewerScript(room.code);
  // The definition contains semicolons inside its entity strings, so it is cut at the
  // statement that follows it rather than at the first ";".
  const definition = /const esc=(s=>.*?);const colorFor=/.exec(script);
  assert.ok(definition, "esc definition not found in the viewer script");
  const esc = new Function(`return (${definition[1]});`)();
  assert.equal(esc(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
  assert.equal(esc(evilName), "x&quot; autofocus onfocus=&quot;alert(1)");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(42), "42");
  // Escaping "&" first means an already-escaped value is not double-decoded into markup.
  assert.equal(esc("&quot;"), "&amp;quot;");
});

test("the viewer has no DOM-serialization escaper and no unescaped room-data interpolation", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "esc2", name: "Chair" })).json();
  const script = await viewerScript(room.code);
  assert.doesNotMatch(script, /textContent=s;return \w+\.innerHTML/, "the quote-blind escaper is back");
  assert.match(script, /const e2=esc;/, "the export helper must reuse esc");
  assert.doesNotMatch(script, /'\+a\.id\+'/, "ask ids must go through esc");
  assert.doesNotMatch(script, /--person:'\+\(/, "participant colors must go through esc");
});

test("a hostile participant name and attachment filename are stored as data, not rewritten", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "esc3", name: "Chair" })).json();
  const evilName = 'x" autofocus onfocus="alert(1)';
  const evilFile = 'a" onerror="alert(1)" b=".png';
  await api("POST", `/api/rooms/${room.code}/join`, { name: evilName });
  const upload = await (await api("POST", `/api/rooms/${room.code}/attachments`, {
    name: "Mallory", filename: evilFile, content_type: "image/png", data_base64: Buffer.from("not an image").toString("base64"),
  })).json();
  await api("POST", `/api/rooms/${room.code}/messages`, { name: "Mallory", content: "see file", attachments: [upload.id] });
  const stored = await (await api("GET", `/api/rooms/${room.code}`)).json();
  assert.ok(stored.participants.some((person) => person.name === evilName));
  assert.equal(stored.messages.at(-1).attachments[0].filename, evilFile);
  // The server-rendered page embeds room data as JSON inside <script>; a "<" must never
  // appear raw there, and the hostile strings must not appear outside that JSON.
  const html = await (await fetch(`${BASE}/rooms/${room.code}`)).text();
  assert.doesNotMatch(html, /onfocus="alert\(1\)"/);
  assert.doesNotMatch(html, /onerror="alert\(1\)"/);
});

// ---- Viewer lane (v0.12.0) -------------------------------------------------------
// The app has no login, so it cannot tell the human's browser from an agent. With
// AGENT_ROOM_VIEWER_SECRET set, the human-lane proxy proves itself by adding the header
// X-Agent-Room-Viewer: <secret>; without it, human-only routes answer 403 and the
// viewer's name cannot be used. These tests run against a second server started with a
// secret. sapi() is the agent lane (no header); hapi() is the human lane (correct header).

const SPORT = 7397;
const SBASE = `http://127.0.0.1:${SPORT}`;
const SECRET = "test-secret";
let secureHome;
let secureServer;

function laneFetch(headers) {
  return (method, endpoint, body) => fetch(SBASE + endpoint, {
    method,
    headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const sapi = laneFetch({});
const hapi = laneFetch({ "x-agent-room-viewer": SECRET });

before(async () => {
  secureHome = fs.mkdtempSync(path.join(os.tmpdir(), "arh-test-secure-"));
  secureServer = spawn(process.execPath, [SCRIPT, "serve"], {
    env: {
      ...process.env,
      AGENT_ROOM_HOME: secureHome,
      AGENT_ROOM_TRANSCRIPT_DIR: path.join(secureHome, "transcripts"),
      AGENT_ROOM_ATTACH_DIR: path.join(secureHome, "attachments"),
      AGENT_ROOM_PORT: String(SPORT),
      AGENT_ROOM_BIND_HOST: "127.0.0.1",
      AGENT_ROOM_VIEWER_SECRET: SECRET,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${SBASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("secured server did not become healthy");
});

after(async () => {
  if (secureServer) secureServer.kill("SIGTERM");
  try { fs.rmSync(secureHome, { recursive: true, force: true }); } catch {}
});

async function securedRoom(title) {
  return (await sapi("POST", "/api/rooms", { title, name: "Chair", user_name: "T.J." })).json();
}

test("with a viewer secret, human-only routes are refused on the agent lane and work on the human lane", async () => {
  const room = await securedRoom("s2-routes");
  const code = room.code;
  await sapi("POST", `/api/rooms/${code}/join`, { name: "Mallory" });

  // viewer/messages
  let r = await sapi("POST", `/api/rooms/${code}/viewer/messages`, { content: "hi" });
  assert.equal(r.status, 403, "viewer/messages must be 403 for agents");
  r = await hapi("POST", `/api/rooms/${code}/viewer/messages`, { content: "hi" });
  assert.equal(r.status, 201, "viewer/messages must work for the human");

  // viewer/remove
  r = await sapi("POST", `/api/rooms/${code}/viewer/remove`, { name: "Mallory" });
  assert.equal(r.status, 403, "viewer/remove must be 403 for agents");
  r = await hapi("POST", `/api/rooms/${code}/viewer/remove`, { name: "Mallory" });
  assert.equal(r.status, 200, "viewer/remove must work for the human");

  // viewer/readmit (Mallory is now removed)
  r = await sapi("POST", `/api/rooms/${code}/viewer/readmit`, { name: "Mallory" });
  assert.equal(r.status, 403, "viewer/readmit must be 403 for agents");
  r = await hapi("POST", `/api/rooms/${code}/viewer/readmit`, { name: "Mallory" });
  assert.equal(r.status, 200, "viewer/readmit must work for the human");

  // mode
  r = await sapi("POST", `/api/rooms/${code}/mode`, { addressed_only: true });
  assert.equal(r.status, 403, "mode must be 403 for agents");
  r = await hapi("POST", `/api/rooms/${code}/mode`, { addressed_only: false });
  assert.equal(r.status, 200, "mode must work for the human");

  // asks/seen
  r = await sapi("POST", `/api/rooms/${code}/asks/seen`, { ids: [1] });
  assert.equal(r.status, 403, "asks/seen must be 403 for agents");
  r = await hapi("POST", `/api/rooms/${code}/asks/seen`, { ids: [1] });
  assert.equal(r.status, 200, "asks/seen must work for the human");

  // asks/<id>/answer
  const askRoom = await securedRoom("s2-ask");
  const askResp = await (await sapi("POST", `/api/rooms/${askRoom.code}/ask`, { name: "Mallory", content: "need approval" })).json();
  const askId = askResp.ask.id;

  r = await sapi("POST", `/api/rooms/${askRoom.code}/asks/${askId}/answer`, { answer: "yes" });
  assert.equal(r.status, 403, "ask answer must be 403 for agents");
  r = await hapi("POST", `/api/rooms/${askRoom.code}/asks/${askId}/answer`, { answer: "yes" });
  assert.equal(r.status, 200, "ask answer must work for the human");

  // asks/<id>/dismiss
  const askRoom2 = await securedRoom("s2-ask2");
  const askResp2 = await (await sapi("POST", `/api/rooms/${askRoom2.code}/ask`, { name: "Mallory", content: "need approval 2" })).json();
  const askId2 = askResp2.ask.id;

  r = await sapi("POST", `/api/rooms/${askRoom2.code}/asks/${askId2}/dismiss`, {});
  assert.equal(r.status, 403, "ask dismiss must be 403 for agents");
  r = await hapi("POST", `/api/rooms/${askRoom2.code}/asks/${askId2}/dismiss`, {});
  assert.equal(r.status, 200, "ask dismiss must work for the human");

  // viewer/leave
  r = await sapi("POST", `/api/rooms/${code}/viewer/leave`, {});
  assert.equal(r.status, 403, "viewer/leave must be 403 for agents");
  r = await hapi("POST", `/api/rooms/${code}/viewer/leave`, {});
  assert.equal(r.status, 200, "viewer/leave must work for the human");

  // A refused call changes nothing: the forged answer above never became a message.
  const transcript = await (await sapi("GET", `/api/rooms/${askRoom.code}`)).json();
  assert.equal(transcript.messages.filter((m) => m.kind === "human").length, 1, "only the human-lane answer is in the transcript");
});

test("with a viewer secret, an agent cannot join, send, ask or create a room under the viewer's name", async () => {
  const room = await securedRoom("s2-reserve");
  const code = room.code;
  const viewerName = room.viewer_name;

  let r = await sapi("POST", `/api/rooms/${code}/join`, { name: viewerName });
  assert.equal(r.status, 403, "join as viewer must be 403 for agents");

  r = await sapi("POST", `/api/rooms/${code}/messages`, { name: viewerName, content: "sneaky" });
  assert.equal(r.status, 403, "send as viewer must be 403 for agents");

  r = await sapi("POST", `/api/rooms/${code}/ask`, { name: viewerName, content: "sneaky ask" });
  assert.equal(r.status, 403, "ask as viewer must be 403 for agents");

  r = await sapi("POST", "/api/rooms", { title: "sneaky-room", name: viewerName, user_name: viewerName });
  assert.equal(r.status, 400, "an agent cannot create a room in which it carries the viewer's name");

  r = await sapi("POST", `/api/rooms/${code}/leave`, { name: viewerName });
  assert.equal(r.status, 403, "leave as viewer must be 403 for agents");

  // Upload attribution: a named upload under the viewer's name, and an unnamed one
  // (which the server would attribute to the viewer), are both refused.
  const file = { filename: "a.txt", content_type: "text/plain", data_base64: Buffer.from("x").toString("base64") };
  r = await sapi("POST", `/api/rooms/${code}/attachments`, { ...file, name: viewerName });
  assert.equal(r.status, 403, "upload as viewer must be 403 for agents");
  r = await sapi("POST", `/api/rooms/${code}/attachments`, file);
  assert.equal(r.status, 403, "an unnamed upload must not be attributed to the viewer");
  r = await sapi("POST", `/api/rooms/${code}/attachments`, { ...file, name: "Mallory" });
  assert.equal(r.status, 201, "an agent can still upload under its own name");
  r = await hapi("POST", `/api/rooms/${code}/attachments`, file);
  assert.equal(r.status, 201, "the human's unnamed upload still works");

  // The human can still post through hapi.
  r = await hapi("POST", `/api/rooms/${code}/viewer/messages`, { content: "legit" });
  assert.equal(r.status, 201, "human viewer can still post through hapi");
});

test("a wrong X-Agent-Room-Viewer value is refused", async () => {
  const room = await securedRoom("s2-wrong");
  const code = room.code;
  const response = await fetch(`${SBASE}/api/rooms/${code}/viewer/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-room-viewer": "wrong-secret",
    },
    body: JSON.stringify({ content: "sneaky" }),
  });
  assert.equal(response.status, 403, "wrong secret must be refused");
});

test("with a viewer secret, the creator can still close from the agent lane but nobody can close as the viewer there", async () => {
  const room = await securedRoom("s2-close");
  const code = room.code;

  let r = await sapi("POST", `/api/rooms/${code}/close`, { name: "Chair", summary: "chair closes" });
  assert.equal(r.status, 200, "close by creator must work for agents");
  const after = await (await sapi("GET", `/api/rooms/${code}`)).json();
  assert.equal(after.status, "closed", "room must be closed after creator close");

  const room2 = await securedRoom("s2-close2");
  const code2 = room2.code;
  r = await sapi("POST", `/api/rooms/${code2}/close`, { name: room2.viewer_name, summary: "sneaky viewer close" });
  assert.equal(r.status, 403, "close as viewer must be 403 for agents");
  const after2 = await (await sapi("GET", `/api/rooms/${code2}`)).json();
  assert.equal(after2.status, "open", "room must still be open after refused viewer close");
});

test("with a viewer secret, only the human lane counts as the viewer's presence", async () => {
  const room = await securedRoom("s2-presence");
  const code = room.code;

  // Agent polls with viewer=1: must NOT mark the viewer as connected.
  let r = await sapi("GET", `/api/rooms/${code}/messages?viewer=1`);
  assert.equal(r.status, 200, "agent viewer=1 poll must not error");
  assert.equal((await r.json()).viewer_connected, false, "agent viewer=1 must not mark the viewer connected");
  assert.equal((await (await sapi("GET", `/api/rooms/${code}/status`)).json()).viewer_connected, false);

  // Human polls with viewer=1 through hapi: MUST mark the viewer as connected.
  r = await hapi("GET", `/api/rooms/${code}/messages?viewer=1`);
  assert.equal(r.status, 200, "human viewer=1 poll must not error");
  assert.equal((await r.json()).viewer_connected, true, "human viewer=1 must mark the viewer connected");
});

test("without a viewer secret nothing is gated, and health reports which mode the server is in", async () => {
  const room = await (await api("POST", "/api/rooms", { title: "legacy", name: "Chair", user_name: "T.J." })).json();
  const r = await api("POST", `/api/rooms/${room.code}/viewer/messages`, { content: "local viewer" });
  assert.equal(r.status, 201, "the local, no-secret server keeps its original behaviour");
  assert.equal((await (await api("GET", "/api/health")).json()).viewer_lane_enforced, false);
  assert.equal((await (await sapi("GET", "/api/health")).json()).viewer_lane_enforced, true);
});
