const HIDDEN_PROJECTS_KEY = "nopentel.hiddenProjects";

const state = {
  report: null,
  selectedKey: null,
  selectedCallId: null,
  details: new Map(),
  callsById: new Map(),
  hiddenProjects: new Set(loadHiddenProjects()),
  filters: {
    from: "",
    to: "",
  },
  lastSseAt: null,
  sourceOnline: false,
  refreshTimer: null,
};

const els = {
  liveDot: document.querySelector("#liveDot"),
  liveLabel: document.querySelector("#liveLabel"),
  fromDate: document.querySelector("#fromDate"),
  toDate: document.querySelector("#toDate"),
  clearDates: document.querySelector("#clearDates"),
  projectMenu: document.querySelector("#projectMenu"),
  projectMenuLabel: document.querySelector("#projectMenuLabel"),
  projectOptions: document.querySelector("#projectOptions"),
  reportRows: document.querySelector("#reportRows"),
  drilldown: document.querySelector("#drilldown"),
  drillTitle: document.querySelector("#drillTitle"),
  clearDrill: document.querySelector("#clearDrill"),
  drillRows: document.querySelector("#drillRows"),
  inspector: document.querySelector("#inspector"),
  inspectorTitle: document.querySelector("#inspectorTitle"),
  inspectorMeta: document.querySelector("#inspectorMeta"),
  closeInspector: document.querySelector("#closeInspector"),
  rawDetail: document.querySelector("#rawDetail"),
};

const serviceLabels = new Map([
  ["codex_exec", "Codex"],
  ["codex_cli_rs", "Codex"],
  ["codex-app-server", "Codex"],
  ["claude-code", "Claude Code"],
]);

function loadHiddenProjects() {
  try {
    const values = JSON.parse(localStorage.getItem(HIDDEN_PROJECTS_KEY) || "[]");
    return Array.isArray(values) ? values : [];
  } catch {
    return [];
  }
}

function saveHiddenProjects() {
  localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...state.hiddenProjects]));
}

function fmtNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function fmtTime(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function serviceLabel(value) {
  if (!value) return "Unknown";
  return serviceLabels.get(value) || value;
}

function displayedTokenTotal(row) {
  const cacheRead = row.cache_read_display_tokens ?? row.cached_tokens;
  return Number(row.input_tokens || 0)
    + Number(row.output_tokens || 0)
    + Number(row.cache_write_tokens || 0)
    + Number(cacheRead || 0);
}

function setConnection(status, label) {
  els.liveDot.className = `dot dot-${status}`;
  els.liveLabel.textContent = label;
}

function rowKey(day, project, model = "") {
  return `${day}\u0000${project}\u0000${model}`;
}

function makeCell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function makeNumberCell(value) {
  return makeCell(fmtNumber(value), "num");
}

function makeMetaTerm(text) {
  const dt = document.createElement("dt");
  dt.textContent = text;
  return dt;
}

function makeMetaValue(text) {
  const dd = document.createElement("dd");
  dd.textContent = text || "n/a";
  return dd;
}

function modelList(models) {
  return models.map((model) => `- ${model.model}`).join("\n");
}

function projectNames(report) {
  return [...new Set((report?.groups || []).map((group) => group.project_name))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function visibleGroups(report) {
  return (report?.groups || []).filter((group) => !state.hiddenProjects.has(group.project_name));
}

function visibleTotals(groups) {
  return groups.reduce(
    (totals, group) => {
      for (const field of [
        "calls",
        "input_tokens",
        "output_tokens",
        "cache_write_tokens",
        "cached_tokens",
        "reasoning_tokens",
        "tool_tokens",
        "duration_ms",
        "total_tokens",
      ]) {
        totals[field] += Number(group[field] || 0);
      }
      totals.cost_usd += Number(group.cost_usd || 0);
      return totals;
    },
    {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      tool_tokens: 0,
      duration_ms: 0,
      cost_usd: 0,
      total_tokens: 0,
    },
  );
}

function selectedKeyVisible(groups) {
  if (!state.selectedKey) return true;
  return groups.some((group) => {
    if (rowKey(group.day, group.project_name) === state.selectedKey) return true;
    return group.models.some((model) => rowKey(group.day, group.project_name, model.model) === state.selectedKey);
  });
}

function updateProjectMenu(report) {
  const projects = projectNames(report);
  els.projectOptions.replaceChildren();

  for (const project of projects) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !state.hiddenProjects.has(project);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.hiddenProjects.delete(project);
      } else {
        state.hiddenProjects.add(project);
      }
      saveHiddenProjects();
      renderReport(state.report);
    });
    label.append(checkbox, document.createTextNode(project));
    els.projectOptions.append(label);
  }

  const visibleCount = projects.filter((project) => !state.hiddenProjects.has(project)).length;
  els.projectMenuLabel.textContent = `Projects ${visibleCount}/${projects.length}`;
}

function clearSelection(rerender = true) {
  state.selectedKey = null;
  state.selectedCallId = null;
  state.callsById.clear();
  els.drilldown.hidden = true;
  els.inspector.hidden = true;
  els.rawDetail.textContent = "";
  els.inspectorMeta.replaceChildren();
  if (rerender && state.report) renderReport(state.report);
}

function renderReport(report) {
  state.report = report;
  updateProjectMenu(report);
  const groups = visibleGroups(report);

  if (!selectedKeyVisible(groups)) {
    clearSelection(false);
  }

  els.reportRows.replaceChildren();

  if (!groups.length) {
    const tr = document.createElement("tr");
    const td = makeCell("No matching token usage");
    td.colSpan = 7;
    tr.append(td);
    els.reportRows.append(tr);
    return;
  }

  for (const group of groups) {
    const projectRow = document.createElement("tr");
    projectRow.className = "project-row";
    const projectCell = makeCell(`Project: ${group.project_name}`);
    projectCell.colSpan = 7;
    projectRow.append(projectCell);
    projectRow.addEventListener("click", () => selectReportGroup(group));
    els.reportRows.append(projectRow);

    const summaryRow = document.createElement("tr");
    summaryRow.className = "summary-row";
    summaryRow.dataset.key = rowKey(group.day, group.project_name);
    if (state.selectedKey === summaryRow.dataset.key) summaryRow.classList.add("selected");
    summaryRow.append(
      makeCell(group.day),
      makeCell(modelList(group.models), "models"),
      makeNumberCell(group.input_tokens),
      makeNumberCell(group.output_tokens),
      makeNumberCell(group.cache_write_tokens),
      makeNumberCell(group.cached_tokens),
      makeNumberCell(group.total_tokens),
    );
    summaryRow.addEventListener("click", () => selectReportGroup(group));
    els.reportRows.append(summaryRow);

    for (const model of group.models) {
      const modelRow = document.createElement("tr");
      modelRow.className = "model-row";
      modelRow.dataset.key = rowKey(group.day, group.project_name, model.model);
      if (state.selectedKey === modelRow.dataset.key) modelRow.classList.add("selected");
      modelRow.append(
        makeCell(`\u2514 ${model.model}`, "model-indent"),
        makeCell(""),
        makeNumberCell(model.input_tokens),
        makeNumberCell(model.output_tokens),
        makeNumberCell(model.cache_write_tokens),
        makeNumberCell(model.cached_tokens),
        makeNumberCell(model.total_tokens),
      );
      modelRow.addEventListener("click", () => selectReportGroup(group, model));
      els.reportRows.append(modelRow);
    }
  }

  const total = visibleTotals(groups);
  const totalRow = document.createElement("tr");
  totalRow.className = "total-row";
  totalRow.append(
    makeCell("Total"),
    makeCell(""),
    makeNumberCell(total.input_tokens),
    makeNumberCell(total.output_tokens),
    makeNumberCell(total.cache_write_tokens),
    makeNumberCell(total.cached_tokens),
    makeNumberCell(total.total_tokens),
  );
  els.reportRows.append(totalRow);
}

async function selectReportGroup(group, model = null) {
  const key = rowKey(group.day, group.project_name, model?.model || "");
  state.selectedKey = key;
  state.selectedCallId = null;
  renderReport(state.report);
  els.inspector.hidden = true;
  els.rawDetail.textContent = "";
  els.inspectorMeta.replaceChildren();
  els.drilldown.hidden = false;
  els.drillTitle.textContent = model
    ? `${group.day} / ${group.project_name} / ${model.model}`
    : `${group.day} / ${group.project_name}`;
  els.drillRows.replaceChildren(makeLoadingRow());

  const params = new URLSearchParams({
    day: group.day,
    project: group.project_name,
  });
  if (model) params.set("model", model.model);
  const response = await fetch(`/api/report/calls?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`calls failed: ${response.status}`);
  const payload = await response.json();
  renderCalls(payload.calls || []);
}

function makeLoadingRow() {
  const tr = document.createElement("tr");
  const td = makeCell("Loading...");
  td.colSpan = 10;
  tr.append(td);
  return tr;
}

function renderCalls(calls) {
  els.drillRows.replaceChildren();
  state.callsById = new Map(calls.map((call) => [call.id, call]));
  if (!calls.length) {
    const tr = document.createElement("tr");
    const td = makeCell("No matching calls");
    td.colSpan = 10;
    tr.append(td);
    els.drillRows.append(tr);
    return;
  }
  for (const call of calls) {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.dataset.id = call.id;
    if (state.selectedCallId === call.id) tr.classList.add("selected");
    tr.append(
      makeCell(fmtTime(call.observed_at)),
      makeCell(serviceLabel(call.service_name)),
      makeCell(call.project_name || "n/a"),
      makeCell(call.model || "n/a"),
      makeCell(call.event_name),
      makeNumberCell(call.input_tokens),
      makeNumberCell(call.output_tokens),
      makeNumberCell(call.cache_write_tokens),
      makeNumberCell(call.cache_read_display_tokens ?? call.cached_tokens),
      makeNumberCell(call.display_total_tokens ?? displayedTokenTotal(call)),
    );
    tr.addEventListener("click", () => selectCall(call.id));
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectCall(call.id);
      }
    });
    els.drillRows.append(tr);
  }
}

async function selectCall(id) {
  state.selectedCallId = id;
  for (const row of els.drillRows.querySelectorAll("tr")) {
    row.classList.toggle("selected", row.dataset.id === String(id));
  }
  const base = state.callsById.get(id) || {};
  renderInspector(base, true);
  if (state.details.has(id)) {
    renderInspector(state.details.get(id));
    return;
  }
  const response = await fetch(`/api/event?id=${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`detail failed: ${response.status}`);
  const payload = await response.json();
  const detail = {
    ...payload.event,
    cache_read_display_tokens: base.cache_read_display_tokens ?? payload.event.cached_tokens,
    cache_read_raw_tokens: base.cache_read_raw_tokens ?? payload.event.cached_tokens,
    display_total_tokens: base.display_total_tokens ?? displayedTokenTotal(base),
  };
  state.details.set(id, detail);
  renderInspector(detail);
}

function renderInspector(event, loading = false) {
  els.inspector.hidden = false;
  els.inspectorTitle.textContent = event.id ? `Request ${event.id}` : "Request";
  els.inspectorMeta.replaceChildren(
    makeMetaTerm("Time"),
    makeMetaValue(fmtTime(event.observed_at)),
    makeMetaTerm("Source"),
    makeMetaValue(serviceLabel(event.service_name)),
    makeMetaTerm("Project"),
    makeMetaValue(event.project_name),
    makeMetaTerm("Model"),
    makeMetaValue(event.model),
    makeMetaTerm("Event"),
    makeMetaValue(event.event_name),
    makeMetaTerm("Request ID"),
    makeMetaValue(event.request_id),
    makeMetaTerm("Session"),
    makeMetaValue(
      event.short_session_key
        || event.session_key
        || event.short_conversation_id
        || event.conversation_id
        || event.session_id,
    ),
    makeMetaTerm("Session Source"),
    makeMetaValue(event.session_key_source),
    makeMetaTerm("Prompt ID"),
    makeMetaValue(event.prompt_id),
    makeMetaTerm("Conversation"),
    makeMetaValue(event.short_conversation_id || event.conversation_id),
    makeMetaTerm("Input"),
    makeMetaValue(fmtNumber(event.input_tokens)),
    makeMetaTerm("Output"),
    makeMetaValue(fmtNumber(event.output_tokens)),
    makeMetaTerm("Cache Create"),
    makeMetaValue(fmtNumber(event.cache_write_tokens)),
    makeMetaTerm("Cache Read Raw"),
    makeMetaValue(fmtNumber(event.cache_read_raw_tokens ?? event.cached_tokens)),
    makeMetaTerm("Cache Read Delta"),
    makeMetaValue(fmtNumber(event.cache_read_display_tokens ?? event.cached_tokens)),
    makeMetaTerm("Duration"),
    makeMetaValue(event.duration_ms ? `${fmtNumber(event.duration_ms)} ms` : "n/a"),
  );
  els.rawDetail.textContent = loading ? "Loading..." : JSON.stringify(detailForDisplay(event), null, 2);
}

function detailForDisplay(event) {
  const detail = { ...event };
  if (detail.raw_json) {
    try {
      detail.raw = JSON.parse(detail.raw_json);
      delete detail.raw_json;
    } catch {
      detail.raw = detail.raw_json;
      delete detail.raw_json;
    }
  }
  return detail;
}

async function loadReport() {
  const params = new URLSearchParams();
  if (state.filters.from) params.set("from", state.filters.from);
  if (state.filters.to) params.set("to", state.filters.to);
  const query = params.toString();
  const response = await fetch(`/api/report${query ? `?${query}` : ""}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`report failed: ${response.status}`);
  const payload = await response.json();
  for (const service of payload.summary?.known_services || []) {
    if (service.name && service.label) serviceLabels.set(service.name, service.label);
  }
  renderReport(payload.report);
}

function scheduleReportRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    loadReport().catch((error) => {
      console.error(error);
      setConnection("stale", "Report error");
    });
  }, 400);
}

function connectEvents() {
  const source = new EventSource("/events");
  source.addEventListener("open", () => {
    state.sourceOnline = true;
    state.lastSseAt = new Date();
    setConnection("live", "Live");
  });
  source.addEventListener("event", () => {
    state.lastSseAt = new Date();
    scheduleReportRefresh();
  });
  source.addEventListener("call", () => {
    state.lastSseAt = new Date();
    scheduleReportRefresh();
  });
  source.addEventListener("summary", () => {
    state.lastSseAt = new Date();
    scheduleReportRefresh();
  });
  source.addEventListener("error", () => {
    state.sourceOnline = false;
    setConnection("stale", "Reconnecting");
  });

  setInterval(() => {
    if (!state.lastSseAt) return;
    const age = Date.now() - state.lastSseAt.getTime();
    if (age > 30000 && state.sourceOnline) setConnection("stale", "Quiet");
  }, 5000);
}

function reloadForFilters() {
  state.filters.from = els.fromDate.value;
  state.filters.to = els.toDate.value;
  clearSelection(false);
  loadReport().catch((error) => {
    console.error(error);
    setConnection("stale", "Report failed");
  });
}

els.clearDrill.addEventListener("click", () => clearSelection());

els.closeInspector.addEventListener("click", () => {
  state.selectedCallId = null;
  els.inspector.hidden = true;
  els.rawDetail.textContent = "";
  els.inspectorMeta.replaceChildren();
  for (const row of els.drillRows.querySelectorAll("tr")) {
    row.classList.remove("selected");
  }
});

els.fromDate.addEventListener("change", reloadForFilters);
els.toDate.addEventListener("change", reloadForFilters);

els.clearDates.addEventListener("click", () => {
  els.fromDate.value = "";
  els.toDate.value = "";
  reloadForFilters();
});

loadReport()
  .catch((error) => {
    console.error(error);
    setConnection("stale", "Report failed");
  })
  .finally(connectEvents);
