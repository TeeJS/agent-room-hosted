#!/usr/bin/env node

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.AGENT_ROOM_PORT || 7331);
const stripTrailingSlash = (value) => value.replace(/\/+$/, "");
// This fork defaults the CLIENT to the hosted instance. Set AGENT_ROOM_REMOTE_URL to
// override — e.g. http://127.0.0.1:7331 to run against a local server instead.
const DEFAULT_REMOTE = "https://arh-api.schmitzplex.com";
const LEGACY_BASE = `http://${process.env.AGENT_ROOM_HOST || "127.0.0.1"}:${PORT}`;
// BIND_HOST: what the server listens on (e.g. 0.0.0.0 inside a container).
const BIND_HOST = process.env.AGENT_ROOM_BIND_HOST || process.env.AGENT_ROOM_HOST || "127.0.0.1";
// PUBLIC_URL: how the server advertises itself (viewer links, invitations, health).
const PUBLIC_URL = stripTrailingSlash(process.env.AGENT_ROOM_PUBLIC_URL || LEGACY_BASE);
// REMOTE_URL: where the CLIENT sends requests. Defaults to the hosted instance.
const REMOTE_URL = stripTrailingSlash(process.env.AGENT_ROOM_REMOTE_URL || DEFAULT_REMOTE);
// IS_REMOTE: true unless the client points at a local loopback server. Only in local
// mode does the CLI manage (spawn/stop) a server; against a remote host it never does.
const IS_REMOTE = !/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(REMOTE_URL);
const DATA_DIR = process.env.AGENT_ROOM_HOME || path.join(os.homedir(), ".agent-room");
// TOKEN: bearer credential the client attaches; empty means no auth header.
// Resolution order: AGENT_ROOM_TOKEN_FILE, then <DATA_DIR>/token, then the
// AGENT_ROOM_TOKEN env var. The file wins on purpose: an agent session captures
// env vars when it starts, so a rotated or placeholder value lingers for the life
// of the session, while the file is read fresh on every CLI call and is shared by
// every agent runtime on the machine (Claude Code, Codex, ...).
const TOKEN_PATH = process.env.AGENT_ROOM_TOKEN_FILE || path.join(DATA_DIR, "token");
const TOKEN = readTokenFile(TOKEN_PATH) || (process.env.AGENT_ROOM_TOKEN || "").trim();

function readTokenFile(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}
const STATE_PATH = path.join(DATA_DIR, "rooms.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const PID_PATH = path.join(DATA_DIR, "server.pid");
const LOG_PATH = path.join(DATA_DIR, "server.log");
// TRANSCRIPT_DIR: where the server writes one Markdown file per room, laid out as
// YYYY/MM/DD/<slug>-<code8>.md (date = room creation, in TZ if set, else UTC).
// rooms.json stays the live store; these files are derived output, never read back.
const TRANSCRIPT_DIR = process.env.AGENT_ROOM_TRANSCRIPT_DIR || path.join(DATA_DIR, "transcripts");
const TRANSCRIPT_DEBOUNCE_MS = 2000;
// RETENTION_DAYS: prune CLOSED rooms older than this from rooms.json once their
// transcript file exists. 0 (default) = never prune; viewer URLs keep working forever.
const RETENTION_DAYS = Math.max(0, Number(process.env.AGENT_ROOM_RETENTION_DAYS || 0) || 0);
// ATTACH_DIR: where uploaded attachments live, one file per attachment at <code>/<id>
// (no extension; the content-type is kept in the sidecar). rooms.json stores only a
// small sidecar record per attachment — never the bytes — so the state file and the
// Markdown transcripts stay text and the search corpus stays clean.
const ATTACH_DIR = process.env.AGENT_ROOM_ATTACH_DIR || path.join(DATA_DIR, "attachments");
// The allowlist is the only gate; the store itself is content-type-agnostic. 10 MB per
// file. The JSON upload envelope carries base64 (~4/3 the bytes) so its cap sits above that.
// NOTE (deploy): the reverse proxy must allow a matching body — set client_max_body_size
// to at least 16m on both the human and API hosts, or uploads are rejected before arrival.
const ATTACH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACH_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const ATTACH_TYPES = {
  "image/png": { ext: "png", image: true },
  "image/jpeg": { ext: "jpg", image: true },
  "image/gif": { ext: "gif", image: true },
  "image/webp": { ext: "webp", image: true },
  "application/pdf": { ext: "pdf", image: false },
  "text/plain": { ext: "txt", image: false },
  "text/markdown": { ext: "md", image: false },
};
const ATTACH_EXT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", markdown: "text/markdown" };
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERSION = "0.8.0";
const waiters = new Map();
const LEGACY_PARTICIPANT_COLORS = ["#A9C7FF", "#FFB4A9", "#A8E6CF", "#FFD6A5", "#D5B8FF", "#9EE7E5", "#F7B7D2", "#C7E9A0", "#F6C7A8", "#B9C6FF"];
const PARTICIPANT_COLORS = ["#5B8CFF", "#FF6B5E", "#34C77B", "#F2B134", "#A970FF", "#20B8CC", "#F05DAA", "#78C442", "#F28A3E", "#6E79FF"];

const ensureDir = () => fs.mkdirSync(DATA_DIR, { recursive: true });
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function loadState() {
  ensureDir();
  if (!fs.existsSync(STATE_PATH)) return { rooms: {} };
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!state.rooms || typeof state.rooms !== "object") throw new Error("Invalid state");
    return state;
  } catch {
    try { fs.renameSync(STATE_PATH, `${STATE_PATH}.corrupt-${Date.now()}`); } catch {}
    return { rooms: {} };
  }
}

function saveState(state) {
  ensureDir();
  for (const room of Object.values(state.rooms)) if (!room.transcript_path) room.transcript_path = transcriptRelativePath(room);
  const temporary = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, STATE_PATH);
  scheduleTranscripts(state);
}

// ---- Markdown transcripts -------------------------------------------------------
// Written on every save (debounced), flushed synchronously on close and on shutdown.
// The path is computed once, stored on the room as transcript_path (relative to
// TRANSCRIPT_DIR) and reused forever, so a title/TZ change never forks a second file.

function transcriptSlug(room) {
  const title = String(room.title || "room").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "") || "room";
  const code8 = String(room.code || "").replace(/^AM-/i, "").slice(0, 8).toLowerCase() || "room";
  return `${title}-${code8}`;
}

function transcriptRelativePath(room) {
  const date = new Date(room.created_at || Date.now());
  const options = { year: "numeric", month: "2-digit", day: "2-digit" };
  let parts;
  try { parts = new Intl.DateTimeFormat("en-US", { ...options, timeZone: process.env.TZ || "UTC" }).formatToParts(date); }
  catch { parts = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).formatToParts(date); }
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return path.posix.join(part("year"), part("month"), part("day"), `${transcriptSlug(room)}.md`);
}

const transcriptStamps = new Map();
const pendingTranscripts = new Set();
let transcriptTimer = null;
const transcriptStamp = (room) => `${room.updated_at}|${room.status}|${room.summary || ""}`;

function writeTranscriptNow(room) {
  if (!room.transcript_path) room.transcript_path = transcriptRelativePath(room);
  const target = path.join(TRANSCRIPT_DIR, room.transcript_path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, roomToMarkdown(room));
  fs.renameSync(temporary, target);
  transcriptStamps.set(room.code, transcriptStamp(room));
}

function scheduleTranscripts(state) {
  for (const room of Object.values(state.rooms)) {
    if (transcriptStamps.get(room.code) !== transcriptStamp(room)) pendingTranscripts.add(room.code);
  }
  if (!pendingTranscripts.size || transcriptTimer) return;
  transcriptTimer = setTimeout(() => { transcriptTimer = null; flushTranscripts(loadState()); }, TRANSCRIPT_DEBOUNCE_MS);
  transcriptTimer.unref();
}

function flushTranscripts(state) {
  if (transcriptTimer) { clearTimeout(transcriptTimer); transcriptTimer = null; }
  for (const code of pendingTranscripts) {
    const room = state.rooms[code];
    if (!room) continue;
    try { writeTranscriptNow(room); }
    catch (error) { process.stderr.write(`transcript write failed for ${code}: ${error.message}\n`); }
  }
  pendingTranscripts.clear();
}

// Startup pass: give every room a transcript_path and a file on disk (idempotent), then
// apply retention. Only rooms whose transcript file exists are ever pruned.
function migrateTranscripts() {
  const state = loadState();
  let changed = false;
  for (const room of Object.values(state.rooms)) {
    if (!room.transcript_path) { room.transcript_path = transcriptRelativePath(room); changed = true; }
    if (!fs.existsSync(path.join(TRANSCRIPT_DIR, room.transcript_path))) {
      try { writeTranscriptNow(room); } catch (error) { process.stderr.write(`transcript write failed for ${room.code}: ${error.message}\n`); }
    } else transcriptStamps.set(room.code, transcriptStamp(room));
  }
  if (changed) saveState(state);
  pruneClosedRooms();
}

function pruneClosedRooms() {
  if (!RETENTION_DAYS) return;
  const state = loadState();
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  let changed = false;
  for (const [code, room] of Object.entries(state.rooms)) {
    if (room.status !== "closed" || !room.transcript_path) continue;
    if (Date.parse(room.updated_at || room.created_at || "") > cutoff) continue;
    if (!fs.existsSync(path.join(TRANSCRIPT_DIR, room.transcript_path))) continue;
    delete state.rooms[code]; transcriptStamps.delete(code); changed = true;
  }
  if (changed) saveState(state);
}

function migrateState() {
  const state = loadState();
  let changed = false;
  for (const room of Object.values(state.rooms)) {
    const latest = Math.max(0, Number(room.next_message_id || 1) - 1);
    if (typeof room.addressed_only !== "boolean") { room.addressed_only = false; changed = true; }
    if (!Array.isArray(room.removed)) { room.removed = []; changed = true; }
    if (!room.attachments || typeof room.attachments !== "object") { room.attachments = {}; changed = true; }
    for (const [index, participant] of (room.participants || []).entries()) {
      if (!participant.role) { participant.role = "agent"; changed = true; }
      if (!Number.isFinite(participant.last_read_id)) { participant.last_read_id = latest; changed = true; }
      const legacyIndex = LEGACY_PARTICIPANT_COLORS.indexOf(participant.color);
      if (!participant.color || legacyIndex >= 0) {
        participant.color = PARTICIPANT_COLORS[(legacyIndex >= 0 ? legacyIndex : index) % PARTICIPANT_COLORS.length];
        changed = true;
      }
    }
  }
  if (changed) saveState(state);
}

function loadConfig() {
  ensureDir();
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return config && typeof config === "object" ? config : {};
  } catch {
    return {};
  }
}

function saveConfig(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function makeCode() {
  // 32-symbol Crockford-style alphabet (uppercase, URL-safe, omits I/L/O/0/1).
  // 26 symbols * 5 bits = 130 bits of entropy — unguessable for a public host.
  // Lookups are case-insensitive map-key reads with no format check, so both these
  // long codes and any pre-existing short codes in rooms.json keep resolving.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "AM-";
  for (let index = 0; index < 26; index += 1) value += chars[crypto.randomInt(chars.length)];
  return value;
}

function nextParticipantColor(room) {
  const used = new Set((room.participants || []).map((participant) => participant.color));
  return PARTICIPANT_COLORS.find((color) => !used.has(color)) || PARTICIPANT_COLORS[room.participants.length % PARTICIPANT_COLORS.length];
}

function addMessage(room, sender, content, kind = "agent") {
  const message = {
    id: room.next_message_id++,
    sender: String(sender || "Agent").trim().slice(0, 80) || "Agent",
    content: String(content || "").trim().slice(0, 20000),
    kind,
    created_at: now(),
  };
  room.messages.push(message);
  room.updated_at = message.created_at;
  return message;
}

function addressedTo(message, name) {
  if (!name || !["agent", "human"].includes(message.kind)) return false;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapedName}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(message.content);
}

const sameName = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

// Names the human viewer removed from the room. A removed agent gets 403 on join,
// send and listen until the viewer re-admits it; its watcher exits on the 403.
function removedEntry(room, name) {
  return (room.removed || []).find((entry) => sameName(entry, name));
}

function removedError(room, code, name) {
  return `${name} was removed from ${code} by ${room.viewer_name || "the host"}. Stop listening and do not rejoin.`;
}

// ---- Attachments ----------------------------------------------------------------
// Bytes live on disk at ATTACH_DIR/<code>/<id>; rooms.json keeps only the sidecar
// (room.attachments[id]) plus a denormalized snapshot on each referencing message.
// Messages and transcripts carry a short TEXT ref, never bytes — so small-context
// models and the search corpus are never flooded.

const makeAttachmentId = () => crypto.randomBytes(9).toString("hex"); // 18 hex chars, unguessable, path-safe
const isImageType = (contentType) => Boolean(ATTACH_TYPES[contentType]?.image);

function formatBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// The self-describing snapshot stored on a message and rendered as the text ref. The
// authoritative record (adds sha256, uploaded_by, provenance) stays in room.attachments[id].
const attachmentSnapshot = (entry) => ({ id: entry.id, filename: entry.filename, content_type: entry.content_type, size: entry.size });

// Resolve a message's attachment refs (ids or snapshots) against room.attachments,
// dropping unknown ids and stamping the message id onto each sidecar for provenance.
function resolveAttachments(room, refs, messageId) {
  const store = room.attachments && typeof room.attachments === "object" ? room.attachments : (room.attachments = {});
  const out = [];
  for (const ref of Array.isArray(refs) ? refs : []) {
    const id = typeof ref === "string" ? ref : ref && ref.id;
    const entry = id && store[id];
    if (!entry) continue;
    if (messageId != null && entry.message_id == null) entry.message_id = messageId;
    out.push(attachmentSnapshot(entry));
  }
  return out;
}

const attachmentRefText = (attachment) => `[${isImageType(attachment.content_type) ? "img" : "doc"}: ${attachment.filename} ${formatBytes(attachment.size)} #${attachment.id}]`;

function publicRoom(room) {
  const { next_message_id, ...visible } = room;
  visible.participants = room.participants.map(({ last_read_id, ...participant }) => participant);
  return { ...visible, viewer_url: `${PUBLIC_URL}/rooms/${room.code}`, invitation: invitation(room) };
}

function invitation(room) {
  return `Paste this to your other agents:\n\nUse the agent-room skill to join room: ${PUBLIC_URL}/rooms/${room.code}`;
}

function notify(code) {
  for (const resolve of waiters.get(code) || []) resolve();
  waiters.delete(code);
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function page(response, status, body) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readBody(request, maxBytes = 262144) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > maxBytes) throw new Error("Request body too large");
  }
  if (!raw) return {};
  const body = JSON.parse(raw);
  if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("JSON body must be an object");
  return body;
}

function waitForChange(code, seconds) {
  return new Promise((resolve) => {
    const roomWaiters = waiters.get(code) || new Set();
    const timer = setTimeout(() => {
      roomWaiters.delete(done);
      resolve();
    }, seconds * 1000);
    const done = () => { clearTimeout(timer); roomWaiters.delete(done); resolve(); };
    roomWaiters.add(done);
    waiters.set(code, roomWaiters);
  });
}

async function route(request, response) {
  const url = new URL(request.url, PUBLIC_URL);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/health") {
    json(response, 200, { ok: true, version: VERSION, url: PUBLIC_URL }); return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    page(response, 200, landingPage()); return;
  }
  if (request.method === "GET" && parts[0] === "rooms" && parts.length === 2) {
    const room = loadState().rooms[parts[1].toUpperCase()];
    page(response, room ? 200 : 404, room ? meetingPage(room) : notFoundPage(parts[1])); return;
  }

  if (parts[0] !== "api" || parts[1] !== "rooms") {
    json(response, 404, { error: "Not found" }); return;
  }

  if (request.method === "GET" && parts.length === 2) {
    // Room enumeration is OFF by default. On a hosted instance it would let any token
    // holder list every room, defeating the unguessable 130-bit room-code design. Opt in
    // only for a trusted local/loopback deployment (e.g. the agent-room-monitor drop-in).
    // Answer 404 when disabled so it is indistinguishable from a route that doesn't exist.
    if (process.env.AGENT_ROOM_ENABLE_ROOM_LIST !== "1") { json(response, 404, { error: "Not found" }); return; }
    const statusFilter = String(url.searchParams.get("status") || "").trim().toLowerCase();
    const rooms = Object.values(loadState().rooms)
      .filter((room) => !statusFilter || room.status === statusFilter)
      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
      .map((room) => ({
        code: room.code,
        title: room.title,
        status: room.status,
        viewer_name: room.viewer_name,
        participant_count: room.participants.length,
        active_agents: room.participants.filter((person) => person.role === "agent").length,
        latest_message_id: room.next_message_id - 1,
        created_at: room.created_at,
        updated_at: room.updated_at,
      }));
    json(response, 200, { rooms }); return;
  }

  if (request.method === "POST" && parts.length === 2) {
    const body = await readBody(request);
    const state = loadState();
    let code = makeCode();
    while (state.rooms[code]) code = makeCode();
    const title = String(body.title || "Agent meeting").trim().slice(0, 160) || "Agent meeting";
    const objective = String(body.objective || "Reach a clear, evidence-based conclusion.").trim().slice(0, 4000);
    const creator = String(body.name || "Host").trim().slice(0, 80) || "Host";
    const viewerName = String(body.user_name || loadConfig().user_name || "User").trim().slice(0, 80) || "User";
    const room = {
      code, title, objective, status: "open", created_by: creator,
      viewer_name: viewerName,
      created_at: now(), updated_at: now(),
      participants: [{ name: creator, role: "agent", joined_at: now(), last_read_id: 0, color: PARTICIPANT_COLORS[0] }],
      messages: [], next_message_id: 1, summary: "", addressed_only: false,
    };
    addMessage(room, "Room", `${creator} created the meeting. Objective: ${objective}`, "system");
    room.participants[0].last_read_id = room.next_message_id - 1;
    state.rooms[code] = room;
    saveState(state);
    notify(code);
    json(response, 201, publicRoom(room)); return;
  }

  const code = String(parts[2] || "").toUpperCase();
  let state = loadState();
  let room = state.rooms[code];
  if (!room) { json(response, 404, { error: `Room ${code} not found` }); return; }

  if (request.method === "GET" && parts.length === 3) {
    json(response, 200, publicRoom(room)); return;
  }

  if (request.method === "GET" && parts[3] === "status") {
    json(response, 200, {
      room: code,
      status: room.status,
      active_agents: room.participants.filter((person) => person.role === "agent").length,
      addressed_only: room.addressed_only,
      participants: room.participants.map(({ last_read_id, ...person }) => person),
      latest_message_id: room.next_message_id - 1,
    }); return;
  }

  if (request.method === "GET" && parts[3] === "messages") {
    const name = String(url.searchParams.get("name") || "").trim().slice(0, 80);
    let participant = name ? room.participants.find((person) => person.name.toLowerCase() === name.toLowerCase()) : null;
    if (name && !participant && room.status === "closed") {
      json(response, 200, {
        room: code,
        status: "closed",
        active_agents: 0,
        addressed_only: room.addressed_only,
        should_respond: false,
        participants: [],
        latest_message_id: room.next_message_id - 1,
        messages: room.messages.filter((message) => message.kind === "summary").slice(-1),
      }); return;
    }
    if (name && removedEntry(room, name)) { json(response, 403, { error: removedError(room, code, name) }); return; }
    if (name && !participant) { json(response, 403, { error: `${name} is not an active participant in ${code}` }); return; }
    const after = participant ? Number(participant.last_read_id || 0) : Math.max(0, Number(url.searchParams.get("after") || 0));
    const wait = Math.min(300, Math.max(0, Number(url.searchParams.get("wait") || 0)));
    const unread = (candidate) => candidate.id > after && (!name || candidate.sender.toLowerCase() !== name.toLowerCase());
    let messages = room.messages.filter(unread);
    if (!messages.length && room.status === "open" && wait) {
      await waitForChange(code, wait);
      state = loadState();
      room = state.rooms[code];
      messages = room.messages.filter(unread);
      participant = name ? room.participants.find((person) => person.name.toLowerCase() === name.toLowerCase()) : null;
      if (name && removedEntry(room, name)) { json(response, 403, { error: removedError(room, code, name) }); return; }
    }
    const latestMessageId = room.next_message_id - 1;
    if (participant) {
      participant.last_read_id = Math.max(Number(participant.last_read_id || 0), latestMessageId);
      saveState(state);
    }
    const deliveredMessages = messages.map((message) => ({
      ...message,
      addressed_to_you: Boolean(name && addressedTo(message, name)),
    }));
    const shouldRespond = deliveredMessages.some((message) =>
      ["agent", "human"].includes(message.kind) && (!room.addressed_only || message.addressed_to_you)
    );
    json(response, 200, {
      room: code,
      status: room.status,
      active_agents: room.participants.filter((person) => person.role === "agent").length,
      addressed_only: room.addressed_only,
      should_respond: shouldRespond,
      participants: room.participants,
      removed: room.removed || [],
      latest_message_id: latestMessageId,
      messages: deliveredMessages,
    }); return;
  }

  // Download an attachment. Access matches the transcript itself (GET /api/rooms/CODE):
  // the unguessable room code is the capability and the reverse proxy enforces the
  // bearer/Authelia lane — so the browser <img> tag works with just the human cookie and
  // any token holder who knows the code can fetch, exactly as they can already read messages.
  if (request.method === "GET" && parts[3] === "attachments" && parts.length === 5) {
    const entry = (room.attachments || {})[parts[4]];
    if (!entry) { json(response, 404, { error: "Attachment not found" }); return; }
    const file = path.join(ATTACH_DIR, room.code, entry.id);
    let stat;
    try { stat = fs.statSync(file); } catch { json(response, 404, { error: "Attachment file missing" }); return; }
    const asciiName = String(entry.filename || entry.id).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    response.writeHead(200, {
      "content-type": entry.content_type || "application/octet-stream",
      "content-length": stat.size,
      "content-disposition": `${isImageType(entry.content_type) ? "inline" : "attachment"}; filename="${asciiName}"`,
      "cache-control": "private, max-age=31536000, immutable",
    });
    fs.createReadStream(file).pipe(response);
    return;
  }

  if (request.method !== "POST") { json(response, 405, { error: "Method not allowed" }); return; }

  // Attachment upload carries base64 bytes, far larger than a normal message, so it is
  // read with a higher body cap and handled before the shared small-cap readBody below.
  if (parts[3] === "attachments" && parts.length === 4) {
    if (room.status === "closed") { json(response, 409, { error: `Room ${code} is closed` }); return; }
    let uploadBody;
    try { uploadBody = await readBody(request, ATTACH_MAX_UPLOAD_BYTES); }
    catch (error) {
      if (/too large/i.test(error.message)) { json(response, 413, { error: `Attachment exceeds the ${formatBytes(ATTACH_MAX_BYTES)} limit` }); return; }
      throw error;
    }
    const uploader = String(uploadBody.name || room.viewer_name || "User").trim().slice(0, 80) || "User";
    if (removedEntry(room, uploader)) { json(response, 403, { error: removedError(room, code, uploader) }); return; }
    const filename = String(uploadBody.filename || "file").trim().slice(0, 200) || "file";
    const contentType = String(uploadBody.content_type || "").trim().toLowerCase();
    if (!ATTACH_TYPES[contentType]) { json(response, 415, { error: `Unsupported content type '${contentType}'. Allowed: ${Object.keys(ATTACH_TYPES).join(", ")}` }); return; }
    const buffer = Buffer.from(String(uploadBody.data_base64 || ""), "base64");
    if (!buffer.length) { json(response, 400, { error: "data_base64 is required" }); return; }
    if (buffer.length > ATTACH_MAX_BYTES) { json(response, 413, { error: `Attachment is ${formatBytes(buffer.length)}; the limit is ${formatBytes(ATTACH_MAX_BYTES)}` }); return; }
    const id = makeAttachmentId();
    const dir = path.join(ATTACH_DIR, room.code);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id), buffer);
    const entry = {
      id, filename, content_type: contentType, size: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      uploaded_by: uploader, message_id: null, created_at: now(),
    };
    if (!room.attachments || typeof room.attachments !== "object") room.attachments = {};
    room.attachments[id] = entry;
    saveState(state);
    json(response, 201, attachmentSnapshot(entry)); return;
  }

  const body = await readBody(request);

  if (parts[3] === "join") {
    if (room.status === "closed") { json(response, 409, { error: `Room ${code} is closed` }); return; }
    const name = String(body.name || "Agent").trim().slice(0, 80) || "Agent";
    if (removedEntry(room, name)) { json(response, 403, { error: removedError(room, code, name) }); return; }
    if (!room.participants.some((person) => person.name.toLowerCase() === name.toLowerCase())) {
      room.participants.push({ name, role: "agent", joined_at: now(), last_read_id: room.next_message_id - 1, color: nextParticipantColor(room) });
      const joined = addMessage(room, "Room", `${name} joined the meeting.`, "system");
      room.participants.at(-1).last_read_id = joined.id;
      saveState(state); notify(code);
    } else {
      const participant = room.participants.find((person) => person.name.toLowerCase() === name.toLowerCase());
      participant.last_read_id = room.next_message_id - 1;
      saveState(state);
    }
    json(response, 200, publicRoom(room)); return;
  }

  if (parts[3] === "messages") {
    if (room.status === "closed") { json(response, 409, { error: `Room ${code} is closed` }); return; }
    const name = String(body.name || "Agent").trim().slice(0, 80) || "Agent";
    const content = String(body.content || "").trim();
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if (!content && !hasAttachments) { json(response, 400, { error: "Content or an attachment is required" }); return; }
    if (removedEntry(room, name)) { json(response, 403, { error: removedError(room, code, name) }); return; }
    if (!room.participants.some((person) => person.name.toLowerCase() === name.toLowerCase())) room.participants.push({ name, role: "agent", joined_at: now(), last_read_id: room.next_message_id - 1, color: nextParticipantColor(room) });
    const message = addMessage(room, name, content);
    const resolved = resolveAttachments(room, body.attachments, message.id);
    if (resolved.length) message.attachments = resolved;
    saveState(state); notify(code);
    json(response, 201, { message }); return;
  }

  if (parts[3] === "viewer" && parts[4] === "messages") {
    if (room.status === "closed") { json(response, 409, { error: `Room ${code} is closed` }); return; }
    const name = String(room.viewer_name || "User").trim().slice(0, 80) || "User";
    const content = String(body.content || "").trim();
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if (!content && !hasAttachments) { json(response, 400, { error: "Content or an attachment is required" }); return; }
    if (!room.participants.some((person) => person.name.toLowerCase() === name.toLowerCase())) {
      room.participants.push({ name, role: "human", joined_at: now(), color: nextParticipantColor(room) });
      addMessage(room, "Room", `${name} joined the meeting.`, "system");
    }
    const message = addMessage(room, name, content, "human");
    const resolved = resolveAttachments(room, body.attachments, message.id);
    if (resolved.length) message.attachments = resolved;
    saveState(state); notify(code);
    json(response, 201, { message, participants: room.participants }); return;
  }

  if (parts[3] === "viewer" && parts[4] === "leave") {
    const name = String(room.viewer_name || "User").trim().slice(0, 80) || "User";
    const index = room.participants.findIndex((person) => person.name.toLowerCase() === name.toLowerCase());
    if (index >= 0) {
      room.participants.splice(index, 1);
      addMessage(room, "Room", `${name} left the meeting.`, "system");
      saveState(state); notify(code);
    }
    json(response, 200, publicRoom(room)); return;
  }

  // Human-viewer moderation. Removing an agent drops it from the participant list,
  // blocks join/send/listen for that name (403) and wakes its long-poll so the
  // watcher sees the 403 promptly. Re-admit lifts the block; the agent must rejoin.
  if (parts[3] === "viewer" && parts[4] === "remove") {
    if (room.status === "closed") { json(response, 409, { error: `Room ${code} is closed` }); return; }
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) { json(response, 400, { error: "name is required" }); return; }
    const who = String(room.viewer_name || "User").trim().slice(0, 80) || "User";
    const index = room.participants.findIndex((person) => sameName(person.name, name));
    if (sameName(name, room.viewer_name) || (index >= 0 && room.participants[index].role === "human")) { json(response, 400, { error: "The human viewer cannot be removed" }); return; }
    const display = index >= 0 ? room.participants[index].name : name;
    if (index >= 0) room.participants.splice(index, 1);
    if (!Array.isArray(room.removed)) room.removed = [];
    if (!removedEntry(room, display)) room.removed.push(display);
    addMessage(room, "Room", `${who} removed ${display} from the meeting.`, "system");
    saveState(state); notify(code);
    json(response, 200, publicRoom(room)); return;
  }

  if (parts[3] === "viewer" && parts[4] === "readmit") {
    if (room.status === "closed") { json(response, 409, { error: `Room ${code} is closed` }); return; }
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) { json(response, 400, { error: "name is required" }); return; }
    const who = String(room.viewer_name || "User").trim().slice(0, 80) || "User";
    const entry = removedEntry(room, name);
    if (entry) {
      room.removed = room.removed.filter((candidate) => !sameName(candidate, name));
      addMessage(room, "Room", `${who} allowed ${entry} to rejoin the meeting.`, "system");
      saveState(state); notify(code);
    }
    json(response, 200, publicRoom(room)); return;
  }

  if (parts[3] === "mode") {
    const enabled = Boolean(body.addressed_only);
    if (room.addressed_only !== enabled) {
      room.addressed_only = enabled;
      addMessage(room, "Room", `Only speak when addressed is now ${enabled ? "on" : "off"}.`, "system");
      saveState(state); notify(code);
    }
    json(response, 200, publicRoom(room)); return;
  }

  if (parts[3] === "leave") {
    const name = String(body.name || "Agent").trim().slice(0, 80) || "Agent";
    const index = room.participants.findIndex((person) => person.name.toLowerCase() === name.toLowerCase());
    if (index >= 0) {
      room.participants.splice(index, 1);
      addMessage(room, "Room", `${name} left the meeting.`, "system");
      saveState(state); notify(code);
    }
    json(response, 200, publicRoom(room)); return;
  }

  if (parts[3] === "close") {
    const name = String(body.name || "Host").trim().slice(0, 80) || "Host";
    const summary = String(body.summary || "Meeting concluded.").trim().slice(0, 10000) || "Meeting concluded.";
    // Only the creator (chair) or the human viewer may close. Any other agent gets a
    // 403 with guidance, so an over-eager model cannot end a meeting for everyone.
    // A removed name loses every privilege, creator included: "remove" must fully sever control.
    if (room.status !== "closed" && removedEntry(room, name)) { json(response, 403, { error: removedError(room, code, name) }); return; }
    const mayClose = sameName(name, room.created_by) || sameName(name, room.viewer_name)
      || room.participants.some((person) => person.role === "human" && sameName(person.name, name));
    if (!mayClose && room.status !== "closed") {
      json(response, 403, { error: `Only the room creator (${room.created_by || "Host"}) or the human viewer (${room.viewer_name || "User"}) can close ${code}. Post your final message and keep listening, or leave the room instead.` }); return;
    }
    let changed = false;
    if (room.status !== "closed") {
      room.status = "closed"; room.summary = summary;
      addMessage(room, name, `Meeting closed. ${summary}`, "summary");
      changed = true;
    }
    if (room.participants.length) { room.participants = []; changed = true; }
    if (changed) { saveState(state); notify(code); }
    flushTranscripts(state);
    json(response, 200, publicRoom(room)); return;
  }

  json(response, 404, { error: "Not found" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function icon(pathValue, viewBox = "0 0 24 24") {
  return `<svg viewBox="${viewBox}" aria-hidden="true"><path d="${pathValue}"/></svg>`;
}

const ICONS = {
  mic: icon("M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5.3-3a5.3 5.3 0 0 1-10.6 0H5a7 7 0 0 0 6 6.92V21H8v2h8v-2h-3v-3.08A7 7 0 0 0 19 11h-1.7Z"),
  camera: icon("M17 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.5l5 4v-11l-5 4Z"),
  captions: icon("M19 4H5a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3ZM11 11H8.5a1.5 1.5 0 0 0 0 3H11v2H8.5a3.5 3.5 0 0 1 0-7H11v2Zm4.5 5H13v-2h2.5a1.5 1.5 0 0 0 0-3H13V9h2.5a3.5 3.5 0 0 1 0 7Z"),
  hand: icon("M18 11V6.5a1.5 1.5 0 0 0-3 0V10h-1V4.5a1.5 1.5 0 0 0-3 0V10h-1V5.5a1.5 1.5 0 0 0-3 0V12H6V8.5a1.5 1.5 0 0 0-3 0V15c0 4.42 3.58 8 8 8h1a9 9 0 0 0 9-9v-3a1.5 1.5 0 0 0-3 0Z"),
  more: icon("M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"),
  hangup: icon("M21.7 16.6a15.9 15.9 0 0 0-19.4 0 1 1 0 0 0-.3 1.5l2 3a1 1 0 0 0 1.3.3l3.2-1.8a1 1 0 0 0 .5-.9v-2.1a11.7 11.7 0 0 1 6 0v2.1a1 1 0 0 0 .5.9l3.2 1.8a1 1 0 0 0 1.3-.3l2-3a1 1 0 0 0-.3-1.5Z"),
  people: icon("M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3ZM8 11c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3Zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13Zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5Z"),
  chat: icon("M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z"),
  copy: icon("M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"),
  download: icon("M5 20h14v-2H5v2ZM19 9h-4V3H9v6H5l7 7 7-7Z"),
  close: icon("M18.3 5.7 12 12l6.3 6.3-1.4 1.4L12 13.4l-6.3 6.3-1.4-1.4L10.6 12 4.3 5.7l1.4-1.4L12 10.6l6.3-6.3 1.4 1.4Z"),
  clip: icon("M16.5 6.5v10a4.5 4.5 0 1 1-9 0V5a3 3 0 0 1 6 0v9.5a1.5 1.5 0 0 1-3 0V6H8v8.5a3 3 0 0 0 6 0V5a4.5 4.5 0 0 0-9 0v11.5a6 6 0 0 0 12 0v-10h-1.5Z"),
};

function meetingPage(room) {
  const code = JSON.stringify(room.code);
  const initial = JSON.stringify(publicRoom(room)).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(room.title)} · Agent Room</title>
<style>
:root{--bg:#0e1014;--rail:#15181e;--surface:#1b1f26;--surface2:#222730;--line:#2c323c;--text:#f4f6f8;--muted:#929aa6;--green:#34C77B;--blue:#5B8CFF;--red:#ff665d}*{box-sizing:border-box}html,body{height:100%;margin:0}body{overflow:hidden;background:var(--bg);color:var(--text);font-family:"Avenir Next","Segoe UI",sans-serif}.app{height:100%;display:grid;grid-template-rows:70px minmax(0,1fr)}.top{display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid var(--line);background:rgba(14,16,20,.96)}.title{min-width:0}.title h1{font-size:17px;line-height:1.2;margin:0;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;margin-top:5px}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(52,199,123,.14)}.actions{display:flex;align-items:center;gap:8px}.button{height:40px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);padding:0 13px;display:flex;align-items:center;gap:8px;font:600 12px inherit;cursor:pointer;transition:.15s}.button:hover{background:var(--surface2);border-color:#3c4450}.button svg{width:17px;height:17px;fill:currentColor}.button.mode.active{background:#213c30;border-color:#31835b;color:#84e6ae}.mode-light{width:8px;height:8px;border-radius:50%;background:#68717d}.button.mode.active .mode-light{background:var(--green);box-shadow:0 0 0 3px rgba(52,199,123,.16)}.button.leave{width:42px;padding:0;justify-content:center;background:#3b2022;border-color:#5a292d;color:#ff8e87}.button.close-room{background:#3b2022;border-color:#5a292d;color:#ff8e87}.button.close-room:hover{background:#4a2629;border-color:#7a3a40}.button.close-room:disabled{opacity:.45;cursor:not-allowed}.workspace{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:0}.rail{min-height:0;border-right:1px solid var(--line);background:var(--rail);padding:20px 14px;overflow:auto}.rail-label{font-size:10px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:#6f7782;margin:0 8px 10px}.objective{padding:13px 14px;background:var(--surface);border:1px solid var(--line);border-radius:12px;font-size:12px;line-height:1.48;color:#b2b9c3;margin-bottom:22px}.people{display:flex;flex-direction:column;gap:5px}.person{--person:#5B8CFF;display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px}.person.active{background:var(--surface)}.person-avatar,.message-avatar{flex:0 0 auto;display:grid;place-items:center;border-radius:9px;background:color-mix(in srgb,var(--person) 28%,var(--surface2));color:var(--person);font-weight:800;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--person) 55%,transparent)}.person-avatar{width:32px;height:32px;font-size:12px}.person-copy{min-width:0}.person-name{font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.person-role{font-size:10px;color:var(--muted);margin-top:2px;text-transform:capitalize}.presence{width:7px;height:7px;border-radius:50%;background:var(--green);margin-left:auto}.conversation{min-width:0;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;background:radial-gradient(circle at 50% -20%,#1b2029 0,transparent 42%),var(--bg)}.thread{overflow:auto;padding:28px clamp(18px,5vw,72px) 24px;scroll-behavior:smooth}.thread-inner{width:min(900px,100%);margin:0 auto}.dayline{display:flex;align-items:center;gap:14px;color:#68717d;font-size:10px;text-transform:uppercase;letter-spacing:.12em;margin:0 0 22px}.dayline:before,.dayline:after{content:"";height:1px;background:var(--line);flex:1}.message{--person:#5B8CFF;display:grid;grid-template-columns:38px minmax(0,1fr);gap:12px;margin:0 0 20px;animation:arrive .22s ease both}.message-avatar{width:38px;height:38px;font-size:14px}.message-head{display:flex;align-items:baseline;gap:8px;margin:1px 0 4px}.message-name{font-size:13px;font-weight:750;color:var(--person)}.message-role{font-size:9px;line-height:1;padding:4px 6px;border:1px solid color-mix(in srgb,var(--person) 48%,var(--line));border-radius:999px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.message-time{font-size:10px;color:#69717d}.message-text{font-size:15px;line-height:1.55;color:#dce1e7;white-space:pre-wrap;overflow-wrap:anywhere}.message.human .message-text{background:color-mix(in srgb,var(--person) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--person) 34%,var(--line));border-radius:4px 13px 13px 13px;padding:11px 13px}.system{display:flex;justify-content:center;margin:10px 0 18px}.system span{font-size:11px;color:#7e8793;background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:6px 11px}.summary{--person:#34C77B;background:rgba(52,199,123,.09);border:1px solid rgba(52,199,123,.3);border-radius:14px;padding:14px;margin-bottom:20px}.summary .message-text{color:#dff7e7}.composer{border-top:1px solid var(--line);padding:14px clamp(18px,5vw,72px) 18px;background:rgba(14,16,20,.95);backdrop-filter:blur(12px)}.composer-inner{width:min(900px,100%);margin:0 auto}.composer-label{display:block;color:#747d88;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0 0 7px 3px}.composer-row{display:flex;align-items:flex-end;gap:9px}.composer textarea{flex:1;min-height:46px;max-height:128px;resize:none;border:1px solid var(--line);border-radius:13px;padding:12px 14px;background:var(--surface);color:var(--text);font:14px/1.4 inherit;outline:none}.composer textarea:focus{border-color:#5B8CFF;box-shadow:0 0 0 3px rgba(91,140,255,.12)}.send{width:46px;height:46px;border:0;border-radius:13px;background:var(--blue);color:#0b0f16;font-size:20px;font-weight:800;cursor:pointer}.send:disabled,.composer textarea:disabled{opacity:.45;cursor:not-allowed}.person-remove,.person-readmit{margin-left:auto;flex:0 0 auto;border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:7px;cursor:pointer;font:inherit}.person-remove{width:24px;height:24px;font-size:15px;line-height:1;padding:0}.person-remove:hover{background:#3b2022;border-color:#5a292d;color:#ff8e87}.person-remove:disabled,.person-readmit:disabled{opacity:.45;cursor:not-allowed}.person-readmit{font-size:10px;font-weight:700;padding:4px 7px}.person-readmit:hover{background:var(--surface2);color:var(--text)}.person.removed{opacity:.6;--person:#68717d}.rail-label.removed-label{margin-top:22px}.banner{position:fixed;top:0;left:0;right:0;z-index:60;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:14px;padding:10px 16px;background:#5a2a10;color:#ffd9b8;border-bottom:1px solid #8a4a1e;font-size:13px;font-weight:600;box-shadow:0 8px 30px rgba(0,0,0,.4)}.banner button{border:1px solid #ffb877;background:#ffb877;color:#2a1608;border-radius:8px;padding:6px 12px;font:700 12px inherit;cursor:pointer}.banner[hidden]{display:none}.toast{position:fixed;left:50%;bottom:90px;transform:translate(-50%,8px);padding:10px 14px;border-radius:9px;background:#f2f4f7;color:#171a1f;font-size:12px;opacity:0;pointer-events:none;transition:.18s;box-shadow:0 12px 40px rgba(0,0,0,.35)}.toast.show{opacity:1;transform:translate(-50%,0)}@keyframes arrive{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}@media(max-width:720px){.workspace{grid-template-columns:1fr}.rail{display:none}.top{padding:0 12px}.button span{display:none}.button{width:40px;padding:0;justify-content:center}.thread{padding:20px 14px}.composer{padding:12px 14px 14px}.title h1{font-size:15px}}
.atts{display:flex;flex-wrap:wrap;gap:10px;margin-top:9px}.att-img{display:block;max-width:320px;line-height:0}.att-img img{max-width:320px;max-height:280px;border-radius:10px;border:1px solid var(--line);display:block}.att-doc{display:inline-flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 11px;color:var(--text);text-decoration:none;font-size:13px;max-width:100%}.att-doc:hover{border-color:#3c4450;background:var(--surface2)}.att-doc svg{width:18px;height:18px;fill:var(--muted);flex:0 0 auto}.att-doc span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.att-doc em{color:var(--muted);font-style:normal;font-size:11px;flex:0 0 auto}
.pending{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 9px 3px}.chip{display:inline-flex;align-items:center;gap:6px;background:var(--surface2);border:1px solid var(--line);border-radius:8px;padding:5px 9px;font-size:12px;color:var(--text);max-width:240px}.chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chip em{color:var(--muted);font-style:normal;flex:0 0 auto}.chip button{border:0;background:none;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;padding:0;flex:0 0 auto}.chip button:hover{color:#ff8e87}.attach-btn{width:46px;height:46px;flex:0 0 auto;border:1px solid var(--line);border-radius:13px;background:var(--surface);color:var(--muted);cursor:pointer;display:grid;place-items:center;transition:.15s}.attach-btn:hover{background:var(--surface2);color:var(--text)}.attach-btn svg{width:20px;height:20px;fill:currentColor}.attach-btn:disabled{opacity:.45;cursor:not-allowed}body.dragging .composer{outline:2px dashed var(--blue);outline-offset:-6px;border-radius:10px}
</style></head><body><div class="app"><header class="top"><div class="title"><h1>${escapeHtml(room.title)}</h1><div class="meta"><span class="status-dot"></span><span id="status">${escapeHtml(room.status)}</span><span>·</span><span>${escapeHtml(room.code)}</span><span>·</span><span id="clock"></span><span>·</span><span id="updated" title="Time of the last successful update from the server"></span></div></div><div class="actions"><button class="button mode" id="mode" title="Agents only respond when named"><span class="mode-light"></span><span>Only when addressed</span></button><button class="button" id="export">${ICONS.download}<span>Export</span></button><button class="button" id="copy">${ICONS.copy}<span>Copy invite</span></button><button class="button close-room" id="closeRoom" title="Close this room for everyone" ${room.status === "closed" ? "disabled" : ""}>${ICONS.close}<span>Close room</span></button><button class="button leave" id="leave" title="Leave room">${ICONS.hangup}</button></div></header><main class="workspace"><aside class="rail"><div class="rail-label">Objective</div><div class="objective">${escapeHtml(room.objective)}</div><div class="rail-label">In this room · <span id="count">${room.participants.length}</span></div><div class="people" id="people"></div><div class="rail-label removed-label" id="removedLabel" hidden>Removed</div><div class="people" id="removed"></div></aside><section class="conversation"><div class="thread" id="thread"><div class="thread-inner"><div class="dayline">Live transcript</div><div id="messages"></div></div></div><form class="composer" id="composer"><div class="composer-inner"><label class="composer-label" for="message">Message as ${escapeHtml(room.viewer_name || "User")}</label><div class="pending" id="pending" hidden></div><div class="composer-row"><input type="file" id="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md" multiple hidden><button type="button" class="attach-btn" id="attach" title="Attach image or document (or paste / drag one in)" aria-label="Attach a file" ${room.status === "closed" ? "disabled" : ""}>${ICONS.clip}</button><textarea id="message" rows="1" maxlength="20000" placeholder="Add to the conversation…" ${room.status === "closed" ? "disabled" : ""}></textarea><button class="send" id="send" type="submit" aria-label="Send" ${room.status === "closed" ? "disabled" : ""}>↑</button></div></div></form></section></main></div><div class="banner" id="banner" hidden role="alert"><span id="bannerText"></span><button id="bannerAction" type="button"></button></div><div class="toast" id="toast"></div>
<script>const ROOM=${initial};const code=${code};let cursor=0;let addressedOnly=Boolean(ROOM.addressed_only);const colors=['#5B8CFF','#FF6B5E','#34C77B','#F2B134','#A970FF','#20B8CC','#F05DAA','#78C442','#F28A3E','#6E79FF'];const el=id=>document.getElementById(id);const esc=s=>{const d=document.createElement('div');d.textContent=s;return d.innerHTML};const colorFor=s=>ROOM.participants.find(p=>p.name===s)?.color||colors[[...s].reduce((a,c)=>a+c.charCodeAt(0),0)%colors.length];const timeOf=s=>new Date(s).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});const participantFor=name=>ROOM.participants.find(p=>p.name===name)||{name,role:name===ROOM.viewer_name?'human':'agent',color:colorFor(name)};
const isOpen=()=>el('status').textContent!=='closed';
const docIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6Zm7 1.5L18.5 9H13V3.5Z"/></svg>';
const fmtBytes=n=>{n=Number(n)||0;if(n<1024)return n+'B';if(n<1048576)return Math.round(n/1024)+'KB';return (n/1048576).toFixed(1)+'MB'};
const isImg=ct=>/^image\\//.test(ct||'');
const attUrl=id=>'/api/rooms/'+encodeURIComponent(code)+'/attachments/'+encodeURIComponent(id);
function attHtml(m){const a=m.attachments||[];if(!a.length)return '';return '<div class="atts">'+a.map(x=>{const u=attUrl(x.id);return isImg(x.content_type)?'<a class="att-img" href="'+u+'" target="_blank" rel="noopener"><img loading="lazy" src="'+u+'" alt="'+esc(x.filename)+'"></a>':'<a class="att-doc" href="'+u+'" target="_blank" rel="noopener" download="'+esc(x.filename)+'">'+docIcon+'<span>'+esc(x.filename)+'</span><em>'+fmtBytes(x.size)+'</em></a>'}).join('')+'</div>'}
function renderPeople(list,active){ROOM.participants=list;el('count').textContent=list.length;el('people').innerHTML=list.length?list.map(p=>'<div class="person '+(p.name===active?'active':'')+'" style="--person:'+(p.color||colorFor(p.name))+'"><div class="person-avatar">'+esc(p.name.slice(0,1).toUpperCase())+'</div><div class="person-copy"><div class="person-name">'+esc(p.name)+'</div><div class="person-role">'+(p.role==='human'?'Human':'Agent')+'</div></div>'+(p.role!=='human'&&isOpen()?'<button class="person-remove" type="button" data-name="'+esc(p.name)+'" title="Remove '+esc(p.name)+' from this room" aria-label="Remove '+esc(p.name)+'">×</button>':'<span class="presence"></span>')+'</div>').join(''):'<div class="objective">No active participants</div>'}
function renderRemoved(list){ROOM.removed=Array.isArray(list)?list:[];el('removedLabel').hidden=!ROOM.removed.length;el('removed').innerHTML=ROOM.removed.map(n=>'<div class="person removed"><div class="person-avatar">'+esc(n.slice(0,1).toUpperCase())+'</div><div class="person-copy"><div class="person-name">'+esc(n)+'</div><div class="person-role">Removed</div></div>'+(isOpen()?'<button class="person-readmit" type="button" data-name="'+esc(n)+'" title="Allow '+esc(n)+' to rejoin">Re-admit</button>':'')+'</div>').join('')}
const F=(u,o={})=>fetch(u,{redirect:'manual',cache:'no-store',...o});
function showBanner(text,action,onAction){el('bannerText').textContent=text;const b=el('bannerAction');b.textContent=action||'';b.hidden=!action;b.onclick=onAction||null;el('banner').hidden=false}
function hideBanner(){el('banner').hidden=true}
function expired(){showBanner('Your sign-in session has expired. New messages are not being received.','Sign in again',()=>location.reload())}
async function jsonOf(response){if(response.type==='opaqueredirect'||response.status===401){expired();const e=new Error('Session expired — sign in again');e.expired=true;throw e}const ct=response.headers.get('content-type')||'';if(!ct.includes('json'))throw new Error('HTTP '+response.status+' from the proxy');return response.json()}
function markUpdated(){el('updated').textContent='updated '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
function addMessage(m,animate=true){cursor=Math.max(cursor,m.id);const item=document.createElement('article');if(!animate)item.style.animation='none';if(m.kind==='system'){item.className='system';item.innerHTML=\`<span>\${esc(m.content)}</span>\`}else{const p=participantFor(m.sender);item.className='message '+m.kind;item.style.setProperty('--person',p.color||colorFor(m.sender));item.innerHTML=\`<div class="message-avatar">\${esc(m.sender.slice(0,1).toUpperCase())}</div><div><div class="message-head"><span class="message-name">\${esc(m.sender)}</span><span class="message-role">\${m.kind==='human'?'Human':m.kind==='summary'?'Decision':p.role||'Agent'}</span><span class="message-time">\${timeOf(m.created_at)}</span></div><div class="message-text">\${esc(m.content)}</div>\${attHtml(m)}</div>\`}el('messages').appendChild(item);el('thread').scrollTop=el('thread').scrollHeight}
function renderMode(enabled){addressedOnly=Boolean(enabled);el('mode').classList.toggle('active',addressedOnly);el('mode').setAttribute('aria-pressed',String(addressedOnly));el('message').placeholder=addressedOnly?'Mention an agent by name to request a response…':'Add to the conversation…'}
function hydrate(){renderMode(addressedOnly);renderPeople(ROOM.participants,ROOM.messages.filter(m=>m.kind==='agent'||m.kind==='human').at(-1)?.sender);renderRemoved(ROOM.removed);ROOM.messages.forEach(m=>addMessage(m,false));markUpdated();el('clock').textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});setInterval(()=>el('clock').textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),30000)}
let failures=0;
async function poll(){let closed=false;let delay=350;try{const response=await F(\`/api/rooms/\${code}/messages?after=\${cursor}&wait=25\`);const data=await jsonOf(response);if(!response.ok)throw new Error(data.error||'HTTP '+response.status);failures=0;hideBanner();markUpdated();el('status').textContent=data.status;const active=data.messages.filter(m=>m.kind==='agent'||m.kind==='human').at(-1)?.sender;renderMode(data.addressed_only);renderPeople(data.participants||[],active);renderRemoved(data.removed||ROOM.removed);data.messages.forEach(m=>addMessage(m));closed=data.status==='closed';if(closed){el('message').disabled=true;el('send').disabled=true;el('mode').disabled=true;el('closeRoom').disabled=true;el('attach').disabled=true;renderPeople(data.participants||[],active);renderRemoved(data.removed||ROOM.removed)}}catch(error){if(error.expired)return;failures+=1;delay=Math.min(15000,1000*failures);showBanner('Connection lost ('+error.message+'). Retrying… New messages are not being received.','Reload',()=>location.reload())}if(!closed)setTimeout(poll,delay)}
function toast(message){el('toast').textContent=message;el('toast').classList.add('show');setTimeout(()=>el('toast').classList.remove('show'),1800)}let pending=[];const ATT_TYPES={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',txt:'text/plain',md:'text/markdown'};const ATT_ALLOWED=['image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain','text/markdown'];const ATT_MAX=10*1048576;
function renderPending(){const box=el('pending');box.hidden=!pending.length;box.innerHTML=pending.map((p,i)=>'<span class="chip">'+(isImg(p.content_type)?'🖼':'📄')+'<span>'+esc(p.filename)+'</span><em>'+fmtBytes(p.size)+'</em><button type="button" data-i="'+i+'" aria-label="Remove attachment">×</button></span>').join('')}
function typeOf(file){const ct=(file.type||'').toLowerCase();if(ct&&ATT_ALLOWED.includes(ct))return ct;return ATT_TYPES[(file.name||'').split('.').pop().toLowerCase()]||ct}
async function uploadFile(file){const ct=typeOf(file);if(!ATT_ALLOWED.includes(ct)){toast('Unsupported: '+(file.name||'file'));return}if(file.size>ATT_MAX){toast((file.name||'file')+' is too big (max 10MB)');return}try{const buf=new Uint8Array(await file.arrayBuffer());let bin='';for(let i=0;i<buf.length;i+=0x8000)bin+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000));const r=await F('/api/rooms/'+encodeURIComponent(code)+'/attachments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({filename:file.name||'file',content_type:ct,data_base64:btoa(bin)})});const d=await jsonOf(r);if(!r.ok)throw new Error(d.error||'Upload failed');pending.push(d);renderPending();toast('Attached '+(d.filename||'file'))}catch(e){toast(e.message)}}
async function handleFiles(files){for(const f of files){if(!isOpen())break;await uploadFile(f)}}
async function sendViewerMessage(){const content=el('message').value.trim();if(!content&&!pending.length)return;el('send').disabled=true;try{const body={content};if(pending.length)body.attachments=pending.map(p=>p.id);const response=await F(\`/api/rooms/\${code}/viewer/messages\`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await jsonOf(response);if(!response.ok)throw new Error(data.error||'Could not send message');el('message').value='';pending=[];renderPending();renderPeople(data.participants||ROOM.participants,data.message.sender)}catch(error){toast(error.message)}finally{if(el('status').textContent!=='closed')el('send').disabled=false}}
el('composer').onsubmit=e=>{e.preventDefault();sendViewerMessage()};el('message').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendViewerMessage()}};el('mode').onclick=async()=>{el('mode').disabled=true;try{const response=await F(\`/api/rooms/\${code}/mode\`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({addressed_only:!addressedOnly})});const data=await jsonOf(response);if(!response.ok)throw new Error(data.error||'Could not change mode');renderMode(data.addressed_only);toast(data.addressed_only?'Agents will only reply when named':'Agents may reply normally')}catch(error){toast(error.message)}finally{el('mode').disabled=false}};el('copy').onclick=async()=>{await navigator.clipboard.writeText(ROOM.invitation);toast('Agent invitation copied')};el('leave').onclick=async()=>{try{await fetch(\`/api/rooms/\${code}/viewer/leave\`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})}finally{location.href='/'}};
el('attach').onclick=()=>el('file').click();el('file').onchange=e=>{handleFiles([...e.target.files]);e.target.value=''};el('pending').onclick=e=>{const b=e.target.closest('button[data-i]');if(!b)return;pending.splice(Number(b.dataset.i),1);renderPending()};el('message').addEventListener('paste',e=>{const items=[...((e.clipboardData&&e.clipboardData.items)||[])];const files=items.filter(i=>i.kind==='file').map(i=>i.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();handleFiles(files)}});document.addEventListener('dragover',e=>{e.preventDefault();if(isOpen())document.body.classList.add('dragging')});document.addEventListener('dragleave',e=>{if(e.relatedTarget===null)document.body.classList.remove('dragging')});document.addEventListener('drop',e=>{e.preventDefault();document.body.classList.remove('dragging');if(!isOpen())return;const files=[...((e.dataTransfer&&e.dataTransfer.files)||[])];if(files.length)handleFiles(files)});
function dlFile(name,text,type){const b=new Blob([text],{type});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1500)}
async function fetchRoom(){const r=await fetch('/api/rooms/'+code);if(!r.ok)throw new Error('Could not load transcript');return r.json()}
function roleOf(m){return m.kind==='human'?'Human':m.kind==='summary'?'Decision':'Agent'}
function mdOf(d){const L=['# '+d.title,'','- **Room:** '+d.code];if(d.objective)L.push('- **Objective:** '+d.objective);L.push('- **Status:** '+d.status,'- **Exported:** '+new Date().toLocaleString(),'','---','');for(const m of d.messages){if(m.kind==='system'){L.push('_'+m.content+'_','');continue}L.push('### '+m.sender+' · '+roleOf(m)+' · '+new Date(m.created_at).toLocaleString(),'',m.content,'');(m.attachments||[]).forEach(x=>{const u=location.origin+attUrl(x.id);L.push(isImg(x.content_type)?'!['+x.filename+']('+u+')':'['+x.filename+' ('+fmtBytes(x.size)+')]('+u+')','')})}if(d.summary)L.push('---','','**Summary:** '+d.summary,'');return L.join('\\n')}
function htmlOf(d){const e2=s=>{const x=document.createElement('div');x.textContent=s;return x.innerHTML};const rows=d.messages.map(m=>{const t=new Date(m.created_at).toLocaleString();if(m.kind==='system')return '<p class="sys">'+e2(m.content)+'</p>';const atts=(m.attachments||[]).map(x=>{const u=location.origin+attUrl(x.id);return isImg(x.content_type)?'<div><img src="'+u+'" style="max-width:320px;max-height:280px;border-radius:8px"></div>':'<div><a href="'+u+'">'+e2(x.filename)+' ('+fmtBytes(x.size)+')</a></div>'}).join('');return '<div class="msg"><div class="h"><b>'+e2(m.sender)+'</b> <span>'+roleOf(m)+'</span> <time>'+t+'</time></div><div class="c">'+e2(m.content)+'</div>'+atts+'</div>'}).join('');return '<!doctype html><html><head><meta charset="utf-8"><title>'+e2(d.title)+'</title><style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 20px}h1{margin:0 0 4px}.meta{color:#555;font-size:12px;margin-bottom:16px}hr{border:0;border-top:1px solid #ddd;margin:16px 0}.msg{margin:0 0 13px}.h{font-size:12px;color:#333}.h span{color:#888;text-transform:uppercase;font-size:10px;margin-left:4px}.h time{color:#999;margin-left:6px}.c{white-space:pre-wrap;margin-top:2px}.sys{color:#888;font-style:italic;text-align:center;font-size:12px;margin:8px 0}@media print{body{margin:0}}</style></head><body><h1>'+e2(d.title)+'</h1><div class="meta">Room '+e2(d.code)+' · '+e2(d.status)+' · Exported '+new Date().toLocaleString()+(d.objective?' · '+e2(d.objective):'')+'</div><hr>'+rows+(d.summary?'<hr><p><b>Summary:</b> '+e2(d.summary)+'</p>':'')+'</body></html>'}
function printHtml(html){const f=document.createElement('iframe');f.setAttribute('aria-hidden','true');f.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0';f.srcdoc=html;f.onload=()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){}setTimeout(()=>f.remove(),1000)};document.body.appendChild(f)}
async function doExport(kind){try{const d=await fetchRoom();if(kind==='md'){dlFile('room-'+d.code+'.md',mdOf(d),'text/markdown');toast('Markdown downloaded')}else{printHtml(htmlOf(d));toast('Opening print dialog…')}}catch(e){toast(e.message)}}
el('export').onclick=ev=>{ev.stopPropagation();const old=document.getElementById('exportMenu');if(old){old.remove();return}const m=document.createElement('div');m.id='exportMenu';const b=el('export').getBoundingClientRect();m.style.cssText='position:fixed;top:'+(b.bottom+6)+'px;left:'+b.left+'px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:5px;z-index:50;box-shadow:0 12px 40px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:2px;min-width:160px';m.innerHTML='<button class="exi" data-k="md">Markdown (.md)</button><button class="exi" data-k="pdf">PDF (print)</button>';m.querySelectorAll('.exi').forEach(x=>{x.style.cssText='background:none;border:0;color:var(--text);text-align:left;padding:9px 11px;border-radius:7px;cursor:pointer;font:inherit;font-size:13px';x.onmouseenter=()=>x.style.background='var(--surface2)';x.onmouseleave=()=>x.style.background='none';x.onclick=()=>{m.remove();doExport(x.dataset.k)}});document.body.appendChild(m)};
document.addEventListener('click',()=>{const m=document.getElementById('exportMenu');if(m)m.remove()});
el('closeRoom').onclick=async()=>{if(!confirm('Close this room for everyone? Agents will stop and the transcript is frozen.'))return;const who=String(ROOM.viewer_name||'User');const summary=prompt('Optional closing summary:','Closed by '+who+' from the viewer');if(summary===null)return;el('closeRoom').disabled=true;try{const response=await F('/api/rooms/'+encodeURIComponent(code)+'/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:who,summary:summary.trim()||'Closed from the viewer'})});const data=await jsonOf(response);if(!response.ok)throw new Error(data.error||'Could not close room');toast('Room closed')}catch(error){toast(error.message);el('closeRoom').disabled=false}};
el('people').onclick=async e=>{const b=e.target.closest('.person-remove');if(!b)return;const name=b.dataset.name;if(!confirm('Remove '+name+' from this room? It will be blocked from rejoining until you re-admit it.'))return;b.disabled=true;try{const response=await F('/api/rooms/'+encodeURIComponent(code)+'/viewer/remove',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});const data=await jsonOf(response);if(!response.ok)throw new Error(data.error||'Could not remove '+name);renderPeople(data.participants||[]);renderRemoved(data.removed||[]);toast(name+' removed')}catch(error){toast(error.message);b.disabled=false}};
el('removed').onclick=async e=>{const b=e.target.closest('.person-readmit');if(!b)return;const name=b.dataset.name;b.disabled=true;try{const response=await F('/api/rooms/'+encodeURIComponent(code)+'/viewer/readmit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});const data=await jsonOf(response);if(!response.ok)throw new Error(data.error||'Could not re-admit '+name);renderRemoved(data.removed||[]);toast(name+' may rejoin')}catch(error){toast(error.message);b.disabled=false}};
hydrate();poll();</script></body></html>`;
}

function landingPage() {
  // The landing page (no room code in the URL) lists open rooms when GET /api/rooms is
  // enabled on this server. The list is built with createElement/textContent only — no
  // API data ever reaches innerHTML — and it stays hidden if the endpoint answers 404
  // (gated off), so the page degrades to the static card. Meeting pages never show it.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Room</title><style>html,body{margin:0}body{min-height:100vh;box-sizing:border-box;padding:6vh 0 48px;display:grid;place-items:start center;background:#202124;color:#f1f3f4;font-family:"Avenir Next","Segoe UI",sans-serif}.card{width:min(620px,88vw);padding:48px;border:1px solid #4a4d51;border-radius:20px;background:#2d2e30;box-shadow:0 30px 90px rgba(0,0,0,.35)}.mark{width:54px;height:54px;border-radius:16px;background:#8ab4f8;color:#202124;display:grid;place-items:center;font-size:24px;font-weight:700}h1{font-size:52px;letter-spacing:-.045em;margin:28px 0 12px}p{color:#bdc1c6;font-size:18px;line-height:1.55}code{display:block;margin-top:28px;padding:16px;background:#202124;border-radius:10px;color:#81c995;overflow:auto}.rooms{margin-top:30px}.rooms-label{font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:#9aa0a6;margin-bottom:10px}.room{display:block;padding:14px 16px;margin-top:10px;border:1px solid #4a4d51;border-radius:12px;background:#202124;color:inherit;text-decoration:none;transition:.15s}.room:hover{border-color:#8ab4f8;background:#26282b}.room-title{font-size:16px;font-weight:700}.room-meta{font-size:12px;color:#9aa0a6;margin-top:4px}.rooms-empty{font-size:15px;color:#9aa0a6;margin:0}.room-row{display:flex;gap:8px;align-items:stretch;margin-top:10px}.room-row .room{flex:1;margin-top:0}.room-close{flex:0 0 44px;border:1px solid #4a4d51;border-radius:12px;background:#202124;color:#9aa0a6;font-size:20px;line-height:1;cursor:pointer;transition:.15s}.room-close:hover{color:#ff8e87;border-color:#5a292d;background:#3b2022}.room-close:disabled{opacity:.45;cursor:not-allowed}</style></head><body><main class="card"><div class="mark">A</div><h1>Agents, meet.</h1><p>Create a private localhost room from your terminal, paste the invitation into another agent, and watch them work through the decision together.</p><section id="rooms" class="rooms" hidden></section><code>agent_room.mjs create --title "Reliability review" --name "Fable"</code></main>
<script>(function(){var sec=document.getElementById('rooms');function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
fetch('/api/rooms?status=open').then(function(r){if(!r.ok)throw new Error('unavailable');return r.json();}).then(function(d){var list=(d&&d.rooms)||[];sec.textContent='';sec.appendChild(el('div','rooms-label','Active rooms · '+list.length));if(!list.length){sec.appendChild(el('p','rooms-empty','No active rooms right now.'));}list.forEach(function(room){var codeStr=String(room.code||'');var title=String(room.title||'Untitled');var row=el('div','room-row');var a=el('a','room');a.href='/rooms/'+encodeURIComponent(codeStr);a.appendChild(el('div','room-title',title));var when='';if(room.updated_at){var t=new Date(room.updated_at);if(!isNaN(t))when=t.toLocaleString();}a.appendChild(el('div','room-meta',codeStr+' · '+(Number(room.participant_count)||0)+' in room · '+(Number(room.active_agents)||0)+' agents'+(when?' · '+when:'')));row.appendChild(a);var x=el('button','room-close','×');x.type='button';x.title='Close this room for everyone';x.setAttribute('aria-label','Close room '+title);x.onclick=function(ev){ev.preventDefault();ev.stopPropagation();if(!confirm('Close "'+title+'" for everyone? Agents will stop and the transcript is frozen.'))return;x.disabled=true;fetch('/api/rooms/'+encodeURIComponent(codeStr)+'/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:String(room.viewer_name||'User'),summary:'Closed from the room list'})}).then(function(r){if(!r.ok)throw new Error('Could not close room');row.remove();var left=sec.querySelectorAll('.room-row').length;var lab=sec.querySelector('.rooms-label');if(lab)lab.textContent='Active rooms · '+left;if(!left)sec.appendChild(el('p','rooms-empty','No active rooms right now.'));}).catch(function(e){x.disabled=false;alert(e.message);});};row.appendChild(x);sec.appendChild(row);});sec.hidden=false;}).catch(function(){sec.hidden=true;});})();</script></body></html>`;
}

function notFoundPage(code) {
  return `<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#202124;color:#f1f3f4;font-family:sans-serif"><main><h1>Room ${escapeHtml(code)} not found</h1><p style="color:#bdc1c6">Check the room code and local server.</p></main></body></html>`;
}

function startServer() {
  ensureDir();
  migrateState();
  migrateTranscripts();
  setInterval(pruneClosedRooms, 6 * 3600000).unref();
  const server = http.createServer((request, response) => route(request, response).catch((error) => json(response, 400, { error: error.message })));
  server.listen(PORT, BIND_HOST, () => {
    fs.writeFileSync(PID_PATH, String(process.pid));
    process.stdout.write(`Agent Room ${VERSION} listening on ${BIND_HOST}:${PORT} (public: ${PUBLIC_URL}); transcripts in ${TRANSCRIPT_DIR}\n`);
  });
  const close = () => server.close(() => {
    try { flushTranscripts(loadState()); } catch {}
    try { if (fs.readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_PATH); } catch {}
    process.exit(0);
  });
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

async function api(method, endpoint, body, timeout = 35000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  // Build headers explicitly so the bearer is attached on every request (incl. GET/long-poll),
  // not only when there's a JSON body. Never interpolate TOKEN into an error/log string.
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (TOKEN) headers["authorization"] = `Bearer ${TOKEN}`;
  try {
    const response = await fetch(REMOTE_URL + endpoint, {
      method, signal: controller.signal,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    // A reverse proxy can answer with a non-JSON body (e.g. a 401 HTML page when
    // the bearer token is missing/wrong). Parse defensively so agents get a clear
    // message instead of a JSON syntax error.
    const raw = await response.text();
    let value = null;
    if (raw) { try { value = JSON.parse(raw); } catch { value = null; } }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        // The app itself answers 403 with a JSON reason (removed from the room, not
        // allowed to close, ...). Only a bare/HTML 401/403 means the proxy rejected the token.
        if (value?.error) throw new Error(`${response.status}: ${value.error}`);
        throw new Error(`${response.status} unauthorized at ${REMOTE_URL} — check AGENT_ROOM_TOKEN / proxy auth`);
      }
      throw new Error(value?.error || `HTTP ${response.status} from ${REMOTE_URL}`);
    }
    return value ?? {};
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Request timed out at ${REMOTE_URL}`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function health() {
  try { return await api("GET", "/api/health", undefined, 800); } catch { return null; }
}

async function healthy() {
  return Boolean(await health());
}

async function stopExistingServer() {
  let pid;
  try { pid = Number(fs.readFileSync(PID_PATH, "utf8").trim()); } catch {}
  if (!pid) throw new Error(`An older Agent Room server is running, but its PID is unavailable at ${PID_PATH}`);
  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!(await healthy())) return;
  }
  throw new Error(`Could not replace older Agent Room process ${pid}`);
}

async function ensureServer() {
  const running = await health();
  if (running?.version === VERSION) return;
  if (running) await stopExistingServer();
  ensureDir();
  const log = fs.openSync(LOG_PATH, "a");
  const child = spawn(process.execPath, [SCRIPT_PATH, "serve"], { detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await healthy()) return;
  }
  throw new Error(`Could not start Agent Room at ${REMOTE_URL}. See ${LOG_PATH}`);
}

function argsOf(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const parsed = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
      // A flag repeated on the command line (e.g. --attach a --attach b) collects into an array.
      result[key] = key in result ? [].concat(result[key], parsed) : parsed;
    } else result._.push(value);
  }
  return result;
}

function messagesText(messages) {
  if (!messages.length) return "No new messages. Continue listening unless a stop condition has been met.";
  return messages.map((m) => {
    const refs = (m.attachments || []).map((a) => `\n  ↳ ${attachmentRefText(a)}`).join("");
    return `#${m.id} [${m.kind}] ${m.sender}: ${m.content}${refs}`;
  }).join("\n\n");
}

function roomToMarkdown(room) {
  const lines = [`# ${room.title}`, "", `- **Room:** ${room.code}`];
  if (room.objective) lines.push(`- **Objective:** ${room.objective}`);
  lines.push(`- **Status:** ${room.status}`, "", "---", "");
  for (const message of room.messages || []) {
    if (message.kind === "system") { lines.push(`_${message.content}_`, ""); continue; }
    const role = message.kind === "human" ? "Human" : message.kind === "summary" ? "Decision" : "Agent";
    lines.push(`### ${message.sender} · ${role} · ${message.created_at}`, "", message.content, "");
    for (const attachment of message.attachments || []) {
      const url = `${PUBLIC_URL}/api/rooms/${room.code}/attachments/${attachment.id}`;
      lines.push(isImageType(attachment.content_type) ? `![${attachment.filename}](${url})` : `[${attachment.filename} (${formatBytes(attachment.size)})](${url})`, "");
    }
  }
  if (room.summary) lines.push("---", "", `**Summary:** ${room.summary}`, "");
  return lines.join("\n");
}

function responseGuidance(result) {
  if (result.status === "closed") return "Meeting closed. Do not reply or poll again.";
  if (!result.addressed_only) return "Response mode: normal.";
  if (result.should_respond) return "Response mode: ONLY WHEN ADDRESSED. Your name was addressed; respond if useful, then wait again.";
  return "Response mode: ONLY WHEN ADDRESSED. Your name was not addressed. Do not send any acknowledgement or commentary; stay silent and listen again.";
}

function required(args, key) {
  if (!args[key]) throw new Error(`--${key} is required`);
  return args[key];
}

async function main() {
  const command = process.argv[2];
  const args = argsOf(process.argv.slice(3));
  if (!command) { console.log("Usage: agent_room.mjs <start|stop|create|invite|join|send|listen|status|leave|transcript|export|close|open>"); return; }
  if (command === "serve") { startServer(); return; }
  if (args["user-name"]) {
    const userName = String(args["user-name"]).trim().slice(0, 80);
    if (!userName) throw new Error("--user-name cannot be empty");
    saveConfig({ ...loadConfig(), user_name: userName });
  }
  if (command === "start") {
    if (IS_REMOTE) throw new Error(`start runs a LOCAL server, but the client is pointed at ${REMOTE_URL}. Set AGENT_ROOM_REMOTE_URL=http://127.0.0.1:${PORT} to run one locally.`);
    await ensureServer(); console.log(`Agent Room is running at ${PUBLIC_URL} for ${loadConfig().user_name || "User"}`); return;
  }
  if (command === "stop") {
    if (IS_REMOTE) throw new Error(`stop manages a LOCAL server, but the client is pointed at ${REMOTE_URL}. Set AGENT_ROOM_REMOTE_URL=http://127.0.0.1:${PORT} to target a local server.`);
    if (!(await healthy())) { console.log("Agent Room is not running."); return; }
    const pid = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    process.kill(pid, "SIGTERM");
    for (let index = 0; index < 40; index += 1) { await new Promise((resolve) => setTimeout(resolve, 100)); if (!(await healthy())) { console.log("Agent Room stopped."); return; } }
    throw new Error(`Agent Room process ${pid} did not stop cleanly`);
  }
  if (!IS_REMOTE) await ensureServer();
  const roomCode = String(args._[0] || "").toUpperCase();
  if (command === "create") {
    const room = await api("POST", "/api/rooms", { title: required(args, "title"), objective: args.objective, name: args.name || "Host", user_name: args["user-name"] });
    console.log(room.invitation); return;
  }
  if (!roomCode) throw new Error("Room code is required");
  if (command === "invite") { console.log((await api("GET", `/api/rooms/${roomCode}`)).invitation); return; }
  if (command === "join") {
    const room = await api("POST", `/api/rooms/${roomCode}/join`, { name: required(args, "name") });
    console.log(`Joined ${room.code}: ${room.title}\nObjective: ${room.objective}\nStatus: ${room.status} | Response mode: ${room.addressed_only ? "only when addressed" : "normal"} | Viewer: ${room.viewer_url}\n\nTranscript\n\n${messagesText(room.messages)}`); return;
  }
  if (command === "send") {
    const name = required(args, "name");
    // --attach <path> (repeatable): upload each file first, then reference the ids in the message.
    const attachPaths = args.attach == null || args.attach === true ? [] : [].concat(args.attach).filter((value) => typeof value === "string");
    const attachments = [];
    for (const filePath of attachPaths) {
      const buffer = fs.readFileSync(filePath);
      const filename = path.basename(filePath);
      const contentType = ATTACH_EXT_TYPES[(filename.split(".").pop() || "").toLowerCase()];
      if (!contentType) throw new Error(`Unsupported attachment type for ${filename}. Allowed extensions: ${Object.keys(ATTACH_EXT_TYPES).join(", ")}`);
      if (buffer.length > ATTACH_MAX_BYTES) throw new Error(`${filename} is ${(buffer.length / (1024 * 1024)).toFixed(1)}MB; the limit is 10MB`);
      const uploaded = await api("POST", `/api/rooms/${roomCode}/attachments`, { name, filename, content_type: contentType, data_base64: buffer.toString("base64") }, 60000);
      attachments.push(uploaded.id);
      console.log(`Uploaded ${filename} (${uploaded.content_type}, ${uploaded.size} bytes) as ${uploaded.id}.`);
    }
    const message = args.message && args.message !== true ? String(args.message) : "";
    if (!message && !attachments.length) throw new Error("--message or --attach is required");
    const result = await api("POST", `/api/rooms/${roomCode}/messages`, { name, content: message, attachments });
    console.log(`Sent message #${result.message.id} as ${result.message.sender}.`);
    if (args.wait !== undefined) {
      const wait = Math.min(300, Math.max(0, Number(args.wait || 45)));
      const reply = await api("GET", `/api/rooms/${roomCode}/messages?name=${encodeURIComponent(args.name)}&wait=${wait}`, undefined, (wait + 5) * 1000);
      console.log(`\nRoom ${reply.room} is ${reply.status}; ${reply.active_agents} agent(s) active.\n${responseGuidance(reply)}\n${messagesText(reply.messages)}`);
    }
    return;
  }
  if (command === "listen") {
    const name = required(args, "name"); const wait = Math.min(300, Math.max(0, Number(args.wait || 45)));
    const result = await api("GET", `/api/rooms/${roomCode}/messages?name=${encodeURIComponent(name)}&wait=${wait}`, undefined, (wait + 5) * 1000);
    console.log(`Room ${result.room} is ${result.status}; ${result.active_agents} agent(s) active.\n${responseGuidance(result)}\n${messagesText(result.messages)}`); return;
  }
  if (command === "status") {
    const result = await api("GET", `/api/rooms/${roomCode}/status`);
    console.log(`${result.room} is ${result.status}; ${result.active_agents} agent(s) active; response mode: ${result.addressed_only ? "only when addressed" : "normal"}.\n${result.participants.map((person) => `- ${person.name} [${person.role}]`).join("\n") || "No active participants."}`); return;
  }
  if (command === "leave") {
    const room = await api("POST", `/api/rooms/${roomCode}/leave`, { name: required(args, "name") });
    console.log(`${args.name} left ${room.code}.`); return;
  }
  if (command === "transcript") {
    const room = await api("GET", `/api/rooms/${roomCode}`);
    console.log(`${room.title} (${room.code}) — ${room.status}\nObjective: ${room.objective}\n\n${messagesText(room.messages)}${room.summary ? `\n\nSummary: ${room.summary}` : ""}`); return;
  }
  if (command === "export") {
    const format = String(args.format || "md").toLowerCase();
    if (format !== "md" && format !== "markdown") throw new Error("Only --format md is supported from the CLI. Use the browser viewer's Export button for PDF.");
    const room = await api("GET", `/api/rooms/${roomCode}`);
    const markdown = roomToMarkdown(room);
    if (args.out) { fs.writeFileSync(String(args.out), markdown); console.log(`Wrote ${args.out}`); }
    else { console.log(markdown); }
    return;
  }
  if (command === "close") {
    const room = await api("POST", `/api/rooms/${roomCode}/close`, { name: args.name || "Host", summary: required(args, "summary") });
    console.log(`Closed ${room.code}. Summary: ${room.summary}`); return;
  }
  if (command === "open") {
    const room = await api("GET", `/api/rooms/${roomCode}`);
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const openerArgs = process.platform === "win32" ? ["/c", "start", "", room.viewer_url] : [room.viewer_url];
    spawn(opener, openerArgs, { detached: true, stdio: "ignore" }).unref();
    console.log(room.viewer_url); return;
  }
  console.log("Usage: agent_room.mjs <start|stop|create|invite|join|send|listen|status|leave|transcript|export|close|open>");
}

main().catch((error) => { console.error(`Error: ${error.message}`); process.exit(1); });
