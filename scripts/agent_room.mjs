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
// Legacy single-endpoint default; equals the historic BASE_URL when no new vars are set.
const LEGACY_BASE = `http://${process.env.AGENT_ROOM_HOST || "127.0.0.1"}:${PORT}`;
// BIND_HOST: what the server listens on (e.g. 0.0.0.0 inside a container).
const BIND_HOST = process.env.AGENT_ROOM_BIND_HOST || process.env.AGENT_ROOM_HOST || "127.0.0.1";
// PUBLIC_URL: how the server advertises itself (viewer links, invitations, health).
const PUBLIC_URL = stripTrailingSlash(process.env.AGENT_ROOM_PUBLIC_URL || LEGACY_BASE);
// REMOTE_URL: where the CLIENT sends requests (a hosted instance, or local loopback).
const REMOTE_URL = stripTrailingSlash(process.env.AGENT_ROOM_REMOTE_URL || LEGACY_BASE);
// TOKEN: bearer credential the client attaches; empty means no auth header (unchanged local behaviour).
const TOKEN = process.env.AGENT_ROOM_TOKEN || "";
// IS_REMOTE: when set, the client talks to a remote host and never manages a local server.
const IS_REMOTE = Boolean(process.env.AGENT_ROOM_REMOTE_URL);
const DATA_DIR = process.env.AGENT_ROOM_HOME || path.join(os.homedir(), ".agent-room");
const STATE_PATH = path.join(DATA_DIR, "rooms.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const PID_PATH = path.join(DATA_DIR, "server.pid");
const LOG_PATH = path.join(DATA_DIR, "server.log");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERSION = "0.5.1";
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
  const temporary = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, STATE_PATH);
}

function migrateState() {
  const state = loadState();
  let changed = false;
  for (const room of Object.values(state.rooms)) {
    const latest = Math.max(0, Number(room.next_message_id || 1) - 1);
    if (typeof room.addressed_only !== "boolean") { room.addressed_only = false; changed = true; }
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

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 262144) throw new Error("Request body too large");
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
      latest_message_id: latestMessageId,
      messages: deliveredMessages,
    }); return;
  }

  if (request.method !== "POST") { json(response, 405, { error: "Method not allowed" }); return; }
  const body = await readBody(request);

  if (parts[3] === "join") {
    if (room.status === "closed") { json(response, 409, { error: `Room ${code} is closed` }); return; }
    const name = String(body.name || "Agent").trim().slice(0, 80) || "Agent";
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
    if (!content) { json(response, 400, { error: "Content is required" }); return; }
    if (!room.participants.some((person) => person.name.toLowerCase() === name.toLowerCase())) room.participants.push({ name, role: "agent", joined_at: now(), last_read_id: room.next_message_id - 1, color: nextParticipantColor(room) });
    const message = addMessage(room, name, content);
    saveState(state); notify(code);
    json(response, 201, { message }); return;
  }

  if (parts[3] === "viewer" && parts[4] === "messages") {
    if (room.status === "closed") { json(response, 409, { error: `Room ${code} is closed` }); return; }
    const name = String(room.viewer_name || "User").trim().slice(0, 80) || "User";
    const content = String(body.content || "").trim();
    if (!content) { json(response, 400, { error: "Content is required" }); return; }
    if (!room.participants.some((person) => person.name.toLowerCase() === name.toLowerCase())) {
      room.participants.push({ name, role: "human", joined_at: now(), color: nextParticipantColor(room) });
      addMessage(room, "Room", `${name} joined the meeting.`, "system");
    }
    const message = addMessage(room, name, content, "human");
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
    let changed = false;
    if (room.status !== "closed") {
      room.status = "closed"; room.summary = summary;
      addMessage(room, name, `Meeting closed. ${summary}`, "summary");
      changed = true;
    }
    if (room.participants.length) { room.participants = []; changed = true; }
    if (changed) { saveState(state); notify(code); }
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
};

function meetingPage(room) {
  const code = JSON.stringify(room.code);
  const initial = JSON.stringify(publicRoom(room)).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(room.title)} · Agent Room</title>
<style>
:root{--bg:#0e1014;--rail:#15181e;--surface:#1b1f26;--surface2:#222730;--line:#2c323c;--text:#f4f6f8;--muted:#929aa6;--green:#34C77B;--blue:#5B8CFF;--red:#ff665d}*{box-sizing:border-box}html,body{height:100%;margin:0}body{overflow:hidden;background:var(--bg);color:var(--text);font-family:"Avenir Next","Segoe UI",sans-serif}.app{height:100%;display:grid;grid-template-rows:70px minmax(0,1fr)}.top{display:flex;align-items:center;justify-content:space-between;padding:0 22px;border-bottom:1px solid var(--line);background:rgba(14,16,20,.96)}.title{min-width:0}.title h1{font-size:17px;line-height:1.2;margin:0;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;margin-top:5px}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px rgba(52,199,123,.14)}.actions{display:flex;align-items:center;gap:8px}.button{height:40px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);padding:0 13px;display:flex;align-items:center;gap:8px;font:600 12px inherit;cursor:pointer;transition:.15s}.button:hover{background:var(--surface2);border-color:#3c4450}.button svg{width:17px;height:17px;fill:currentColor}.button.mode.active{background:#213c30;border-color:#31835b;color:#84e6ae}.mode-light{width:8px;height:8px;border-radius:50%;background:#68717d}.button.mode.active .mode-light{background:var(--green);box-shadow:0 0 0 3px rgba(52,199,123,.16)}.button.leave{width:42px;padding:0;justify-content:center;background:#3b2022;border-color:#5a292d;color:#ff8e87}.workspace{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:0}.rail{min-height:0;border-right:1px solid var(--line);background:var(--rail);padding:20px 14px;overflow:auto}.rail-label{font-size:10px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:#6f7782;margin:0 8px 10px}.objective{padding:13px 14px;background:var(--surface);border:1px solid var(--line);border-radius:12px;font-size:12px;line-height:1.48;color:#b2b9c3;margin-bottom:22px}.people{display:flex;flex-direction:column;gap:5px}.person{--person:#5B8CFF;display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px}.person.active{background:var(--surface)}.person-avatar,.message-avatar{flex:0 0 auto;display:grid;place-items:center;border-radius:9px;background:color-mix(in srgb,var(--person) 28%,var(--surface2));color:var(--person);font-weight:800;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--person) 55%,transparent)}.person-avatar{width:32px;height:32px;font-size:12px}.person-copy{min-width:0}.person-name{font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.person-role{font-size:10px;color:var(--muted);margin-top:2px;text-transform:capitalize}.presence{width:7px;height:7px;border-radius:50%;background:var(--green);margin-left:auto}.conversation{min-width:0;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;background:radial-gradient(circle at 50% -20%,#1b2029 0,transparent 42%),var(--bg)}.thread{overflow:auto;padding:28px clamp(18px,5vw,72px) 24px;scroll-behavior:smooth}.thread-inner{width:min(900px,100%);margin:0 auto}.dayline{display:flex;align-items:center;gap:14px;color:#68717d;font-size:10px;text-transform:uppercase;letter-spacing:.12em;margin:0 0 22px}.dayline:before,.dayline:after{content:"";height:1px;background:var(--line);flex:1}.message{--person:#5B8CFF;display:grid;grid-template-columns:38px minmax(0,1fr);gap:12px;margin:0 0 20px;animation:arrive .22s ease both}.message-avatar{width:38px;height:38px;font-size:14px}.message-head{display:flex;align-items:baseline;gap:8px;margin:1px 0 4px}.message-name{font-size:13px;font-weight:750;color:var(--person)}.message-role{font-size:9px;line-height:1;padding:4px 6px;border:1px solid color-mix(in srgb,var(--person) 48%,var(--line));border-radius:999px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.message-time{font-size:10px;color:#69717d}.message-text{font-size:15px;line-height:1.55;color:#dce1e7;white-space:pre-wrap;overflow-wrap:anywhere}.message.human .message-text{background:color-mix(in srgb,var(--person) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--person) 34%,var(--line));border-radius:4px 13px 13px 13px;padding:11px 13px}.system{display:flex;justify-content:center;margin:10px 0 18px}.system span{font-size:11px;color:#7e8793;background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:6px 11px}.summary{--person:#34C77B;background:rgba(52,199,123,.09);border:1px solid rgba(52,199,123,.3);border-radius:14px;padding:14px;margin-bottom:20px}.summary .message-text{color:#dff7e7}.composer{border-top:1px solid var(--line);padding:14px clamp(18px,5vw,72px) 18px;background:rgba(14,16,20,.95);backdrop-filter:blur(12px)}.composer-inner{width:min(900px,100%);margin:0 auto}.composer-label{display:block;color:#747d88;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:0 0 7px 3px}.composer-row{display:flex;align-items:flex-end;gap:9px}.composer textarea{flex:1;min-height:46px;max-height:128px;resize:none;border:1px solid var(--line);border-radius:13px;padding:12px 14px;background:var(--surface);color:var(--text);font:14px/1.4 inherit;outline:none}.composer textarea:focus{border-color:#5B8CFF;box-shadow:0 0 0 3px rgba(91,140,255,.12)}.send{width:46px;height:46px;border:0;border-radius:13px;background:var(--blue);color:#0b0f16;font-size:20px;font-weight:800;cursor:pointer}.send:disabled,.composer textarea:disabled{opacity:.45;cursor:not-allowed}.toast{position:fixed;left:50%;bottom:90px;transform:translate(-50%,8px);padding:10px 14px;border-radius:9px;background:#f2f4f7;color:#171a1f;font-size:12px;opacity:0;pointer-events:none;transition:.18s;box-shadow:0 12px 40px rgba(0,0,0,.35)}.toast.show{opacity:1;transform:translate(-50%,0)}@keyframes arrive{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}@media(max-width:720px){.workspace{grid-template-columns:1fr}.rail{display:none}.top{padding:0 12px}.button span{display:none}.button{width:40px;padding:0;justify-content:center}.thread{padding:20px 14px}.composer{padding:12px 14px 14px}.title h1{font-size:15px}}
</style></head><body><div class="app"><header class="top"><div class="title"><h1>${escapeHtml(room.title)}</h1><div class="meta"><span class="status-dot"></span><span id="status">${escapeHtml(room.status)}</span><span>·</span><span>${escapeHtml(room.code)}</span><span>·</span><span id="clock"></span></div></div><div class="actions"><button class="button mode" id="mode" title="Agents only respond when named"><span class="mode-light"></span><span>Only when addressed</span></button><button class="button" id="export">${ICONS.download}<span>Export</span></button><button class="button" id="copy">${ICONS.copy}<span>Copy invite</span></button><button class="button leave" id="leave" title="Leave room">${ICONS.hangup}</button></div></header><main class="workspace"><aside class="rail"><div class="rail-label">Objective</div><div class="objective">${escapeHtml(room.objective)}</div><div class="rail-label">In this room · <span id="count">${room.participants.length}</span></div><div class="people" id="people"></div></aside><section class="conversation"><div class="thread" id="thread"><div class="thread-inner"><div class="dayline">Live transcript</div><div id="messages"></div></div></div><form class="composer" id="composer"><div class="composer-inner"><label class="composer-label" for="message">Message as ${escapeHtml(room.viewer_name || "User")}</label><div class="composer-row"><textarea id="message" rows="1" maxlength="20000" placeholder="Add to the conversation…" ${room.status === "closed" ? "disabled" : ""}></textarea><button class="send" id="send" type="submit" aria-label="Send" ${room.status === "closed" ? "disabled" : ""}>↑</button></div></div></form></section></main></div><div class="toast" id="toast"></div>
<script>const ROOM=${initial};const code=${code};let cursor=0;let addressedOnly=Boolean(ROOM.addressed_only);const colors=['#5B8CFF','#FF6B5E','#34C77B','#F2B134','#A970FF','#20B8CC','#F05DAA','#78C442','#F28A3E','#6E79FF'];const el=id=>document.getElementById(id);const esc=s=>{const d=document.createElement('div');d.textContent=s;return d.innerHTML};const colorFor=s=>ROOM.participants.find(p=>p.name===s)?.color||colors[[...s].reduce((a,c)=>a+c.charCodeAt(0),0)%colors.length];const timeOf=s=>new Date(s).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});const participantFor=name=>ROOM.participants.find(p=>p.name===name)||{name,role:name===ROOM.viewer_name?'human':'agent',color:colorFor(name)};
function renderPeople(list,active){ROOM.participants=list;el('count').textContent=list.length;el('people').innerHTML=list.length?list.map(p=>\`<div class="person \${p.name===active?'active':''}" style="--person:\${p.color||colorFor(p.name)}"><div class="person-avatar">\${esc(p.name.slice(0,1).toUpperCase())}</div><div class="person-copy"><div class="person-name">\${esc(p.name)}</div><div class="person-role">\${p.role==='human'?'Human':'Agent'}</div></div><span class="presence"></span></div>\`).join(''):'<div class="objective">No active participants</div>'}
function addMessage(m,animate=true){cursor=Math.max(cursor,m.id);const item=document.createElement('article');if(!animate)item.style.animation='none';if(m.kind==='system'){item.className='system';item.innerHTML=\`<span>\${esc(m.content)}</span>\`}else{const p=participantFor(m.sender);item.className='message '+m.kind;item.style.setProperty('--person',p.color||colorFor(m.sender));item.innerHTML=\`<div class="message-avatar">\${esc(m.sender.slice(0,1).toUpperCase())}</div><div><div class="message-head"><span class="message-name">\${esc(m.sender)}</span><span class="message-role">\${m.kind==='human'?'Human':m.kind==='summary'?'Decision':p.role||'Agent'}</span><span class="message-time">\${timeOf(m.created_at)}</span></div><div class="message-text">\${esc(m.content)}</div></div>\`}el('messages').appendChild(item);el('thread').scrollTop=el('thread').scrollHeight}
function renderMode(enabled){addressedOnly=Boolean(enabled);el('mode').classList.toggle('active',addressedOnly);el('mode').setAttribute('aria-pressed',String(addressedOnly));el('message').placeholder=addressedOnly?'Mention an agent by name to request a response…':'Add to the conversation…'}
function hydrate(){renderMode(addressedOnly);renderPeople(ROOM.participants,ROOM.messages.filter(m=>m.kind==='agent'||m.kind==='human').at(-1)?.sender);ROOM.messages.forEach(m=>addMessage(m,false));el('clock').textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});setInterval(()=>el('clock').textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),30000)}
async function poll(){let closed=false;try{const response=await fetch(\`/api/rooms/\${code}/messages?after=\${cursor}&wait=25\`);const data=await response.json();const active=data.messages.filter(m=>m.kind==='agent'||m.kind==='human').at(-1)?.sender;renderMode(data.addressed_only);renderPeople(data.participants||[],active);data.messages.forEach(m=>addMessage(m));el('status').textContent=data.status;closed=data.status==='closed';if(closed){el('message').disabled=true;el('send').disabled=true;el('mode').disabled=true}}catch{}if(!closed)setTimeout(poll,350)}
function toast(message){el('toast').textContent=message;el('toast').classList.add('show');setTimeout(()=>el('toast').classList.remove('show'),1800)}async function sendViewerMessage(){const content=el('message').value.trim();if(!content)return;el('send').disabled=true;try{const response=await fetch(\`/api/rooms/\${code}/viewer/messages\`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not send message');el('message').value='';renderPeople(data.participants||ROOM.participants,data.message.sender)}catch(error){toast(error.message)}finally{if(el('status').textContent!=='closed')el('send').disabled=false}}
el('composer').onsubmit=e=>{e.preventDefault();sendViewerMessage()};el('message').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendViewerMessage()}};el('mode').onclick=async()=>{el('mode').disabled=true;try{const response=await fetch(\`/api/rooms/\${code}/mode\`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({addressed_only:!addressedOnly})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not change mode');renderMode(data.addressed_only);toast(data.addressed_only?'Agents will only reply when named':'Agents may reply normally')}catch(error){toast(error.message)}finally{el('mode').disabled=false}};el('copy').onclick=async()=>{await navigator.clipboard.writeText(ROOM.invitation);toast('Agent invitation copied')};el('leave').onclick=async()=>{try{await fetch(\`/api/rooms/\${code}/viewer/leave\`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})}finally{location.href='/'}};
function dlFile(name,text,type){const b=new Blob([text],{type});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1500)}
async function fetchRoom(){const r=await fetch('/api/rooms/'+code);if(!r.ok)throw new Error('Could not load transcript');return r.json()}
function roleOf(m){return m.kind==='human'?'Human':m.kind==='summary'?'Decision':'Agent'}
function mdOf(d){const L=['# '+d.title,'','- **Room:** '+d.code];if(d.objective)L.push('- **Objective:** '+d.objective);L.push('- **Status:** '+d.status,'- **Exported:** '+new Date().toLocaleString(),'','---','');for(const m of d.messages){if(m.kind==='system'){L.push('_'+m.content+'_','');continue}L.push('### '+m.sender+' · '+roleOf(m)+' · '+new Date(m.created_at).toLocaleString(),'',m.content,'')}if(d.summary)L.push('---','','**Summary:** '+d.summary,'');return L.join('\\n')}
function htmlOf(d){const e2=s=>{const x=document.createElement('div');x.textContent=s;return x.innerHTML};const rows=d.messages.map(m=>{const t=new Date(m.created_at).toLocaleString();if(m.kind==='system')return '<p class="sys">'+e2(m.content)+'</p>';return '<div class="msg"><div class="h"><b>'+e2(m.sender)+'</b> <span>'+roleOf(m)+'</span> <time>'+t+'</time></div><div class="c">'+e2(m.content)+'</div></div>'}).join('');return '<!doctype html><html><head><meta charset="utf-8"><title>'+e2(d.title)+'</title><style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 20px}h1{margin:0 0 4px}.meta{color:#555;font-size:12px;margin-bottom:16px}hr{border:0;border-top:1px solid #ddd;margin:16px 0}.msg{margin:0 0 13px}.h{font-size:12px;color:#333}.h span{color:#888;text-transform:uppercase;font-size:10px;margin-left:4px}.h time{color:#999;margin-left:6px}.c{white-space:pre-wrap;margin-top:2px}.sys{color:#888;font-style:italic;text-align:center;font-size:12px;margin:8px 0}@media print{body{margin:0}}</style></head><body><h1>'+e2(d.title)+'</h1><div class="meta">Room '+e2(d.code)+' · '+e2(d.status)+' · Exported '+new Date().toLocaleString()+(d.objective?' · '+e2(d.objective):'')+'</div><hr>'+rows+(d.summary?'<hr><p><b>Summary:</b> '+e2(d.summary)+'</p>':'')+'</body></html>'}
function printHtml(html){const f=document.createElement('iframe');f.setAttribute('aria-hidden','true');f.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0';f.srcdoc=html;f.onload=()=>{try{f.contentWindow.focus();f.contentWindow.print()}catch(e){}setTimeout(()=>f.remove(),1000)};document.body.appendChild(f)}
async function doExport(kind){try{const d=await fetchRoom();if(kind==='md'){dlFile('room-'+d.code+'.md',mdOf(d),'text/markdown');toast('Markdown downloaded')}else{printHtml(htmlOf(d));toast('Opening print dialog…')}}catch(e){toast(e.message)}}
el('export').onclick=ev=>{ev.stopPropagation();const old=document.getElementById('exportMenu');if(old){old.remove();return}const m=document.createElement('div');m.id='exportMenu';const b=el('export').getBoundingClientRect();m.style.cssText='position:fixed;top:'+(b.bottom+6)+'px;left:'+b.left+'px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:5px;z-index:50;box-shadow:0 12px 40px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:2px;min-width:160px';m.innerHTML='<button class="exi" data-k="md">Markdown (.md)</button><button class="exi" data-k="pdf">PDF (print)</button>';m.querySelectorAll('.exi').forEach(x=>{x.style.cssText='background:none;border:0;color:var(--text);text-align:left;padding:9px 11px;border-radius:7px;cursor:pointer;font:inherit;font-size:13px';x.onmouseenter=()=>x.style.background='var(--surface2)';x.onmouseleave=()=>x.style.background='none';x.onclick=()=>{m.remove();doExport(x.dataset.k)}});document.body.appendChild(m)};
document.addEventListener('click',()=>{const m=document.getElementById('exportMenu');if(m)m.remove()});
hydrate();poll();</script></body></html>`;
}

function landingPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Room</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#202124;color:#f1f3f4;font-family:"Avenir Next","Segoe UI",sans-serif}.card{width:min(620px,88vw);padding:48px;border:1px solid #4a4d51;border-radius:20px;background:#2d2e30;box-shadow:0 30px 90px rgba(0,0,0,.35)}.mark{width:54px;height:54px;border-radius:16px;background:#8ab4f8;color:#202124;display:grid;place-items:center;font-size:24px;font-weight:700}h1{font-size:52px;letter-spacing:-.045em;margin:28px 0 12px}p{color:#bdc1c6;font-size:18px;line-height:1.55}code{display:block;margin-top:28px;padding:16px;background:#202124;border-radius:10px;color:#81c995;overflow:auto}</style></head><body><main class="card"><div class="mark">A</div><h1>Agents, meet.</h1><p>Create a private localhost room from your terminal, paste the invitation into another agent, and watch them work through the decision together.</p><code>agent_room.mjs create --title "Reliability review" --name "Fable"</code></main></body></html>`;
}

function notFoundPage(code) {
  return `<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#202124;color:#f1f3f4;font-family:sans-serif"><main><h1>Room ${escapeHtml(code)} not found</h1><p style="color:#bdc1c6">Check the room code and local server.</p></main></body></html>`;
}

function startServer() {
  ensureDir();
  migrateState();
  const server = http.createServer((request, response) => route(request, response).catch((error) => json(response, 400, { error: error.message })));
  server.listen(PORT, BIND_HOST, () => {
    fs.writeFileSync(PID_PATH, String(process.pid));
    process.stdout.write(`Agent Room ${VERSION} listening on ${BIND_HOST}:${PORT} (public: ${PUBLIC_URL})\n`);
  });
  const close = () => server.close(() => {
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
    if (value.startsWith("--")) result[value.slice(2)] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
    else result._.push(value);
  }
  return result;
}

function messagesText(messages) {
  return messages.length ? messages.map((m) => `#${m.id} [${m.kind}] ${m.sender}: ${m.content}`).join("\n\n") : "No new messages. Continue listening unless a stop condition has been met.";
}

function roomToMarkdown(room) {
  const lines = [`# ${room.title}`, "", `- **Room:** ${room.code}`];
  if (room.objective) lines.push(`- **Objective:** ${room.objective}`);
  lines.push(`- **Status:** ${room.status}`, "", "---", "");
  for (const message of room.messages || []) {
    if (message.kind === "system") { lines.push(`_${message.content}_`, ""); continue; }
    const role = message.kind === "human" ? "Human" : message.kind === "summary" ? "Decision" : "Agent";
    lines.push(`### ${message.sender} · ${role} · ${message.created_at}`, "", message.content, "");
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
    if (IS_REMOTE) throw new Error("start manages a LOCAL Agent Room server and is unavailable when AGENT_ROOM_REMOTE_URL is set.");
    await ensureServer(); console.log(`Agent Room is running at ${PUBLIC_URL} for ${loadConfig().user_name || "User"}`); return;
  }
  if (command === "stop") {
    if (IS_REMOTE) throw new Error("stop manages a LOCAL Agent Room server and is unavailable when AGENT_ROOM_REMOTE_URL is set.");
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
    const result = await api("POST", `/api/rooms/${roomCode}/messages`, { name: required(args, "name"), content: required(args, "message") });
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
