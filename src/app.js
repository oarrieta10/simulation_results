/* App: loading, scenario switching, rendering of all sections. */
(function () {
  'use strict';
  const { parseText } = window.SimParser;
  const { analyze, fmt, pct, prettyType } = window.SimAnalysis;
  const C = window.SimCharts;

  const state = { reports: [], activeId: null, stationSort: 'type', stationFilter: 'all' };
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cssVar = (n) => `var(--${n})`;
  const SERIES = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`series-${i}`));

  // ---------------- loading ----------------
  async function loadFiles(files) {
    const errors = [];
    for (const file of files) {
      try {
        const text = await file.text();
        parseText(text, file.name).forEach(addReport);
      } catch (e) {
        errors.push(`${file.name}: ${e.message}`);
      }
    }
    if (errors.length) toast(errors.join('<br>'), true);
    render();
  }

  // Per-viewer memory of profile choice and manual role overrides, keyed by report code.
  const store = {
    get(k) { try { const v = localStorage.getItem(`simres-${k}`); return v == null ? undefined : JSON.parse(v); } catch (_) { return undefined; } },
    set(k, v) { try { v === undefined ? localStorage.removeItem(`simres-${k}`) : localStorage.setItem(`simres-${k}`, JSON.stringify(v)); } catch (_) {} },
  };

  // id: undefined = remembered choice or best suggestion; 'none' = no design basis.
  function applyProfile(m, id) {
    const P = window.SimProfiles;
    if (id === undefined) id = store.get(`profile:${m.reportCode}`) ?? (P.suggest(m)?.id || 'none');
    m.profile = id === 'none' ? null : P.get(id);
    m.autoRoles = m.profile ? P.assignRoles(m, m.profile) : {};
    m.roleOverrides = (m.profile && store.get(`roles:${m.reportCode}:${m.profile.id}`)) || {};
    m.roles = { ...m.autoRoles, ...m.roleOverrides };
    m.analysis = analyze(m);
  }

  function addReport(model) {
    applyProfile(model);
    // Make labels unique if the same file is loaded twice.
    const same = state.reports.filter((r) => r.label === model.label || r.label.startsWith(model.label + ' (')).length;
    if (same) model.label = `${model.label} (${same + 1})`;
    state.reports.push(model);
    state.activeId = model.id;
  }

  function loadSample() {
    (window.SIMRES_SAMPLES || []).forEach((raw) => addReport(window.SimParser.normalize(raw, raw.__fileName)));
    render();
  }

  function toast(html, isError) {
    const t = $('#toast');
    t.innerHTML = html;
    t.className = `toast show ${isError ? 'error' : ''}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.className = 'toast'), 6000);
  }

  // ---------------- top-level render ----------------
  function render() {
    const has = state.reports.length > 0;
    document.body.classList.toggle('empty', !has);
    (state.teardown || []).forEach((f) => f());
    state.teardown = [];
    const view = $('#view');
    view.innerHTML = '';
    if (!has) return renderTabs();
    if (state.activeId === '__compare' && state.reports.length > 1) {
      renderTabs();
      return renderCompare(view);
    }
    const r = state.reports.find((x) => x.id === state.activeId) || state.reports[0];
    state.activeId = r.id;
    renderTabs();
    renderReport(view, r);
  }

  function renderTabs() {
    const tabs = $('#tabs');
    const items = state.reports.map((r) => `<button class="tab ${r.id === state.activeId ? 'active' : ''}" data-id="${esc(r.id)}" title="${esc(r.fileName)}">${esc(r.label)}<span class="x" data-close="${esc(r.id)}" aria-label="Remove ${esc(r.label)}">×</span></button>`);
    if (state.reports.length > 1) items.push(`<button class="tab compare ${state.activeId === '__compare' ? 'active' : ''}" data-id="__compare">Compare ${state.reports.length}</button>`);
    tabs.innerHTML = items.join('');
  }

  // ---------------- single report ----------------
  function renderReport(view, r) {
    const a = r.analysis, k = a.kpis;
    const tzFmt = (ms) => {
      if (!ms) return '–';
      const d = new Date(ms + r.tzMin * 60000);
      return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
    };
    view.insertAdjacentHTML('beforeend', `
      <header class="report-head">
        <div class="head-row">
          <div>
            <h1 contenteditable="true" spellcheck="false" id="label" title="Click to rename this scenario">${esc(r.label)}</h1>
            <p class="meta">${esc(r.reportName)} · ${esc(r.reportCode)} · ${tzFmt(r.start)} → ${tzFmt(r.end)} (UTC${esc(r.tz)}) · ${fmt(r.durationH, 1)} h simulated</p>
          </div>
          <div class="seg-toggle" role="tablist" aria-label="View">
            <button role="tab" data-mode="walk" aria-selected="${state.viewMode === 'walk'}" class="${state.viewMode === 'walk' ? 'on' : ''}">Walkthrough</button>
            <button role="tab" data-mode="dash" aria-selected="${state.viewMode === 'dash'}" class="${state.viewMode === 'dash' ? 'on' : ''}">Full dashboard</button>
          </div>
        </div>
        ${state.viewMode === 'walk' ? '' : `<dl class="params">
          <div><dt>Inbound handling</dt><dd>${r.params.inboundOpTime ? fmt(r.params.inboundOpTime) + ' s/tote presentation' : '–'}</dd></div>
          <div><dt>Outbound handling</dt><dd>${r.params.outboundOpTime ? fmt(r.params.outboundOpTime) + ' s/tote presentation' : '–'}</dd></div>
          <div><dt>Stations</dt><dd>${a.types.map((t) => `${t.count} ${esc(t.label.toLowerCase())}`).join(' · ') || '–'}</dd></div>
          <div><dt>Design basis</dt><dd>${r.profile ? esc(r.profile.name) : 'None'}</dd></div>
        </dl>`}
      </header>
      ${state.viewMode === 'walk' ? '' : `<nav class="section-nav">
        <a href="#s-findings">Findings</a><a href="#s-design">Design targets</a><a href="#s-flow">Throughput &amp; open tasks</a><a href="#s-stations">Stations</a><a href="#s-robots">Robots &amp; charging</a><a href="#s-data">Data</a><a href="#s-method">Method</a>
      </nav>`}`);
    wireHeader(r);
    if (state.viewMode === 'walk') {
      window.SimWalkthrough.render(view, r, {
        esc, fmt, statusIcon, levelLabel, SERIES, tz: tzFmt, reports: state.reports,
        onTeardown: (f) => state.teardown.push(f),
        openDashboard: (anchor) => setMode('dash', anchor),
      });
      return;
    }

    // KPI tiles
    const tiles = [
      { label: 'Tote presentations completed', value: fmt(k.total), sub: `${fmt(k.sumOut)} out · ${fmt(k.sumIn)} in` },
      { label: 'Throughput', value: `${fmt(k.perHour)}<small>/h</small>`, sub: `steady ${fmt(k.steadyThroughput)}/h · peak ${fmt(k.peakThroughput)} (h${k.peakHour})` },
      { label: 'Peak open outbound', value: fmt(k.peakOpenOut), sub: `hour ${k.peakOpenOutHour} · ${fmt(k.endOpenOut)} open at end`, status: k.peakOpenOut > k.steadyThroughput ? 'warning' : null },
      ...(a.design ? [{
        label: 'Design targets', value: `${k.designPass}<small> of ${k.designTotal} met</small>`,
        sub: a.design.rows.filter((x) => x.process.main).map((x) => `${esc(x.process.name)} ${pct(x.pct)} of target`).join(' · '),
        status: k.designPass === k.designTotal ? 'good' : a.design.rows.some((x) => x.status === 'fail' || x.status === 'missing') ? 'critical' : 'warning',
      }] : []),
      { label: `${a.labor ? esc(a.labor.label) : 'Labor'} station rate`, value: k.laborSteady ? `${fmt(k.laborSteady)}<small>/h</small>` : '–', sub: k.ceiling ? `${pct(k.ceilingUse)} of ${fmt(k.ceiling)}/h ceiling · ${fmt(k.laborCycle, 1)} s cycle` : 'steady-state median' },
      { label: 'Robot productivity', value: k.robotRate ? `${fmt(k.robotRate, 1)}<small>/robot/h</small>` : '–', sub: `tote presentations${k.robotFleet ? ` · ≈${fmt(k.robotFleet)} robots (inferred)` : ''}` },
      { label: 'Charger utilization', value: a.chargers.length ? `${fmt(k.chargerMean)}<small>%</small>` : '–', sub: a.chargers.length ? `peak ${fmt(k.chargerPeak)}%` : '' },
    ];
    view.insertAdjacentHTML('beforeend', `<section class="tiles">${tiles.map((t) => `
      <div class="tile"><div class="tile-label">${t.label}${t.status ? ` <span class="badge ${t.status}">${statusIcon(t.status)} ${levelLabel(t.status)}</span>` : ''}</div>
      <div class="tile-value">${t.value}</div><div class="tile-sub">${t.sub}</div></div>`).join('')}</section>`);

    // Findings
    // Collapsed state is remembered per viewer; the summary keeps a count per status visible.
    const counts = ['critical', 'warning', 'good', 'info']
      .map((l) => [l, a.findings.filter((f) => f.level === l).length])
      .filter(([, n]) => n)
      .map(([l, n]) => `<span class="badge ${l}">${statusIcon(l)} ${n} ${levelLabel(l)}</span>`).join('');
    view.insertAdjacentHTML('beforeend', `
      <details class="card collapsible" id="s-findings" ${store.get('findings-collapsed') ? '' : 'open'}>
        <summary>
          <span class="chev" aria-hidden="true"></span>
          <span class="summary-text"><h2>Key findings</h2>
          <span class="card-sub">Generated from the report data. Rules and thresholds are listed under Method.</span></span>
          <span class="summary-counts">${counts}</span>
        </summary>
        <ul class="findings">${a.findings.map((f) => `
          <li class="finding ${f.level}"><span class="badge ${f.level}">${statusIcon(f.level)} ${levelLabel(f.level)}</span>
          <div><b class="f-title">${esc(f.title)}</b><p>${f.text}</p></div></li>`).join('')}</ul>
      </details>`);
    $('#s-findings').addEventListener('toggle', (e) => store.set('findings-collapsed', e.target.open ? undefined : true));

    renderDesign(view, r);

    // Flow
    const labels = r.hours.map((h) => `h${h}`);
    const hasIn = k.sumIn > 0 || k.peakOpenIn > 0;
    const sec = el(view, 'section', 'grid-2', 's-flow');
    const c1 = card(sec, 'Tote presentations completed per hour', hasIn ? 'Stacked inbound + outbound. Hover a column for exact values.' : 'Outbound only. This run has no inbound work. Hover a column for exact values.', 'span-2');
    C.hourly(c1, {
      labels, totalRow: true, height: 260, aria: 'Tote presentations completed per hour',
      tipTitle: (i) => `Hour ${r.hours[i]}`,
      series: [
        { name: 'Outbound', color: SERIES[0], values: r.system.map((x) => x.finOut) },
        ...(hasIn ? [{ name: 'Inbound', color: SERIES[1], values: r.system.map((x) => x.finIn) }] : []),
      ],
      refs: [{ value: k.perHour, label: `Run average ${fmt(k.perHour)}/h` }],
    });
    const c2 = card(sec, 'Outbound: released vs completed', 'Released = completed + change in open tasks. A gap above the completed line means work queued up.', hasIn ? '' : 'span-2');
    C.hourly(c2, {
      labels, height: 230, tipTitle: (i) => `Hour ${r.hours[i]}`,
      series: [
        { name: 'Released', color: SERIES[0], type: 'line', dash: true, values: a.flow.map((x) => x.relOut) },
        { name: 'Completed', color: SERIES[0], type: 'line', values: r.system.map((x) => x.finOut) },
      ],
      extraTip: (i) => [{ name: 'Open at hour end', value: fmt(r.system[i].openOut) }],
    });
    if (hasIn) C.hourly(card(sec, 'Inbound: released vs completed', 'Same balance for inbound tasks.'), {
      labels, height: 230, tipTitle: (i) => `Hour ${r.hours[i]}`,
      series: [
        { name: 'Released', color: SERIES[1], type: 'line', dash: true, values: a.flow.map((x) => x.relIn) },
        { name: 'Completed', color: SERIES[1], type: 'line', values: r.system.map((x) => x.finIn) },
      ],
      extraTip: (i) => [{ name: 'Open at hour end', value: fmt(r.system[i].openIn) }],
    });
    const c4 = card(sec, 'Open tasks at end of each hour', 'Last snapshot in each hour. Rising = demand outpacing capacity; falling = draining.', 'span-2');
    C.hourly(c4, {
      labels, height: 230, tipTitle: (i) => `End of hour ${r.hours[i]}`,
      series: [
        { name: 'Outbound open', color: SERIES[0], type: 'line', values: r.system.map((x) => x.openOut) },
        ...(hasIn ? [{ name: 'Inbound open', color: SERIES[1], type: 'line', values: r.system.map((x) => x.openIn) }] : []),
      ],
    });

    // Stations
    const ss = el(view, 'section', 'grid-1', 's-stations');
    const sc = card(ss, 'Station performance', `Each dot is a station placed at its average tote presentations per hour, grouped by ${r.profile ? 'design process' : 'station type'}. The vertical tick is the group median; ▲ marks stations more than 15% below it.`);
    C.strip(sc, {
      types: a.types, ceiling: k.ceiling, color: SERIES[0], flagColor: cssVar('status-critical'),
      ceilingLabel: k.ceiling ? `Manual ceiling ${fmt(k.ceiling)}/h (${fmt(a.opTime)} s handling)` : '',
    });
    const hc = card(ss, 'Tote presentations per station by hour', 'Darker cells mean more tote presentations. Click a column header to sort.');
    renderHeatmap(hc, r);

    // Robots & charging
    const rs = el(view, 'section', 'grid-2', 's-robots');
    const rc = card(rs, 'Tote presentations per robot per hour', 'Fleet-wide tote presentations in each hour divided by robot count. The reference line is the run average.');
    if (a.robots.length) {
      C.hourly(rc, {
        labels, height: 230, tipTitle: (i) => `Hour ${r.hours[i]}`, yFormat: (v) => fmt(v, v % 1 ? 1 : 0),
        tipFormat: (v) => fmt(v, 2),
        series: a.robots.map((ro, i) => ({ name: ro.type, color: SERIES[i], type: 'line', values: ro.perHour })),
        refs: a.robots.slice(0, 1).map((ro) => ({ value: ro.runAvg, label: `Run avg ${fmt(ro.runAvg, 1)}` })),
      });
    } else rc.insertAdjacentHTML('beforeend', '<p class="empty-note">No robot data in this report.</p>');
    const cc = card(rs, 'Charger utilization', 'Share of charger time spent charging in each hour.');
    if (a.chargers.length) {
      C.hourly(cc, {
        labels, height: 230, yMax: 100, yFormat: (v) => `${v}%`, tipFormat: (v) => `${fmt(v)}%`,
        tipTitle: (i) => `Hour ${r.hours[i]}`,
        series: a.chargers.map((c, i) => ({ name: c.type, color: SERIES[i], type: 'line', values: c.vals })),
      });
    } else cc.insertAdjacentHTML('beforeend', '<p class="empty-note">No charger data in this report.</p>');

    renderData(view, r);
    renderMethod(view, r);

  }

  function wireHeader(r) {
    $('#label').addEventListener('blur', (e) => {
      const v = e.target.textContent.trim();
      if (v && v !== r.label) { r.label = v; renderTabs(); }
    });
    $('#label').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
    document.querySelectorAll('.seg-toggle [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  }

  function setMode(mode, anchor) {
    state.viewMode = mode;
    store.set('view-mode', mode);
    render();
    if (anchor) requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }));
    else window.scrollTo({ top: 0 });
  }

  function renderDesign(view, r) {
    const P = window.SimProfiles;
    const a = r.analysis, d = a.design;
    const sec = el(view, 'section', 'card', 's-design');
    const opts = [`<option value="none" ${!r.profile ? 'selected' : ''}>None</option>`,
      ...P.PROFILES.map((p) => `<option value="${esc(p.id)}" ${r.profile && r.profile.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`)].join('');
    sec.innerHTML = `<div class="card-head"><div><h2>Design targets</h2>
        <p class="card-sub">${d ? `Checked against ${esc(d.profile.source)}. Stations are matched to processes by throughput; you can change any of them below.` : 'Choose a design basis to check this run against contractual workstation targets.'}</p></div>
        <label class="inline-select">Design basis <select id="profile-select">${opts}</select></label></div>`;
    sec.querySelector('#profile-select').addEventListener('change', (e) => {
      store.set(`profile:${r.reportCode}`, e.target.value);
      applyProfile(r, e.target.value);
      render();
      requestAnimationFrame(() => $('#s-design')?.scrollIntoView());
    });
    if (!d) return;

    const statusCell = (row) => {
      const map = {
        pass: ['good', 'Pass'], fail: ['critical', 'Below target'], missing: ['critical', 'No stations'],
        demand: ['warning', 'Not proven'],
      };
      const [lvl, txt] = map[row.status];
      const tip = row.status === 'demand' ? ' title="The simulation released less work than the target, and the stations still had spare capacity."' : '';
      return `<span class="badge ${lvl}"${tip}>${statusIcon(lvl)} ${txt}</span>`;
    };
    const maxPct = Math.max(1.25, ...d.rows.map((x) => x.pct));
    const bar = (p) => `<span class="pct-bar"><span class="pct-fill ${p >= 0.995 ? 'ok' : 'short'}" style="width:${Math.min(100, (p / maxPct) * 100)}%"></span><span class="pct-mark" style="left:${(1 / maxPct) * 100}%"></span></span><span class="pct-val">${pct(p)}</span>`;
    sec.insertAdjacentHTML('beforeend', `<div class="table-wrap"><table class="data design-table">
      <thead><tr><th class="left">Process</th><th class="left">Workstation</th><th>Stations<br><span class="muted">sim / design</span></th><th>Target<br><span class="muted">per h</span></th><th>Simulated<br><span class="muted">per h</span></th><th class="left">vs target</th><th>Released<br><span class="muted">vs target</span></th><th>Capacity<br><span class="muted">per h</span></th><th>Cycle<br><span class="muted">sim / wait</span></th><th class="left">Status</th></tr></thead>
      <tbody>${d.rows.map((x) => `<tr>
        <th class="left">${esc(x.process.name)}</th>
        <td class="left muted">${esc(x.process.note || prettyType(x.process.stationType))} · ${esc(x.process.cycle)}</td>
        <td>${x.stationsSim !== x.stationsDesign ? `<b class="mismatch" title="Differs from the design">${x.stationsSim}</b>` : x.stationsSim} / ${x.stationsDesign}</td>
        <td>${fmt(x.process.target)}</td>
        <td><b>${fmt(x.actual)}</b></td>
        <td class="left pct-cell">${bar(x.pct)}</td>
        <td>${x.group ? pct(x.demandPct) : '–'}</td>
        <td>${x.capacity ? `${fmt(x.capacity)} <span class="muted">(${pct(x.capacityPct)})</span>` : '<span class="muted" title="Stations did not reach a shared ceiling, so capacity is not observable">–</span>'}</td>
        <td>${x.cycle ? `${fmt(x.cycle, 1)} s` : '–'} / ${x.process.wait ? `${fmt(x.process.wait)} s` : '–'}</td>
        <td class="left">${statusCell(x)}</td>
      </tr>`).join('')}</tbody></table></div>
      <p class="muted small">Simulated = tote presentations completed ÷ simulated hours. Released = simulated plus work still open at the end. Capacity is shown only where the stations hit a shared ceiling. "Not proven" = the stations had spare capacity, but the run didn't release enough work to reach the target.</p>`);

    // Role editor
    const procOpts = (code) => {
      const st = r.stations.find((s) => s.code === code);
      const tk = st.type.replace(/_STATION$/i, '').toUpperCase();
      const own = r.profile.processes.filter((p) => p.stationType.toUpperCase() === tk);
      const list = own.length ? own : r.profile.processes;
      return `<option value="">Unassigned</option>` + list.map((p) => `<option value="${esc(p.id)}" ${r.roles[code] === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    };
    const nOver = Object.keys(r.roleOverrides || {}).length;
    const ed = document.createElement('details');
    ed.className = 'data-block';
    ed.innerHTML = `<summary><span>Station roles</span><span class="muted">${r.stations.length} stations · ${nOver ? `${nOver} changed by you` : 'auto-assigned'}</span>${nOver ? '<button class="btn small" id="roles-reset">Reset to auto</button>' : ''}</summary>
      <div class="roles-grid">${r.stations.map((s) => `<label class="role-item ${r.roleOverrides[s.code] ? 'overridden' : ''}"><span class="role-code">${esc(s.code)}<small>${fmt(s.avgPerHour)}/h</small></span><select data-code="${esc(s.code)}">${procOpts(s.code)}</select></label>`).join('')}</div>`;
    sec.appendChild(ed);
    if (state.rolesOpen) ed.open = true;
    ed.addEventListener('toggle', () => (state.rolesOpen = ed.open));
    ed.querySelectorAll('select[data-code]').forEach((sel) => sel.addEventListener('change', () => {
      const code = sel.dataset.code;
      const ov = { ...r.roleOverrides };
      if (sel.value === (r.autoRoles[code] || '')) delete ov[code]; else ov[code] = sel.value;
      store.set(`roles:${r.reportCode}:${r.profile.id}`, Object.keys(ov).length ? ov : undefined);
      applyProfile(r, r.profile.id);
      const y = window.scrollY;
      render();
      window.scrollTo({ top: y });
    }));
    ed.querySelector('#roles-reset')?.addEventListener('click', (e) => {
      e.preventDefault();
      store.set(`roles:${r.reportCode}:${r.profile.id}`, undefined);
      applyProfile(r, r.profile.id);
      const y = window.scrollY;
      render();
      window.scrollTo({ top: y });
    });
  }

  function renderHeatmap(container, r) {
    const a = r.analysis;
    const flagged = new Set(a.types.flatMap((t) => t.outliers.map((s) => s.code)));
    const max = Math.max(1, ...r.stations.flatMap((s) => s.hourly));
    const typeOpts = ['all', ...a.types.map((t) => t.type)];
    const grpLabel = Object.fromEntries(a.types.map((t) => [t.type, t.label]));
    const grpOrder = Object.fromEntries(a.types.map((t, i) => [t.type, i]));
    if (!typeOpts.includes(state.stationFilter)) state.stationFilter = 'all';
    const controls = document.createElement('div');
    controls.className = 'controls';
    controls.innerHTML = `<label>${r.profile ? 'Process' : 'Station type'} <select id="st-filter">${typeOpts.map((t) => `<option value="${esc(t)}" ${state.stationFilter === t ? 'selected' : ''}>${t === 'all' ? 'All' : esc(grpLabel[t])}</option>`).join('')}</select></label>
      <span class="scale">fewer <i class="ramp"></i> more tote presentations</span>`;
    container.appendChild(controls);
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    container.appendChild(wrap);

    const draw = () => {
      let rows = r.stations.filter((s) => state.stationFilter === 'all' || a.groupOf[s.code] === state.stationFilter);
      const sk = state.stationSort;
      rows = [...rows].sort((x, y) => {
        if (sk === 'type') return grpOrder[a.groupOf[x.code]] - grpOrder[a.groupOf[y.code]] || window.SimParser.naturalCmp(x.code, y.code);
        if (sk === 'code') return window.SimParser.naturalCmp(x.code, y.code);
        if (sk === 'total') return y.total - x.total;
        if (sk === 'avg') return y.avgPerHour - x.avgPerHour;
        const h = Number(sk.slice(1));
        return y.hourly[h] - x.hourly[h];
      });
      const typeMed = Object.fromEntries(a.types.map((t) => [t.type, t.median]));
      const avgMax = Math.max(1, ...r.stations.map((s) => s.avgPerHour));
      const th = (key, label, cls = '') => `<th class="sortable ${cls} ${sk === key ? 'sorted' : ''}" data-sort="${key}">${label}</th>`;
      wrap.innerHTML = `<table class="heat">
        <thead><tr>${th('code', 'Station', 'left')}${th('type', r.profile ? 'Process' : 'Type', 'left')}${r.hours.map((h, i) => th(`h${i}`, `h${h}`)).join('')}${th('total', 'Total')}${th('avg', 'Avg / h', 'left')}</tr></thead>
        <tbody>${rows.map((s) => `<tr class="${flagged.has(s.code) ? 'flagged' : ''}">
          <th class="left">${flagged.has(s.code) ? '<span class="flag" title="More than 15% below type median">▲</span> ' : ''}${esc(s.code)}</th>
          <td class="left muted">${esc(grpLabel[a.groupOf[s.code]])}</td>
          ${s.hourly.map((v, i) => `<td class="cell" data-s="${esc(s.code)}" data-h="${i}" style="${heatStyle(v, max)}">${v ? fmt(v) : '<span class="zero">·</span>'}</td>`).join('')}
          <td class="num"><b>${fmt(s.total)}</b></td>
          <td class="bar-cell"><span class="mini-bar" style="width:${Math.round((s.avgPerHour / avgMax) * 70)}px"></span><span class="mini-val">${fmt(s.avgPerHour)}</span></td>
        </tr>`).join('')}</tbody></table>`;
      wrap.querySelectorAll('th.sortable').forEach((t) => t.addEventListener('click', () => { state.stationSort = t.dataset.sort; draw(); }));
      wrap.querySelectorAll('td.cell').forEach((td) => {
        td.addEventListener('mousemove', (e) => {
          const st = r.stations.find((x) => x.code === td.dataset.s);
          const h = Number(td.dataset.h);
          const med = typeMed[a.groupOf[st.code]];
          C.showTip(e, C.tipRows(`${st.code} · hour ${r.hours[h]}`, [
            { name: 'Tote presentations', value: fmt(st.hourly[h]) },
            { name: 'Station avg / h', value: fmt(st.avgPerHour) },
            { name: `${grpLabel[a.groupOf[st.code]]} median / h`, value: fmt(med) },
          ]));
        });
        td.addEventListener('mouseleave', C.hideTip);
      });
    };
    controls.querySelector('#st-filter').addEventListener('change', (e) => { state.stationFilter = e.target.value; draw(); });
    draw();
  }

  // Hai Robotics sequential ramp: hai-blue-1…5, hai-blue, darker-blue-4, darker-blue.
  // White text from hai-blue-5 up.
  const RAMP = ['#F0F3FF', '#D1D8FF', '#A8B2FF', '#808AFF', '#575FFF', '#2E31FA', '#070BED', '#04068B'];
  function heatStyle(v, max) {
    if (!v) return '';
    const i = Math.min(RAMP.length - 1, Math.round((v / max) * (RAMP.length - 1)));
    return `background:${RAMP[i]};color:${i >= 4 ? '#fff' : '#000'}`;
  }

  function renderData(view, r) {
    const sec = el(view, 'section', 'grid-1', 's-data');
    const c = card(sec, 'Data', 'The cleaned tables behind every chart. Download as CSV for Excel.');
    const sysCols = ['Hour', 'Completed inbound', 'Completed outbound', 'Completed total', 'Released inbound', 'Released outbound', 'Open inbound (end of hour)', 'Open outbound (end of hour)'];
    const sysRows = r.system.map((x, i) => [x.h, x.finIn, x.finOut, x.finIn + x.finOut, r.analysis.flow[i].relIn, r.analysis.flow[i].relOut, x.openIn, x.openOut]);
    const stCols = ['Station', 'Type', 'Design process', ...r.hours.map((h) => `h${h}`), 'Total', 'Avg per hour'];
    const stRows = r.stations.map((s) => [s.code, s.type, r.analysis.types.find((t) => t.type === r.analysis.groupOf[s.code])?.process?.name || '', ...s.hourly, s.total, s.avgPerHour]);
    const robCols = ['Hour', ...r.analysis.robots.map((x) => `${x.type} tote presentations/robot`), ...r.analysis.chargers.map((x) => `${x.type} utilization %`)];
    const robRows = r.hours.map((h, i) => [h, ...r.analysis.robots.map((x) => x.perHour[i]), ...r.analysis.chargers.map((x) => x.vals[i])]);
    const tables = [
      { id: 'system', title: 'System by hour', cols: sysCols, rows: sysRows },
      { id: 'stations', title: 'Stations by hour', cols: stCols, rows: stRows },
      { id: 'fleet', title: 'Robots & chargers by hour', cols: robCols, rows: robRows },
      ...r.extras.map((x) => ({ id: x.key, title: `Other: ${x.key}`, cols: Object.keys(x.rows[0] || {}), rows: x.rows.map((o) => Object.values(o)) })),
    ];
    c.insertAdjacentHTML('beforeend', tables.map((t) => `
      <details class="data-block">
        <summary><span>${esc(t.title)}</span><span class="muted">${t.rows.length} rows</span><button class="btn small" data-csv="${esc(t.id)}">Download CSV</button></summary>
        <div class="table-wrap"><table class="data"><thead><tr>${t.cols.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${t.rows.map((row) => `<tr>${row.map((v) => `<td>${typeof v === 'number' ? fmt(v, v % 1 ? 2 : 0) : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      </details>`).join(''));
    c.querySelectorAll('[data-csv]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      const t = tables.find((x) => x.id === b.dataset.csv);
      downloadCsv(`${r.label} - ${t.title}.csv`, [t.cols, ...t.rows]);
    }));
  }

  function renderMethod(view, r) {
    const sec = el(view, 'section', 'grid-1', 's-method');
    const c = card(sec, 'Method & definitions', 'How each number is produced, so results can be explained to a customer.');
    c.insertAdjacentHTML('beforeend', `
      <ul class="method">
        <li><b>Completed</b>: transport tasks with status FINISHED and end time in the hour, split by carry mode (INBOUND / OUTBOUND).</li>
        <li><b>Open tasks</b>: the last business snapshot in each hour of unfinished inbound / outbound tasks.</li>
        <li><b>Released</b> (derived): completed + open at end of hour − open at end of previous hour. It shows when work entered the system, which the original report does not.</li>
        <li><b>Station tote presentations</b>: an outbound task counts at its destination station and an inbound task at its source station. <b>Avg / h</b> = total ÷ simulated hours, rounded up as the report does.</li>
        <li><b>Underperforming station</b>: average below 85% of the median for its station type. <b>Plateau</b>: healthy stations' steady-state hours (first and last hour excluded) are all within ±2% of each other.</li>
        <li><b>Manual ceiling</b> = 3600 ÷ handling time per tote presentation (from the report parameters). <b>Effective cycle</b> = 3600 ÷ the labor stations' steady-state rate.</li>
        <li><b>Tote presentations per robot per hour</b> = all tote presentations completed in the hour ÷ robot count for that type. <b>Fleet size</b> is inferred by reversing that calculation.</li>
        <li><b>Charger utilization</b> = charging time ÷ (charger count × 1 h).</li>
        <li><b>Design targets</b>: each station is assigned to a design process (src/profiles.js). Within a station type, the side processes (e.g. inventory, consolidation) take the stations that run more than 15% below the type median, smallest target first; all other stations go to the main process. You can change any assignment under Design targets → Station roles.</li>
        <li><b>Pass</b> = simulated rate ≥ target. <b>Not proven</b> = below target, but the stations weren't saturated, so the run didn't release enough work. <b>Below target</b> = the stations were saturated and still fell short. <b>Released vs design</b> = (completed + open at end) ÷ (target × hours).</li>
      </ul>
      ${r.queries.length ? `<details class="data-block"><summary><span>Source queries (${r.queries.length})</span></summary>${r.queries.map((q) => `<h4>${esc(q.name)} <code>${esc(q.code)}</code></h4><pre>${esc(q.sql.trim())}</pre>`).join('')}</details>` : ''}
      <p class="muted small">Source file: ${esc(r.fileName)} · template ${esc(r.template)}</p>`);
  }

  // ---------------- compare ----------------
  function renderCompare(view) {
    const reps = state.reports.slice(0, 8);
    const base = reps[0];
    view.insertAdjacentHTML('beforeend', `<header class="report-head"><div><h1>Scenario comparison</h1>
      <p class="meta">${reps.length} reports · deltas are relative to <b>${esc(base.label)}</b> (the first tab). Drag tabs to change the baseline.</p></div></header>`);
    // [label, value fn, decimals, polarity]: 'up' = higher is better, 'down' = lower is better,
    // 'neutral' = setup or demand-mix figures where a change is neither good nor bad.
    const K = (r) => r.analysis.kpis;
    const groups = [
      ['Setup', [
        ['Simulated hours', (r) => r.durationH, 1, 'neutral'],
        ['Stations', (r) => r.stations.length, 0, 'neutral'],
        ...typeRows(reps),
        ['Robots (inferred)', (r) => K(r).robotFleet, 0, 'neutral'],
        ['Wait / handling time (s)', (r) => r.analysis.opTime, 0, 'neutral'],
      ]],
      ['Design targets', [
        ['Targets met %', (r) => (r.analysis.design ? (r.analysis.kpis.designPass / r.analysis.kpis.designTotal) * 100 : NaN), 0, 'up'],
        ['Main process % of target', (r) => (r.analysis.design ? r.analysis.kpis.mainPctTarget * 100 : NaN), 0, 'up'],
        ['Released vs design %', (r) => (r.analysis.design ? r.analysis.design.demandFactor * 100 : NaN), 0, 'neutral'],
      ]],
      ['Output', [
        ['Tote presentations completed', (r) => K(r).total, 0, 'up'],
        ['  Outbound', (r) => K(r).sumOut, 0, 'neutral'],
        ['  Inbound', (r) => K(r).sumIn, 0, 'neutral'],
        ['Throughput / h (run avg)', (r) => K(r).perHour, 0, 'up'],
        ['Throughput / h (steady state)', (r) => K(r).steadyThroughput, 0, 'up'],
      ]],
      ['Service', [
        ['Peak open outbound', (r) => K(r).peakOpenOut, 0, 'down'],
        ['Open outbound at end', (r) => K(r).endOpenOut, 0, 'down'],
        ['Open inbound at end', (r) => K(r).endOpenIn, 0, 'down'],
        ['Outbound completion rate %', (r) => K(r).completionOut * 100, 1, 'up'],
      ]],
      ['Efficiency', [
        ['Station rate / h (main process)', (r) => K(r).laborSteady, 0, 'up'],
        ['Effective cycle, s (main process)', (r) => K(r).laborCycle, 1, 'down'],
        ['Underperforming stations', (r) => r.analysis.types.reduce((a, t) => a + t.outliers.length, 0), 0, 'down'],
        ['Tote presentations / robot / h', (r) => K(r).robotRate, 2, 'up'],
        ['Charger utilization avg %', (r) => K(r).chargerMean, 0, 'neutral'],
        ['Charger utilization peak %', (r) => K(r).chargerPeak, 0, 'down'],
      ]],
    ];

    const summary = compareSummary(base, reps.slice(1));
    if (summary.length) {
      const sc = el(view, 'section', 'card');
      sc.id = 's-changes';
      sc.innerHTML = `<h2>What changed</h2><p class="card-sub">Generated by comparing each scenario with ${esc(base.label)}.</p>
        <ul class="findings">${summary.map((f) => `<li class="finding ${f.level}"><span class="badge ${f.level}">${statusIcon(f.level)} ${levelLabel(f.level)}</span><div><b class="f-title">${esc(f.title)}</b><p>${f.text}</p></div></li>`).join('')}</ul>`;
    }

    const sec = el(view, 'section', 'grid-1');
    const c = card(sec, 'Side-by-side KPIs', 'Green ▲▼ = better, red = worse, grey = a setup or demand-mix difference rather than a result.');
    c.insertAdjacentHTML('beforeend', `<div class="table-wrap"><table class="data compare-table"><thead><tr><th class="left">Metric</th>${reps.map((r, i) => `<th><i class="sw" style="--c:${SERIES[i]}"></i>${esc(r.label)}<br><span class="muted small">${r.profile ? esc(r.profile.name) : 'No design basis'}</span></th>`).join('')}</tr></thead><tbody>
      ${groups.map(([g, rows]) => `<tr class="group"><th class="left" colspan="${reps.length + 1}">${g}</th></tr>` + rows.map(([name, fn, d = 0, pol]) => {
        const b = fn(base);
        return `<tr><th class="left ${name.startsWith('  ') ? 'indent' : ''}">${esc(name.trim())}</th>${reps.map((r, i) => {
          const v = fn(r);
          if (!Number.isFinite(v)) return '<td class="muted">–</td>';
          if (i === 0) return `<td>${fmt(v, d)}</td>`;
          if (!b || !Number.isFinite(b)) return `<td>${fmt(v, d)}${v ? ' <span class="delta flat">new</span>' : ''}</td>`;
          const dl = (v - b) / Math.abs(b);
          if (Math.abs(dl) < 0.0005) return `<td>${fmt(v, d)} <span class="delta flat">=</span></td>`;
          const cls = pol === 'neutral' ? 'flat' : (pol === 'down' ? dl < 0 : dl > 0) ? 'up' : 'down';
          return `<td>${fmt(v, d)} <span class="delta ${cls}">${dl > 0 ? '▲' : '▼'} ${fmt(Math.abs(dl) * 100, 1)}%</span></td>`;
        }).join('')}</tr>`;
      }).join('')).join('')}</tbody></table></div>`);

    const maxH = Math.max(...reps.map((r) => r.hours.length));
    const labels = Array.from({ length: maxH }, (_, i) => `h${i + 1}`);
    const g = el(view, 'section', 'grid-2');
    const c1 = card(g, 'Tote presentations completed per hour', 'Total inbound + outbound for each scenario.');
    C.hourly(c1, { labels, height: 250, tipTitle: (i) => `Hour ${i + 1}`, series: reps.map((r, i) => ({ name: r.label, color: SERIES[i], type: 'line', values: labels.map((_, h) => r.analysis.totals[h] ?? 0) })) });
    const c2 = card(g, 'Open outbound tasks', 'End-of-hour backlog for each scenario.');
    C.hourly(c2, { labels, height: 250, tipTitle: (i) => `End of hour ${i + 1}`, series: reps.map((r, i) => ({ name: r.label, color: SERIES[i], type: 'line', values: labels.map((_, h) => r.system[h]?.openOut ?? 0) })) });
    const c3 = card(g, 'Tote presentations per robot per hour', 'First robot type in each report.');
    C.hourly(c3, { labels, height: 230, tipFormat: (v) => fmt(v, 2), tipTitle: (i) => `Hour ${i + 1}`, series: reps.map((r, i) => ({ name: r.label, color: SERIES[i], type: 'line', values: labels.map((_, h) => r.analysis.robots[0]?.perHour[h] ?? 0) })) });
    const c4 = card(g, 'Charger utilization', 'First charger type in each report.');
    C.hourly(c4, { labels, height: 230, yMax: 100, yFormat: (v) => `${v}%`, tipFormat: (v) => `${fmt(v)}%`, tipTitle: (i) => `Hour ${i + 1}`, series: reps.map((r, i) => ({ name: r.label, color: SERIES[i], type: 'line', values: labels.map((_, h) => r.analysis.chargers[0]?.vals[h] ?? 0) })) });
  }

  function typeRows(reps) {
    const types = [...new Set(reps.flatMap((r) => r.analysis.types.map((t) => t.type)))];
    const lbl = (type) => reps.map((r) => r.analysis.types.find((t) => t.type === type)?.label).find(Boolean) || prettyType(type);
    return types.map((type) => [`  ${lbl(type)} stations`, (r) => r.analysis.types.find((t) => t.type === type)?.count || 0, 0, 'neutral']);
  }

  // Plain-language differences between each scenario and the baseline.
  function compareSummary(base, others) {
    const out = [];
    const sgn = (v, d = 1) => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v) * 100, d)}%`;
    const rel = (a, b) => (b ? a / b - 1 : 0);
    const kb = base.analysis.kpis;
    others.forEach((o) => {
      const k = o.analysis.kpis;
      const L = esc(o.label);
      const dTot = rel(k.total, kb.total);
      const lb = base.analysis.labor, lo = o.analysis.labor;
      const parts = [`Tote presentations completed ${sgn(dTot)} (${fmt(kb.total)} → ${fmt(k.total)}), steady-state ${fmt(kb.steadyThroughput)} → ${fmt(k.steadyThroughput)}/h.`];
      if (lb && lo) {
        const dRate = rel(lo.steadyMedian, lb.steadyMedian);
        if (Math.abs(dRate) < 0.03 && lo.count !== lb.count) {
          parts.push(`The per-station rate barely moved (${fmt(lb.steadyMedian)} → ${fmt(lo.steadyMedian)}/h), so the difference comes from station count: <b>${lo.count}</b> ${esc(lo.label.toLowerCase())} stations vs ${lb.count}${lb.outliers.length ? `, ${lb.outliers.length} of which underperformed in the baseline` : ''}.`);
        } else if (Math.abs(dRate) >= 0.03) {
          parts.push(`Labor stations ran ${sgn(dRate)} faster per station (${fmt(lb.steadyMedian)} → ${fmt(lo.steadyMedian)}/h).`);
        }
      }
      out.push({ level: dTot >= 0 ? 'good' : 'warning', title: `${o.label}: throughput ${sgn(dTot)}`, text: parts.join(' ') });

      const rb = base.analysis.robots[0], ro = o.analysis.robots[0];
      if (rb && ro) {
        const sameFleet = Math.abs(rel(k.robotFleet, kb.robotFleet)) < 0.03;
        const dProd = rel(k.robotRate, kb.robotRate);
        if (sameFleet && Math.abs(dProd) > 0.05) {
          out.push({ level: 'info', title: 'Robot fleet', text: `About the same fleet (≈${fmt(kb.robotFleet)} → ≈${fmt(k.robotFleet)} robots) moved ${sgn(dProd)} tote presentations per robot (${fmt(kb.robotRate, 1)} → ${fmt(k.robotRate, 1)}/h). ${dProd > 0 ? `The baseline fleet therefore had spare capacity, and robots are not the limit in ${base.label}.` : `${L} gets less out of each robot. Check travel distances or the storage layout.`}` });
        } else if (!sameFleet) {
          out.push({ level: 'info', title: 'Robot fleet', text: `Inferred fleet ${fmt(kb.robotFleet)} → ${fmt(k.robotFleet)} robots; productivity ${fmt(kb.robotRate, 1)} → ${fmt(k.robotRate, 1)} tote presentations/robot/h.` });
        }
      }

      const dPeak = rel(k.peakOpenOut, kb.peakOpenOut);
      if (k.peakOpenOut || kb.peakOpenOut) {
        const worse = k.peakOpenOut > kb.peakOpenOut * 1.05 || k.endOpenOut > kb.endOpenOut * 1.05;
        out.push({ level: worse ? 'warning' : 'good', title: 'Open outbound work', text: `Peak open outbound ${fmt(kb.peakOpenOut)} → <b>${fmt(k.peakOpenOut)}</b> (${sgn(dPeak)}). Open at end of run ${fmt(kb.endOpenOut)} → <b>${fmt(k.endOpenOut)}</b>${k.endOpenOut && o.system.at(-1)?.finOut ? `, about ${fmt((k.endOpenOut / o.system.at(-1).finOut) * 60)} min of work left at the final-hour rate` : ''}.` });
      }

      if (lb?.plateau && lo?.plateau) {
        out.push({ level: 'warning', title: 'Same bottleneck in both', text: `${esc(lo.label)} stations plateau at ~${fmt(lo.steadyMedian)}/h in both runs, an effective ${fmt(k.laborCycle, 1)} s cycle vs ${fmt(o.analysis.opTime)} s handling. To go faster, either add stations or cut the ~${fmt(k.laborCycle - o.analysis.opTime, 1)} s of non-handling time per tote presentation.` });
      }

      const outB = base.analysis.types.flatMap((t) => t.outliers.map((s) => s.code));
      const outO = o.analysis.types.flatMap((t) => t.outliers.map((s) => s.code));
      if (outB.length !== outO.length) {
        out.push({ level: outO.length < outB.length ? 'good' : 'critical', title: 'Underperforming stations', text: `${outB.length ? outB.join(', ') : 'None'} in the baseline vs ${outO.length ? outO.join(', ') : 'none'} in ${L}.` });
      }

      if (!kb.sumIn !== !k.sumIn) {
        out.push({ level: 'info', title: 'Not like-for-like', text: `${!k.sumIn ? L : esc(base.label)} has no inbound work, so total volumes reflect a different order profile as well as different system performance.` });
      }
    });
    return out;
  }

  // ---------------- utils ----------------
  function el(parent, tag, cls, id) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (id) e.id = id;
    parent.appendChild(e);
    return e;
  }
  function card(parent, title, sub, extra = '') {
    const c = el(parent, 'div', `card ${extra}`);
    c.innerHTML = `<h3>${esc(title)}</h3>${sub ? `<p class="card-sub">${esc(sub)}</p>` : ''}`;
    return c;
  }
  function statusIcon(l) { return { good: '✓', warning: '!', critical: '✕', info: 'i' }[l] || 'i'; }
  function levelLabel(l) { return { good: 'OK', warning: 'Watch', critical: 'Act', info: 'Info' }[l] || l; }
  function downloadCsv(name, rows) {
    const csv = rows.map((r) => r.map((v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = name.replace(/[\\/:*?"<>|]/g, '_');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------- wiring ----------------
  function setTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    try { t ? localStorage.setItem('simres-theme', t) : localStorage.removeItem('simres-theme'); } catch (_) {}
    state.reports.length && render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    state.viewMode = store.get('view-mode') || 'walk';
    document.addEventListener('keydown', (e) => {
      if (state.viewMode !== 'walk' || e.altKey || e.ctrlKey || e.metaKey) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (window.SimWalkthrough.step(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
      }
    });
    try { const t = localStorage.getItem('simres-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (_) {}
    const input = $('#file');
    $('#add').addEventListener('click', () => input.click());
    $('#pick').addEventListener('click', () => input.click());
    $('#sample').addEventListener('click', loadSample);
    input.addEventListener('change', () => { loadFiles([...input.files]); input.value = ''; });
    $('#theme').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      setTheme(cur === 'dark' ? 'light' : 'dark');
    });
    $('#print').addEventListener('click', () => window.print());
    $('#tabs').addEventListener('click', (e) => {
      const close = e.target.closest('[data-close]');
      if (close) {
        state.reports = state.reports.filter((r) => r.id !== close.dataset.close);
        if (state.activeId === close.dataset.close || state.reports.length < 2) state.activeId = state.reports[0]?.id ?? null;
        return render();
      }
      const t = e.target.closest('.tab');
      if (t) { state.activeId = t.dataset.id; render(); window.scrollTo({ top: 0 }); }
    });
    // Drag tabs to reorder (sets the comparison baseline).
    let dragId = null;
    $('#tabs').addEventListener('dragstart', (e) => { dragId = e.target.closest('.tab')?.dataset.id; });
    $('#tabs').addEventListener('dragover', (e) => e.preventDefault());
    $('#tabs').addEventListener('drop', (e) => {
      const over = e.target.closest('.tab')?.dataset.id;
      if (!dragId || !over || dragId === over || over === '__compare') return;
      const from = state.reports.findIndex((r) => r.id === dragId), to = state.reports.findIndex((r) => r.id === over);
      const [m] = state.reports.splice(from, 1);
      state.reports.splice(to, 0, m);
      render();
    });
    new MutationObserver(() => $('#tabs').querySelectorAll('.tab:not(.compare)').forEach((t) => t.setAttribute('draggable', 'true'))).observe($('#tabs'), { childList: true });

    // Drag & drop files anywhere.
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; document.body.classList.add('dragging'); } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dragging'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      if (e.dataTransfer?.files?.length) loadFiles([...e.dataTransfer.files]);
    });
    if (!window.SIMRES_SAMPLES) $('#sample').hidden = true;
    render();
  });
})();
