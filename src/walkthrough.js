/* Walkthrough: the report as a sequence of questions an engineer asks, in order.
   Each step = question → one-sentence answer (with status) → one annotated visual →
   "how to read this" → why it matters. Steps not yet built link to the full dashboard. */
(function (global) {
  'use strict';
  const { fmt, pct, median } = global.SimAnalysis;
  const C = global.SimCharts;

  const GLOSSARY = {
    'open tasks': 'Transport tasks released to the system but not finished yet: the queue of waiting work, sampled at the end of each hour.',
    'tote presentation': 'One tote brought to a workstation and handled there. The unit all station and throughput figures are counted in.',
    'ceiling': 'The highest rate the stations reach. When every station sits at the same height while work is queued, that height is their capacity.',
    'cycle': 'Seconds between two consecutive tote presentations at one station = 3600 ÷ presentations per hour.',
    'wait time': 'The time a tote pauses at the station to simulate the operator picking (from the proposal, used for the PAT).',
    'tote exchange': 'The time to swap one tote for the next at the station: the part of the cycle that is not wait time.',
    'design basis': 'The proposal targets this run is checked against (station counts, throughput per process, wait times).',
    'station role': 'Which proposal process a station serves (picking, consolidation …), matched automatically from its throughput.',
  };
  const term = (t, label) => `<abbr class="term" tabindex="0" title="${GLOSSARY[t] || ''}">${label || t}</abbr>`;

  const STEPS = [
    { id: 'run', short: 'Right run?', q: 'Is this the right run?' },
    { id: 'met', short: 'Met the design?', q: 'Did it meet the design?', dash: 's-design' },
    { id: 'pushed', short: 'How hard pushed?', q: 'How hard was it pushed?', dash: 's-flow' },
    { id: 'keptup', short: 'Kept up?', q: 'Did the system keep up?', dash: 's-flow' },
    { id: 'limit', short: 'What limited it?', q: 'What limited it?' },
    { id: 'stations', short: 'Stations OK?', q: 'Is every station behaving?', dash: 's-stations' },
    { id: 'margin', short: 'How much margin?', q: 'How much margin is there?', dash: 's-design' },
    { id: 'summary', short: 'Summary', q: 'What do I tell the customer?', dash: 's-findings' },
  ];

  // ---------------------------------------------------------------- answers
  // Every step gets a status + one-sentence answer, even the ones not fully built yet,
  // so the rail works as an executive summary.
  function answers(r, ctx) {
    const a = r.analysis, k = a.kpis, d = a.design;
    const out = {};
    const run = runChecks(r, ctx);
    out.run = { level: run.level, text: run.verdict };

    if (d) {
      const fail = d.rows.filter((x) => x.status === 'fail' || x.status === 'missing');
      const dem = d.rows.filter((x) => x.status === 'demand');
      out.met = {
        level: fail.length ? 'critical' : dem.length ? 'warning' : 'good',
        text: `${k.designPass} of ${k.designTotal} processes met their target${fail.length ? `; ${fail.map((x) => x.process.name).join(', ')} fell short` : dem.length ? `; ${dem.map((x) => x.process.name).join(', ')} not proven` : ''}.`,
      };
      out.pushed = { level: 'info', text: `Work was released at about ${pct(d.demandFactor)} of the design rate.` };
    } else {
      out.met = { level: 'info', text: 'No design basis selected, so there is nothing to check against.' };
      out.pushed = { level: 'info', text: `${fmt(k.releasedOut + k.releasedIn)} tasks were released over ${fmt(r.durationH, 1)} h.` };
    }
    const grew = r.system.filter((x, i) => x.openOut > (i ? r.system[i - 1].openOut : 0)).length;
    out.keptup = grew >= 2
      ? { level: k.endOpenOut < k.peakOpenOut * 0.25 ? 'warning' : 'critical', text: `Not at first: open work built to ${fmt(k.peakOpenOut)} by hour ${k.peakOpenOutHour}, then ${k.endOpenOut < k.peakOpenOut * 0.25 ? `drained to ${fmt(k.endOpenOut)}` : `was still ${fmt(k.endOpenOut)} at the end`}.` }
      : { level: 'good', text: 'Yes. Open work never built up.' };
    out.limit = limitAnswer(r);
    const outl = a.types.reduce((n, t) => n + t.outliers.length, 0);
    out.stations = outl
      ? { level: 'critical', text: `${outl} station${outl > 1 ? 's' : ''} ran more than 15% below the others in ${outl > 1 ? 'their roles' : 'its role'}.` }
      : { level: 'good', text: 'Yes. Every station runs within 15% of the others in its role.' };
    const main = d && d.rows.find((x) => x.process.main);
    out.margin = main && main.capacity
      ? { level: main.capacityPct >= 1.05 ? 'good' : main.capacityPct >= 1 ? 'warning' : 'critical', text: `${main.process.name} capacity is ${fmt(main.capacity)}/h, ${pct(main.capacityPct)} of target.` }
      : { level: 'info', text: 'Capacity isn\'t observable: the stations never filled up.' };
    out.summary = { level: 'info', text: 'The conclusions above, worded for the customer.' };
    return out;
  }

  function limitAnswer(r) {
    const a = r.analysis, k = a.kpis, L = a.labor;
    const backlog = k.peakOpenOut > 0;
    if (L && L.plateau && backlog) {
      return { level: 'warning', text: `The ${L.label.toLowerCase()} stations. They held a ${fmt(L.steadyMedian)}/h ceiling while up to ${fmt(k.peakOpenOut)} tasks waited; robots and chargers had room to spare.` };
    }
    if (backlog) return { level: 'warning', text: 'Not the stations: they never reached a shared ceiling while work waited. Look at robot supply or how work was released.' };
    return { level: 'good', text: 'Nothing. Demand never exceeded what the system could handle.' };
  }

  // ---------------------------------------------------------------- step 1
  function runChecks(r, ctx) {
    const a = r.analysis, d = a.design;
    const checks = [];
    const ds = [
      ['throughput & open tasks', r.system.some((x) => x.finIn + x.finOut + x.openIn + x.openOut > 0)],
      ['stations', r.stations.length > 0],
      ['robots', r.robots.length > 0],
      ['chargers', Object.keys(r.chargers).length > 0],
    ];
    const missing = ds.filter(([, ok]) => !ok).map(([n]) => n);
    checks.push({
      level: missing.length ? (missing.includes('throughput & open tasks') || missing.includes('stations') ? 'critical' : 'warning') : 'good',
      title: 'Report data',
      text: missing.length ? `Missing: ${missing.join(', ')}. The steps that rely on them will be empty.` : `All ${ds.length} datasets found (throughput, open tasks, ${r.stations.length} stations, robots, chargers).`,
    });
    checks.push({
      level: 'good', title: 'Run length',
      text: `${fmt(r.durationH, 1)} h simulated, ${ctx.tz(r.start)} → ${ctx.tz(r.end)} (UTC${r.tz}). Rates are averaged over this whole window, including the first and last hours.`,
    });
    if (!d) {
      checks.push({
        level: 'warning', title: 'Design basis',
        text: `None yet, so this run can't be checked against its design. Paste the design inputs from the Customer Success Tool.<span class="check-actions"><button class="btn small primary" type="button" data-paste-design>Paste design inputs</button><button class="btn small" type="button" data-import-design>Import file…</button></span>`,
      });
    } else {
      checks.push({
        level: d.profile.example ? 'warning' : 'good', title: 'Design basis',
        text: d.profile.example ? 'Only the illustrative example is selected. Import the project\'s design inputs to get real targets.'
          : d.profile.imported ? `Design inputs <b>${ctx.esc(d.profile.profileName)}</b> from ${ctx.esc(d.profile.source)}, matched automatically to this report.`
            : `${ctx.esc(d.profile.name)}: ${ctx.esc(d.profile.source)}.`,
      });
      const ov = Object.keys(r.roleOverrides || {}).length;
      const un = d.unassigned.reduce((n, g) => n + g.count, 0);
      checks.push({
        level: un ? 'warning' : 'good', title: 'Station roles',
        text: un ? `${un} station(s) have no design role.` : `All ${r.stations.length} stations matched to a process by throughput${ov ? ` (${ov} changed by you)` : ''}.`,
      });
      d.rows.filter((x) => x.group && x.stationsSim !== x.stationsDesign).forEach((x) => {
        const more = x.stationsSim > x.stationsDesign;
        checks.push({
          level: 'warning', title: `${x.process.name} station count`,
          text: `<b>${x.stationsSim}</b> in the simulation vs <b>${x.stationsDesign}</b> in the design. ${more ? 'Extra stations add capacity, so the result may look better than the design would deliver.' : 'Fewer stations than designed: this process is tested with less capacity than proposed.'}`,
          ask: `${x.process.name}: the simulation has ${x.stationsSim} stations but the proposal specifies ${x.stationsDesign}. Is that intentional, or are some stations modelled under a different process?`,
        });
      });
      const mainRow = d.rows.find((x) => x.process.main);
      if (mainRow && mainRow.process.wait && d.reportOpTime && d.reportOpTime !== mainRow.process.wait) {
        checks.push({
          level: 'warning', title: 'Wait time parameter',
          text: `The report says <b>${fmt(d.reportOpTime)} s</b> handling per tote presentation; the proposal's PAT ${term('wait time')} is <b>${fmt(mainRow.process.wait)} s</b>. That changes how the observed ${term('cycle')} splits into wait and ${term('tote exchange')} (step 5).`,
          ask: `The report parameter "outbound manual one box operation time" is ${fmt(d.reportOpTime)} s, but the proposal PAT wait time is ${fmt(mainRow.process.wait)} s. Which value did the simulation run with?`,
        });
      }
    }
    const order = { critical: 3, warning: 2, info: 1, good: 0 };
    const worst = checks.reduce((w, c) => (order[c.level] > order[w] ? c.level : w), 'good');
    const nAsk = checks.filter((c) => c.ask).length;
    const verdict = worst === 'critical'
      ? 'No. Key data is missing, so the later steps can\'t be trusted.'
      : worst === 'warning'
        ? `Usable, but ${nAsk ? `${nAsk} thing${nAsk > 1 ? 's' : ''} to confirm with the simulation engineer` : 'check the warnings below'} before quoting results.`
        : 'Yes. The data is complete and the setup matches the design.';
    return { checks, level: worst, verdict };
  }

  function renderRun(body, r, ctx) {
    const res = runChecks(r, ctx);
    const d = r.analysis.design;
    const grid = div(body, 'step-grid');
    const left = div(grid, 'step-main');
    const right = div(grid, 'step-side');

    // Visual: workstations, design vs simulation.
    if (d) {
      const v = div(left, 'viz-card');
      v.innerHTML = `<h4>Workstations: design vs simulation</h4>
        <div class="pips">${d.rows.map((x) => {
          const n = Math.max(x.stationsSim, x.stationsDesign);
          const pips = Array.from({ length: n }, (_, i) => {
            const inSim = i < x.stationsSim, inDes = i < x.stationsDesign;
            const cls = inSim && inDes ? 'both' : inSim ? 'extra' : 'missing';
            return `<i class="pip ${cls}" title="${cls === 'both' ? 'In design and simulation' : cls === 'extra' ? 'In the simulation, not in the design' : 'In the design, not simulated'}"></i>`;
          }).join('');
          // Match = ✓ green. Extra stations = ! amber (result may look better than the design).
          // Missing stations = ✕ red (process tested with less capacity than proposed).
          const diff = x.stationsSim - x.stationsDesign;
          const st = diff === 0 ? { cls: 'ok', icon: '✓', note: 'Matches design' }
            : diff > 0 ? { cls: 'warn', icon: '!', note: `${diff} extra` }
            : { cls: 'bad', icon: '✕', note: `${-diff} missing` };
          return `<div class="pip-row ${st.cls}"><span class="pip-label">${ctx.esc(x.process.name)}</span><span class="pip-set">${pips}</span>
            <span class="count-chip ${st.cls}" title="Simulated / designed workstations">
              <span class="cc-icon" aria-hidden="true">${st.icon}</span>
              <span class="cc-num"><b>${x.stationsSim}</b><span class="cc-of">/ ${x.stationsDesign}</span></span>
              <span class="cc-note">${st.note}</span>
            </span></div>`;
        }).join('')}</div>
        <div class="pip-legend"><span><i class="pip both"></i> in design and simulation</span><span><i class="pip extra"></i> simulation only</span><span><i class="pip missing"></i> design only</span>
          <span class="legend-sep"></span>
          <span><i class="cc-icon mini ok">✓</i> matches</span><span><i class="cc-icon mini warn">!</i> extra: may look better than designed</span><span><i class="cc-icon mini bad">✕</i> missing: under-tested</span></div>`;
      howTo(left, [
        'Each square is one workstation, grouped by the process it serves. The count reads <b>simulated / designed</b>.',
        'A clean result is all dark squares. Orange squares are stations the proposal doesn\'t include; dashed ones are designed stations the simulation left out.',
      ]);
    }

    // Checklist
    const cl = div(right, 'checklist');
    cl.innerHTML = `<h4>Setup checks</h4><ul>${res.checks.map((c) => `<li class="${c.level}"><span class="badge ${c.level}">${ctx.statusIcon(c.level)}</span><div><b>${c.title}</b><p>${c.text}</p></div></li>`).join('')}</ul>`;
    const asks = res.checks.filter((c) => c.ask);
    if (asks.length) {
      const box = div(right, 'ask-box');
      const text = `Questions on ${r.label} (${r.reportCode}):\n` + asks.map((c, i) => `${i + 1}. ${c.ask}`).join('\n');
      box.innerHTML = `<h4>To confirm with the simulation engineer</h4><ol>${asks.map((c) => `<li>${ctx.esc(c.ask)}</li>`).join('')}</ol><button class="btn small" type="button">Copy questions</button>`;
      box.querySelector('button').addEventListener('click', async (e) => {
        try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied ✓'; } catch (_) { e.target.textContent = 'Copy failed'; }
        setTimeout(() => (e.target.textContent = 'Copy questions'), 2000);
      });
    }
    why(body, 'Every later step compares this run to the proposal. If the layout or the timing parameters differ, a "pass" may not mean what you think, so settle these questions before quoting any number to the customer.');
  }

  // ---------------------------------------------------------------- step 5
  function renderLimit(body, r, ctx) {
    const a = r.analysis, k = a.kpis, L = a.labor;
    const grid = div(body, 'step-grid wide-main');
    const left = div(grid, 'step-main');
    const right = div(grid, 'step-side');

    if (L) {
      // Chart: every station of the main process, hour by hour, with the ceiling.
      const labels = r.hours.map((h) => `h${h}`);
      const medianLine = r.hours.map((_, i) => median(L.list.filter((s) => !L.outliers.includes(s)).map((s) => s.hourly[i])));
      const wait = (L.process && L.process.wait) || a.reportOpTime;
      const waitOnly = wait ? 3600 / wait : 0;
      const peakI = k.peakOpenOutHour - 1;
      const v = div(left, 'viz-card');
      v.innerHTML = `<h4>${ctx.esc(L.label)} stations: ${term('tote presentation', 'tote presentations')} per hour</h4>`;
      const series = [
        ...L.list.map((s, i) => ({ name: s.code, color: 'var(--ink-2)', type: 'line', muted: true, values: s.hourly, legend: i === 0 ? true : false })),
        { name: 'Median station', color: ctx.SERIES[0], type: 'line', values: medianLine },
      ];
      series[0].name = 'Each station';
      C.hourly(v, {
        labels, height: 280, tipTitle: (i) => `Hour ${r.hours[i]}`,
        yMax: Math.ceil(Math.max(waitOnly, L.steadyMedian, (L.process && L.process.maxRate) || 0, (L.process && L.process.stationRate) || 0) * 1.12 / 50) * 50,
        series,
        refs: [
          ...(L.process && L.process.maxRate ? [{ value: L.process.maxRate, label: `Workstation max: ${fmt(L.process.maxRate)}/h (${L.process.note || 'design inputs'})`, tone: 'faint' }] : []),
          ...(waitOnly && !(L.process && L.process.maxRate && Math.abs(L.process.maxRate - waitOnly) < 15) ? [{ value: waitOnly, label: `If wait time were the only delay: ${fmt(waitOnly)}/h (${fmt(wait)} s)`, tone: 'faint', below: true }] : []),
          ...(L.process && L.process.stationRate ? [{ value: L.process.stationRate, label: `Design rate per station: ${fmt(L.process.stationRate)}/h`, below: true }] : []),
        ],
        annotations: [
          { i: Math.min(peakI, r.hours.length - 1), value: medianLine[Math.min(peakI, r.hours.length - 1)], text: `Still ${fmt(medianLine[peakI])}/h here, with\n${fmt(k.peakOpenOut)} tasks waiting`, dx: peakI > r.hours.length / 2 ? -18 : 18, dy: 54, anchor: peakI > r.hours.length / 2 ? 'end' : 'start' },
        ],
        extraTip: (i) => [{ name: 'Open outbound at hour end', value: fmt(r.system[i].openOut) }],
      });
      howTo(left, [
        `Each grey line is one ${L.label.toLowerCase()} station; the blue line is the median.`,
        `<b>Flat lines bunched at one height while work is waiting</b> mean the stations are working as fast as they can: that height is their ${term('ceiling')}. If robots were short, the lines would dip and scatter instead.`,
      ]);

      // Cycle breakdown
      const cyc = k.laborCycle;
      const main = a.design && a.design.rows.find((x) => x.process === L.process);
      const needCycle = main && main.perStationTarget ? 3600 / main.perStationTarget : 0;
      if (cyc) {
        const exch = wait ? cyc - wait : 0;
        const scale = Math.max(cyc, needCycle) * 1.05;
        const w = (sec) => `${(sec / scale) * 100}%`;
        const cb = div(left, 'viz-card');
        cb.innerHTML = `<h4>Where each station ${term('cycle')} goes</h4>
          <div class="cycle-row"><span class="cycle-label">Simulated</span><div class="cycle-bar">
            ${wait ? `<span class="seg wait" style="width:${w(wait)}">${fmt(wait)} s</span><span class="seg exch" style="width:${w(Math.max(0, exch))}">${fmt(exch, 1)} s</span>` : `<span class="seg wait" style="width:${w(cyc)}">${fmt(cyc, 1)} s</span>`}
          </div><span class="cycle-total">${fmt(cyc, 1)} s = ${fmt(L.steadyMedian)}/h</span></div>
          ${wait ? `<div class="pip-legend cycle-legend"><span><i class="pip both"></i> ${term('wait time')}: operator picking, ${L.process && L.process.wait ? 'from the design' : 'from the report\'s handling-time parameter'}</span><span><i class="pip extra"></i> ${term('tote exchange')}: swapping to the next tote</span></div>` : ''}
          ${needCycle ? `<div class="cycle-row"><span class="cycle-label">Needed for target</span><div class="cycle-bar"><span class="seg need" style="width:${w(needCycle)}">${fmt(main.perStationTarget)}/h per station</span></div><span class="cycle-total">${fmt(needCycle, 1)} s</span></div>
          <p class="cycle-note">The simulated cycle is <b>${fmt(needCycle - cyc, 1)} s shorter</b> than the ${fmt(needCycle, 1)} s each station can take and still hit ${fmt(main.process.target)}/h with the design's ${main.stationsDesign} stations, so the target holds with about ${pct(needCycle / cyc - 1)} to spare.</p>` : ''}`;
        howTo(left, [
          `A station's ${term('cycle')} is the time from one tote to the next. Part of it is the ${term('wait time')} (operator picking, fixed by the proposal); the rest is ${term('tote exchange')}, which the robots and station design control.`,
          'To speed up the stations you can only shorten the exchange part, or add stations.',
        ]);
      }
    }

    // Elimination cards
    right.insertAdjacentHTML('beforeend', '<h4 class="side-h">Checking each possible limit</h4>');
    const cards = [];
    const backlog = k.peakOpenOut > 0;
    if (L) {
      const lim = L.plateau && backlog;
      cards.push({
        name: `${L.label} stations`, limiting: lim, metric: `${fmt(L.steadyMedian)}/h`, sub: 'per station, steady state',
        evidence: lim ? `All ${L.count - L.outliers.length} stations sat within ±${pct(L.spread / 2, 1)} of ${fmt(L.steadyMedian)}/h every hour while up to ${fmt(k.peakOpenOut)} tasks waited.` : 'Station rates varied while work waited, so they were not at a shared ceiling.',
        looks: 'Limiting looks like: all stations flat at one height while open tasks pile up.',
      });
    }
    if (a.robots.length) {
      const peer = (ctx.reports || []).filter((o) => o !== r && o.analysis.kpis.robotFleet && Math.abs(o.analysis.kpis.robotFleet / k.robotFleet - 1) < 0.03 && o.analysis.kpis.robotRate > k.robotRate * 1.05)[0];
      const lim = !(L && L.plateau) && backlog;
      cards.push({
        name: 'Robots', limiting: lim, metric: `${fmt(k.robotRate, 1)}/robot/h`, sub: `≈${fmt(k.robotFleet)} robots (inferred)`,
        evidence: lim ? 'Stations were below their ceiling while work waited, which points to totes not arriving fast enough.'
          : `The stations never ran short of totes: they stayed at their ceiling the whole time work was waiting.${peer ? ` In ${ctx.esc(peer.label)} the same ≈${fmt(peer.analysis.kpis.robotFleet)} robots reached ${fmt(peer.analysis.kpis.robotRate, 1)}/robot/h, so this fleet has room to spare.` : ''}`,
        looks: 'Limiting looks like: station lines dip below their ceiling while work is still waiting.',
      });
    }
    if (a.chargers.length) {
      const lim = k.chargerPeak >= 70;
      cards.push({
        name: 'Chargers', limiting: lim, metric: `${fmt(k.chargerMean)}% busy`, sub: `peak ${fmt(k.chargerPeak)}%`,
        evidence: lim ? 'Chargers were busy for most of the hour at peak, so robots may queue to charge.' : `Chargers were idle more than half the time even in the busiest hour (${fmt(k.chargerPeak)}%).`,
        looks: 'Limiting looks like: utilization above ~70–85% and robot productivity falling.',
        meter: k.chargerPeak,
      });
    }
    right.insertAdjacentHTML('beforeend', cards.map((c) => `
      <div class="elim ${c.limiting ? 'is-limit' : ''}">
        <div class="elim-head"><b>${c.name}</b><span class="badge ${c.limiting ? 'warning' : 'good'}">${c.limiting ? '! Limiting' : '✓ Not limiting'}</span></div>
        <div class="elim-metric">${c.metric} <span>${c.sub}</span></div>
        ${c.meter != null ? `<div class="meter"><span style="width:${Math.min(100, c.meter)}%"></span><i style="left:70%" title="70% warning level"></i></div>` : ''}
        <p>${c.evidence}</p>
        <p class="elim-looks">${c.looks}</p>
      </div>`).join(''));

    why(body, L && L.plateau
      ? `Knowing the limit tells you which lever moves throughput. Adding robots or chargers here would change nothing; only more ${L.label.toLowerCase()} stations or a shorter tote exchange would.`
      : 'Knowing the limit tells you which lever moves throughput: more stations, more robots, or a different release of work.');
  }

  // ---------------------------------------------------------------- shell
  function render(view, r, ctx) {
    const ans = answers(r, ctx);
    const wrap = div(view, 'walk');
    const rail = document.createElement('nav');
    rail.className = 'rail';
    rail.setAttribute('aria-label', 'Walkthrough steps');
    wrap.appendChild(rail);
    const main = div(wrap, 'chapters');

    rail.innerHTML = `<ol>${STEPS.map((s, i) => `<li><a href="#step-${s.id}" data-step="${s.id}"><span class="dot ${ans[s.id].level}">${i + 1}</span><span class="rail-text"><span class="rail-q">${s.short}</span><span class="rail-status">${ctx.statusIcon(ans[s.id].level)} ${ctx.levelLabel(ans[s.id].level)}</span></span></a></li>`).join('')}</ol>
      <p class="rail-hint">← → to move between steps</p>`;

    STEPS.forEach((s, i) => {
      const ch = document.createElement('section');
      ch.className = 'chapter';
      ch.id = `step-${s.id}`;
      const built = s.id === 'run' || s.id === 'limit';
      ch.innerHTML = `<div class="eyebrow">Step ${i + 1} of ${STEPS.length}</div>
        <h2 class="question">${s.q}</h2>
        <p class="answer ${ans[s.id].level}"><span class="badge ${ans[s.id].level}">${ctx.statusIcon(ans[s.id].level)} ${ctx.levelLabel(ans[s.id].level)}</span><span>${ans[s.id].text}</span></p>`;
      main.appendChild(ch);
      const body = div(ch, 'chapter-body');
      if (s.id === 'run') renderRun(body, r, ctx);
      else if (s.id === 'limit') renderLimit(body, r, ctx);
      if (!built) {
        body.innerHTML = `<div class="coming">The full walkthrough for this step is coming. For now, the details are in the dashboard.
          <button class="btn small" type="button" data-goto="${s.dash}">Open in full dashboard →</button></div>`;
        ch.classList.add('stub');
      }
      const nav = div(ch, 'chapter-nav');
      nav.innerHTML = `${i ? `<a class="btn" href="#step-${STEPS[i - 1].id}">← ${STEPS[i - 1].short}</a>` : '<span></span>'}${i < STEPS.length - 1 ? `<a class="btn primary" href="#step-${STEPS[i + 1].id}">Next: ${STEPS[i + 1].q} →</a>` : ''}`;
    });

    main.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => ctx.openDashboard(b.dataset.goto)));

    // Active step tracking + reveal animation.
    const links = [...rail.querySelectorAll('a[data-step]')];
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) e.target.classList.add('in-view');
      });
      const visible = [...main.querySelectorAll('.chapter')].filter((c) => {
        const b = c.getBoundingClientRect();
        return b.top < window.innerHeight * 0.45 && b.bottom > window.innerHeight * 0.3;
      });
      const cur = visible[0];
      if (cur) links.forEach((l) => l.classList.toggle('active', `step-${l.dataset.step}` === cur.id));
    }, { threshold: [0, 0.2, 0.5] });
    main.querySelectorAll('.chapter').forEach((c) => io.observe(c));
    const onScroll = () => {
      const chs = [...main.querySelectorAll('.chapter')];
      const cur = chs.filter((c) => c.getBoundingClientRect().top < window.innerHeight * 0.4).pop() || chs[0];
      links.forEach((l) => l.classList.toggle('active', `step-${l.dataset.step}` === cur.id));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    ctx.onTeardown(() => { io.disconnect(); window.removeEventListener('scroll', onScroll); });
  }

  // Keyboard: ← / → move between steps.
  function step(dir) {
    const chs = [...document.querySelectorAll('.chapter')];
    if (!chs.length) return false;
    // Current step = the last chapter whose top has passed just below the sticky header.
    let cur = 0;
    chs.forEach((c, i) => { if (c.getBoundingClientRect().top <= 110) cur = i; });
    chs[Math.max(0, Math.min(chs.length - 1, cur + dir))].scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }

  // ---------------------------------------------------------------- bits
  function div(parent, cls) { const d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; }
  function howTo(parent, lines) {
    const h = div(parent, 'how-to');
    h.innerHTML = `<span class="how-icon" aria-hidden="true">?</span><div><b>How to read this</b>${lines.map((l) => `<p>${l}</p>`).join('')}</div>`;
  }
  function why(parent, text) {
    const w = div(parent, 'why');
    w.innerHTML = `<b>Why it matters</b><p>${text}</p>`;
  }

  global.SimWalkthrough = { render, step, STEPS };
})(window);
