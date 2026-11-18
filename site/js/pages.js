"use strict";

// Pure render functions. Each takes data already read from site/data and returns an HTML
// string. No network calls, no DOM access, no globals written. Charts that need the real
// width of the page (timelines, scope, dot wall) are drawn later by charts.js and scope.js
// into the placeholders these functions emit.

const Pages = (() => {
  const PAGES = [
    ["index", "Overview", "index.html"],
    ["volumes", "Volumes", "volumes.html"],
    ["router", "Router", "router.html"],
    ["cost", "Cost", "cost.html"],
    ["radar", "Radar", "radar.html"],
    ["quality", "Data quality", "quality.html"],
    ["try", "Try it", "try.html"],
  ];

  const TERMS = {
    narrative: "The complaint text, present only when the consumer agreed to publish it.",
    desk: "The eleven product groups a complaint can be sent to; one group is one desk.",
    "macro-F1": "The average of the F1 scores for each product, so every product counts equally.",
    precision: "Of the complaints sent to a desk automatically, the share that are on the right desk.",
    coverage: "The share of complaints confident enough to be sent to a desk automatically.",
    "95% interval":
      "A range of values from resampling the complaints, built so that ninety-five of a hundred such ranges would contain the true value.",
    calibration: "Whether the stated confidence matches how often the prediction is actually right.",
    "zero-shot": "A language model given only the list of desks and the complaint.",
    "few-shot": "The same prompt, preceded by one example complaint for each desk.",
    alarm: "A week when the rule says a product desk suddenly filled up.",
    episode: "A run of alarm weeks no more than a few weeks apart.",
    "new text": "A test complaint whose text was not seen in any complaint received before the test period.",
  };

  // Pass rules from the analysis plan, written before any result existed. Rules, not results.
  const RULE = { precision: 0.95, coverage: 0.5 };

  // ---------------------------------------------------------------- helpers

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

  function signed(value, digits = 3) {
    if (!ok(value)) return "—";
    const v = Number(value);
    return `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(digits)}`;
  }

  function integer(value) {
    if (!ok(value)) return "—";
    return Math.round(Number(value)).toLocaleString("en-US");
  }

  function pct(value, digits = 1) {
    if (!ok(value)) return "—";
    return `${fixed(Number(value) * 100, digits)}%`;
  }

  const pctFmt = (value) => pct(value, 1);

  // Number formats shared by the markup and the count-up animation in site.js.
  const FORMATS = {
    pct1: (v) => pct(v, 1),
    int: (v) => integer(v),
    f2: (v) => fixed(v, 2),
    f3: (v) => fixed(v, 3),
    s3: (v) => signed(v, 3),
    times: (v) => `${integer(v)}×`,
  };

  function format(kind, value) {
    return (FORMATS[kind] || FORMATS.int)(value);
  }

  // A figure that counts up from zero when it scrolls into view; the final text is the markup.
  function count(value, kind) {
    if (!ok(value)) return "—";
    return `<span class="count" data-count="${esc(value)}" data-fmt="${esc(kind)}">${esc(format(kind, value))}</span>`;
  }

  function plain(value) {
    return String(value === null || value === undefined ? "" : value).replace(/<[^>]*>/g, "");
  }

  function groupLabel(group) {
    return ok(group) ? String(group).replaceAll("_", " ") : "not reported";
  }

  // Short desk name from a product name: text before the first comma, "or other ..." dropped.
  function deskName(product) {
    return String(product).split(",")[0].replace(/\s+or other.*$/i, "");
  }

  function term(key, label) {
    return `<button type="button" class="term" data-term="${esc(key)}" aria-haspopup="dialog">${esc(label || key)}</button>`;
  }

  function interval(num, fmt) {
    if (!num || !ok(num.ci_low) || !ok(num.ci_high)) return "interval not published";
    return `${fmt(num.ci_low)} to ${fmt(num.ci_high)}`;
  }

  // The quiet second line under every estimate: its 95% interval and n.
  function ciLine(num, fmt = pctFmt) {
    if (!num || !ok(num.value)) return "Not reported in the result file.";
    const n = ok(num.n) ? ` · n = ${integer(num.n)}` : "";
    return `95% interval ${interval(num, fmt)}${n}`;
  }

  function ci(num, fmt = pctFmt) {
    return `<span class="ci">${esc(ciLine(num, fmt))}</span>`;
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
    const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    return { value: centre, ci_low: Math.max(0, centre - half), ci_high: Math.min(1, centre + half), n };
  }

  function badge(flag, big = false) {
    const size = big ? " big" : "";
    if (!ok(flag)) return `<span class="badge idle${size}">NOT RUN</span>`;
    return `<span class="badge ${flag ? "pass" : "fail"}${size}"><span aria-hidden="true">${flag ? "✓" : "×"}</span> ${flag ? "PASS" : "FAIL"}</span>`;
  }

  // Responsive table: at phone width each row becomes a stacked block labelled by data-label.
  function table(headers, rows, className = "") {
    const head = headers.map((header) => `<th scope="col">${header}</th>`).join("");
    const body = rows
      .map(
        (row) =>
          `<tr>${row.map((cell, i) => `<td data-label="${esc(plain(headers[i] || ""))}">${cell}</td>`).join("")}</tr>`,
      )
      .join("");
    return `<table class="${esc(className)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function numCell(num, fmt = pctFmt) {
    if (!num || !ok(num.value)) return '<span class="muted">not reported</span>';
    return `<span class="n">${esc(fmt(num.value))}</span>${ci(num, fmt)}`;
  }

  function notRun(title, detail) {
    return `<section class="band"><div class="wrap"><div class="panel notrun"><span class="badge idle big">NOT RUN</span><h2>${esc(title)}</h2><p>${esc(detail)}</p></div></div></section>`;
  }

  function eventName(event) {
    return String(event.title || groupLabel(event.event_id));
  }

  // One short sentence under a chart.
  function note(text) {
    return `<p class="note">${text}</p>`;
  }

  // Interval bar: a fill to the value, a whisker for the 95% interval and an optional rule line.
  // o: {label, num, fmt, domain:[lo,hi], mark, markLabel, tone, sub}
  function ibar(o) {
    const fmt = o.fmt || pctFmt;
    const num = o.num;
    if (!num || !ok(num.value)) {
      return `<div class="ibar"><div class="ibar-head"><span>${o.label}</span><b>not reported</b></div></div>`;
    }
    const [d0, d1] = o.domain || [0, 1];
    const at = (x) => Math.max(0, Math.min(100, ((Number(x) - d0) / (d1 - d0)) * 100));
    const zero = at(0);
    const v = at(num.value);
    const lo = ok(num.ci_low) ? at(num.ci_low) : v;
    const hi = ok(num.ci_high) ? at(num.ci_high) : v;
    const fillLeft = Math.min(zero, v);
    const fillWidth = Math.abs(v - zero);
    const mark = ok(o.mark)
      ? `<i class="ibar-mark${at(o.mark) > 70 ? " end" : ""}" style="left:${at(o.mark)}%"><em>${esc(o.markLabel || "")}</em></i>`
      : "";
    const zeroTick = d0 < 0 ? `<i class="ibar-zero" style="left:${zero}%"></i>` : "";
    const aria = `${plain(o.label)}: ${fmt(num.value)}, 95% interval ${interval(num, fmt)}`;
    return `<div class="ibar ${o.tone || ""}${ok(o.mark) ? " has-mark" : ""}" style="--i:${o.i || 0}">
      <div class="ibar-head"><span>${o.label}</span><b>${esc(fmt(num.value))}</b></div>
      <div class="ibar-track" role="img" aria-label="${esc(aria)}">${zeroTick}<i class="ibar-fill grow-x" style="left:${fillLeft}%;width:${fillWidth}%"></i><i class="ibar-ci" style="left:${lo}%;width:${Math.max(0, hi - lo)}%"></i>${mark}</div>
      <p class="ci">${esc(ciLine(num, fmt))}${o.sub ? ` · ${esc(o.sub)}` : ""}</p></div>`;
  }

  function stat(label, valueHtml, sub = "") {
    return `<div class="stat"><p class="stat-label">${label}</p><p class="stat-value">${valueHtml}</p>${sub ? `<p class="ci">${esc(sub)}</p>` : ""}</div>`;
  }

  function nextBand(name) {
    const index = PAGES.findIndex((page) => page[0] === name);
    const next = PAGES[(index + 1) % PAGES.length];
    return `<a class="next-band" href="${next[2]}"><span class="wrap"><span class="next-label">Next</span><span class="next-title">${esc(next[1])}</span><svg class="next-arrow" viewBox="0 0 48 24" aria-hidden="true"><path d="M2 12h42M32 2l12 10-12 10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span></a>`;
  }

  // Page opener: a giant number from the data, a sentence, optional extras.
  function opener(o) {
    return `<header class="opener band"><div class="glow" aria-hidden="true"></div><div class="wrap">
      <p class="label">${o.label}</p>
      <h1><span class="hero-num draw" style="--ch:${Math.max(4, plain(o.num).length)}">${o.num}</span><span class="hero-line">${o.line}</span></h1>
      ${o.sub ? `<p class="ci hero-ci">${esc(o.sub)}</p>` : ""}
      ${o.extra || ""}</div></header>`;
  }

  function section(id, label, title, body, cls = "") {
    return `<section class="band draw ${cls}"${id ? ` id="${esc(id)}"` : ""}><div class="wrap">
      ${label ? `<p class="label">${label}</p>` : ""}${title ? `<h2 class="section-title">${title}</h2>` : ""}${body}</div></section>`;
  }

  function verdictWords(verdict) {
    if (verdict === "llm_better") return "The language model is more accurate on this sample.";
    if (verdict === "small_model_better") return "The small model is more accurate on this sample.";
    if (verdict === "no_detectable_difference") return "The test cannot tell the two models apart.";
    return "The result has not been published.";
  }

  // seconds with two or three significant figures, never a rounded-to-zero value
  function seconds(value) {
    const v = Number(value);
    if (!ok(value) || !Number.isFinite(v)) return "—";
    return v >= 100 ? `${integer(Math.round(v))} s` : v >= 1 ? `${v.toFixed(1)} s` : `${v.toFixed(2)} s`;
  }

  // A length of time in the unit a reader thinks in: seconds, minutes or hours.
  function duration(value) {
    const v = Number(value);
    if (!ok(value) || !Number.isFinite(v)) return "—";
    if (v < 100) return seconds(v);
    if (v < 7200) return `${(v / 60).toFixed(v < 600 ? 1 : 0)} min`;
    return `${(v / 3600).toFixed(1)} hours`;
  }

  const CAVEATS = [
    "Complaints are not a random sample of problems, and narratives are the subset whose authors agreed to publish.",
    'Labels are chosen by the consumer. A "wrong" prediction is sometimes the better label.',
    "Complaint counts are not incident counts. Nothing here measures any company's conduct.",
    "United States consumer finance only.",
    "The test period is small and unusual. Results on it describe that period.",
  ];

  function caveatList() {
    return `<ul class="caveats">${CAVEATS.map((text, i) => `<li><span class="cav-n" aria-hidden="true">${i + 1}</span><span>${esc(text)}</span></li>`).join("")}</ul>`;
  }

  // ---------------------------------------------------------------- overview

  function chapter(o) {
    return `<section class="band chapter ${o.flip ? "flip" : ""} draw" id="${o.id}"><div class="wrap grid">
      <div class="ch-text"><p class="label">${o.label}</p>
        <div class="hero-num sm">${o.num}</div><p class="ci">${esc(o.numNote)}</p>
        <h2 class="ch-q">${o.question}</h2><p class="ch-sentence">${o.text}</p>
        <p class="ch-foot">${o.badge}<a class="link-arrow" href="${o.href}">${o.link}<svg viewBox="0 0 24 12" aria-hidden="true"><path d="M1 6h20M16 1l6 5-6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a></p></div>
      <div class="ch-visual panel">${o.visual}</div></div></section>`;
  }

  function h1Chapter(data) {
    const evalData = data.llmEval;
    if (!evalData || !evalData.h1) {
      return chapter({
        id: "t1", label: "Test 1 · The language model", num: "not run", numNote: "No result file yet",
        question: "Does a large language model beat the small trained model?",
        text: "The long model run has not written its result file, so nothing is drawn and no result is shown.",
        badge: badge(null, true), href: "cost.html", link: "What is planned",
        visual: '<p class="empty">Not run. No figure is shown until the result file exists.</p>',
      });
    }
    const h1 = evalData.h1;
    const chosen = evalData.chosen_variant === "few_shot" ? "few-shot" : "zero-shot";
    const variant = (evalData.variants || {})[evalData.chosen_variant] || {};
    const llm = (variant.test || {}).macro_f1;
    const words = ((evalData.same_sample || {}).words || {}).macro_f1;
    const diff = h1.difference || {};
    const reach = Math.max(Math.abs(Number(diff.ci_low) || 0), Math.abs(Number(diff.ci_high) || 0), Math.abs(Number(diff.value) || 0)) * 1.3 || 0.1;
    return chapter({
      id: "t1", label: "Test 1 · The language model",
      num: count(diff.value, "s3"), numNote: `Macro-F1, language model minus words model. ${ciLine(diff, (v) => signed(v, 3))}`,
      question: "Does a large language model beat the small trained model?",
      text: `${esc(verdictWords(h1.verdict))} Both were scored on the same fixed sample, on an equal mix of products.`,
      badge: badge(h1.pass, true), href: "cost.html", link: "See the cost evidence",
      visual: `${ibar({ label: `Language model, ${chosen}`, num: llm, tone: "tone-llm" })}
        ${ibar({ label: "Words model, same sample", num: words, tone: "tone-words", i: 1 })}
        ${ibar({ label: "Paired difference", num: diff, fmt: (v) => signed(v, 3), domain: [-reach, reach], tone: "tone-diff", i: 2 })}`,
      flip: false,
    });
  }

  function h2Chapter(router) {
    const h2 = router.h2 || {};
    const precisionTone = ok(h2.precision && h2.precision.value) && h2.precision.value >= RULE.precision ? "tone-ok" : "tone-bad";
    const coverageTone = ok(h2.coverage && h2.coverage.value) && h2.coverage.value >= RULE.coverage ? "tone-ok" : "tone-bad";
    return chapter({
      id: "t2", label: "Test 2 · Automatic routing",
      num: count(h2.precision && h2.precision.value, "pct1"),
      numNote: `Right desk, among complaints sent on automatically. ${ciLine(h2.precision)}`,
      question: "Can half of all complaints go to a desk with no person, at least 95% right?",
      text: "Both lines had to be crossed. The marked line on each bar is the rule.",
      badge: badge(h2.pass, true), href: "router.html", link: "See the router evidence",
      visual: `${ibar({ label: `Right desk (${term("precision")})`, num: h2.precision, mark: RULE.precision, markLabel: "95% needed", tone: precisionTone })}
        ${ibar({ label: `Sent automatically (${term("coverage")})`, num: h2.coverage, mark: RULE.coverage, markLabel: "50% needed", tone: coverageTone, i: 1 })}`,
      flip: true,
    });
  }

  function h3Chapter(radar) {
    const events = radar.events || [];
    const summary = radar.summary || {};
    const rate = summary.unexplained_per_series_year;
    const list = events
      .map(
        (event) => `<li class="ev ${event.detected ? "hit" : "miss"}"><span class="ev-dot" aria-hidden="true"></span><span class="ev-name">${esc(eventName(event))}<small>${esc(event.event_date)} · ${esc(groupLabel(event.product_group))}</small></span><span class="ev-state">${event.detected ? "caught" : "missed"}</span></li>`,
      )
      .join("");
    return chapter({
      id: "t3", label: "Test 3 · The radar",
      num: `${count(summary.detected, "int")}<span class="of"> of ${esc(integer(summary.events))}</span>`,
      numNote: `Known events caught. ${ciLine(summary.detection_rate)}`,
      question: "Would a simple alarm rule catch known events without crying wolf?",
      text: `Lime: the rule raised an alarm in time. Coral: it stayed silent. ${esc(fixed(rate && rate.value, 2))} unexplained alarms per series per year.`,
      badge: badge((radar.h3 || {}).pass, true), href: "radar.html", link: "See the radar evidence",
      visual: `<ul class="events">${list}</ul><p class="ci">Unexplained alarms per series per year: ${esc(fixed(rate && rate.value, 2))} · ${esc(ciLine(rate, (v) => fixed(v, 2)))}</p>`,
      flip: false,
    });
  }

  // Dot wall rows: one per desk, sorted by complaints sent there. Each dot is one in a thousand test complaints.
  function wallRows(router) {
    const auto = ((router.models || {}).words || {}).auto_route || {};
    const total = ((auto.test || {}).coverage || {}).n;
    const rows = (auto.by_product || []).filter((row) => ok(row.coverage && row.coverage.n) && ok(total) && total > 0);
    return rows
      .map((row) => {
        const sent = Math.round((row.coverage.n / total) * 1000);
        const routed = Math.min(sent, Math.round((row.precision.n / total) * 1000));
        const right = Math.round(routed * (row.precision.value || 0));
        return { row, sent, routed, right, wrong: routed - right, person: sent - routed };
      })
      .sort((a, b) => b.sent - a.sent);
  }

  function wallHtml(router) {
    const rows = wallRows(router);
    if (!rows.length) return '<p class="empty">The routing result is not available.</p>';
    return `<div class="wall draw" role="group" aria-label="One thousand test complaints sorted by desk">${rows
      .map(
        (r, i) => `<div class="wall-row" style="--i:${i}"><div class="wall-label"><b>${esc(deskName(r.row.product))}</b><span class="ci">${esc(integer(r.sent))} of 1,000 sent here · ${esc(pct(r.row.precision.value))} right when routed</span><span class="ci wall-ci">${esc(ciLine(r.row.precision))}</span></div>
          <canvas class="wall-canvas" data-right="${r.right}" data-wrong="${r.wrong}" data-person="${r.person}" role="img" aria-label="${esc(`${deskName(r.row.product)}: ${r.right} routed right, ${r.wrong} routed wrong, ${r.person} left to a person, out of every 1,000 complaints`)}"></canvas></div>`,
      )
      .join("")}</div>
      <ul class="legend" aria-label="Key"><li><i class="dot ok"></i>Routed to the right desk</li><li><i class="dot bad"></i>Routed to the wrong desk</li><li><i class="dot off"></i>A person decides</li></ul>`;
  }

  function renderIndex(data) {
    const router = data.router || {};
    const radar = data.radar || {};
    const h2 = router.h2 || {};
    const flags = [data.llmEval && data.llmEval.h1 ? data.llmEval.h1.pass : null, h2.pass, radar.h3 ? radar.h3.pass : null];
    const known = flags.filter((flag) => ok(flag));
    const passed = known.filter((flag) => flag === true).length;
    const failed = known.length - passed;
    const unrun = flags.length - known.length;
    const lede =
      known.length === 3
        ? `${failed === 3 ? "All three failed." : `${integer(failed)} failed.`} A language model, an automatic router and an alarm rule were each held to a rule written down before any result existed. Nothing was softened.`
        : `${integer(unrun)} of the three tests have no result file and are shown as not run. The rest were held to rules written down in advance.`;
    const names = ["The language model", "Automatic routing", "The radar"];
    const pills = flags
      .map((flag, i) => `<a class="flag ${ok(flag) ? (flag ? "pass" : "fail") : "idle"}" href="#t${i + 1}"><span>Test ${i + 1} · ${names[i]}</span>${badge(flag)}</a>`)
      .join("");
    const events = radar.events || [];
    const keyEvents = events.length
      ? `<ol class="scope-key-events">${events.map((event, i) => `<li class="${event.detected ? "hit" : "miss"}"><b>${i + 1}</b> ${esc(eventName(event))} · ${event.detected ? "caught" : "missed"}</li>`).join("")}</ol>`
      : "";
    const weeks = radar.weeks || {};
    const hero = `<header class="hero band"><div class="glow" aria-hidden="true"></div><div class="wrap">
        <p class="label">Complaint Radar · bank complaints as a signal-detection test</p>
        <h1 class="hero-title">Three tests.<br><span class="hero-hl">${esc(["None", "One", "Two", "All three"][passed] || String(passed))}</span> passed.</h1>
        <p class="lede">${esc(lede)}</p>
        <div class="flags">${pills}</div></div>
      <div class="scope" data-scope><canvas class="scope-canvas" role="img" aria-label="A radar scope. A sweep line turns once through the weeks from ${esc(weeks.first || "the first week")} to ${esc(weeks.last || "the last week")}. Each blip is one alarm episode; lime when it matched a known event, coral when unexplained."></canvas><ul class="scope-labels" aria-label="Known events on the rim"></ul></div>
      <div class="wrap scope-foot"><div class="legend"><span><i class="dot ok"></i>Alarm that matched a known event</span><span><i class="dot bad"></i>Unexplained alarm</span><span><i class="ring bad"></i>Event the rule missed</span></div>
      <p class="note">Clockwise from the top is time, ${esc(weeks.first || "")} to ${esc(weeks.last || "")}. Rings, centre outwards: ${esc((radar.series || []).map((s) => groupLabel(s.product_group)).join(", "))}. Blip size is the number of alarm weeks.</p>${keyEvents}</div></header>`;

    const chapters = `${h1Chapter(data)}${h2Chapter(router)}${h3Chapter(radar)}`;

    const coverage = h2.coverage;
    const precision = h2.precision;
    const routed = ok(coverage && coverage.value) ? Math.round(Number(coverage.value) * 1000) : null;
    const wrong = ok(routed) && ok(precision && precision.value) ? Math.round(routed * (1 - Number(precision.value))) : null;
    const sentence = ok(routed)
      ? `Of every 1,000 complaints, <em>${integer(routed)}</em> can be sent to a desk without a person. <em>${integer(wrong)}</em> of those land on the wrong desk.`
      : "The routing result is not available, so this page cannot say how many complaints can be sent without a person.";
    const room = section(
      "room", "The sorting room", sentence,
      `<p class="lede">Each dot is one of every thousand test complaints, sorted into the desk the model chose.</p>${wallHtml(router)}
      <div class="stats">${stat(`Sent automatically · ${term("coverage")}`, pctFmt(coverage && coverage.value), ciLine(coverage))}${stat(`Right desk · ${term("precision")}`, pctFmt(precision && precision.value), ciLine(precision))}${stat("Test 2 rule", badge(h2.pass, true), "At least 50% sent, at least 95% right.")}</div>`,
      "room",
    );

    const totals = (data.descriptive || {}).totals || {};
    const dataFacts = section(
      "data", "The data in one paragraph", `${integer(totals.complaints)} complaints, ${integer(totals.with_narrative)} with a story`,
      `<div class="stats">${stat("Complaints", esc(integer(totals.complaints)), "exact count")}${stat(`With a ${term("narrative")}`, esc(integer(totals.with_narrative)), "exact count")}${stat("Companies", esc(integer(totals.companies)), "exact count")}${stat("Received", `<span class="small-val">${esc(ok(totals.first_date) ? totals.first_date : "—")} to ${esc(ok(totals.last_date) ? totals.last_date : "—")}</span>`, "")}</div>
      <p class="lede">Of the complaints that got a response, ${esc(pctFmt((totals.timely_rate || {}).value))} were timely and ${esc(pctFmt((totals.monetary_relief_rate || {}).value))} ended in monetary relief. ${esc(ciLine(totals.monetary_relief_rate))}</p>`,
    );
    const caveats = section("caveats", "What this is and is not", "Read the results with these limits", caveatList());
    return `${hero}${chapters}${room}${caveats}${dataFacts}${nextBand("index")}`;
  }

  // ---------------------------------------------------------------- volumes

  function defaultFilters() {
    return { group: "all", company: "all", year: "all" };
  }

  function chipSelect(label, name, values, selected, allLabel) {
    const options = [`<option value="all"${selected === "all" ? " selected" : ""}>${esc(allLabel)}</option>`]
      .concat(values.map((value) => `<option value="${esc(value)}"${String(selected) === String(value) ? " selected" : ""}>${esc(plain(value).replaceAll("_", " "))}</option>`))
      .join("");
    return `<label class="chip-select"><span>${esc(label)}</span><select data-filter="${esc(name)}">${options}</select></label>`;
  }

  function sumRows(rows, index) {
    return rows.reduce((total, row) => total + (Number(row[index]) || 0), 0);
  }

  // Cube rows: [year, group, company, complaints, narratives, responded, timely, money, relief].
  function cubeRows(volume, filters, ignore) {
    const { groups = [], companies = [], years = [], cube = [] } = volume;
    return cube.filter(
      (row) =>
        (ignore === "year" || filters.year === "all" || String(years[row[0]]) === String(filters.year)) &&
        (ignore === "group" || filters.group === "all" || groups[row[1]] === filters.group) &&
        (ignore === "company" || filters.company === "all" || companies[row[2]] === filters.company),
    );
  }

  // Monthly rows: [month, group, complaints, narratives, ...]. They carry no company split.
  function monthlySeries(data, filters) {
    const volume = data.volumes || {};
    const { groups = [], months = [], monthly = [] } = volume;
    const keep = monthly.filter(
      (row) =>
        (filters.group === "all" || groups[row[1]] === filters.group) &&
        (filters.year === "all" || String(months[row[0]]).startsWith(String(filters.year))),
    );
    const byMonth = months.map((label, i) => {
      const rows = keep.filter((row) => row[0] === i);
      return { label, complaints: sumRows(rows, 2), narratives: sumRows(rows, 3) };
    });
    return byMonth.filter((row) => row.complaints > 0);
  }

  function rankList(rows, tone = "") {
    if (!rows.length) return '<p class="empty">No complaints in this selection.</p>';
    const peak = Math.max(...rows.map((row) => row[1]), 1);
    return `<ol class="rank draw ${tone}">${rows
      .map(
        (row, i) => `<li style="--i:${i}"><span class="rank-name">${esc(row[0])}</span><span class="rank-bar"><i class="grow-x" style="width:${Math.max(0.6, (row[1] / peak) * 100)}%"></i></span><b>${esc(integer(row[1]))}</b></li>`,
      )
      .join("")}</ol>`;
  }

  function columns(items, o = {}) {
    // items: [{label, short, value, text, tone}]; heights are relative to the tallest column.
    const peak = Math.max(...items.map((item) => item.value), o.peak || 0, 0.000001);
    return `<div class="cols draw" style="--n:${items.length}" role="img" aria-label="${esc(o.alt || "Column chart")}">${items
      .map(
        (item, i) => `<div class="col ${item.tone || ""}" style="--i:${i}" title="${esc(`${item.label}: ${item.text}`)}"><span class="col-val">${esc(item.text)}</span><span class="col-bar"><i class="grow-y" style="height:${Math.max(0.8, (item.value / peak) * 100)}%"></i></span><span class="col-label"><span class="y-long">${esc(item.label)}</span><span class="y-short">${esc(item.short || item.label)}</span></span></div>`,
      )
      .join("")}</div>`;
  }

  function volumesDashboard(data, filters) {
    const volume = data.volumes || {};
    const { groups = [], companies = [], years = [], states = [] } = volume;
    const all = cubeRows(volume, filters, "");
    const complaints = sumRows(all, 3);
    const narrative = sumRows(all, 4);
    const responded = sumRows(all, 5);
    const timely = sumRows(all, 6);
    const money = sumRows(all, 7);
    const kpis = `<div class="stats tiles">
      ${stat("Complaints", count(complaints, "int"), "exact count")}
      ${stat(`With a ${term("narrative")}`, pctFmt(wilson(narrative, complaints).value), ciLine(wilson(narrative, complaints)))}
      ${stat("Timely response", pctFmt(wilson(timely, responded).value), ciLine(wilson(timely, responded)))}
      ${stat("Monetary relief", pctFmt(wilson(money, responded).value), ciLine(wilson(money, responded)))}</div>`;

    const byYear = years
      .map((year, yi) => [year, sumRows(cubeRows(volume, filters, "year").filter((row) => row[0] === yi), 3)])
      .filter((row) => row[1] > 0);
    const yearChart = byYear.length
      ? columns(byYear.map(([year, value]) => ({ label: String(year), short: `’${String(year).slice(2)}`, value, text: compact(value) })), { alt: "Complaints by year" })
      : '<p class="empty">No complaints in this selection.</p>';

    const byGroup = groups
      .map((group, gi) => [groupLabel(group), sumRows(cubeRows(volume, filters, "group").filter((row) => row[1] === gi), 3)])
      .filter((row) => row[1] > 0).sort((a, b) => b[1] - a[1]);
    const byCompany = companies
      .map((company, ci) => [company, sumRows(cubeRows(volume, filters, "company").filter((row) => row[2] === ci), 3)])
      .filter((row) => row[1] > 0).sort((a, b) => b[1] - a[1]);
    const stateMap = states
      .filter((row) => filters.year === "all" || String(row[1]) === String(filters.year))
      .reduce((map, row) => map.set(row[0], (map.get(row[0]) || 0) + Number(row[2])), new Map());
    const byState = [...stateMap.entries()].filter((row) => row[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 12);

    const months = monthlySeries(data, filters);
    const peak = months.reduce((a, b) => (b.narratives > a.narratives ? b : a), { narratives: 0, label: "—" });
    const last = months[months.length - 1];
    const monthlySentence = months.some((m) => m.narratives > 0)
      ? `Narratives peak at ${integer(peak.narratives)} in ${peak.label} and stand at ${integer(last.narratives)} in ${last.label}, while all complaints keep rising.`
      : "No narratives were published in this selection.";
    const top = byYear.length ? byYear.reduce((a, b) => (b[1] > a[1] ? b : a)) : null;

    return `${kpis}
      <div class="grid dash">
        <div class="panel span-12"><h3>Complaints by year</h3>${yearChart}${note(top ? `The tallest column is ${esc(integer(top[1]))} complaints in ${esc(top[0])}.` : "")}</div>
        <div class="panel span-12"><h3>Every month: all complaints and those with a narrative</h3><div class="viz" data-viz="monthly"></div>${note(`${esc(monthlySentence)} This series has no company split, so it follows the desk and year filters only.`)}</div>
        <div class="panel span-6"><h3>By desk</h3>${rankList(byGroup)}${note(byGroup.length ? `${esc(byGroup[0][0])} is the largest desk here.` : "")}</div>
        <div class="panel span-6"><h3>By company</h3>${rankList(byCompany, "companies")}${note("The longest bar is the company with the most complaints here; it is not a measure of conduct.")}</div>
        <div class="panel span-12"><h3>Top states</h3>${rankList(byState, "states")}${note("States are ordered by complaint count only; population is not adjusted for.")}</div>
      </div>`;
  }

  // 1,234,567 -> 1.2M, 12,345 -> 12k, for column tops only; exact figures live in the title text.
  function compact(value) {
    const v = Number(value);
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return String(Math.round(v));
  }

  function renderVolumes(data, filters) {
    const chosen = filters || defaultFilters();
    const volume = data.volumes || {};
    const totals = (data.descriptive || {}).totals || {};
    const bar = `<div class="filterbar"><div class="wrap"><div class="filters" role="group" aria-label="Filter the complaint volumes">
      ${chipSelect("Desk", "group", volume.groups || [], chosen.group, "All desks")}
      ${chipSelect("Company", "company", volume.companies || [], chosen.company, "All companies")}
      ${chipSelect("Year", "year", volume.years || [], chosen.year, "All years")}
      <button type="button" class="chip reset" id="vol-reset" hidden>Reset</button></div></div></div>`;
    const head = opener({
      label: "Volumes · who complains",
      num: count(totals.complaints, "int"),
      line: `complaints in the archive. <b>${esc(pctFmt((totals.narrative_share || {}).value))}</b> carry a ${term("narrative")}.`,
      sub: `Share with a narrative: ${ciLine(totals.narrative_share)}`,
    });
    return `${head}${bar}<section class="band dashboard"><div class="wrap"><div id="vol-dashboard">${volumesDashboard(data, chosen)}</div>
      <p class="note lg">Complaint counts are not incident counts. Bigger companies receive more complaints, and no rate here is adjusted for size.</p></div></section>${nextBand("volumes")}`;
  }

  // ----------------------------------------------------------------- router

  const MODEL_NAMES = {
    words: ["Words", "TF-IDF + logistic regression"],
    embeddings: ["Embeddings", "MiniLM + logistic regression"],
    majority: ["Majority", "always the commonest desk"],
  };

  function leaderboard(models, key) {
    const rows = ["majority", "words", "embeddings"]
      .map((name) => ({ name, metrics: (models[name] || {})[key] || {} }))
      .sort((a, b) => ((b.metrics.macro_f1 || {}).value || 0) - ((a.metrics.macro_f1 || {}).value || 0));
    return `<ol class="board draw">${rows
      .map((row, i) => {
        const tone = row.name === "words" ? "tone-words" : row.name === "embeddings" ? "tone-emb" : "tone-grey";
        const acc = row.metrics.accuracy;
        return `<li><span class="board-rank" aria-hidden="true">${i + 1}</span><div class="board-main"><p class="board-name"><b>${esc(MODEL_NAMES[row.name][0])}</b> <span>${esc(MODEL_NAMES[row.name][1])}</span></p>
          ${ibar({ label: term("macro-F1"), num: row.metrics.macro_f1, tone, i })}
          <p class="ci">Accuracy ${esc(pctFmt(acc && acc.value))} · ${esc(ciLine(acc))} · calibration error ${esc(fixed(row.metrics.ece, 3))}</p></div></li>`;
      })
      .join("")}</ol>`;
  }

  function levelOf(share) {
    return share < 0.005 ? 0 : share < 0.04 ? 1 : share < 0.2 ? 2 : share < 0.5 ? 3 : 4;
  }

  // Confusion matrix as a heatmap: diagonal in lime (right desk), the rest in coral (wrong desk).
  function heatmap(matrix, products) {
    if (!matrix.length) return '<p class="empty">No confusion matrix was published.</p>';
    const names = products.map(deskName);
    const head = `<span class="hm-corner"></span>${names.map((name, j) => `<span class="hm-col" title="${esc(name)}">${j + 1}</span>`).join("")}`;
    const body = matrix
      .map((row, i) => {
        const total = row.reduce((a, b) => a + b, 0) || 1;
        const cells = row
          .map((value, j) => {
            const share = value / total;
            const level = levelOf(share);
            return `<span class="hm-cell ${i === j ? "right" : "wrong"} l${level}" title="${esc(`True ${names[i]}, sent to ${names[j]}: ${integer(value)} complaints (${pct(share, 1)} of that desk)`)}">${level >= 2 ? Math.round(share * 100) : ""}</span>`;
          })
          .join("");
        return `<span class="hm-row" title="${esc(names[i])}"><b>${i + 1}</b><span class="hm-name">${esc(names[i])}</span></span>${cells}`;
      })
      .join("");
    return `<div class="heatmap draw" style="--k:${matrix.length}" role="img" aria-label="Confusion matrix of the words model, rows true desk, columns chosen desk">${head}${body}</div>
      <ol class="hm-key">${names.map((name, i) => `<li><b>${i + 1}</b> ${esc(name)}</li>`).join("")}</ol>`;
  }

  function dateFraction(date, from, to) {
    const a = Date.parse(from);
    const b = Date.parse(to);
    return Math.max(0, Math.min(1, (Date.parse(date) - a) / (b - a)));
  }

  function splitTimeline(split) {
    const parts = ["train", "validation", "test"].map((name) => [name, split[name] || {}]).filter(([, p]) => ok(p.from) && ok(p.to));
    if (parts.length < 3) return '<p class="empty">The split was not published.</p>';
    const from = parts[0][1].from;
    const to = parts[2][1].to;
    const span = (p) => {
      const l = dateFraction(p.from, from, to) * 100;
      const r = dateFraction(p.to, from, to) * 100;
      return `left:${l}%;width:${Math.max(r - l, 1)}%`;
    };
    const startYear = new Date(from).getUTCFullYear();
    const endYear = new Date(to).getUTCFullYear();
    let ticks = "";
    for (let y = startYear + 1; y <= endYear; y++) {
      ticks += `<i class="tl-tick" style="left:${dateFraction(`${y}-01-01`, from, to) * 100}%"><em>${y}</em></i>`;
    }
    return `<div class="timeline draw"><div class="tl-axis">${ticks}${parts
      .map(([name, p], i) => `<span class="tl-band ${name}" style="${span(p)};--i:${i}"><b>${name}</b></span>`)
      .join("")}</div>
      <ul class="tl-legend">${parts
        .map(([name, p]) => `<li class="${name}"><b>${name}</b><span>${esc(p.from)} to ${esc(p.to)}</span><span class="ci">${esc(integer(p.rows))} complaints${name === "test" && ok(p.new_text_rows) ? ` · ${esc(integer(p.new_text_rows))} of them new text` : ""}</span></li>`)
        .join("")}</ul></div>`;
  }

  function routerDashboard(data, view) {
    const router = data.router || {};
    const models = router.models || {};
    const key = view === "new" ? "test_new_text" : "test";
    const words = models.words || {};
    const metrics = words[key] || {};
    const label = view === "new" ? "new text only" : "all test complaints";

    const board = `<div class="panel span-12"><h3>Model leaderboard · ${esc(label)}</h3>${leaderboard(models, key)}${note("Bars start at zero. The whisker is the 95% interval from resampling complaints; it is too narrow, because complaints are not independent.")}</div>`;

    const heat = `<div class="panel span-7"><h3>Where the words model sends complaints</h3>${heatmap(metrics.confusion || [], router.products || [])}${note("Rows are the true desk, columns the chosen desk. Lime is right, coral is wrong; each cell is a share of its row.")}</div>`;

    const bins = metrics.reliability || [];
    const calibration = `<div class="panel span-5"><h3>Confidence against accuracy</h3><div class="viz" data-viz="reliability"></div>${note(`Points on the diagonal would be perfectly ${term("calibration", "calibrated")}. Calibration error is ${esc(fixed(metrics.ece, 3))}, n = ${esc(integer((metrics.macro_f1 || {}).n))}.`)}<span class="sr-only">${bins.length} confidence bins.</span></div>`;

    const auto = words.auto_route || {};
    const routeRows = (auto.by_product || []).map((row) =>
      `<li><span class="rank-name">${esc(deskName(row.product))}</span>${ibar({ label: "Right desk", num: row.precision, mark: RULE.precision, markLabel: "95%", tone: ok(row.precision && row.precision.value) && row.precision.value >= RULE.precision ? "tone-ok" : "tone-bad", sub: `${pctFmt(row.coverage && row.coverage.value)} of complaints sent here are routed` })}</li>`,
    );
    const route = `<div class="panel span-12"><h3>Automatic routing by desk</h3><p class="route-top">At threshold ${esc(fixed(auto.threshold, 3))}: ${esc(pctFmt((auto.test || {}).coverage && auto.test.coverage.value))} of complaints sent automatically, ${esc(pctFmt((auto.test || {}).precision && auto.test.precision.value))} of those right. ${esc(ciLine((auto.test || {}).precision))}</p><ul class="routes draw">${routeRows.join("")}</ul>${note(`Per desk means per predicted desk. The ${term("precision")} bar shows each desk against the 95% line.`)}</div>`;

    const inMacro = new Map((router.class_counts || []).map((row) => [row.product, row.in_macro_f1]));
    const perRows = (metrics.per_product || []).map((row) => [
      esc(deskName(row.product)), esc(fixed(row.precision, 3)), esc(fixed(row.recall, 3)), esc(fixed(row.f1, 3)), esc(integer(row.n)),
      inMacro.get(row.product) === false ? "Left out of macro-F1" : "Included",
    ]);
    const perDesk = `<div class="panel span-12"><h3>Per-desk scores · words model</h3>${table(["Desk", "Precision", "Recall", "F1", "n", "In macro-F1"], perRows)}${note("Point estimates with n shown; the test period is small for the rarer desks.")}</div>`;

    const issueRows = (router.issue_within_product || []).map((row) => [
      esc(deskName(row.product)), esc(integer(row.issues)), esc(integer(row.train_rows)), esc(integer(row.test_rows)),
      numCell(row.majority_accuracy), numCell(row.words_accuracy), numCell(row.words_macro_f1),
    ]);
    const issue = `<div class="panel span-12"><h3>Issue within a desk · secondary, no hypothesis</h3>${table(["Desk", "Issues", "Train rows", "Test rows", "Majority accuracy", "Words accuracy", "Words macro-F1"], issueRows)}${note("Picking the issue inside a desk is much harder than picking the desk.")}</div>`;
    return `<div class="grid dash">${board}${heat}${calibration}${route}${perDesk}${issue}</div>`;
  }

  function renderRouter(data, view) {
    const chosen = view === "new" ? "new" : "test";
    const router = data.router || {};
    const h2 = router.h2 || {};
    const noise = (data.descriptive || {}).label_noise || {};
    const words = ((router.models || {}).words || {}).test || {};
    const head = opener({
      label: "Router · one of eleven desks",
      num: count(h2.precision && h2.precision.value, "pct1"),
      line: `right, on the complaints the words model sent on automatically. The rule needed 95%. ${badge(h2.pass)}`,
      sub: `${ciLine(h2.precision)}. Coverage ${pctFmt(h2.coverage && h2.coverage.value)}, ${ciLine(h2.coverage)}. Macro-F1 ${pctFmt(words.macro_f1 && words.macro_f1.value)}.`,
      extra: `<div class="seg" role="group" aria-label="Choose which test complaints to show"><button type="button" data-view="test" aria-pressed="${chosen === "test"}">All test complaints</button><button type="button" data-view="new" aria-pressed="${chosen === "new"}">New text only</button></div>`,
    });
    const split = section("split", "The split and the change in product mix", "Trained on the past, tested once on the future",
      `${splitTimeline(router.split || {})}${note(`The test period's product mix differs from training. The ${term("new text")} view is the closest look at genuinely unseen complaints.`)}`);
    const labelNoise = section("noise", "Label noise", `${pctFmt((noise.modal_share || {}).value)} agree on repeated text`,
      `<p class="lede">Among ${esc(integer(noise.complaints))} test complaints that share their text with another (${esc(integer(noise.distinct_texts))} distinct texts), that share carry the commonest desk for their text. ${esc(ciLine(noise.modal_share))}. This covers repeated text only.</p>`);
    return `${head}<section class="band dashboard"><div class="wrap"><div id="router-dashboard">${routerDashboard(data, chosen)}</div></div></section>${split}${labelNoise}${nextBand("router")}`;
  }

  // ------------------------------------------------------------------- cost

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

  function chosenName(evaluation) {
    return evaluation.chosen_variant === "few_shot" ? "Few-shot" : "Zero-shot";
  }

  function raceHtml(data) {
    const rows = timeRows(data);
    const words = rows.find((row) => row[0] === "Words");
    const llm = rows.find((row) => row[0] === chosenName(data.llmEval || {}));
    if (!words || !llm) return "";
    const slowest = Math.max(Number(words[1]), Number(llm[1]));
    const lane = (name, secs, tone) =>
      `<div class="lane ${tone}" data-lane data-seconds="${esc(secs)}" data-share="${esc(Math.max(0.004, Number(secs) / slowest))}"><p class="lane-head"><span>${esc(name)}</span><b class="lane-time">${esc(duration(secs))}</b></p><div class="lane-track"><i class="lane-fill"></i></div></div>`;
    return `<div class="race" data-race>
      ${lane("Words model", words[1], "fast")}${lane(`Language model, ${llm[0].toLowerCase()}`, llm[1], "slow")}
      <p class="note">Bar length is time on one shared clock. The replay is scaled so the slower run takes about two and a half seconds on screen; the words model is done before the first frame. Real times: ${esc(duration(words[1]))} against ${esc(duration(llm[1]))}.</p>
      <button type="button" class="chip" data-replay>Replay the race</button></div>`;
  }

  function logChart(rows) {
    if (!rows.length) return '<p class="empty">No timings were published.</p>';
    const values = rows.map((row) => Number(row[1]));
    const lo = Math.floor(Math.log10(Math.min(...values)));
    const hi = Math.ceil(Math.log10(Math.max(...values)));
    const at = (v) => ((Math.log10(v) - lo) / (hi - lo)) * 100;
    let grid = "";
    for (let e = lo; e <= hi; e++) {
      const v = Math.pow(10, e);
      grid += `<i class="lg-line" style="left:${at(v)}%"><em>${v >= 1000 ? `${v / 1000}k` : v < 1 ? v : v}s</em></i>`;
    }
    return `<div class="logchart draw"><div class="lg-grid" aria-hidden="true">${grid}</div>${rows
      .map(
        (row, i) => `<div class="lg-row ${row[0] === "Words" || row[0] === "Embeddings" ? "small" : "big"}" style="--i:${i}"><span class="lg-name">${esc(row[0])}</span><span class="lg-bar"><i class="grow-x" style="width:${at(Number(row[1]))}%"></i></span><b>${esc(seconds(row[1]))}</b></div>`,
      )
      .join("")}</div>`;
  }

  function costTable(evaluation) {
    const sample = (evaluation.sample || {}).test;
    const same = evaluation.same_sample || {};
    const variants = evaluation.variants || {};
    const eceCell = (ece) => `<span class="n">${esc(fixed(ece, 3))}</span><span class="ci">n = ${esc(integer(sample))} · interval not published</span>`;
    const rows = [];
    for (const name of ["majority", "words", "embeddings"]) {
      const item = same[name] || {};
      rows.push([esc(name), numCell(item.macro_f1), numCell(item.accuracy), eceCell(item.ece), numCell((item.auto_route || {}).coverage), numCell((item.auto_route || {}).precision)]);
    }
    for (const name of ["zero_shot", "few_shot"]) {
      const item = variants[name] || {};
      const metrics = item.test || {};
      rows.push([esc(name.replaceAll("_", "-")), numCell(metrics.macro_f1), numCell(metrics.accuracy), eceCell(metrics.ece), numCell(((item.auto_route || {}).test || {}).coverage), numCell(((item.auto_route || {}).test || {}).precision)]);
    }
    return table(["Model", "Macro-F1", "Accuracy", "Calibration error", "Coverage", "Precision"], rows);
  }

  function costResult(data, price) {
    const evaluation = data.llmEval;
    if (!evaluation || !evaluation.h1) return "The language model result is not available.";
    const variant = (evaluation.variants || {})[evaluation.chosen_variant] || {};
    if (!ok(price) || price === "" || Number(price) < 0 || !ok(variant.prompt_tokens_per_1000)) {
      return "Enter a price to see what the measured tokens would cost.";
    }
    const tokens = Number(variant.prompt_tokens_per_1000) + Number(variant.output_tokens_per_1000 || 0);
    const cost = (tokens / 1000000) * Number(price);
    return `At your price of ${fixed(price, 2)} per million tokens, the measured ${integer(tokens)} tokens per thousand complaints cost ${cost.toFixed(2)} per thousand complaints.`;
  }

  function renderCost(data) {
    const evaluation = data.llmEval;
    if (!evaluation || !evaluation.h1) {
      return `${opener({
        label: "Cost against accuracy · not run",
        num: '<span class="num-idle">not run</span>',
        line: "The language model result file does not exist yet, so this page cannot say whether it is worth its cost.",
        extra: badge(null, true),
      })}${notRun("The language model result is not available", "The long model run has not written its result file. No accuracy, time or token figure is shown here.")}
      ${section("", "What will appear here", "Cost, speed and accuracy on one fixed sample", "<p class=\"lede\">The chosen language model variant against the words model on the same sample, the paired difference in macro-F1 with its interval, seconds per thousand complaints and tokens.</p>")}${nextBand("cost")}`;
    }
    const h1 = evaluation.h1;
    const chosen = chosenName(evaluation);
    const variant = (evaluation.variants || {})[evaluation.chosen_variant] || {};
    const same = evaluation.same_sample || {};
    const rows = timeRows(data);
    const wordsTime = rows.find((row) => row[0] === "Words");
    const llmTime = rows.find((row) => row[0] === chosen);
    const ratio = wordsTime && llmTime ? Math.round(Number(llmTime[1]) / Number(wordsTime[1])) : null;
    const accuracy = h1.verdict === "small_model_better" ? "and less accurate" : h1.verdict === "llm_better" ? "but more accurate" : "and no more accurate than the test can detect";
    const head = opener({
      label: "Cost against accuracy · is the big model worth it?",
      num: ok(ratio) ? count(ratio, "times") : '<span class="num-idle">no timing</span>',
      line: ok(ratio)
        ? `slower for the same thousand complaints. The language model is slower ${accuracy}.`
        : esc(verdictWords(h1.verdict)),
      sub: ok(ratio) ? `${chosen} language model, ${duration(llmTime[1])} against ${duration(wordsTime[1])} for the words model. Measured times, no interval.` : "",
    });
    const race = ok(ratio) ? section("race", "The same 1,000 complaints", "Two models, one clock", raceHtml(data), "race-band") : "";
    const accuracyBand = section("accuracy", "And the accuracy, on the same sample", esc(verdictWords(h1.verdict)),
      `<div class="grid"><div class="panel span-7">${ibar({ label: `Language model, ${chosen.toLowerCase()} · ${term("macro-F1")}`, num: (variant.test || {}).macro_f1, tone: "tone-llm" })}${ibar({ label: `Words model · ${term("macro-F1")}`, num: (same.words || {}).macro_f1, tone: "tone-words", i: 1 })}</div>
      <div class="panel span-5 diff"><p class="stat-label">Paired difference · Test 1</p><p class="hero-num sm">${count((h1.difference || {}).value, "s3")}</p><p class="ci">${esc(ciLine(h1.difference, (v) => signed(v, 3)))}</p>${badge(h1.pass, true)}</div></div>
      ${note(`Macro-F1 here is on an equal mix of products over ${esc(integer((evaluation.sample || {}).test))} complaints, not the real mix.`)}`);
    const log = section("scale", "Drawn to scale", "The gap on a log scale", `${logChart(rows)}${note(`Each gridline is ten times the one before it. ${ok(ratio) ? `The language model sits about ${esc(String(Math.round(Math.log10(ratio))))} gridlines to the right of the words model.` : ""}`)}`);
    const full = section("table", "Every model, same sample", "The full table", `<div class="panel">${costTable(evaluation)}${note(`${term("macro-F1")} on an equal mix of products. Calibration error has no published interval.`)}</div>`);
    const tokens = `<div class="panel"><p class="mono-line">Prompt tokens per thousand complaints: ${esc(integer(variant.prompt_tokens_per_1000))} · output tokens: ${esc(integer(variant.output_tokens_per_1000))}</p>
      <label class="field"><span>Your price per million tokens (no price is suggested here)</span><input id="price-input" type="number" min="0" step="any" inputmode="decimal" placeholder="Enter your own price"></label>
      <p id="cost-result" class="result-line" aria-live="polite">Enter a price to see what the measured tokens would cost.</p>
      ${note("This applies your price to measured prompt and output tokens. It is your assumption, not a measured cost.")}</div>`;
    return `${head}${race}${accuracyBand}${log}${full}${section("tokens", "Tokens", "What it would cost, at your price", tokens)}${nextBand("cost")}`;
  }

  // ------------------------------------------------------------------ radar

  // The missed event whose two weeks from the event week came closest to the alarm line.
  function nearMiss(data) {
    const radar = data.radar || {};
    const weekly = (data.weekly || {}).radar || {};
    const limit = (radar.rule || {}).limit;
    if (!ok(limit) || !weekly.weeks) return "";
    let best = null;
    (radar.events || []).forEach((event) => {
      if (event.detected) return;
      const z = ((weekly.series || {})[event.product_group] || {}).z;
      const i = weekly.weeks.indexOf(event.week_start);
      if (!z || i < 0 || !ok(z[i]) || !ok(z[i + 1])) return;
      const closeness = Math.min(z[i], z[i + 1]);
      if (!best || closeness > best.closeness) {
        best = { event, closeness, week: [weekly.weeks[i], weekly.weeks[i + 1]], z: [z[i], z[i + 1]] };
      }
    });
    if (!best || best.closeness <= 0) return "";
    const need = (radar.rule || {}).consecutive;
    const scale = Math.max(limit, ...best.z) * 1.15;
    const row = (week, value, first) => {
      const over = value > limit;
      return `<div class="nm-row"><span class="nm-week">${esc(week)}</span><div class="nm-track"><i class="nm-fill grow-x ${over ? "over" : "under"}" style="width:${(Math.max(0, value) / scale) * 100}%"></i><i class="nm-limit" style="left:${(limit / scale) * 100}%">${first ? `<em>limit ${esc(fixed(limit, 0))}</em>` : ""}</i></div><b>z ${esc(fixed(value, 2))}</b></div>`;
    };
    const gap = limit - best.z[1];
    return section("near", "The near-miss", `${esc(eventName(best.event))}: week one crossed the limit, week two fell ${esc(fixed(gap, 2))} short.`,
      `<div class="panel draw near">${row(best.week[0], best.z[0], true)}${row(best.week[1], best.z[1], false)}
      ${note(`The rule needs ${esc(integer(need))} weeks in a row above ${esc(fixed(limit, 0))}. The event week reached ${esc(fixed(best.z[0], 2))}, the next fell to ${esc(fixed(best.z[1], 2))}, so the rule stayed quiet and the event counts as missed.`)}</div>`, "near-band");
  }

  function radarGroups(data) {
    return (((data.weekly || {}).radar || {}).groups || []).slice().sort();
  }

  function radarGroupDefault(data) {
    return (((data.radar || {}).events || [])[0] || {}).product_group || radarGroups(data)[0] || null;
  }

  function eventKey(radar, group) {
    const list = (radar.events || []).filter((event) => event.product_group === group);
    if (!list.length) return "";
    return `<ul class="flag-key">${list.map((event, i) => `<li class="${event.detected ? "hit" : "miss"}"><span class="flag-n" aria-hidden="true">${i + 1}</span>${esc(eventName(event))} · ${esc(event.event_date)} · <strong>${event.detected ? "detected" : "missed"}</strong></li>`).join("")}</ul>`;
  }

  function episodeRow(name, episode) {
    return [
      esc(groupLabel(name)), esc(episode.start), esc(episode.end), esc(integer(episode.alarm_weeks)), esc(fixed(episode.peak_z, 2)),
      episode.event_id ? `<span class="state pass">${esc(groupLabel(episode.event_id))}</span>` : '<span class="state fail">Unexplained</span>',
    ];
  }

  function radarDashboard(data, group, scale) {
    const radar = data.radar || {};
    const series = (radar.series || []).find((item) => item.product_group === group) || {};
    const episodes = series.episodes || [];
    const log = scale === "log";
    return `<div class="panel"><div class="panel-head"><h3>Weekly complaints · ${esc(groupLabel(group))}</h3><div class="seg sm" role="group" aria-label="Timeline scale"><button type="button" data-scale="linear" aria-pressed="${!log}">Linear</button><button type="button" data-scale="log" aria-pressed="${log}">Log</button></div></div>
      <div class="viz" data-viz="timeline" data-group="${esc(group)}"></div>${eventKey(radar, group)}
      ${note(`This desk has ${esc(integer(episodes.length))} ${term("episode", episodes.length === 1 ? "episode" : "episodes")}; ${esc(integer(episodes.filter((e) => !e.event_id).length))} start outside the dated event windows. Tall ticks are ${term("alarm", "alarms")}; shaded bands are episodes; dashed flags are known events.`)}</div>`;
  }

  function radarTables(data) {
    const radar = data.radar || {};
    const summary = radar.summary || {};
    const eventRows = (radar.events || []).map((event) => [
      esc(event.title), esc(event.event_date), esc(groupLabel(event.product_group)),
      event.detected ? '<span class="state pass">Detected</span>' : '<span class="state fail">Missed</span>',
      esc(ok(event.delay_weeks) ? integer(event.delay_weeks) : "—"),
      event.naive_detected ? "Detected" : "Missed",
      esc(ok(event.lead_weeks_vs_naive) ? integer(event.lead_weeks_vs_naive) : "—"),
    ]);
    const events = section("events", "Known events", "Five dates, one catch",
      `<div class="panel">${table(["Event", "Date", "Desk", "Rule", "Delay, weeks", "Naive rule", "Lead, weeks"], eventRows)}${note("A missed event is shown as missed, not hidden. The naive rule is a plain ratio against recent weeks.")}</div>`);
    const rates = section("false", "Crying wolf", "Unexplained alarms per series per year",
      `<div class="stats">${stat("The rule", esc(fixed((summary.unexplained_per_series_year || {}).value, 2)), ciLine(summary.unexplained_per_series_year, (v) => fixed(v, 2)))}${stat("The naive rule", esc(fixed((summary.naive_unexplained_per_series_year || {}).value, 2)), ciLine(summary.naive_unexplained_per_series_year, (v) => fixed(v, 2)))}</div>
      ${note("Some unexplained alarms are real events that are not on the fixed list, so this is an upper bound on false alarms.")}`);
    const all = (radar.series || []).flatMap((item) => (item.episodes || []).map((episode) => episodeRow(item.product_group, episode)));
    const list = section("episodes", "Every episode", "All desks, all alarms",
      `<div class="panel">${table(["Desk", "Start", "End", "Alarm weeks", "Peak z", "Explained by"], all)}${note(`Episodes are runs of ${term("alarm", "alarm")} weeks no more than a few weeks apart, dated by their first alarm week.`)}</div>`);
    return `${events}${rates}${list}`;
  }

  function noveltyBlock(data) {
    const novelty = (data.radar || {}).novelty;
    const weekly = (data.weekly || {}).novelty || {};
    if (!novelty || !ok(novelty.series) || !weekly.groups || !weekly.groups.length) {
      return notRun("Text novelty was not run", "The result file does not contain a text novelty block, so no novelty figure or event table is shown.");
    }
    const rate = novelty.unexplained_per_series_year;
    const rows = (novelty.events || []).map((event) => [esc(groupLabel(event.event_id)), event.detected ? "Detected" : "Missed", esc(ok(event.delay_weeks) ? integer(event.delay_weeks) : "—")]);
    return section("novelty", "Exploratory", "Text novelty, with no pass or fail rule",
      `<p class="lede">This variant watches new words in published narratives on the event desks. It was not part of the three tests.</p>
      <div class="panel"><div class="viz" data-viz="novelty"></div>${note("One line per week of mean novelty; alarm weeks are marked in coral.")}
      <p class="mono-line">Unexplained alarms per series per year: ${esc(fixed(rate && rate.value, 2))} · ${esc(ciLine(rate, (v) => fixed(v, 2)))}</p>${table(["Event", "Rule", "Delay, weeks"], rows)}</div>`);
  }

  function radarRule(rule) {
    return section("rule", "The rule", "In plain steps", `<ol class="steps">
      <li>Take the natural log of one plus each week's complaints.</li>
      <li>Compare it with the median of the previous ${esc(integer(rule.level_weeks))} weeks; that is the level.</li>
      <li>Remove the season using the same week 52, 104 and so on weeks earlier, or zero when fewer than two years are available.</li>
      <li>Divide by one point four eight two six times the median absolute deviation of the last ${esc(integer(rule.scale_weeks))} weeks, with a floor, to get z.</li>
      <li>Raise an alarm when z is above ${esc(fixed(rule.limit, 1))} in this week and the week before; start watching at week ${esc(integer(rule.monitor_from_week))}.</li>
      <li>Join alarm weeks up to ${esc(integer(rule.episode_gap_weeks))} weeks apart into one episode, and score an event if an episode starts within ${esc(integer(rule.event_window_weeks))} weeks of it.</li>
      <li>The naive rule instead alarms when a week is above ${esc(fixed(rule.naive_ratio, 1))} times the mean of the previous ${esc(integer(rule.scale_weeks))} weeks in both weeks.</li></ol>`);
  }

  function renderRadar(data, group, scale) {
    const radar = data.radar || {};
    const summary = radar.summary || {};
    const chosen = group || radarGroupDefault(data);
    const head = opener({
      label: "Radar · the pulse",
      num: ok(summary.detected) ? `${count(summary.detected, "int")}<span class="of"> of ${esc(integer(summary.events))}</span>` : '<span class="num-idle">no result</span>',
      line: `known events caught by the alarm rule. ${badge((radar.h3 || {}).pass)}`,
      sub: `${ciLine(summary.detection_rate)} · ${fixed((summary.unexplained_per_series_year || {}).value, 2)} unexplained alarms per series per year`,
    });
    const picker = `<div class="filterbar static"><div class="wrap"><div class="chips" role="group" aria-label="Choose a product desk">${radarGroups(data)
      .map((name) => `<button type="button" class="chip" data-radar-group="${esc(name)}" aria-pressed="${name === chosen}">${esc(groupLabel(name))}</button>`)
      .join("")}</div></div></div>`;
    return `${head}${picker}<section class="band dashboard"><div class="wrap"><div id="radar-dashboard">${radarDashboard(data, chosen, scale === "log" ? "log" : "linear")}</div></div></section>
      ${nearMiss(data)}${radarTables(data)}${noveltyBlock(data)}${radarRule(radar.rule || {})}${nextBand("radar")}`;
  }

  // ---------------------------------------------------------------- quality

  function renderQuality(data) {
    const descriptive = data.descriptive || {};
    const byYear = descriptive.by_year || [];
    const usable = byYear.filter((row) => row.with_narrative > 0);
    const first = usable[0] || {};
    const last = usable[usable.length - 1] || {};
    const prior = usable[usable.length - 2] || {};
    const head = ok(last.year)
      ? opener({
          label: "Data quality · what is missing",
          num: count((last.narrative_share || {}).value, "pct1"),
          line: `of complaints received in ${esc(last.year)} carry a narrative, down from ${esc(pctFmt((prior.narrative_share || {}).value))} in ${esc(prior.year)}. Text results describe a shrinking slice.`,
          sub: `${last.year}: ${ciLine(last.narrative_share)}`,
        })
      : opener({ label: "Data quality · what is missing", num: '<span class="num-idle">no history</span>', line: "The narrative history is not available." });
    const shareChart = columns(
      usable.map((row) => ({ label: String(row.year), short: `’${String(row.year).slice(2)}`, value: (row.narrative_share || {}).value || 0, text: pct(row.narrative_share && row.narrative_share.value, 0), tone: row === last ? "bad" : "" })),
      { peak: 0.5, alt: "Share of complaints with a narrative, by year" },
    );
    const shareRows = byYear.map((row) => [esc(row.year), esc(integer(row.complaints)), esc(integer(row.with_narrative)), numCell(row.narrative_share)]);
    const share = section("narratives", "The collapse", "Share of complaints with a narrative, by year",
      `<div class="panel">${shareChart}${note(`Narratives first appear in ${esc(first.year)}. In ${esc(last.year)} only ${esc(integer(last.with_narrative))} of ${esc(integer(last.complaints))} complaints carry one. ${esc(ciLine(last.narrative_share))}`)}
      <details class="exact"><summary>Exact numbers</summary>${table(["Year", "Complaints", "With a narrative", "Share"], shareRows)}</details></div>`);

    const repeats = descriptive.repeats || [];
    const repeatChart = repeats.length
      ? columns(repeats.map((row) => ({ label: String(row.year), short: `’${String(row.year).slice(2)}`, value: (row.repeated_share || {}).value || 0, text: pct(row.repeated_share && row.repeated_share.value, 0), tone: "violet" })), { peak: 0.7, alt: "Share of narratives repeating another word for word, by year" })
      : '<p class="empty">No repeated-text figures were published.</p>';
    const repeatRows = repeats.map((row) => [esc(row.year), esc(integer(row.with_narrative)), numCell(row.repeated_share)]);
    const repeatMax = repeats.length ? repeats.reduce((a, b) => ((b.repeated_share || {}).value > (a.repeated_share || {}).value ? b : a)) : null;
    const rep = section("repeats", "Copies", "Repeated text by year",
      `<div class="panel">${repeatChart}${note(repeatMax ? `Up to ${esc(pctFmt(repeatMax.repeated_share.value))} of narratives in ${esc(repeatMax.year)} repeat another complaint word for word. ${esc(ciLine(repeatMax.repeated_share))}` : "")}
      <details class="exact"><summary>Exact numbers</summary>${table(["Year", "With a narrative", "Repeated-text share"], repeatRows)}</details></div>`);

    const taxonomy = descriptive.taxonomy || [];
    const rows = taxonomy.map((row) => [esc(row.product), esc(ok(row.sub_product) ? row.sub_product : "—"), esc(groupLabel(row.product_group)), esc(row.first_date), esc(row.last_date), esc(integer(row.complaints))]);
    const mapping = section("mapping", "Labels change", `The product mapping · ${esc(integer(rows.length))} source labels, eleven desks`,
      `<label class="field"><span>Search product, sub-product or desk</span><input type="search" id="taxonomy-search" placeholder="Type to filter" autocomplete="off"></label>
      <div class="panel scroller" tabindex="0" role="region" aria-label="Product mapping table"><div id="taxonomy-holder">${table(["Source product", "Sub-product", "Desk", "First date", "Last date", "Complaints"], rows, "taxonomy-table")}</div></div>
      ${note("Eleven desks hold across three versions of the product list.")}`);

    const noise = descriptive.label_noise || {};
    const year = String(((descriptive.totals || {}).last_date) || "").slice(0, 4);
    const trust = section("trust", "Label noise and exclusions", `${esc(pctFmt((noise.modal_share || {}).value))} agree on repeated text`,
      `<p class="lede">Among ${esc(integer(noise.complaints))} test complaints sharing text with another (${esc(integer(noise.distinct_texts))} distinct texts), that share carry the commonest desk for their text. ${esc(ciLine(noise.modal_share))}. This says nothing about labels on unique text.</p>
      <p class="lede">July and August ${esc(year)} are left out of modelling because their narratives are incomplete. Repeated text is removed from training, and each product is capped there.</p>`);
    const caveats = section("limits", "What this cannot show", "Limits", caveatList());
    return `${head}${share}${rep}${mapping}${trust}${caveats}${nextBand("quality")}`;
  }

  // -------------------------------------------------------------------- try

  const EXAMPLES = [
    ["Mortgage fees", "My mortgage servicer keeps adding fees I never agreed to and will not explain my escrow account."],
    ["Debt collector calls", "A debt collector calls me every day about a debt I already paid and threatens to sue me."],
    ["Wrong credit report", "The credit bureau shows an account that is not mine and will not remove it after I disputed it."],
  ];

  function tryEmpty() {
    return '<p class="empty">Your result will appear here: the desk, the confidence against the routing threshold, all eleven probabilities and the words that pushed the decision.</p>';
  }

  function tryResult(result, model) {
    const threshold = ok(model && model.threshold) ? model.threshold : null;
    const at = (v) => Math.max(0, Math.min(100, v * 100));
    const probs = result.probabilities
      .map((item, i) => `<li class="${i === 0 ? "top" : ""}"><span class="rank-name">${esc(deskName(item.product))}</span><span class="rank-bar"><i style="width:${Math.max(0.5, at(item.p))}%"></i></span><b>${esc(pct(item.p, 1))}</b></li>`)
      .join("");
    const terms = result.terms.length
      ? result.terms.map((item) => `<li>${esc(item.term)}<b>+${esc(item.weight.toFixed(3))}</b></li>`).join("")
      : "<li>No vocabulary terms from this text moved the decision.</li>";
    const mark = threshold == null ? "" : `<i class="ibar-mark${at(threshold) > 70 ? " end" : ""}" style="left:${at(threshold)}%"><em>routing threshold ${esc(pct(threshold, 1))}</em></i>`;
    return `<div class="try-top"><div><p class="label">Sorted to</p><h2 class="desk-name">${esc(deskName(result.product))}</h2></div>
        <span class="badge big ${result.routed ? "pass" : "idle"}">${result.routed ? "Sent automatically" : "A person decides"}</span></div>
      <div class="ibar ${result.routed ? "tone-ok" : "tone-grey"}"><div class="ibar-head"><span>Confidence</span><b>${esc(pct(result.confidence, 1))}</b></div>
        <div class="ibar-track"><i class="ibar-fill" style="left:0;width:${at(result.confidence)}%"></i>${mark}</div>
        <p class="ci">${threshold == null ? "Threshold not published." : "Above the threshold the complaint is sent on automatically; below it, a person decides."}</p></div>
      <div class="grid"><div class="span-7"><h3>All eleven desks</h3><ol class="rank probs">${probs}</ol></div><div class="span-5"><h3>Terms that pushed the decision</h3><ul class="terms">${terms}</ul></div></div>`;
  }

  function renderTry(data) {
    const chips = EXAMPLES.map((item, i) => `<button type="button" class="chip" data-example="${i}" title="${esc(item[1])}">${esc(item[0])}</button>`).join("");
    const router = ((data || {}).router) || {};
    const threshold = (((router.models || {}).words || {}).auto_route || {}).threshold;
    return `<header class="opener band try-head"><div class="glow" aria-hidden="true"></div><div class="wrap">
        <p class="label">Try it · the same model, in your browser</p>
        <h1 class="hero-title sm">Paste a complaint.<br>Watch it get sorted.</h1>
        <div class="cmd"><label class="sr-only" for="try-text">A made-up complaint, or write your own</label>
          <textarea id="try-text" rows="5" placeholder="Describe the complaint in your own words…" spellcheck="true"></textarea>
          <div class="cmd-foot"><div class="chips" role="group" aria-label="Made-up examples">${chips}</div><span id="try-status" class="status" aria-live="polite">The model loads when you first type or choose an example.</span></div></div>
      </div></header>
      <section class="band"><div class="wrap"><div class="panel result" id="try-result" aria-live="polite">${tryEmpty()}</div></div></section>
      ${section("how", "How it works", "The same model that was tested", `<p class="lede">This is the model from the router section. It runs in your browser and nothing you type is sent anywhere. The bar shows where the answer sits against the automatic-routing threshold${ok(threshold) ? ` of ${esc(pct(threshold, 1))}` : ""} chosen on the 2025 validation data.</p>`)}${nextBand("try")}`;
  }

  return {
    TERMS, PAGES, RULE, EXAMPLES, esc, ok, fixed, integer, pct, pctFmt, signed, format, count, wilson, badge, table, term,
    ibar, ciLine, columns, nextBand, notRun, defaultFilters, renderIndex, renderVolumes, renderRouter, renderCost,
    renderRadar, renderQuality, renderTry, volumesDashboard, routerDashboard, radarDashboard, monthlySeries,
    radarGroupDefault, tryResult, tryEmpty, costResult, duration, deskName, nearMiss, timeRows, seconds, wallRows,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = Pages;
}
if (typeof window !== "undefined") {
  window.Pages = Pages;
}
