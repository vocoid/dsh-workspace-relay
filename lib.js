/** Pure formatting and transcript helpers for the workspace-relay plugin. */

export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Extract visible text from a content-block array (or a plain string). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

/** Last assistant text in a committed event slice, or null when the turn produced none. */
export function assistantTextIn(events) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'assistant/message') continue;
    const text = contentText(event.data?.message?.content);
    if (text !== '') return text;
  }
  return null;
}

/** Latest non-empty user text in a session log, or null. */
export function lastUserText(session) {
  if (session === undefined || typeof session.snapshotEvents !== 'function') return null;
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'user/message') continue;
    if (event.data?.source?.kind !== 'user') continue;
    const text = contentText(event.data?.content);
    if (text.trim() !== '') return text;
  }
  return null;
}

/** Split a command line into tokens, honoring single and double quotes. */
export function tokenizeForward(raw) {
  const tokens = [];
  let current = '';
  let quote = null;
  const text = typeof raw === 'string' ? raw : '';
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * Parse `/forward` arguments. Returns { ids, workspace, title, text } or { error }.
 * Grammar: --session/--sessions <id[,id]> | --new/--workspace <dir> [--title <title>]
 * [--text <text> | -- <text>]. A leading `session-...` token is shorthand for --session.
 */
export function parseForward(raw) {
  const tokens = tokenizeForward(raw);
  const result = { ids: [], workspace: undefined, title: undefined, text: '' };
  const textParts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      textParts.push(...tokens.slice(index + 1));
      break;
    }
    if (token === '--text' || token === '--message') {
      textParts.push(...tokens.slice(index + 1));
      break;
    }
    if (token === '--session' || token === '--sessions') {
      const value = tokens[index + 1];
      if (value === undefined) return { error: `${token} needs a session id` };
      index += 1;
      for (const id of value.split(',')) {
        if (id !== '') result.ids.push(id);
      }
      continue;
    }
    if (token === '--new' || token === '--workspace') {
      const value = tokens[index + 1];
      if (value === undefined) return { error: `${token} needs a workspace path or id` };
      index += 1;
      result.workspace = value;
      continue;
    }
    if (token === '--title') {
      const value = tokens[index + 1];
      if (value === undefined) return { error: '--title needs a value' };
      index += 1;
      result.title = value;
      continue;
    }
    if (token.startsWith('--')) return { error: `unknown option ${token}` };
    if (result.ids.length === 0 && result.workspace === undefined
      && /^session-[0-9a-z-]+$/iu.test(token)) {
      result.ids.push(token);
      continue;
    }
    textParts.push(token);
  }
  result.text = textParts.join(' ').trim();
  return result;
}

export function formatTime(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

export function formatWorkspaces(rows) {
  if (rows.length === 0) {
    return 'No workspaces are registered. Use workspace_spawn with an absolute directory to create one.';
  }
  return [
    `Known workspaces (${rows.length}):`,
    ...rows.map(row => [
      `- ${row.title} [${row.id}]`,
      `  ${row.path}`,
      `  ${row.sessionCount} session${row.sessionCount === 1 ? '' : 's'}, ${row.liveCount} live`,
    ].join('\n')),
  ].join('\n');
}

export function formatSessions(rows, meta) {
  const header = `Sessions in "${meta.title}" (${meta.path}): showing ${rows.length} of ${meta.total}`;
  if (rows.length === 0) return `${header}\nNo matching sessions.`;
  return [
    header,
    ...rows.map((row) => {
      const title = row.title ? `"${row.title}"` : '(untitled)';
      const state = row.live ? `live/${row.status ?? 'idle'}` : 'stored';
      const archived = row.archived ? '  archived' : '';
      return `- ${row.id}  ${title}  ${state}  created ${formatTime(row.createdAt)}${archived}`;
    }),
  ].join('\n');
}

export function formatDelivery(id, outcome, maxReplyChars) {
  if (outcome.timedOut) {
    return `[${id}] delivered; no reply before the deadline. The target may still be working.`;
  }
  const reply = outcome.reply === null || outcome.reply === ''
    ? '(no text reply)'
    : truncate(outcome.reply, maxReplyChars);
  return `[${id}] ${reply}`;
}

/** Whether a session title marks a workspace-ask relay session. */
export function isRelayTitle(title) {
  return typeof title === 'string' && title.startsWith('Workspace relay: ');
}

export function formatAsk(workspaceTitle, id, outcome, maxReplyChars) {
  if (outcome.timedOut) {
    return `[${workspaceTitle} · ${id}] delivered; no reply before the deadline. The relay may still be working.`;
  }
  const reply = outcome.reply === null || outcome.reply === ''
    ? '(no text reply)'
    : truncate(outcome.reply, maxReplyChars);
  return `[${workspaceTitle} · ${id}] ${reply}`;
}

/**
 * Resolve a tool's wait deadline:
 * - `wait: false` -> 0 (deliver without waiting)
 * - explicit `timeout_ms: 0` or a 0 default -> null (wait indefinitely)
 * - otherwise a clamped positive millisecond count.
 */
export function resolveWaitMs(wait, timeoutMs, fallback, min, max) {
  if (wait === false) return 0;
  const requested = Number(timeoutMs === undefined || timeoutMs === null ? fallback : timeoutMs);
  if (requested === 0) return null;
  if (!Number.isFinite(requested)) return min;
  return Math.min(max, Math.max(min, Math.trunc(requested)));
}

export function formatSpawn(result, maxReplyChars) {
  const lines = [`Created ${result.sessionId} in ${result.cwd}`];
  if (result.warning) lines.push(result.warning);
  if (result.timedOut) {
    lines.push('Task delivered; no reply before the deadline. The session may still be working.');
  } else {
    const reply = result.reply === null || result.reply === ''
      ? '(no text reply)'
      : truncate(result.reply, maxReplyChars);
    lines.push(reply);
  }
  return lines.join('\n');
}
