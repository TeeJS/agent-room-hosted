// Agent Room bridge for OMP (oh-my-pi).
//
// Bridge mode: the agent joins, posts, and ENDS ITS TURN. This extension long-polls the
// room in the background and wakes the agent only when a message needs it. The agent
// holds no watcher loop and never sees a full transcript — built for low-context models.
//
// Talks to the room HTTP API in-process with fetch: no CLI wrap, no process spawn.
// Closed/removed are read from structured fields and HTTP status only — message text is
// never scanned (SKILL.md invariant).
//
// Install: copy this file to ~/.omp/agent/extensions/agent-room.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const DEFAULT_REMOTE = "https://arh-api.schmitzplex.com";
const WAIT = 90; // hosted proxy drops connections held longer than 120s
const STATE = "agent-room.state";
const JOIN_TAIL = 10; // messages shown on join; never the full transcript
const COMPACT_AT_PERCENT = 80;
const GATED_TOOLS = ["bash", "write", "edit"];

interface RoomState {
	code: string;
	name: string;
}
interface RoomMessage {
	id: number;
	kind: string;
	sender: string;
	content: string;
	attachments?: { filename?: string }[];
}
interface ListenResult {
	status: string;
	addressed_only: boolean;
	should_respond: boolean;
	messages: RoomMessage[];
}
interface JoinResult {
	code: string;
	title: string;
	objective: string;
	status: string;
	addressed_only: boolean;
	messages: RoomMessage[];
}
class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

// Same resolution order as the CLI. The token file is read fresh on every call so a
// rotated token takes effect without restarting the session.
function baseUrl(): string {
	return (process.env.AGENT_ROOM_REMOTE_URL || DEFAULT_REMOTE).replace(/\/+$/, "");
}
function token(): string {
	const dataDir = process.env.AGENT_ROOM_HOME || path.join(os.homedir(), ".agent-room");
	const file = process.env.AGENT_ROOM_TOKEN_FILE || path.join(dataDir, "token");
	try {
		const value = fs.readFileSync(file, "utf8").trim();
		if (value) return value;
	} catch {}
	return (process.env.AGENT_ROOM_TOKEN || "").trim();
}

// Never interpolate the token into an error or log string.
async function api<T>(method: string, endpoint: string, body?: unknown, timeoutMs = 35_000): Promise<T> {
	const headers: Record<string, string> = {};
	if (body) headers["content-type"] = "application/json";
	const bearer = token();
	if (bearer) headers.authorization = `Bearer ${bearer}`;
	let response: Response;
	try {
		response = await fetch(baseUrl() + endpoint, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const name = (error as Error).name;
		if (name === "TimeoutError" || name === "AbortError") throw new ApiError(`Request timed out at ${baseUrl()}`, 0);
		throw new ApiError((error as Error).message, 0);
	}
	// A reverse proxy can answer with a non-JSON body (e.g. an HTML 401 page).
	const raw = await response.text();
	let value: any = null;
	if (raw) {
		try {
			value = JSON.parse(raw);
		} catch {}
	}
	if (!response.ok) {
		const bareAuth = (response.status === 401 || response.status === 403) && !value?.error;
		const reason = bareAuth
			? `unauthorized at ${baseUrl()} — check ~/.agent-room/token / proxy auth`
			: value?.error || `HTTP ${response.status} from ${baseUrl()}`;
		throw new ApiError(`${response.status}: ${reason}`, response.status);
	}
	return (value ?? {}) as T;
}

function formatMessages(messages: RoomMessage[]): string {
	return messages
		.map(m => {
			const refs = (m.attachments || []).map(a => `\n  ↳ attachment: ${a.filename ?? "file"}`).join("");
			return `#${m.id} [${m.kind}] ${m.sender}: ${m.content}${refs}`;
		})
		.join("\n");
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

export default function agentRoom(pi: ExtensionAPI) {
	const z = pi.zod;
	let room: RoomState | null = null;
	let watching = false;
	let pending: RoomMessage[] = []; // delivered by the server but not yet injected
	let roomTriggered = false; // the current agent run was started by a room message

	function setRoom(next: RoomState | null): void {
		room = next;
		pending = [];
		pi.appendEntry(STATE, next);
	}

	pi.registerTool({
		name: "room_join",
		label: "Agent Room: Join",
		loadMode: "essential", // top-level, not an xd:// device — small models never find those
		description:
			"Join an Agent Room by code. A background bridge then watches the room for you. After joining, post with room_send if appropriate, then END YOUR TURN — do not poll or wait; you will be woken when a message needs you.",
		parameters: z.object({
			code: z.string().describe("Room code, e.g. AM-ABCD"),
			name: z.string().describe("Your participant name in the room"),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as { code: string; name: string };
			const code = input.code.trim().toUpperCase();
			const name = input.name.trim();
			let joined: JoinResult;
			try {
				joined = await api<JoinResult>("POST", `/api/rooms/${encodeURIComponent(code)}/join`, { name });
			} catch (error) {
				return text(`Join failed: ${(error as Error).message}`);
			}
			setRoom({ code, name });
			startWatcher(ctx);
			const tail = joined.messages.slice(-JOIN_TAIL);
			const omitted = joined.messages.length - tail.length;
			const mode = joined.addressed_only
				? `ONLY WHEN ADDRESSED — do not introduce yourself or comment; stay silent until a message names ${name}.`
				: "normal";
			return text(
				`Joined ${joined.code}: ${joined.title}\nObjective: ${joined.objective}\nStatus: ${joined.status}\nResponse mode: ${mode}\n\n` +
					`Recent messages${omitted > 0 ? ` (${omitted} earlier omitted)` : ""}:\n${formatMessages(tail) || "(none)"}\n\n` +
					"Bridge active. Post with room_send if appropriate, then end your turn.",
			);
		},
	});

	pi.registerTool({
		name: "room_send",
		label: "Agent Room: Send",
		loadMode: "essential", // top-level, not an xd:// device — small models never find those
		description: "Post a message to the joined room. This is the ONLY way other participants see what you say.",
		parameters: z.object({ message: z.string().describe("Message to post") }),
		async execute(_toolCallId, params) {
			if (!room) return text("Not in a room. Use room_join first.");
			try {
				await api("POST", `/api/rooms/${room.code}/messages`, {
					name: room.name,
					content: (params as { message: string }).message,
					attachments: [],
				});
			} catch (error) {
				return text(`Send failed: ${(error as Error).message}`);
			}
			return text("Posted. End your turn unless you have more to do; the bridge will wake you on replies.");
		},
	});

	pi.registerTool({
		name: "room_leave",
		label: "Agent Room: Leave",
		loadMode: "essential", // top-level, not an xd:// device — small models never find those
		description: "Leave the joined room and stop the bridge.",
		parameters: z.object({}),
		async execute() {
			if (!room) return text("Not in a room.");
			const left = room;
			setRoom(null);
			try {
				await api("POST", `/api/rooms/${left.code}/leave`, { name: left.name });
			} catch (error) {
				return text(`Bridge stopped. Leave call failed: ${(error as Error).message}`);
			}
			return text(`Left ${left.code}.`);
		},
	});

	function inject(content: string): boolean {
		// Extension sends can reject when no prompt scope is active; the caller keeps the batch.
		try {
			roomTriggered = true;
			pi.sendUserMessage(content, { deliverAs: "aside", attribution: "agent" });
			return true;
		} catch (error) {
			roomTriggered = false;
			pi.logger.warn(`agent-room: inject failed, will retry: ${(error as Error).message}`);
			return false;
		}
	}

	function startWatcher(ctx: ExtensionContext): void {
		if (watching || !room) return;
		watching = true;
		let backoff = 1_000;

		const tick = async (): Promise<void> => {
			const current = room;
			if (!current) {
				watching = false;
				return;
			}
			let delay = 200;
			try {
				const result = await api<ListenResult>(
					"GET",
					`/api/rooms/${current.code}/messages?name=${encodeURIComponent(current.name)}&wait=${WAIT}`,
					undefined,
					(WAIT + 5) * 1000,
				);
				backoff = 1_000;
				if (room !== current) {
					// left or re-joined while the poll was in flight
				} else if (result.status === "closed") {
					const summary = result.messages.filter(m => m.kind === "summary").slice(-1);
					setRoom(null);
					inject(
						`[agent-room ${current.code}] The room is closed. Do not reply or post again.` +
							(summary.length ? `\n${formatMessages(summary)}` : ""),
					);
				} else {
					// should_respond is the server's verdict: a human/agent message arrived and, in
					// addressed-only rooms, it names this agent. Anything else (join notices,
					// unaddressed chatter) is dropped without waking the model. `pending` only
					// outlives a tick when an earlier inject failed.
					if (result.should_respond) pending.push(...result.messages);
					if (pending.length) {
						const usage = ctx.getContextUsage();
						if (usage && usage.percent > COMPACT_AT_PERCENT && ctx.isIdle()) await ctx.compact();
						const mode = result.addressed_only ? " You were addressed." : "";
						const sent = inject(
							`[agent-room ${current.code}] New messages:${mode}\n${formatMessages(pending)}\n\n` +
								"Reply with room_send if useful, then end your turn.",
						);
						if (sent) pending = [];
						else delay = 5_000;
					}
				}
			} catch (error) {
				const status = error instanceof ApiError ? error.status : 0;
				if (status === 403 || status === 404) {
					// removed from the room, not a participant, or the room is gone
					if (room === current) setRoom(null);
					ctx.ui.notify(`agent-room: stopped watching ${current.code} — ${(error as Error).message}`, "warning");
				} else {
					pi.logger.warn(`agent-room watcher: ${(error as Error).message}`);
					delay = backoff;
					backoff = Math.min(backoff * 2, 30_000);
				}
			}
			if (room) ctx.setTimeout(tick, delay);
			else watching = false;
		};
		ctx.setTimeout(tick, 0);
	}

	pi.on("session_start", async (_event, ctx) => {
		let restored: RoomState | null = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE) restored = (entry.data as RoomState | null) ?? null;
		}
		room = restored;
		if (room) startWatcher(ctx);
	});

	// A room message must not mutate local state silently: while a run was started by
	// the room, bash/write/edit need a local yes.
	pi.on("agent_end", () => {
		roomTriggered = false;
	});
	pi.on("input", event => {
		if (event.source !== "extension") roomTriggered = false;
	});
	pi.on("tool_call", async (event, ctx) => {
		if (!roomTriggered || !GATED_TOOLS.includes(event.toolName)) return;
		const detail = JSON.stringify(event.input).slice(0, 400);
		const ok = ctx.hasUI
			? await ctx.ui.confirm("Agent Room: room-triggered action", `Allow ${event.toolName}?\n${detail}`)
			: false;
		if (!ok) return { block: true, reason: "Room-relayed action needs local confirmation, which was not given." };
	});
}
