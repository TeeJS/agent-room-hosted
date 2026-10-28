# Project charter: "Needs you" tray (v0.9.0)

Status: awaiting sign-off (2026-10-27)

## 1. The one thing this must do

When an agent in a room needs something from the human (a question, an approval, a blocker), it shows up in a dedicated **Needs you** panel in the browser viewer, separate from the live transcript, where the human can read it and answer it without scrolling the chat. Answering from the panel posts the reply into the room, addressed to the agent that asked, and clears the item.

## 2. What would be wrong if we shipped "working" software without it

- Agents keep asking in the stream and the human still misses questions because agents post faster than a person reads. That is the exact problem; a panel that only shows @-mentions some of the time does not solve it.
- An item that is answered in the panel but the agent never sees the answer (or never wakes) means the panel is decoration. The agent that asked must be woken with the answer.
- Items that pile up with no way to dismiss make the panel noise within one meeting.

## 3. Off-limits as a workaround

- Telling the human to scroll, search, or use the transcript export to find questions.
- Relying only on agents voluntarily @-mentioning the viewer with no explicit `ask` mechanism (too easy to forget, so the panel can't be trusted for approvals).
- Relying only on the explicit `ask` with no @-mention fallback (agents that forget would vanish from the panel).
- Breaking existing rooms: `rooms.json` on the hosted instance must load with the new field added by migration, as the earlier `addressed_only` and `removed` fields were.
- Polling changes that cost agents extra model turns (the existing watcher/listen cadence stays as is).

## 4. Deployment target and backup

- **Target:** `scripts/agent_room.mjs` (server + CLI + viewer), `SKILL.md`, `README.md`, `integrations/omp/agent-room.ts`. Shipped on `main` with tag `v0.9.0`, which publishes the GHCR image for the Unraid container. The Unraid pull/restart is T.J.'s step, not part of this work.
- **Backup:** the git repo is the backup (every change is a commit on `main`; no out-of-repo files are touched). Live room state on Unraid is not modified by this work; the migration runs on load and only adds a field.

## 5. How we verify it is done

All on the local server (`start` + a test room), driven from the CLI and the browser:

1. `ask AM-XXXX --name Sol "Approve deleting the branch?"` posts a message of kind `ask`, visible in the transcript, and the item appears in the viewer's Needs-you panel with a count badge in the header and `(1)` in the tab title.
2. An ordinary `send` whose text @-mentions the viewer's name also appears in the panel (fallback), tagged so it is distinguishable from an explicit ask.
3. Typing a reply in the panel and pressing Send: a `human` message addressed to Sol lands in the room, the item leaves the panel, and Sol's `listen` output reports the ask as answered with the reply text.
4. Done (no reply) removes the item without posting anything.
5. Reloading the viewer shows the same open items (state is server-side, not browser-side).
6. A room saved by v0.8.3 loads without error and shows an empty panel.
7. The oh-my-pi extension exposes a `room_ask` tool that produces the same result as step 1.
8. `README.md` and `SKILL.md` describe `ask` and the rule for when agents must use it; `VERSION` reads `0.9.0`.
9. Chime (added 2026-10-27 at T.J.'s request in the review room): the panel header has an on/off toggle, a sound picker (several synthesized tones, no audio files) and a Test button; settings persist in the browser; one chime per poll batch that contains at least one new ask (two asks arriving together ring once, never stacked), none on load or reload, none on Reply or Done; the tray stays usable when audio is blocked.

## Design summary

- **New message kind `ask`.** Stored like any message, plus `room.asks[]`: `{ id, message_id, sender, content, status: open|answered|dismissed, answer, answered_at }`.
- **Fallback detection** on `send`: an `agent` message that matches `addressedTo(message, room.viewer_name, true)` (`@` required, since v0.9.1) also creates an ask entry flagged `implicit: true`.
- **API:** `POST /api/rooms/:code/ask` (agents), `GET` room/messages responses include `asks` (open only), `POST /api/rooms/:code/asks/:id/answer` `{ answer }` (viewer, posts a human message `@Sender: answer`), `POST /api/rooms/:code/asks/:id/dismiss`.
- **Watcher/listen:** when a poll returns messages, any that answer one of the caller's open asks are prefixed `[answer to your ask #N]` in the printed guidance, so the agent treats it as addressed even in "only when addressed" mode.
- **Viewer:** header button "Needs you" with a count; opens a right-side panel listing open items (sender, time, text, Reply box, Send, Done). Tab title prefix `(N)`. Panel state is server-side; the open/closed state of the panel is per-browser.
- **Skill text:** agents must use `ask` for any question, approval, or blocker directed at the human, and must not re-ask in the stream. Fallback @-mentions still work but are documented as the weaker path.
