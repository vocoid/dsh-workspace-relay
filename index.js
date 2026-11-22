/**
 * Workspace relay: list workspaces and sessions, deliver turns to selected
 * sessions, and create worker/overseer sessions in other workspaces.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import {
  assistantTextIn,
  formatAsk,
  formatDelivery,
  formatSessions,
  formatSpawn,
  formatWorkspaces,
  isRelayTitle,
  lastUserText,
  parseForward,
  resolveWaitMs,
} from './lib.js';

export const name = 'workspace-relay';
export const inject = ['tools', 'agents', 'workspaceRegistry', 'sessionQuery', 'commands'];

const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 600_000;
const MAX_REPLY_CHARS = 8_000;
const TOOL_TIMEOUT_MS = MAX_WAIT_MS + 30_000;
const RELAY_TITLE = 'Workspace relay';

const schema = z.object({
  showSpawnedSessions: z.boolean().default(false)
    .description('Show sessions created by workspace_spawn or /forward in their workspace list.'),
  defaultWaitMs: z.number().default(DEFAULT_WAIT_MS)
    .description('Default reply wait in milliseconds for workspace tools. Agents can override with timeout_ms.'),
});
export const Config = typeof schema.volatile === 'function' ? schema.volatile() : schema;

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

export function apply(ctx, source) {
  const live = source !== undefined && typeof source.get === 'function';
  const readConfig = () => (live ? source.get() : (source ?? {}));

  const owned = new Map();
  const relays = new Map();
  ctx.effect(() => () => {
    for (const handle of owned.values()) {
      try { handle.dispose(); } catch { /* dispose is best-effort during unload */ }
    }
    owned.clear();
    relays.clear();
  }, 'workspace-relay.owned-agents');

  ctx.tools.register(defineTool({
    name: 'workspace_list',
    description: 'List the harness workspaces, their directories, and session counts.',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async () => {
      const rows = ctx.workspaceRegistry.list().map((workspace) => {
        const ids = workspace.sessionIds;
        return {
          id: workspace.id,
          title: workspace.title,
          path: workspace.path,
          sessionCount: ids.length,
          liveCount: ids.filter(id => ctx.agents.get(id) !== undefined).length,
        };
      });
      return formatWorkspaces(rows);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'workspace_sessions',
    description: 'List sessions in one workspace with ids, titles, creation time, and live/archive state. '
      + 'Use the ids with workspace_send to choose which sessions receive messages.',
    parameters: {
      workspace: {
        type: 'string',
        required: true,
        description: 'Workspace id, exact title, or absolute directory path.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum sessions to list, 1-100. Default 30.',
      },
      include_archived: {
        type: 'boolean',
        description: 'Include archived sessions. Default false.',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd();
      const workspace = await resolveWorkspace(ctx, args.workspace, cwd);
      if (workspace === undefined) {
        throw new Error(`No workspace matches "${args.workspace}". Use workspace_list, or pass an absolute directory.`);
      }
      const limit = clamp(args.limit ?? 30, 1, 100);
      const archived = new Set(ctx.workspaceRegistry.archivedSessionIds ?? []);
      const records = await ctx.sessionQuery.listSessions();
      let matching = records.filter(record => record.header.cwd === workspace.path
        && record.header.origin !== 'subagent');
      if (args.include_archived !== true) {
        matching = matching.filter(record => !archived.has(record.header.id));
      }
      matching.sort((left, right) => right.header.createdAt - left.header.createdAt);
      const shown = matching.slice(0, limit);
      const titles = await readTitles(ctx, shown);
      const rows = shown.map((record) => {
        const agent = ctx.agents.get(record.header.id);
        return {
          id: record.header.id,
          title: titles.get(record.header.id) ?? null,
          createdAt: record.header.createdAt,
          live: record.live,
          status: agent?.status,
          archived: archived.has(record.header.id),
        };
      });
      return formatSessions(rows, {
        title: workspace.title,
        path: workspace.path,
        total: matching.length,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'workspace_send',
    description: 'Send one message to selected sessions, which may live in different workspaces. '
      + 'By default this waits for each target turn that claims the message and returns its reply. '
      + 'A busy target replies after its current turn.',
    parameters: {
      session_ids: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Session ids from workspace_sessions. One or more; may span workspaces.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Message delivered as a user turn in each target session.',
      },
      wait: {
        type: 'boolean',
        description: 'Wait for each target turn and return replies. Default true.',
      },
      timeout_ms: {
        type: 'integer',
        description: `Per-target wait deadline, 1000-${MAX_WAIT_MS} ms. Default ${DEFAULT_WAIT_MS}.`,
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (args, exec) => {
      if (!Array.isArray(args.session_ids) || args.session_ids.length === 0) {
        throw new Error('session_ids must contain at least one session id');
      }
      const ids = [...new Set(args.session_ids)];
      const callerId = exec.agent?.session.id;
      const waitMs = resolveWaitMs(
        args.wait,
        args.timeout_ms,
        readConfig().defaultWaitMs ?? DEFAULT_WAIT_MS,
        1_000,
        MAX_WAIT_MS,
      );
      const outcomes = await Promise.all(ids.map(async (id) => {
        if (id === callerId) {
          return { id, error: 'refusing to send to the calling session' };
        }
        try {
          const agent = await getOrResumeAgent(ctx, id, owned);
          const delivery = await deliver(ctx, agent, args.message, waitMs, exec.signal);
          return { id, delivery };
        } catch (error) {
          return { id, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      return outcomes
        .map(outcome => outcome.error
          ? `[${outcome.id}] error: ${outcome.error}`
          : formatDelivery(outcome.id, outcome.delivery, MAX_REPLY_CHARS))
        .join('\n\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'workspace_ask',
    description: 'Ask a question in another workspace without choosing a session. '
      + 'The first ask creates a dedicated hidden relay session in that workspace and later asks reuse it. '
      + 'The relay runs with that workspace as its working directory, so it can inspect and use tools there. '
      + 'Pass session_id to ask an existing session instead. By default this waits for the reply.',
    parameters: {
      workspace: {
        type: 'string',
        required: true,
        description: 'Workspace id, exact title, or registered directory path.',
      },
      question: {
        type: 'string',
        required: true,
        description: 'Question or task for the workspace relay.',
      },
      session_id: {
        type: 'string',
        description: 'Optional existing session id in that workspace. Omit to use the automatic relay.',
      },
      wait: {
        type: 'boolean',
        description: 'Wait for the reply. Default true.',
      },
      timeout_ms: {
        type: 'integer',
        description: `Wait deadline, 1000-${MAX_WAIT_MS} ms. Default ${DEFAULT_WAIT_MS}.`,
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (args, exec) => {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (question === '') throw new Error('question must not be empty');
      const callerCwd = exec.agent?.session.header.cwd ?? process.cwd();
      const workspace = await resolveWorkspace(ctx, args.workspace, callerCwd);
      if (workspace === undefined) {
        throw new Error(`No workspace matches "${args.workspace}". Use workspace_list, or pass an absolute directory.`);
      }
      const waitMs = resolveWaitMs(
        args.wait,
        args.timeout_ms,
        readConfig().defaultWaitMs ?? DEFAULT_WAIT_MS,
        1_000,
        MAX_WAIT_MS,
      );

      let target;
      if (typeof args.session_id === 'string' && args.session_id !== '') {
        if (args.session_id === exec.agent?.session.id) {
          throw new Error('refusing to ask the calling session');
        }
        target = await getOrResumeAgent(ctx, args.session_id, owned);
        if (target.session.header.cwd !== workspace.path) {
          throw new Error(`session "${args.session_id}" is not in workspace "${workspace.title}"`);
        }
      } else {
        target = await getRelayAgent(ctx, readConfig, workspace, owned, relays);
      }
      if (target.session.id === exec.agent?.session.id) {
        throw new Error('refusing to ask the calling session');
      }

      const delivery = await deliver(ctx, target, question, waitMs, exec.signal);
      return formatAsk(workspace.title, target.session.id, delivery, MAX_REPLY_CHARS);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'workspace_spawn',
    description: 'Create a new session in a target workspace and give it a task. '
      + 'The new session runs with that workspace as its working directory and its own tools, so it '
      + 'can inspect, change, or oversee that workspace. Use it as a worker or overseer, or when no '
      + 'existing session is suitable. By default this waits for the first reply. Spawned sessions '
      + 'are subagent-origin and hidden from the sidebar unless the showSpawnedSessions setting is on.',
    parameters: {
      workspace: {
        type: 'string',
        required: true,
        description: 'Workspace id, exact title, or absolute directory path. A missing directory is created.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'Task for the new session.',
      },
      title: {
        type: 'string',
        description: 'Optional pinned session title.',
      },
      agent_preset: {
        type: 'string',
        description: 'Optional agent preset id. Omit for the deployment default.',
      },
      wait: {
        type: 'boolean',
        description: 'Wait for the first reply. Default true.',
      },
      timeout_ms: {
        type: 'integer',
        description: `Wait deadline, 1000-${MAX_WAIT_MS} ms. Default ${DEFAULT_WAIT_MS}.`,
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    execute: async (args, exec) => {
      const callerCwd = exec.agent?.session.header.cwd ?? process.cwd();
      const requested = isAbsolute(args.workspace)
        ? args.workspace
        : resolve(callerCwd, args.workspace);
      const created = await createSessionIn(ctx, readConfig, requested, {
        title: args.title,
        agentPreset: args.agent_preset,
      }, owned);
      const waitMs = resolveWaitMs(
        args.wait,
        args.timeout_ms,
        readConfig().defaultWaitMs ?? DEFAULT_WAIT_MS,
        1_000,
        MAX_WAIT_MS,
      );
      const delivery = await deliver(ctx, created.handle.agent, args.message, waitMs, exec.signal);
      return formatSpawn({
        sessionId: created.handle.agent.id,
        cwd: created.cwd,
        warning: created.warning,
        timedOut: delivery.timedOut === true,
        reply: delivery.reply ?? null,
      }, MAX_REPLY_CHARS);
    },
  }));

  ctx.commands.register({
    name: 'forward',
    description: 'Forward the latest user message, or text after --, to selected sessions or a new session in a workspace.',
    input: {
      hint: '--session <id[,id]> | --new <workspace> [--title <title>] [-- <text>]',
    },
    handler: async (invocation) => forwardCommand(ctx, readConfig, owned, invocation),
  });
}

async function createSessionIn(ctx, readConfig, requested, options, owned) {
  await mkdir(requested, { recursive: true });
  const cwd = await realpath(requested);
  const composition = await compose(ctx, options.agentPreset);
  const visible = readConfig().showSpawnedSessions === true;
  const handle = await ctx.agents.create({
    sessionId: `session-${randomUUID()}`,
    meta: {
      cwd,
      ...(visible ? {} : { origin: 'subagent' }),
      ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
    },
    agentOptions: defaultAgentOptions(ctx),
    setup: composition.setup,
  });
  owned.set(handle.agent.id, handle);

  let warning;
  if (visible) {
    try {
      const workspace = await ensureWorkspace(ctx, cwd);
      await workspace.attachSession(handle.agent.id);
    } catch (error) {
      warning = appendWarning(warning,
        `warning: session created but not attached to a workspace: ${messageOf(error)}`);
    }
  }
  if (options.title !== undefined && options.title !== '') {
    try {
      const titleService = ctx.get('sessionTitle');
      if (titleService === undefined) {
        warning = appendWarning(warning, 'warning: session title service unavailable; title not set');
      } else {
        titleService.rename(handle.agent.session, options.title);
      }
    } catch (error) {
      warning = appendWarning(warning, `warning: title not set: ${messageOf(error)}`);
    }
  }
  return { handle, cwd, warning };
}

async function getRelayAgent(ctx, readConfig, workspace, owned, relays) {
  const remembered = relays.get(workspace.id);
  if (remembered !== undefined) {
    try {
      const agent = await getOrResumeAgent(ctx, remembered, owned);
      if (agent.session.header.cwd === workspace.path) return agent;
    } catch { /* stale relay record; discover or create another below */ }
  }

  const found = await findRelaySession(ctx, workspace);
  if (found !== undefined) {
    try {
      const agent = await getOrResumeAgent(ctx, found, owned);
      if (agent.session.header.cwd === workspace.path) {
        relays.set(workspace.id, agent.session.id);
        return agent;
      }
    } catch { /* stale relay record; create a new one below */ }
  }

  const created = await createSessionIn(ctx, readConfig, workspace.path, {
    title: `${RELAY_TITLE}: ${workspace.title}`,
    agentPreset: undefined,
  }, owned);
  relays.set(workspace.id, created.handle.agent.id);
  return created.handle.agent;
}

async function findRelaySession(ctx, workspace) {
  let records;
  try {
    records = await ctx.sessionQuery.listSessions();
  } catch {
    return undefined;
  }
  const candidates = records.filter(record => record.header.cwd === workspace.path
    && record.header.parentSession === undefined
    && !(ctx.workspaceRegistry.archivedSessionIds ?? []).includes(record.header.id));
  if (candidates.length === 0) return undefined;
  const titles = await readTitles(ctx, candidates);
  let newest;
  for (const record of candidates) {
    if (!isRelayTitle(titles.get(record.header.id))) continue;
    if (newest === undefined || record.header.createdAt > newest.header.createdAt) newest = record;
  }
  return newest?.header.id;
}

async function forwardCommand(ctx, readConfig, owned, invocation) {
  const parsed = parseForward(invocation.rawInput);
  if (parsed.error !== undefined) return { kind: 'error', text: parsed.error };
  if (parsed.workspace !== undefined && parsed.ids.length > 0) {
    return { kind: 'error', text: 'Choose either --session or --new, not both.' };
  }

  const caller = invocation.agent;
  const text = parsed.text || lastUserText(caller.session) || '';
  if (text.trim() === '') {
    return { kind: 'error', text: 'Nothing to forward: pass text after --, or send a message first.' };
  }
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });

  if (parsed.workspace !== undefined) {
    const cwd = caller.session.header.cwd ?? process.cwd();
    const requested = isAbsolute(parsed.workspace) ? parsed.workspace : resolve(cwd, parsed.workspace);
    try {
      const created = await createSessionIn(ctx, readConfig, requested, {
        title: parsed.title ?? 'Forwarded message',
        agentPreset: undefined,
      }, owned);
      created.handle.agent.followup(message);
      const warning = created.warning === undefined ? '' : `\n${created.warning}`;
      return { kind: 'success', text: `Created ${created.handle.agent.id} in ${created.cwd} and forwarded.${warning}` };
    } catch (error) {
      return { kind: 'error', text: `Forward failed: ${messageOf(error)}` };
    }
  }

  const ids = [...new Set(parsed.ids)].filter(id => id !== caller.session.id);
  if (ids.length === 0) {
    return { kind: 'error', text: 'No target sessions. Use --session <id> or --new <workspace>.' };
  }
  const sent = [];
  const failed = [];
  for (const id of ids) {
    try {
      const agent = await getOrResumeAgent(ctx, id, owned);
      agent.followup(message);
      sent.push(id);
    } catch (error) {
      failed.push(`${id}: ${messageOf(error)}`);
    }
  }
  if (sent.length === 0) return { kind: 'error', text: `Forward failed:\n${failed.join('\n')}` };
  const lines = [`Forwarded to ${sent.length} session${sent.length === 1 ? '' : 's'}: ${sent.join(', ')}`];
  if (failed.length > 0) lines.push(`Failed: ${failed.join('; ')}`);
  return { kind: 'success', text: lines.join('\n') };
}

async function resolveWorkspace(ctx, needle, cwd) {  const list = ctx.workspaceRegistry.list();
  const text = needle.trim();
  const exact = list.find(workspace => workspace.id === text
    || workspace.path === text
    || workspace.title === text);
  if (exact !== undefined) return exact;

  let candidate = text;
  if (!isAbsolute(candidate)) candidate = resolve(cwd, candidate);
  try {
    const canonical = await realpath(candidate);
    const byPath = list.find(workspace => workspace.path === canonical);
    if (byPath !== undefined) return byPath;
  } catch { /* the path may not exist yet; title matching still applies */ }

  const lower = text.toLowerCase();
  return list.find(workspace => workspace.title.toLowerCase() === lower
    || workspace.path.toLowerCase() === lower);
}

async function ensureWorkspace(ctx, cwd) {
  const existing = ctx.workspaceRegistry.list().find(workspace => workspace.path === cwd);
  if (existing !== undefined) return existing;
  return await ctx.workspaceRegistry.create(cwd, basename(cwd));
}

async function readTitles(ctx, records) {
  const titles = new Map();
  if (records.length === 0) return titles;
  try {
    const results = await ctx.sessionQuery.readTitleSnapshots(records.map(record => record.header.id));
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.title !== undefined) {
        titles.set(result.value.session.id, result.value.title.title);
      }
    }
  } catch { /* titles are optional display data */ }
  return titles;
}

async function getOrResumeAgent(ctx, id, owned) {
  const live = ctx.agents.get(id);
  if (live !== undefined) return live;

  let observation;
  try {
    observation = await ctx.sessionQuery.readTitleSnapshot(id);
  } catch {
    throw new Error(`session "${id}" was not found`);
  }
  if (observation.session.origin === 'subagent' && observation.session.parentSession !== undefined) {
    throw new Error(`session "${id}" is a subagent session; address its parent or use the agent-team tools`);
  }

  const composition = await compose(ctx, observation.session.agentPreset);
  try {
    const handle = await ctx.agents.resume({
      resumeSessionId: id,
      agentOptions: defaultAgentOptions(ctx),
      setup: composition.setup,
    });
    owned.set(id, handle);
    return handle.agent;
  } catch (error) {
    const raced = ctx.agents.get(id);
    if (raced !== undefined) return raced;
    throw error;
  }
}

async function compose(ctx, presetId) {
  const presets = ctx.get('agentPresets');
  if (presets === undefined) {
    return {
      agentPreset: undefined,
      setup: (agentCtx) => { installModelSelection(agentCtx); },
    };
  }
  const resolved = await presets.resolve(presetId);
  return {
    agentPreset: resolved.id,
    setup: async (agentCtx) => {
      installModelSelection(agentCtx);
      await presets.mount(agentCtx, resolved.id);
    },
  };
}

function defaultAgentOptions(ctx) {
  const defaults = ctx.get('agentDefaultModel');
  if (defaults === undefined) return undefined;
  return {
    get provider() { return defaults.currentSelection().provider; },
    get model() { return defaults.currentSelection().model; },
    get reasoningEffort() { return defaults.currentSelection().reasoningEffort; },
  };
}

async function deliver(ctx, agent, text, waitMs, signal) {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
  if (waitMs <= 0) {
    agent.followup(message);
    return { delivered: true, timedOut: false };
  }

  const session = agent.session;
  const disposers = [];
  let targetTurn;
  let turnStartSeq;
  let lastTurnStart;
  try {
    const reply = new Promise((resolveReply, rejectReply) => {
      disposers.push(ctx.on('session/event', (subject, event) => {
        if (subject.id !== session.id) return;
        if (event.type === 'turn/start') {
          lastTurnStart = { turn: event.data.turn, seq: event.seq };
        }
        if (event.type === 'turn/end' && targetTurn !== undefined && event.data.turn === targetTurn) {
          resolveReply(event);
        }
      }));
      disposers.push(ctx.on('agent/inbox/claimed', (payload) => {
        if (payload.agent.session.id !== session.id || payload.message.id !== message.id) return;
        targetTurn = payload.turn;
        turnStartSeq = lastTurnStart?.turn === targetTurn ? lastTurnStart.seq : undefined;
      }));
      try {
        agent.followup(message);
      } catch (error) {
        rejectReply(error);
      }
    });

    const end = await withTimeout(reply, waitMs, signal);
    if (end === null) return { delivered: true, timedOut: true };
    if (turnStartSeq === undefined) turnStartSeq = findTurnStart(session, targetTurn);
    const events = turnStartSeq === undefined
      ? []
      : session.snapshotEvents(turnStartSeq, end.seq + 1);
    return {
      delivered: true,
      timedOut: false,
      reply: assistantTextIn(events),
      reason: end.data.reason,
    };
  } finally {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* listener already disposed */ }
    }
  }
}

function findTurnStart(session, turn) {
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'turn/start' && event.data.turn === turn) return index;
  }
  return undefined;
}

function withTimeout(promise, ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      settle(value);
    };
    const onAbort = () => finish(rejectPromise, signal?.reason ?? new Error('aborted'));
    const timer = setTimeout(() => finish(resolvePromise, null), Math.max(1, ms));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    promise.then(value => finish(resolvePromise, value), error => finish(rejectPromise, error));
  });
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function appendWarning(current, next) {
  return current === undefined ? next : `${current}\n${next}`;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
