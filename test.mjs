import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assistantTextIn,
  contentText,
  formatAsk,
  formatDelivery,
  formatSessions,
  isRelayTitle,
  lastUserText,
  parseForward,
  resolveWaitMs,
  truncate,
} from './lib.js';

assert.equal(truncate('abcdef', 4), 'abc…');
assert.equal(truncate('abc', 4), 'abc');
assert.equal(truncate(null, 4), '');
assert.equal(truncate('abcdef', 0), '…');

assert.equal(contentText('plain'), 'plain');
assert.equal(contentText([
  { type: 'text', text: 'hello' },
  { type: 'image', text: 'ignored' },
  { type: 'text', text: 'world' },
]), 'hello\nworld');
assert.equal(contentText(undefined), '');

const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final' }] } } },
  { type: 'turn/end', data: { turn: 1 } },
];
assert.equal(assistantTextIn(events), 'final');
assert.equal(assistantTextIn([
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } },
  { type: 'assistant/message', data: { message: { content: [] } } },
]), 'answer');
assert.equal(assistantTextIn([]), null);

const sessions = formatSessions([
  { id: 's1', title: 'Worker', createdAt: 0, live: true, status: 'idle', archived: false },
  { id: 's2', title: null, createdAt: 0, live: false, archived: true },
], { title: 'Demo', path: 'C:\\demo', total: 2 });
assert.match(sessions, /s1/);
assert.match(sessions, /live\/idle/);
assert.match(sessions, /archived/);

assert.match(formatDelivery('s1', { timedOut: true }, 10), /no reply/);
assert.match(formatDelivery('s1', { timedOut: false, reply: 'ok' }, 10), /\[s1\] ok/);
assert.equal(isRelayTitle('Workspace relay: Demo'), true);
assert.equal(isRelayTitle('Demo'), false);
assert.match(formatAsk('Demo', 's9', { timedOut: false, reply: 'answer' }, 20), /answer/);
assert.match(formatAsk('Demo', 's9', { timedOut: true }, 20), /no reply/);
assert.equal(resolveWaitMs(false, 9000, 60000, 1000, 600000), 0);
assert.equal(resolveWaitMs(true, 9000, 60000, 1000, 600000), 9000);
assert.equal(resolveWaitMs(true, undefined, 60000, 1000, 600000), 60000);
assert.equal(resolveWaitMs(true, undefined, undefined, 1000, 600000), 1000);
assert.equal(resolveWaitMs(true, 1, 60000, 1000, 600000), 1000);
assert.equal(resolveWaitMs(true, 999999, 60000, 1000, 600000), 600000);
assert.equal(resolveWaitMs(true, '5000', 60000, 1000, 600000), 5000);

assert.deepEqual(parseForward('--session a,b -- hi there'), {
  ids: ['a', 'b'], workspace: undefined, title: undefined, text: 'hi there',
});
assert.deepEqual(parseForward('--new "C:\\x y" -- hi'), {
  ids: [], workspace: 'C:\\x y', title: undefined, text: 'hi',
});
assert.deepEqual(parseForward('--session nope --title Worker -- hello'), {
  ids: ['nope'], workspace: undefined, title: 'Worker', text: 'hello',
});
assert.deepEqual(parseForward('session-abc -- hello'), {
  ids: ['session-abc'], workspace: undefined, title: undefined, text: 'hello',
});
assert.match(parseForward('--wat').error, /unknown option/);
assert.match(parseForward('--session').error, /needs a session id/);
assert.match(parseForward('--new').error, /needs a workspace/);
assert.deepEqual(parseForward('--text keep --literal words').text, 'keep --literal words');

const fakeSession = {
  snapshotEvents: () => [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply' }] } } },
    { type: 'user/message', data: { source: { kind: 'agent' }, content: [{ type: 'text', text: 'injected' }] } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'latest' }] } },
  ],
};
assert.equal(lastUserText(fakeSession), 'latest');
assert.equal(lastUserText(undefined), null);

let loaded;
const window = { __ModuleLoader__: { load: spec => { loaded = spec; } } };
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
new Function('window', 'require', source)(window, () => ({ createElement: () => null, useState: () => [], useEffect: () => {} }));

assert.equal(loaded.id, '@local/dsh-workspace-relay');
assert.equal(typeof loaded.factory, 'function');
const client = loaded.factory(() => ({ createElement: () => null, useState: () => [], useEffect: () => {} }));
assert.equal(typeof client.apply, 'function');
assert.ok(client.inject.includes('slots') && client.inject.includes('locale'));

const registered = { slots: [], decorations: [] };
const disposer = () => {};
const fakeScope = {
  effect: fn => { const off = fn(); assert.equal(typeof off, 'function'); return off; },
  locale: { bind: () => () => 't' },
  commandUi: { decorate: spec => { registered.decorations.push(spec); return disposer; } },
  sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }) } },
  workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
  remote: { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success' } } }) } },
};
const fakeCtx = {
  effect: fn => { const off = fn(); assert.equal(typeof off, 'function'); return off; },
  locale: { register: () => disposer },
  slots: {
    inject: (_slot, fn) => fn(),
    register: spec => { registered.slots.push(spec); return disposer; },
  },
  inject: (_deps, fn) => fn(fakeScope),
};
client.apply(fakeCtx);
assert.equal(registered.slots[0].key, '@local/dsh-workspace-relay#workspace-relay');
assert.equal(registered.decorations[0].name, 'forward');
assert.equal(registered.decorations[0].ui.kind, 'popupSelect');
const pendingOptions = registered.decorations[0].ui.options({ sessionId: 'caller' }, new AbortController().signal);
assert.equal(typeof pendingOptions.then, 'function');
assert.deepEqual(await pendingOptions, []);

const now = Date.now();
fakeScope.sessions.list.getSnapshot = () => ({
  ids: ['s1', 's2'],
  byId: {
    s1: { id: 's1', title: 'Old', displayTitle: 'Old', cwd: 'C:\\a', running: false, updatedAt: now - 10_000 },
    s2: { id: 's2', title: 'Recent', displayTitle: 'Recent', cwd: 'C:\\b', running: false, updatedAt: now },
  },
});
fakeScope.workspaces.list.getSnapshot = () => ({
  items: [
    { workspaceId: 'w1', path: 'C:\\a', title: 'Alpha', updatedAt: new Date(now - 10_000).toISOString() },
    { workspaceId: 'w2', path: 'C:\\b', title: 'Beta', updatedAt: new Date(now).toISOString() },
  ],
});
const recentOptions = await registered.decorations[0].ui.options(
  { sessionId: 'caller' },
  new AbortController().signal,
);
assert.equal(recentOptions[0].group.label, 'Beta');
assert.equal(recentOptions[0].label, 'Recent');
assert.match(recentOptions[0].detail, /^Beta · /);
assert.ok(!recentOptions[0].detail.includes('idle'));
assert.equal(recentOptions[1].id, 'new:C:\\b');
assert.equal(recentOptions[2].label, 'Old');
assert.equal(recentOptions[3].id, 'new:C:\\a');

console.log('workspace-relay helper tests passed');
