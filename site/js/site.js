"use strict";

// Page bootstrap. Every figure comes from the JSON files listed in the generated manifest.
// Rendering lives in pages.js, charts in charts.js and scope.js; this file mounts the page,
// wires the controls and runs the scroll-triggered count-ups and draw-ins.

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
    scale: "linear",
    model: null,
    modelPromise: null,
  };

  const $ = (root, query) => root.querySelector(query);
  const $$ = (root, query) => Array.from(root.querySelectorAll(query));

  // ------------------------------------------------------------ theme, menu, glossary

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
      if (choice === "system") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", choice);
      button.textContent = choice === "system" ? "System" : choice === "light" ? "Light" : "Dark";
      button.setAttribute("aria-label", `Colour theme: ${choice}. Click to change.`);
      if (window.Scope) window.Scope.redraw();
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

  function initMenu() {
    const button = document.getElementById("menu-btn");
    const sheet = document.getElementById("sheet");
    if (!button || !sheet) return;
    const set = (open) => {
      sheet.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      button.textContent = open ? "Close" : "Menu";
      document.body.classList.toggle("locked", open);
    };
    button.addEventListener("click", () => set(sheet.hidden));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !sheet.hidden) {
        set(false);
        button.focus();
      }
    });
    window.matchMedia("(min-width: 1180px)").addEventListener("change", (event) => {
      if (event.matches) set(false);
    });
  }

  function initGlossary() {
    const box = document.getElementById("gloss");
    if (!box) return;
    let current = null;
    const close = () => {
      box.hidden = true;
      current = null;
    };
    const open = (button) => {
      const key = button.dataset.term;
      if (!P.TERMS[key]) return;
      if (current === button) return close();
      current = button;
      box.innerHTML = `<b>${P.esc(key)}</b>${P.esc(P.TERMS[key])}`;
      box.hidden = false;
      const rect = button.getBoundingClientRect();
      const left = Math.max(16, Math.min(rect.left, window.innerWidth - box.offsetWidth - 16));
      const below = rect.bottom + 10 + box.offsetHeight < window.innerHeight;
      box.style.left = `${left}px`;
      box.style.top = `${below ? rect.bottom + 10 : Math.max(12, rect.top - 10 - box.offsetHeight)}px`;
    };
    document.addEventListener("click", (event) => {
      const button = event.target.closest(".term");
      if (button) open(button);
      else if (!event.target.closest("#gloss")) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    window.addEventListener("scroll", close, { passive: true });
  }

  // ------------------------------------------------------------ count-ups and draw-ins

  const ease = (t) => 1 - Math.pow(1 - t, 3);
  let observer = null;

  function countUp(el) {
    const value = Number(el.dataset.count);
    const kind = el.dataset.fmt;
    if (!Number.isFinite(value)) return;
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - start) / 800);
      el.textContent = P.format(kind, value * ease(p));
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = P.format(kind, value);
    };
    requestAnimationFrame(tick);
  }

  function observe(root) {
    const targets = $$(root, ".draw, .viz, .count");
    if (root.matches && root.matches(".draw, .viz, .count")) targets.push(root);
    if (reduced || !("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("in"));
      return;
    }
    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            observer.unobserve(entry.target);
            if (entry.target.classList.contains("count")) {
              if (!entry.target.dataset.done) {
                entry.target.dataset.done = "1";
                countUp(entry.target);
              }
            } else {
              entry.target.classList.add("in");
              if (entry.target.matches(".race-band")) startRace(entry.target);
            }
          });
        },
        { rootMargin: "0px 0px -8% 0px", threshold: 0 },
      );
    }
    targets.forEach((el) => {
      if (el.classList.contains("count")) el.textContent = P.format(el.dataset.fmt, 0);
      observer.observe(el);
    });
  }

  // ------------------------------------------------------------ charts

  function drawViz(root) {
    $$(root, ".viz").forEach((el) => {
      const kind = el.dataset.viz;
      if (kind === "monthly") window.Charts.monthly(el, P.monthlySeries(state.data, state.filters));
      else if (kind === "reliability") {
        const key = state.view === "new" ? "test_new_text" : "test";
        const metrics = (((state.data.router || {}).models || {}).words || {})[key] || {};
        window.Charts.reliability(el, metrics.reliability || []);
      } else if (kind === "timeline") window.Charts.timeline(el, state.data, el.dataset.group, state.scale);
      else if (kind === "novelty") window.Charts.novelty(el, state.data);
    });
  }

  function hydrate(root) {
    drawViz(root);
    observe(root);
  }

  // ------------------------------------------------------------ page controls

  function swap(id, html) {
    const box = document.getElementById(id);
    if (!box) return;
    box.innerHTML = html;
    hydrate(box);
  }

  function initVolumes() {
    const reset = document.getElementById("vol-reset");
    const selects = $$(app, "[data-filter]");
    const update = () => {
      selects.forEach((select) => {
        state.filters[select.dataset.filter] = select.value;
      });
      reset.hidden = Object.values(state.filters).every((v) => v === "all");
      swap("vol-dashboard", P.volumesDashboard(state.data, state.filters));
    };
    selects.forEach((select) => select.addEventListener("change", update));
    reset.addEventListener("click", () => {
      selects.forEach((select) => {
        select.value = "all";
      });
      update();
    });
  }

  function initRouter() {
    const buttons = $$(app, "[data-view]");
    buttons.forEach((button) =>
      button.addEventListener("click", () => {
        state.view = button.dataset.view;
        buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
        swap("router-dashboard", P.routerDashboard(state.data, state.view));
      }),
    );
  }

  function initRadar() {
    const render = () => swap("radar-dashboard", P.radarDashboard(state.data, state.group, state.scale));
    $$(app, "[data-radar-group]").forEach((button) =>
      button.addEventListener("click", () => {
        state.group = button.dataset.radarGroup;
        $$(app, "[data-radar-group]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
        render();
      }),
    );
    app.addEventListener("click", (event) => {
      const button = event.target.closest("[data-scale]");
      if (!button) return;
      state.scale = button.dataset.scale;
      render();
    });
  }

  function initQuality() {
    const input = document.getElementById("taxonomy-search");
    if (!input) return;
    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      $$(app, "#taxonomy-holder tbody tr").forEach((row) => {
        row.hidden = query !== "" && !row.textContent.toLowerCase().includes(query);
      });
    });
  }

  // The honest race: one clock for both lanes, scaled so the slower run takes about 2.5 s on screen.
  function setLane(lane, f) {
    const share = Number(lane.dataset.share);
    $(lane, ".lane-fill").style.setProperty("--p", String(share * f));
    $(lane, ".lane-time").textContent = P.duration(Number(lane.dataset.seconds) * f);
  }

  let raceTicket = 0;
  function startRace(root) {
    const race = root.matches("[data-race]") ? root : $(root, "[data-race]");
    if (!race || reduced) return;
    const lanes = $$(race, "[data-lane]");
    const ticket = ++raceTicket;
    const begin = performance.now();
    const tick = (now) => {
      if (ticket !== raceTicket) return;
      let running = false;
      lanes.forEach((lane) => {
        const share = Number(lane.dataset.share);
        const f = Math.min(1, (now - begin) / (2500 * share));
        setLane(lane, f);
        if (f < 1) running = true;
      });
      if (running) requestAnimationFrame(tick);
    };
    lanes.forEach((lane) => setLane(lane, 0));
    requestAnimationFrame(tick);
  }

  function initCost() {
    const race = $(app, "[data-race]");
    if (race) {
      $$(race, "[data-lane]").forEach((lane) => setLane(lane, 1));
      const replay = $(race, "[data-replay]");
      if (replay) replay.addEventListener("click", () => startRace(race));
      if (reduced && replay) replay.hidden = true;
    }
    const input = document.getElementById("price-input");
    if (!input) return;
    input.addEventListener("input", () => {
      const result = document.getElementById("cost-result");
      if (result) result.textContent = P.costResult(state.data, input.value);
    });
  }

  function loadModel() {
    if (state.modelPromise) return state.modelPromise;
    const status = document.getElementById("try-status");
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
    const field = document.getElementById("try-text");
    const box = document.getElementById("try-result");
    if (!field || !box) return;
    const run = async () => {
      const model = await loadModel();
      if (!model) return;
      const text = field.value.trim();
      if (!text) {
        box.innerHTML = P.tryEmpty();
        return;
      }
      box.innerHTML = P.tryResult(window.classify(text, model), model);
    };
    field.addEventListener("input", run);
    field.addEventListener("focus", loadModel);
    $$(app, "[data-example]").forEach((button) =>
      button.addEventListener("click", () => {
        field.value = P.EXAMPLES[Number(button.dataset.example)][1];
        run();
      }),
    );
  }

  function initIndex() {
    const root = $(app, "[data-scope]");
    if (root && window.Scope) {
      const start = () => window.Scope.mountScope(root, state.data, !reduced, P.esc);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(start);
      else start();
      window.Scope.mountWall(app, !reduced);
    }
  }

  const specific = {
    index: initIndex, volumes: initVolumes, router: initRouter, radar: initRadar,
    quality: initQuality, cost: initCost, try: initTry,
  };

  function mount() {
    const totals = (state.data.descriptive || {}).totals || {};
    const range = document.getElementById("footer-range");
    if (range && P.ok(totals.first_date) && P.ok(totals.last_date)) {
      range.textContent = `${totals.first_date} to ${totals.last_date}`;
    }
    state.group = P.radarGroupDefault(state.data);
    const renderers = {
      index: () => P.renderIndex(state.data),
      volumes: () => P.renderVolumes(state.data, state.filters),
      router: () => P.renderRouter(state.data, state.view),
      cost: () => P.renderCost(state.data),
      radar: () => P.renderRadar(state.data, state.group, state.scale),
      quality: () => P.renderQuality(state.data),
      try: () => P.renderTry(state.data),
    };
    app.innerHTML = (renderers[page] || renderers.index)();
    if (specific[page]) specific[page]();
    hydrate(app);
  }

  async function boot() {
    initTheme();
    initMenu();
    initGlossary();
    try {
      const manifest = await (await fetch("data/manifest.json")).json();
      const pairs = await Promise.all(
        (manifest.files || []).map(async (name) => {
          try {
            const response = await fetch(`data/${name}`);
            return [name.replace(".json", ""), response.ok ? await response.json() : null];
          } catch (error) {
            return [name.replace(".json", ""), null];
          }
        }),
      );
      pairs.forEach(([key, value]) => {
        if (value !== null) state.data[key === "llm_eval" ? "llmEval" : key] = value;
      });
      mount();
    } catch (error) {
      console.warn("boot failed", error);
      app.innerHTML = '<section class="band"><div class="wrap"><h1 class="section-title">The data could not be loaded</h1><p class="lede">Open this site from the repository so the local data files are available.</p></div></section>';
    }
  }

  let resizeTicket = 0;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    cancelAnimationFrame(resizeTicket);
    resizeTicket = requestAnimationFrame(() => {
      $$(app, ".viz").forEach((el) => el.classList.add("in"));
      drawViz(app);
      if (window.Scope) window.Scope.redraw();
    });
  });

  boot();
})();
