/* Parser: turns a DP Simulation Report export (raw HTML, extracted JSON, or the
   sample bundle) into a clean, typed model. No analysis here - see analysis.js. */
(function (global) {
  'use strict';

  const MARKER = 'window.__STATIC_REPORT_DATA__=';

  // Report datasets are found by key pattern so sibling templates (SM_*, HPS3_*) still load.
  const DATASETS = {
    system: /SystemEfficiency|inboundOutboundEfficiency/i,
    chargers: /charger.*Percent/i,
    stationHourly: /stationMoveEfficiency/i,
    stationAvg: /BoxMovementPerStation/i,
    robots: /BoxMovementPerVehicle/i,
  };

  const QUERY_NAMES = {
    '工作站平均每小时处理箱数': 'Average tote presentations per station per hour',
    '每小时每台机器人平均搬箱数': 'Average tote presentations moved per robot per hour',
    '充电桩利用趋势图': 'Charger utilization trend',
    '分小时统计工作站处理箱数': 'Tote presentations handled per station, by hour',
    '整仓效率': 'Whole-warehouse throughput & open tasks',
  };

  const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

  function extractFromHtml(text) {
    const i = text.indexOf(MARKER);
    if (i < 0) throw new Error('No embedded simulation data found. Expected a DP Simulation Report HTML export.');
    const start = i + MARKER.length;
    const end = text.indexOf('</script>', start);
    let json = text.slice(start, end < 0 ? undefined : end).trim();
    if (json.endsWith(';')) json = json.slice(0, -1);
    return JSON.parse(json);
  }

  function parseText(text, fileName) {
    const trimmed = text.trimStart();
    let raw;
    if (trimmed[0] === '{' || trimmed[0] === '[') raw = JSON.parse(trimmed);
    else raw = extractFromHtml(text);
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((r, i) => normalize(r, list.length > 1 ? `${fileName} #${i + 1}` : fileName));
  }

  function findKey(result, re) {
    return Object.keys(result).find((k) => re.test(k));
  }

  function parseTz(tz) {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz || '');
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  }

  // "Site_Peak_V01.html" -> "Site · Peak · V01"
  function labelFromFile(name) {
    return String(name || 'Report')
      .replace(/\.(html?|json)$/i, '')
      .split(/[_]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' · ');
  }

  function translateName(name) {
    return String(name || '')
      .replace(/灰盒报告/g, ' Gray-box report ')
      .replace(/[-－]?新$/, ' (new)')
      .replace(/（/g, '(').replace(/）/g, ')')
      .replace(/\s+/g, ' ')
      .replace(/\s+([)(\-])/g, ' $1')
      .trim();
  }

  function normalize(raw, fileName) {
    fileName = raw.__fileName || fileName || 'report';
    const result = raw.result || {};
    const p = raw.parameters || {};
    const t1 = num(p.create_time_1);
    const t2 = num(p.create_time_2);
    const used = new Set();
    const take = (kind) => {
      const k = findKey(result, DATASETS[kind]);
      if (k) used.add(k);
      return k ? result[k] : null;
    };

    const sysRows = take('system') || [];
    const chgRows = take('chargers') || [];
    const stHourRows = take('stationHourly') || [];
    const stAvgRows = take('stationAvg') || [];
    const robotRows = take('robots') || [];

    let durationH = t2 > t1 ? (t2 - t1) / 3600000 : 0;
    let H = Math.ceil(durationH - 1e-9);
    sysRows.forEach((r) => (H = Math.max(H, num(r.group_id))));
    chgRows.forEach((r) => (H = Math.max(H, num(r.group_id))));
    robotRows.forEach((r) => (H = Math.max(H, num(r.hour_num))));
    if (!durationH) durationH = H;
    const hours = Array.from({ length: H }, (_, i) => i + 1);

    const system = hours.map((h) => {
      const r = sysRows.find((x) => num(x.group_id) === h) || {};
      return {
        h,
        finIn: num(r.finished_inbound_tasks),
        finOut: num(r.finished_outbound_tasks),
        openIn: num(r.unfinished_inbound_tasks),
        openOut: num(r.unfinished_outbound_tasks),
      };
    });

    const chargers = {};
    chgRows.forEach((r) => {
      const t = r.charger_type || 'Charger';
      (chargers[t] = chargers[t] || hours.map(() => 0))[num(r.group_id) - 1] = num(r.charging_percent);
    });

    const stMap = new Map();
    stHourRows.forEach((r) => {
      const code = r.stationCode || r.station_code;
      if (!code) return;
      if (!stMap.has(code)) stMap.set(code, { code, type: r.stationType || 'STATION', hourly: hours.map(() => 0), reportedTotal: null, avgPerHour: null });
      const s = stMap.get(code);
      if (r.stationType) s.type = r.stationType;
      if (r.period === 'Total') s.reportedTotal = num(r.moveNum);
      else {
        const h = parseInt(r.period, 10);
        if (h >= 1 && h <= H) s.hourly[h - 1] = num(r.moveNum);
      }
    });
    stAvgRows.forEach((r) => {
      const code = r.station_code || r.stationCode;
      if (!stMap.has(code)) stMap.set(code, { code, type: guessType(code), hourly: hours.map(() => 0), reportedTotal: null, avgPerHour: null });
      stMap.get(code).avgPerHour = num(r.move_efficiency);
    });
    const stations = [...stMap.values()].map((s) => {
      const total = s.reportedTotal ?? s.hourly.reduce((a, b) => a + b, 0);
      return { ...s, total, avgPerHour: s.avgPerHour ?? (durationH ? Math.ceil(total / durationH) : 0) };
    });
    stations.sort((a, b) => a.type.localeCompare(b.type) || naturalCmp(a.code, b.code));

    const robots = {};
    robotRows.forEach((r) => {
      const t = r.robot_classify || 'Robot';
      const o = (robots[t] = robots[t] || { type: t, perHour: hours.map(() => 0), runAvg: 0 });
      o.perHour[num(r.hour_num) - 1] = num(r.robotEfficiencyPerHour);
      o.runAvg = num(r.avgRobotBoxPerHour) || o.runAvg;
    });

    const extras = Object.keys(result)
      .filter((k) => !used.has(k))
      .map((k) => ({ key: k, rows: result[k] }));

    const queries = (raw.viewConfigs || []).map((v) => ({
      code: v.code,
      name: QUERY_NAMES[(v.name || '').trim()] || (v.name || '').trim(),
      sql: v.sqlScript || '',
    }));

    const tzMin = parseTz(p.$TIME_ZONE$);
    return {
      id: `${fileName}-${raw.code || ''}-${Math.random().toString(36).slice(2, 7)}`,
      fileName,
      label: labelFromFile(fileName),
      reportName: translateName(raw.name),
      reportCode: raw.code || '',
      template: raw.reportTemplate || '',
      start: t1,
      end: t2,
      tz: p.$TIME_ZONE$ || '',
      tzMin,
      durationH,
      params: {
        inboundOpTime: num(p.inbound_manual_one_box_operation_time),
        outboundOpTime: num(p.outbound_manual_one_box_operation_time),
      },
      rawParams: p,
      hours,
      system,
      chargers,
      stations,
      robots: Object.values(robots),
      extras,
      queries,
    };
  }

  function guessType(code) {
    const m = /^([A-Z]+)_/.exec(code || '');
    return m ? `${m[1]}_STATION` : 'STATION';
  }

  function naturalCmp(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  global.SimParser = { parseText, normalize, naturalCmp };
})(window);
