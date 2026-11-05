# Simulation Results

An interactive viewer for **DP Simulation Report** HTML exports. It replaces the
five generic charts of the stock report with a guided explanation of what the run shows.

The stock export is about 14 MB, but almost all of that is bundled viewer code. The
actual results are a roughly 28 KB JSON blob (`window.__STATIC_REPORT_DATA__`). This
tool reads that blob and builds its views from it.

## Use it

Open `index.html` in a browser by double-clicking it. There is no install or build
step, and it works offline. Then:

- **Drop** one or more report `.html` files (or extracted `.json`) anywhere on the page, or use **+ Add report**.
- Load two or more reports, for example Average and Peak, and a **Compare** tab appears.
  Deltas are measured against the first tab; drag tabs to change the baseline.
- Click the scenario title to rename it. **◐** toggles the theme and **⎙** prints or saves as PDF.

Everything runs locally in the browser and nothing is uploaded.

## Two views

**Walkthrough** (default) takes the reader through the result as eight questions, in the order an
engineer would ask them. A step rail on the left shows each step's status (✓ / ! / ✕), so it
doubles as the executive summary. Use ← → to move between steps.

1. Is this the right run? *(built)*: data completeness, design basis, station counts vs design, parameter mismatches, and a copyable list of questions for the simulation engineer
2. Did it meet the design?
3. How hard was it pushed?
4. Did the system keep up?
5. What limited it? *(built)*: every station of the main process hour by hour against its ceiling, the cycle split into wait time and tote exchange vs the cycle needed for target, and stations / robots / chargers checked one by one
6. Is every station behaving?
7. How much margin is there?
8. What do I tell the customer?

Steps not built yet show their answer and link to the matching dashboard section.

**Full dashboard** puts everything on one page:

| Section | Adds |
|---|---|
| KPI tiles | Totals, run-average vs steady-state vs peak throughput, peak and end-of-run open tasks, main station rate vs its ceiling, inferred fleet size |
| Key findings | Plain-language conclusions with status (collapsible) |
| Design targets | Each station is assigned a design process, and each process gets a target-vs-actual check (Pass / Not proven / Below target), with released demand, observed capacity and cycle vs PAT wait time. Station roles can be edited and are remembered per report |
| Released vs completed | Derives when work *entered* the system (completed + change in open tasks), so you can see where demand outran capacity |
| Station strip plot and heatmap | Every station's rate by process, with medians, ceiling and flagged outliers; stations × hours |
| Robots & charging | Per-hour productivity against the run average, and charger utilization on a fixed 0–100% axis |
| Data | Cleaned tables with CSV export (UTF-8 BOM so Excel opens it cleanly) |
| Method | Every definition and threshold, plus the original SQL behind each dataset |

## Design targets (profiles)

A profile describes a proposal's workstation table: per process, its station type, total target
(tote presentations/h), station count, cycle and PAT wait time. Mark the high-volume process `main: true`.
A `match` regex on the file name helps the tool pick a profile automatically.

Real profiles contain confidential proposal figures, so they **don't live in this repo**.
Put them in `src/profiles.local.js` (git-ignored):

```js
window.SIMRES_LOCAL_PROFILES = [
  { id: 'my-project-avg', name: 'My project · Average design', source: 'Proposal v2, §3.3', match: /average/i,
    processes: [ /* same shape as the example in src/profiles.js */ ] },
];
```

`src/profiles.js` contains one illustrative example profile, which is never auto-selected.

Roles are auto-assigned within each station type. Side processes take the stations running more than 15% below
the type median, smallest target first. Every other station goes to the main process. Override any
station under **Design targets → Station roles**; the change is saved in this browser.

## Customer data stays local

`samples/` (except its README) and `src/profiles.local.js` are git-ignored. To get a
**Load local sample** button on your machine:

```bash
python tools/extract_report.py "path/to/report.html" -o samples --sample samples/sample-reports.js
```

## Layout

```
index.html              app shell
src/parser.js           HTML/JSON -> normalized model (datasets matched by key pattern)
src/analysis.js         KPIs, flow balance, station health, design evaluation, findings
src/profiles.js         profile format, example profile, auto role assignment
src/profiles.local.js   your confidential project profiles (git-ignored, optional)
src/walkthrough.js      the guided eight-step view
src/charts.js           dependency-free SVG charts with annotations + tooltip
src/app.js              loading, tabs, dashboard, compare, CSV export
src/styles.css          light/dark tokens, layout, print
tools/extract_report.py batch-extract report data to JSON
```

Tunable thresholds are in `src/analysis.js`: `OUTLIER_RATIO` (0.85) and `PLATEAU_TOL` (0.02).
Report datasets this tool doesn't recognize are still listed under **Data → Other** so nothing is hidden.
