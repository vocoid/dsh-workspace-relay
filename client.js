window.__ModuleLoader__.load({
  id: '@local/dsh-workspace-relay',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const NS = 'workspaceRelay';
    const SLOT = 'plugins.row.config';
    const ROW_KEY = '@local/dsh-workspace-relay#workspace-relay';

    const en = {
      summary: 'Workspace relay messages and spawned sessions.',
      title: 'Show spawned sessions in workspace lists',
      hint: 'Off creates hidden subagent-origin sessions. Turn it on to create ordinary sessions attached to their workspace.',
      loading: 'Loading configuration…',
      unavailable: 'Configuration is unavailable for this profile.',
      readOnly: 'This profile is read-only.',
      saveFailed: 'Could not save the setting.',
      conflict: 'The configuration changed. Reopen this page and try again.',
      waitTitle: 'Default wait time',
      waitHint: 'Seconds to wait for a reply. Agents can override it per call with timeout_ms.',
      save: 'Save',
      invalidWait: 'Enter 1–600 seconds.',
      searchPlaceholder: 'Search sessions or workspaces…',
      empty: 'No other sessions or workspaces.',
      noResults: 'No matching sessions or workspaces.',
      newGroup: 'New session',
      newIn: 'New session in',
      untitled: 'Untitled session',
      justNow: 'just now',
      minutesAgo: 'm ago',
      hoursAgo: 'h ago',
      daysAgo: 'd ago',
      forwardError: 'Forward failed',
    };
    const zh = {
      summary: '跨工作区消息与会话。',
      title: '在工作区列表中显示派生的会话',
      hint: '关闭时会创建隐藏的 subagent 会话；开启后会创建普通会话并附加到对应工作区。',
      loading: '正在加载配置…',
      unavailable: '当前 profile 的配置不可用。',
      readOnly: '当前 profile 为只读。',
      saveFailed: '无法保存设置。',
      conflict: '配置已变化，请重新打开此页面后再试。',
      waitTitle: '默认等待时间',
      waitHint: '等待回复的秒数。agent 可以在每次调用时用 timeout_ms 覆盖。',
      save: '保存',
      invalidWait: '请输入 1–600 秒。',
      searchPlaceholder: '搜索会话或工作区…',
      empty: '没有其他会话或工作区。',
      noResults: '没有匹配的会话或工作区。',
      newGroup: '新会话',
      newIn: '在以下位置新建会话：',
      untitled: '未命名会话',
      justNow: '刚刚',
      minutesAgo: '分钟前',
      hoursAgo: '小时前',
      daysAgo: '天前',
      forwardError: '转发失败',
    };

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'workspace-relay: dictionaries');

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        key: ROW_KEY,
        locale: NS,
      }, ({ view, form, t }) => (view === 'summary'
        ? t('summary')
        : h(Settings, { form, t }))));

      ctx.inject(['commandUi', 'sessions', 'workspaces', 'remote', 'remote.commands'], (scope) => {
        const t = scope.locale.bind(NS);
        scope.effect(() => scope.commandUi.decorate({
          name: 'forward',
          available: () => true,
          ui: {
            kind: 'popupSelect',
            searchMode: 'fuzzy-label',
            searchLabels: () => ({
              placeholder: t('searchPlaceholder'),
              empty: t('empty'),
              noResults: t('noResults'),
            }),
            options: async (session) => forwardOptions(scope, t, session),
            onSelect: async (option, session) => {
              const line = option.id.startsWith('new:')
                ? `/forward --new ${JSON.stringify(option.id.slice(4))}`
                : `/forward --session ${option.id.slice(8)}`;
              const result = await scope.remote.commands.execute(session.sessionId, line, []);
              if (!result.ok) throw new Error(`${t('forwardError')}: ${result.error.message}`);
              if (result.value === undefined) throw new Error(`${t('forwardError')}: unknown command`);
              if (result.value.result.kind === 'error') throw new Error(result.value.result.text);
            },
          },
        }), 'workspace-relay: /forward picker');
      });
    }

    function forwardOptions(scope, t, caller) {
      const sessions = scope.sessions.list.getSnapshot();
      const workspaces = scope.workspaces.list.getSnapshot();
      const rows = sessions.ids
        .map(id => sessions.byId[id])
        .filter(row => row !== undefined && row.origin !== 'subagent' && row.id !== caller.sessionId);
      const usedAt = new Map();
      for (const row of rows) {
        if (row.cwd === undefined) continue;
        usedAt.set(row.cwd, Math.max(usedAt.get(row.cwd) ?? 0, row.updatedAt ?? 0));
      }
      const workspaceUsedAt = (workspace) => {
        const touched = Number.isNaN(Date.parse(workspace.updatedAt)) ? 0 : Date.parse(workspace.updatedAt);
        return Math.max(usedAt.get(workspace.path) ?? 0, touched);
      };
      const ordered = [...workspaces.items].sort((left, right) =>
        workspaceUsedAt(right) - workspaceUsedAt(left) || left.title.localeCompare(right.title));
      const byPath = new Map(ordered.map(workspace => [workspace.path, workspace]));
      const titleOf = (row) => typeof row.title === 'string' && row.title !== ''
        ? row.title
        : row.displayTitle === row.id ? t('untitled') : row.displayTitle;
      const formatLastUsed = (updatedAt) => {
        if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return '';
        const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60_000));
        if (minutes < 1) return t('justNow');
        if (minutes < 60) return `${minutes}${t('minutesAgo')}`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}${t('hoursAgo')}`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}${t('daysAgo')}`;
        return new Date(updatedAt).toLocaleDateString();
      };
      const sessionOption = (row, workspace, group) => {
        const where = workspace === undefined ? baseName(row.cwd) : workspace.title;
        const detail = [where, formatLastUsed(row.updatedAt)].filter(part => part !== '').join(' · ');
        return {
          id: `session:${row.id}`,
          label: titleOf(row),
          detail,
          group,
        };
      };
      const options = [];
      const assigned = new Set();
      for (const workspace of ordered) {
        const group = { name: `ws:${workspace.workspaceId}`, label: workspace.title };
        const groupRows = rows
          .filter(row => row.cwd !== undefined && byPath.get(row.cwd) === workspace)
          .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
            || titleOf(left).localeCompare(titleOf(right)));
        for (const row of groupRows) {
          assigned.add(row.id);
          options.push(sessionOption(row, workspace, group));
        }
        options.push({
          id: `new:${workspace.path}`,
          label: `${t('newIn')} ${workspace.title}`,
          detail: workspace.path,
          group,
        });
      }
      const rest = rows
        .filter(row => !assigned.has(row.id))
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
          || titleOf(left).localeCompare(titleOf(right)));
      for (const row of rest) {
        options.push(sessionOption(row, undefined, {
          name: 'other',
          label: baseName(row.cwd) || t('newGroup'),
        }));
      }
      return options;
    }

    function baseName(path) {
      if (typeof path !== 'string' || path === '') return '';
      const parts = path.split(/[\\/]/u).filter(Boolean);
      return parts.length === 0 ? path : parts[parts.length - 1];
    }

    function Settings({ form, t }) {
      const state = form?.state;
      const [value, setValue] = React.useState(undefined);
      const [waitSeconds, setWaitSeconds] = React.useState(undefined);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState(undefined);
      const revision = state?.status === 'ready' ? state.revision : undefined;
      React.useEffect(() => {
        if (state?.status !== 'ready') return;
        setValue(state.value?.showSpawnedSessions === true);
        setWaitSeconds(Math.round((state.value?.defaultWaitMs ?? 120_000) / 1_000));
      }, [state?.status, revision]);

      if (form === undefined || state?.status === 'loading') {
        return h('p', { role: 'status' }, t('loading'));
      }
      if (state?.status !== 'ready' || state.value === undefined || state.revision === undefined) {
        return h('p', { role: 'status' }, t('unavailable'));
      }
      if (!state.writable) return h('p', { role: 'status' }, t('readOnly'));

      const enabled = value ?? (state.value.showSpawnedSessions === true);
      const disabled = saving;
      async function toggle() {
        if (disabled) return;
        const next = !enabled;
        setSaving(true);
        setError(undefined);
        try {
          const saved = await form.mutate(
            [{ op: 'set', path: ['showSpawnedSessions'], value: next }],
            state.revision,
          );
          if (!saved) throw new Error(t('conflict'));
          setValue(next);
        } catch (caught) {
          setError(caught instanceof Error && caught.message !== undefined ? caught.message : t('saveFailed'));
        } finally {
          setSaving(false);
        }
      }

      async function saveWait() {
        if (disabled) return;
        const seconds = Number(waitSeconds);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
          setError(t('invalidWait'));
          return;
        }
        setSaving(true);
        setError(undefined);
        try {
          const saved = await form.mutate(
            [{ op: 'set', path: ['defaultWaitMs'], value: Math.round(seconds * 1_000) }],
            state.revision,
          );
          if (!saved) throw new Error(t('conflict'));
        } catch (caught) {
          setError(caught instanceof Error && caught.message !== undefined ? caught.message : t('saveFailed'));
        } finally {
          setSaving(false);
        }
      }

      return h('div', { style: { display: 'grid', gap: 12 } }, [
        h('p', { key: 'summary', style: { margin: 0 } }, t('summary')),
        h('div', {
          key: 'toggle',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
        }, [
          h('div', { key: 'copy', style: { display: 'grid', gap: 4 } }, [
            h('span', { key: 'title', style: { fontWeight: 600 } }, t('title')),
            h('small', { key: 'hint', style: { opacity: 0.7 } }, t('hint')),
          ]),
          h('button', {
            key: 'switch',
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': t('title'),
            disabled,
            onClick: toggle,
            style: {
              position: 'relative',
              width: 40,
              height: 22,
              padding: 0,
              border: 'none',
              borderRadius: 999,
              background: enabled
                ? 'var(--dsw-alias-accent-fill, #4c8dff)'
                : 'var(--dsw-alias-border-l4, #777)',
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.6 : 1,
              flex: 'none',
            },
          }, h('span', {
            style: {
              position: 'absolute',
              top: 3,
              left: enabled ? 21 : 3,
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: '#fff',
              transition: 'left 120ms ease',
            },
          })),
        ]),
        h('div', {
          key: 'wait',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
        }, [
          h('div', { key: 'copy', style: { display: 'grid', gap: 4 } }, [
            h('span', { key: 'title', style: { fontWeight: 600 } }, t('waitTitle')),
            h('small', { key: 'hint', style: { opacity: 0.7 } }, t('waitHint')),
          ]),
          h('div', { key: 'control', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            h('input', {
              key: 'seconds',
              type: 'number',
              min: 1,
              max: 600,
              step: 1,
              value: waitSeconds ?? '',
              disabled,
              'aria-label': t('waitTitle'),
              onChange: event => setWaitSeconds(event.target.value),
              style: { width: 80 },
            }),
            h('button', {
              key: 'save',
              type: 'button',
              disabled,
              onClick: saveWait,
            }, t('save')),
          ]),
        ]),
        error === undefined ? null : h('p', {
          key: 'error',
          role: 'status',
          style: { margin: 0, color: 'var(--dsw-alias-text-danger, #e5484d)' },
        }, error),
      ]);
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
