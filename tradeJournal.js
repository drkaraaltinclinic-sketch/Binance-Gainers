// tradeJournal.js
//
// The "brain" — but the honest version of one. Each logged trade records
// the CONDITIONS the setup was produced under (squeeze score/label, entry
// timing phase) alongside what ACTUALLY happened. Accumulate enough of
// these and you can see which conditions genuinely produce wins — e.g.
// whether "Flip Confirmed" setups really outperform "Too Early" ones, or
// whether High-squeeze setups earn their conviction.
//
// What this deliberately does NOT do: auto-tune any scoring threshold off
// these results. A few dozen trades can't distinguish real signal from
// noise, and a system that self-adjusts on noise gets worse, not better.
// This surfaces the evidence; the decision to change a rule stays with a
// human. Same "manual review only" philosophy as the rest of the app.

const { readJson, writeJson } = require("./storage");

const FILE = "trades.json";
const MIN_SAMPLE_FOR_CONFIDENCE = 30;

function loadTrades() {
  const data = readJson(FILE, []);
  return Array.isArray(data) ? data : [];
}

function logTrade(entry) {
  const trades = loadTrades();
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    loggedAt: new Date().toISOString(),
    ticker: String(entry.ticker || "").toUpperCase(),
    // Conditions at setup time — this is what makes the journal analyzable
    squeezeScore: entry.squeezeScore != null ? Number(entry.squeezeScore) : null,
    squeezeLabel: entry.squeezeLabel || null,
    entryTimingPhase: entry.entryTimingPhase || null,
    // What actually happened
    entered: !!entry.entered,
    entryPrice: entry.entryPrice != null ? Number(entry.entryPrice) : null,
    exitPrice: entry.exitPrice != null ? Number(entry.exitPrice) : null,
    pnlUsdt: entry.pnlUsdt != null ? Number(entry.pnlUsdt) : null,
    pnlPct: entry.pnlPct != null ? Number(entry.pnlPct) : null,
    outcome: entry.outcome || null, // win | loss | breakeven | skipped
    notes: entry.notes || "",
  };
  trades.unshift(record);
  writeJson(FILE, trades);
  return record;
}

function deleteTrade(id) {
  const trades = loadTrades();
  const remaining = trades.filter((t) => t.id !== id);
  writeJson(FILE, remaining);
  return { removed: trades.length - remaining.length };
}

function bucketStats(trades) {
  const entered = trades.filter((t) => t.entered && (t.outcome === "win" || t.outcome === "loss" || t.outcome === "breakeven"));
  const wins = entered.filter((t) => t.outcome === "win").length;
  const losses = entered.filter((t) => t.outcome === "loss").length;
  const pnlValues = entered.map((t) => t.pnlPct).filter((v) => v != null && !Number.isNaN(v));
  const avgPnlPct = pnlValues.length ? pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length : null;
  const totalPnlUsdt = entered.map((t) => t.pnlUsdt).filter((v) => v != null && !Number.isNaN(v)).reduce((a, b) => a + b, 0);
  return {
    count: entered.length,
    wins,
    losses,
    winRate: entered.length ? +((wins / entered.length) * 100).toFixed(1) : null,
    avgPnlPct: avgPnlPct != null ? +avgPnlPct.toFixed(2) : null,
    totalPnlUsdt: +totalPnlUsdt.toFixed(2),
  };
}

function getStats() {
  const trades = loadTrades();
  const overall = bucketStats(trades);

  const byLabel = {};
  for (const label of ["High", "Moderate", "Low"]) {
    byLabel[label] = bucketStats(trades.filter((t) => t.squeezeLabel === label));
  }
  const byPhase = {};
  for (const phase of ["flip_confirmed", "mixed", "too_early"]) {
    byPhase[phase] = bucketStats(trades.filter((t) => t.entryTimingPhase === phase));
  }

  return {
    overall,
    byLabel,
    byPhase,
    totalLogged: trades.length,
    skipped: trades.filter((t) => !t.entered).length,
    minSampleForConfidence: MIN_SAMPLE_FOR_CONFIDENCE,
    confidenceNote:
      overall.count < MIN_SAMPLE_FOR_CONFIDENCE
        ? `Only ${overall.count} entered trade${overall.count === 1 ? "" : "s"} logged — treat every number here as directional, not statistically meaningful, until you're past ${MIN_SAMPLE_FOR_CONFIDENCE}.`
        : `${overall.count} entered trades logged — enough to start taking the breakdowns seriously.`,
  };
}

module.exports = { logTrade, deleteTrade, loadTrades, getStats };
