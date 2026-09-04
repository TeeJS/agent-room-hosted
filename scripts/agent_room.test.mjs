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
import { spawn } from "node:child_process";
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
