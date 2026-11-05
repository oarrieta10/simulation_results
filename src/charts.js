/* Charts: small dependency-free SVG charts (works offline / from file://).
   Bars + lines on one y-axis, a station strip plot, and a shared tooltip. */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const { fmt } = global.SimAnalysis;

  function s(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ---------- tooltip ----------
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'status');
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tip));
  function showTip(evt, html) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const pad = 14, r = tip.getBoundingClientRect();
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  function hideTip() { tip.style.display = 'none'; }
  function tipRows(title, rows) {
    return `<div class="tt-title">${title}</div>` + rows.map((r) =>
      `<div class="tt-row">${r.color ? `<i class="sw ${r.line ? 'sw-line' : ''}" style="--c:${r.color}"></i>` : '<i class="sw sw-none"></i>'}<span>${r.name}</span><b>${r.value}</b></div>`).join('');
  }

  // ---------- helpers ----------
  function niceStep(range, ticks) {
    const raw = range / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }
  function niceMax(v, ticks = 4) { const st = niceStep(v || 1, ticks); return { max: Math.ceil((v || 1) / st) * st, step: st }; }
  function compact(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
    if (a >= 1e4) return `${+(v / 1e3).toFixed(0)}k`;
    if (a >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
    return `${+v.toFixed(2)}`;
  }
  function topRounded(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    if (h <= 0) return '';
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function legend(container, series) {
    if (series.filter((sr) => sr.legend !== false).length < 2) return;
    const lg = document.createElement('div');
    lg.className = 'legend';
    lg.innerHTML = series.filter((sr) => sr.legend !== false).map((sr) => `<span><i class="sw ${sr.type === 'line' ? 'sw-line' : ''} ${sr.dash ? 'sw-dash' : ''}" style="--c:${sr.color}"></i>${sr.name}</span>`).join('');
    container.appendChild(lg);
  }

  // Responsive wrapper: re-renders when the container width changes.
  function responsive(container, draw) {
    let lastW = 0;
    const run = () => {
      const w = Math.floor(container.clientWidth);
      if (!w || w === lastW) return;
      lastW = w;
      container.innerHTML = '';
      draw(w);
    };
    const ro = new ResizeObserver(run);
    ro.observe(container);
    run();
  }

  /**
   * Bars (optionally stacked) and lines over hourly categories on ONE y-axis.
   * opts: { labels, series:[{name,color,values,type:'bar'|'line',dash}], height,
   *         yFormat, tipFormat, yMax, refs:[{value,label}], xTitle, unit, totalRow }
   */
  function hourly(container, opts) {
    legend(container, opts.series); // legend above plot
    const box = document.createElement('div');
    container.appendChild(box);
    responsive(box, (W) => drawHourly(box, W, opts));
  }

  function drawHourly(box, W, o) {
    const H = o.height || 240;
    const m = { l: 48, r: 18, t: 14, b: 30 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const n = o.labels.length;
    const bars = o.series.filter((x) => x.type !== 'line');
    const lines = o.series.filter((x) => x.type === 'line');
    let maxV = 0;
    for (let i = 0; i < n; i++) {
      maxV = Math.max(maxV, bars.reduce((a, sr) => a + (sr.values[i] || 0), 0));
      lines.forEach((sr) => (maxV = Math.max(maxV, sr.values[i] || 0)));
    }
    (o.refs || []).forEach((r) => (maxV = Math.max(maxV, r.value)));
    const { max, step } = o.yMax ? { max: o.yMax, step: niceStep(o.yMax, 4) } : niceMax(maxV * 1.04);
    const y = (v) => m.t + ih - (v / max) * ih;
    const band = iw / n;
    const cx = (i) => m.l + band * i + band / 2;
    const yf = o.yFormat || compact;

    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': o.aria || '' }, box);
    const g = s('g', {}, svg);
    for (let v = 0; v <= max + 1e-9; v += step) {
      s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }, g);
      s('text', { x: m.l - 8, y: y(v), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, g).textContent = yf(v);
    }
    const every = Math.ceil(n / Math.max(1, Math.floor(iw / 34)));
    o.labels.forEach((lb, i) => {
      if (i % every) return;
      s('text', { x: cx(i), y: H - m.b + 18, class: 'tick', 'text-anchor': 'middle' }, g).textContent = lb;
    });

    const hl = s('rect', { x: 0, y: m.t, width: band, height: ih, class: 'hover-band', opacity: 0 }, g);

    const bw = Math.min(band * 0.62, 44);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      const vis = bars.filter((sr) => (sr.values[i] || 0) > 0);
      vis.forEach((sr, k) => {
        const v = sr.values[i] || 0;
        const y0 = y(acc), y1 = y(acc + v);
        const gap = k > 0 ? 2 : 0; // 2px surface gap between stacked segments
        const h = Math.max(0, y0 - y1 - gap);
        const isTop = k === vis.length - 1;
        if (isTop) s('path', { d: topRounded(cx(i) - bw / 2, y1, bw, h, 4), fill: sr.color }, g);
        else s('rect', { x: cx(i) - bw / 2, y: y1, width: bw, height: h, fill: sr.color }, g);
        acc += v;
      });
    }
    (o.refs || []).forEach((r) => {
      s('line', { x1: m.l, x2: W - m.r, y1: y(r.value), y2: y(r.value), class: `ref ${r.tone || ''}` }, g);
      s('text', { x: W - m.r, y: y(r.value) + (r.below ? 13 : -5), class: `ref-label ${r.tone || ''}`, 'text-anchor': 'end' }, g).textContent = r.label;
    });
    lines.forEach((sr) => {
      const d = sr.values.map((v, i) => `${i ? 'L' : 'M'}${cx(i)},${y(v || 0)}`).join('');
      s('path', {
        d, fill: 'none', stroke: sr.color, 'stroke-width': sr.muted ? 1.25 : 2, opacity: sr.muted ? 0.35 : null,
        'stroke-dasharray': sr.dash ? '5 4' : null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        pathLength: sr.dash ? null : 1, class: sr.dash ? null : 'draw',
      }, g);
      if (!sr.muted) sr.values.forEach((v, i) => s('circle', { cx: cx(i), cy: y(v || 0), r: n > 24 ? 2.5 : 4, fill: sr.color, class: 'dot' }, g));
      if (sr.endLabel) {
        const v = sr.values[n - 1] || 0;
        s('text', { x: cx(n - 1) + 8, y: y(v), class: 'end-label', 'dominant-baseline': 'middle' }, g).textContent = sr.endLabel;
      }
    });

    // Annotations: a ring on the point the text talks about, with a short leader to its label.
    (o.annotations || []).forEach((an) => {
      const ax = cx(an.i), ay = y(an.value);
      const lx = ax + (an.dx ?? 16), ly = ay + (an.dy ?? -28);
      const ga = s('g', { class: 'anno' }, g);
      s('line', { x1: ax, y1: ay, x2: lx, y2: ly + 4, class: 'anno-leader' }, ga);
      s('circle', { cx: ax, cy: ay, r: 7, class: 'anno-ring' }, ga);
      const tx = s('text', { x: lx + (an.anchor === 'end' ? -4 : 4), y: ly, 'text-anchor': an.anchor || 'start', class: 'anno-text' }, ga);
      String(an.text).split(/\n/).forEach((line, k) => { const t = s('tspan', { x: lx + (an.anchor === 'end' ? -4 : 4), dy: k ? 14 : 0 }, tx); t.textContent = line; });
    });

    // Hit targets: one full-height band per hour.
    for (let i = 0; i < n; i++) {
      const hit = s('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, fill: 'transparent' }, g);
      const enter = (e) => {
        hl.setAttribute('x', m.l + band * i); hl.setAttribute('opacity', 1);
        const rows = o.series.filter((sr) => !sr.muted).map((sr) => ({ name: sr.name, color: sr.color, line: sr.type === 'line', value: (o.tipFormat || ((v) => fmt(v)))(sr.values[i] || 0, sr) }));
        if (o.totalRow && bars.length > 1) rows.push({ name: 'Total', value: (o.tipFormat || ((v) => fmt(v)))(bars.reduce((a, sr) => a + (sr.values[i] || 0), 0)) });
        if (o.extraTip) rows.push(...o.extraTip(i));
        showTip(e, tipRows(o.tipTitle ? o.tipTitle(i) : o.labels[i], rows));
      };
      hit.addEventListener('mousemove', enter);
      hit.addEventListener('mouseleave', () => { hl.setAttribute('opacity', 0); hideTip(); });
    }
  }

  /**
   * Strip plot: one row per station type, a dot per station at its avg tote presentations/h.
   * Shows type median and an optional ceiling line; outliers are labelled.
   */
  function strip(container, { types, ceiling, ceilingLabel, color, flagColor }) {
    const box = document.createElement('div');
    container.appendChild(box);
    responsive(box, (W) => {
      const rowH = 64, m = { l: 96, r: 24, t: 10, b: 30 };
      const H = m.t + m.b + rowH * types.length;
      const iw = W - m.l - m.r;
      const maxV = Math.max(ceiling || 0, ...types.flatMap((t) => t.list.map((s) => s.avgPerHour)));
      const { max, step } = niceMax(maxV * 1.05, 5);
      const x = (v) => m.l + (v / max) * iw;
      const svg = s('svg', { width: W, height: H, class: 'chart', role: 'img', 'aria-label': 'Average tote presentations per hour by station' }, box);
      for (let v = 0; v <= max + 1e-9; v += step) {
        s('line', { x1: x(v), x2: x(v), y1: m.t, y2: H - m.b, class: v === 0 ? 'axis' : 'grid' }, svg);
        s('text', { x: x(v), y: H - m.b + 18, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = fmt(v);
      }
      if (ceiling) {
        s('line', { x1: x(ceiling), x2: x(ceiling), y1: m.t, y2: H - m.b, class: 'ref' }, svg);
        s('text', { x: x(ceiling) - 6, y: m.t + 10, class: 'ref-label', 'text-anchor': 'end' }, svg).textContent = ceilingLabel;
      }
      types.forEach((t, ti) => {
        const cy = m.t + rowH * ti + rowH / 2;
        s('text', { x: m.l - 12, y: cy - 6, class: 'row-label', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg).textContent = t.label;
        s('text', { x: m.l - 12, y: cy + 10, class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg).textContent = `${t.count} stations`;
        s('line', { x1: x(t.median), x2: x(t.median), y1: cy - 20, y2: cy + 20, class: 'median' }, svg);
        // Beeswarm-lite: stack dots that would overlap.
        const buckets = {};
        const placed = [...t.list].sort((a, b) => a.avgPerHour - b.avgPerHour).map((st) => {
          const key = Math.round(x(st.avgPerHour) / 9);
          const k = (buckets[key] = (buckets[key] || 0) + 1) - 1;
          const off = k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 8;
          return { st, cx: x(st.avgPerHour), cy: cy + Math.max(-22, Math.min(22, off)) };
        });
        placed.forEach(({ st, cx, cy: dy }) => {
          const out = t.outliers.includes(st);
          const c = s('circle', { cx, cy: dy, r: 5, fill: out ? flagColor : color, class: 'dot' }, svg);
          if (out) {
            const lbl = s('text', { x: cx, y: cy + 30, class: 'flag-label', 'text-anchor': 'middle' }, svg);
            lbl.textContent = `▲ ${st.code}`;
          }
          const hit = s('circle', { cx, cy: dy, r: 10, fill: 'transparent' }, svg);
          hit.addEventListener('mousemove', (e) => {
            c.setAttribute('r', 7);
            showTip(e, tipRows(st.code, [
              { name: 'Avg tote presentations / h', value: fmt(st.avgPerHour) },
              { name: 'Total tote presentations', value: fmt(st.total) },
              { name: `vs ${t.label.toLowerCase()} median`, value: `${st.avgPerHour >= t.median ? '+' : ''}${fmt((st.avgPerHour / t.median - 1) * 100, 1)}%` },
              ...(ceiling && t.isLabor ? [{ name: 'of manual ceiling', value: `${fmt((st.avgPerHour / ceiling) * 100)}%` }] : []),
            ]));
          });
          hit.addEventListener('mouseleave', () => { c.setAttribute('r', 5); hideTip(); });
        });
      });
    });
  }

  global.SimCharts = { hourly, strip, showTip, hideTip, tipRows, compact };
})(window);
