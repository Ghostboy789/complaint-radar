"use strict";

// Pure render functions. Each takes data already read from site/data and returns an
// HTML string. No network calls, no globals written, no DOM access.

const Pages = (() => {
  const PAGES = [
    ["index", "Overview", "index.html"],
    ["volumes", "Volumes", "volumes.html"],
    ["router", "Router", "router.html"],
    ["cost", "Cost against accuracy", "cost.html"],
    ["radar", "Radar", "radar.html"],
    ["quality", "Data quality", "quality.html"],
    ["try", "Try it", "try.html"],
  ];

  const TERMS = {
    narrative:
      "The complaint text, present only when the consumer agreed to publish it.",
    desk: "The eleven product groups a complaint can be sent to; one group is one desk.",
    "macro-F1":
      "The average of the F1 scores for each product, so every product counts equally.",
    precision:
      "Of the complaints sent to a desk automatically, the share that are on the right desk.",
    coverage:
      "The share of complaints confident enough to be sent to a desk automatically.",
    "95% interval":
      "A range of values from resampling the complaints; the estimate is expected to fall inside it in ninety-five of a hundred repeated samples.",
    calibration:
      "Whether the stated confidence matches how often the prediction is actually right.",
    "zero-shot": "A language model given only the list of desks and the complaint.",
    "few-shot":
      "The same prompt, preceded by one example complaint for each desk.",
    alarm: "A week when the rule says a product desk suddenly filled up.",
    episode: "A run of alarm weeks no more than a few weeks apart.",
    "new text":
      "A test complaint whose text was not seen in any complaint received before the test period.",
  };

  function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function ok(value) {
    return value !== null && value !== undefined && !(typeof value === "number" && Number.isNaN(value));
  }

  function fixed(value, digits = 1) {
    if (!ok(value)) return "—";
    return Number(value).toFixed(digits);
  }

  function integer(value) {
    if (!ok(value)) return "—";
    return Math.round(Number(value)).toLocaleString("en-US");
  }

  function pct(value, digits = 1) {
    if (!ok(value)) return "—";
    return `${fixed(Number(value) * 100, digits)}%`;
  }

  function term(key, label) {
    return `<button type="button" class="term" data-term="${esc(key)}" aria-describedby="gloss-def">${esc(label || key)}</button>`;
  }

  function plain(value) {
    return String(value === null || value === undefined ? "" : value).replace(/<[^>]*>/g, "");
  }

  function table(headers, rows, className = "") {
    const head = headers
      .map((header) => `<th scope="col">${header}</th>`)
      .join("");
    const body = rows
      .map(
        (row) =>
          `<tr>${row
            .map(
              (cell, i) =>
                `<td data-label="${esc(plain(headers[i] || ""))}">${cell}</td>`,
            )
            .join("")}</tr>`,
      )
      .join("");
    return `<table class="${esc(className)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function badge(flag, passWord = "PASS", failWord = "FAIL") {
    if (!ok(flag)) return '<span class="badge idle">NOT RUN</span>';
    return `<span class="badge ${flag ? "pass" : "fail"}"><span aria-hidden="true">${flag ? "✓" : "×"}</span> ${flag ? passWord : failWord}</span>`;
  }

  function interval(num, formatter) {
    if (!num || !ok(num.ci_low) || !ok(num.ci_high)) return "interval not published";
    return `${formatter(num.ci_low)} – ${formatter(num.ci_high)}`;
  }

  function numLine(num, formatter, prefix = "95% interval") {
    if (!num || !ok(num.value)) return "Not reported in the result file.";
    const n = ok(num.n) ? ` · n = ${integer(num.n)}` : "";
    return `${prefix} ${interval(num, formatter)}${n}`;
  }

  function numCell(num, formatter) {
    if (!num || !ok(num.value)) return '<span class="muted">not reported</span>';
    return `${esc(formatter(num.value))}<span class="ci">${esc(numLine(num, formatter))}</span>`;
  }

  function bar(value, low, high, formatter) {
    if (!ok(value)) return '<div class="track"><span class="track-none">not reported</span></div>';
    const lo = ok(low) ? Number(low) : Number(value);
    const hi = ok(high) ? Number(high) : Number(value);
    // Fixed scale so interval widths are comparable: 0..1 for shares and scores, else a padded range through zero.
    let d0 = 0;
    let d1 = 1;
    if (lo < 0 || hi > 1) {
      const pad = (Math.max(0, hi) - Math.min(0, lo)) * 0.15;
      d0 = Math.min(0, lo) - pad;
      d1 = Math.max(0, hi) + pad;
    }
    const at = (x) => Math.max(0, Math.min(100, ((x - d0) / (d1 - d0)) * 100));
    const pos = at(Number(value));
    const left = at(lo);
    const right = at(hi);
    return `<div class="track" role="img" aria-label="${esc(`${formatter(value)}, ${interval({ ci_low: low, ci_high: high }, formatter)}`)}"><span class="track-range" style="left:${left}%;width:${right - left}%"></span><span class="track-dot" style="left:${pos}%"></span></div>`;
  }

  function kpi(label, num, formatter, note = "") {
    const value = num && ok(num.value) ? formatter(num.value) : "—";
    return `<div class="kpi"><p class="kpi-label">${label}</p><p class="kpi-value">${esc(value)}</p>${bar(num && num.value, num && num.ci_low, num && num.ci_high, formatter)}<p class="kpi-meta">${esc(numLine(num, formatter))}${note ? ` · ${esc(note)}` : ""}</p></div>`;
  }

  function exactCount(label, value, note = "exact count") {
    return `<div class="kpi"><p class="kpi-label">${label}</p><p class="kpi-value">${integer(value)}</p><p class="kpi-meta">${esc(note)}</p></div>`;
  }

  function plainEstimate(label, value, n, description = "95% interval not published") {
    return `<div class="kpi"><p class="kpi-label">${label}</p><p class="kpi-value">${esc(fixed(value, 3))}</p><p class="kpi-meta">${esc(description)}${ok(n) ? ` · n = ${integer(n)}` : ""}</p></div>`;
  }

  function figure(spec) {
    const rows = spec.rows || [];
    const headers = spec.headers || [];
    return `<section class="figure" ${spec.id ? `id="${esc(spec.id)}"` : ""}>
      ${spec.title ? `<h3>${spec.title}</h3>` : ""}
      ${spec.intro ? `<p class="figure-intro">${spec.intro}</p>` : ""}
      <div class="chart" data-chart="${esc(spec.chart)}" ${spec.group ? `data-group="${esc(spec.group)}"` : ""} role="img" aria-label="${esc(spec.alt || spec.title || "chart")}"></div>
      <p class="meaning"><strong>What this means.</strong> ${spec.meaning || ""}</p>
      <details class="exact"><summary>Exact numbers</summary>${rows.length ? table(headers, rows) : '<p class="muted">No exact numbers were published for this block.</p>'}</details>
    </section>`;
  }

  function opener(eyebrow, sentence, look) {
    return `<header class="opener reveal"><p class="eyebrow">${esc(eyebrow)}</p><h1>${sentence}</h1><p class="look">${esc(look)}</p></header>`;
  }

  function nextCard(name) {
    const index = PAGES.findIndex((page) => page[0] === name);
    const next = PAGES[(index + 1) % PAGES.length];
    return `<a class="next-card" href="${next[2]}"><span class="eyebrow">NEXT</span><span class="next-title">${esc(next[1])}</span><span class="next-arrow" aria-hidden="true">→</span></a>`;
  }

  function notRun(title, detail) {
    return `<section class="card not-run"><p class="eyebrow">NOT RUN</p><h2>${esc(title)}</h2><p>${esc(detail)}</p></section>`;
  }

  function groupLabel(group) {
    return ok(group) ? String(group).replaceAll("_", " ") : "not reported";
  }

  function wilson(successes, total) {
    if (!ok(successes) || !ok(total) || Number(total) <= 0) {
      return { value: null, ci_low: null, ci_high: null, n: null };
    }
    const n = Number(total);
    const p = Number(successes) / n;
    const z = 1.96;
    const z2 = z * z;
    const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
    const half =
      (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    return {
      value: centre,
      ci_low: Math.max(0, centre - half),
      ci_high: Math.min(1, centre + half),
      n,
    };
  }

  function pctFmt(value) {
    return pct(value, 1);
  }

  function rateFmt(value) {
    return pct(value, 2);
  }

  // ---------------------------------------------------------------- overview

  function renderIndex(data) {
    const router = data.router || {};
    const h2 = router.h2 || {};
    const coverage = h2.coverage;
    const precision = h2.precision;
    const every = 1000;
    const routed = ok(coverage && coverage.value)
      ? Math.round(Number(coverage.value) * every)
      : null;
    const wrong = ok(routed) && ok(precision && precision.value)
      ? Math.round(routed * (1 - Number(precision.value)))
      : null;
    const sentence = ok(routed)
      ? `Of every ${integer(every)} complaints, <em>${integer(routed)}</em> can be sent to a desk without a person. <em>${integer(wrong)}</em> of those land on the wrong desk.`
      : "The routing result is not available, so this page cannot say how many complaints can be sent without a person.";
    const look = "Watch the marks sort into desks, then read the three verdicts below.";
    const meta = `<div class="hero-meta">
      <div><p class="kpi-label">Automatic routing · ${term("coverage", "coverage")}</p><p class="mono">${esc(numLine(coverage, pctFmt))}</p></div>
      <div><p class="kpi-label">Right desk · ${term("precision", "precision")}</p><p class="mono">${esc(numLine(precision, pctFmt))}</p></div>
      <div><p class="kpi-label">H2 rule</p>${badge(h2.pass)}<p class="rule-words">Sent automatically for at least half of complaints, with at least ninety-five per cent on the right desk.</p></div>
    </div>`;
    const hero = `<section class="hero-grid">
      ${opener("OVERVIEW · THE SORTING ROOM", sentence, look)}${meta}
      <div class="canvas-panel">
        <div class="chart canvas-chart" data-chart="sorting-room" role="img" aria-label="One thousand marks sorting into eleven product desks"></div>
        <p class="caption">One mark is one of every thousand test complaints. Accent: sent automatically. Signal: sent to the wrong desk. Grey: a person decides.</p>
        <details class="exact"><summary>Exact numbers · by desk</summary>${deskTable(router)}</details>
      </div>
    </section>`;

    const verdicts = '<h2 class="section-head">The three questions</h2><div class="cards">';
    const rCard = `<article class="card verdict"><p class="eyebrow">H2 · ROUTER</p><p class="verdict-number">${esc(pct(coverage && coverage.value))}</p><p class="mono small">${esc(numLine(coverage, pctFmt))}</p>${badge(h2.pass)}<p class="verdict-text">Can a complaint be sent to the right desk from its text alone?</p><a href="router.html">See the router evidence →</a></article>`;
    const llmCard = renderLlmCard(data);
    const h3 = data.radar && data.radar.h3 ? data.radar.h3.pass : null;
    const summary = (data.radar || {}).summary || {};
    const rate = summary.unexplained_per_series_year;
    const radarCard = `<article class="card verdict"><p class="eyebrow">H3 · RADAR</p><p class="verdict-number">${esc(fixed(rate && rate.value, 2))}</p><p class="mono small">${esc(numLine(rate, (v) => fixed(v, 2)))}</p>${badge(h3)}<p class="verdict-text">Would a simple rule have flagged known events without crying wolf?</p><a href="radar.html">See the radar evidence →</a></article>`;
    const caveats = `<section class="prose reveal"><h2 class="section-head">What this is and is not</h2><ul class="caveats">
      <li>Complaints are not a random sample of problems, and narratives are the subset whose authors agreed to publish.</li>
      <li>Labels are chosen by the consumer. A "wrong" prediction is sometimes the better label.</li>
      <li>Complaint counts are not incident counts. Nothing here measures any company's conduct.</li>
      <li>United States consumer finance only.</li>
      <li>The test period is small and unusual. Results on it describe that period.</li>
    </ul></section>`;
    const totals = (data.descriptive || {}).totals || {};
    const facts = `<section class="reveal"><h2 class="section-head">The data in one paragraph</h2><div class="facts">
      ${exactCount("Complaints", totals.complaints)}
      ${exactCount("With a narrative", totals.with_narrative)}
      ${exactCount("Companies", totals.companies)}
      <div class="kpi"><p class="kpi-label">Received</p><p class="fact-line">${esc(ok(totals.first_date) ? totals.first_date : "—")} to ${esc(ok(totals.last_date) ? totals.last_date : "—")}</p><p class="kpi-meta">exact count of days in the archive</p></div>
    </div><p class="prose-line">The archive holds ${integer(totals.complaints)} complaints; ${integer(totals.with_narrative)} carry a ${term("narrative")}. Of those that were responded to, ${pctFmt((totals.timely_rate || {}).value)} were timely and ${pctFmt((totals.monetary_relief_rate || {}).value)} ended in monetary relief.</p></section>`;
    return `${hero}<section class="section">${verdicts}${rCard}${llmCard}${radarCard}</div></section>${caveats}${facts}${nextCard("index")}`;
  }

  function deskTable(router) {
    const rows = ((router.models || {}).words || {}).auto_route;
    const byProduct = (rows && rows.by_product) || [];
    return table(
      ["Desk", "Complaints sent to desk", "Sent automatically", "Share right"],
      byProduct.map((row) => [
        esc(groupLabel(row.product)),
        esc(integer((row.coverage || {}).n)),
        esc(integer((row.precision || {}).n)),
        numCell(row.precision, pctFmt),
      ]),
    );
  }

  function renderLlmCard(data) {
    const evalData = data.llmEval;
    if (!evalData || !evalData.h1) {
      return `<article class="card verdict"><p class="eyebrow">H1 · LANGUAGE MODEL</p><h3>Not run yet</h3><p class="mono small">The long model run has not written its result file.</p><span class="badge idle">NOT RUN</span><p class="verdict-text">Does a large language model beat the small trained model once confidence and cost are counted?</p><a href="cost.html">See what is planned →</a></article>`;
    }
    const h1 = evalData.h1;
    const diff = h1.difference;
    return `<article class="card verdict"><p class="eyebrow">H1 · LANGUAGE MODEL</p><p class="verdict-number">${esc(fixed(diff && diff.value, 3))}</p><p class="mono small">${esc(numLine(diff, (v) => fixed(v, 3)))}</p>${badge(h1.pass)}<p class="verdict-text">Paired difference in ${term("macro-F1")} on the same fixed sample.</p><a href="cost.html">See the cost evidence →</a></article>`;
  }

  // ---------------------------------------------------------------- volumes

  function defaultFilters() {
    return { group: "all", company: "all", year: "all" };
  }

  function selectHtml(label, name, values, selected, allLabel = "All") {
    const options = [`<option value="all"${selected === "all" ? " selected" : ""}>${esc(allLabel)}</option>`]
      .concat(
        values.map(
          (value) =>
            `<option value="${esc(value)}"${String(selected) === String(value) ? " selected" : ""}>${esc(plain(value).replaceAll("_", " "))}</option>`,
        ),
      )
      .join("");
    return `<label class="filter"><span>${esc(label)}</span><select data-filter="${esc(name)}">${options}</select></label>`;
  }

  function renderVolumes(data, filters) {
    const volume = data.volumes || {};
    const chosen = filters || defaultFilters();
    const controls = `<div class="filters" role="group" aria-label="Filter the complaint volumes">
      ${selectHtml("Product group", "group", volume.groups || [], chosen.group)}
      ${selectHtml("Company", "company", volume.companies || [], chosen.company)}
      ${selectHtml("Year", "year", volume.years || [], chosen.year)}
    </div>`;
    return `${opener("VOLUMES · WHO COMPLAINS", `${integer((data.descriptive || {}).totals && data.descriptive.totals.complaints)} complaints in the archive; ${pctFmt(((data.descriptive || {}).totals || {}).narrative_share && data.descriptive.totals.narrative_share.value)} carry a ${term("narrative")}.`, "Use the three filters, then read the charts below them.")}
      ${controls}<div id="vol-dashboard">${volumesDashboard(data, chosen)}</div>
      <p class="prose-line">Complaint counts are not incident counts. Bigger companies receive more complaints, and no rate here is adjusted for size.</p>
      ${nextCard("volumes")}`;
  }

  function volumesDashboard(data, filters) {
    const volume = data.volumes || {};
    const groups = volume.groups || [];
    const companies = volume.companies || [];
    const years = volume.years || [];
    const months = volume.months || [];
    const cube = volume.cube || [];
    const monthly = volume.monthly || [];
    const match = (row, ignore) => {
      if (ignore !== "year" && filters.year !== "all" && years[row[0]] !== String(filters.year)) return false;
      if (ignore !== "group" && filters.group !== "all" && groups[row[1]] !== filters.group) return false;
      if (ignore !== "company" && filters.company !== "all" && companies[row[2]] !== filters.company) return false;
      return true;
    };
    const sum = (rows, index) => rows.reduce((total, row) => total + (Number(row[index]) || 0), 0);
    const all = cube.filter((row) => match(row, ""));
    const complaints = sum(all, 3);
    const narrative = sum(all, 4);
    const responded = sum(all, 5);
    const timely = sum(all, 6);
    const money = sum(all, 7);

    const kpis = `<div class="kpis">
      ${exactCount("Complaints", complaints)}
      ${kpi("Share with a narrative", wilson(narrative, complaints), pctFmt)}
      ${kpi("Timely-response rate", wilson(timely, responded), pctFmt)}
      ${kpi("Monetary-relief rate", wilson(money, responded), pctFmt)}
    </div>`;

    const byYear = years
      .map((year, yi) => [year, sum(cube.filter((row) => row[0] === yi && (filters.group === "all" || groups[row[1]] === filters.group) && (filters.company === "all" || companies[row[2]] === filters.company)), 3)])
      .filter((row) => row[1] > 0);
    const yearFigure = figure({
      id: "volume-year",
      title: "Complaints by year",
      chart: "vol-years",
      alt: "Bars of complaint counts by year",
      meaning: `The tallest bar is ${integer(Math.max(0, ...byYear.map((row) => row[1])))} complaints in ${esc(byYear.length ? byYear.reduce((a, b) => (b[1] > a[1] ? b : a))[0] : "—")}.`,
      headers: ["Year", "Complaints"],
      rows: byYear.map((row) => [esc(row[0]), esc(integer(row[1]))]),
    });

    const byGroup = groups
      .map((group, gi) => [group, sum(cube.filter((row) => row[1] === gi && (filters.year === "all" || years[row[0]] === filters.year) && (filters.company === "all" || companies[row[2]] === filters.company)), 3)])
      .filter((row) => row[1] > 0)
      .sort((a, b) => b[1] - a[1]);
    const groupFigure = figure({
      id: "volume-product",
      title: "By product desk",
      chart: "vol-products",
      alt: "Ranked bars of complaints by product desk",
      meaning: groupFigureMeaning(byGroup),
      headers: ["Desk", "Complaints"],
      rows: byGroup.map((row) => [esc(groupLabel(row[0])), esc(integer(row[1]))]),
    });

    const byCompany = companies
      .map((company, ci) => [company, sum(cube.filter((row) => row[2] === ci && (filters.year === "all" || years[row[0]] === filters.year) && (filters.group === "all" || groups[row[1]] === filters.group)), 3)])
      .filter((row) => row[1] > 0)
      .sort((a, b) => b[1] - a[1]);
    const companyFigure = figure({
      id: "volume-company",
      title: "By company",
      chart: "vol-companies",
      alt: "Ranked bars of complaints by company",
      meaning: "The largest bar is the company with the most complaints in this selection; it is not a measure of conduct.",
      headers: ["Company", "Complaints"],
      rows: byCompany.map((row) => [esc(row[0]), esc(integer(row[1]))]),
    });

    const byMonth = months.map((month, mi) => [
      month,
      sum(monthly.filter((row) => row[0] === mi && (filters.group === "all" || groups[row[1]] === filters.group) && (filters.company === "all" || companies[row[2]] === filters.company)), 2),
      sum(monthly.filter((row) => row[0] === mi && (filters.group === "all" || groups[row[1]] === filters.group) && (filters.company === "all" || companies[row[2]] === filters.company)), 3),
    ]);
    const monthFigure = figure({
      id: "volume-month",
      title: "Every month: with and without a narrative",
      chart: "vol-monthly",
      alt: "Monthly lines of complaints with and without a narrative",
      meaning: monthlyMeaning(byMonth),
      headers: ["Month", "Complaints", "With a narrative"],
      rows: byMonth.filter((row) => row[1] > 0).map((row) => [esc(row[0]), esc(integer(row[1])), esc(integer(row[2]))]),
    });

    const byState = (volume.states || [])
      .filter((row) => filters.year === "all" || String(row[1]) === String(filters.year))
      .reduce((map, row) => map.set(row[0], (map.get(row[0]) || 0) + Number(row[2])), new Map());
    const stateRows = [...byState.entries()].filter((row) => row[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const stateFigure = figure({
      id: "volume-state",
      title: "Top states",
      chart: "vol-states",
      alt: "Ranked bars of complaints by state",
      meaning: "States are ordered by complaint count only; population is not adjusted for here.",
      headers: ["State", "Complaints"],
      rows: stateRows.map((row) => [esc(row[0]), esc(integer(row[1]))]),
    });
    return `${kpis}<div class="figure-grid">${yearFigure}${groupFigure}${companyFigure}${monthFigure}${stateFigure}</div>`;
  }

  function groupFigureMeaning(rows) {
    if (!rows.length) return "No complaints in this selection.";
    const top = rows[0];
    return `${groupLabel(top[0])} is the largest desk here with ${integer(top[1])} complaints.`;
  }

  function monthlyMeaning(rows) {
    const withRows = rows.filter((row) => row[2] > 0);
    if (!withRows.length) return "No narratives were published in this selection.";
    const peak = withRows.reduce((a, b) => (b[2] > a[2] ? b : a));
    const last = withRows[withRows.length - 1];
    return `Narratives peak at ${integer(peak[2])} in ${esc(peak[0])} and stand at ${integer(last[2])} in ${esc(last[0])} while total complaints keep rising.`;
  }

  // ----------------------------------------------------------------- router

  function renderRouter(data, view) {
    const chosen = view === "new" ? "new" : "test";
    const split = ((data.router || {}).split) || {};
    const controls = `<div class="segmented" role="group" aria-label="Choose which test complaints to show">
      <button type="button" class="${chosen === "test" ? "selected" : ""}" data-view="test" aria-pressed="${chosen === "test"}">All test complaints</button>
      <button type="button" class="${chosen === "new" ? "selected" : ""}" data-view="new" aria-pressed="${chosen === "new"}">New text only</button>
    </div>`;
    const macro = ((data.router || {}).models || {}).words;
    const macroNum = macro && macro.test && macro.test.macro_f1;
    const sentence = macroNum && ok(macroNum.value)
      ? `The words model scores ${pctFmt(macroNum.value)} on ${term("macro-F1")}, but automatic routing ${((data.router || {}).h2 || {}).pass ? "passes" : "fails"}: only ${pctFmt(((data.router || {}).h2 || {}).coverage && data.router.h2.coverage.value)} of complaints can be sent straight to a desk.`
      : "The router result is not available, so this page cannot report a score.";
    return `${opener("ROUTER · ONE OF ELEVEN DESKS", sentence, "Compare the models, then read the routing and calibration evidence.")}
      ${controls}<div id="router-dashboard">${routerDashboard(data, chosen)}</div>
      <section class="prose reveal"><h2 class="section-head">The split and the change in product mix</h2>${splitTable(split)}<p>The test period's product mix differs from training. The ${term("new text")} view is the closest look at genuinely unseen complaints.</p></section>
      ${nextCard("router")}`;
  }

  function routerDashboard(data, view) {
    const router = data.router || {};
    const models = router.models || {};
    const metricsKey = view === "new" ? "test_new_text" : "test";
    const routeKey = view === "new" ? "test_new_text" : "test";
    const modelNames = ["majority", "words", "embeddings"];
    const modelRows = modelNames.map((name) => {
      const model = models[name] || {};
      const metrics = model[metricsKey] || {};
      return [esc(name), numCell(metrics.macro_f1, pctFmt), numCell(metrics.accuracy, pctFmt)];
    });
    const modelFigure = figure({
      id: "router-models",
      title: `Model scores · ${view === "new" ? "new text only" : "all test complaints"}`,
      chart: "router-models",
      alt: "Horizontal bars of macro-F1 and accuracy with intervals",
      meaning: "Bars start at zero. Whiskers are the 95% intervals from resampling complaints.",
      headers: ["Model", "Macro-F1", "Accuracy"],
      rows: modelRows,
    });

    const words = models.words || {};
    const metrics = words[metricsKey] || {};
    const perProduct = metrics.per_product || [];
    const inMacro = new Map((router.class_counts || []).map((row) => [row.product, row.in_macro_f1]));
    const perRows = perProduct.map((row) => [
      esc(groupLabel(row.product)),
      esc(fixed(row.precision, 3)),
      esc(fixed(row.recall, 3)),
      esc(fixed(row.f1, 3)),
      esc(integer(row.n)),
      inMacro.get(row.product) === false ? "Left out of macro-F1" : "Included",
    ]);
    const perTable = `<section class="figure"><h3>Per-desk scores</h3>${table(["Desk", "Precision", "Recall", "F1", "n", "Use in macro-F1"], perRows)}<p class="meaning"><strong>What this means.</strong> Each figure here is a point estimate with n shown; the test result file does not publish intervals per desk.</p></section>`;

    const confusion = metrics.confusion || [];
    const confusionFigure = figure({
      id: "router-confusion",
      title: "Where the words model sends complaints",
      chart: "confusion",
      alt: "Heatmap of the words model confusion matrix",
      meaning: "Rows are the true desk and columns are the chosen desk. Each cell prints the share of its row; the exact count is in the cell title and table.",
      headers: ["True desk", ...((router.products || []).map((p) => esc(groupLabel(p))))],
      rows: confusion.map((row, i) => [
        esc(groupLabel((router.products || [])[i] || "")),
        ...row.map((value) => esc(integer(value))),
      ]),
    });

    const reliability = metrics.reliability || [];
    const reliabilityFigure = figure({
      id: "router-reliability",
      title: "Confidence against accuracy",
      chart: "reliability",
      alt: "Reliability chart with a diagonal reference line",
      meaning: `Expected calibration error is ${esc(fixed(metrics.ece, 3))} on n = ${esc(integer(metrics.macro_f1 && metrics.macro_f1.n))} complaints; points on the diagonal would be perfectly ${term("calibration", "calibrated")}.`,
      headers: ["Bin", "n", "Mean confidence", "Accuracy"],
      rows: reliability.map((row) => [
        esc(`${fixed(row.bin_low, 2)} – ${fixed(row.bin_high, 2)}`),
        esc(integer(row.n)),
        esc(fixed(row.mean_confidence, 3)),
        esc(fixed(row.accuracy, 3)),
      ]),
    });

    const auto = words.auto_route || {};
    const routeRows = (auto.by_product || []).map((row) => [
      esc(groupLabel(row.product)),
      esc(fixed(auto.threshold, 3)),
      numCell(row.coverage, pctFmt),
      numCell(row.precision, pctFmt),
    ]);
    const autoSection = `<section class="figure"><h3>Automatic routing by desk</h3>${table(["Desk", "Threshold", "Coverage", "Precision"], routeRows)}
      <p class="meaning"><strong>What this means.</strong> On the test set, ${pctFmt((auto.test || {}).coverage && auto.test.coverage.value)} of complaints are sent automatically and ${pctFmt((auto.test || {}).precision && auto.test.precision.value)} of those are right. On new text those figures are ${pctFmt((auto.test_new_text || {}).coverage && auto.test_new_text.coverage.value)} and ${pctFmt((auto.test_new_text || {}).precision && auto.test_new_text.precision.value)}. The threshold comes from the validation period.</p>
      <details class="exact"><summary>Exact numbers</summary>${table(["Desk", "Threshold", "Coverage", "Precision"], routeRows)}</details></section>`;

    const issueRows = (router.issue_within_product || []).map((row) => [
      esc(groupLabel(row.product)),
      esc(integer(row.issues)),
      esc(integer(row.train_rows)),
      esc(integer(row.test_rows)),
      numCell(row.majority_accuracy, pctFmt),
      numCell(row.words_accuracy, pctFmt),
      numCell(row.words_macro_f1, pctFmt),
    ]);
    const issueSection = `<section class="figure"><h3>Issue within a desk (secondary)</h3>${table(["Desk", "Issues", "Train rows", "Test rows", "Majority accuracy", "Words accuracy", "Words macro-F1"], issueRows)}<p class="meaning"><strong>What this means.</strong> This asks whether the words model can predict the issue inside a desk. No hypothesis was set for it.</p></section>`;
    const noise = (data.descriptive || {}).label_noise || {};
    const noiseBlock = `<section class="prose"><h3>Label noise</h3><p>Among ${integer(noise.complaints)} test complaints that share their text with another test complaint (${integer(noise.distinct_texts)} distinct texts), ${pctFmt((noise.modal_share || {}).value)} carry the most common desk for that text. This describes repeated text only, not a ceiling for the whole test set.</p><p class="mono small">${esc(numLine(noise.modal_share, pctFmt))}</p></section>`;
    return `<div class="figure-grid">${modelFigure}${confusionFigure}${reliabilityFigure}</div>${perTable}${autoSection}${issueSection}${noiseBlock}`;
  }

  function splitTable(split) {
    const rows = ["train", "validation", "test"].map((name) => {
      const part = split[name] || {};
      return [esc(name), esc(ok(part.from) ? part.from : "—"), esc(ok(part.to) ? part.to : "—"), esc(integer(part.rows))];
    });
    return table(["Set", "Received from", "Received to", "Rows"], rows);
  }

  // ------------------------------------------------------------------- cost

  function verdictWords(verdict) {
    if (verdict === "llm_better") return "The language model is more accurate on this sample.";
    if (verdict === "small_model_better") return "The small model is more accurate on this sample.";
    if (verdict === "no_detectable_difference") return "The test cannot tell the two models apart.";
    return "The result has not been published.";
  }

  function renderCost(data) {
    const evaluation = data.llmEval;
    if (!evaluation || !evaluation.h1) {
      return `${opener("COST AGAINST ACCURACY · NOT RUN YET", "The language model has not been run yet, so this page cannot say whether it is worth its cost.", "When the result file arrives, this page will compare it with the small model on one fixed sample.")}
        ${notRun("The language model result is not available", "The long model run has not written its result file. No accuracy, time or token figure is shown here yet.")}
        <section class="prose reveal"><h2 class="section-head">What will appear here</h2><p>The language model's chosen variant against the words model on the same fixed sample, the paired difference in macro-F1 with its interval, the verdict, seconds and tokens per thousand complaints, and a cost you can price yourself.</p><p>The ${term("macro-F1")} on this page is on an equal mix of products, not the real mix.</p></section>
        ${nextCard("cost")}`;
    }
    const h1 = evaluation.h1;
    const chosen = evaluation.chosen_variant === "few_shot" ? "Few-shot" : "Zero-shot";
    const variant = (evaluation.variants || {})[evaluation.chosen_variant] || {};
    const same = evaluation.same_sample || {};
    const llmMacro = (variant.test || {}).macro_f1;
    const wordsMacro = (same.words || {}).macro_f1;
    const lead = ok(h1.difference && h1.difference.value)
      ? `${h1.difference.value > 0 ? "above" : "below"} zero`
      : "not available";
    const sentence = `On the same fixed sample, the ${esc(chosen.toLowerCase())} language model scored ${esc(pct(llmMacro && llmMacro.value))} ${term("macro-F1")} against ${esc(pct(wordsMacro && wordsMacro.value))} for the words model: a paired difference of ${esc(fixed(h1.difference && h1.difference.value, 3))}, ${lead}. ${esc(verdictWords(h1.verdict))}`;
    const figures = `<section class="figure-grid">
      <article class="card figure-figure"><p class="eyebrow">${esc(chosen.toUpperCase())} · LANGUAGE MODEL</p><p class="big-figure">${esc(pct(llmMacro && llmMacro.value))}</p>${bar(llmMacro && llmMacro.value, llmMacro && llmMacro.ci_low, llmMacro && llmMacro.ci_high, pctFmt)}<p class="mono small">${esc(numLine(llmMacro, pctFmt))}</p></article>
      <article class="card figure-figure"><p class="eyebrow">WORDS MODEL · SAME SAMPLE</p><p class="big-figure">${esc(pct(wordsMacro && wordsMacro.value))}</p>${bar(wordsMacro && wordsMacro.value, wordsMacro && wordsMacro.ci_low, wordsMacro && wordsMacro.ci_high, pctFmt)}<p class="mono small">${esc(numLine(wordsMacro, pctFmt))}</p></article>
    </section>`;
    const difference = `<section class="card verdict"><p class="eyebrow">PAIRED DIFFERENCE · H1</p><p class="big-figure">${esc(fixed(h1.difference && h1.difference.value, 3))}</p>${bar(h1.difference && h1.difference.value, h1.difference && h1.difference.ci_low, h1.difference && h1.difference.ci_high, (v) => fixed(v, 3))}<p class="mono small">${esc(numLine(h1.difference, (v) => fixed(v, 3)))}</p>${badge(h1.pass)}<p class="verdict-text">${esc(verdictWords(h1.verdict))}</p></section>`;
    const comparison = `<section class="figure"><h3>Every model on the fixed sample</h3>${costTable(evaluation)}<p class="meaning"><strong>What this means.</strong> ${term("macro-F1")} here is on an equal mix of products, not the real mix. Calibration error and time are point estimates with n = ${esc(integer((evaluation.sample || {}).test))} complaints on this sample.</p></section>`;
    const timeFigure = figure({
      id: "cost-time",
      title: "Time to score a thousand complaints",
      chart: "cost-time",
      alt: "Bars of seconds per thousand complaints, drawn to scale",
      meaning: timeMeaning(data),
      headers: ["Model", "Seconds per 1,000 complaints"],
      rows: timeRows(data),
    });
    const tokens = variant.prompt_tokens_per_1000;
    const outputTokens = variant.output_tokens_per_1000;
    const tokensBlock = `<section class="card"><h3>Tokens and a price you choose</h3><p class="mono small">Prompt tokens per thousand complaints: ${esc(integer(tokens))} · output tokens: ${esc(integer(outputTokens))}</p>
      <label class="filter"><span>Your price per million tokens (no price is suggested here)</span><input id="price-input" type="number" min="0" step="any" inputmode="decimal" placeholder="Enter your own price"></label>
      <p id="cost-result" class="result-line" aria-live="polite">Enter a price to see what the measured tokens would cost.</p>
      <p class="caption">This applies your price to measured prompt and output tokens at the same rate. It is your assumption, not a measured cost.</p></section>`;
    return `${opener("COST AGAINST ACCURACY · IS THE BIG MODEL WORTH IT?", sentence, "Compare the two large figures, the paired difference, then the time and token counts.")}
      ${figures}${difference}${comparison}${timeFigure}${tokensBlock}
      <section class="prose"><p>These results describe one fixed sample of complaints, with every product given equal weight. That is not the mix of complaints the desk actually sees.</p></section>
      ${nextCard("cost")}`;
  }

  function costTable(evaluation) {
    const sample = (evaluation.sample || {}).test;
    const same = evaluation.same_sample || {};
    const variants = evaluation.variants || {};
    const rows = [];
    for (const name of ["majority", "words", "embeddings"]) {
      const item = same[name] || {};
      rows.push([
        esc(name),
        numCell(item.macro_f1, pctFmt),
        numCell(item.accuracy, pctFmt),
        `<span class="mono small">${esc(fixed(item.ece, 3))}<span class="ci">n = ${esc(integer(sample))} · interval not published</span></span>`,
        numCell((item.auto_route || {}).coverage, pctFmt),
        numCell((item.auto_route || {}).precision, pctFmt),
      ]);
    }
    for (const name of ["zero_shot", "few_shot"]) {
      const item = variants[name] || {};
      const metrics = item.test || {};
      rows.push([
        esc(name.replaceAll("_", "-")),
        numCell(metrics.macro_f1, pctFmt),
        numCell(metrics.accuracy, pctFmt),
        `<span class="mono small">${esc(fixed(metrics.ece, 3))}<span class="ci">n = ${esc(integer(sample))} · interval not published</span></span>`,
        numCell(((item.auto_route || {}).test || {}).coverage, pctFmt),
        numCell(((item.auto_route || {}).test || {}).precision, pctFmt),
      ]);
    }
    return table(["Model", "Macro-F1", "Accuracy", "Calibration error", "Coverage", "Precision"], rows);
  }

  // seconds with two or three significant figures, never a rounded-to-zero value
  function seconds(value) {
    const v = Number(value);
    if (!ok(value) || !Number.isFinite(v)) return "—";
    return v >= 100 ? `${integer(Math.round(v))} s` : v >= 1 ? `${v.toFixed(1)} s` : `${v.toFixed(2)} s`;
  }

  function timeRows(data) {
    const evaluation = data.llmEval || {};
    const timings = data.timings || {};
    const variants = evaluation.variants || {};
    return [
      ["Words", timings.words_seconds_per_1000],
      ["Embeddings", timings.embeddings_seconds_per_1000],
      ["Zero-shot", variants.zero_shot && variants.zero_shot.seconds_per_1000],
      ["Few-shot", variants.few_shot && variants.few_shot.seconds_per_1000],
    ].filter((row) => ok(row[1]));
  }

  function timeMeaning(data) {
    const rows = timeRows(data);
    const words = rows.find((row) => row[0] === "Words");
    const chosen = (data.llmEval || {}).chosen_variant === "few_shot" ? "Few-shot" : "Zero-shot";
    const llm = rows.find((row) => row[0] === chosen);
    if (!words || !llm) return "Time is drawn to scale where the result files published it.";
    const ratio = Number(llm[1]) / Number(words[1]);
    return `The ${esc(llm[0].toLowerCase())} language model takes about ${esc(integer(Math.round(ratio)))} times as long as the words model for the same thousand complaints (${esc(seconds(llm[1]))} against ${esc(seconds(words[1]))}), about ${esc(String(Math.round(Math.log10(ratio))))} orders of magnitude. Each gridline is ten times the one before, so the bars are on a log scale.`;
  }

  function costResult(data, price) {
    const evaluation = data.llmEval;
    if (!evaluation || !evaluation.h1) return "The language model result is not available.";
    const variant = (evaluation.variants || {})[evaluation.chosen_variant] || {};
    if (!ok(price) || Number(price) < 0 || !ok(variant.prompt_tokens_per_1000)) {
      return "Enter a price to see what the measured tokens would cost.";
    }
    const tokens =
      Number(variant.prompt_tokens_per_1000) + Number(variant.output_tokens_per_1000 || 0);
    const cost = (tokens / 1000000) * Number(price);
    return `At your price of ${esc(fixed(price, 2))} per million tokens, the measured ${esc(integer(tokens))} tokens per thousand complaints cost ${esc(cost.toFixed(2))} per thousand complaints.`;
  }

  // ------------------------------------------------------------------ radar

  function renderRadar(data, group) {
    const radar = data.radar || {};
    const summary = radar.summary || {};
    const rate = summary.unexplained_per_series_year;
    const detected = summary.detected;
    const events = summary.events;
    const rule = radar.rule || {};
    const sentence = ok(detected)
      ? `The rule caught ${integer(detected)} of ${integer(events)} known events and raised ${esc(fixed(rate && rate.value, 2))} unexplained alarms per series per year.`
      : "The radar result is not available, so this page cannot say whether events were caught.";
    const defaultGroup = ((radar.events || [])[0] || {}).product_group || null;
    const chosen = group || defaultGroup || (((data.weekly || {}).radar || {}).groups || [])[0];
    const groups = (((data.weekly || {}).radar || {}).groups || []).slice().sort();
    const tabs = `<div class="tabs" role="group" aria-label="Choose a product desk">${groups
      .map(
        (name) =>
          `<button type="button" class="${name === chosen ? "selected" : ""}" data-radar-group="${esc(name)}" aria-pressed="${name === chosen}">${esc(groupLabel(name))}</button>`,
      )
      .join("")}</div>`;
    return `${opener("RADAR · THE PULSE", sentence, "Choose a desk, watch the timeline draw, then check the dated events.")}
      <section class="card verdict"><p class="eyebrow">H3 · ALARM RULE</p>${badge((radar.h3 || {}).pass)}<p class="rule-words">Pass needs at least four of the five events caught and no more than one unexplained alarm per series per year. The result is ${esc(detected)} of ${esc(events)} caught and ${esc(fixed(rate && rate.value, 2))} unexplained alarms per series per year.</p></section>
      ${tabs}<div id="radar-dashboard">${radarDashboard(data, chosen)}</div>
      ${radarRule(rule)}${nextCard("radar")}`;
  }

  function radarDashboard(data, group) {
    const radar = data.radar || {};
    const summary = radar.summary || {};
    const weekly = ((data.weekly || {}).radar || {});
    const series = (radar.series || []).find((item) => item.product_group === group) || {};
    const episodes = series.episodes || [];
    const episodeRows = episodes.map((episode) => [
      esc(groupLabel(series.product_group || group)),
      esc(episode.start),
      esc(episode.end),
      esc(fixed(episode.peak_z, 2)),
      esc(episode.event_id ? groupLabel(episode.event_id) : "Unexplained"),
    ]);
    const pulse = figure({
      id: "radar-weekly",
      title: `Weekly complaints · ${groupLabel(group)}`,
      chart: "radar-weekly",
      group: group,
      alt: "Weekly complaint timeline with alarm weeks, episodes and event flags",
      meaning: `This desk has ${integer(episodes.length)} episode${episodes.length === 1 ? "" : "s"}; ${episodes.filter((episode) => !episode.event_id).length} start outside the dated event windows.`,
      headers: ["Desk", "Start", "End", "Peak z", "Explained by"],
      rows: episodeRows,
    });

    const eventRows = (radar.events || []).map((event) => [
      esc(event.title),
      esc(event.event_date),
      esc(groupLabel(event.product_group)),
      event.detected
        ? `<span class="state pass">Detected</span>`
        : `<span class="state fail">Missed</span>`,
      esc(ok(event.delay_weeks) ? integer(event.delay_weeks) : "—"),
      event.naive_detected ? "Detected" : "Missed",
      esc(ok(event.lead_weeks_vs_naive) ? integer(event.lead_weeks_vs_naive) : "—"),
    ]);
    const eventSection = `<section class="figure"><h3>Known events</h3>${table(["Event", "Date", "Desk", "Rule", "Delay, weeks", "Naive rule", "Lead, weeks"], eventRows)}<p class="meaning"><strong>What this means.</strong> A missed event is shown as Missed, not hidden. An episode already open in the event week does not count.</p></section>`;

    const rateCards = `<div class="kpis">
      ${kpi("Unexplained alarms · rule", summary.unexplained_per_series_year, (v) => fixed(v, 2))}
      ${kpi("Unexplained alarms · naive rule", summary.naive_unexplained_per_series_year, (v) => fixed(v, 2))}
    </div><p class="prose-line">Some unexplained alarms are real events that are not on the fixed list, so this is an upper bound on false alarms.</p>`;

    const allEpisodes = (radar.series || []).flatMap((item) =>
      (item.episodes || []).map((episode) => [item.product_group, episode]),
    );
    const allRows = allEpisodes.map(([name, episode]) => [
      esc(groupLabel(name)),
      esc(episode.start),
      esc(episode.end),
      esc(fixed(episode.peak_z, 2)),
      esc(episode.event_id ? groupLabel(episode.event_id) : "Unexplained"),
    ]);
    const list = `<section class="figure"><h3>Every episode</h3>${table(["Desk", "Start", "End", "Peak z", "Explained by"], allRows)}<p class="meaning"><strong>What this means.</strong> Episodes are runs of alarm weeks no more than a few weeks apart, dated by their first alarm week.</p></section>`;
    return `<div class="figure-grid">${pulse}</div>${eventSection}${rateCards}${list}${noveltyBlock(data)}`;
  }

  function noveltyBlock(data) {
    const radar = data.radar || {};
    const novelty = radar.novelty;
    const weekly = ((data.weekly || {}).novelty || {});
    if (!novelty || !ok(novelty.series) || !weekly.groups || !weekly.groups.length) {
      return notRun(
        "Text novelty was not run",
        "The result file does not contain a text novelty block, so no novelty figure or event table is shown.",
      );
    }
    const groups = weekly.groups.slice().sort();
    const first = groups[0];
    const events = novelty.events || [];
    const rows = events.map((event) => [
      esc(event.event_id),
      event.detected ? "Detected" : "Missed",
      esc(ok(event.delay_weeks) ? integer(event.delay_weeks) : "—"),
    ]);
    const rate = novelty.unexplained_per_series_year;
    return `<section class="prose reveal"><h2 class="section-head">Text novelty · exploratory</h2><p>This variant watches new words in published narratives on the event desks. It has no pass or fail rule.</p>
      <div class="chart" data-chart="novelty-weekly" data-group="${esc(first)}" role="img" aria-label="Weekly text novelty with alarm weeks"></div>
      <p class="caption">One line per week of mean novelty; alarm weeks are marked in the signal colour.</p>
      <p class="meaning"><strong>What this means.</strong> Unexplained alarms per series per year: ${esc(fixed(rate && rate.value, 2))}. ${esc(numLine(rate, (v) => fixed(v, 2)))}</p>
      <details class="exact"><summary>Exact numbers</summary>${table(["Event", "Rule", "Delay, weeks"], rows)}</details>
      <p class="prose-line">There are ${esc(fixed(rate && rate.value, 2))} unexplained alarms per series per year on this exploratory variant.</p></section>`;
  }

  function radarRule(rule) {
    return `<section class="prose reveal"><h2 class="section-head">The rule in plain steps</h2><ol class="steps">
      <li>Take the natural log of one plus each week's complaints.</li>
      <li>Compare it with the median of the previous ${esc(integer(rule.level_weeks))} weeks; that is the level.</li>
      <li>Remove the season using the same week ${esc(integer(52))}, ${esc(integer(104))} and so on weeks earlier, or zero when fewer than two years are available.</li>
      <li>Divide by one point four eight two six times the median absolute deviation of the last ${esc(integer(rule.scale_weeks))} weeks, with a floor, to get z.</li>
      <li>Raise an alarm when z is above ${esc(fixed(rule.limit, 1))} in this week and the week before; start watching at week ${esc(integer(rule.monitor_from_week))}.</li>
      <li>Join alarm weeks up to ${esc(integer(rule.episode_gap_weeks))} weeks apart into one episode, and score an event if an episode starts within ${esc(integer(rule.event_window_weeks))} weeks of it.</li>
      <li>The naive rule instead alarms when a week is above ${esc(fixed(rule.naive_ratio, 1))} times the mean of the previous ${esc(integer(rule.scale_weeks))} weeks in both weeks.</li>
    </ol></section>`;
  }

  // ---------------------------------------------------------------- quality

  function renderQuality(data) {
    const descriptive = data.descriptive || {};
    const byYear = descriptive.by_year || [];
    const usable = byYear.filter((row) => row.with_narrative > 0);
    const first = usable[0] || {};
    const last = usable[usable.length - 1] || {};
    const prior = usable[usable.length - 2] || {};
    const sentence = ok(last.year)
      ? `Narratives fall from ${pctFmt((prior.narrative_share || {}).value)} in ${esc(prior.year)} to ${pctFmt((last.narrative_share || {}).value)} in ${esc(last.year)}, so text results describe a smaller slice of complaints.`
      : "The narrative history is not available, so this page cannot describe the change.";
    const shareFigure = figure({
      id: "quality-narrative",
      title: "Share of complaints with a narrative, by year",
      chart: "quality-narrative",
      alt: "Bars of narrative share by year with intervals",
      meaning: `Narratives first appear in ${esc(first.year)}. By ${esc(last.year)} only ${integer(last.with_narrative)} of ${integer(last.complaints)} complaints carry one.`,
      headers: ["Year", "Complaints", "With a narrative", "Share"],
      rows: byYear.map((row) => [
        esc(row.year),
        esc(integer(row.complaints)),
        esc(integer(row.with_narrative)),
        numCell(row.narrative_share, pctFmt),
      ]),
    });
    const repeats = descriptive.repeats || [];
    const repeatFigure = figure({
      id: "quality-repeats",
      title: "Repeated text by year",
      chart: "quality-repeats",
      alt: "Bars of the share of narratives with repeated text by year",
      meaning: repeats.length
        ? `The largest reported share is ${pctFmt(repeats.reduce((a, b) => ((b.repeated_share || {}).value > (a.repeated_share || {}).value ? b : a)).repeated_share.value)} among published narratives.`
        : "No repeated-text figures were published.",
      headers: ["Year", "With a narrative", "Repeated-text share"],
      rows: repeats.map((row) => [esc(row.year), esc(integer(row.with_narrative)), numCell(row.repeated_share, pctFmt)]),
    });
    const taxonomy = descriptive.taxonomy || [];
    const rows = taxonomy.map((row) => [
      esc(row.product),
      esc(ok(row.sub_product) ? row.sub_product : "—"),
      esc(groupLabel(row.product_group)),
      esc(row.first_date),
      esc(row.last_date),
      esc(integer(row.complaints)),
    ]);
    const searchable = `<section class="figure"><h3>Product mapping table</h3><details class="exact"><summary>Show the full mapping (${esc(integer(rows.length))} rows)</summary>
      <label class="filter"><span>Search product, sub-product or desk</span><input type="search" id="taxonomy-search" placeholder="Type to filter"></label>
      <div id="taxonomy-holder">${table(["Source product", "Sub-product", "Desk", "First date", "Last date", "Complaints"], rows, "taxonomy-table")}</div>
      <p class="meaning"><strong>What this means.</strong> Eleven desks hold across three versions of the product list. This is the published mapping from source labels to desks.</p></details></section>`;
    const noise = descriptive.label_noise || {};
    const noiseBlock = `<section class="prose"><h3>Label noise</h3><p>Among ${integer(noise.complaints)} test complaints sharing text with another test complaint (${integer(noise.distinct_texts)} distinct texts), ${pctFmt((noise.modal_share || {}).value)} carry the most common desk for that text. A model sees only the text, so it cannot beat this on those complaints.</p><p class="mono small">${esc(numLine(noise.modal_share, pctFmt))}</p></section>`;
    const lastDate = (((data.descriptive || {}).totals || {}).last_date) || "";
    const year = lastDate.slice(0, 4);
    const caveats = `<section class="prose reveal"><h2 class="section-head">What this cannot show</h2><ul class="caveats">
      <li>Complaints are not a random sample of problems, and narratives are the subset whose authors agreed to publish.</li>
      <li>Labels are chosen by the consumer. A "wrong" prediction is sometimes the better label.</li>
      <li>Complaint counts are not incident counts. Nothing here measures any company's conduct.</li>
      <li>United States consumer finance only.</li>
      <li>The test period is small and unusual. Results on it describe that period.</li>
    </ul><p>July and August ${esc(year)} are left out of modelling because their narratives are incomplete.</p></section>`;
    return `${opener("DATA QUALITY · WHAT IS MISSING", sentence, "Read the two charts, then open the mapping table and the caveats.")}
      <div class="figure-grid">${shareFigure}${repeatFigure}</div>${searchable}${noiseBlock}${caveats}${nextCard("quality")}`;
  }

  // -------------------------------------------------------------------- try

  function renderTry() {
    const examples = [
      "My mortgage servicer keeps adding fees I never agreed to and will not explain my escrow account.",
      "A debt collector calls me every day about a debt I already paid and threatens to sue me.",
      "The credit bureau shows an account that is not mine and will not remove it after I disputed it.",
    ];
    const buttons = examples
      .map(
        (text, i) =>
          `<button type="button" class="example" data-example="${i}">Made-up example ${i + 1}</button>`,
      )
      .join("");
    return `${opener("TRY IT · THE SAME MODEL", `Type a complaint and watch the same words model tested here sort it into a desk, using only your browser.`, "The result shows the desk, the confidence against the threshold, and the terms that moved the decision.")}
      <section class="try-grid"><div class="card">
        <label class="input-label" for="try-text">A made-up complaint, or write your own</label>
        <textarea id="try-text" rows="7" placeholder="Describe the complaint in your own words…"></textarea>
        <div class="examples" role="group" aria-label="Made-up examples">${buttons}</div>
        <p class="caption">The three example buttons insert short made-up complaints written for this page.</p>
        <p id="try-status" class="status" aria-live="polite">The model has not been loaded yet. It loads when you first type or choose an example.</p>
      </div><div class="card result" id="try-result" aria-live="polite"><p class="muted">Your result will appear here.</p></div></section>
      <section class="prose reveal"><h2 class="section-head">How this works</h2><p>This is the same model that was tested in the router section. It runs in your browser and nothing you type is sent anywhere. The confidence bar shows where the answer sits against the automatic-routing threshold from the model file.</p></section>
      ${nextCard("try")}`;
  }

  return {
    TERMS,
    PAGES,
    esc,
    ok,
    fixed,
    integer,
    pct,
    pctFmt,
    wilson,
    badge,
    table,
    term,
    bar,
    figure,
    opener,
    nextCard,
    notRun,
    defaultFilters,
    renderIndex,
    renderVolumes,
    renderRouter,
    renderCost,
    renderRadar,
    renderQuality,
    renderTry,
    volumesDashboard,
    routerDashboard,
    radarDashboard,
    costResult,
    timeRows,
    seconds,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = Pages;
}
if (typeof window !== "undefined") {
  window.Pages = Pages;
}
