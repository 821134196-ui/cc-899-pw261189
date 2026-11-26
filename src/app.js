import { CATALOG, EXAMPLES, RULE_MATRIX } from './examples.js';
import { runOptimization, parseDSL, formatPlan } from './optimize.js';
import { evaluateDetailed } from './engine.js';

const clone = x => structuredClone(x);

const DEFAULT_EXAMPLE_ID = 'c1-where-right';

const state = {
  catalog: clone(CATALOG),
  exampleId: DEFAULT_EXAMPLE_ID,
  baselineText: EXAMPLES.find(x => x.id === DEFAULT_EXAMPLE_ID).plan.trim(),
  run: null,
  viewRound: 0,
  activeTable: Object.keys(CATALOG)[0],
  forced: null,
  candidateFilter: 'all',
};

const $ = selector => document.querySelector(selector);
const els = {
  exampleSelect: $('#exampleSelect'),
  exampleNote: $('#exampleNote'),
  planEditor: $('#planEditor'),
  parseStatus: $('#parseStatus'),
  formatPlanBtn: $('#formatPlanBtn'),
  resetExampleBtn: $('#resetExampleBtn'),
  runEditorBtn: $('#runEditorBtn'),
  tableTabs: $('#tableTabs'),
  dataEditor: $('#dataEditor'),
  prevStepBtn: $('#prevStepBtn'),
  nextStepBtn: $('#nextStepBtn'),
  runAllBtn: $('#runAllBtn'),
  stepLabel: $('#stepLabel'),
  stepper: $('#stepper'),
  globalVerdict: $('#globalVerdict'),
  candidateCounts: $('#candidateCounts'),
  candidateList: $('#candidateList'),
  beforePlan: $('#beforePlan'),
  afterPlan: $('#afterPlan'),
  resultSummary: $('#resultSummary'),
  originalResult: $('#originalResult'),
  finalResult: $('#finalResult'),
  diffSamples: $('#diffSamples'),
  forcedBanner: $('#forcedBanner'),
  forcedResultWrap: $('#forcedResultWrap'),
  forcedResult: $('#forcedResult'),
  forcedDiffSamples: $('#forcedDiffSamples'),
  matrixBody: $('#matrixBody'),
};

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function displayValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ---------------- Initialization ---------------- */

function init() {
  populateExamples();
  renderMatrix();
  bindEvents();
  loadExample(DEFAULT_EXAMPLE_ID);
}

function populateExamples() {
  const groups = new Map();
  for (const ex of EXAMPLES) {
    if (!groups.has(ex.group)) groups.set(ex.group, []);
    groups.get(ex.group).push(ex);
  }
  els.exampleSelect.innerHTML = [...groups.entries()].map(([group, items]) => `
    <optgroup label="${escapeHtml(group)}">
      ${items.map(ex => `<option value="${ex.id}">${escapeHtml(ex.title)}</option>`).join('')}
    </optgroup>
  `).join('');
  els.exampleSelect.value = state.exampleId;
}

function renderMatrix() {
  const label = { safe: '合法', conditional: '有条件合法', unsafe: '错误 / 拒绝' };
  els.matrixBody.innerHTML = RULE_MATRIX.map(r => `
    <tr>
      <td>${escapeHtml(r.where)}</td>
      <td>${escapeHtml(r.join)}</td>
      <td>${escapeHtml(r.side)}</td>
      <td><span class="verdict ${r.verdict}">${label[r.verdict]}</span></td>
      <td>${escapeHtml(r.action)}</td>
    </tr>
  `).join('');
}

function bindEvents() {
  els.exampleSelect.addEventListener('change', e => loadExample(e.target.value));
  els.runEditorBtn.addEventListener('click', applyEditorPlan);
  els.formatPlanBtn.addEventListener('click', formatEditorPlan);
  els.resetExampleBtn.addEventListener('click', () => loadExample(state.exampleId));
  els.runAllBtn.addEventListener('click', () => { state.forced = null; recompute(); });

  els.prevStepBtn.addEventListener('click', () => {
    state.viewRound = Math.max(0, state.viewRound - 1);
    renderDynamic();
  });
  els.nextStepBtn.addEventListener('click', () => {
    const max = (state.run?.steps.length || 1) - 1;
    state.viewRound = Math.min(max, state.viewRound + 1);
    renderDynamic();
  });

  els.stepper.addEventListener('click', e => {
    const btn = e.target.closest('[data-round]');
    if (!btn) return;
    state.viewRound = Number(btn.dataset.round);
    renderDynamic();
  });

  els.candidateCounts.addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.candidateFilter = btn.dataset.filter;
    renderCandidates();
  });

  els.candidateList.addEventListener('click', onCandidateAction);

  els.tableTabs.addEventListener('click', e => {
    const btn = e.target.closest('[data-table]');
    if (!btn) return;
    state.activeTable = btn.dataset.table;
    renderDataEditor();
  });

  els.dataEditor.addEventListener('change', onCellChange);
  els.dataEditor.addEventListener('click', onDataEditorClick);

  els.planEditor.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') applyEditorPlan();
  });
}

function loadExample(id) {
  const ex = EXAMPLES.find(x => x.id === id) || EXAMPLES[0];
  state.exampleId = ex.id;
  state.catalog = clone(CATALOG);
  state.baselineText = ex.plan.trim();
  state.viewRound = 0;
  state.forced = null;
  state.candidateFilter = 'all';
  state.activeTable = Object.keys(state.catalog)[0];
  els.exampleSelect.value = ex.id;
  els.exampleNote.textContent = ex.note;
  els.planEditor.value = state.baselineText;
  recompute();
  renderDataEditor();
}

function applyEditorPlan() {
  const text = els.planEditor.value;
  try {
    parseDSL(text);
  } catch (error) {
    state.run = { error: error.message, steps: [], equivalent: false };
    renderDynamic();
    els.parseStatus.className = 'parse-status error';
    els.parseStatus.textContent = `解析错误：${error.message}`;
    return;
  }
  state.baselineText = text.trim();
  state.viewRound = 0;
  state.forced = null;
  recompute();
}

function formatEditorPlan() {
  try {
    const plan = parseDSL(els.planEditor.value);
    els.planEditor.value = formatPlan(plan);
    els.parseStatus.className = 'parse-status ok';
    els.parseStatus.textContent = '已格式化；点击“解析并重新优化”应用。';
  } catch (error) {
    els.parseStatus.className = 'parse-status error';
    els.parseStatus.textContent = `无法格式化：${error.message}`;
  }
}

function recompute() {
  try {
    state.run = runOptimization(state.baselineText, state.catalog);
    if (state.run.error) {
      els.parseStatus.className = 'parse-status error';
      els.parseStatus.textContent = `解析错误：${state.run.error}`;
    } else {
      els.parseStatus.className = 'parse-status ok';
      els.parseStatus.textContent = '计划解析成功；所有合法候选均已通过当前行数据的多重集差分校验。';
    }
  } catch (error) {
    state.run = { error: error.message, steps: [], equivalent: false };
    els.parseStatus.className = 'parse-status error';
    els.parseStatus.textContent = `运行失败：${error.message}`;
  }
  const max = Math.max(0, (state.run?.steps.length || 1) - 1);
  state.viewRound = Math.min(state.viewRound, max);
  renderDynamic();
}

/* ---------------- Data editor ---------------- */

function renderDataEditor() {
  const names = Object.keys(state.catalog);
  if (!names.includes(state.activeTable)) state.activeTable = names[0];

  els.tableTabs.innerHTML = names.map(name => `
    <button type="button" class="table-tab ${name === state.activeTable ? 'active' : ''}" data-table="${escapeHtml(name)}">
      ${escapeHtml(name)} (${state.catalog[name].rows.length})
    </button>
  `).join('');

  const table = state.catalog[state.activeTable];
  if (!table) { els.dataEditor.innerHTML = ''; return; }

  els.dataEditor.innerHTML = `
    <div class="data-grid-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="row-index">#</th>
            ${table.columns.map(col => `<th>${escapeHtml(col)}</th>`).join('')}
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${table.rows.map((row, ri) => `
            <tr>
              <td class="row-index">${ri + 1}</td>
              ${table.columns.map(col => {
                const v = row[col];
                const isNull = v === null || v === undefined;
                return `<td><input
                  class="cell-input ${isNull ? 'null-cell' : ''}"
                  data-row="${ri}" data-col="${escapeHtml(col)}"
                  value="${isNull ? '' : escapeHtml(displayValue(v))}"
                  placeholder="NULL"
                  aria-label="第 ${ri + 1} 行 ${escapeHtml(col)}"></td>`;
              }).join('')}
              <td><button type="button" class="icon-btn" data-action="delete-row" data-row="${ri}" title="删除行">✕</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="data-actions">
      <button type="button" class="btn tiny" data-action="add-row">＋ 添加行</button>
      <button type="button" class="btn tiny" data-action="add-column">＋ 添加列</button>
    </div>
  `;
}

function parseCellValue(raw) {
  const text = raw.trim();
  if (text === '' || text.toUpperCase() === 'NULL') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return raw;
}

function onCellChange(event) {
  const input = event.target.closest('input.cell-input');
  if (!input) return;
  const table = state.catalog[state.activeTable];
  const ri = Number(input.dataset.row);
  const col = input.dataset.col;
  table.rows[ri][col] = parseCellValue(input.value);
  recompute();
}

function onDataEditorClick(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const table = state.catalog[state.activeTable];
  const action = btn.dataset.action;

  if (action === 'delete-row') {
    table.rows.splice(Number(btn.dataset.row), 1);
    renderDataEditor();
    recompute();
  } else if (action === 'add-row') {
    const row = {};
    for (const col of table.columns) row[col] = null;
    table.rows.push(row);
    renderDataEditor();
    recompute();
    const inputs = els.dataEditor.querySelectorAll('tbody tr:last-child input.cell-input');
    inputs[0]?.focus();
  } else if (action === 'add-column') {
    const name = window.prompt('新列名（物理列名）');
    if (!name) return;
    const col = name.trim();
    if (!col || table.columns.includes(col)) {
      window.alert('列名为空或已存在');
      return;
    }
    table.columns.push(col);
    for (const row of table.rows) row[col] = null;
    renderDataEditor();
    recompute();
  }
}

/* ---------------- Dynamic optimization rendering ---------------- */

function renderDynamic() {
  renderStepper();
  renderGlobalVerdict();
  renderCandidates();
  renderPlanDiff();
  renderResults();
  renderForced();
}

function renderStepper() {
  const run = state.run;
  if (!run || run.error || !run.steps.length) {
    els.stepper.innerHTML = '<span class="hint">没有可展示的步骤；请检查计划语法。</span>';
    els.stepLabel.textContent = '—';
    els.prevStepBtn.disabled = true;
    els.nextStepBtn.disabled = true;
    return;
  }

  els.stepper.innerHTML = run.steps.map((step, i) => {
    const adopted = step.candidates.find(c => c.id === step.selectedId);
    const label = adopted ? shortRule(adopted.ruleId) : '终止审计';
    const cls = i === state.viewRound
      ? 'step-pill active'
      : adopted ? 'step-pill done-safe' : 'step-pill terminal';
    return `<button type="button" class="${cls}" data-round="${i}" title="${escapeHtml(adopted?.title || run.stoppedReason || '')}">
      ${i + 1}. ${escapeHtml(label)}
    </button>`;
  }).join('');

  els.stepLabel.textContent = `第 ${state.viewRound + 1} / ${run.steps.length} 轮`;
  els.prevStepBtn.disabled = state.viewRound === 0;
  els.nextStepBtn.disabled = state.viewRound >= run.steps.length - 1;
}

function shortRule(ruleId) {
  const map = {
    'filter-split-and': '拆 AND',
    'push-filter-through-project': '穿过投影',
    'push-where-inner-left': 'WHERE→左',
    'push-where-inner-right': 'WHERE→右',
    'push-where-left-preserved': '保留侧下推',
    'left-to-inner-null-rejecting': 'LEFT→INNER',
    'merge-where-inner-on': '并入 ON',
    'push-on-right-input': 'ON 右侧下推',
    'push-on-inner-left': 'ON 左侧下推',
    'merge-adjacent-projects': '合并投影',
    'eliminate-identity-project': '删恒等投影',
    'prune-base-columns': '裁剪列',
  };
  return map[ruleId] || ruleId;
}

function renderGlobalVerdict() {
  const run = state.run;
  if (!run) { els.globalVerdict.className = 'global-verdict'; els.globalVerdict.textContent = ''; return; }
  if (run.error) {
    els.globalVerdict.className = 'global-verdict error';
    els.globalVerdict.textContent = `当前计划无法运行：${run.error}`;
    return;
  }
  const adoptions = run.steps.filter(s => s.selectedId).length;
  const costText = run.originalEval && run.finalEval
    ? `；估算成本 ${run.originalEval.cost} → ${run.finalEval.cost}`
    : '';
  if (run.equivalent) {
    els.globalVerdict.className = 'global-verdict safe';
    els.globalVerdict.textContent = `✔ 原始计划与安全优化结果在当前数据上为等价多重集。采纳 ${adoptions} 个候选${costText}。${run.stoppedReason || ''}`;
  } else {
    els.globalVerdict.className = 'global-verdict error';
    els.globalVerdict.textContent = `✕ 最终安全优化未通过等价校验：${run.stoppedReason || '存在行差分'}`;
  }
}

function currentStep() {
  return state.run?.steps?.[state.viewRound] || null;
}

function renderCandidates() {
  const step = currentStep();
  if (!step) {
    els.candidateCounts.innerHTML = '';
    els.candidateList.innerHTML = '<p class="hint">暂无候选。</p>';
    return;
  }

  const all = step.candidates;
  const rejected = all.filter(c => !c.legal || c.audit?.runtimeError || c.audit?.empiricalEquivalent === false);
  const legal = all.filter(c => c.legal && c.audit?.empiricalEquivalent && !c.audit?.runtimeError);
  els.candidateCounts.innerHTML = `
    <button type="button" class="count-pill ${state.candidateFilter === 'all' ? 'adopt' : ''}" data-filter="all">全部 ${all.length}</button>
    <button type="button" class="count-pill ${state.candidateFilter === 'legal' ? 'adopt' : ''}" data-filter="legal">合法可采用 ${legal.length}</button>
    <button type="button" class="count-pill ${state.candidateFilter === 'rejected' ? 'reject' : ''}" data-filter="rejected">拒绝 ${rejected.length}</button>
  `;

  let candidates = all;
  if (state.candidateFilter === 'legal') candidates = legal;
  if (state.candidateFilter === 'rejected') candidates = rejected;

  if (!candidates.length) {
    els.candidateList.innerHTML = '<p class="hint">该过滤条件下没有候选。</p>';
    return;
  }

  els.candidateList.innerHTML = candidates.map(c => candidateCard(c, step)).join('');
}

function candidateCard(c, step) {
  const adopted = c.id === step.recommendedId;
  const cls = adopted ? 'adopted' : c.verdict.startsWith('rejected') ? c.verdict : 'eligible';
  const badge = verdictBadge(c, adopted);
  const audit = c.audit;
  const equiv = audit?.empiricalEquivalent;
  const diff = audit?.diff;

  return `
    <article class="candidate-card ${cls}">
      <div class="candidate-head">
        <div>
          <div class="candidate-title">${escapeHtml(c.title)}</div>
          <div class="candidate-target">${escapeHtml(c.target)} · ${escapeHtml(c.ruleId)}</div>
        </div>
        <span class="verdict-badge ${adopted ? 'adopted' : c.legal ? 'eligible' : 'rejected'}">${badge}</span>
      </div>
      <p class="rule-detail">${escapeHtml(c.detail)}</p>
      <ul class="rule-clauses">${c.clauses.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      ${adopted ? `
        <p class="rule-detail" style="color:var(--safe);font-weight:800;margin:0">
          ✔ 本轮采纳：形式前置条件成立、当前数据多重集等价，成本变化 ${c.audit?.costDelta ?? '—'}；启发式顺序优先处理谓词/外连接规则。
        </p>` : (!c.legal || audit?.runtimeError || equiv === false) ? `
        <p class="rule-detail" style="color:var(--danger);font-weight:800;margin:0">
          ✕ 拒绝原因：${escapeHtml(audit?.runtimeError || (equiv === false ? '当前行数据差分不等价；该候选不能被采纳。' : '违反上述外连接/三值逻辑前置条件；即使某份样本恰好无差异，也不能作为通用规则。'))}
        </p>` : `
        <p class="hint" style="margin:0">合法但本轮未优先选择；仍可点击下方按钮手动采用并从此分叉。</p>`}

      <div class="audit-grid">
        <div class="audit-item ${c.legal ? 'good' : 'bad'}">
          形式前置条件<b>${c.legal ? '通过' : '不通过'}</b>
        </div>
        <div class="audit-item ${audit?.runtimeError || equiv === false ? 'bad' : 'good'}">
          当前数据差分<b>${audit?.runtimeError ? '执行错误' : equiv ? '多重集一致' : `缺 ${diff?.missing.length || 0} / 多 ${diff?.extra.length || 0}`}</b>
        </div>
        <div class="audit-item">
          估算成本后<b>${audit?.costAfter ?? '—'}</b>
        </div>
        <div class="audit-item ${audit?.costDelta > 0.001 ? 'bad' : 'good'}">
          成本变化<b>${audit?.costDelta === null || audit?.costDelta === undefined ? '—' : (audit.costDelta > 0 ? '+' : '') + audit.costDelta}</b>
        </div>
      </div>

      ${audit?.runtimeError ? `<p class="parse-status error">${escapeHtml(audit.runtimeError)}</p>` : ''}
      ${diff && !diff.equivalent ? miniDiffHtml(diff) : ''}

      <details>
        <summary class="hint">查看候选计划</summary>
        <pre class="code-block">${escapeHtml(c.proposedText)}</pre>
      </details>

      <div class="candidate-actions">
        ${!c.legal ? `<button type="button" class="btn danger tiny" data-action="force-candidate" data-round="${state.viewRound}" data-candidate="${c.id}">强制应用错误候选</button>` : ''}
        ${c.legal && equiv && !audit.runtimeError ? `<button type="button" class="btn tiny primary" data-action="branch-candidate" data-round="${state.viewRound}" data-candidate="${c.id}">${adopted ? '采用并作为新起点' : '手动采用 / 从此分叉'}</button>` : ''}
      </div>
    </article>
  `;
}

function verdictBadge(c, adopted) {
  if (adopted) return '✔ 本轮推荐采纳';
  if (!c.legal) return '✕ 规则拒绝';
  if (c.audit?.runtimeError) return '✕ 运行错误';
  if (!c.audit?.empiricalEquivalent) return '✕ 差分拒绝';
  return '合法 · 本轮未选';
}

function miniDiffHtml(diff) {
  const missing = diff.missing.slice(0, 2);
  const extra = diff.extra.slice(0, 2);
  return `
    <div class="mini-diff">
      <table class="result-table">
        <tbody>
          ${missing.map(x => `<tr class="missing-row"><td>− 缺少 ×${x.count}</td><td>${escapeHtml(compactRow(x.row))}</td></tr>`).join('')}
          ${extra.map(x => `<tr class="extra-row"><td>＋ 多出 ×${x.count}</td><td>${escapeHtml(compactRow(x.row))}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function compactRow(row) {
  return Object.entries(row).map(([k, v]) => `${k}=${displayValue(v)}`).join(', ');
}

function onCandidateAction(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const roundIndex = Number(btn.dataset.round);
  const candidateId = btn.dataset.candidate;
  const candidate = state.run?.steps?.[roundIndex]?.candidates.find(c => c.id === candidateId);
  if (!candidate) return;

  if (btn.dataset.action === 'force-candidate') {
    state.forced = { roundIndex, candidateId };
    renderDynamic();
    setTimeout(() => document.querySelector('#forcedBanner')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }), 30);
  } else if (btn.dataset.action === 'branch-candidate') {
    els.planEditor.value = candidate.proposedText;
    state.baselineText = candidate.proposedText;
    state.viewRound = 0;
    state.forced = null;
    recompute();
  }
}

function renderPlanDiff() {
  const step = currentStep();
  if (!step) {
    els.beforePlan.textContent = state.run?.error ? state.baselineText : '';
    els.afterPlan.textContent = '';
    return;
  }
  els.beforePlan.textContent = step.beforeText;
  const adopted = step.candidates.find(c => c.id === step.selectedId);
  els.afterPlan.textContent = adopted?.proposedText || '（没有推荐候选；计划保持不变）';
}

/* ---------------- Result tables ---------------- */

function renderResults() {
  const run = state.run;
  if (!run?.originalEval || !run?.finalEval) {
    els.resultSummary.innerHTML = '<span class="summary-pill bad">无法计算结果</span>';
    els.originalResult.innerHTML = '';
    els.finalResult.innerHTML = '';
    els.diffSamples.innerHTML = '';
    return;
  }

  const o = run.originalEval;
  const f = run.finalEval;
  els.resultSummary.innerHTML = `
    <span class="summary-pill">原始 ${o.rows.length} 行</span>
    <span class="summary-pill">优化后 ${f.rows.length} 行</span>
    <span class="summary-pill">成本 ${o.cost} → ${f.cost}</span>
    <span class="summary-pill ${run.equivalent ? 'good' : 'bad'}">${run.equivalent ? '多重集等价' : '存在差分'}</span>
  `;
  els.originalResult.innerHTML = resultTableHtml(o.schema.map(c => c.key), o.rows);
  els.finalResult.innerHTML = resultTableHtml(f.schema.map(c => c.key), f.rows);
  els.diffSamples.innerHTML = run.totalDiff && !run.totalDiff.equivalent
    ? fullDiffSamplesHtml(run.totalDiff)
    : '<p class="hint">没有缺少或多出的行。</p>';
}

function resultTableHtml(columns, rows) {
  if (!rows.length) return '<p class="hint" style="padding:.6rem">（0 行）</p>';
  return `
    <table class="result-table">
      <thead><tr>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map(row => `<tr>${columns.map(c => `<td class="${row[c] === null || row[c] === undefined ? 'null-value' : ''}">${escapeHtml(displayValue(row[c]))}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>
  `;
}

function fullDiffSamplesHtml(diff) {
  return `
    ${diffBlockHtml('missing', '安全优化缺少的行', diff.missing)}
    ${diffBlockHtml('extra', '安全优化多出的行', diff.extra)}
  `;
}

function diffBlockHtml(kind, title, items) {
  if (!items.length) return '';
  const first = items.slice(0, 8);
  const columns = Object.keys(first[0].row);
  return `
    <div class="diff-block ${kind}">
      <h4>${escapeHtml(title)}（${items.reduce((n, x) => n + x.count, 0)} 行次）</h4>
      <div class="table-wrap">
        <table class="result-table">
          <thead><tr><th>次数</th>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>
            ${first.map(x => `<tr class="${kind === 'missing' ? 'missing-row' : 'extra-row'}">
              <td>×${x.count}</td>
              ${columns.map(c => `<td class="${x.row[c] === null ? 'null-value' : ''}">${escapeHtml(displayValue(x.row[c]))}</td>`).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ---------------- Forced wrong candidate ---------------- */

function renderForced() {
  const forced = state.forced;
  if (!forced || !state.run) {
    els.forcedBanner.classList.add('hidden');
    els.forcedResultWrap.classList.add('hidden');
    els.forcedBanner.innerHTML = '';
    return;
  }
  const step = state.run.steps[forced.roundIndex];
  const candidate = step?.candidates.find(c => c.id === forced.candidateId);
  if (!candidate) {
    els.forcedBanner.classList.add('hidden');
    els.forcedResultWrap.classList.add('hidden');
    return;
  }

  let forcedEval;
  let runtimeError = null;
  try {
    forcedEval = evaluateDetailed(candidate.proposed, state.catalog);
  } catch (e) {
    runtimeError = e.message;
  }

  const diff = candidate.audit?.diff;
  els.forcedBanner.classList.remove('hidden');
  els.forcedBanner.innerHTML = `
    <div>
      <strong>⚠ 已强制应用被形式规则拒绝的候选：${escapeHtml(candidate.title)}</strong><br>
      <span>${escapeHtml(candidate.clauses[0] || '')}</span>
      ${diff ? `<br><span>相对该轮 Before：缺少 <b>${diff.missing.length}</b> 类行，多出 <b>${diff.extra.length}</b> 类行（按多重集计数）。</span>` : ''}
    </div>
    <button type="button" class="btn" data-action="clear-force">退出错误实验</button>
  `;
  els.forcedBanner.querySelector('[data-action="clear-force"]').addEventListener('click', () => {
    state.forced = null;
    renderForced();
  });

  els.forcedResultWrap.classList.remove('hidden');
  if (runtimeError) {
    els.forcedResult.innerHTML = `<p class="parse-status error">${escapeHtml(runtimeError)}</p>`;
    els.forcedDiffSamples.innerHTML = '';
    return;
  }
  els.forcedResult.innerHTML = resultTableHtml(forcedEval.schema.map(c => c.key), forcedEval.rows);
  els.forcedDiffSamples.innerHTML = diff && !diff.equivalent
    ? diffBlockHtml('missing', '错误候选丢失的行', diff.missing) + diffBlockHtml('extra', '错误候选多出的行', diff.extra)
    : '<p class="hint">当前编辑后的数据没有在这个样本上制造差异；形式前置条件仍判定该“规则”不合法。可尝试载入对应反例数据。</p>';
}

init();
