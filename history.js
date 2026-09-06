// history.js
// Append-only log of each scan's report, so you can look back and
// check whether the squeeze thesis / short setups actually played out.
// Lives on the persistent volume when one is attached (see storage.js).

const { readJson, writeJson } = require("./storage");

const FILE = "history.json";

function loadHistory() {
  const data = readJson(FILE, []);
  return Array.isArray(data) ? data : [];
}

function appendReport(report) {
  const history = loadHistory();
  history.unshift({ ...report, savedAt: new Date().toISOString() });
  // keep last 200 reports
  const trimmed = history.slice(0, 200);
  writeJson(FILE, trimmed);
  return trimmed[0];
}

function getRecent(limit = 20) {
  return loadHistory().slice(0, limit);
}

module.exports = { appendReport, getRecent };
