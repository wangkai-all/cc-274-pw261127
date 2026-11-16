/**
 * Operator console.
 *
 * Plain ES modules, no build step. Every user-supplied string is escaped at
 * render time; nothing is ever injected as HTML from the server or from rule
 * source.
 */

const state = {
  meta: null,
  live: null,
  versions: [],
  selectedVersionId: null,
  selectedVersion: null,
  editor: null,
  editorDirty: false,
  preview: null,
  previewToken: 0,
  results: null,
  resultsOffset: 0,
  adjudications: null,
  adjBefore: null,
  jobs: [],
  epochDetail: null,
  verify: null,
  pollTimer: null,
  stream: null,
  busy: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtNumber(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(value);
}

function fmtTime(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function fmtClock(ms) {
  if (!ms || ms < 0) return '—';
  return `${Math.round(ms)}ms`;
}

function truncate(text, max = 26) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.className = 'toast';
  }, 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    method: options.method ?? 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `请求失败（${response.status}）`);
    error.code = payload?.error?.code;
    error.status = response.status;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

// ------------------------------------------------------------------ bootstrap

async function boot() {
  wireTabs();
  wireOverview();
  wireRules();
  wireResults();
  wireTimeline();
  try {
    state.meta = await api('/api/meta');
  } catch (error) {
    toast(`无法载入元数据：${error.message}`, 'error');
  }
  await refreshLive();
  await refreshVersions();
  renderHelp();
  startPolling();
  connectStream();
}

function showView(name) {
  for (const tab of $$('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  }
  for (const view of $$('.view')) {
    view.hidden = view.id !== `view-${name}`;
  }
  if (name === 'results') {
    refreshResults().catch(() => {});
    refreshAdjudications(true).catch(() => {});
  }
  if (name === 'timeline') {
    renderTimeline().catch(() => {});
  }
  if (name === 'rules') {
    renderChangeCard();
  }
}

function wireTabs() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    refreshLive().catch(() => {});
  }, 2500);
}

function connectStream() {
  if (!('EventSource' in window)) return;
  try {
    const source = new EventSource('/api/stream');
    source.addEventListener('engine', () => {
      refreshLive().catch(() => {});
    });
    source.onerror = () => {
      source.close();
      state.stream = null;
    };
    state.stream = source;
  } catch {
    // Polling covers this.
  }
}

// -------------------------------------------------------------------- overview

async function refreshLive() {
  const live = await api('/api/state');
  state.live = live;
  const initialised = state.meta !== null;
  renderTopbar();
  renderOverview();
  renderJobs();
  renderStale();
  renderPause();
  if (state.live.simulator) renderSimulator(state.live.simulator);
  if (!initialised) return;
  const activeJob = live.jobs?.find((job) => ['running', 'queued', 'ready'].includes(job.status));
  if (activeJob && !state.jobsSeen) state.jobsSeen = activeJob.id;
  if (state.jobsSeen && !live.jobs?.some((job) => job.id === state.jobsSeen && ['running', 'queued'].includes(job.status))) {
    state.jobsSeen = null;
    refreshVersions().catch(() => {});
    if (!$('#view-timeline').hidden) renderTimeline().catch(() => {});
  }
}

function renderTopbar() {
  const box = $('#topbar-status');
  const live = state.live;
  if (!live) {
    box.innerHTML = '<span class="pill pill-muted">连接中…</span>';
    return;
  }
  const paused = live.paused;
  const jobs = (live.jobs ?? []).filter((job) => ['running', 'queued', 'ready'].includes(job.status));
  const parts = [
    paused
      ? '<span class="pill pill-warn">执行器已暂停</span>'
      : '<span class="pill pill-live">执行器活动</span>',
    `<span class="pill pill-muted">v${esc(live.runtime?.versionId ?? '—')}</span>`,
    `<span class="pill pill-muted">fence ${esc(live.runtime?.fence ?? '—')}</span>`,
  ];
  if (jobs.length > 0) {
    parts.push(`<span class="pill pill-info">重建中 ${esc(jobs.length)}</span>`);
  }
  if (live.counts?.staleReports > 0) {
    parts.push(`<span class="pill pill-danger">拒绝上报 ${esc(live.counts.staleReports)}</span>`);
  }
  box.innerHTML = parts.join('');
  $('#live-pill').textContent = paused ? '已暂停' : '活动';
  $('#live-pill').className = `pill ${paused ? 'pill-warn' : 'pill-live'}`;
}

function renderOverview() {
  const live = state.live;
  if (!live) return;
  const version = live.activeVersion;
  const epoch = live.activeEpoch;

  $('#active-summary').innerHTML = version
    ? `
      <div class="list-item active">
        <div>
          <div class="version-title">v${esc(version.id)} · ${esc(version.label)}</div>
          <div class="version-desc">${esc(version.summary?.description ?? '')}</div>
        </div>
        <span class="pill ${live.paused ? 'pill-warn' : 'pill-live'}">${live.paused ? '暂停' : '活动'}</span>
      </div>
      <dl class="kv">
        <dt>epoch</dt><dd>#${esc(epoch?.id ?? '—')} · ${esc(epoch?.strategy ?? '—')}</dd>
        <dt>过滤</dt><dd>${esc(version.spec?.filter ?? '（无）')}</dd>
        <dt>分组</dt><dd>${esc(version.spec?.group ?? '')}</dd>
        <dt>去重</dt><dd>${esc(version.spec?.dedup ?? '（无）')}</dd>
        <dt>度量</dt><dd>${esc(version.spec?.measure ?? '')} · ${esc(AGG[version.spec?.aggregate] ?? version.spec?.aggregate)}</dd>
        <dt>窗口</dt><dd>${esc(windowText(version.spec?.window))}</dd>
        <dt>水位线</dt><dd>${esc(live.watermark === null ? '未建立' : fmtTime(live.watermark))}</dd>
        <dt>语义哈希</dt><dd>${esc(version.semanticHash ?? '—')}</dd>
      </dl>
    `
    : '<div class="empty">尚无活动规则</div>';

  const c = live.counters ?? {};
  $('#counters').innerHTML = [
    metric('计入事件', c.accepted),
    metric('过滤', c.filtered),
    metric('重复', c.duplicate, 'warn'),
    metric('迟到', c.late, 'warn'),
    metric('窗口写入', c.acceptedWindows, 'accent'),
    metric('开放窗口', live.openWindows, 'accent'),
  ].join('');

  $('#counts').innerHTML = [
    metric('原始事件', live.counts?.rawEvents),
    metric('已关闭结果', live.counts?.closedResults),
    metric('逐条判定', live.counts?.adjudications),
    metric('过期上报', live.counts?.staleReports, (live.counts?.staleReports ?? 0) > 0 ? 'danger' : ''),
    metric('隔离事件', live.counts?.quarantine, (live.counts?.quarantine ?? 0) > 0 ? 'warn' : ''),
    metric('规则版本', live.counts?.versions),
  ].join('');
}

function metric(label, value, tone = '') {
  return `<div class="metric ${tone}"><div class="label">${esc(label)}</div><div class="value">${esc(fmtNumber(value))}</div></div>`;
}

function windowText(window) {
  if (!window) return '—';
  return window.kind === 'tumbling'
    ? `滚动 ${window.sizeMs}ms / 迟到 ${window.allowedLatenessMs}ms / 偏移 ${window.offsetMs}ms`
    : `滑动 ${window.sizeMs}ms 步长 ${window.slideMs}ms / 迟到 ${window.allowedLatenessMs}ms / 偏移 ${window.offsetMs}ms`;
}

const AGG = { sum: '求和', count: '计数', avg: '平均', min: '最小', max: '最大' };

function renderJobs() {
  const jobs = state.live?.jobs ?? [];
  state.jobs = jobs;
  const box = $('#jobs');
  const hint = $('#jobs-hint');
  if (jobs.length === 0) {
    box.innerHTML = '<div class="empty">没有重建任务。发布需要重建的规则时会在这里出现进度。</div>';
    hint.textContent = '';
    return;
  }
  const active = jobs.filter((job) => ['running', 'queued', 'ready'].includes(job.status));
  hint.textContent = active.length > 0 ? `${active.length} 个进行中` : '最近记录';
  box.innerHTML = jobs
    .map((job) => {
      const running = ['running', 'queued', 'ready'].includes(job.status);
      const pct = Math.round((job.progress ?? 0) * 100);
      return `
        <div class="change" style="border-left-color:${
          job.status === 'done' ? 'var(--accent-strong)' : job.status === 'failed' || job.status === 'aborted' ? 'var(--danger)' : 'var(--blue)'
        }">
          <div class="change-head">
            <strong>#${esc(job.id)} v${esc(job.versionId)}</strong>
            <span class="pill ${job.status === 'done' ? 'pill-live' : job.status === 'failed' || job.status === 'aborted' ? 'pill-danger' : 'pill-info'}">${esc(jobStatusLabel(job.status))}</span>
            <span class="hint">${esc(job.strategyLabel)}</span>
            ${running ? `<button class="btn btn-small" data-cancel-job="${job.id}">取消</button>` : ''}
          </div>
          <div class="hint">重放 ${esc(fmtNumber(job.replayed))} / 目标 ${esc(fmtNumber(job.targetSeq))} · 落后 ${esc(fmtNumber(job.lagEvents))} 条 · 阶段 ${esc(job.phase ?? '—')}</div>
          ${running ? `<div class="bar" style="margin-top:6px"><span style="width:${pct}%"></span></div>` : ''}
          ${job.error ? `<div class="hint" style="color:var(--danger);margin-top:4px">${esc(job.error)}</div>` : ''}
        </div>`;
    })
    .join('');
  for (const btn of $$('[data-cancel-job]', box)) {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/rebuilds/cancel', { method: 'POST', body: { jobId: Number(btn.dataset.cancelJob) } });
        toast('已取消重建', 'success');
        await refreshLive();
        await refreshVersions();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }
}

function jobStatusLabel(status) {
  return {
    running: '重建中',
    queued: '排队',
    ready: '待切换',
    done: '已完成',
    aborted: '已中止',
    failed: '失败',
  }[status] ?? status;
}

function renderStale() {
  const rows = state.live?.staleReports ?? [];
  const box = $('#stale-list');
  if (rows.length === 0) {
    box.innerHTML = '<div class="empty">没有过期上报。旧执行器被拒绝时会记录在这里。</div>';
    return;
  }
  box.innerHTML = rows
    .map(
      (row) => `
      <div class="list-item">
        <div>
          <div>${esc(reasonLabel(row.reason))} · ${esc(row.workerId ?? '未知来源')}</div>
          <div class="meta">声称 epoch ${esc(row.claimedEpoch ?? '—')} / v${esc(row.claimedVersion ?? '—')} → 当前 epoch ${esc(row.activeEpoch ?? '—')} / v${esc(row.activeVersion ?? '—')}</div>
        </div>
        <span class="hint">${esc(fmtTime(row.receivedAt))}</span>
      </div>`,
    )
    .join('');
}

function reasonLabel(reason) {
  return {
    'stale-fence': '凭据过期',
    'stale-version': '规则版本过期',
    paused: '执行器暂停',
  }[reason] ?? reason;
}

function renderPause() {
  const live = state.live;
  if (!live) return;
  $('#pause-btn').disabled = live.paused || (live.jobs ?? []).some((job) => job.status === 'running');
  $('#resume-btn').disabled = !live.paused;
  $('#pause-status').innerHTML = live.paused
    ? `<div class="callout warn">已暂停（${esc(live.pauseReason ?? '未知原因')}）。所有上报会因凭据失效被拒绝并记录，事件不会进入原始数据。</div>`
    : '<div class="callout ok">执行器正在接收事件。暂停会使当前 fence 失效，恢复后会颁发新 fence。</div>';
}

function renderSimulator(sim) {
  const box = $('#sim-status');
  const legacy = sim.legacy;
  box.innerHTML = `
    <div class="hint">累计产生 ${esc(fmtNumber(sim.sent))} 条 · 当前事件时间 ${esc(sim.cursorEventTime ? fmtTime(sim.cursorEventTime) : '—')} · ${sim.running ? '运行中' : '已停止'}</div>
    ${sim.lastError ? `<div class="callout danger">最近错误：${esc(sim.lastError.code)} ${esc(sim.lastError.message)}</div>` : ''}
    ${
      legacy
        ? `<div class="callout ${legacy.rejected > 0 ? 'danger' : 'warn'}">
             <strong>${esc(legacy.label)}</strong> 一直使用启动时凭据：epoch ${esc(legacy.credentials.epochId)} / v${esc(legacy.credentials.versionId)} / fence ${esc(legacy.credentials.fence)}。
             尝试 ${esc(legacy.attempts)} 次，成功 ${esc(legacy.accepted)}，被拒 ${esc(legacy.rejected)}${legacy.lastCode ? `（最近 ${esc(reasonLabel(legacy.lastCode) || legacy.lastCode)}）` : ''}。
           </div>`
        : ''
    }
  `;
  $('#sim-start').disabled = sim.running;
  $('#sim-stop').disabled = !sim.running;
}

function wireOverview() {
  $('#sim-start').addEventListener('click', async () => {
    try {
      const sim = await api('/api/simulator/start', {
        method: 'POST',
        body: { tickMs: Number($('#sim-tick').value) },
      });
      renderSimulator(sim);
      toast('数据源已启动', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#sim-stop').addEventListener('click', async () => {
    try {
      renderSimulator(await api('/api/simulator/stop', { method: 'POST' }));
      toast('数据源已停止');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#sim-step').addEventListener('click', async () => {
    try {
      const result = await api('/api/simulator/step', { method: 'POST', body: { batchSize: 12 } });
      toast(`追加 ${result.accepted ?? 0} 条，关闭 ${result.closed ?? 0} 个窗口`, 'success');
      await refreshLive();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#legacy-launch').addEventListener('click', async () => {
    try {
      const sim = await api('/api/simulator/legacy-executor', { method: 'POST', body: {} });
      renderSimulator(sim);
      toast('旧执行器已启动，将用当前凭据持续上报', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#pause-btn').addEventListener('click', async () => {
    try {
      await api('/api/executor/pause', { method: 'POST', body: { reason: '操作员暂停' } });
      toast('已暂停接收', 'success');
      await refreshLive();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#resume-btn').addEventListener('click', async () => {
    try {
      await api('/api/executor/resume', { method: 'POST' });
      toast('已恢复接收', 'success');
      await refreshLive();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
}

// ----------------------------------------------------------------------- rules

async function refreshVersions() {
  const { versions } = await api('/api/versions');
  state.versions = versions;
  if (state.selectedVersionId === null || !versions.some((v) => v.id === state.selectedVersionId)) {
    const active = versions.find((v) => v.isActive);
    state.selectedVersionId = active?.id ?? versions[0]?.id ?? null;
  }
  renderVersionList();
  if (state.selectedVersionId) await selectVersion(state.selectedVersionId, { keepDirty: true });
  else renderEditor();
  renderChangeCard();
}

function renderVersionList() {
  const box = $('#version-list');
  if (state.versions.length === 0) {
    box.innerHTML = '<div class="empty">还没有规则版本</div>';
    return;
  }
  box.innerHTML = state.versions
    .map((version) => {
      const status = versionStatus(version);
      return `
        <div class="version ${version.id === state.selectedVersionId ? 'selected' : ''}" data-version="${version.id}" tabindex="0" role="button">
          <div class="version-top">
            <span class="version-title">v${version.id} · ${esc(version.label)}</span>
            <span class="pill ${status.className}">${esc(status.label)}</span>
          </div>
          <div class="version-desc">${esc(version.summary?.description ?? '')}</div>
          <div class="version-top">
            <span class="hint">${esc(version.spec?.filter ?? '无过滤')}</span>
            <span class="hint">${version.hasActiveJob ? '重建中' : esc(fmtTime(version.createdAt))}</span>
          </div>
        </div>`;
    })
    .join('');
  for (const node of $$('.version', box)) {
    const activate = () => selectVersion(Number(node.dataset.version));
    node.addEventListener('click', activate);
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
  }
}

function versionStatus(version) {
  if (version.isActive) return { label: '活动', className: 'pill-live' };
  if (version.status === 'draft') return { label: '草稿', className: 'pill-info' };
  if (version.status === 'published') return { label: '待切换', className: 'pill-warn' };
  if (version.status === 'retired') return { label: '历史', className: 'pill-muted' };
  return { label: version.status, className: 'pill-muted' };
}

async function selectVersion(versionId, { keepDirty = false } = {}) {
  if (state.editorDirty && !keepDirty && state.selectedVersionId !== versionId) {
    if (!window.confirm('当前草稿有未保存的修改，切换版本会丢失这些修改。继续？')) return;
  }
  state.selectedVersionId = versionId;
  const detail = await api(`/api/versions/${versionId}`);
  state.selectedVersion = detail;
  state.preview = null;
  state.editorDirty = false;
  state.editor = { ...detail.version.spec, note: detail.version.note ?? '' };
  renderVersionList();
  renderEditor();
  renderChangeCard();
  if (detail.version.status === 'draft') schedulePreview();
}

function renderEditor() {
  const detail = state.selectedVersion;
  const box = $('#editor');
  const title = $('#editor-title');
  const status = $('#editor-status');
  if (!detail) {
    box.innerHTML = '<div class="empty">选择左侧版本，或新建草稿。</div>';
    title.textContent = '编辑器';
    status.textContent = '未选择';
    status.className = 'pill pill-muted';
    return;
  }
  const version = detail.version;
  const editable = version.status === 'draft';
  const spec = state.editor ?? version.spec;
  title.textContent = `v${version.id} · ${version.label}`;
  status.textContent = editable ? '草稿（可编辑）' : version.isActive ? '活动（只读）' : '历史（只读）';
  status.className = `pill ${editable ? 'pill-info' : version.isActive ? 'pill-live' : 'pill-muted'}`;

  box.innerHTML = `
    <div class="field">
      <span>规则名称</span>
      <input id="ed-label" value="${esc(spec.label)}" ${editable ? '' : 'disabled'} maxlength="80" />
    </div>
    <div class="field">
      <span>过滤条件（布尔）</span>
      <textarea id="ed-filter" rows="2" ${editable ? '' : 'disabled'}>${esc(spec.filter ?? '')}</textarea>
    </div>
    <div class="field-row">
      <div class="field">
        <span>分组键（标量）</span>
        <textarea id="ed-group" rows="2" ${editable ? '' : 'disabled'}>${esc(spec.group ?? '')}</textarea>
      </div>
      <div class="field">
        <span>去重键（可留空）</span>
        <textarea id="ed-dedup" rows="2" ${editable ? '' : 'disabled'}>${esc(spec.dedup ?? '')}</textarea>
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <span>聚合度量（数字）</span>
        <textarea id="ed-measure" rows="2" ${editable ? '' : 'disabled'}>${esc(spec.measure ?? '')}</textarea>
      </div>
      <div class="field">
        <span>聚合方式（只改变口径，可迁移）</span>
        <select id="ed-aggregate" ${editable ? '' : 'disabled'}>
          ${Object.entries(AGG)
            .map(([key, label]) => `<option value="${key}" ${spec.aggregate === key ? 'selected' : ''}>${esc(label)} (${esc(key)})</option>`)
            .join('')}
        </select>
      </div>
    </div>
    <div class="field-row-3">
      <div class="field">
        <span>窗口类型</span>
        <select id="ed-kind" ${editable ? '' : 'disabled'}>
          <option value="tumbling" ${spec.window?.kind === 'tumbling' ? 'selected' : ''}>滚动</option>
          <option value="hopping" ${spec.window?.kind === 'hopping' ? 'selected' : ''}>滑动</option>
        </select>
      </div>
      <div class="field">
        <span>窗口长度 (ms)</span>
        <input id="ed-size" type="number" min="1000" max="3600000" step="1000" value="${esc(spec.window?.sizeMs ?? 15000)}" ${editable ? '' : 'disabled'} />
      </div>
      <div class="field">
        <span>滑动步长 (ms)</span>
        <input id="ed-slide" type="number" min="1000" max="3600000" step="1000" value="${esc(spec.window?.slideMs ?? 15000)}" ${editable ? '' : 'disabled'} />
      </div>
    </div>
    <div class="field-row">
      <div class="field">
        <span>允许迟到 (ms)</span>
        <input id="ed-lateness" type="number" min="0" max="600000" step="500" value="${esc(spec.window?.allowedLatenessMs ?? 0)}" ${editable ? '' : 'disabled'} />
      </div>
      <div class="field">
        <span>窗口偏移 (ms)</span>
        <input id="ed-offset" type="number" min="0" max="3599999" step="1000" value="${esc(spec.window?.offsetMs ?? 0)}" ${editable ? '' : 'disabled'} />
      </div>
    </div>
    <div class="field">
      <span>备注</span>
      <input id="ed-note" value="${esc(state.editor?.note ?? version.note ?? '')}" ${editable ? '' : 'disabled'} maxlength="200" />
    </div>
    <div class="control-row" style="margin-bottom:0">
      ${editable ? '<button class="btn btn-primary" id="ed-save">保存草稿</button>' : ''}
      ${editable ? '<button class="btn" id="ed-preview">预览影响</button>' : ''}
      ${
        !version.isActive && version.status !== 'draft'
          ? `<button class="btn" id="ed-rollback">回滚到此版本</button>`
          : ''
      }
      ${version.status === 'draft' ? '' : ''}
      <span class="hint" id="ed-error"></span>
    </div>
  `;

  for (const input of $$('input, textarea, select', box)) {
    input.addEventListener('input', () => {
      state.editorDirty = true;
      collectEditor();
      renderChangeCard();
      if (state.selectedVersion?.version.status === 'draft') schedulePreview();
    });
    input.addEventListener('change', () => {
      state.editorDirty = true;
      collectEditor();
      renderChangeCard();
    });
  }

  const save = $('#ed-save');
  if (save) {
    save.addEventListener('click', async () => {
      collectEditor();
      save.disabled = true;
      try {
        const result = await api(`/api/versions/${version.id}`, { method: 'PUT', body: editorPayload() });
        state.selectedVersion = { ...state.selectedVersion, version: result.version, changeVsActive: result.change };
        state.editorDirty = false;
        state.preview = null;
        toast('草稿已保存', 'success');
        await refreshVersions();
        await previewCurrent();
      } catch (error) {
        $('#ed-error').textContent = error.message;
        toast(error.message, 'error');
      } finally {
        save.disabled = false;
      }
    });
  }
  const previewBtn = $('#ed-preview');
  if (previewBtn) {
    previewBtn.addEventListener('click', () => {
      collectEditor();
      previewCurrent().catch((error) => toast(error.message, 'error'));
    });
  }
  const rollbackBtn = $('#ed-rollback');
  if (rollbackBtn) {
    rollbackBtn.addEventListener('click', async () => {
      if (!window.confirm(`回滚到 v${version.id} 会派生一个新版本并按当前留存原始数据重建/迁移。继续？`)) return;
      try {
        const result = await api('/api/rollback', { method: 'POST', body: { versionId: version.id, strategy: 'shadow' } });
        toast(`已发起回滚：新版本 v${result.version.id}`, 'success');
        await refreshLive();
        await refreshVersions();
        showView('overview');
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }
}

function collectEditor() {
  if (!state.editor) return;
  state.editor = {
    ...state.editor,
    label: $('#ed-label')?.value ?? state.editor.label,
    filter: $('#ed-filter')?.value ?? state.editor.filter,
    group: $('#ed-group')?.value ?? state.editor.group,
    dedup: $('#ed-dedup')?.value ?? state.editor.dedup,
    measure: $('#ed-measure')?.value ?? state.editor.measure,
    aggregate: $('#ed-aggregate')?.value ?? state.editor.aggregate,
    window: {
      kind: $('#ed-kind')?.value ?? state.editor.window.kind,
      sizeMs: Number($('#ed-size')?.value ?? state.editor.window.sizeMs),
      slideMs: Number($('#ed-slide')?.value ?? state.editor.window.slideMs),
      allowedLatenessMs: Number($('#ed-lateness')?.value ?? state.editor.window.allowedLatenessMs),
      offsetMs: Number($('#ed-offset')?.value ?? state.editor.window.offsetMs),
    },
    note: $('#ed-note')?.value ?? state.editor.note,
  };
}

function editorPayload() {
  const e = state.editor;
  return {
    label: e.label,
    filter: e.filter,
    group: e.group,
    dedup: e.dedup,
    measure: e.measure,
    aggregate: e.aggregate,
    window: {
      kind: e.window.kind,
      sizeMs: Number(e.window.sizeMs),
      slideMs: Number(e.window.slideMs),
      allowedLatenessMs: Number(e.window.allowedLatenessMs),
      offsetMs: Number(e.window.offsetMs),
    },
    note: e.note,
  };
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewCurrent().catch(() => {});
  }, 550);
}

async function previewCurrent() {
  const detail = state.selectedVersion;
  if (!detail || detail.version.status !== 'draft') return;
  collectEditor();
  const token = ++state.previewToken;
  try {
    // Save first so the server previews exactly what the editor shows.
    const saved = await api(`/api/versions/${detail.version.id}`, { method: 'PUT', body: editorPayload() });
    if (token !== state.previewToken) return;
    state.selectedVersion = { ...detail, version: saved.version, changeVsActive: saved.change };
    state.editorDirty = false;
    const preview = await api(`/api/versions/${detail.version.id}/preview`, { method: 'POST', body: {} });
    if (token !== state.previewToken) return;
    state.preview = preview;
    $('#ed-error').textContent = '';
    renderChangeCard();
    renderVersionList();
  } catch (error) {
    if (token !== state.previewToken) return;
    state.preview = null;
    const node = $('#ed-error');
    if (node) node.textContent = error.message;
    renderChangeCard();
  }
}

function renderChangeCard() {
  const detail = state.selectedVersion;
  const summaryBox = $('#change-summary');
  const previewBox = $('#preview');
  if (!detail) {
    const empty = '<div class="empty">选择版本后这里会显示与活动版本相比的变更分类。</div>';
    if (summaryBox.__html !== empty) {
      summaryBox.innerHTML = empty;
      summaryBox.__html = empty;
    }
    previewBox.innerHTML = '';
    return;
  }
  const change = state.preview?.change ?? detail.changeVsActive;
  const version = detail.version;
  const isActive = version.isActive;
  const classification = change?.classification ?? 'noop';

  const banner =
    classification === 'rebuild'
      ? '<div class="callout danger"><strong>必须重建</strong>：分组键、过滤、去重、度量或窗口语义发生变化，旧聚合状态无法反推到新语义。需要用留存原始数据重放。</div>'
      : classification === 'migrate'
        ? '<div class="callout ok"><strong>可以迁移</strong>：只有聚合口径或展示信息变化，状态里的 count/sum/min/max 足以直接换算，不需要重放原始数据。</div>'
        : '<div class="callout ok"><strong>无状态影响</strong>：语义完全一致，只需切换指针（或仅更新名称）。</div>';

  const rows = (change?.changes ?? [])
    .map(
      (item) => `
      <div class="change ${item.kind}">
        <div class="change-head">
          <strong>${esc(item.label)}</strong>
          <span class="pill ${
            item.kind === 'semantic' ? 'pill-danger' : item.kind === 'migratable' ? 'pill-warn' : 'pill-muted'
          }">${item.kind === 'semantic' ? '需要重建' : item.kind === 'migratable' ? '可直接迁移' : '仅展示'}</span>
        </div>
        <div class="change-diff">
          <div class="from">原：${esc(displayChangeValue(item.field, item.from))}</div>
          <div class="to">新：${esc(displayChangeValue(item.field, item.to))}</div>
        </div>
        <div class="change-why">${esc(item.why)}</div>
      </div>`,
    )
    .join('');

  const strategyPlans =
    classification === 'rebuild' && !isActive
      ? `<div class="plan-grid">
          ${planCard('shadow', '影子追赶', classification, version)}
          ${planCard('stop-the-world', '停流切换', classification, version)}
        </div>`
      : '';

  const actions = isActive
    ? '<div class="hint">这是当前活动版本，可以直接回滚到其他历史版本。</div>'
    : version.status === 'draft'
      ? `<div class="control-row" style="margin:8px 0 0">
           <button class="btn btn-primary" id="publish-shadow" data-publish="shadow" ${classification === 'rebuild' ? '' : 'disabled'}>
             影子追赶发布
           </button>
           <button class="btn" id="publish-stw" data-publish="stop-the-world" ${classification === 'rebuild' ? '' : 'disabled'}>
             停流切换发布
           </button>
           <button class="btn" id="publish-direct" data-publish="">发布（自动选择）</button>
           <span class="hint">${
             classification === 'rebuild'
               ? '审核预览后选择切换方式。发布前不会改动线上状态。'
               : '本次变更无需重建，发布后立即切换。'
           }</span>
         </div>`
      : '<div class="hint">历史版本不可直接发布，可用“回滚到此版本”派生新版本。</div>';

  const html = `${banner}${actions}${strategyPlans}<div class="change-list">${rows || '<div class="empty">与活动版本无语义差异</div>'}</div>${
    classification !== 'rebuild' && state.preview?.plan
      ? `<div class="callout">${esc(state.preview.plan.latency)}</div>`
      : ''
  }`;
  // Focus loss on an editor field fires a `change`, which re-renders this card.
  // Replacing the node between pointerdown and pointerup would swallow the
  // click on a publish button, so leave the DOM alone when nothing changed.
  if (summaryBox.__html !== html) {
    summaryBox.innerHTML = html;
    summaryBox.__html = html;
  }

  renderPreview(previewBox, state.preview);
}

function planCard(strategy, label, classification, version) {
  const plan = state.selectedVersion?.planOptions?.find((item) => item.strategy === strategy);
  if (!plan) return '';
  const recommended = strategy === 'shadow';
  return `
    <div class="plan ${recommended ? 'recommended' : ''}">
      <div class="plan-title"><span>${esc(label)}${recommended ? ' · 推荐' : ''}</span><span class="hint">${esc(strategy)}</span></div>
      <div class="hint">重放事件 ${esc(fmtNumber(plan.replayEvents ?? 0))} · 预计冻结 ${esc(fmtClock(plan.estimatedFreezeMs))} · 总耗时 ${esc(fmtClock(plan.estimatedTotalMs))}</div>
      <div class="plan-latency">${esc(plan.latency ?? '')}</div>
      <div class="hint">只读预览和发布前的估算；实际时间以重建任务进度为准。</div>
    </div>`;
}

function displayChangeValue(field, value) {
  if (value === null || value === undefined || value === '') return '（无）';
  if (field.startsWith('window.')) return String(value);
  return String(value);
}

function renderPreview(box, preview) {
  if (!preview?.totals) {
    if (box.__html !== '') {
      box.innerHTML = '';
      box.__html = '';
    }
    return;
  }
  const t = preview.totals;
  const html = `
    <div class="card-head" style="margin-top:6px">
      <h3>影响预览 · 最近 ${esc(fmtNumber(preview.scope.events))} 条事件（seq ${esc(preview.scope.firstSeq ?? '—')}–${esc(preview.scope.lastSeq ?? '—')}）</h3>
      <span class="hint">${esc(preview.plan?.latency ?? '')}</span>
    </div>
    <div class="metric-grid">
      ${metric('候选窗口', t.candidateGroups)}
      ${metric('新增', t.added, 'accent')}
      ${metric('消失', t.removed, 'warn')}
      ${metric('数值变化', t.changed, 'warn')}
      ${metric('不变', t.unchanged)}
      ${metric('判定变化', t.adjudicationChanges, 'warn')}
    </div>
    ${
      preview.openWindowWarning
        ? `<div class="callout warn">${esc(preview.openWindowWarning)}</div>`
        : ''
    }
    ${
      preview.diffs?.length
        ? `<div class="table-wrap" style="max-height:260px">
             <table>
               <thead><tr><th>变化</th><th>分组</th><th>窗口</th><th class="num">旧值</th><th class="num">新值</th><th class="num">旧条数</th><th class="num">新条数</th></tr></thead>
               <tbody>
                 ${preview.diffs
                   .slice(0, 40)
                   .map(
                     (d) => `<tr>
                       <td>${esc(diffLabel(d.kind))}</td>
                       <td>${esc(d.group)}</td>
                       <td class="mono">${esc(fmtTime(d.windowStart))} → ${esc(fmtTime(d.windowEnd))}</td>
                       <td class="num">${esc(fmtNumber(d.previous, 2))}</td>
                       <td class="num">${esc(fmtNumber(d.value, 2))}</td>
                       <td class="num">${esc(fmtNumber(d.previousCount))}</td>
                       <td class="num">${esc(fmtNumber(d.count))}</td>
                     </tr>`,
                   )
                   .join('')}
               </tbody>
             </table>
           </div>`
        : '<div class="empty">在当前留存事件范围内，候选规则与活动规则的结果完全一致。</div>'
    }
    ${
      preview.adjudicationDiffs?.length
        ? `<details><summary>逐条判定变化（前 ${esc(preview.adjudicationDiffs.length)} 条）</summary>
             <div class="table-wrap" style="max-height:220px"><table>
               <thead><tr><th>seq</th><th>event</th><th>原判定</th><th>新判定</th><th>说明</th></tr></thead>
               <tbody>${preview.adjudicationDiffs
                 .map(
                   (d) => `<tr><td class="num">${esc(d.seq)}</td><td class="mono">${esc(d.eventId)}</td>
                     <td>${esc(outcomeLabel(d.from))}</td><td>${esc(outcomeLabel(d.to))}</td><td>${esc(d.reason ?? '')}</td></tr>`,
                 )
                 .join('')}</tbody>
             </table></div>
           </details>`
        : ''
    }
  `;
  if (box.__html !== html) {
    box.innerHTML = html;
    box.__html = html;
  }
}

function diffLabel(kind) {
  return { added: '新增窗口', removed: '消失窗口', changed: '数值变化' }[kind] ?? kind;
}

function outcomeLabel(outcome) {
  return {
    accepted: '计入',
    filtered: '被过滤',
    duplicate: '重复',
    late: '迟到',
    'invalid-group': '分组为空',
    'invalid-dedup': '去重为空',
  }[outcome] ?? outcome;
}

async function publish(versionId, strategy) {
  if (state.editorDirty) {
    try {
      collectEditor();
      const saved = await api(`/api/versions/${versionId}`, { method: 'PUT', body: editorPayload() });
      state.selectedVersion = { ...state.selectedVersion, version: saved.version, changeVsActive: saved.change };
      state.editorDirty = false;
    } catch (error) {
      toast(`保存失败：${error.message}`, 'error');
      return;
    }
  }
  const body = strategy ? { strategy } : {};
  try {
    const result = await api(`/api/versions/${versionId}/publish`, { method: 'POST', body });
    const activation = result.activation;
    const extra =
      activation.mode === 'state-adopt'
        ? '已直接迁移状态，无需重放。'
        : `已发起${result.plan?.strategy === 'shadow' ? '影子追赶' : '停流切换'}重建：${activation.jobId ? `任务 #${activation.jobId}` : ''}`;
    toast(extra, 'success');
    await refreshLive();
    await refreshVersions();
    showView('overview');
  } catch (error) {
    toast(error.message, 'error');
    renderChangeCard();
  }
}

function wireRules() {
  $('#new-draft').addEventListener('click', async () => {
    const base = state.selectedVersion?.version.spec ?? state.live?.activeVersion?.spec;
    if (!base) {
      toast('还没有可复制的规则', 'error');
      return;
    }
    try {
      const result = await api('/api/versions', {
        method: 'POST',
        body: { ...base, label: `${base.label} 副本` },
      });
      state.selectedVersionId = result.version.id;
      await refreshVersions();
      toast(`已新建草稿 v${result.version.id}`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  // Delegate publish clicks to the stable card container. The editor's change
  // handler can re-render the summary while a press is in flight, and a button
  // replaced between pointerdown and pointerup never receives its click.
  $('#change-card').addEventListener('click', (event) => {
    const button = event.target.closest('[data-publish]');
    if (!button || button.disabled) return;
    const versionId = state.selectedVersion?.version.id;
    if (!versionId) return;
    const strategy = button.dataset.publish || null;
    button.disabled = true;
    publish(versionId, strategy).finally(() => {
      if (document.contains(button)) button.disabled = false;
    });
  });
}

// --------------------------------------------------------------------- results

async function refreshResults() {
  const epoch = $('#results-epoch')?.value ? Number($('#results-epoch').value) : null;
  const query = new URLSearchParams();
  if (epoch) query.set('epoch', String(epoch));
  query.set('limit', '100');
  query.set('offset', String(state.resultsOffset));
  const data = await api(`/api/results?${query}`);
  state.results = data;
  renderResults();
}

function renderResults() {
  const data = state.results;
  const table = $('#results-table');
  if (!data) return;
  if (data.rows.length === 0 && data.open.length === 0 && data.openCount === 0) {
    table.innerHTML = '<div class="empty">该执行器还没有结果。先产生一些事件，并让水位线越过窗口边界。</div>';
    $('#open-table').innerHTML = '';
    $('#results-pager').innerHTML = '';
    return;
  }
  table.innerHTML = `
    <table>
      <thead><tr>
        <th>分组</th><th>窗口</th><th class="num">值</th><th class="num">count</th>
        <th class="num">sum</th><th class="num">min</th><th class="num">max</th><th>关闭时间</th>
      </tr></thead>
      <tbody>
        ${data.rows
          .map(
            (row) => `<tr>
              <td>${esc(row.group)}</td>
              <td class="mono">${esc(fmtTime(row.windowStart))} → ${esc(fmtTime(row.windowEnd))}</td>
              <td class="num"><strong>${esc(fmtNumber(row.value, 2))}</strong></td>
              <td class="num">${esc(fmtNumber(row.count))}</td>
              <td class="num">${esc(fmtNumber(row.sum, 2))}</td>
              <td class="num">${esc(fmtNumber(row.min, 2))}</td>
              <td class="num">${esc(fmtNumber(row.max, 2))}</td>
              <td class="hint">${esc(fmtTime(row.closedAt))}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
  const open = data.open ?? [];
  $('#open-table').innerHTML = open.length
    ? `<table>
        <thead><tr><th>分组</th><th>窗口</th><th class="num">值</th><th class="num">count</th><th>状态</th></tr></thead>
        <tbody>${open
          .map(
            (row) => `<tr>
              <td>${esc(row.group)}</td>
              <td class="mono">${esc(fmtTime(row.windowStart))} → ${esc(fmtTime(row.windowEnd))}</td>
              <td class="num">${esc(fmtNumber(row.value, 2))}</td>
              <td class="num">${esc(fmtNumber(row.count))}</td>
              <td><span class="pill pill-info">水位线前</span></td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`
    : '<div class="empty">当前没有未关闭窗口。</div>';
  const page = Math.floor(state.resultsOffset / 100) + 1;
  const maxPage = Math.max(1, Math.ceil(data.total / 100));
  $('#results-pager').innerHTML = `
    <button class="btn btn-small" id="results-prev" ${state.resultsOffset === 0 ? 'disabled' : ''}>上一页</button>
    <span class="hint">第 ${page} / ${maxPage} 页 · 共 ${esc(fmtNumber(data.total))} 个已关闭窗口 · epoch #${esc(data.epoch.id)}（${esc(data.availability)}）· ${esc(AGG[data.aggregate] ?? data.aggregate)}</span>
    <button class="btn btn-small" id="results-next" ${state.resultsOffset + 100 >= data.total ? 'disabled' : ''}>下一页</button>
  `;
  $('#results-prev')?.addEventListener('click', () => {
    state.resultsOffset = Math.max(0, state.resultsOffset - 100);
    refreshResults().catch((error) => toast(error.message, 'error'));
  });
  $('#results-next')?.addEventListener('click', () => {
    state.resultsOffset += 100;
    refreshResults().catch((error) => toast(error.message, 'error'));
  });
}

async function refreshAdjudications(reset = false) {
  if (reset) state.adjBefore = null;
  const query = new URLSearchParams();
  const epoch = $('#adj-epoch')?.value ? Number($('#adj-epoch').value) : null;
  if (epoch) query.set('epoch', String(epoch));
  const outcome = $('#adj-outcome')?.value;
  if (outcome) query.set('outcome', outcome);
  query.set('limit', '60');
  if (state.adjBefore) query.set('before', String(state.adjBefore));
  const data = await api(`/api/adjudications?${query}`);
  state.adjudications = data;
  renderAdjudications();
}

function renderAdjudications() {
  const data = state.adjudications;
  if (!data) return;
  const box = $('#adj-table');
  if (data.rows.length === 0) {
    box.innerHTML = '<div class="empty">没有逐条判定记录。</div>';
    $('#adj-pager').innerHTML = '';
    return;
  }
  box.innerHTML = `
    <table>
      <thead><tr>
        <th class="num">seq</th><th>事件</th><th>时间</th><th>判定</th><th>分组</th>
        <th>窗口</th><th>规则版本</th><th>说明</th>
      </tr></thead>
      <tbody>
        ${data.rows
          .map(
            (row) => `<tr>
              <td class="num">${esc(row.seq)}</td>
              <td class="mono">${esc(row.eventId)}</td>
              <td class="mono">${esc(fmtTime(row.eventTime))}</td>
              <td><span class="outcome outcome-${esc(row.outcome)}">${esc(outcomeLabel(row.outcome))}</span></td>
              <td>${esc(row.group ?? '—')}</td>
              <td class="mono hint">${esc(
                (row.windows ?? []).map((w) => `${fmtTime(w.start)}`).join(' / ') || '—',
              )}</td>
              <td>v${esc(row.versionId)}${row.inherited ? ` <span class="hint">（继承自 #${esc(row.inheritedFromEpoch ?? '—')}）</span>` : ''}</td>
              <td class="hint">${esc(row.reason ?? '')}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;
  $('#adj-pager').innerHTML = `
    <span class="hint">epoch #${esc(data.epoch.id)} · 规则 v${esc(data.version.id)} · ${esc(data.version.label)}</span>
    ${data.nextBefore ? '<button class="btn btn-small" id="adj-more">加载更早</button>' : ''}
  `;
  $('#adj-more')?.addEventListener('click', () => {
    state.adjBefore = data.nextBefore;
    refreshAdjudications(false).catch((error) => toast(error.message, 'error'));
  });
}

function wireResults() {
  $('#results-refresh').addEventListener('click', () => {
    state.resultsOffset = 0;
    refreshResults().catch((error) => toast(error.message, 'error'));
  });
  $('#results-epoch').addEventListener('change', () => {
    state.resultsOffset = 0;
    refreshResults().catch((error) => toast(error.message, 'error'));
  });
  $('#adj-refresh').addEventListener('click', () => {
    refreshAdjudications(true).catch((error) => toast(error.message, 'error'));
  });
  $('#adj-epoch').addEventListener('change', () => {
    refreshAdjudications(true).catch((error) => toast(error.message, 'error'));
  });
  $('#adj-outcome').addEventListener('change', () => {
    refreshAdjudications(true).catch((error) => toast(error.message, 'error'));
  });
}

// -------------------------------------------------------------------- timeline

async function renderTimeline() {
  const [audit, state_] = await Promise.all([api('/api/audit?limit=60'), Promise.resolve(state.live)]);
  const live = state_ ?? (await api('/api/state'));
  const epochs = live.epochs ?? [];
  const box = $('#epoch-timeline');
  if (epochs.length === 0) {
    box.innerHTML = '<div class="empty">还没有执行器记录。</div>';
  } else {
    box.innerHTML = epochs
      .map((epoch) => {
        const status = epochStatus(epoch.status);
        return `
          <div class="epoch-row">
            <div class="mono hint">#${esc(epoch.id)}</div>
            <div class="epoch-line">
              <div class="epoch-title">
                <strong>v${esc(epoch.versionId)}</strong>
                <span class="pill ${status.className}">${esc(status.label)}</span>
                <span class="hint">${esc(epoch.strategy)}</span>
                ${epoch.parentEpochId ? `<span class="hint">← #${esc(epoch.parentEpochId)}</span>` : ''}
              </div>
              <div class="epoch-meta">覆盖起点 seq ${esc(epoch.coverageStartSeq)} · 检查点 ${esc(epoch.checkpointSeq)} · ${esc(fmtTime(epoch.createdAt))}${epoch.note ? ` · ${esc(epoch.note)}` : ''}</div>
            </div>
            <button class="btn btn-small" data-epoch-results="${epoch.id}">查看结果</button>
          </div>`;
      })
      .join('');
    for (const btn of $$('[data-epoch-results]', box)) {
      btn.addEventListener('click', () => {
        showView('results');
        $('#results-epoch').value = btn.dataset.epochResults;
        $('#adj-epoch').value = btn.dataset.epochResults;
        state.resultsOffset = 0;
        refreshResults().catch((error) => toast(error.message, 'error'));
        refreshAdjudications(true).catch(() => {});
      });
    }
  }

  $('#lineage').innerHTML = (state.versions ?? [])
    .slice(0, 8)
    .map(
      (version) => `
      <div class="list-item ${version.isActive ? 'active' : ''}">
        <div>
          <div>v${esc(version.id)} · ${esc(version.label)}</div>
          <div class="meta">${version.sourceVersionId ? `派生自 v${esc(version.sourceVersionId)} · ` : ''}${esc(versionStatus(version).label)} · ${esc(version.semanticHash)}</div>
        </div>
        <span class="hint">${esc(fmtTime(version.activatedAt ?? version.createdAt))}</span>
      </div>`,
    )
    .join('');

  $('#audit').innerHTML = `
    <table>
      <thead><tr><th>时间</th><th>操作</th><th>详情</th></tr></thead>
      <tbody>
        ${audit.rows
          .map(
            (row) => `<tr>
              <td class="mono hint">${esc(fmtTime(row.at))}</td>
              <td>${esc(auditLabel(row.kind))}</td>
              <td class="mono hint" style="white-space:normal;max-width:620px">${esc(JSON.stringify(row.detail))}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>`;

  if (state.verify) renderVerify(state.verify);
}

function epochStatus(status) {
  return {
    active: { label: '活动', className: 'pill-live' },
    paused: { label: '暂停', className: 'pill-warn' },
    building: { label: '停流构建', className: 'pill-info' },
    shadow: { label: '影子构建', className: 'pill-info' },
    retired: { label: '已退役', className: 'pill-muted' },
    aborted: { label: '已中止', className: 'pill-danger' },
    failed: { label: '失败', className: 'pill-danger' },
  }[status] ?? { label: status, className: 'pill-muted' };
}

function auditLabel(kind) {
  return {
    bootstrap: '初始化',
    'version.create': '创建规则版本',
    'version.update': '编辑草稿',
    'version.publish': '发布规则',
    'version.rollback': '回滚',
    'epoch.migrate': '直接迁移状态',
    'executor.pause': '暂停执行器',
    'executor.resume': '恢复执行器',
    'rebuild.start': '开始重建',
    'rebuild.cutover': '切换完成',
    'rebuild.abort': '重建中止',
    'rebuild.fail': '重建失败',
    'rebuild.orphaned': '重启清理',
    'rebuild.manual': '手动重建',
    verify: '全量核对',
  }[kind] ?? kind;
}

function wireTimeline() {
  $('#verify-btn').addEventListener('click', async () => {
    const btn = $('#verify-btn');
    btn.disabled = true;
    btn.textContent = '核对中…';
    try {
      state.verify = await api('/api/verify', { method: 'POST', body: {} });
      renderVerify(state.verify);
      toast(state.verify.ok ? '全量基准核对通过' : '核对发现差异', state.verify.ok ? 'success' : 'error');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '运行核对';
    }
  });
}

function renderVerify(report) {
  const box = $('#verify-result');
  box.innerHTML = `
    <div class="callout ${report.ok ? 'ok' : 'danger'}">
      ${report.ok ? '通过' : '未通过'}：用留存原始事件从零重算 epoch #${esc(report.epochId)}（v${esc(report.versionId)}），
      比对 ${esc(fmtNumber(report.baselineWindows))} 个已关闭窗口，匹配 ${esc(fmtNumber(report.matched))} 个，差异 ${esc(fmtNumber(report.mismatchCount))} 个。
    </div>
    <div class="metric-grid">
      ${metric('原始事件', report.rawEvents)}
      ${metric('基准窗口', report.baselineWindows)}
      ${metric('存储窗口', report.storedWindows)}
      ${metric('匹配', report.matched, 'accent')}
      ${metric('差异', report.mismatchCount, report.mismatchCount ? 'danger' : '')}
      ${metric('未关闭', report.openWindowCount, 'warn')}
    </div>
    <div class="hint">${esc(report.note)} · 耗时 ${esc(fmtClock(report.durationMs))} · ${esc(fmtTime(report.checkedAt))}</div>
    ${
      report.mismatches?.length
        ? `<div class="table-wrap"><table>
             <thead><tr><th>类型</th><th>分组</th><th>窗口</th><th>差异</th></tr></thead>
             <tbody>${report.mismatches
               .map(
                 (m) => `<tr><td>${esc(m.kind)}</td><td>${esc(m.group)}</td>
                   <td class="mono">${esc(fmtTime(m.windowStart))}</td>
                   <td class="mono" style="white-space:normal">${esc((m.problems ?? []).join('; ') || '—')}</td></tr>`,
               )
               .join('')}</tbody>
           </table></div>`
        : ''
    }
  `;
}

// ------------------------------------------------------------------------ help

function renderHelp() {
  if (!state.meta) return;
  $('#help-fields').innerHTML = `
    <table>
      <thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead>
      <tbody>${state.meta.fields
        .map((field) => `<tr><td><code>${esc(field.name)}</code></td><td>${esc(field.type)}</td><td>${esc(field.description)}</td></tr>`)
        .join('')}</tbody>
    </table>`;
  $('#help-functions').innerHTML = `
    <div class="callout">
      表达式是受限语法：只有数字/字符串/布尔字面量、字段、白名单函数、算术与比较、逻辑、三元表达式。
      没有成员访问、赋值、模板字符串、注释或分号；任何未经白名单的标识符都会在发布前被拒绝。
      类型在保存时静态检查，不做隐式转换。空值沿算术与比较传播；除零结果为 null。
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>函数</th><th>说明</th><th>参数</th></tr></thead>
        <tbody>${state.meta.functions
          .map(
            (fn) => `<tr><td><code>${esc(fn.signature)}</code></td><td>${esc(fn.description)}</td>
              <td class="hint">${esc(fn.minArgs === fn.maxArgs ? fn.minArgs : `${fn.minArgs}–${fn.maxArgs}`)}</td></tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>
    <div class="callout">
      <strong>迁移判定</strong>：过滤、分组、去重、度量、窗口（类型/长度/步长/偏移/允许迟到）任一变化 → 旧状态无法反推，必须从留存原始数据重建；
      只有聚合方式（sum/count/avg/min/max）或规则名称变化 → 存储的 count/sum/min/max 足以直接换算，可零重放迁移。
    </div>
    <div class="callout">
      <strong>切换方式</strong>：影子追赶保持旧规则继续服务，重建期间新事件仍进入原始数据，切换瞬间追平；停流切换发布即冻结上报，
      按留存数据全量重放后切换，期间新上报会被拒绝并记录为过期。两种方式都只让“当前活动 epoch”的结果对外可见。
    </div>
  `;
}

boot().catch((error) => {
  console.error(error);
  toast(`初始化失败：${error.message}`, 'error');
});
