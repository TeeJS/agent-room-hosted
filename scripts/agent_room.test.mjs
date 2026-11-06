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
