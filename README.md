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

1. **Is this the right run?** Data completeness, design basis, workstations in the simulation vs the design (✓ / ! / ✕ per process), parameter mismatches, and copyable questions for the simulation engineer.
2. **Did it meet the design?** Per process: simulated rate vs target, with the work released behind it. Pass / Not proven / Below target, explained.
3. **How hard was it pushed?** Work released per hour against the design demand, per-process demand vs design, and whether the release was front-loaded.
4. **Did the system keep up?** The open-task queue hour by hour, its peak and end, the time to clear it, and a verdict (kept up / caught up later / fell behind).
5. **What limited it?** Every station of the main process against the design theoretical and planned rates; per process, the design cycle (wait + switch from the design inputs, plus the buffer up to the planned cycle) next to the total cycle the simulation produced, with the gap to theoretical and what's left of the plan; and stations / robots / chargers checked one by one.
6. **Is every station behaving?** Each station's rate within its process group, with outliers, idle time and flat (demand-limited) stations called out.
7. **How much margin is there?** Capacity with the design's station count vs the target (and as simulated, and the theoretical workstation max), stations needed, cycle time allowed, demand growth absorbed.
8. **What do I tell the customer?** A customer-ready summary built from steps 1–7 with **Copy text**, the eight answers at a glance, and the open points to settle internally.

Every step degrades gracefully: without design inputs, steps 2–3 ask for them and the others compare stations by type.

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

## Design inputs (targets to check against)

**Paste** the design inputs JSON from the Customer Success Tool (the main way): **Paste design inputs** on the
start screen (step 1), under **Design targets**, or in Step 1 of the walkthrough. Give it a name (reusing a name
replaces that import); the JSON is checked as you paste. Pressing **Ctrl+V** anywhere outside a text field with
design inputs on the clipboard opens the dialog already filled. **Import file…** and drag-and-drop of the `.json`
(also together with reports) work too.
The file lists the workstation types (with their absolute max rate and single/double cycle), the
flows (direction, workstation type) and, per scenario profile (e.g. Average, Peak), each flow's demand,
workstation count and design rate per station.

Each scenario profile becomes a design basis. A flow with no demand in a profile is left out. Each report is matched
automatically by station counts and file name (`…_Average_…` → Average, `…_peak_…` → Peak); you can override
the match per report. Imports are remembered in this browser only and can be removed again.

Roles are auto-assigned within each station type. Side processes take the stations running more than 15% below
the type median, smallest target first. Every other station goes to the main (highest-demand) process. Override any
station under **Design targets → Station roles**; the change is saved in this browser.

The design inputs don't carry a PAT wait time, so the cycle split in Step 5 uses the report's handling-time
parameter. Hand-written profiles (same shape, with a `wait` per process) can still go in a git-ignored
`src/profiles.local.js` as `window.SIMRES_LOCAL_PROFILES = [...]`.

## Customer data stays local

`samples/` (except its README) and `src/profiles.local.js` are git-ignored. Keep design inputs JSON files in `samples/` or anywhere outside the repo. To get a
**Load local sample** button on your machine:

```bash
python tools/extract_report.py "path/to/report.html" -o samples --sample samples/sample-reports.js
```

## Layout

```
index.html              app shell
src/parser.js           HTML/JSON -> normalized model (datasets matched by key pattern)
src/analysis.js         KPIs, flow balance, station health, design evaluation, findings
src/profiles.js         design inputs import, profile format, auto role assignment
src/walkthrough.js      the guided eight-step view
src/charts.js           dependency-free SVG charts with annotations + tooltip
src/app.js              loading, tabs, dashboard, compare, CSV export
src/styles.css          light/dark tokens, layout, print
tools/extract_report.py batch-extract report data to JSON
```

Tunable thresholds are in `src/analysis.js`: `OUTLIER_RATIO` (0.85) and `PLATEAU_TOL` (0.02).
Report datasets this tool doesn't recognize are still listed under **Data → Other** so nothing is hidden.
