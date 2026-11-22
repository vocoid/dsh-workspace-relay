# Workspace Relay

Workspace Relay is a DeepSeek Harness plugin for moving work between workspaces. A session can discover other workspaces and their sessions, send a message to chosen sessions and wait for their reply, or create a worker/overseer session inside another workspace without leaving the current conversation.

It also adds a `/forward` command: pick one or more existing sessions, or create a new session in a workspace, and forward the latest user message (or text after `--`) to them.

## Features

- **See other workspaces** — list registered workspaces and the sessions inside each one.
- **Ask another workspace automatically** — ask a question without picking a session; the plugin reuses (or creates) a relay session in that workspace and returns its answer.
- **Message sessions across workspaces** — send to one or more session ids; by default wait for each target's turn and return its reply.
- **Spawn a worker or overseer** — create a session whose working directory is the target workspace, give it a task, and optionally wait for the result.
- **Forward with a picker** — bare `/forward` opens a searchable list grouped by workspace, ordered by most recent activity.
- **Keep the sidebar clean** — spawned sessions are hidden by default; one setting switches future spawns to ordinary, reopenable workspace sessions.

## Tools

| Tool | Purpose |
| --- | --- |
| `workspace_list` | List workspaces, paths, and session counts. |
| `workspace_sessions` | List sessions in a workspace with ids, titles, timestamps, and live/archive state. |
| `workspace_ask` | Ask a workspace a question through an automatic relay session; pass `session_id` to use an existing session instead. |
| `workspace_send` | Send one message to one or more session ids, optionally waiting for replies. |
| `workspace_spawn` | Create a session in a target workspace and send it a task. |

## Automatic relay

`workspace_ask` takes a workspace and a question. On first use it creates a hidden relay session whose working directory is that workspace; later asks reuse the same relay, so it keeps context across questions. The relay can read files and run tools in that workspace. No session id or manual selection is needed.

```json
{ "workspace": "RobuxBot", "question": "What does the bot do, and where is its entry point?" }
```

Pass `session_id` when you specifically want to ask an existing session instead of the relay.

## `/forward`

```text
/forward                              # open the picker
/forward --session <id[,id]> -- text  # send to chosen sessions
/forward --new C:\path\to\workspace -- text
/forward --session <id> --title Handoff -- continue from here
```

With no arguments, the picker lists other sessions grouped by workspace and offers a new-session entry for each workspace. The caller's own session is never a target. Forwarding is fire-and-forget; use `workspace_send` when you need the reply in the current turn.

## Settings

The plugin row has two controls:

- **Show spawned sessions in workspace lists** — off by default. When off, sessions created by `workspace_spawn` or `/forward --new` are subagent-origin and stay out of the sidebar; the relay tools can still reach them by id. Turning it on affects future spawns — new sessions become ordinary sessions attached to their workspace. Origin is immutable, so existing hidden sessions stay hidden.
- **Default wait time** — how long relay tools wait for a reply, in seconds. Default 120, range 0–600; **0 waits indefinitely**. An agent can override it per call with `timeout_ms` (`0` also means indefinite), or skip waiting with `wait: false`.

## Install

Requires DeepSeek Harness `0.2.2-rc.5` or a compatible release. Install this directory as a local plugin through DSH's plugin manager; it also provides a small web client for the settings page and `/forward` picker.

## Development

```powershell
node test.mjs
```

The test exercises the parser/transcript helpers and the client's picker ordering contract. See [docs/DETAIL.md](docs/DETAIL.md) for behavior and limits.
