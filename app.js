(function () {
  "use strict";

  const STORAGE_KEY = "pm-construction-v1";
  const SETTINGS_STORAGE_KEY = "pm-construction-settings-v1";
  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(id) { return document.getElementById(id); }

  function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }

  function sum(arr, key) {
    return round2(arr.reduce((acc, x) => acc + (Number(x[key]) || 0), 0));
  }

  function formatMoney(v) {
    const n = Number(v) || 0;
    const opts = Number.isInteger(n)
      ? { maximumFractionDigits: 0 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return new Intl.NumberFormat("ru-RU", opts).format(n);
  }

  function compactMoney(v) {
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (abs >= 1e6) return sign + trimZero(abs / 1e6) + " млн";
    if (abs >= 1e3) return sign + trimZero(abs / 1e3) + " тыс.";
    return sign + String(Math.round(abs));
  }

  function trimZero(v) {
    return v.toFixed(1).replace(/\.0$/, "");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function formatDateShort(ms) {
    const d = new Date(ms);
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yy = String(d.getUTCFullYear()).slice(2);
    return `${dd}.${mm}.${yy}`;
  }

  function isoToMs(iso) {
    return Date.parse(iso + "T00:00:00Z");
  }

  // --- State ---

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { projects: [], activeProjectId: null, activeView: "overview", activeSectionId: null };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.projects)) throw new Error("bad shape");
      return parsed;
    } catch (e) {
      console.error("Не удалось прочитать сохранённые данные", e);
      return { projects: [], activeProjectId: null, activeView: "overview", activeSectionId: null };
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  let state = loadState();
  if (!state.activeProjectId && state.projects.length) {
    state.activeProjectId = state.projects[0].id;
  }

  function getActiveProject() {
    return state.projects.find((p) => p.id === state.activeProjectId) || null;
  }

  function getActiveSection(project) {
    if (!project) return null;
    return project.sections.find((s) => s.id === state.activeSectionId) || null;
  }

  // --- Computations ---

  function computeSectionStats(section) {
    const spent = round2(sum(section.contracts, "sum") + sum(section.materials, "sum"));
    const earned = sum(section.progress, "amount");
    const budget = Number(section.budget) || 0;
    return {
      budget,
      spent,
      earned,
      margin: round2(earned - spent),
      percent: budget > 0 ? (earned / budget) * 100 : 0,
    };
  }

  function computeProjectStats(project) {
    return project.sections.reduce(
      (acc, s) => {
        const st = computeSectionStats(s);
        acc.budget += st.budget;
        acc.spent += st.spent;
        acc.earned += st.earned;
        return acc;
      },
      { budget: 0, spent: 0, earned: 0 }
    );
  }

  function buildTimeline(project) {
    const events = [];
    project.sections.forEach((s) => {
      s.contracts.forEach((c) => events.push({ date: c.date, amount: Number(c.sum) || 0, kind: "spent" }));
      s.materials.forEach((m) => events.push({ date: m.date, amount: Number(m.sum) || 0, kind: "spent" }));
      s.progress.forEach((p) => events.push({ date: p.date, amount: Number(p.amount) || 0, kind: "earned" }));
    });
    if (!events.length) return [];
    const dates = [...new Set(events.map((e) => e.date))].sort();
    let cumEarned = 0;
    let cumSpent = 0;
    return dates.map((d) => {
      events.filter((e) => e.date === d).forEach((e) => {
        if (e.kind === "earned") cumEarned += e.amount;
        else cumSpent += e.amount;
      });
      return { date: isoToMs(d), earned: round2(cumEarned), spent: round2(cumSpent) };
    });
  }

  // --- DOM refs ---

  const projectListEl = el("projectList");
  const projectTitleEl = el("projectTitle");
  const projectCustomerEl = el("projectCustomer");
  const editProjectBtn = el("editProjectBtn");
  const deleteProjectBtn = el("deleteProjectBtn");
  const sectionTabsEl = el("sectionTabs");
  const overviewViewEl = el("overviewView");
  const sectionViewEl = el("sectionView");
  const emptyStateEl = el("emptyState");
  const noSectionStateEl = el("noSectionState");

  const overviewStatsEl = el("overviewStats");
  const chartContainerEl = el("chartContainer");
  const chartEmptyEl = el("chartEmpty");
  const sectionsTableBodyEl = el("sectionsTableBody");

  const sectionNameEl = el("sectionName");
  const sectionStatsEl = el("sectionStats");
  const sectionProgressFillEl = el("sectionProgressFill");
  const contractsBodyEl = el("contractsBody");
  const contractsTotalEl = el("contractsTotal");
  const materialsBodyEl = el("materialsBody");
  const materialsTotalEl = el("materialsTotal");
  const progressBodyEl = el("progressBody");
  const progressTotalEl = el("progressTotal");

  // --- Generic dialog cancel wiring ---
  document.addEventListener("click", (e) => {
    if (e.target.matches(".dialog-cancel")) {
      const dialog = e.target.closest("dialog");
      if (dialog) dialog.close();
    }
  });

  // --- Render ---

  function render() {
    renderProjectList();
    const project = getActiveProject();

    if (!project) {
      projectTitleEl.textContent = "Выберите проект";
      projectCustomerEl.textContent = "";
      editProjectBtn.disabled = true;
      deleteProjectBtn.disabled = true;
      sectionTabsEl.hidden = true;
      overviewViewEl.hidden = true;
      sectionViewEl.hidden = true;
      noSectionStateEl.hidden = true;
      emptyStateEl.hidden = state.projects.length > 0;
      return;
    }

    emptyStateEl.hidden = true;
    projectTitleEl.textContent = project.name;
    projectCustomerEl.textContent = project.customer ? `Заказчик: ${project.customer}` : "";
    editProjectBtn.disabled = false;
    deleteProjectBtn.disabled = false;

    renderSectionTabs(project);

    if (!project.sections.length) {
      overviewViewEl.hidden = true;
      sectionViewEl.hidden = true;
      noSectionStateEl.hidden = false;
      return;
    }
    noSectionStateEl.hidden = true;

    const activeSection = getActiveSection(project);
    if (state.activeView === "section" && activeSection) {
      overviewViewEl.hidden = true;
      sectionViewEl.hidden = false;
      renderSectionView(project, activeSection);
    } else {
      state.activeView = "overview";
      overviewViewEl.hidden = false;
      sectionViewEl.hidden = true;
      renderOverview(project);
    }
  }

  function renderProjectList() {
    projectListEl.innerHTML = "";
    state.projects.forEach((project) => {
      const stats = computeProjectStats(project);
      const li = document.createElement("li");
      if (project.id === state.activeProjectId) li.classList.add("active");

      const name = document.createElement("div");
      name.textContent = project.name;
      li.appendChild(name);

      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = `${formatMoney(stats.earned)} из ${formatMoney(stats.budget)}`;
      li.appendChild(sub);

      li.addEventListener("click", () => {
        state.activeProjectId = project.id;
        state.activeView = "overview";
        state.activeSectionId = null;
        saveState();
        render();
      });
      projectListEl.appendChild(li);
    });
  }

  function renderSectionTabs(project) {
    sectionTabsEl.hidden = false;
    sectionTabsEl.innerHTML = "";

    const overviewBtn = document.createElement("button");
    overviewBtn.textContent = "Обзор";
    if (state.activeView === "overview") overviewBtn.classList.add("active");
    overviewBtn.addEventListener("click", () => {
      state.activeView = "overview";
      saveState();
      render();
    });
    sectionTabsEl.appendChild(overviewBtn);

    project.sections.forEach((section) => {
      const btn = document.createElement("button");
      btn.textContent = section.name;
      if (state.activeView === "section" && state.activeSectionId === section.id) {
        btn.classList.add("active");
      }
      btn.addEventListener("click", () => {
        state.activeView = "section";
        state.activeSectionId = section.id;
        saveState();
        render();
      });
      sectionTabsEl.appendChild(btn);
    });

    const addBtn = document.createElement("button");
    addBtn.textContent = "+ Раздел";
    addBtn.className = "add-tab";
    addBtn.addEventListener("click", () => openSectionDialog(null));
    sectionTabsEl.appendChild(addBtn);
  }

  function statTile(label, value, tone) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "value" + (tone ? ` ${tone}` : "");
    v.textContent = value;
    tile.appendChild(l);
    tile.appendChild(v);
    return tile;
  }

  function renderOverview(project) {
    const stats = computeProjectStats(project);
    const margin = round2(stats.earned - stats.spent);

    overviewStatsEl.innerHTML = "";
    overviewStatsEl.appendChild(statTile("Бюджет по договору", formatMoney(stats.budget)));
    overviewStatsEl.appendChild(statTile("Заработано (освоено)", formatMoney(stats.earned)));
    overviewStatsEl.appendChild(statTile("Потрачено", formatMoney(stats.spent)));
    overviewStatsEl.appendChild(statTile("Маржа", formatMoney(margin), margin >= 0 ? "good" : "bad"));

    const points = buildTimeline(project);
    renderChart(points, stats.budget);

    sectionsTableBodyEl.innerHTML = "";
    if (!project.sections.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.className = "table-empty";
      td.textContent = "Нет разделов работ";
      tr.appendChild(td);
      sectionsTableBodyEl.appendChild(tr);
    } else {
      project.sections.forEach((section) => {
        const st = computeSectionStats(section);
        const tr = document.createElement("tr");
        tr.innerHTML = "";
        appendCell(tr, section.name);
        appendCell(tr, formatMoney(st.budget));
        appendCell(tr, formatMoney(st.spent));
        appendCell(tr, formatMoney(st.earned));
        appendCell(tr, formatMoney(st.margin), st.margin >= 0 ? "good" : "bad");
        appendCell(tr, `${Math.round(st.percent)}%`);
        tr.style.cursor = "pointer";
        tr.addEventListener("click", () => {
          state.activeView = "section";
          state.activeSectionId = section.id;
          saveState();
          render();
        });
        sectionsTableBodyEl.appendChild(tr);
      });
    }
  }

  function appendCell(tr, text, tone) {
    const td = document.createElement("td");
    td.textContent = text;
    if (tone) td.classList.add(tone);
    tr.appendChild(td);
  }

  function renderSectionView(project, section) {
    sectionNameEl.textContent = section.name;
    const st = computeSectionStats(section);

    sectionStatsEl.innerHTML = "";
    sectionStatsEl.appendChild(statTile("Бюджет (доход)", formatMoney(st.budget)));
    sectionStatsEl.appendChild(statTile("Затраты", formatMoney(st.spent)));
    sectionStatsEl.appendChild(statTile("Освоено", formatMoney(st.earned)));
    sectionStatsEl.appendChild(statTile("Маржа", formatMoney(st.margin), st.margin >= 0 ? "good" : "bad"));
    sectionProgressFillEl.style.width = `${Math.min(100, Math.max(0, st.percent))}%`;

    renderContracts(section);
    renderMaterials(section);
    renderProgress(section);
  }

  function renderEmptyRow(tbody, colspan, text) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = colspan;
    td.className = "table-empty";
    td.textContent = text;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function renderContracts(section) {
    contractsBodyEl.innerHTML = "";
    if (!section.contracts.length) {
      renderEmptyRow(contractsBodyEl, 5, "Договоров пока нет");
    } else {
      section.contracts
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .forEach((c) => {
          const tr = document.createElement("tr");
          appendCell(tr, c.name);
          appendCell(tr, formatMoney(c.sum));
          appendCell(tr, formatDate(c.date));
          appendCell(tr, c.note || "");
          tr.appendChild(rowActions(
            () => openContractDialog(c),
            () => deleteContract(section, c.id)
          ));
          contractsBodyEl.appendChild(tr);
        });
    }
    contractsTotalEl.textContent = formatMoney(sum(section.contracts, "sum"));
  }

  function renderMaterials(section) {
    materialsBodyEl.innerHTML = "";
    if (!section.materials.length) {
      renderEmptyRow(materialsBodyEl, 5, "Материалы пока не закупались");
    } else {
      section.materials
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .forEach((m) => {
          const tr = document.createElement("tr");
          appendCell(tr, m.name);
          appendCell(tr, m.qty || "—");
          appendCell(tr, formatMoney(m.sum));
          appendCell(tr, formatDate(m.date));
          tr.appendChild(rowActions(
            () => openMaterialDialog(m),
            () => deleteMaterial(section, m.id)
          ));
          materialsBodyEl.appendChild(tr);
        });
    }
    materialsTotalEl.textContent = formatMoney(sum(section.materials, "sum"));
  }

  function renderProgress(section) {
    progressBodyEl.innerHTML = "";
    if (!section.progress.length) {
      renderEmptyRow(progressBodyEl, 5, "Выполнение работ ещё не отмечалось");
    } else {
      let running = 0;
      section.progress
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .forEach((p) => {
          running = round2(running + (Number(p.amount) || 0));
          const tr = document.createElement("tr");
          appendCell(tr, formatDate(p.date));
          appendCell(tr, formatMoney(p.amount));
          appendCell(tr, formatMoney(running));
          appendCell(tr, p.note || "");
          tr.appendChild(rowActions(
            () => openProgressDialog(p),
            () => deleteProgress(section, p.id)
          ));
          progressBodyEl.appendChild(tr);
        });
    }
    progressTotalEl.textContent = formatMoney(sum(section.progress, "amount"));
  }

  function rowActions(onEdit, onDelete) {
    const td = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "row-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Изменить";
    editBtn.addEventListener("click", onEdit);
    wrap.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Удалить";
    delBtn.addEventListener("click", onDelete);
    wrap.appendChild(delBtn);

    td.appendChild(wrap);
    return td;
  }

  // --- Chart ---

  function niceTicks(maxVal, targetCount) {
    if (maxVal <= 0) return [0, 1];
    const rawStep = maxVal / targetCount;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const residual = rawStep / magnitude;
    let step;
    if (residual > 5) step = 10 * magnitude;
    else if (residual > 2) step = 5 * magnitude;
    else if (residual > 1) step = 2 * magnitude;
    else step = magnitude;

    const ticks = [];
    const top = Math.ceil(maxVal / step) * step;
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(round2(v));
    return ticks;
  }

  function renderChart(points, budget) {
    chartContainerEl.innerHTML = "";
    if (!points.length) {
      chartEmptyEl.hidden = false;
      return;
    }
    chartEmptyEl.hidden = true;

    const width = 760;
    const height = 280;
    const pad = { left: 64, right: 24, top: 16, bottom: 32 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const dates = points.map((p) => p.date);
    const minDate = Math.min(...dates);
    const maxDate = Math.max(...dates);
    const maxVal = Math.max(budget || 0, ...points.map((p) => p.earned), ...points.map((p) => p.spent), 1);
    const ticks = niceTicks(maxVal, 4);
    const topTick = ticks[ticks.length - 1] || 1;

    function x(d) {
      return pad.left + (maxDate === minDate ? innerW / 2 : ((d - minDate) / (maxDate - minDate)) * innerW);
    }
    function y(v) {
      return pad.top + innerH - (v / topTick) * innerH;
    }

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "График динамики освоения проекта: заработано и потрачено во времени");

    ticks.forEach((t) => {
      const gy = y(t);
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", pad.left);
      line.setAttribute("x2", width - pad.right);
      line.setAttribute("y1", gy);
      line.setAttribute("y2", gy);
      line.style.stroke = "var(--grid)";
      line.setAttribute("stroke-width", "1");
      svg.appendChild(line);

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", pad.left - 8);
      label.setAttribute("y", gy + 4);
      label.setAttribute("text-anchor", "end");
      label.setAttribute("font-size", "10");
      label.style.fill = "var(--text-muted)";
      label.textContent = compactMoney(t);
      svg.appendChild(label);
    });

    const axis = document.createElementNS(SVG_NS, "line");
    axis.setAttribute("x1", pad.left);
    axis.setAttribute("x2", width - pad.right);
    axis.setAttribute("y1", pad.top + innerH);
    axis.setAttribute("y2", pad.top + innerH);
    axis.style.stroke = "var(--baseline)";
    axis.setAttribute("stroke-width", "1");
    svg.appendChild(axis);

    if (budget > 0 && budget <= topTick * 1.5) {
      const by = y(budget);
      const bline = document.createElementNS(SVG_NS, "line");
      bline.setAttribute("x1", pad.left);
      bline.setAttribute("x2", width - pad.right);
      bline.setAttribute("y1", by);
      bline.setAttribute("y2", by);
      bline.style.stroke = "var(--text-muted)";
      bline.setAttribute("stroke-width", "1");
      bline.setAttribute("stroke-dasharray", "4 4");
      svg.appendChild(bline);

      const blabel = document.createElementNS(SVG_NS, "text");
      blabel.setAttribute("x", width - pad.right);
      blabel.setAttribute("y", Math.max(pad.top + 8, by - 4));
      blabel.setAttribute("text-anchor", "end");
      blabel.setAttribute("font-size", "10");
      blabel.style.fill = "var(--text-muted)";
      blabel.textContent = `Бюджет: ${compactMoney(budget)}`;
      svg.appendChild(blabel);
    }

    const labelIdxs = points.length === 1 ? [0] : [0, Math.floor((points.length - 1) / 2), points.length - 1];
    [...new Set(labelIdxs)].forEach((i) => {
      const p = points[i];
      const lx = x(p.date);
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", lx);
      t.setAttribute("y", height - 8);
      t.setAttribute("text-anchor", i === 0 ? "start" : i === points.length - 1 ? "end" : "middle");
      t.setAttribute("font-size", "10");
      t.style.fill = "var(--text-muted)";
      t.textContent = formatDateShort(p.date);
      svg.appendChild(t);
    });

    function drawSeries(key, colorVar) {
      const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.date).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(" ");
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.style.stroke = `var(${colorVar})`;
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("stroke-linecap", "round");
      svg.appendChild(path);

      const last = points[points.length - 1];
      const cx = x(last.date);
      const cy = y(last[key]);
      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("cx", cx);
      ring.setAttribute("cy", cy);
      ring.setAttribute("r", "6");
      ring.style.fill = "var(--panel)";
      svg.appendChild(ring);
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      dot.setAttribute("r", "4");
      dot.style.fill = `var(${colorVar})`;
      svg.appendChild(dot);

      return { cx, cy, value: last[key] };
    }

    const earnedEnd = drawSeries("earned", "--series-earned");
    const spentEnd = drawSeries("spent", "--series-spent");

    let earnedLabelY = earnedEnd.cy;
    let spentLabelY = spentEnd.cy;
    if (Math.abs(earnedEnd.cy - spentEnd.cy) < 16) {
      if (earnedEnd.cy <= spentEnd.cy) {
        earnedLabelY -= 8;
        spentLabelY += 8;
      } else {
        earnedLabelY += 8;
        spentLabelY -= 8;
      }
    }

    function addEndLabel(cx, labelY, value, colorVar) {
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", Math.min(cx + 8, width - pad.right + 20));
      text.setAttribute("y", labelY + 4);
      text.setAttribute("font-size", "11");
      text.setAttribute("font-weight", "600");
      text.style.fill = "var(--text)";
      text.textContent = compactMoney(value);
      svg.appendChild(text);
    }
    addEndLabel(earnedEnd.cx, earnedLabelY, earnedEnd.value, "--series-earned");
    addEndLabel(spentEnd.cx, spentLabelY, spentEnd.value, "--series-spent");

    const crosshair = document.createElementNS(SVG_NS, "line");
    crosshair.setAttribute("y1", pad.top);
    crosshair.setAttribute("y2", pad.top + innerH);
    crosshair.style.stroke = "var(--baseline)";
    crosshair.setAttribute("stroke-width", "1");
    crosshair.style.display = "none";
    svg.appendChild(crosshair);

    const overlay = document.createElementNS(SVG_NS, "rect");
    overlay.setAttribute("x", pad.left);
    overlay.setAttribute("y", pad.top);
    overlay.setAttribute("width", innerW);
    overlay.setAttribute("height", innerH);
    overlay.setAttribute("fill", "transparent");
    svg.appendChild(overlay);

    chartContainerEl.appendChild(svg);

    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    chartContainerEl.appendChild(tooltip);

    overlay.addEventListener("pointermove", (e) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const scaleX = width / rect.width;
      const scaleY = height / rect.height;
      const px = (e.clientX - rect.left) * scaleX;

      let nearest = 0;
      let bestDist = Infinity;
      points.forEach((p, i) => {
        const d = Math.abs(x(p.date) - px);
        if (d < bestDist) {
          bestDist = d;
          nearest = i;
        }
      });
      const p = points[nearest];
      const svgX = x(p.date);
      crosshair.setAttribute("x1", svgX);
      crosshair.setAttribute("x2", svgX);
      crosshair.style.display = "block";

      tooltip.innerHTML = "";
      const dateEl = document.createElement("div");
      dateEl.className = "tt-date";
      dateEl.textContent = formatDateShort(p.date);
      tooltip.appendChild(dateEl);

      [
        ["Заработано", p.earned, "--series-earned"],
        ["Потрачено", p.spent, "--series-spent"],
      ].forEach(([label, value, colorVar]) => {
        const row = document.createElement("div");
        row.className = "tt-row";
        const key = document.createElement("span");
        key.className = "tt-key";
        key.style.background = `var(${colorVar})`;
        row.appendChild(key);
        const strong = document.createElement("strong");
        strong.textContent = formatMoney(value);
        row.appendChild(strong);
        const span = document.createElement("span");
        span.textContent = ` ${label}`;
        row.appendChild(span);
        tooltip.appendChild(row);
      });

      tooltip.classList.add("visible");
      tooltip.style.left = `${svgX / scaleX}px`;
      tooltip.style.top = `${Math.min(y(p.earned), y(p.spent)) / scaleY}px`;
    });
    overlay.addEventListener("pointerleave", () => {
      crosshair.style.display = "none";
      tooltip.classList.remove("visible");
    });
  }

  // --- Project CRUD ---

  const projectDialog = el("projectDialog");
  const projectForm = el("projectForm");
  const projectDialogTitle = el("projectDialogTitle");
  const projectNameInput = el("projectName");
  const projectCustomerInput = el("projectCustomerInput");
  let editingProjectId = null;

  el("addProjectBtn").addEventListener("click", () => {
    editingProjectId = null;
    projectDialogTitle.textContent = "Новый проект";
    projectNameInput.value = "";
    projectCustomerInput.value = "";
    projectDialog.showModal();
    projectNameInput.focus();
  });

  editProjectBtn.addEventListener("click", () => {
    const project = getActiveProject();
    if (!project) return;
    editingProjectId = project.id;
    projectDialogTitle.textContent = "Изменить проект";
    projectNameInput.value = project.name;
    projectCustomerInput.value = project.customer || "";
    projectDialog.showModal();
    projectNameInput.focus();
  });

  projectForm.addEventListener("submit", () => {
    const name = projectNameInput.value.trim();
    if (!name) return;
    const customer = projectCustomerInput.value.trim();

    if (editingProjectId) {
      const project = state.projects.find((p) => p.id === editingProjectId);
      if (project) {
        project.name = name;
        project.customer = customer;
      }
    } else {
      const project = { id: uid(), name, customer, sections: [] };
      state.projects.push(project);
      state.activeProjectId = project.id;
      state.activeView = "overview";
      state.activeSectionId = null;
    }
    saveState();
    render();
  });

  deleteProjectBtn.addEventListener("click", () => {
    const project = getActiveProject();
    if (!project) return;
    if (!confirm(`Удалить проект «${project.name}» вместе со всеми разделами, договорами и материалами?`)) return;
    state.projects = state.projects.filter((p) => p.id !== project.id);
    state.activeProjectId = state.projects.length ? state.projects[0].id : null;
    state.activeView = "overview";
    state.activeSectionId = null;
    saveState();
    render();
  });

  // --- Section CRUD ---

  const sectionDialog = el("sectionDialog");
  const sectionForm = el("sectionForm");
  const sectionDialogTitle = el("sectionDialogTitle");
  const sectionNameInput = el("sectionNameInput");
  const sectionBudgetInput = el("sectionBudget");
  let editingSectionId = null;

  function openSectionDialog(section) {
    const project = getActiveProject();
    if (!project) return;
    editingSectionId = section ? section.id : null;
    sectionDialogTitle.textContent = section ? "Изменить вид работ" : "Новый вид работ";
    sectionNameInput.value = section ? section.name : "";
    sectionBudgetInput.value = section ? section.budget : "";
    sectionDialog.showModal();
    sectionNameInput.focus();
  }

  el("editSectionBtn").addEventListener("click", () => {
    const project = getActiveProject();
    const section = getActiveSection(project);
    if (section) openSectionDialog(section);
  });

  sectionForm.addEventListener("submit", () => {
    const project = getActiveProject();
    if (!project) return;
    const name = sectionNameInput.value.trim();
    const budget = Number(sectionBudgetInput.value);
    if (!name || Number.isNaN(budget) || budget < 0) return;

    if (editingSectionId) {
      const section = project.sections.find((s) => s.id === editingSectionId);
      if (section) {
        section.name = name;
        section.budget = budget;
      }
    } else {
      const section = { id: uid(), name, budget, contracts: [], materials: [], progress: [] };
      project.sections.push(section);
      state.activeView = "section";
      state.activeSectionId = section.id;
    }
    saveState();
    render();
  });

  el("deleteSectionBtn").addEventListener("click", () => {
    const project = getActiveProject();
    const section = getActiveSection(project);
    if (!project || !section) return;
    if (!confirm(`Удалить раздел «${section.name}» вместе со всеми договорами, материалами и записями о выполнении?`)) return;
    project.sections = project.sections.filter((s) => s.id !== section.id);
    state.activeView = "overview";
    state.activeSectionId = null;
    saveState();
    render();
  });

  // --- Contract CRUD ---

  const contractDialog = el("contractDialog");
  const contractForm = el("contractForm");
  const contractDialogTitle = el("contractDialogTitle");
  const contractIdInput = el("contractId");
  const contractNameInput = el("contractName");
  const contractSumInput = el("contractSum");
  const contractDateInput = el("contractDate");
  const contractNoteInput = el("contractNote");

  function openContractDialog(contract, prefill) {
    const data = contract || prefill || null;
    contractDialogTitle.textContent = contract
      ? "Изменить договор"
      : prefill
      ? "Новый договор (распознано из файла — проверьте перед сохранением)"
      : "Новый договор";
    contractIdInput.value = contract ? contract.id : "";
    contractNameInput.value = data ? data.name || "" : "";
    contractSumInput.value = data && data.sum != null ? data.sum : "";
    contractDateInput.value = data ? data.date || "" : "";
    contractNoteInput.value = data ? data.note || "" : "";
    contractDialog.showModal();
    contractNameInput.focus();
  }

  el("addContractBtn").addEventListener("click", () => openContractDialog(null));

  contractForm.addEventListener("submit", () => {
    const project = getActiveProject();
    const section = getActiveSection(project);
    if (!section) return;
    const name = contractNameInput.value.trim();
    const sumVal = Number(contractSumInput.value);
    const date = contractDateInput.value;
    if (!name || Number.isNaN(sumVal) || sumVal < 0 || !date) return;
    const note = contractNoteInput.value.trim();

    if (contractIdInput.value) {
      const c = section.contracts.find((x) => x.id === contractIdInput.value);
      if (c) Object.assign(c, { name, sum: sumVal, date, note });
    } else {
      section.contracts.push({ id: uid(), name, sum: sumVal, date, note });
    }
    saveState();
    render();
  });

  function deleteContract(section, id) {
    if (!confirm("Удалить этот договор?")) return;
    section.contracts = section.contracts.filter((c) => c.id !== id);
    saveState();
    render();
  }

  // --- Material CRUD ---

  const materialDialog = el("materialDialog");
  const materialForm = el("materialForm");
  const materialDialogTitle = el("materialDialogTitle");
  const materialIdInput = el("materialId");
  const materialNameInput = el("materialName");
  const materialQtyInput = el("materialQty");
  const materialSumInput = el("materialSum");
  const materialDateInput = el("materialDate");

  function openMaterialDialog(material, prefill) {
    const data = material || prefill || null;
    materialDialogTitle.textContent = material
      ? "Изменить материал"
      : prefill
      ? "Новый материал (распознано по фото — проверьте перед сохранением)"
      : "Новый материал";
    materialIdInput.value = material ? material.id : "";
    materialNameInput.value = data ? data.name || "" : "";
    materialQtyInput.value = data ? data.qty || "" : "";
    materialSumInput.value = data && data.sum != null ? data.sum : "";
    materialDateInput.value = data ? data.date || "" : "";
    materialDialog.showModal();
    materialNameInput.focus();
  }

  el("addMaterialBtn").addEventListener("click", () => openMaterialDialog(null));

  materialForm.addEventListener("submit", () => {
    const project = getActiveProject();
    const section = getActiveSection(project);
    if (!section) return;
    const name = materialNameInput.value.trim();
    const sumVal = Number(materialSumInput.value);
    const date = materialDateInput.value;
    if (!name || Number.isNaN(sumVal) || sumVal < 0 || !date) return;
    const qty = materialQtyInput.value.trim();

    if (materialIdInput.value) {
      const m = section.materials.find((x) => x.id === materialIdInput.value);
      if (m) Object.assign(m, { name, qty, sum: sumVal, date });
    } else {
      section.materials.push({ id: uid(), name, qty, sum: sumVal, date });
    }
    saveState();
    render();
  });

  function deleteMaterial(section, id) {
    if (!confirm("Удалить эту закупку материалов?")) return;
    section.materials = section.materials.filter((m) => m.id !== id);
    saveState();
    render();
  }

  // --- Settings (Anthropic API key for photo recognition) ---

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }

  const settingsDialog = el("settingsDialog");
  const settingsForm = el("settingsForm");
  const anthropicApiKeyInput = el("anthropicApiKeyInput");

  function openSettingsDialog() {
    anthropicApiKeyInput.value = loadSettings().anthropicApiKey || "";
    settingsDialog.showModal();
    anthropicApiKeyInput.focus();
  }

  el("settingsBtn").addEventListener("click", openSettingsDialog);

  settingsForm.addEventListener("submit", () => {
    const settings = loadSettings();
    settings.anthropicApiKey = anthropicApiKeyInput.value.trim();
    saveSettings(settings);
  });

  // --- File extraction pipeline (Claude Vision/Documents + client-side xlsx/docx parsing) ---

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        const base64 = result.slice(result.indexOf(",") + 1);
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function fileToArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  const MAX_EXTRACT_TEXT_CHARS = 20000;

  async function extractFileContent(file) {
    const name = (file.name || "").toLowerCase();
    const type = file.type || "";

    if (type === "application/pdf" || name.endsWith(".pdf")) {
      const base64 = await fileToBase64(file);
      return { kind: "pdf", base64 };
    }

    if (type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(name)) {
      const base64 = await fileToBase64(file);
      return { kind: "image", base64, mediaType: type || "image/jpeg" };
    }

    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      if (!window.XLSX) throw new Error("Не удалось загрузить библиотеку для чтения Excel-файлов (нужен интернет).");
      const buffer = await fileToArrayBuffer(file);
      const workbook = XLSX.read(buffer, { type: "array" });
      const csvParts = workbook.SheetNames.map(
        (sheetName) => `# Лист: ${sheetName}\n${XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])}`
      );
      return { kind: "text", text: csvParts.join("\n\n") };
    }

    if (name.endsWith(".docx")) {
      if (!window.mammoth) throw new Error("Не удалось загрузить библиотеку для чтения Word-файлов (нужен интернет).");
      const buffer = await fileToArrayBuffer(file);
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      return { kind: "text", text: result.value };
    }

    throw new Error("Неподдерживаемый формат файла. Поддерживаются: PDF, изображения, Excel (.xlsx/.xls), Word (.docx).");
  }

  function buildContentBlocks(extracted, instructionText) {
    if (extracted.kind === "pdf") {
      return [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: extracted.base64 } },
        { type: "text", text: instructionText },
      ];
    }
    if (extracted.kind === "image") {
      return [
        { type: "image", source: { type: "base64", media_type: extracted.mediaType, data: extracted.base64 } },
        { type: "text", text: instructionText },
      ];
    }
    let text = extracted.text || "";
    if (text.length > MAX_EXTRACT_TEXT_CHARS) {
      text = text.slice(0, MAX_EXTRACT_TEXT_CHARS) + "\n...(текст обрезан из-за размера)";
    }
    return [{ type: "text", text: `${instructionText}\n\n--- Содержимое файла ---\n${text}` }];
  }

  async function callClaudeExtract(apiKey, contentBlocks, schema, maxTokens) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: maxTokens || 1024,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: contentBlocks }],
      }),
    });

    if (!response.ok) {
      let detail = "";
      try {
        const errJson = await response.json();
        detail = errJson.error && errJson.error.message ? errJson.error.message : "";
      } catch (e) {
        // ignore
      }
      throw new Error(`Ошибка API Anthropic (${response.status})${detail ? ": " + detail : ""}`);
    }

    const data = await response.json();
    if (data.stop_reason === "refusal") {
      throw new Error("Модель отказалась обрабатывать этот файл.");
    }
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) throw new Error("Пустой ответ модели — не удалось распознать документ.");
    return JSON.parse(textBlock.text);
  }

  function requireApiKeyOrOpenSettings() {
    const apiKey = loadSettings().anthropicApiKey;
    if (!apiKey) {
      alert("Сначала укажите API-ключ Anthropic в настройках (значок ⚙ в левом верхнем углу).");
      openSettingsDialog();
      return null;
    }
    return apiKey;
  }

  // --- Photo recognition of a single material (Claude Vision) ---

  const materialPhotoInput = el("materialPhotoInput");
  const photoRecognizeStatus = el("photoRecognizeStatus");
  const addMaterialByPhotoBtn = el("addMaterialByPhotoBtn");

  addMaterialByPhotoBtn.addEventListener("click", () => {
    const project = getActiveProject();
    const section = getActiveSection(project);
    if (!section) return;
    if (!requireApiKeyOrOpenSettings()) return;
    materialPhotoInput.value = "";
    materialPhotoInput.click();
  });

  materialPhotoInput.addEventListener("change", async () => {
    const file = materialPhotoInput.files && materialPhotoInput.files[0];
    if (!file) return;
    const apiKey = loadSettings().anthropicApiKey;
    if (!apiKey) return;

    addMaterialByPhotoBtn.disabled = true;
    photoRecognizeStatus.hidden = false;
    try {
      const extracted = await extractFileContent(file);
      const blocks = buildContentBlocks(
        extracted,
        "Это фото расходной накладной или счёта на строительные материалы. Извлеки: название материала (если позиций несколько — одно обобщённое название), поставщика (если указан), суммарное количество с единицей измерения, итоговую сумму к оплате и дату документа в формате YYYY-MM-DD."
      );
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", description: "Название материала/товара (кратко, обобщённо, если позиций несколько)" },
          supplier: { type: "string", description: "Название поставщика/продавца, если указано в документе" },
          qty: { type: "string", description: "Количество с единицей измерения, например «120 м2» или «3 упаковки»" },
          sum: { type: "number", description: "Итоговая сумма к оплате по документу" },
          date: { type: "string", description: "Дата документа в формате YYYY-MM-DD, если указана" },
        },
        required: ["name", "sum"],
        additionalProperties: false,
      };
      const result = await callClaudeExtract(apiKey, blocks, schema, 1024);
      openMaterialDialog(null, result);
    } catch (err) {
      console.error(err);
      alert(
        `Не удалось распознать фото: ${err.message}\n\n` +
          "Если это ошибка сети/CORS, прямой вызов API Anthropic из браузера может быть недоступен — введите данные вручную кнопкой «+ Материал»."
      );
    } finally {
      addMaterialByPhotoBtn.disabled = false;
      photoRecognizeStatus.hidden = true;
    }
  });

  // --- Contract recognition from an uploaded file ---

  const contractFileInput = el("contractFileInput");
  const contractImportStatus = el("contractImportStatus");
  const addContractByFileBtn = el("addContractByFileBtn");

  addContractByFileBtn.addEventListener("click", () => {
    const project = getActiveProject();
    const section = getActiveSection(project);
    if (!section) return;
    if (!requireApiKeyOrOpenSettings()) return;
    contractFileInput.value = "";
    contractFileInput.click();
  });

  contractFileInput.addEventListener("change", async () => {
    const file = contractFileInput.files && contractFileInput.files[0];
    if (!file) return;
    const apiKey = loadSettings().anthropicApiKey;
    if (!apiKey) return;

    addContractByFileBtn.disabled = true;
    contractImportStatus.hidden = false;
    try {
      const extracted = await extractFileContent(file);
      const blocks = buildContentBlocks(
        extracted,
        "Это скан или файл договора с субподрядчиком на строительные работы. Извлеки: название субподрядчика (сторона-исполнитель по договору), итоговую договорную сумму, дату договора в формате YYYY-MM-DD (если есть) и краткую суть/предмет договора одной фразой."
      );
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", description: "Название субподрядчика (стороны-исполнителя по договору)" },
          sum: { type: "number", description: "Итоговая договорная сумма" },
          date: { type: "string", description: "Дата договора в формате YYYY-MM-DD, если указана" },
          note: { type: "string", description: "Краткая суть/предмет договора одной фразой" },
        },
        required: ["name", "sum"],
        additionalProperties: false,
      };
      const result = await callClaudeExtract(apiKey, blocks, schema, 1024);
      openContractDialog(null, result);
    } catch (err) {
      console.error(err);
      alert(
        `Не удалось распознать файл договора: ${err.message}\n\n` +
          "Введите данные вручную кнопкой «+ Договор»."
      );
    } finally {
      addContractByFileBtn.disabled = false;
      contractImportStatus.hidden = true;
    }
  });

  // --- Bulk materials import from an uploaded накладная (xlsx/docx/pdf/image) ---

  const materialsImportInput = el("materialsImportInput");
  const materialsImportStatus = el("materialsImportStatus");
  const addMaterialsByFileBtn = el("addMaterialsByFileBtn");
  const materialsImportDialog = el("materialsImportDialog");
  const materialsImportForm = el("materialsImportForm");
  const materialsImportDateInput = el("materialsImportDate");
  const materialsImportRowsEl = el("materialsImportRows");
  const addImportRowBtn = el("addImportRowBtn");
  const materialsImportCountEl = el("materialsImportCount");

  let importRows = [];

  function renderImportRows() {
    materialsImportRowsEl.innerHTML = "";
    importRows.forEach((row, idx) => {
      const rowEl = document.createElement("div");
      rowEl.className = "import-row";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.placeholder = "Название материала";
      nameInput.value = row.name;
      nameInput.addEventListener("input", () => {
        row.name = nameInput.value;
        updateImportCount();
      });

      const qtyInput = document.createElement("input");
      qtyInput.type = "text";
      qtyInput.placeholder = "Кол-во";
      qtyInput.value = row.qty;
      qtyInput.addEventListener("input", () => {
        row.qty = qtyInput.value;
      });

      const sumInput = document.createElement("input");
      sumInput.type = "number";
      sumInput.min = "0";
      sumInput.step = "0.01";
      sumInput.placeholder = "Сумма";
      sumInput.value = row.sum;
      sumInput.addEventListener("input", () => {
        row.sum = sumInput.value;
        updateImportCount();
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "import-row-delete";
      delBtn.textContent = "×";
      delBtn.title = "Удалить строку";
      delBtn.addEventListener("click", () => {
        importRows.splice(idx, 1);
        renderImportRows();
      });

      rowEl.appendChild(nameInput);
      rowEl.appendChild(qtyInput);
      rowEl.appendChild(sumInput);
      rowEl.appendChild(delBtn);
      materialsImportRowsEl.appendChild(rowEl);
    });
    updateImportCount();
  }

  function updateImportCount() {
    const valid = importRows.filter((r) => r.name.trim() && r.sum !== "" && !Number.isNaN(Number(r.sum)));
    materialsImportCountEl.textContent = valid.length;
  }

  function openMaterialsImportDialog(extracted) {
    importRows = (extracted.materials || []).map((m) => ({
      name: m.name || "",
      qty: m.qty || "",
      sum: m.sum != null ? String(m.sum) : "",
    }));
    if (!importRows.length) importRows.push({ name: "", qty: "", sum: "" });
    materialsImportDateInput.value = /^\d{4}-\d{2}-\d{2}$/.test(extracted.date || "")
      ? extracted.date
      : new Date().toISOString().slice(0, 10);
    renderImportRows();
    materialsImportDialog.showModal();
  }

  addImportRowBtn.addEventListener("click", () => {
    importRows.push({ name: "", qty: "", sum: "" });
    renderImportRows();
    const rows = materialsImportRowsEl.querySelectorAll(".import-row");
    const last = rows[rows.length - 1];
    if (last) last.querySelector("input").focus();
  });

  addMaterialsByFileBtn.addEventListener("click", () => {
    const project = getActiveProject();
    const section = getActiveSection(project);
    if (!section) return;
    if (!requireApiKeyOrOpenSettings()) return;
    materialsImportInput.value = "";
    materialsImportInput.click();
  });

  materialsImportInput.addEventListener("change", async () => {
    const file = materialsImportInput.files && materialsImportInput.files[0];
    if (!file) return;
    const apiKey = loadSettings().anthropicApiKey;
    if (!apiKey) return;

    addMaterialsByFileBtn.disabled = true;
    materialsImportStatus.hidden = false;
    try {
      const extracted = await extractFileContent(file);
      const blocks = buildContentBlocks(
        extracted,
        "Это расходная накладная, счёт или спецификация на строительные материалы, возможно с несколькими позициями. Извлеки список позиций: для каждой — название материала, количество с единицей измерения, сумма по позиции. Также извлеки общую дату документа в формате YYYY-MM-DD, если она есть."
      );
      const schema = {
        type: "object",
        properties: {
          date: { type: "string", description: "Дата документа в формате YYYY-MM-DD, если указана" },
          materials: {
            type: "array",
            description: "Список позиций материалов из документа",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Название материала" },
                qty: { type: "string", description: "Количество с единицей измерения" },
                sum: { type: "number", description: "Сумма по позиции" },
              },
              required: ["name", "sum"],
              additionalProperties: false,
            },
          },
        },
        required: ["materials"],
        additionalProperties: false,
      };
      const result = await callClaudeExtract(apiKey, blocks, schema, 4096);
      if (!result.materials || !result.materials.length) {
        throw new Error("В файле не найдено ни одной позиции материалов.");
      }
      openMaterialsImportDialog(result);
    } catch (err) {
      console.error(err);
      alert(
        `Не удалось разобрать файл: ${err.message}\n\n` +
          "Введите материалы вручную кнопкой «+ Материал»."
      );
    } finally {
      addMaterialsByFileBtn.disabled = false;
      materialsImportStatus.hidden = true;
    }
  });

  materialsImportForm.addEventListener("submit", () => {
    const project = getActiveProject();
    const section = getActiveSection(project);
    if (!section) return;
    const sharedDate = materialsImportDateInput.value || new Date().toISOString().slice(0, 10);
    let added = 0;
    importRows.forEach((row) => {
      const name = row.name.trim();
      const sumVal = Number(row.sum);
      if (!name || Number.isNaN(sumVal) || sumVal < 0) return;
      section.materials.push({ id: uid(), name, qty: (row.qty || "").trim(), sum: sumVal, date: sharedDate });
      added += 1;
    });
    if (added > 0) {
      saveState();
      render();
    }
  });

  // --- Progress CRUD ---

  const progressDialog = el("progressDialog");
  const progressForm = el("progressForm");
  const progressDialogTitle = el("progressDialogTitle");
  const progressIdInput = el("progressId");
  const progressDateInput = el("progressDate");
  const progressAmountInput = el("progressAmount");
  const progressNoteInput = el("progressNote");

  function openProgressDialog(entry) {
    progressDialogTitle.textContent = entry ? "Изменить запись" : "Новая запись о выполнении";
    progressIdInput.value = entry ? entry.id : "";
    progressDateInput.value = entry ? entry.date : new Date().toISOString().slice(0, 10);
    progressAmountInput.value = entry ? entry.amount : "";
    progressNoteInput.value = entry ? entry.note || "" : "";
    progressDialog.showModal();
    progressAmountInput.focus();
  }

  el("addProgressBtn").addEventListener("click", () => openProgressDialog(null));

  progressForm.addEventListener("submit", () => {
    const project = getActiveProject();
    const section = getActiveSection(project);
    if (!section) return;
    const amount = Number(progressAmountInput.value);
    const date = progressDateInput.value;
    if (Number.isNaN(amount) || amount < 0 || !date) return;
    const note = progressNoteInput.value.trim();

    if (progressIdInput.value) {
      const p = section.progress.find((x) => x.id === progressIdInput.value);
      if (p) Object.assign(p, { amount, date, note });
    } else {
      section.progress.push({ id: uid(), amount, date, note });
    }
    saveState();
    render();
  });

  function deleteProgress(section, id) {
    if (!confirm("Удалить эту запись о выполнении?")) return;
    section.progress = section.progress.filter((p) => p.id !== id);
    saveState();
    render();
  }

  render();
})();
