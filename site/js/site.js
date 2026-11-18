"use strict";

// Page bootstrap. All figures come from the JSON files listed in the generated manifest.
// Rendering lives in pages.js; this file only mounts it, draws charts and wires controls.

(() => {
  const P = window.Pages;
  const app = document.getElementById("app");
  const page = document.body.dataset.page || "index";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const state = {
    data: {},
    filters: P.defaultFilters(),
    view: "test",
    group: null,
    model: null,
    modelPromise: null,
    sortedDrawn: false,
  };
  let uid = 0;

  const select = (root, query) => root.querySelector(query);
  const selectAll = (root, query) => Array.from(root.querySelectorAll(query));
  const css = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function short(value, limit) {
    const text = value == null ? "" : String(value);
    return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text;
  }

  function number(value) {
    const parsed = Number(String(value).replaceAll(",", "").replace("%", ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // ------------------------------------------------------------ theme + words

  function initTheme() {
    const button = document.getElementById("theme-toggle");
    if (!button) return;
    const names = ["system", "light", "dark"];
    let saved = "system";
    try {
      saved = localStorage.getItem("complaint-radar-theme") || "system";
    } catch (error) {
      saved = "system";
    }
    const apply = (choice) => {
      if (choice === "system") {
        document.documentElement.removeAttribute("data-theme");
      } else {
        document.documentElement.setAttribute("data-theme", choice);
      }
      button.textContent = choice === "system" ? "System" : choice === "light" ? "Light" : "Dark";
      button.setAttribute("aria-label", `Colour theme: ${choice}. Click to change.`);
      drawCharts();
    };
    apply(names.includes(saved) ? saved : "system");
    button.addEventListener("click", () => {
      const current = button.textContent.trim().toLowerCase();
      const next = names[(names.indexOf(current) + 1) % names.length];
      try {
        localStorage.setItem("complaint-radar-theme", next);
      } catch (error) {
        // The choice still applies for this page view.
      }
      apply(next);
    });
  }

  function initGlossary() {
    const definition = document.getElementById("gloss-def");
    if (!definition) return;
    const close = () => {
      definition.hidden = true;
      definition.textContent = "";
    };
    const open = (button) => {
      const key = button.dataset.term;
      definition.textContent = P.TERMS[key] || "";
      definition.hidden = !definition.textContent;
    };
    document.addEventListener("click", (event) => {
      const button = event.target.closest(".term");
      if (button) {
        open(button);
      } else if (!event.target.closest("#gloss-def")) {
        close();
      }
    });
    document.addEventListener("focusin", (event) => {
      const button = event.target.closest(".term");
      if (button) open(button);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
  }

  function initReveal() {
    const blocks = selectAll(app, ".reveal");
    if (reduced || !("IntersectionObserver" in window)) {
      blocks.forEach((block) => block.classList.add("in"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08 },
    );
    blocks.forEach((block) => observer.observe(block));
  }

  // ------------------------------------------------------------ svg primitives

  function makeSvg(el, width, height, body, title, description) {
    const a = `chart-title-${++uid}`;
    const b = `chart-desc-${uid}`;
    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="xMinYMin meet" aria-labelledby="${a} ${b}"><title id="${a}">${P.esc(title || "Chart")}</title><desc id="${b}">${P.esc(description || "")}</desc>${body}</svg>`;
  }

  function emptyChart(el, message) {
    el.innerHTML = `<p class="chart-empty">${P.esc(message)}</p>`;
  }

  function heatFill(share) {
    const accent = css("--accent") || "#1F4FD8";
    const surface = css("--surface") || "#FFFFFF";
    const parse = (hex) => {
      const clean = hex.replace("#", "");
      const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
      return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    };
    const a = parse(accent);
    const b = parse(surface);
    const mix = a.map((channel, i) => Math.round(b[i] + (channel - b[i]) * (0.12 + share * 0.88)));
    return `rgb(${mix.join(",")})`;
  }

  function luminance(rgb) {
    const values = rgb.match(/\d+/g).slice(0, 3).map(Number);
    const channels = values.map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function readableInk(fill) {
    const light = luminance(css("--ink") || "#FFFFFF");
    const dark = luminance(css("--bg") || "#000000");
    const background = luminance(fill);
    const lightContrast = (Math.max(light, background) + 0.05) / (Math.min(light, background) + 0.05);
    const darkContrast = (Math.max(dark, background) + 0.05) / (Math.min(dark, background) + 0.05);
    return darkContrast >= lightContrast ? css("--bg") || "#000000" : css("--ink") || "#FFFFFF";
  }

  function logShare(value, range) {
    const [lo, hi] = range;
    return Math.max(0, Math.min(1, (Math.log10(Math.max(value, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))));
  }

  function drawBars(el, items, options = {}) {
    if (!items.length) return emptyChart(el, "No figures were published for this chart.");
    const width = Math.max(280, el.clientWidth || 600);
    const height = options.height || Math.max(180, items.length * 32 + 48);
    const top = 16;
    const bottom = 24;
    const labelWidth = options.labelWidth || Math.min(180, Math.max(110, width * 0.34));
    const x0 = labelWidth + 8;
    const x1 = width - (options.log ? 72 : 64);
    const rowHeight = (height - top - bottom) / items.length;
    const barHeight = Math.max(6, Math.min(16, rowHeight * 0.48));
    const peak = Math.max(...items.map((item) => Math.max(0, number(item.value))), 1);
    const track = css("--surface-2");
    const ink = css("--ink");
    const muted = css("--ink-3");
    let body = "";
    if (options.log) {
      // decade gridlines so the log scale reads at a glance; fewer labels on phones
      const first = Math.log10(options.log[0]);
      for (let e = first; e <= Math.log10(options.log[1]); e++) {
        const gx = x0 + logShare(Math.pow(10, e), options.log) * (x1 - x0);
        const v = Math.pow(10, e);
        const text = `${v >= 1000 ? `${v / 1000}k` : v}s`;
        body += `<line x1="${gx}" x2="${gx}" y1="${top - 4}" y2="${height - bottom + 2}" stroke="${css("--border")}" stroke-width="1"/>`;
        if ((e - first) % (width < 500 ? 2 : 1) === 0) {
          body += `<text x="${gx}" y="${height - 6}" text-anchor="middle" fill="${muted}" font-size="10">${P.esc(text)}</text>`;
        }
      }
    }
    items.forEach((item, i) => {
      const y = top + i * rowHeight + rowHeight / 2;
      const value = Math.max(0, number(item.value));
      const length = Math.max(0, (options.log ? logShare(value, options.log) : value / peak) * (x1 - x0));
      const fill = item.color || css("--accent");
      body += `<text x="0" y="${y + 3.5}" fill="${ink}" font-size="11"><title>${P.esc(item.label)}</title>${P.esc(short(item.label, Math.floor(labelWidth / 6.3)))}</text>`;
      body += `<rect x="${x0}" y="${y - barHeight / 2}" width="${Math.max(1, x1 - x0)}" height="${barHeight}" fill="${track}" rx="2"/>`;
      body += `<rect x="${x0}" y="${y - barHeight / 2}" width="${Math.max(0, length)}" height="${barHeight}" fill="${fill}" rx="2"/>`;
      if (item.low != null && item.high != null && peak > 0) {
        const lo = x0 + (Math.max(0, number(item.low)) / peak) * (x1 - x0);
        const hi = x0 + (Math.max(0, number(item.high)) / peak) * (x1 - x0);
        body += `<line x1="${lo}" x2="${hi}" y1="${y}" y2="${y}" stroke="${muted}" stroke-width="1.5"/><line x1="${lo}" x2="${lo}" y1="${y - 5}" y2="${y + 5}" stroke="${muted}" stroke-width="1"/><line x1="${hi}" x2="${hi}" y1="${y - 5}" y2="${y + 5}" stroke="${muted}" stroke-width="1"/>`;
      }
      body += `<text x="${x1 + 6}" y="${y + 3.5}" fill="${ink}" font-size="11">${P.esc(item.display || item.label)}</text>`;
    });
    makeSvg(el, width, height, body, options.title, options.description);
  }

  function drawLines(el, series, labels, options = {}) {
    if (!series.length || !series[0].values.length) {
      return emptyChart(el, "No series were published for this chart.");
    }
    const width = Math.max(280, el.clientWidth || 700);
    const height = options.height || 300;
    const left = 46;
    const right = 14;
    const top = 30;
    const bottom = 30;
    const count = labels.length;
    const peak = Math.max(...series.flatMap((line) => line.values.map((v) => number(v))), 1) * 1.08;
    const x = (i) => left + (i / Math.max(1, count - 1)) * (width - left - right);
    const y = (v) => top + (1 - number(v) / peak) * (height - top - bottom);
    const muted = css("--ink-3");
    const grid = css("--border");
    let body = "";
    for (let tick = 0; tick <= 3; tick++) {
      const value = (peak / 3) * tick;
      const yy = y(value);
      body += `<line x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" stroke="${grid}" stroke-width="1"/>`;
      body += `<text x="${left - 6}" y="${yy + 3}" text-anchor="end" fill="${muted}" font-size="11">${value >= 10000 ? `${Math.round(value / 1000)}k` : Math.round(value)}</text>`;
    }
    const labelSteps = [0, 0.25, 0.5, 0.75, 1];
    labelSteps.forEach((fraction) => {
      const index = Math.min(count - 1, Math.round(fraction * (count - 1)));
      body += `<text x="${x(index)}" y="${height - 8}" text-anchor="${fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}" fill="${muted}" font-size="10">${P.esc(short(labels[index], 10))}</text>`;
    });
    body += '<g class="draw-x"><clipPath id="clip-' + uid + '"><rect class="clip-rect" x="0" y="0" width="' + width + '" height="' + height + '"/></clipPath>';
    body += '<g clip-path="url(#clip-' + uid + ')">';
    series.forEach((line) => {
      const points = line.values
        .map((value, i) => (value == null ? null : `${x(i)},${y(value)}`))
        .filter(Boolean)
        .join(" ");
      body += `<polyline points="${points}" fill="none" stroke="${line.color}" stroke-width="${line.width || 1.8}" stroke-linejoin="round" ${line.dash ? 'stroke-dasharray="4 3"' : ""}/>`;
    });
    body += "</g></g>";
    series.forEach((line, i) => {
      const lx = left + i * Math.min(160, (width - left - right) / Math.max(1, series.length));
      body += `<line x1="${lx}" x2="${lx + 14}" y1="14" y2="14" stroke="${line.color}" stroke-width="2" ${line.dash ? 'stroke-dasharray="4 3"' : ""}/><text x="${lx + 19}" y="17" fill="${muted}" font-size="10">${P.esc(line.name)}</text>`;
    });
    makeSvg(el, width, height, body, options.title, options.description);
  }

  function drawHeatmap(el, matrix, labels, options = {}) {
    if (!matrix.length) return emptyChart(el, "No matrix was published for this chart.");
    const width = Math.max(280, el.clientWidth || 700);
    const left = Math.min(110, Math.max(76, width * 0.25));
    const top = 30;
    const cell = Math.max(18, Math.min(30, (width - left - 8) / matrix.length));
    const height = top + matrix.length * cell + 22;
    const ink = css("--ink");
    const muted = css("--ink-3");
    let body = "";
    labels.forEach((label, j) => {
      body += `<text x="${left + j * cell + cell / 2}" y="${top - 8}" text-anchor="middle" fill="${muted}" font-size="9"><title>${P.esc(label)}</title>${P.esc(short(label, Math.max(4, Math.floor(cell / 5))))}</text>`;
    });
    matrix.forEach((row, i) => {
      const total = row.reduce((sum, value) => sum + number(value), 0) || 1;
      const maxShare = Math.max(...row.map((value) => number(value) / total), 0.0001);
      body += `<text x="0" y="${top + i * cell + cell * 0.65}" fill="${ink}" font-size="9"><title>${P.esc(labels[i])}</title>${P.esc(short(labels[i], Math.floor(left / 5.6)))}</text>`;
      row.forEach((value, j) => {
        const share = number(value) / total;
        const fill = heatFill(share / maxShare);
        const x = left + j * cell;
        const y = top + i * cell;
        body += `<rect x="${x}" y="${y}" width="${cell - 1}" height="${cell - 1}" fill="${fill}" rx="1"><title>${P.esc(`${labels[i]} → ${labels[j]}: ${value} complaints`)}</title></rect>`;
        body += `<text x="${x + (cell - 1) / 2}" y="${y + (cell - 1) * 0.66}" text-anchor="middle" fill="${readableInk(fill)}" font-size="9">${Math.round(share * 100)}</text>`;
      });
    });
    body += `<text x="${left}" y="${height - 5}" fill="${muted}" font-size="9">Cell: share of its row, per cent. Counts in the exact table.</text>`;
    makeSvg(el, width, height, body, options.title, options.description);
  }

  function drawReliability(el, bins, options = {}) {
    if (!bins.length) return emptyChart(el, "No reliability table was published.");
    const width = Math.max(280, el.clientWidth || 560);
    const height = Math.min(360, Math.max(220, width * 0.55));
    const left = 42;
    const right = 18;
    const top = 18;
    const bottom = 34;
    const px = (v) => left + number(v) * (width - left - right);
    const py = (v) => top + (1 - number(v)) * (height - top - bottom);
    const grid = css("--border");
    const muted = css("--ink-3");
    let body = `<line x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(1)}" stroke="${muted}" stroke-width="1" stroke-dasharray="4 3"/>`;
    [0, 0.5, 1].forEach((tick) => {
      body += `<line x1="${px(tick)}" x2="${px(tick)}" y1="${top}" y2="${py(0)}" stroke="${grid}"/><line x1="${px(0)}" x2="${px(1)}" y1="${py(tick)}" y2="${py(tick)}" stroke="${grid}"/>`;
      body += `<text x="${px(tick)}" y="${height - 12}" text-anchor="middle" fill="${muted}" font-size="10">${tick}</text>`;
      body += `<text x="${left - 6}" y="${py(tick) + 3}" text-anchor="end" fill="${muted}" font-size="10">${tick}</text>`;
    });
    bins.forEach((bin) => {
      const radius = Math.min(12, Math.max(4, Math.sqrt(number(bin.n)) / 5));
      body += `<circle cx="${px(bin.mean_confidence)}" cy="${py(bin.accuracy)}" r="${radius}" fill="${css("--accent")}" fill-opacity="0.75" stroke="${css("--surface")}"><title>${P.esc(`Confidence ${bin.mean_confidence}, accuracy ${bin.accuracy}, n = ${bin.n}`)}</title></circle>`;
    });
    body += `<text x="${left}" y="${height - 1}" fill="${muted}" font-size="9">Mean confidence →</text>`;
    makeSvg(el, width, height, body, options.title, options.description);
  }

  // ------------------------------------------------------------ data series

  function volumeRows() {
    const volume = state.data.volumes || {};
    const groups = volume.groups || [];
    const companies = volume.companies || [];
    const years = volume.years || [];
    const filter = state.filters;
    const cube = volume.cube || [];
    const monthly = volume.monthly || [];
    const keep = (row, except) =>
      (except === "year" || filter.year === "all" || years[row[0]] === filter.year) &&
      (except === "group" || filter.group === "all" || groups[row[1]] === filter.group) &&
      (except === "company" || filter.company === "all" || companies[row[2]] === filter.company);
    const by = (rows, index, key) => {
      const result = new Map();
      rows.forEach((row) => result.set(key(row), (result.get(key(row)) || 0) + number(row[index])));
      return result;
    };
    const yearRows = by(cube.filter((row) => keep(row, "year")), 3, (row) => years[row[0]]);
    const groupRows = by(cube.filter((row) => keep(row, "group")), 3, (row) => groups[row[1]]);
    const companyRows = by(cube.filter((row) => keep(row, "company")), 3, (row) => companies[row[2]]);
    const keepMonthly = monthly.filter(
      (row) =>
        (filter.group === "all" || groups[row[1]] === filter.group) &&
        (filter.company === "all" || companies[row[2]] === filter.company),
    );
    const monthRows = by(keepMonthly, 2, (row) => volume.months[row[0]]);
    const narrativeRows = by(keepMonthly, 3, (row) => volume.months[row[0]]);
    const stateRows = by(
      (volume.states || []).filter(
        (row) => filter.year === "all" || String(row[1]) === String(filter.year),
      ),
      2,
      (row) => row[0],
    );
    return { yearRows, groupRows, companyRows, monthRows, narrativeRows, stateRows };
  }

  function chartSeries(kind) {
    const data = state.data;
    if (kind === "vol-years" || kind === "vol-products" || kind === "vol-companies" || kind === "vol-states") {
      const rows = volumeRows();
      const map =
        kind === "vol-years"
          ? rows.yearRows
          : kind === "vol-products"
            ? rows.groupRows
            : kind === "vol-companies"
              ? rows.companyRows
              : rows.stateRows;
      return [...map.entries()]
        .filter((entry) => entry[1] > 0)
        .sort((a, b) => (kind === "vol-years" ? String(a[0]).localeCompare(String(b[0])) : b[1] - a[1]))
        .slice(0, kind === "vol-states" ? 12 : 40)
        .map(([label, value]) => ({ label: String(label).replaceAll("_", " "), value, display: Math.round(value).toLocaleString("en-US") }));
    }
    if (kind === "vol-monthly") {
      const rows = volumeRows();
      return [...rows.monthRows.entries()].map(([label, value]) => ({
        label,
        values: [value, rows.narrativeRows.get(label) || 0],
      }));
    }
    if (kind === "router-models") {
      const models = (data.router || {}).models || {};
      const key = state.view === "new" ? "test_new_text" : "test";
      return ["majority", "words", "embeddings"].flatMap((name) => {
        const metrics = (models[name] || {})[key] || {};
        return [
          { label: `${name} · macro-F1`, value: number((metrics.macro_f1 || {}).value), low: (metrics.macro_f1 || {}).ci_low, high: (metrics.macro_f1 || {}).ci_high, display: `${(((metrics.macro_f1 || {}).value) * 100 || 0).toFixed(1)}%`, color: css("--accent") },
          { label: `${name} · accuracy`, value: number((metrics.accuracy || {}).value), low: (metrics.accuracy || {}).ci_low, high: (metrics.accuracy || {}).ci_high, display: `${(((metrics.accuracy || {}).value) * 100 || 0).toFixed(1)}%`, color: css("--ink-3") },
        ];
      });
    }
    if (kind === "confusion") {
      const router = data.router || {};
      const key = state.view === "new" ? "test_new_text" : "test";
      const metrics = (((router.models || {}).words || {})[key] || {});
      return { matrix: metrics.confusion || [], labels: router.products || [] };
    }
    if (kind === "reliability") {
      const router = data.router || {};
      const key = state.view === "new" ? "test_new_text" : "test";
      return ((((router.models || {}).words || {})[key] || {}).reliability) || [];
    }
    if (kind === "cost-time") {
      return (P.timeRows ? P.timeRows(data) : []).map(([label, value]) => ({
        label,
        value: number(value),
        display: P.seconds(number(value)),
        color: label.startsWith("Words") || label.startsWith("Embeddings") ? css("--accent") : css("--ink-3"),
      }));
    }
    if (kind === "quality-narrative") {
      return ((data.descriptive || {}).by_year || []).map((row) => ({
        label: String(row.year),
        value: number((row.narrative_share || {}).value),
        low: (row.narrative_share || {}).ci_low,
        high: (row.narrative_share || {}).ci_high,
        display: `${(number((row.narrative_share || {}).value) * 100).toFixed(number((row.narrative_share || {}).value) < 0.1 ? 1 : 0)}%`,
      }));
    }
    if (kind === "quality-repeats") {
      return ((data.descriptive || {}).repeats || []).map((row) => ({
        label: String(row.year),
        value: number((row.repeated_share || {}).value),
        low: (row.repeated_share || {}).ci_low,
        high: (row.repeated_share || {}).ci_high,
        display: `${(number((row.repeated_share || {}).value) * 100).toFixed(number((row.repeated_share || {}).value) < 0.1 ? 1 : 0)}%`,
      }));
    }
    if (kind === "radar-weekly" || kind === "novelty-weekly") {
      const weekly = kind === "radar-weekly" ? ((data.weekly || {}).radar || {}) : ((data.weekly || {}).novelty || {});
      const group = kind === "radar-weekly" ? state.group : (((weekly.groups || [])[0]));
      return { weekly, group };
    }
    return null;
  }

  // ------------------------------------------------------------ data moments

  function drawTimeline(el, group) {
    const weekly = ((state.data.weekly || {}).radar || {});
    // the week labels live once on the file, not on each series
    const raw = (weekly.series || {})[group];
    const series = raw && weekly.weeks ? { ...raw, weeks: weekly.weeks } : null;
    if (!series || !series.complaints) {
      return emptyChart(el, "No weekly series was published for this desk.");
    }
    const radar = state.data.radar || {};
    const desk = (radar.series || []).find((item) => item.product_group === group) || {};
    const width = Math.max(280, el.clientWidth || 800);
    const height = 320;
    const left = 44;
    const right = 14;
    const top = 70;
    const bottom = 42;
    const values = series.complaints.map((value) => number(value));
    const peak = Math.max(...values, 1) * 1.1;
    const count = values.length;
    const x = (i) => left + (i / Math.max(1, count - 1)) * (width - left - right);
    const y = (value) => top + (1 - value / peak) * (height - top - bottom);
    const signal = css("--signal") || "#C2410C";
    const accent = css("--accent");
    const muted = css("--ink-3");
    const grid = css("--border");
    let body = "";
    for (let tick = 0; tick <= 2; tick++) {
      const value = (peak / 2) * tick;
      body += `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="${grid}"/><text x="${left - 6}" y="${y(value) + 3}" text-anchor="end" fill="${muted}" font-size="11">${value >= 10000 ? `${Math.round(value / 1000)}k` : Math.round(value)}</text>`;
    }
    (desk.episodes || []).forEach((episode) => {
      const from = series.weeks.indexOf(episode.start);
      const to = series.weeks.indexOf(episode.end);
      if (from < 0 || to < 0) return;
      body += `<rect x="${x(from)}" y="${top}" width="${Math.max(2, x(to) - x(from))}" height="${height - top - bottom}" fill="${signal}" fill-opacity="0.1"><title>${P.esc(`Episode ${episode.start} to ${episode.end}`)}</title></rect>`;
    });
    const points = values.map((value, i) => `${x(i)},${y(value)}`).join(" ");
    body += `<g class="draw-x"><clipPath id="clip-${uid}"><rect class="clip-rect" x="0" y="0" width="${width}" height="${height}"/></clipPath><g clip-path="url(#clip-${uid})">`;
    body += `<polygon points="${x(0)},${y(0)} ${points} ${x(count - 1)},${y(0)}" fill="${css("--surface-2")}"/>`;
    body += `<polyline points="${points}" fill="none" stroke="${css("--ink-2")}" stroke-width="1.4"/></g></g>`;
    series.alarm.forEach((flag, i) => {
      if (!flag) return;
      body += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(values[i]) - 5}" y2="${y(values[i]) + 5}" stroke="${signal}" stroke-width="2"><title>${P.esc(`Alarm in week ${series.weeks[i]}`)}</title></line>`;
    });
    series.naive_alarm.forEach((flag, i) => {
      if (!flag) return;
      body += `<line x1="${x(i)}" x2="${x(i)}" y1="${height - bottom + 4}" y2="${height - bottom + 9}" stroke="${muted}" stroke-width="1.5"/>`;
    });
    // numbered flags: filled disc = detected, hollow ring = missed; the key under the chart names them
    (radar.events || [])
      .filter((event) => event.product_group === group)
      .forEach((event, i) => {
        const index = series.weeks.indexOf(event.week_start);
        if (index < 0) return;
        const xx = Math.min(width - right - 10, Math.max(left + 10, x(index)));
        const colour = event.detected ? css("--pass") : css("--fail");
        const cy = 22 + (i % 2) * 24;
        body += `<line x1="${x(index)}" x2="${x(index)}" y1="${cy + 10}" y2="${height - bottom}" stroke="${colour}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
        body += `<g><title>${P.esc(`${event.title}: ${event.detected ? "detected" : "missed"}`)}</title><circle cx="${xx}" cy="${cy}" r="10" fill="${event.detected ? colour : css("--surface")}" stroke="${colour}" stroke-width="2"/><text x="${xx}" y="${cy + 4}" text-anchor="middle" fill="${event.detected ? css("--surface") : colour}" font-size="12" font-weight="700">${i + 1}</text></g>`;
        if (!event.detected && width > 520) {
          body += `<text x="${xx + 15}" y="${cy + 4}" fill="${colour}" font-size="11" font-weight="700">MISSED</text>`;
        }
      });
    body += `<line x1="${left}" x2="${width - right}" y1="${height - bottom}" y2="${height - bottom}" stroke="${grid}"/>`;
    const marks = [0, Math.floor(count / 2), count - 1];
    marks.forEach((index, i) => {
      body += `<text x="${x(index)}" y="${height - 12}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}" fill="${muted}" font-size="11">${P.esc(series.weeks[index])}</text>`;
    });
    makeSvg(el, width, height, body, `Weekly complaints for ${group}`, "Bands are episodes, tall ticks are alarms, dashed flags are dated events.");
  }

  function drawNovelty(el) {
    const weekly = ((state.data.weekly || {}).novelty || {});
    const group = (weekly.groups || [])[0];
    const raw = (weekly.series || {})[group];
    const series = raw && weekly.weeks ? { ...raw, weeks: weekly.weeks } : null;
    if (!series || !series.mean_novelty) {
      return emptyChart(el, "No novelty series was published.");
    }
    const rows = series.weeks
      .map((week, i) => ({
        label: week,
        values: [number(series.mean_novelty[i]), series.alarm && series.alarm[i] ? number(series.mean_novelty[i]) : null],
      }))
      .filter((row) => row.values[0] > 0);
    drawLines(el, [
      { name: "Mean novelty", values: rows.map((row) => row.values[0]), color: css("--accent") },
      {
        name: "Alarm week",
        values: rows.map((row) => row.values[1]),
        color: css("--signal"),
        dash: false,
        width: 4,
      },
    ], rows.map((row) => row.label), {
      height: 240,
      title: "Weekly text novelty",
      description: "Exploratory series of the mean novelty of published narratives, with alarm weeks marked.",
    });
  }

  // ------------------------------------------------------------ sorting field

  function drawSorting(el, animate) {
    const canvas = document.createElement("canvas");
    const byProduct =
      ((((state.data.router || {}).models || {}).words || {}).auto_route || {}).by_product || [];
    const width = Math.max(280, el.clientWidth || 700);
    const rows = width < 640; // phones: one row per desk, label on the left
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    el.replaceChildren(canvas);
    const ctx = canvas.getContext("2d");
    const setSize = (h) => {
      canvas.style.width = "100%";
      canvas.style.height = `${h}px`;
      canvas.style.display = "block";
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    if (!byProduct.length) {
      setSize(60);
      ctx.fillStyle = css("--ink-2");
      ctx.font = "14px sans-serif";
      ctx.fillText("The routing result is not available.", 8, 24);
      return;
    }
    // one mark per thousandth of the test complaints, shared out by largest remainder
    const totals = byProduct.map((row) => number((row.coverage || {}).n));
    const total = totals.reduce((sum, value) => sum + value, 0) || 1;
    const exact = totals.map((value) => (value / total) * 1000);
    const counts = exact.map(Math.floor);
    const remainder = 1000 - counts.reduce((sum, value) => sum + value, 0);
    exact
      .map((value, i) => [value - Math.floor(value), i])
      .sort((a, b) => b[0] - a[0])
      .slice(0, remainder)
      .forEach((pair) => {
        counts[pair[1]] += 1;
      });
    const names = byProduct.map((row) => P.deskName(row.product));
    const labelFont = rows ? "11px 'JetBrains Mono', monospace" : "11.5px 'JetBrains Mono', monospace";
    ctx.font = labelFont;
    const wrap = (text, maxChars) => {
      const out = [];
      let line = "";
      text.split(" ").forEach((word) => {
        if ((line + " " + word).trim().length > maxChars && line) {
          out.push(line);
          line = word;
        } else {
          line = (line + " " + word).trim();
        }
      });
      if (line) out.push(line);
      return out;
    };
    // layout: a rectangle of marks per desk, and where its label goes
    const layout = [];
    let height;
    let pitch;
    if (!rows) {
      pitch = width > 900 ? 8 : 6;
      const gutter = 12;
      const col = (width - 2 * gutter) / counts.length;
      const perRow = Math.max(1, Math.floor((col - 8) / pitch));
      const tallest = Math.max(...counts.map((c) => Math.ceil(c / perRow)));
      const baseline = 14 + tallest * pitch + 6;
      height = baseline + 62;
      counts.forEach((count, desk) => {
        layout.push({
          x: gutter + desk * col + 4,
          perRow,
          place: (k) => [Math.floor(k % perRow) * pitch, baseline - (Math.floor(k / perRow) + 1) * pitch],
          label: wrap(names[desk], Math.max(8, Math.floor((col - 6) / 6.6))),
          labelX: gutter + desk * col + 4,
          labelY: baseline + 18,
          align: "left",
          count,
        });
      });
      layout.baseline = baseline;
    } else {
      pitch = 4;
      const labelW = Math.min(122, Math.floor(width * 0.36));
      const area = width - labelW - 12;
      const perRow = Math.max(1, Math.floor(area / pitch));
      let y = 8;
      counts.forEach((count, desk) => {
        const top = y;
        const lines = wrap(names[desk], Math.floor((labelW - 4) / 6.6));
        const h = Math.max(Math.ceil(count / perRow) * pitch, lines.length * 13) + 12;
        layout.push({
          x: labelW + 8,
          perRow,
          place: (k) => [(k % perRow) * pitch, top + 4 + Math.floor(k / perRow) * pitch],
          label: lines,
          labelX: 2,
          labelY: top + 14,
          align: "left",
          count,
        });
        y += h;
      });
      height = y + 4;
    }
    setSize(height);
    const marks = [];
    counts.forEach((deskCount, desk) => {
      const row = byProduct[desk] || {};
      const routedCount = Math.min(
        deskCount,
        Math.round((number((row.precision || {}).n) / (number((row.coverage || {}).n) || 1)) * deskCount),
      );
      const wrongCount = Math.round(routedCount * (1 - number((row.precision || {}).value)));
      let seed = desk * 7919 + 13;
      const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      const spot = layout[desk];
      for (let k = 0; k < deskCount; k++) {
        const kind = k < routedCount - wrongCount ? "auto" : k < routedCount ? "wrong" : "person";
        const [dx, finalY] = spot.place(k);
        marks.push({
          desk,
          kind,
          finalX: spot.x + dx,
          finalY,
          scatterX: 8 + random() * (width - 16),
          scatterY: 8 + random() * (height - 40),
        });
      }
    });
    const colors = { auto: css("--accent"), wrong: css("--signal"), person: css("--ink-3") };
    const ink = css("--ink-2");
    const rule = css("--border");
    const size = pitch - (pitch > 5 ? 2 : 1);
    const paint = (progress) => {
      ctx.clearRect(0, 0, width, height);
      ctx.font = labelFont;
      ctx.fillStyle = ink;
      ctx.textBaseline = "alphabetic";
      layout.forEach((spot, desk) => {
        spot.label.forEach((line, i) => ctx.fillText(line, spot.labelX, spot.labelY + i * 13));
        if (!rows) {
          ctx.strokeStyle = rule;
          ctx.beginPath();
          ctx.moveTo(spot.x - 2, layout.baseline + 0.5);
          ctx.lineTo(spot.x + spot.perRow * pitch, layout.baseline + 0.5);
          ctx.stroke();
        }
      });
      marks.forEach((mark) => {
        const stagger = Math.min(0.42, (mark.desk / counts.length) * 0.42);
        const local = Math.max(0, Math.min(1, (progress - stagger) / (1 - stagger)));
        const eased = 1 - (1 - local) ** 3;
        ctx.fillStyle = colors[mark.kind];
        ctx.fillRect(
          mark.scatterX + (mark.finalX - mark.scatterX) * eased,
          mark.scatterY + (mark.finalY - mark.scatterY) * eased,
          size,
          size,
        );
      });
    };
    if (!animate || reduced) {
      paint(1);
      return;
    }
    const start = performance.now();
    const frame = (now) => {
      const progress = Math.min(1, (now - start) / 2400);
      paint(1 - (1 - progress) ** 3);
      if (progress < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ chart dispatch

  function drawCharts() {
    if (!app) return;
    selectAll(app, ".chart[data-chart]").forEach((el) => {
      const kind = el.dataset.chart;
      if (kind === "sorting-room") return drawSorting(el, false);
      if (kind === "radar-weekly") return drawTimeline(el, state.group || el.dataset.group);
      if (kind === "novelty-weekly") return drawNovelty(el);
      const series = chartSeries(kind);
      if (!series) return emptyChart(el, "This chart is not available.");
      if (kind === "confusion") {
        return drawHeatmap(el, series.matrix, series.labels, {
          title: "Words model confusion matrix",
          description: "Rows are true desks, columns are predicted desks, printed cells are row shares in per cent.",
        });
      }
      if (kind === "reliability") {
        return drawReliability(el, series, {
          title: "Reliability by confidence bin",
          description: "Each circle is one bin of mean confidence against observed accuracy.",
        });
      }
      if (kind === "vol-monthly") {
        return drawLines(el, [
          { name: "Complaints", values: series.map((row) => row.values[0]), color: css("--ink-3") },
          { name: "With narrative", values: series.map((row) => row.values[1]), color: css("--accent") },
        ], series.map((row) => row.label), {
          height: 300,
          title: "Complaints by month with and without a narrative",
          description: "Two monthly series across the whole archive; the gap widens in the latest year.",
        });
      }
      if (kind === "router-models") {
        return drawBars(el, series, {
          height: Math.max(280, series.length * 30 + 44),
          labelWidth: Math.min(210, Math.max(120, (el.clientWidth || 600) * 0.4)),
          title: "Model macro-F1 and accuracy with intervals",
          description: "Horizontal bars with whiskers for the published 95% intervals.",
        });
      }
      if (kind === "cost-time") {
        const top = Math.max(...series.map((row) => row.value));
        return drawBars(el, series, {
          height: 200,
          log: [0.01, Math.pow(10, Math.ceil(Math.log10(top)))],
          title: "Seconds per thousand complaints on a log scale",
          description: "Each gridline is ten times the one before it.",
        });
      }
      return drawBars(el, series, {
        title: kind,
        description: "Bars drawn to scale from the data file.",
        labelWidth:
          kind === "vol-companies"
            ? Math.min(190, Math.max(120, (el.clientWidth || 600) * 0.42))
            : undefined,
      });
    });
  }

  function startSortingWhenVisible() {
    const el = select(app, '.chart[data-chart="sorting-room"]');
    if (!el) return;
    if (reduced || !("IntersectionObserver" in window)) {
      drawSorting(el, false);
      state.sortedDrawn = true;
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !state.sortedDrawn) {
            state.sortedDrawn = true;
            drawSorting(el, true);
            observer.disconnect();
          }
        });
      },
      { threshold: 0.25 },
    );
    drawSorting(el, false);
    observer.observe(el);
  }

  // ------------------------------------------------------------------ wiring

  function initVolumes() {
    selectAll(app, "[data-filter]").forEach((control) => {
      control.addEventListener("change", () => {
        state.filters[control.dataset.filter] = control.value;
        const holder = select(app, "#vol-dashboard");
        if (holder) holder.innerHTML = P.volumesDashboard(state.data, state.filters);
        drawCharts();
      });
    });
  }

  function initRouter() {
    selectAll(app, "[data-view]").forEach((button) => {
      button.addEventListener("click", () => {
        state.view = button.dataset.view;
        selectAll(app, "[data-view]").forEach((item) => {
          const active = item.dataset.view === state.view;
          item.classList.toggle("selected", active);
          item.setAttribute("aria-pressed", String(active));
        });
        const holder = select(app, "#router-dashboard");
        if (holder) holder.innerHTML = P.routerDashboard(state.data, state.view);
        drawCharts();
      });
    });
  }

  function initRadar() {
    selectAll(app, "[data-radar-group]").forEach((button) => {
      button.addEventListener("click", () => {
        state.group = button.dataset.radarGroup;
        selectAll(app, "[data-radar-group]").forEach((item) => {
          const active = item.dataset.radarGroup === state.group;
          item.classList.toggle("selected", active);
          item.setAttribute("aria-pressed", String(active));
        });
        const holder = select(app, "#radar-dashboard");
        if (holder) holder.innerHTML = P.radarDashboard(state.data, state.group);
        drawCharts();
      });
    });
  }

  function initQuality() {
    const input = select(app, "#taxonomy-search");
    if (!input) return;
    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      selectAll(app, ".taxonomy-table tbody tr").forEach((row) => {
        row.hidden = !row.textContent.toLowerCase().includes(query);
      });
    });
  }

  // The speed gap: both lanes run on one clock scaled from the measured seconds; once, then static.
  function initRace() {
    const root = select(app, "[data-race]");
    if (!root || reduced || !("IntersectionObserver" in window)) return;
    const lanes = selectAll(root, ".lane").map((lane) => ({
      secs: Number(lane.dataset.seconds),
      share: Number(lane.dataset.share),
      fill: select(lane, ".lane-fill"),
      count: select(lane, ".lane-n"),
      time: select(lane, ".lane-time"),
      final: select(lane, ".lane-time").textContent,
    }));
    const slowest = Math.max(...lanes.map((lane) => lane.secs));
    const show = 2500; // ms on screen for the slowest run
    const set = (progressOf) =>
      lanes.forEach((lane) => {
        const p = progressOf(lane);
        lane.fill.style.transform = `scaleX(${p * lane.share})`;
        lane.count.textContent = P.integer(Math.floor(p * 1000));
        lane.time.textContent = p >= 1 ? lane.final : P.duration(p * lane.secs);
      });
    set(() => 0);
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const start = performance.now();
      const frame = (now) => {
        const real = ((now - start) / show) * slowest;
        set((lane) => Math.min(1, real / lane.secs));
        if (real < slowest) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, { threshold: 0.5 });
    observer.observe(root);
  }

  function initCost() {
    initRace();
    const input = select(app, "#price-input");
    if (!input) return;
    input.addEventListener("input", () => {
      const result = select(app, "#cost-result");
      if (result) result.textContent = P.costResult(state.data, input.value);
    });
  }

  function resultHtml(result) {
    const model = state.model || {};
    const threshold = P.ok(model.threshold) ? model.threshold : null;
    const lines = result.probabilities
      .map(
        (item) => `<div class="prob-row"><span>${P.esc(item.product)}</span><span class="prob-track"><span style="transform:scaleX(${item.p})"></span></span><span class="mono">${(item.p * 100).toFixed(1)}%</span></div>`,
      )
      .join("");
    const terms = result.terms.length
      ? result.terms.map((item) => `<li>${P.esc(item.term)} <span class="mono">+${item.weight.toFixed(3)}</span></li>`).join("")
      : '<li>No vocabulary terms from this text moved the decision.</li>';
    const badge = result.routed
      ? '<span class="badge big pass">Sent automatically</span>'
      : '<span class="badge big idle">A person decides</span>';
    const at = (v) => Math.max(0, Math.min(100, v * 100));
    const mark = threshold == null ? "" : `<span class="hbar-mark" style="left:${at(threshold)}%"><i>routing threshold ${(threshold * 100).toFixed(1)}%</i></span>`;
    return `<p class="eyebrow">THE DESK</p><h2 class="desk-name">${P.esc(P.deskName(result.product))}</h2>${badge}
      <div class="hbar"><div class="hbar-head"><span class="hbar-label">Confidence</span><span class="hbar-value mono">${(result.confidence * 100).toFixed(1)}%</span></div>
      <div class="hbar-track"><span class="hbar-fill ${result.routed ? "tone-accent" : "tone-grey"}" style="width:${at(result.confidence)}%"></span>${mark}</div>
      <p class="hbar-meta">${threshold == null ? "Threshold not published." : `Above the threshold the complaint is sent on automatically; below it, a person decides.`}</p></div>
      <div class="desk-cols"><div><h3>All eleven desks</h3><div class="probabilities">${lines}</div></div>
      <div><h3>Terms that pushed the decision</h3><ul class="terms">${terms}</ul></div></div>`;
  }

  function loadModel() {
    if (state.modelPromise) return state.modelPromise;
    const status = select(app, "#try-status");
    if (status) status.textContent = "Loading the model into your browser…";
    state.modelPromise = fetch("data/model.json")
      .then((response) => {
        if (!response.ok) throw new Error("model unavailable");
        return response.json();
      })
      .then((model) => {
        state.model = model;
        if (status) status.textContent = "The model is loaded. Nothing you type leaves this page.";
        return model;
      })
      .catch(() => {
        state.modelPromise = null;
        if (status) status.textContent = "The model could not be loaded. Please reload this page.";
        return null;
      });
    return state.modelPromise;
  }

  function initTry() {
    const field = select(app, "#try-text");
    const resultBox = select(app, "#try-result");
    if (!field || !resultBox) return;
    const run = async () => {
      const model = await loadModel();
      if (!model) return;
      const text = field.value.trim();
      if (!text) {
        resultBox.innerHTML = '<p class="muted">Your result will appear here, as a card for the desk the complaint is sent to.</p>';
        return;
      }
      resultBox.innerHTML = resultHtml(window.classify(text, model));
    };
    field.addEventListener("input", run);
    field.addEventListener("focus", loadModel);
    selectAll(app, "[data-example]").forEach((button) => {
      button.addEventListener("click", () => {
        const examples = [
          "My mortgage servicer keeps adding fees I never agreed to and will not explain my escrow account.",
          "A debt collector calls me every day about a debt I already paid and threatens to sue me.",
          "The credit bureau shows an account that is not mine and will not remove it after I disputed it.",
        ];
        field.value = examples[number(button.dataset.example)];
        run();
      });
    });
  }

  const specific = {
    volumes: initVolumes,
    router: initRouter,
    radar: initRadar,
    quality: initQuality,
    cost: initCost,
    try: initTry,
  };

  function mount() {
    const totals = (state.data.descriptive || {}).totals || {};
    const range = document.getElementById("footer-range");
    if (range && P.ok(totals.first_date) && P.ok(totals.last_date)) {
      range.textContent = `${totals.first_date} to ${totals.last_date}`;
    }
    const renderers = {
      index: P.renderIndex,
      volumes: P.renderVolumes,
      router: P.renderRouter,
      cost: P.renderCost,
      radar: P.renderRadar,
      quality: P.renderQuality,
      try: P.renderTry,
    };
    const render = renderers[page] || P.renderIndex;
    if (page === "radar") {
      const events = (state.data.radar || {}).events || [];
      state.group = (events[0] || {}).product_group || ((((state.data.weekly || {}).radar || {}).groups || [])[0]);
    }
    app.innerHTML =
      page === "volumes"
        ? render(state.data, state.filters)
        : page === "router"
          ? render(state.data, state.view)
          : page === "radar"
            ? render(state.data, state.group)
            : render(state.data);
    if (specific[page]) specific[page]();
    initReveal();
    drawCharts();
    if (page === "index") startSortingWhenVisible();
  }

  async function boot() {
    initTheme();
    initGlossary();
    try {
      const manifestResponse = await fetch("data/manifest.json");
      const manifest = await manifestResponse.json();
      const names = manifest.files || [];
      const pairs = await Promise.all(
        names.map(async (name) => {
          try {
            const response = await fetch(`data/${name}`);
            return [name.replace(".json", ""), await response.json()];
          } catch (error) {
            return [name.replace(".json", ""), null];
          }
        }),
      );
      pairs.forEach(([key, value]) => {
        state.data[key === "llm_eval" ? "llmEval" : key] = value;
      });
      mount();
    } catch (error) {
      console.warn("boot failed", error);
      app.innerHTML =
        '<section class="card"><h1>The data could not be loaded</h1><p>Open this site from the repository so the local data files are available.</p></section>';
    }
  }

  let resizeTicket = null;
  window.addEventListener("resize", () => {
    if (resizeTicket) cancelAnimationFrame(resizeTicket);
    resizeTicket = requestAnimationFrame(() => {
      drawCharts();
      if (state.sortedDrawn) {
        const el = select(app, '.chart[data-chart="sorting-room"]');
        if (el) drawSorting(el, false);
      }
    });
  });

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      drawCharts();
      const room = select(app, '.chart[data-chart="sorting-room"]');
      if (room && state.sortedDrawn) drawSorting(room, false);
    });
  }
  boot();
})();
