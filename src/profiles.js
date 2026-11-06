/* Design profiles: the design throughput a simulation is checked against.

   The normal source is a **design inputs** JSON exported from the Customer Success Tool
   (workstationTypes + requirements + scenarios). Importing one creates a profile per
   scenario profile (e.g. "Average", "Peak"); the app remembers imports in the browser.

   Profile shape (what fromDesignInputs produces, and what src/profiles.local.js may hold):
     { id, name, source, match: RegExp, processes: [{
         id, name, direction, stationType: 'CONVEYOR'|'LABOR', cycle: 'Single'|'Double',
         target       total design throughput, tote presentations per hour
         stations     number of workstations
         stationRate  design rate per workstation (workstationFlowTPH)
         maxRate      absolute max rate of the workstation type (absoluteMaxTPH)
         wait         PAT wait time per presentation, seconds (0 = unknown)
         main         the high-volume process; unmatched stations of its type default to it
         note         workstation type name
         inputs       the raw sizing inputs (effective hours, lines/order …) for display
     }] }
   `example: true` profiles are never auto-selected. */
(function (global) {
  'use strict';

  const EXAMPLE = {
    id: 'example',
    example: true,
    name: 'Example project (illustrative)',
    source: 'Illustrative numbers only. Import a design inputs JSON to check a run against your project',
    processes: [
      { id: 'putaway', name: 'Tote putaway', stationType: 'CONVEYOR', cycle: 'Single', target: 400, stations: 2, wait: 0 },
      { id: 'audit', name: 'Inventory audit', stationType: 'LABOR', cycle: 'Double', target: 40, stations: 1, wait: 30 },
      { id: 'picking', name: 'Picking', stationType: 'LABOR', cycle: 'Double', target: 4000, stations: 20, wait: 10, main: true },
    ],
  };

  // Imported profiles first, then optional hand-written local ones, then the example.
  const PROFILES = [...(global.SIMRES_LOCAL_PROFILES || []), EXAMPLE];

  const typeKey = (t) => String(t || '').replace(/_STATION$/i, '').toUpperCase();
  const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
  const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cap = (s) => (s ? String(s)[0].toUpperCase() + String(s).slice(1) : '');

  // ---------------------------------------------------------------- design inputs
  function isDesignInputs(json) {
    return !!(json && typeof json === 'object' && !Array.isArray(json)
      && Array.isArray(json.workstationTypes) && Array.isArray(json.requirements) && Array.isArray(json.scenarios));
  }

  /* One profile per scenario profile. Flows with no demand in that profile are left out
     (e.g. a Peak profile that only runs picking keeps its putaway stations at 0 demand). */
  function fromDesignInputs(json, fileName) {
    const types = Object.fromEntries(json.workstationTypes.map((w) => [w.id, w]));
    const stem = String(fileName || 'Design inputs').replace(/\.json$/i, '');
    const exported = json.exportedAt ? String(json.exportedAt).slice(0, 10) : '';
    const out = [];
    json.scenarios.forEach((sc) => {
      (sc.profiles || []).forEach((pf) => {
        const flows = (pf.data && pf.data.flows) || {};
        const processes = json.requirements.map((req) => {
          const f = flows[req.id] || {};
          const wt = types[req.workstationTypeId] || {};
          const target = num(f.demand), stations = num(f.workstationCount);
          if (!target) return null;
          const conveyor = /conveyor|docking/i.test(wt.name || '') || req.direction === 'inbound';
          return {
            id: req.id, name: req.name, direction: req.direction || '',
            stationType: conveyor ? 'CONVEYOR' : 'LABOR',
            cycle: cap(wt.cycleType) || '–',
            target, stations,
            stationRate: num(f.workstationFlowTPH), maxRate: num(wt.absoluteMaxTPH),
            wait: num(f.waitTime || f.waitTimeSec || 0),
            switch: num(f.switchTime || f.switchTimeSec || 0),
            note: wt.name || '',
            inputs: {
              effectiveHours: num(f.effectiveHours), hitRate: num(f.hitRate), linesPerOrder: num(f.linesPerOrder),
              unitsPerLine: num(f.unitsPerLine), unitsPerCase: num(f.unitsPerCase), totesPerCase: num(f.totesPerCase),
            },
            // How the simulation should be set up for this flow (shown for checking the run).
            sim: {
              hours: num(f.simulationHours), releaseMethod: f.taskReleaseMethod || '',
              ordersPerBatch: num(f.ordersPerBatch), tasksPerOrder: num(f.tasksPerOrder), batchesInRotation: num(f.batchesInRotation),
              tasksPerRelease: num(f.tasksPerRelease),
              interval: f.taskIntervalValue ? `${f.taskIntervalValue} ${f.taskIntervalUnit || ''}`.trim() : '',
              zones: f.zoneDistribution || '',
            },
          };
        }).filter(Boolean);
        if (!processes.length) return;
        const main = [...processes].sort((a, b) => b.target - a.target)[0];
        main.main = true;
        out.push({
          id: `di:${stem}:${sc.id}:${pf.id}`,
          imported: true,
          name: `${stem} · ${pf.name}`,
          profileName: pf.name,
          scenarioName: sc.name || '',
          source: `${/\.json$/i.test(String(fileName)) ? fileName : stem}: ${sc.name ? `${sc.name} → ` : ''}${pf.name}${json.tool ? ` (${json.tool}${exported ? `, exported ${exported}` : ''})` : ''}`,
          match: new RegExp(`(^|[^a-z])${escRe(pf.name)}([^a-z]|$)`, 'i'),
          ratePph: num(pf.calculatedRatePph),
          processes,
        });
      });
    });
    return out;
  }

  // Add (or replace) profiles; imported ones go to the front of the list.
  function register(list) {
    list.forEach((p) => {
      const i = PROFILES.findIndex((x) => x.id === p.id);
      if (i >= 0) PROFILES.splice(i, 1);
    });
    PROFILES.unshift(...list);
  }
  function unregister(prefix) {
    for (let i = PROFILES.length - 1; i >= 0; i--) if (String(PROFILES[i].id).startsWith(prefix)) PROFILES.splice(i, 1);
  }

  // ---------------------------------------------------------------- matching
  // Choose the profile whose station counts best fit the report. The file name breaks ties,
  // and imported design inputs win over hand-written profiles.
  function suggest(m) {
    let best = null;
    PROFILES.filter((p) => !p.example).forEach((p) => {
      const need = {};
      p.processes.forEach((pr) => (need[pr.stationType] = (need[pr.stationType] || 0) + pr.stations));
      const have = {};
      m.stations.forEach((s) => (have[typeKey(s.type)] = (have[typeKey(s.type)] || 0) + 1));
      let score = 0;
      new Set([...Object.keys(need), ...Object.keys(have)]).forEach((k) => (score += Math.abs((need[k] || 0) - (have[k] || 0))));
      if (p.match && p.match.test(m.fileName)) score -= 3;
      if (p.imported) score -= 0.5;
      if (!best || score < best.score) best = { p, score };
    });
    return best ? best.p : null;
  }

  /* Assign every station to a process.
     - Each station type goes to the processes that declare it.
     - Within a type, the non-main processes take the lowest-throughput stations that are
       clearly below the type's median (they're demand-limited side processes). These are
       paired in order: the smallest target gets the slowest station.
     - Every other station of that type goes to the main process (or the only process). */
  function assignRoles(m, profile) {
    const roles = {};
    if (!profile) return roles;
    const byType = {};
    m.stations.forEach((s) => (byType[typeKey(s.type)] = byType[typeKey(s.type)] || []).push(s));
    Object.entries(byType).forEach(([t, list]) => {
      const procs = profile.processes.filter((p) => typeKey(p.stationType) === t);
      if (!procs.length) return;
      const main = procs.find((p) => p.main) || [...procs].sort((a, b) => b.target - a.target)[0];
      const side = procs.filter((p) => p !== main).sort((a, b) => a.target - b.target);
      const avgs = list.map((s) => s.avgPerHour).sort((a, b) => a - b);
      const med = avgs[avgs.length >> 1] || 0;
      const slow = list.filter((s) => s.avgPerHour < med * 0.85).sort((a, b) => a.avgPerHour - b.avgPerHour);
      let si = 0;
      side.forEach((p) => {
        for (let n = 0; n < Math.max(1, p.stations) && si < slow.length; n++) roles[slow[si++].code] = p.id;
      });
      list.forEach((s) => { if (!roles[s.code]) roles[s.code] = main.id; });
    });
    return roles;
  }

  global.SimProfiles = {
    PROFILES, suggest, assignRoles, isDesignInputs, fromDesignInputs, register, unregister,
    get: (id) => PROFILES.find((p) => p.id === id) || null,
  };
})(window);
