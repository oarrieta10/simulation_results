/* Design profiles: the contractual workstation targets a simulation is checked against.
   Add a project by copying an entry. Field meanings:
     stationType  which report station type can serve this process (CONVEYOR / LABOR)
     target       total design throughput for the process, tote presentations per hour
     stations     number of workstations in the design
     wait         PAT wait time per presentation, seconds (0 = none)
     main         the high-volume process. Unmatched stations of its type default to it.
   `match` lets the tool pick a profile automatically from the file name.

   Real project profiles usually contain confidential proposal figures. Put them in
   src/profiles.local.js (git-ignored) as `window.SIMRES_LOCAL_PROFILES = [ ... ]`; they are
   added to the list below. `example: true` profiles are never auto-selected. */
(function (global) {
  'use strict';

  const EXAMPLE = {
    id: 'example',
    example: true,
    name: 'Example project (illustrative)',
    source: 'Illustrative numbers only. Copy this entry into src/profiles.local.js and replace it with your proposal\'s workstation table',
    processes: [
      { id: 'putaway', name: 'Tote putaway', stationType: 'CONVEYOR', cycle: 'Single', target: 400, stations: 2, wait: 0 },
      { id: 'audit', name: 'Inventory audit', stationType: 'LABOR', cycle: 'Double', target: 40, stations: 1, wait: 30 },
      { id: 'picking', name: 'Picking', stationType: 'LABOR', cycle: 'Double', target: 4000, stations: 20, wait: 10, main: true },
    ],
  };

  const PROFILES = [...(global.SIMRES_LOCAL_PROFILES || []), EXAMPLE];

  const typeKey = (t) => String(t || '').replace(/_STATION$/i, '').toUpperCase();

  // Choose the profile whose station counts best fit the report. The file name breaks ties.
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
        for (let n = 0; n < p.stations && si < slow.length; n++) roles[slow[si++].code] = p.id;
      });
      list.forEach((s) => { if (!roles[s.code]) roles[s.code] = main.id; });
    });
    return roles;
  }

  global.SimProfiles = { PROFILES, suggest, assignRoles, get: (id) => PROFILES.find((p) => p.id === id) || null };
})(window);
