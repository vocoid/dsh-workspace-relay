# Workspace Relay

Four tools and a `/forward` command for moving work between DeepSeek Harness workspaces.

## Tools

- `workspace_list` — registered workspaces, their paths, and session counts.
- `workspace_sessions` — sessions in one workspace, with ids, titles, creation time, live state, and archive state.
- `workspace_send` — send one message to one or more session ids; by default waits for each target's turn and returns its reply.
- `workspace_spawn` — create a new session in a workspace, send a task, and optionally wait for the reply.

A spawned session runs with the target workspace as its cwd and the deployment's default agent preset, so it has that workspace's files and its own tools. Use it as a worker, an inspector, or an overseer for another workspace. By default the session is a subagent-origin session: it stays out of the sidebar but the plugin can still reach it by id. Enable the setting below to create ordinary, reopenable sessions instead.

## Forwarding

`/forward` sends the latest user message, or text after `--`, to other sessions:

```
/forward --session session-abc,session-def -- please review the change
/forward --new C:\path\to\workspace -- run the tests
/forward --session session-abc --title Handoff -- continue from here
```

With no arguments, a picker lists other sessions grouped by workspace and one "new session" entry per workspace. Those new sessions use the workspace path and are hidden from the sidebar unless the setting below is on.

## Settings

The plugin row has a settings page with one switch: **Show spawned sessions in workspace lists**. It is off by default. While it is off, sessions created by `workspace_spawn` or `/forward --new` are subagent-origin: they do not appear anywhere in the sidebar. Turning it on makes newly created sessions ordinary sessions attached to their workspace. The switch affects future spawns; an existing hidden session keeps its origin. The tools remain able to reach hidden sessions by id.

## Behavior and limits

- Waiting is a tool call, not a background subscription: the reply is the target turn that claims the sent message. A busy target replies after its current turn.
- Default wait is 120 seconds per target; `timeout_ms` changes it. A timeout returns the session id so the work can be followed later.
- Sending to the caller's own session is refused.
- A spawned session is kept live by the plugin until the plugin unloads or the profile restarts; its log is persisted, and the plugin can resume it. A hidden session has subagent origin, so the sidebar does not offer to open it; use the session id with `workspace_send` instead.
- `workspace_spawn` needs the directory to exist or be creatable. The workspace registration is created on demand.
- A hidden spawned session has no workspace record; `workspace_sessions` cannot find it by workspace path. `workspace_send` still works with its id.
