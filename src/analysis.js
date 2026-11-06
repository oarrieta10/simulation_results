/* Analysis: derives KPIs, flow balance, station health and plain-language findings
   from a parsed model. Every derived number documents how it was computed. */
(function (global) {
  'use strict';

  const OUTLIER_RATIO = 0.85; // station below 85% of its type median = underperformer
  const PLATEAU_TOL = 0.02; // non-outlier stations within ±2% of each other = plateau
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  const argmax = (a) => a.reduce((bi, v, i) => (v > a[bi] ? i : bi), 0);
  const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
  const pct = (n, d = 0) => `${fmt(n * 100, d)}%`;

  function prettyType(t) {
    return String(t || '')
      .replace(/_STATION$/, '')
      .toLowerCase()
      .replace(/(^|_)(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
  }

  function analyze(m) {
    const sys = m.system;
    const H = m.hours.length;
    const totals = sys.map((r) => r.finIn + r.finOut);
    const sumIn = sum(sys.map((r) => r.finIn));
    const sumOut = sum(sys.map((r) => r.finOut));
    const total = sumIn + sumOut;
    const perHour = m.durationH ? total / m.durationH : 0;
    const peakIdx = argmax(totals);

    // Flow balance: tasks released into the system in hour h is inferred as
    // completed(h) + open(h) - open(h-1), with open(0) = 0.
    let pIn = 0, pOut = 0;
    const flow = sys.map((r) => {
      const o = { h: r.h, relIn: r.finIn + r.openIn - pIn, relOut: r.finOut + r.openOut - pOut };
      pIn = r.openIn; pOut = r.openOut;
      return o;
    });
    const releasedIn = sumIn + (sys.at(-1)?.openIn || 0);
    const releasedOut = sumOut + (sys.at(-1)?.openOut || 0);

    const openOut = sys.map((r) => r.openOut);
    const openIn = sys.map((r) => r.openIn);
    const peakOpenOutIdx = argmax(openOut);
    const peakOpenInIdx = argmax(openIn);
    const endOpenOut = openOut.at(-1) || 0;
    const endOpenIn = openIn.at(-1) || 0;
    const lastOut = sys.at(-1)?.finOut || 0;
    const lastIn = sys.at(-1)?.finIn || 0;
    // Hours in which open work grew (release outpaced completion).
    const growingOutHours = sys.filter((r, i) => r.openOut > (i ? sys[i - 1].openOut : 0)).map((r) => r.h);

    // ---- Stations ----
    // Stations are grouped by design process when a profile assigns roles, else by station type.
    const profile = m.profile || null;
    const roles = (profile && m.roles) || {};
    const procOf = (code) => profile && profile.processes.find((p) => p.id === roles[code]);
    const groupOf = {};
    const byType = {};
    m.stations.forEach((s) => {
      const key = procOf(s.code) ? roles[s.code] : s.type;
      groupOf[s.code] = key;
      (byType[key] = byType[key] || []).push(s);
    });
    const order = (k) => { const i = profile ? profile.processes.findIndex((p) => p.id === k) : -1; return i < 0 ? 99 : i; };
    const types = Object.entries(byType).sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0])).map(([type, list]) => {
      const avgs = list.map((s) => s.avgPerHour);
      const med = median(avgs);
      const outliers = list.filter((s) => s.avgPerHour < med * OUTLIER_RATIO);
      const healthy = list.filter((s) => !outliers.includes(s));
      // Steady hours: drop first & last hour and hours where the station did nothing.
      const steadyVals = healthy.flatMap((s) => s.hourly.filter((v, i) => i > 0 && i < H - 1 && v > 0));
      const steadyMed = median(steadyVals);
      const spread = steadyVals.length ? (Math.max(...steadyVals) - Math.min(...steadyVals)) / steadyMed : 0;
      const plateau = steadyVals.length >= 4 && spread <= PLATEAU_TOL * 2;
      const process = profile ? profile.processes.find((p) => p.id === type) || null : null;
      const isLabor = process ? !!process.main && /LABOR/i.test(process.stationType) : !profile && /LABOR|MANUAL|PICK/i.test(type);
      const isInbound = list.every((s) => /CONVEYOR/i.test(s.type));
      const activeHours = list.map((s) => s.hourly.filter((v) => v > 0).length);
      const lastActive = Math.max(0, ...list.map((s) => s.hourly.reduce((li, v, i) => (v > 0 ? i + 1 : li), 0)));
      // Flat output while no other limit applies = the station did all the work it was given.
      const hourlyTot = m.hours.map((_, i) => sum(list.map((s) => s.hourly[i])));
      const mid = hourlyTot.filter((v, i) => i > 0 && i < H - 1 && v > 0);
      const flat = mid.length >= 3 && (Math.max(...mid) - Math.min(...mid)) / (median(mid) || 1) <= 0.03;
      return {
        type, label: process ? process.name : prettyType(type), process, list, count: list.length, median: med, steadyMedian: steadyMed,
        min: Math.min(...avgs), max: Math.max(...avgs), total: sum(list.map((s) => s.total)),
        outliers, plateau, spread, isLabor, isInbound, activeHours, lastActive, flat, hourlyTot,
      };
    });

    // Reference rate for the main stations. Preferred: the design theoretical cycle (wait + switch
    // from the design inputs). Fallback: the report's "manual one box operation time" parameter.
    const labor = types.find((t) => t.isLabor);
    const reportOpTime = m.params.outboundOpTime || m.params.inboundOpTime || 0;
    const lp = (labor && labor.process) || {};
    const theoCycle = lp.wait && lp.switch ? lp.wait + lp.switch : 0;
    const opTime = theoCycle || reportOpTime || lp.wait || 0;
    const ceilingSource = theoCycle ? 'design' : opTime ? 'report' : '';
    const ceiling = opTime ? 3600 / opTime : 0;
    const laborCycle = labor && labor.steadyMedian ? 3600 / labor.steadyMedian : 0;

    // ---- Robots ----
    const robots = m.robots.map((r) => {
      const fleetEst = median(r.perHour.map((v, i) => (v > 0 ? totals[i] / v : NaN)).filter(Number.isFinite));
      const active = r.perHour.filter((v) => v > 0);
      return { ...r, fleetEst: Math.round(fleetEst), mean: mean(active), peak: Math.max(0, ...r.perHour), peakHour: argmax(r.perHour) + 1 };
    });

    // ---- Chargers ----
    const chargers = Object.entries(m.chargers).map(([type, vals]) => ({
      type, vals, mean: mean(vals), peak: Math.max(0, ...vals), peakHour: argmax(vals) + 1,
    }));

    const kpis = {
      total, sumIn, sumOut, perHour,
      peakHour: peakIdx + 1, peakThroughput: totals[peakIdx] || 0,
      steadyThroughput: median(totals.filter((v, i) => i > 0 && i < H - 1)),
      peakOpenOut: openOut[peakOpenOutIdx] || 0, peakOpenOutHour: peakOpenOutIdx + 1,
      peakOpenIn: openIn[peakOpenInIdx] || 0, peakOpenInHour: peakOpenInIdx + 1,
      endOpenOut, endOpenIn, releasedIn, releasedOut,
      completionOut: releasedOut ? sumOut / releasedOut : 1,
      completionIn: releasedIn ? sumIn / releasedIn : 1,
      stations: m.stations.length,
      laborMedian: labor ? labor.median : 0,
      laborSteady: labor ? labor.steadyMedian : 0,
      laborCycle, ceiling, ceilingSource, theoCycle, ceilingUse: ceiling && labor ? labor.steadyMedian / ceiling : 0,
      robotFleet: sum(robots.map((r) => r.fleetEst || 0)),
      robotRate: robots[0] ? robots[0].runAvg || robots[0].mean : 0,
      chargerMean: chargers.length ? mean(chargers.map((c) => c.mean)) : 0,
      chargerPeak: chargers.length ? Math.max(...chargers.map((c) => c.peak)) : 0,
    };

    const design = profile ? evaluateDesign(m, profile, types, { endOpenOut, endOpenIn, reportOpTime }) : null;
    if (design) {
      kpis.designPass = design.rows.filter((r) => r.status === 'pass').length;
      kpis.designTotal = design.rows.length;
      const mainRow = design.rows.find((r) => r.process.main) || design.rows[0];
      kpis.mainPctTarget = mainRow ? mainRow.pct : 0;
    }
    const findings = buildFindings(m, { kpis, types, labor, robots, chargers, growingOutHours, lastOut, lastIn, opTime, design });
    return { totals, flow, types, groupOf, robots, chargers, kpis, findings, labor, opTime, reportOpTime, ceilingSource, theoCycle, design, profile };
  }

  /* Target vs actual per design process.
     actual   = tote presentations the process's stations completed ÷ simulated hours
     demand   = actual + open work at the end. The run's open outbound / inbound tasks are
                attributed to the main outbound process / the inbound process.
     capacity = stations × steady-state rate, but only when the stations plateaued (saturated).
     status   = pass when actual ≥ target; otherwise "demand-limited" if the stations still had
                spare capacity (the simulation didn't release enough work to prove the rate),
                or fail when they were saturated below target. */
  function evaluateDesign(m, profile, groups, ctx) {
    const rows = profile.processes.map((p) => {
      const g = groups.find((x) => x.type === p.id);
      const total = g ? g.total : 0;
      const actual = m.durationH ? total / m.durationH : 0;
      let openEnd = 0;
      if (p.main) openEnd = ctx.endOpenOut;
      else if (/CONVEYOR/i.test(p.stationType)) openEnd = ctx.endOpenIn;
      const demand = m.durationH ? (total + openEnd) / m.durationH : 0;
      // Saturated = stations hit a shared ceiling while work was still waiting for them.
      const saturated = !!(g && g.plateau && (openEnd > 0 || p.main));
      const capacity = saturated ? g.steadyMedian * g.count : 0;
      const pct = p.target ? actual / p.target : 0;
      let status = 'pass';
      if (!g) status = 'missing';
      else if (pct < 0.995) status = saturated ? 'fail' : 'demand';
      return {
        process: p, group: g, stationsSim: g ? g.count : 0, stationsDesign: p.stations, total, actual, demand,
        demandPct: p.target ? demand / p.target : 0, pct, capacity, capacityPct: capacity && p.target ? capacity / p.target : 0,
        perStationTarget: p.stations ? p.target / p.stations : 0, perStationActual: g && g.count ? actual / g.count : 0,
        cycle: saturated && g.steadyMedian ? 3600 / g.steadyMedian : 0, flat: g ? g.flat : false, status,
      };
    });
    const unassigned = groups.filter((g) => !g.process);
    const factors = rows.filter((r) => r.group && r.process.target).map((r) => r.demandPct);
    return { profile, rows, unassigned, demandFactor: median(factors), reportOpTime: ctx.reportOpTime };
  }

  function buildFindings(m, a) {
    const k = a.kpis;
    const f = [];
    const H = m.hours.length;

    f.push({
      level: 'info', title: 'Throughput',
      text: `Completed <b>${fmt(k.total)}</b> tote presentations in ${fmt(m.durationH, 1)} h — <b>${fmt(k.perHour)}/h</b> on average (${k.sumIn ? `${fmt(k.sumOut)} outbound, ${fmt(k.sumIn)} inbound` : 'all outbound; this run has no inbound work'}). Steady-state hours ran at ~${fmt(k.steadyThroughput)}/h; peak was hour ${k.peakHour} at ${fmt(k.peakThroughput)}.`,
    });

    if (a.growingOutHours.length >= 2) {
      const drained = k.endOpenOut < k.peakOpenOut * 0.25;
      const clearMin = a.lastOut ? (k.endOpenOut / a.lastOut) * 60 : 0;
      f.push({
        level: drained ? 'warning' : 'critical', title: 'Outbound demand exceeded capacity',
        text: `Open outbound tasks grew in ${a.growingOutHours.length} of ${H} hours (h${a.growingOutHours[0]}–h${a.growingOutHours.at(-1)}), peaking at <b>${fmt(k.peakOpenOut)}</b> in hour ${k.peakOpenOutHour}. ` +
          (drained
            ? `The queue drained to ${fmt(k.endOpenOut)} by the end of the run (≈${fmt(clearMin)} min more at the final-hour rate).`
            : `<b>${fmt(k.endOpenOut)}</b> tasks were still open at the end — the system did not catch up within the run.`),
      });
    } else if (k.endOpenOut === 0 && k.sumOut) {
      f.push({ level: 'good', title: 'Outbound kept pace', text: 'Open outbound work never built up — completion tracked release throughout the run.' });
    }

    if (a.design) designFindings(m, a, f);

    if (k.peakOpenIn > 0) {
      f.push({
        level: k.endOpenIn ? 'warning' : 'good', title: 'Inbound',
        text: `Inbound open tasks peaked at ${fmt(k.peakOpenIn)} (hour ${k.peakOpenInHour}) and ${k.endOpenIn ? `ended at <b>${fmt(k.endOpenIn)}</b>` : 'fully cleared'}.` +
          (() => { const inTypes = a.types.filter((t) => t.isInbound && t.lastActive && t.lastActive < H); return inTypes.length ? ` ${inTypes.map((t) => `${t.label} stations`).join(', ')} finished their work in hour ${inTypes[0].lastActive} and sat idle afterwards.` : ''; })(),
      });
    }

    if (a.labor && a.labor.plateau) {
      const P = a.labor.process || {};
      const dCyc = k.theoCycle ? k.laborCycle - k.theoCycle : 0;
      f.push({
        level: 'warning', title: `${a.labor.label} stations are the binding constraint`,
        text: `Healthy ${a.labor.label.toLowerCase()} stations plateaued at <b>${fmt(a.labor.steadyMedian)} tote presentations/h</b> (±${pct(a.labor.spread / 2, 1)}) while outbound work was queued — a flat ceiling means station processing, not robot supply, limits throughput.` +
          (k.theoCycle
            ? ` That is a simulated cycle of <b>${fmt(k.laborCycle, 1)} s per tote</b> against the design's theoretical ${fmt(k.theoCycle, 1)} s (${fmt(P.wait)} s wait + ${fmt(P.switch)} s switch)${Math.abs(dCyc) >= 0.3 ? `: <b>${dCyc > 0 ? '+' : '−'}${fmt(Math.abs(dCyc), 1)} s</b>, so ${fmt(k.ceilingUse * 100)}% of the theoretical ${fmt(k.ceiling)}/h` : ', as designed'}.`
            : k.ceiling ? ` That is a simulated cycle of <b>${fmt(k.laborCycle, 1)} s per tote</b>; the report's handling-time parameter is ${fmt(a.opTime)} s.` : ''),
      });
    }

    a.types.forEach((t) => {
      if (!t.outliers.length) return;
      const items = t.outliers
        .sort((x, y) => x.avgPerHour - y.avgPerHour)
        .map((s) => `<b>${s.code}</b> ${fmt(s.avgPerHour)}/h (${pct(1 - s.avgPerHour / t.median)} below)`)
        .join(', ');
      f.push({
        level: 'critical', title: `${t.outliers.length} underperforming ${t.label.toLowerCase()} station${t.outliers.length > 1 ? 's' : ''}`,
        text: `${items} vs a median of ${fmt(t.median)}/h. Their hourly output is flat, which points to an assignment or configuration cap rather than congestion — worth checking order allocation and station settings.`,
      });
    });

    a.robots.forEach((r) => {
      f.push({
        level: 'info', title: `${r.type} robots`,
        text: `≈<b>${fmt(r.fleetEst)}</b> robots (inferred from throughput ÷ per-robot rate) averaged <b>${fmt(r.runAvg || r.mean, 1)}</b> tote presentations/robot/h; best hour ${r.peakHour} at ${fmt(r.peak, 2)}.`,
      });
    });

    a.chargers.forEach((c) => {
      const lvl = c.peak >= 85 ? 'critical' : c.peak >= 70 ? 'warning' : 'good';
      f.push({
        level: lvl, title: `Charging (${c.type})`,
        text: `Charger utilization averaged ${fmt(c.mean)}% (peak ${fmt(c.peak)}% in hour ${c.peakHour}). ${lvl === 'good' ? 'Plenty of headroom — charging is not a constraint.' : 'Approaching saturation — robots may queue for chargers.'}`,
      });
    });
    return f;
  }

  function designFindings(m, a, f) {
    const d = a.design;
    const pass = d.rows.filter((r) => r.status === 'pass');
    const fail = d.rows.filter((r) => r.status === 'fail' || r.status === 'missing');
    const dem = d.rows.filter((r) => r.status === 'demand');
    f.push({
      level: fail.length ? 'critical' : dem.length ? 'warning' : 'good',
      title: `Design targets: ${pass.length} of ${d.rows.length} met`,
      text: d.rows.map((r) => `${r.process.name} <b>${fmt(r.actual)}/h</b> vs ${fmt(r.process.target)}/h (${pct(r.pct)})`).join(' · ') +
        `. Checked against ${d.profile.source}.` +
        (fail.length ? ` <b>Below target while saturated:</b> ${fail.map((r) => r.process.name).join(', ')}.` : '') +
        (dem.length ? ` ${dem.map((r) => r.process.name).join(', ')} fell short because the simulation released less work than the target, not because the stations were full. Those rates aren't proven by this run.` : ''),
    });
    if (d.demandFactor && Math.abs(d.demandFactor - 1) > 0.05) {
      f.push({
        level: 'info', title: `Simulated demand ≈ ${pct(d.demandFactor)} of design`,
        text: `Work released per process (completed + still open) ran at a median ${pct(d.demandFactor)} of the design rate: ${d.rows.filter((r) => r.group).map((r) => `${r.process.name} ${pct(r.demandPct)}`).join(', ')}. ${d.demandFactor > 1 ? 'The run includes a demand margin over the design values, so a pass here carries headroom.' : 'The run under-loads the design, so it cannot prove the targets.'}`,
      });
    }
    const mismatch = d.rows.filter((r) => r.group && r.stationsSim !== r.stationsDesign);
    if (mismatch.length) {
      f.push({
        level: 'warning', title: 'Station counts differ from the design',
        text: mismatch.map((r) => `${r.process.name}: <b>${r.stationsSim}</b> in the simulation vs ${r.stationsDesign} in the design`).join('; ') +
          '. Check the role assignment under Design targets, or confirm the simulated layout.',
      });
    }
    if (d.unassigned.length) {
      f.push({ level: 'warning', title: 'Stations without a design role', text: `${d.unassigned.map((g) => `${g.count} ${g.label.toLowerCase()}`).join(', ')} station(s) aren't covered by ${d.profile.name}.` });
    }
  }

  global.SimAnalysis = { analyze, fmt, pct, median, sum, prettyType };
})(window);
