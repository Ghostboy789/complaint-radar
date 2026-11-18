"use strict";

// Canvas pieces of the overview: the radar scope in the hero and the dot wall in the sorting
// room. Both read colours from CSS variables at draw time. Both animate once, then stay still;
// with reduced motion they draw the final state straight away.

const Scope = (() => {
  const TAU = Math.PI * 2;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colours = () => ({
    accent: css("--accent"), alert: css("--alert"), text: css("--text"), muted: css("--muted"),
    line: css("--line"), bg: css("--bg"), track: css("--track-2"),
  });

  function alpha(colour, a) {
    // colour is #rrggbb from the tokens; fall back to the colour itself if it is not
    const m = /^#([0-9a-f]{6})$/i.exec(colour);
    if (!m) return colour;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function size(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // ---------------------------------------------------------------- scope

  const scope = { root: null, data: null, raf: 0, drawn: 1, running: false };

  function frac(date, first, last) {
    return (Date.parse(date) - Date.parse(first)) / (Date.parse(last) - Date.parse(first));
  }

  function geometry(root, canvas) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const phone = w < 600;
    const cx = w / 2;
    const cy = h / 2;
    const R = phone ? w / 2 - 22 : Math.min(h / 2 - 36, w / 2 - 260);
    return { w, h, phone, cx, cy, R: Math.max(R, 120) };
  }

  // Positions of the five rim markers and their labels. Labels on each side are nudged apart.
  function layout(data, g) {
    const radar = data.radar || {};
    const weeks = radar.weeks || {};
    const events = (radar.events || []).map((event, i) => {
      const t = frac(event.week_start, weeks.first, weeks.last);
      const a = -Math.PI / 2 + TAU * t;
      const left = Math.cos(a) < 0;
      const x = g.cx + Math.cos(a) * g.R;
      const y = g.cy + Math.sin(a) * g.R;
      return { event, i, t, a, x, y, left, lx: g.cx + Math.cos(a) * (g.R + 56) + (left ? -18 : 18), ly: g.cy + Math.sin(a) * (g.R + 40) };
    });
    ["left", "right"].forEach((side) => {
      const side_ = events.filter((e) => (side === "left") === e.left).sort((p, q) => p.ly - q.ly);
      for (let k = 1; k < side_.length; k++) side_[k].ly = Math.max(side_[k].ly, side_[k - 1].ly + 46);
    });
    return events;
  }

  function draw(progress) {
    const root = scope.root;
    if (!root) return;
    const canvas = root.querySelector(".scope-canvas");
    const { ctx, w, h } = size(canvas);
    const g = geometry(root, canvas);
    const c = colours();
    const data = scope.data;
    const radar = data.radar || {};
    const weeks = radar.weeks || {};
    const series = radar.series || [];
    const events = layout(data, g);
    ctx.clearRect(0, 0, w, h);

    // soft glow behind the scope
    const glow = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.R * 1.25);
    glow.addColorStop(0, alpha(c.accent, 0.1));
    glow.addColorStop(1, alpha(c.accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // rings, one per product group, centre outwards; spokes by year
    const ringR = (s) => g.R * (0.2 + 0.8 * (series.length > 1 ? s / (series.length - 1) : 1));
    ctx.lineWidth = 1;
    ctx.strokeStyle = alpha(c.text, 0.1);
    series.forEach((_, s) => {
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, ringR(s), 0, TAU);
      ctx.stroke();
    });
    ctx.strokeStyle = alpha(c.text, 0.28);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.R, 0, TAU);
    ctx.stroke();
    const y0 = new Date(weeks.first).getUTCFullYear();
    const y1 = new Date(weeks.last).getUTCFullYear();
    ctx.font = `500 11px "Inter Tight", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let year = y0 + 1; year <= y1; year++) {
      const t = frac(`${year}-01-01`, weeks.first, weeks.last);
      const a = -Math.PI / 2 + TAU * t;
      ctx.strokeStyle = alpha(c.text, 0.28);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(g.cx + Math.cos(a) * (g.R - 7), g.cy + Math.sin(a) * (g.R - 7));
      ctx.lineTo(g.cx + Math.cos(a) * (g.R + 5), g.cy + Math.sin(a) * (g.R + 5));
      ctx.stroke();
      if (!g.phone && (year - y0) % 2 === 0) {
        ctx.fillStyle = c.muted;
        ctx.fillText(String(year), g.cx + Math.cos(a) * (g.R - 22), g.cy + Math.sin(a) * (g.R - 22));
      }
    }
    ctx.strokeStyle = alpha(c.text, 0.07);
    ctx.beginPath();
    ctx.moveTo(g.cx - g.R, g.cy); ctx.lineTo(g.cx + g.R, g.cy);
    ctx.moveTo(g.cx, g.cy - g.R); ctx.lineTo(g.cx, g.cy + g.R);
    ctx.stroke();

    // sweep: a trailing wedge and the leading line
    const sweepA = -Math.PI / 2 + TAU * progress;
    if (progress > 0 && progress < 1 && ctx.createConicGradient) {
      const trail = ctx.createConicGradient(sweepA - 1.1, g.cx, g.cy);
      trail.addColorStop(0, alpha(c.accent, 0));
      trail.addColorStop(1 / TAU * 1.1, alpha(c.accent, 0.32));
      trail.addColorStop(1 / TAU * 1.1 + 0.0001, alpha(c.accent, 0));
      ctx.fillStyle = trail;
      ctx.beginPath();
      ctx.moveTo(g.cx, g.cy);
      ctx.arc(g.cx, g.cy, g.R, sweepA - 1.1, sweepA);
      ctx.closePath();
      ctx.fill();
    }
    if (progress > 0 && progress < 1) {
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2;
      ctx.shadowColor = c.accent;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.moveTo(g.cx, g.cy);
      ctx.lineTo(g.cx + Math.cos(sweepA) * g.R, g.cy + Math.sin(sweepA) * g.R);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // blips: one per alarm episode, placed by start date and by desk ring
    const flare = (t) => Math.max(0, 1 - (progress - t) / 0.12);
    series.forEach((s, si) => {
      (s.episodes || []).forEach((ep) => {
        const t = frac(ep.start, weeks.first, weeks.last);
        if (progress < t) return;
        const t2 = Math.max(t, frac(ep.end, weeks.first, weeks.last));
        const a = -Math.PI / 2 + TAU * t;
        const colour = ep.event_id ? c.accent : c.alert;
        const r = ringR(si);
        if (t2 > t) {
          ctx.strokeStyle = alpha(colour, 0.7);
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(g.cx, g.cy, r, a, -Math.PI / 2 + TAU * Math.min(t2, Math.max(t, progress)));
          ctx.stroke();
        }
        const px = g.cx + Math.cos(a) * r;
        const py = g.cy + Math.sin(a) * r;
        const radius = 3.5 + Math.min(8, (ep.alarm_weeks || 1) * 0.9);
        const f = flare(t);
        const halo = ctx.createRadialGradient(px, py, 0, px, py, radius * (2.4 + 2.5 * f));
        halo.addColorStop(0, alpha(colour, 0.55 + 0.4 * f));
        halo.addColorStop(1, alpha(colour, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(px, py, radius * (2.4 + 2.5 * f), 0, TAU);
        ctx.fill();
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, TAU);
        ctx.fill();
      });
    });

    // rim markers for the known events and their leader lines
    events.forEach((e) => {
      if (progress < e.t) return;
      const hit = e.event.detected;
      const colour = hit ? c.accent : c.alert;
      const f = flare(e.t);
      if (!g.phone) {
        ctx.strokeStyle = alpha(colour, 0.55);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(e.x, e.y);
        ctx.lineTo(e.lx + (e.left ? 8 : -8), e.ly);
        ctx.stroke();
      }
      const rr = g.phone ? 10 : 8;
      if (hit) {
        ctx.shadowColor = colour;
        ctx.shadowBlur = 16 + 16 * f;
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(e.x, e.y, rr, 0, TAU);
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = c.bg;
        ctx.beginPath();
        ctx.arc(e.x, e.y, rr + 2, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = colour;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(e.x, e.y, rr + 2, 0, TAU);
        ctx.stroke();
      }
      if (g.phone) {
        ctx.fillStyle = hit ? css("--accent-ink") : colour;
        ctx.font = `700 12px "Inter Tight", system-ui, sans-serif`;
        ctx.fillText(String(e.i + 1), e.x, e.y + 0.5);
      }
    });

    // centre
    ctx.fillStyle = c.text;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, 3, 0, TAU);
    ctx.fill();

    placeLabels(events, g, progress);
  }

  function placeLabels(events, g, progress) {
    const list = scope.root.querySelector(".scope-labels");
    if (!list || g.phone) return;
    if (!list.children.length) {
      list.innerHTML = events
        .map((e) => `<li class="${e.event.detected ? "hit" : "miss"}"><b>${e.i + 1}. ${scope.esc(e.event.title)}</b><small>${scope.esc(e.event.event_date)} · ${e.event.detected ? "caught" : "missed"}</small></li>`)
        .join("");
    }
    Array.from(list.children).forEach((li, k) => {
      const e = events[k];
      li.style.left = `${e.lx}px`;
      li.style.top = `${e.ly}px`;
      li.classList.toggle("left", e.left);
      li.style.opacity = progress >= e.t ? "1" : "0";
      li.style.transition = "opacity .4s";
    });
  }

  function run(animate) {
    cancelAnimationFrame(scope.raf);
    if (!animate) {
      draw(1);
      return;
    }
    const start = performance.now();
    const duration = 3000;
    scope.running = true;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      draw(p);
      if (p < 1) scope.raf = requestAnimationFrame(tick);
      else scope.running = false;
    };
    scope.raf = requestAnimationFrame(tick);
  }

  function mountScope(root, data, animate, esc) {
    scope.root = root;
    scope.data = data;
    scope.esc = esc;
    run(animate);
  }

  function redraw() {
    if (scope.root && !scope.running) draw(1);
    wall.redraw();
  }

  // ---------------------------------------------------------------- dot wall

  const wall = {
    rows: [],
    redraw() {
      wall.rows.forEach((row) => paint(row, 1));
    },
  };

  function paint(row, progress) {
    const canvas = row.canvas;
    const pitch = canvas.parentElement.clientWidth < 600 ? 8 : 11;
    const width = Math.max(120, canvas.clientWidth);
    const cols = Math.max(10, Math.floor(width / pitch));
    const total = row.right + row.wrong + row.person;
    const rows = Math.max(1, Math.ceil(total / cols));
    const heightWanted = rows * pitch;
    if (canvas.style.height !== `${heightWanted}px`) canvas.style.height = `${heightWanted}px`;
    const { ctx } = size(canvas);
    const c = colours();
    ctx.clearRect(0, 0, width, heightWanted);
    for (let k = 0; k < total; k++) {
      const delay = (k / Math.max(1, total)) * 0.7;
      const t = Math.max(0, Math.min(1, (progress - delay) / 0.3));
      if (t <= 0) continue;
      const kind = k < row.right ? c.accent : k < row.right + row.wrong ? c.alert : c.track;
      const x = (k % cols) * pitch + pitch / 2;
      const y = Math.floor(k / cols) * pitch + pitch / 2;
      ctx.fillStyle = kind;
      ctx.globalAlpha = k >= row.right + row.wrong ? t * 0.9 : t;
      ctx.beginPath();
      ctx.arc(x, y, (pitch * 0.34) * (0.4 + 0.6 * t), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function mountWall(root, animate) {
    wall.rows = Array.from(root.querySelectorAll(".wall-canvas")).map((canvas) => ({
      canvas,
      right: Number(canvas.dataset.right) || 0,
      wrong: Number(canvas.dataset.wrong) || 0,
      person: Number(canvas.dataset.person) || 0,
    }));
    if (!animate || !("IntersectionObserver" in window)) {
      wall.redraw();
      return;
    }
    wall.rows.forEach((row) => paint(row, 0));
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        const row = wall.rows.find((r) => r.canvas === entry.target.querySelector(".wall-canvas"));
        if (!row) return;
        const start = performance.now();
        const tick = (now) => {
          const p = Math.min(1, (now - start) / 1400);
          paint(row, p);
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    Array.from(root.querySelectorAll(".wall-row")).forEach((r) => observer.observe(r));
  }

  return { mountScope, mountWall, redraw };
})();

if (typeof window !== "undefined") window.Scope = Scope;
