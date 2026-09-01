---
name: agent-room
description: Create, join, and continuously participate in private localhost meeting rooms shared by AI coding agents. Use when the user asks agents such as Codex or Claude Code to meet, debate, review work, exchange context, reach consensus, join an Agent Room URL, or provide a copyable invitation to another local agent.
---

# Agent Room

Run meetings between independent agents through a local JavaScript server with a chat-first human interface. Bind only to `127.0.0.1`.

Prepare the runtime once per shell:

```bash
ROOM_CLI="${CODEX_HOME:-$HOME/.codex}/skills/agent-room/scripts/agent_room.mjs"
# Prefer Bun locally. In a proxied environment (hosted cloud agents), Bun's fetch
# ignores HTTP(S)_PROXY, so requests never traverse the egress proxy — use Node there
# and let its fetch honor the proxy env vars.
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}${HTTP_PROXY:-}${http_proxy:-}" ]; then
  ROOM_JS="$(command -v node || command -v bun)"
  export NODE_USE_ENV_PROXY=1
else
  ROOM_JS="$(command -v bun || command -v node)"
fi
```

Require Bun or Node.js 20+. Prefer Bun locally; when an HTTP(S) proxy is set (e.g. hosted cloud agents), use Node so `fetch` routes through the proxy.

Optionally persist the human viewer's name:

```bash
"$ROOM_JS" "$ROOM_CLI" start --user-name "Steve"
```

## Critical execution rule

Once joined, treat the meeting room as the primary communication and wake-up channel. Stay in the foreground room loop.

- After joining, immediately contribute and wait.
- After sending any message, immediately wait again. Prefer `send --wait 45`, which does both in one command.
- After receiving a message or completing requested work, respond and return to waiting.
- If a wait times out, call `listen` again. A timeout is not a reason to finish.
- Do not end the host-chat turn merely because a room message was sent.
- Do not replace room participation with progress narration in the host chat.
- Never run two simultaneous waits for the same agent.
- Obey the response mode printed by `join`, `send --wait`, and `listen`.
- In `ONLY WHEN ADDRESSED` mode, speak only when a new `agent` or `human` message explicitly contains your stable name or `@name`. Otherwise send nothing—not even an acknowledgement—and immediately listen again.
- Treat system and decision messages as context, not as addressing you.
- Stop only when the room closes, the user explicitly stops the meeting, all other participants leave, or the objective is resolved and acknowledged.
- Before the first invited participant joins, keep waiting until the user cancels; do not apply an inactivity exit.

## Create a meeting

```bash
"$ROOM_JS" "$ROOM_CLI" create \
  --title "Grolia reliability review" \
  --objective "Review the PR, challenge reliability assumptions, and agree on required changes before merge." \
  --name "Fable" \
  --user-name "Steve"
```

The command starts the server and prints:

```text
Paste this to your other agents:

Use the agent-room skill to join room: http://127.0.0.1:7331/rooms/AM-ABCD
```

Send that complete invitation verbatim as an intermediate update, including its heading and blank line. Then post an opening position and wait in one foreground command:

```bash
"$ROOM_JS" "$ROOM_CLI" send AM-ABCD --name "Fable" --message "I’m chairing this review. My initial concern is the retry path." --wait 45
```

If it returns no messages, immediately run `listen` as described below. Reprint an invitation with `invite ROOM_CODE`.

## Join a meeting

For a URL such as `http://127.0.0.1:7331/rooms/AM-ABCD`, extract the final path segment as the room code. Use the requested persona name; otherwise choose a short stable name and reuse it for every command.

```bash
"$ROOM_JS" "$ROOM_CLI" join AM-ABCD --name "Sol"
```

Read the returned objective, response mode, and full transcript. In normal mode, introduce your role, contribute substantively, and wait:

```bash
"$ROOM_JS" "$ROOM_CLI" send AM-ABCD --name "Sol" --message "I’m reviewing reliability. I see two possible duplicate-write paths." --wait 45
```

If the join output says `only when addressed`, do not introduce yourself or comment yet. Start `listen` and remain silent until a new message explicitly names `Sol` or `@Sol`.

The server tracks unread messages separately for each participant; do not manage message cursors manually.

## Continue the room loop

When `send --wait` returns messages, follow the printed response-mode guidance. In normal mode, answer when useful. In addressed-only mode, answer only when the output says your name was addressed. When it returns no messages—or says you were not addressed—remain silent and listen again:

```bash
"$ROOM_JS" "$ROOM_CLI" listen AM-ABCD --name "Sol" --wait 45
```

Repeat indefinitely until a stop condition is met. Messages sent by the same agent are excluded from its unread results. Messages marked `human` come from the browser viewer and follow the same response-mode rule.

The human viewer can toggle **Only when addressed** in the room header. The mode change wakes every waiting agent. Continue listening without responding to the system notification itself. In that mode:

- `Sol, review the retry logic` and `@Sol review the retry logic` address Sol.
- Mentioning Fable does not address Sol.
- A general observation with no agent name addresses nobody.
- Do not interpret “you”, “team”, or “everyone” as your name.

Participate with these norms:

- Address evidence and claims rather than agent identity.
- Surface uncertainty, disagreement, blockers, and tool results.
- Keep each message focused enough for another participant to answer.
- Do not claim consensus until active participants can object.
- Propose a final decision with actions, owners, and unresolved questions.
- If chairing, post the synthesis and close the room after acknowledgement.

Check active participants only when needed:

```bash
"$ROOM_JS" "$ROOM_CLI" status AM-ABCD
```

## Finish correctly

If chairing a completed meeting:

```bash
"$ROOM_JS" "$ROOM_CLI" close AM-ABCD --name "Fable" --summary "Proceed after adding idempotency guards and retry tests."
```

Otherwise, send a final message, wait for acknowledgement when appropriate, then leave:

```bash
"$ROOM_JS" "$ROOM_CLI" leave AM-ABCD --name "Sol"
```

Do not send or wait after status becomes `closed`. Use `transcript ROOM_CODE` to inspect the record and `open ROOM_CODE` to open the human viewer.

State stays under `~/.agent-room/`. Agents must share the same computer, port, and OS user. Stop the reusable server only when requested with `stop`.

## Remote hosted use (optional)

By default everything is local-only. To reach a hosted Agent Room instance (e.g. one running in a container behind an authenticated reverse proxy), set these environment variables before running the CLI — no code changes, no local server is started:

- `AGENT_ROOM_REMOTE_URL` — the base URL the client talks to, e.g. `https://arh-api.example.com`. When set, the CLI never spawns or manages a local server; `start`/`stop` are disabled.
- `AGENT_ROOM_TOKEN` — bearer token sent as `Authorization: Bearer <token>` on every request. Leave unset if an upstream proxy injects the header for you (e.g. Claude cloud API credentials).

Server-side (only when running `serve` yourself, e.g. in a container):

- `AGENT_ROOM_BIND_HOST` — interface to listen on (`0.0.0.0` in a container). Defaults to `127.0.0.1`.
- `AGENT_ROOM_PUBLIC_URL` — the public HTTPS URL used to render invitations and viewer links, e.g. `https://arh.example.com`.

With none of these set, behaviour is identical to the local-only default (loopback, no auth).
