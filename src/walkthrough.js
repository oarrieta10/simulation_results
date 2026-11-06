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
    const mg = marginNumbers(r);
    out.margin = !mg ? { level: 'info', text: 'Capacity isn\'t observable: the stations never filled up, so this run can\'t measure it.' }
      : mg.target ? {
        level: mg.capDesignPct >= 1.05 ? 'good' : mg.capDesignPct >= 1 ? 'warning' : 'critical',
        text: `With the design's ${mg.stationsDesign} stations, ${mg.name.toLowerCase()} can do about <b>${fmt(mg.capDesign)}/h</b>: ${pct(mg.capDesignPct)} of the ${fmt(mg.target)}/h target${mg.stationsSim !== mg.stationsDesign ? ` (${pct(mg.capSimPct)} with the ${mg.stationsSim} simulated)` : ''}.`,
      } : { level: 'info', text: `${mg.name} stations top out at ${fmt(mg.rate)}/h each, ${fmt(mg.capSim)}/h in total. Add design inputs to compare with a target.` };
    out.summary = { level: 'info', text: 'The conclusions above, worded for the customer, plus the points to settle internally.' };
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

  // ---------------------------------------------------------------- shared
  function noDesign(body, what) {
    const b = div(body, 'coming');
    b.innerHTML = `<span>${what} needs the design inputs, so there's nothing to compare yet.</span>
      <span class="check-actions"><button class="btn small primary" type="button" data-paste-design>Paste design inputs</button><button class="btn small" type="button" data-import-design>Import file…</button></span>`;
  }
  const statusChip = (x) => {
    const m = { pass: ['ok', '✓', 'Pass'], demand: ['warn', '!', 'Not proven'], fail: ['bad', '✕', 'Below target'], missing: ['bad', '✕', 'No stations'] }[x.status];
    return `<span class="count-chip ${m[0]} slim"><span class="cc-icon" aria-hidden="true">${m[1]}</span><span class="cc-note">${m[2]}</span></span>`;
  };

  // Capacity of the main process: observed per-station ceiling × stations (simulated and designed).
  function marginNumbers(r) {
    const a = r.analysis, L = a.labor, d = a.design;
    if (!L || !L.plateau || !L.steadyMedian) return null;
    const row = d && d.rows.find((x) => x.process === L.process);
    const rate = L.steadyMedian;
    const stationsSim = L.count - L.outliers.length;
    const stationsDesign = row ? row.stationsDesign : stationsSim;
    const target = row ? row.process.target : 0;
    const capSim = rate * stationsSim, capDesign = rate * stationsDesign;
    const perStationNeed = target && stationsDesign ? target / stationsDesign : 0;
    return {
      name: L.label, rate, stationsSim, stationsDesign, target, capSim, capDesign,
      capSimPct: target ? capSim / target : 0, capDesignPct: target ? capDesign / target : 0,
      stationsNeeded: target ? Math.ceil(target / rate) : 0,
      cycle: 3600 / rate, cycleAllowed: perStationNeed ? 3600 / perStationNeed : 0, perStationNeed,
      maxRate: L.process && L.process.maxRate, stationRate: L.process && L.process.stationRate,
    };
  }

  // ---------------------------------------------------------------- step 2
  function renderMet(body, r, ctx) {
    const d = r.analysis.design;
    if (!d) return noDesign(body, 'Checking against the design');
    const grid = div(body, 'step-grid');
    const left = div(grid, 'step-main'), right = div(grid, 'step-side');
    const v = div(left, 'viz-card');
    v.innerHTML = `<h4>Simulated vs design, per process</h4>
      <div class="bullets">${d.rows.map((x) => {
        const scale = Math.max(x.actual, x.process.target, x.demand) * 1.1 || 1;
        const w = (n) => `${Math.min(100, (n / scale) * 100)}%`;
        const cls = x.status === 'pass' ? 'ok' : x.status === 'demand' ? 'warn' : 'bad';
        return `<div class="bullet-row ${cls}">
          <div class="bullet-head"><b>${ctx.esc(x.process.name)}</b>
            <span class="bullet-val"><b>${fmt(x.actual)}</b><span class="muted"> / ${fmt(x.process.target)} per h</span> <span class="bullet-pct">${pct(x.pct)}</span></span>${statusChip(x)}</div>
          <div class="bullet-track" role="img" aria-label="${ctx.esc(x.process.name)}: simulated ${fmt(x.actual)} per hour against a target of ${fmt(x.process.target)}">
            <span class="b-demand" style="width:${w(x.demand)}" title="Released: ${fmt(x.demand)}/h"></span>
            <span class="b-actual" style="width:${w(x.actual)}" title="Simulated: ${fmt(x.actual)}/h"></span>
            <span class="b-target" style="left:${w(x.process.target)}" title="Target: ${fmt(x.process.target)}/h"></span>
          </div></div>`;
      }).join('')}</div>
      <div class="pip-legend"><span><i class="lg-bar actual"></i> simulated rate</span><span><i class="lg-bar demand"></i> work released</span><span><i class="lg-tick"></i> design target</span></div>`;
    howTo(left, [
      'Each row is one process, scaled to its own target. The <b>dark bar</b> is what the simulation completed per hour; the <b>black tick</b> is the design target.',
      'Past the tick is a pass. The pale bar behind shows how much work the simulation released: if it stops short of the tick, the run never asked for the target, so a shortfall there is "not proven" rather than a fail.',
    ]);

    const kinds = [
      ['pass', 'ok', '✓ Pass', 'Completed at least the target rate.'],
      ['demand', 'warn', '! Not proven', 'Fell short, but the stations still had spare capacity: the simulation didn\'t release enough work to reach the target. Rerun with more demand to prove it.'],
      ['fail', 'bad', '✕ Below target', 'The stations were full and still fell short. This is a real capacity gap.'],
    ];
    right.insertAdjacentHTML('beforeend', `<h4 class="side-h">What each result means</h4>${kinds.map(([k, cls, label, text]) => {
      const n = d.rows.filter((x) => x.status === k);
      return `<div class="elim ${n.length ? '' : 'dim'}"><div class="elim-head"><b>${label}</b><span class="muted small">${n.length} process${n.length === 1 ? '' : 'es'}</span></div>${n.length ? `<p class="elim-names">${n.map((x) => ctx.esc(x.process.name)).join(' · ')}</p>` : ''}<p>${text}</p></div>`;
    }).join('')}
      ${d.demandFactor > 1.05 ? `<div class="elim"><p>The run released about <b>${pct(d.demandFactor)}</b> of the design demand, so these passes already include a margin. Step 3 shows how the work arrived.</p></div>` : ''}`);
    why(body, `These targets are what Hai Robotics commits to in the PAT (performance acceptance test). A pass here is the first thing the customer will ask about, and a "not proven" means the run can't back up the number yet.`);
  }

  // ---------------------------------------------------------------- step 3
  function renderPushed(body, r, ctx) {
    const a = r.analysis, d = a.design, k = a.kpis;
    const grid = div(body, 'step-grid wide-main');
    const left = div(grid, 'step-main'), right = div(grid, 'step-side');
    const labels = r.hours.map((h) => `h${h}`);
    const relOut = a.flow.map((x) => Math.max(0, x.relOut)), relIn = a.flow.map((x) => Math.max(0, x.relIn));
    const tot = relOut.map((v, i) => v + relIn[i]);
    const designTotal = d ? (d.profile.ratePph || d.rows.reduce((s, x) => s + x.process.target, 0)) : 0;
    const pk = tot.indexOf(Math.max(...tot));
    const hasIn = relIn.some((v) => v > 0);
    const v = div(left, 'viz-card');
    v.innerHTML = '<h4>Work released into the system, per hour</h4>';
    C.hourly(v, {
      labels, height: 270, totalRow: true, tipTitle: (i) => `Hour ${r.hours[i]}`,
      series: [
        { name: 'Outbound released', color: ctx.SERIES[0], values: relOut },
        ...(hasIn ? [{ name: 'Inbound released', color: ctx.SERIES[1], values: relIn }] : []),
      ],
      refs: designTotal ? [{ value: designTotal, label: `Design demand ${fmt(designTotal)}/h` }] : [],
      annotations: [{ i: pk, value: tot[pk], text: `Peak release: ${fmt(tot[pk])}\nin hour ${pk + 1}`, dx: pk > labels.length / 2 ? -20 : 22, dy: -6, anchor: pk > labels.length / 2 ? 'end' : 'start' }],
    });
    howTo(left, [
      'Each bar is the work that <b>arrived</b> in that hour: tasks completed plus the change in the queue. The line is the demand the system was designed for.',
      'Bars above the line mean the simulation pushed harder than the design; below means it asked for less.',
    ]);

    const half = Math.ceil(tot.length / 2);
    const total = tot.reduce((s, x) => s + x, 0) || 1;
    const firstHalf = tot.slice(0, half).reduce((s, x) => s + x, 0) / total;
    const over = tot.filter((x) => designTotal && x > designTotal).length;
    right.insertAdjacentHTML('beforeend', `<h4 class="side-h">How the demand compares</h4>
      <div class="elim"><div class="elim-head"><b>Overall</b></div>
        <div class="elim-metric">${d ? pct(d.demandFactor) : fmt(total / r.durationH)}<span>${d ? 'of design demand' : 'tasks released per hour'}</span></div>
        <p>${fmt(total)} tasks released over ${fmt(r.durationH, 1)} h${designTotal ? `; ${over} of ${tot.length} hours above the design rate` : ''}.</p></div>
      ${d ? `<div class="elim"><div class="elim-head"><b>Per process</b></div><div class="mini-rows">${d.rows.map((x) => `
        <div class="mini-row"><span>${ctx.esc(x.process.name)}</span><span class="mini-track"><span style="width:${Math.min(100, (x.demandPct / 1.5) * 100)}%"></span><i style="left:${(1 / 1.5) * 100}%"></i></span><b>${x.group ? pct(x.demandPct) : '–'}</b></div>`).join('')}</div>
        <p class="elim-looks">Tick = 100% of design. Released = completed + still open at the end, per hour.</p></div>` : ''}
      <div class="elim"><div class="elim-head"><b>Timing</b><span class="badge ${firstHalf > 0.6 ? 'warning' : 'good'}">${firstHalf > 0.6 ? '! Front-loaded' : '✓ Even'}</span></div>
        <p>${pct(firstHalf)} of the work arrived in the first half of the run${firstHalf > 0.6 ? ', so a queue was bound to build early (step 4)' : ''}.</p></div>`);
    if (!d) noDesign(body, 'Comparing demand with the design');
    why(body, d && d.demandFactor > 1
      ? `A run released at ${pct(d.demandFactor)} of design is a stress test: anything that passes has headroom. But the queue it builds is partly self-inflicted, so read step 4 with that in mind.`
      : 'A run that releases less work than the design can\'t prove the design rates: stations that never fill up never show their capacity.');
  }

  // ---------------------------------------------------------------- step 4
  function renderKeptUp(body, r, ctx) {
    const a = r.analysis, k = a.kpis;
    const grid = div(body, 'step-grid wide-main');
    const left = div(grid, 'step-main'), right = div(grid, 'step-side');
    const labels = r.hours.map((h) => `h${h}`);
    const out = r.system.map((x) => x.openOut), inn = r.system.map((x) => x.openIn);
    const hasIn = inn.some((v) => v > 0);
    const pk = k.peakOpenOutHour - 1, last = out.length - 1;
    const v = div(left, 'viz-card');
    v.innerHTML = `<h4>${term('open tasks', 'Open tasks')} at the end of each hour</h4>`;
    const anns = [];
    if (out[pk] > 0) anns.push({ i: pk, value: out[pk], text: `Peak: ${fmt(out[pk])} waiting`, dx: pk > last / 2 ? -18 : 18, dy: -12, anchor: pk > last / 2 ? 'end' : 'start' });
    if (last !== pk) anns.push({ i: last, value: out[last], text: `${fmt(out[last])} left at the end`, dx: -16, dy: -30, anchor: 'end' });
    C.hourly(v, {
      labels, height: 260, tipTitle: (i) => `End of hour ${r.hours[i]}`,
      series: [
        { name: 'Outbound open', color: ctx.SERIES[0], type: 'line', values: out },
        ...(hasIn ? [{ name: 'Inbound open', color: ctx.SERIES[1], type: 'line', values: inn }] : []),
      ],
      annotations: anns,
      extraTip: (i) => [{ name: 'Completed this hour', value: fmt(r.system[i].finOut + r.system[i].finIn) }, { name: 'Released this hour', value: fmt(Math.max(0, a.flow[i].relOut) + Math.max(0, a.flow[i].relIn)) }],
    });
    howTo(left, [
      `Each point is the queue of unfinished work at the end of an hour. A <b>rising</b> line means more arrived than the system finished; a <b>falling</b> line means it was catching up.`,
      'A healthy result rises during a demand peak and comes back down. A line that keeps rising to the end means the system can\'t sustain that demand.',
    ]);

    const growing = r.system.filter((x, i) => x.openOut > (i ? r.system[i - 1].openOut : 0)).length;
    const lastRate = r.system[last].finOut;
    const clearMin = lastRate ? (k.endOpenOut / lastRate) * 60 : 0;
    const drained = k.endOpenOut < k.peakOpenOut * 0.25;
    const stat = (label, value, sub) => `<div class="stat"><span class="muted small">${label}</span><b>${value}</b>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>`;
    right.insertAdjacentHTML('beforeend', `<h4 class="side-h">The queue in numbers</h4>
      <div class="elim stats">
        ${stat('Hours the queue grew', `${growing} of ${out.length}`, growing ? `h1–h${pk + 1}` : '')}
        ${stat('Peak queue', fmt(k.peakOpenOut), `end of hour ${k.peakOpenOutHour}`)}
        ${stat('Left at the end', fmt(k.endOpenOut), clearMin ? `≈${fmt(clearMin)} min more at the final-hour rate` : 'fully cleared')}
        ${stat('Completed of released', pct(k.completionOut, 1), 'outbound')}
        ${hasIn ? stat('Inbound queue', k.endOpenIn ? `${fmt(k.endOpenIn)} left` : 'cleared', `peak ${fmt(k.peakOpenIn)} in hour ${k.peakOpenInHour}`) : ''}
      </div>
      <div class="elim"><div class="elim-head"><b>Verdict</b><span class="badge ${growing < 2 ? 'good' : drained ? 'warning' : 'critical'}">${growing < 2 ? '✓ Kept up' : drained ? '! Caught up later' : '✕ Fell behind'}</span></div>
        <p>${growing < 2 ? 'Completion tracked arrivals all run.' : drained ? `Arrivals outran completion for ${growing} hours, then the system worked the queue down. That pattern is a demand peak being absorbed, not a capacity shortfall.` : 'The queue was still large at the end: at this demand the system needs more capacity or a longer window.'}</p></div>`);
    why(body, 'Throughput alone hides delay. A queue of 10,000 tasks means orders waiting, possibly past cut-off times. Whether the queue drains decides if the design copes with the peak or just postpones it.');
  }

  // ---------------------------------------------------------------- step 6
  function renderStations(body, r, ctx) {
    const a = r.analysis, k = a.kpis;
    const grid = div(body, 'step-grid wide-main');
    const left = div(grid, 'step-main'), right = div(grid, 'step-side');
    const v = div(left, 'viz-card');
    v.innerHTML = `<h4>Every station's average rate, grouped by ${r.profile ? 'process' : 'station type'}</h4>`;
    C.strip(v, {
      types: a.types, ceiling: k.ceiling, color: ctx.SERIES[0], flagColor: 'var(--status-critical)',
      ceilingLabel: k.ceiling ? `If wait time were the only delay: ${fmt(k.ceiling)}/h` : '',
    });
    howTo(left, [
      'Each dot is one station, placed at the tote presentations it handled per hour on average. The short vertical line is the median of its group.',
      'Dots should sit in a tight cluster. A dot well to the left of its group (marked ▲) is a station doing less than its peers: check its configuration and order assignment.',
    ]);
    const H = r.hours.length;
    right.insertAdjacentHTML('beforeend', `<h4 class="side-h">Per ${r.profile ? 'process' : 'station type'}</h4>
      ${a.types.map((t) => {
        const ok = !t.outliers.length;
        const idle = t.lastActive && t.lastActive < H;
        return `<div class="elim"><div class="elim-head"><b>${ctx.esc(t.label)}</b><span class="badge ${ok ? 'good' : 'critical'}">${ok ? '✓ Consistent' : `✕ ${t.outliers.length} low`}</span></div>
          <div class="elim-metric">${fmt(t.median)}/h <span>median · ${t.count} station${t.count > 1 ? 's' : ''}</span></div>
          <p>${t.count > 1 ? `Range ${fmt(t.min)}–${fmt(t.max)}/h.` : 'Single station.'}${ok ? '' : ` ${t.outliers.map((s) => `<b>${ctx.esc(s.code)}</b> ${fmt(s.avgPerHour)}/h`).join(', ')}.`}${idle ? ` Finished its work in hour ${t.lastActive} and was idle afterwards.` : ''}${t.flat && !t.isLabor && t.count === 1 ? ' Its output is flat every hour: it handled all the work it was given.' : ''}</p></div>`;
      }).join('')}`);
    why(body, 'One misconfigured or under-fed station quietly lowers capacity, and it hides inside totals. Checking each station against its own group catches it before results go to the customer.');
  }

  // ---------------------------------------------------------------- step 7
  function renderMargin(body, r, ctx) {
    const mg = marginNumbers(r), d = r.analysis.design;
    if (!mg) {
      const b = div(body, 'coming');
      b.textContent = 'The stations never reached a shared ceiling in this run, so their capacity, and with it the margin, can\'t be measured. A run with more demand would show it.';
      return;
    }
    const grid = div(body, 'step-grid');
    const left = div(grid, 'step-main'), right = div(grid, 'step-side');
    const bars = [
      ...(mg.target ? [{ label: 'Design target', value: mg.target, cls: 'target', sub: d ? ctx.esc(d.profile.profileName || d.profile.name) : '' }] : []),
      { label: `Capacity with ${mg.stationsDesign} design stations`, value: mg.capDesign, cls: 'cap', sub: `${mg.stationsDesign} × ${fmt(mg.rate)}/h` },
      ...(mg.stationsSim !== mg.stationsDesign ? [{ label: `Capacity as simulated`, value: mg.capSim, cls: 'cap-sim', sub: `${mg.stationsSim} × ${fmt(mg.rate)}/h` }] : []),
      ...(mg.maxRate ? [{ label: 'Workstation max (theoretical)', value: mg.maxRate * mg.stationsDesign, cls: 'max', sub: `${mg.stationsDesign} × ${fmt(mg.maxRate)}/h` }] : []),
    ];
    const scale = Math.max(...bars.map((b) => b.value)) * 1.05;
    const v = div(left, 'viz-card');
    v.innerHTML = `<h4>${ctx.esc(mg.name)}: capacity vs target, tote presentations per hour</h4>
      <div class="cap-bars">${bars.map((b) => `<div class="cap-row ${b.cls}"><span class="cap-label">${b.label}<small>${b.sub}</small></span>
        <span class="cap-track"><span class="cap-fill" style="width:${(b.value / scale) * 100}%"></span>${mg.target && b.cls !== 'target' ? `<i class="cap-target" style="left:${(mg.target / scale) * 100}%"></i>` : ''}</span>
        <b class="cap-val">${fmt(b.value)}${mg.target && b.cls !== 'target' ? `<small>${pct(b.value / mg.target)}</small>` : ''}</b></div>`).join('')}</div>`;
    howTo(left, [
      `Capacity is the rate the stations actually sustained when they were full (${fmt(mg.rate)}/h each) multiplied by the number of stations. The black tick on each bar is the design target.`,
      'Read the second bar, the design\'s own station count: that is the margin the proposal really has. The simulated count can flatter it when the model has extra stations.',
    ]);
    const lever = (title, value, text) => `<div class="elim"><div class="elim-head"><b>${title}</b></div><div class="elim-metric">${value}</div><p>${text}</p></div>`;
    right.insertAdjacentHTML('beforeend', `<h4 class="side-h">Where the margin is</h4>
      ${mg.target ? lever('Stations needed', `${mg.stationsNeeded} <span>of ${mg.stationsDesign} designed</span>`, `At ${fmt(mg.rate)}/h per station, ${mg.stationsNeeded} stations cover ${fmt(mg.target)}/h, leaving ${mg.stationsDesign - mg.stationsNeeded} spare in the design.`) : ''}
      ${mg.cycleAllowed ? lever('Cycle time allowed', `${fmt(mg.cycleAllowed, 1)} s <span>vs ${fmt(mg.cycle, 1)} s simulated</span>`, `Each station can take up to ${fmt(mg.cycleAllowed - mg.cycle, 1)} s longer per tote and still meet the target with ${mg.stationsDesign} stations.`) : ''}
      ${mg.target ? lever('Demand growth absorbed', `${mg.capDesignPct >= 1 ? '+' : ''}${pct(mg.capDesignPct - 1)}`, mg.capDesignPct >= 1 ? `Demand can grow by about ${pct(mg.capDesignPct - 1)} before the ${mg.stationsDesign} stations are full.` : 'The designed stations can\'t reach the target at the simulated station rate.') : ''}
      ${d ? `<p class="muted small">${d.rows.filter((x) => !x.capacity && x.group).map((x) => ctx.esc(x.process.name)).join(', ') || 'Other processes'}: their stations never filled up, so this run doesn't measure their capacity.</p>` : ''}`);
    why(body, 'Margin is what protects the customer when volumes grow or operators slow down. Quote it with the design\'s station count, and say which lever moves it: stations or cycle time, not robots (step 5).');
  }

  // ---------------------------------------------------------------- step 8
  function renderSummary(body, r, ctx, ans) {
    const a = r.analysis, k = a.kpis, d = a.design;
    const plain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const mg = marginNumbers(r);
    const lim = limitAnswer(r);
    const para = [];
    para.push(`${r.label}: ${fmt(r.durationH, 1)}-hour simulation${d ? `, checked against the ${d.profile.profileName || d.profile.name} design inputs` : ''}. ${d ? `Work was released at about ${pct(d.demandFactor)} of the design demand.` : ''}`);
    if (d) para.push(`Design targets: ${k.designPass} of ${k.designTotal} met. ${d.rows.map((x) => `${x.process.name} ${fmt(x.actual)}/h vs ${fmt(x.process.target)}/h (${pct(x.pct)})`).join('; ')}.`);
    const grew = r.system.filter((x, i) => x.openOut > (i ? r.system[i - 1].openOut : 0)).length;
    const flowLine = grew < 2 ? 'Completion kept pace with arriving work throughout the run.'
      : k.endOpenOut < k.peakOpenOut * 0.25
        ? `During the demand peak, open work built up to ${fmt(k.peakOpenOut)} tasks by hour ${k.peakOpenOutHour} and was worked down to ${fmt(k.endOpenOut)} by the end of the run.`
        : `Open work built up to ${fmt(k.peakOpenOut)} tasks and ${fmt(k.endOpenOut)} were still open at the end of the run.`;
    para.push(`The system completed ${fmt(k.total)} tote presentations (${fmt(k.perHour)}/h on average). ${flowLine}`);
    if (a.labor && a.labor.plateau) para.push(`Throughput is limited by the ${a.labor.label.toLowerCase()} stations (about ${fmt(a.labor.steadyMedian)} tote presentations per station per hour), not by the robots (≈${fmt(k.robotFleet)} robots at ${fmt(k.robotRate, 1)} per robot per hour) or charging (${fmt(k.chargerMean)}% average utilization).`);
    else para.push(plain(lim.text));
    if (mg && mg.target) para.push(`With the design's ${mg.stationsDesign} ${mg.name.toLowerCase()} stations, capacity is about ${fmt(mg.capDesign)}/h, ${pct(mg.capDesignPct)} of the ${fmt(mg.target)}/h target, so demand can grow by about ${pct(Math.max(0, mg.capDesignPct - 1))} before the stations are full.`);
    const asks = runChecks(r, ctx).checks.filter((c) => c.ask).map((c) => c.ask);

    const grid = div(body, 'step-grid');
    const left = div(grid, 'step-main'), right = div(grid, 'step-side');
    const cs = div(left, 'viz-card summary-card');
    cs.innerHTML = `<div class="summary-head"><h4>Summary for the customer</h4><button class="btn small primary" type="button" data-copy="customer">Copy text</button></div>
      ${para.map((p) => `<p>${ctx.esc(p)}</p>`).join('')}`;
    howTo(left, [
      'Generated from steps 1–7. Copy it into an email or report and edit as needed: check the wording against your proposal before sending.',
    ]);
    const steps = STEPS.slice(0, -1).map((s, i) => `<li><a href="#step-${s.id}"><span class="dot ${ans[s.id].level}">${i + 1}</span><span><b>${s.q}</b><span class="muted small">${plain(ans[s.id].text)}</span></span></a></li>`).join('');
    right.insertAdjacentHTML('beforeend', `<div class="checklist step-recap"><h4>The walkthrough at a glance</h4><ol>${steps}</ol></div>
      ${asks.length ? `<div class="ask-box"><h4>Settle internally before sending</h4><ol>${asks.map((q) => `<li>${ctx.esc(q)}</li>`).join('')}</ol><button class="btn small" type="button" data-copy="internal">Copy questions</button></div>` : ''}`);
    const texts = {
      customer: para.join('\n\n'),
      internal: `Open points on ${r.label} (${r.reportCode}):\n` + asks.map((q, i) => `${i + 1}. ${q}`).join('\n'),
    };
    body.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      const old = b.textContent;
      try { await navigator.clipboard.writeText(texts[b.dataset.copy]); b.textContent = 'Copied ✓'; } catch (_) { b.textContent = 'Copy failed'; }
      setTimeout(() => (b.textContent = old), 2000);
    }));
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
      ch.innerHTML = `<div class="eyebrow">Step ${i + 1} of ${STEPS.length}</div>
        <h2 class="question">${s.q}</h2>
        <p class="answer ${ans[s.id].level}"><span class="badge ${ans[s.id].level}">${ctx.statusIcon(ans[s.id].level)} ${ctx.levelLabel(ans[s.id].level)}</span><span>${ans[s.id].text}</span></p>`;
      main.appendChild(ch);
      const body = div(ch, 'chapter-body');
      const renderers = {
        run: renderRun, met: renderMet, pushed: renderPushed, keptup: renderKeptUp,
        limit: renderLimit, stations: renderStations, margin: renderMargin, summary: renderSummary,
      };
      try { renderers[s.id](body, r, ctx, ans); } catch (e) {
        body.innerHTML = `<div class="coming">This step couldn't be drawn for this report (${ctx.esc(e.message)}). The details are in the full dashboard.
          <button class="btn small" type="button" data-goto="${s.dash || 's-findings'}">Open in full dashboard →</button></div>`;
        console.error(e);
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
