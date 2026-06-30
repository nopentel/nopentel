const HIDDEN_PROJECTS_KEY = "nopentel.hiddenProjects";

const state = {
  report: null,
  selectedKey: null,
  selectedEventType: null,
  selectedCallId: null,
  scopeEvents: [],
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
  eventSummary: document.querySelector("#eventSummary"),
  eventListPanel: document.querySelector("#eventListPanel"),
  eventListTitle: document.querySelector("#eventListTitle"),
  clearEventType: document.querySelector("#clearEventType"),
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

const eventCategoryOrder = ["Conversation", "Model/API", "Tools", "System"];

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

function fmtMetric(value) {
  if (value === null || value === undefined) return "n/a";
  return fmtNumber(value);
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
  if (row.has_token_metrics === false) return null;
  const cacheRead = row.cache_read_display_tokens ?? row.cached_tokens;
  return Number(row.input_tokens || 0)
    + Number(row.output_tokens || 0)
    + Number(row.cache_write_tokens || 0)
    + Number(cacheRead || 0);
}

function eventCategoryName(eventName) {
  const value = String(eventName || "").toLowerCase();
  if (value.includes("user_prompt") || value.includes("assistant_response") || value.includes("compaction")) {
    return "Conversation";
  }
  if (value.includes("api_request") || value.includes("sse") || value.includes("websocket") || value.includes("turn_ttft")) {
    return "Model/API";
  }
  if (value.includes("tool") || value.includes("hook") || value.includes("mcp")) {
    return "Tools";
  }
  return "System";
}

function metricTokenTotal(event) {
  const total = event.display_total_tokens ?? displayedTokenTotal(event);
  return total === null || total === undefined ? null : Number(total || 0);
}

function setConnection(status, label) {
  els.liveDot.className = `dot dot-${status}`;
  els.liveLabel.textContent = label;
}

function rowKey(day, project, model = "", service = "") {
  return `${day}\u0000${project}\u0000${model}\u0000${service}`;
}

function makeCell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function makeDiv(text, className = "") {
  const div = document.createElement("div");
  div.textContent = text;
  if (className) div.className = className;
  return div;
}

function makeSpan(text, className = "") {
  const span = document.createElement("span");
  span.textContent = text;
  if (className) span.className = className;
  return span;
}

function makeNumberCell(value) {
  return makeCell(fmtNumber(value), "num");
}

function makeMetricCell(value) {
  return makeCell(fmtMetric(value), "num");
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

function modelDisplayName(model) {
  const source = model.source_label || serviceLabel(model.service_name);
  if (!source || source === "Unknown") return model.model;
  return `${source} / ${model.model}`;
}

function modelList(models) {
  return models.map((model) => `- ${modelDisplayName(model)}`).join("\n");
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
  const totals = groups.reduce(
    (totals, group) => {
      for (const field of [
        "calls",
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "reasoning_tokens",
        "tool_tokens",
        "duration_ms",
        "total_tokens",
      ]) {
        totals[field] += Number(group[field] || 0);
      }
      totals.cache_write_tokens += Number(group.cache_write_tokens || 0);
      totals.cache_write_known_rows += Number(group.cache_write_known_rows || 0);
      totals.cache_write_unknown_rows += Number(group.cache_write_unknown_rows || 0);
      totals.cost_usd += Number(group.cost_usd || 0);
      return totals;
    },
    {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_write_known_rows: 0,
      cache_write_unknown_rows: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      tool_tokens: 0,
      duration_ms: 0,
      cost_usd: 0,
      total_tokens: 0,
    },
  );
  if (!totals.cache_write_known_rows) totals.cache_write_tokens = null;
  return totals;
}

function selectedKeyVisible(groups) {
  if (!state.selectedKey) return true;
  return groups.some((group) => {
    if (rowKey(group.day, group.project_name) === state.selectedKey) return true;
    return group.models.some(
      (model) => rowKey(group.day, group.project_name, model.model, model.service_name || "") === state.selectedKey,
    );
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
  state.selectedEventType = null;
  state.selectedCallId = null;
  state.scopeEvents = [];
  state.callsById.clear();
  els.drilldown.hidden = true;
  els.eventListPanel.hidden = true;
  els.eventSummary.replaceChildren();
  els.drillRows.replaceChildren();
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
      makeMetricCell(group.cache_write_tokens),
      makeNumberCell(group.cached_tokens),
      makeNumberCell(group.total_tokens),
    );
    summaryRow.addEventListener("click", () => selectReportGroup(group));
    els.reportRows.append(summaryRow);

    for (const model of group.models) {
      const modelRow = document.createElement("tr");
      modelRow.className = "model-row";
      modelRow.dataset.key = rowKey(group.day, group.project_name, model.model, model.service_name || "");
      if (state.selectedKey === modelRow.dataset.key) modelRow.classList.add("selected");
      modelRow.append(
        makeCell(`\u2514 ${modelDisplayName(model)}`, "model-indent"),
        makeCell(""),
        makeNumberCell(model.input_tokens),
        makeNumberCell(model.output_tokens),
        makeMetricCell(model.cache_write_tokens),
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
    makeMetricCell(total.cache_write_tokens),
    makeNumberCell(total.cached_tokens),
    makeNumberCell(total.total_tokens),
  );
  els.reportRows.append(totalRow);
}

async function selectReportGroup(group, model = null) {
  const key = rowKey(group.day, group.project_name, model?.model || "", model?.service_name || "");
  state.selectedKey = key;
  state.selectedEventType = null;
  state.selectedCallId = null;
  renderReport(state.report);
  els.inspector.hidden = true;
  els.rawDetail.textContent = "";
  els.inspectorMeta.replaceChildren();
  els.drilldown.hidden = false;
  els.eventListPanel.hidden = true;
  els.eventSummary.replaceChildren(makeDiv("Loading...", "event-empty"));
  els.drillRows.replaceChildren();
  els.drillTitle.textContent = model
    ? `${group.day} / ${group.project_name} / ${modelDisplayName(model)}`
    : `${group.day} / ${group.project_name}`;

  const params = new URLSearchParams({
    day: group.day,
    project: group.project_name,
  });
  if (model) params.set("model", model.model);
  if (model?.service_name) params.set("service", model.service_name);
  const response = await fetch(`/api/report/calls?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`calls failed: ${response.status}`);
  const payload = await response.json();
  renderEventSummary(payload.calls || []);
}

function eventTypeSummaries(events) {
  const summaries = new Map();
  for (const event of events) {
    const eventName = event.event_name || "unknown";
    const summary = summaries.get(eventName) || {
      name: eventName,
      category: eventCategoryName(eventName),
      count: 0,
      tokenRows: 0,
      tokenTotal: 0,
      latest: "",
    };
    summary.count += 1;
    const tokenTotal = metricTokenTotal(event);
    if (tokenTotal !== null) {
      summary.tokenRows += 1;
      summary.tokenTotal += tokenTotal;
    }
    if (!summary.latest || String(event.observed_at || "") > summary.latest) {
      summary.latest = event.observed_at || "";
    }
    summaries.set(eventName, summary);
  }
  return [...summaries.values()].sort((a, b) => {
    const categoryDelta = eventCategoryOrder.indexOf(a.category) - eventCategoryOrder.indexOf(b.category);
    if (categoryDelta) return categoryDelta;
    return b.count - a.count || b.tokenTotal - a.tokenTotal || a.name.localeCompare(b.name);
  });
}

function renderEventSummary(events) {
  state.scopeEvents = events;
  state.callsById = new Map(events.map((event) => [event.id, event]));
  state.selectedEventType = null;
  state.selectedCallId = null;
  els.eventSummary.replaceChildren();
  els.eventListPanel.hidden = true;
  els.drillRows.replaceChildren();
  els.inspector.hidden = true;
  els.rawDetail.textContent = "";
  els.inspectorMeta.replaceChildren();

  if (!events.length) {
    els.eventSummary.replaceChildren(makeDiv("No matching events", "event-empty"));
    return;
  }

  const summaries = eventTypeSummaries(events);
  const tokenRows = events.filter((event) => metricTokenTotal(event) !== null).length;
  const tokenTotal = events.reduce((total, event) => total + (metricTokenTotal(event) ?? 0), 0);
  const totals = document.createElement("div");
  totals.className = "event-totals";
  for (const [label, value] of [
    ["Events", fmtNumber(events.length)],
    ["Types", fmtNumber(summaries.length)],
    ["Token Rows", fmtNumber(tokenRows)],
    ["Token Δ", fmtNumber(tokenTotal)],
  ]) {
    const item = document.createElement("div");
    item.className = "event-total";
    item.append(makeDiv(label, "event-total-label"), makeDiv(value, "event-total-value"));
    totals.append(item);
  }
  els.eventSummary.append(totals);

  for (const category of eventCategoryOrder) {
    const categorySummaries = summaries.filter((summary) => summary.category === category);
    if (!categorySummaries.length) continue;
    const section = document.createElement("section");
    section.className = "event-category";
    section.append(makeDiv(category, "event-category-title"));
    const grid = document.createElement("div");
    grid.className = "event-type-grid";
    for (const summary of categorySummaries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "event-type-button";
      button.dataset.eventType = summary.name;
      button.append(
        makeSpan(summary.name, "event-type-name"),
        makeSpan(fmtNumber(summary.count), "event-type-count"),
        makeSpan(
          summary.tokenRows
            ? `${fmtNumber(summary.tokenRows)} token rows / ${fmtNumber(summary.tokenTotal)} token Δ`
            : "no token metrics",
          "event-type-meta",
        ),
      );
      button.addEventListener("click", () => selectEventType(summary.name));
      grid.append(button);
    }
    section.append(grid);
    els.eventSummary.append(section);
  }
}

function markSelectedEventType() {
  for (const button of els.eventSummary.querySelectorAll(".event-type-button")) {
    button.classList.toggle("selected", button.dataset.eventType === state.selectedEventType);
  }
}

function selectEventType(eventType) {
  state.selectedEventType = eventType;
  state.selectedCallId = null;
  markSelectedEventType();
  els.inspector.hidden = true;
  els.rawDetail.textContent = "";
  els.inspectorMeta.replaceChildren();
  const events = state.scopeEvents.filter((event) => event.event_name === eventType);
  els.eventListTitle.textContent = `${eventType} (${fmtNumber(events.length)})`;
  els.eventListPanel.hidden = false;
  renderCalls(events);
}

function renderCalls(calls) {
  els.drillRows.replaceChildren();
  if (!calls.length) {
    const tr = document.createElement("tr");
    const td = makeCell("No matching events");
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
      makeMetricCell(call.input_tokens),
      makeMetricCell(call.output_tokens),
      makeMetricCell(call.cache_write_tokens),
      makeMetricCell(call.cache_read_display_tokens ?? call.cached_tokens),
      makeMetricCell(call.display_total_tokens ?? displayedTokenTotal(call)),
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
  els.inspectorTitle.textContent = event.id ? `Event ${event.id}` : "Event";
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
    makeMetaValue(fmtMetric(event.input_tokens)),
    makeMetaTerm("Output"),
    makeMetaValue(fmtMetric(event.output_tokens)),
    makeMetaTerm("Cache Create"),
    makeMetaValue(fmtMetric(event.cache_write_tokens)),
    makeMetaTerm("Cache Read Raw"),
    makeMetaValue(fmtMetric(event.cache_read_raw_tokens ?? event.cached_tokens)),
    makeMetaTerm("Cache Read Delta"),
    makeMetaValue(fmtMetric(event.cache_read_display_tokens ?? event.cached_tokens)),
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

els.clearEventType.addEventListener("click", () => {
  state.selectedEventType = null;
  state.selectedCallId = null;
  markSelectedEventType();
  els.eventListPanel.hidden = true;
  els.drillRows.replaceChildren();
  els.inspector.hidden = true;
  els.rawDetail.textContent = "";
  els.inspectorMeta.replaceChildren();
});

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
