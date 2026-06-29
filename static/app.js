const state = {
  report: null,
  selectedKey: null,
  selectedCallId: null,
  details: new Map(),
  lastSseAt: null,
  sourceOnline: false,
  refreshTimer: null,
};

const els = {
  liveDot: document.querySelector("#liveDot"),
  liveLabel: document.querySelector("#liveLabel"),
  reportRows: document.querySelector("#reportRows"),
  drilldown: document.querySelector("#drilldown"),
  drillTitle: document.querySelector("#drillTitle"),
  clearDrill: document.querySelector("#clearDrill"),
  drillRows: document.querySelector("#drillRows"),
  rawDetail: document.querySelector("#rawDetail"),
};

const serviceLabels = new Map([
  ["codex_exec", "Codex"],
  ["claude-code", "Claude Code"],
]);

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
  return Number(row.input_tokens || 0)
    + Number(row.output_tokens || 0)
    + Number(row.cache_write_tokens || 0)
    + Number(row.cached_tokens || 0);
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

function modelList(models) {
  return models.map((model) => `- ${model.model}`).join("\n");
}

function renderReport(report) {
  state.report = report;
  els.reportRows.replaceChildren();

  if (!report.groups.length) {
    const tr = document.createElement("tr");
    tr.append(makeCell("No token usage yet"));
    tr.append(makeCell(""));
    tr.append(makeNumberCell(0));
    tr.append(makeNumberCell(0));
    tr.append(makeNumberCell(0));
    tr.append(makeNumberCell(0));
    tr.append(makeNumberCell(0));
    els.reportRows.append(tr);
    return;
  }

  for (const group of report.groups) {
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

  const total = report.totals;
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
  els.rawDetail.hidden = true;
  els.rawDetail.textContent = "";
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
      makeNumberCell(call.cached_tokens),
      makeNumberCell(displayedTokenTotal(call)),
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
    row.classList.toggle("selected", Number(row.dataset.id) === id);
  }
  els.rawDetail.hidden = false;
  els.rawDetail.textContent = "Loading...";
  if (state.details.has(id)) {
    els.rawDetail.textContent = JSON.stringify(state.details.get(id), null, 2);
    return;
  }
  const response = await fetch(`/api/event?id=${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`detail failed: ${response.status}`);
  const payload = await response.json();
  state.details.set(id, payload.event);
  els.rawDetail.textContent = JSON.stringify(payload.event, null, 2);
}

async function loadReport() {
  const response = await fetch("/api/report", { cache: "no-store" });
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

els.clearDrill.addEventListener("click", () => {
  state.selectedKey = null;
  state.selectedCallId = null;
  els.drilldown.hidden = true;
  els.rawDetail.hidden = true;
  els.rawDetail.textContent = "";
  if (state.report) renderReport(state.report);
});

loadReport()
  .catch((error) => {
    console.error(error);
    setConnection("stale", "Report failed");
  })
  .finally(connectEvents);
