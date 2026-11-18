"use strict";

// SVG charts that need the real width of their container: monthly volumes, the calibration
// chart, the weekly radar timeline and the text-novelty line. Colours are CSS variables, so a
// theme change needs no redraw. Each function replaces the contents of the element it is given.

const Charts = (() => {
  const SVG = "http://www.w3.org/2000/svg";
  let uid = 0;

  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  function compact(value) {
    const v = Math.abs(value);
    if (v >= 1e6) return `${(value / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
    if (v >= 1e3) return `${(value / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k`;
    return String(Math.round(value * 100) / 100);
  }

  function niceMax(value) {
    if (!(value > 0)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(value)));
    return ([1, 2, 2.5, 5, 10].find((step) => step * pow >= value) || 10) * pow;
  }

  function frame(el, width, height, body, title, description) {
    const a = `ct-${++uid}`;
    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${a}-t ${a}-d"><title id="${a}-t">${esc(title)}</title><desc id="${a}-d">${esc(description || "")}</desc>${body}</svg>`;
    return el.querySelector("svg");
  }

  function width(el) {
    return Math.max(280, Math.round(el.clientWidth || 600));
  }

  // A hover read-out: finds the nearest index to the pointer and shows text from `text(i)`.
  function attachTip(el, svg, w, h, xs, text) {
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    el.appendChild(tip);
    const line = document.createElementNS(SVG, "line");
    line.setAttribute("class", "tip-line");
    line.setAttribute("y1", "0");
    line.setAttribute("y2", String(h));
    line.setAttribute("visibility", "hidden");
    svg.appendChild(line);
    const move = (event) => {
      const box = svg.getBoundingClientRect();
      const px = ((event.clientX - box.left) / box.width) * w;
      let best = 0;
      for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - px) < Math.abs(xs[best] - px)) best = i;
      line.setAttribute("x1", String(xs[best]));
      line.setAttribute("x2", String(xs[best]));
      line.setAttribute("visibility", "visible");
      tip.innerHTML = text(best);
      tip.hidden = false;
      const left = (xs[best] / w) * box.width;
      tip.style.left = `${Math.min(Math.max(left + 12, 0), box.width - tip.offsetWidth)}px`;
      tip.style.top = "0px";
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerleave", () => {
      tip.hidden = true;
      line.setAttribute("visibility", "hidden");
    });
  }

  // Generic line chart. o: {labels, series:[{name, values, style, width, area}], log, height, title,
  // description, tip(i), overlay(ctx) -> svg string drawn above the lines, format(v)}
  function line(el, o) {
    const labels = o.labels;
    if (!labels.length) {
      el.innerHTML = '<p class="empty">No series was published for this selection.</p>';
      return;
    }
    const w = width(el);
    const h = o.height || (w < 600 ? 260 : 340);
    const m = { l: 46, r: 14, t: o.top || 20, b: 32 };
    const n = labels.length;
    const x = (i) => m.l + (i / Math.max(1, n - 1)) * (w - m.l - m.r);
    const all = o.series.flatMap((s) => s.values.filter((v) => v != null).map(num));
    const peak = Math.max(...all, 1);
    const ymax = o.log ? Math.pow(10, Math.max(1, Math.ceil(Math.log10(peak)))) : niceMax(peak * 1.04);
    const y = (v) => {
      const frac = o.log ? Math.log10(Math.max(1, num(v))) / Math.log10(ymax) : num(v) / ymax;
      return m.t + (1 - Math.min(1, frac)) * (h - m.t - m.b);
    };
    const fmt = o.format || compact;
    let body = "";
    const ticks = [];
    if (o.log) for (let e = 0; e <= Math.log10(ymax); e++) ticks.push(Math.pow(10, e));
    else for (let k = 0; k <= 4; k++) ticks.push((ymax / 4) * k);
    ticks.forEach((t) => {
      body += `<line class="gl" x1="${m.l}" x2="${w - m.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="ax" x="${m.l - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${fmt(t)}</text>`;
    });
    // one label per year, every other year on narrow screens
    const years = [];
    labels.forEach((label, i) => {
      const year = String(label).slice(0, 4);
      if (i === 0 || year !== String(labels[i - 1]).slice(0, 4)) years.push([i, year]);
    });
    const step = w < 600 ? Math.ceil(years.length / 5) : Math.ceil(years.length / 14);
    years.forEach(([i, year], k) => {
      if (k % step === 0) body += `<text class="ax" x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="${i === 0 ? "start" : "middle"}">${year}</text>`;
    });
    body += `<line class="axis-line" x1="${m.l}" x2="${w - m.r}" y1="${h - m.b}" y2="${h - m.b}"/>`;
    if (o.under) body += o.under({ x, y, w, h, m });
    o.series.forEach((s) => {
      let d = "";
      let pen = false;
      let first = null;
      let last = null;
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
        if (first === null) first = i;
        last = i;
        pen = true;
      });
      if (s.area && first !== null) {
        body += `<path class="reveal-fade" d="${d}L${x(last).toFixed(1)} ${y(0).toFixed(1)}L${x(first).toFixed(1)} ${y(0).toFixed(1)}Z" style="fill:${s.style};opacity:.12"/>`;
      }
      body += `<path class="reveal-path" pathLength="1" d="${d}" fill="none" style="stroke:${s.style}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
    });
    if (o.overlay) body += o.overlay({ x, y, w, h, m });
    const svg = frame(el, w, h, body, o.title, o.description);
    if (o.tip) attachTip(el, svg, w, h, labels.map((_, i) => x(i)), o.tip);
  }

  function monthly(el, rows) {
    line(el, {
      labels: rows.map((r) => r.label),
      series: [
        { name: "All complaints", values: rows.map((r) => r.complaints), style: "var(--muted)", width: 2, area: true },
        { name: "With a narrative", values: rows.map((r) => r.narratives), style: "var(--violet)", width: 3, area: true },
      ],
      title: "Monthly complaints, with and without a narrative",
      description: "Two lines by month: all complaints, and those that carry a narrative.",
      tip: (i) => `<b>${esc(rows[i].label)}</b>All complaints ${rows[i].complaints.toLocaleString("en-US")}<br>With a narrative ${rows[i].narratives.toLocaleString("en-US")}`,
    });
    const key = document.createElement("p");
    key.className = "legend";
    key.innerHTML = '<span><i class="dot" style="background:var(--muted)"></i>All complaints</span><span><i class="dot" style="background:var(--violet)"></i>With a narrative</span>';
    el.appendChild(key);
  }

  function reliability(el, bins) {
    const w = Math.min(width(el), 460);
    const h = Math.round(w * 0.92);
    const m = { l: 44, r: 14, t: 12, b: 44 };
    const x = (v) => m.l + v * (w - m.l - m.r);
    const y = (v) => m.t + (1 - v) * (h - m.t - m.b);
    let body = "";
    [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
      body += `<line class="gl" x1="${m.l}" x2="${w - m.r}" y1="${y(t)}" y2="${y(t)}"/><line class="gl" y1="${m.t}" y2="${h - m.b}" x1="${x(t)}" x2="${x(t)}"/>`;
      body += `<text class="ax" x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${Math.round(t * 100)}</text><text class="ax" x="${x(t)}" y="${h - m.b + 18}" text-anchor="middle">${Math.round(t * 100)}</text>`;
    });
    body += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke-dasharray="5 5" style="stroke:var(--muted)" stroke-width="1.5"/>`;
    body += `<text class="ax" x="${(m.l + w - m.r) / 2}" y="${h - 4}" text-anchor="middle">Stated confidence, %</text>`;
    body += `<text class="ax" transform="translate(12 ${(m.t + h - m.b) / 2}) rotate(-90)" text-anchor="middle">Share right, %</text>`;
    const peak = Math.max(...bins.map((b) => num(b.n)), 1);
    const pts = bins.filter((b) => num(b.n) > 0).map((b) => {
      const r = 4 + 10 * Math.sqrt(num(b.n) / peak);
      return `<circle class="reveal-fade" cx="${x(num(b.mean_confidence)).toFixed(1)}" cy="${y(num(b.accuracy)).toFixed(1)}" r="${r.toFixed(1)}" style="fill:var(--accent);fill-opacity:.85;stroke:var(--bg)" stroke-width="1.5"><title>${esc(`Confidence ${(num(b.mean_confidence) * 100).toFixed(1)}%, right ${(num(b.accuracy) * 100).toFixed(1)}%, n = ${num(b.n).toLocaleString("en-US")}`)}</title></circle>`;
    });
    frame(el, w, h, body + pts.join(""), "Confidence against accuracy", "Each dot is a confidence bin; the dashed diagonal is perfect calibration. Dot size is the number of complaints in the bin.");
  }

  // Weekly radar timeline for one desk, linear or log, with episodes, alarm ticks and event flags.
  function timeline(el, data, group, scale) {
    const weekly = ((data.weekly || {}).radar || {});
    const raw = (weekly.series || {})[group];
    if (!raw || !weekly.weeks || !raw.complaints) {
      el.innerHTML = '<p class="empty">No weekly series was published for this desk.</p>';
      return;
    }
    const weeks = weekly.weeks;
    const radar = data.radar || {};
    const desk = (radar.series || []).find((s) => s.product_group === group) || {};
    const events = (radar.events || []).filter((e) => e.product_group === group);
    const log = scale === "log";
    const w = width(el);
    const under = ({ x, y, h, m }) => {
      let out = "";
      (desk.episodes || []).forEach((ep) => {
        const a = weeks.indexOf(ep.start);
        const b = weeks.indexOf(ep.end);
        if (a < 0 || b < 0) return;
        out += `<rect x="${x(a).toFixed(1)}" y="${m.t}" width="${Math.max(3, x(b) - x(a)).toFixed(1)}" height="${h - m.t - m.b}" style="fill:${ep.event_id ? "var(--accent)" : "var(--alert)"};opacity:.16"><title>${esc(`Episode ${ep.start} to ${ep.end}${ep.event_id ? "" : ", unexplained"}`)}</title></rect>`;
      });
      return out;
    };
    const overlay = ({ x, y, w: ww, h, m }) => {
      let out = "";
      raw.alarm.forEach((flag, i) => {
        if (flag) out += `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${(y(raw.complaints[i]) - 7).toFixed(1)}" y2="${(y(raw.complaints[i]) + 7).toFixed(1)}" style="stroke:var(--alert)" stroke-width="2.5"><title>${esc(`Alarm in week ${weeks[i]}`)}</title></line>`;
      });
      raw.naive_alarm.forEach((flag, i) => {
        if (flag) out += `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${h - m.b + 3}" y2="${h - m.b + 9}" style="stroke:var(--muted)" stroke-width="1.5"/>`;
      });
      events.forEach((event, k) => {
        const i = weeks.indexOf(event.week_start);
        if (i < 0) return;
        const px = Math.min(ww - m.r - 11, Math.max(m.l + 11, x(i)));
        const cy = 12 + (k % 2) * 4;
        const colour = event.detected ? "var(--accent)" : "var(--alert)";
        out += `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${cy + 11}" y2="${h - m.b}" style="stroke:${colour}" stroke-width="1.5" stroke-dasharray="4 4"/>`;
        out += `<g><title>${esc(`${event.title}: ${event.detected ? "detected" : "missed"}`)}</title><circle cx="${px.toFixed(1)}" cy="${cy}" r="11" style="fill:${event.detected ? "var(--accent)" : "var(--bg)"};stroke:${colour}" stroke-width="2.5"/><text x="${px.toFixed(1)}" y="${cy + 4}" text-anchor="middle" font-size="12" font-weight="700" style="fill:${event.detected ? "var(--accent-ink)" : "var(--alert)"}">${k + 1}</text></g>`;
        if (!event.detected && ww > 520) out += `<text x="${(px + 16).toFixed(1)}" y="${cy + 4}" font-size="12" font-weight="700" style="fill:var(--alert)">MISSED</text>`;
      });
      return out;
    };
    line(el, {
      labels: weeks,
      series: [{ name: "Complaints", values: raw.complaints, style: "var(--text)", width: 1.6, area: true }],
      log, under, overlay, top: 36,
      height: w < 600 ? 300 : 380,
      title: `Weekly complaints for ${group.replaceAll("_", " ")}`,
      description: "Shaded bands are alarm episodes, tall ticks are alarm weeks, dashed flags are dated events.",
      tip: (i) => `<b>${esc(weeks[i])}</b>${num(raw.complaints[i]).toLocaleString("en-US")} complaints${raw.z && raw.z[i] != null ? `<br>z ${num(raw.z[i]).toFixed(2)}` : ""}${raw.alarm[i] ? "<br>Alarm week" : ""}`,
    });
  }

  function novelty(el, data) {
    const weekly = ((data.weekly || {}).novelty || {});
    const group = (weekly.groups || [])[0];
    const raw = (weekly.series || {})[group];
    if (!raw || !weekly.weeks || !raw.mean_novelty) {
      el.innerHTML = '<p class="empty">No novelty series was published.</p>';
      return;
    }
    const keep = weekly.weeks.map((week, i) => [week, num(raw.mean_novelty[i]), raw.alarm && raw.alarm[i] ? num(raw.mean_novelty[i]) : null]).filter((row) => row[1] > 0);
    line(el, {
      labels: keep.map((r) => r[0]),
      series: [
        { name: "Mean novelty", values: keep.map((r) => r[1]), style: "var(--violet)", width: 1.8 },
        { name: "Alarm week", values: keep.map((r) => r[2]), style: "var(--alert)", width: 5 },
      ],
      format: (v) => (Math.round(v * 1000) / 1000).toString(),
      title: `Weekly text novelty, ${group.replaceAll("_", " ")}`,
      description: "Exploratory series of the mean novelty of published narratives, with alarm weeks marked.",
      tip: (i) => `<b>${esc(keep[i][0])}</b>Mean novelty ${keep[i][1].toFixed(3)}${keep[i][2] != null ? "<br>Alarm week" : ""}`,
    });
    const key = document.createElement("p");
    key.className = "note";
    key.textContent = `Desk shown: ${group.replaceAll("_", " ")}.`;
    el.appendChild(key);
  }

  return { monthly, reliability, timeline, novelty };
})();

if (typeof window !== "undefined") window.Charts = Charts;
