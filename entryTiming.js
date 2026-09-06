// entryTiming.js
//
// Implements the core timing rule from the whale-squeeze strategy: shorting
// while funding is still climbing and open interest is still building means
// stepping in front of the liquidation cascade, not catching its exhaustion.
// The safer window is after funding peaks and starts to flatten/drop, OI
// stops growing, and price fails to make a new high (a "lower high").
//
// This does NOT verify that any of this is actually whale manipulation —
// same honesty standard as the rest of this app. It's a heuristic built
// from three real, checkable signals, not a confirmed mechanism.

function assessFundingTrend(fundingHistory) {
  if (!fundingHistory || !fundingHistory.rates || fundingHistory.rates.length < 2) {
    return { trend: "unknown", note: "Not enough funding rate history to assess a trend" };
  }
  const rates = fundingHistory.rates.map((r) => r.rate);
  const latest = rates[rates.length - 1];
  const previous = rates[rates.length - 2];

  if (latest > previous && latest > 0) {
    return { trend: "rising", latest, previous, note: `Funding still rising (${(previous * 100).toFixed(3)}% → ${(latest * 100).toFixed(3)}%) — momentum likely still building` };
  }
  if (latest < previous) {
    return { trend: "flipping", latest, previous, note: `Funding turning down (${(previous * 100).toFixed(3)}% → ${(latest * 100).toFixed(3)}%) — a real exhaustion signal` };
  }
  return { trend: "flat", latest, previous, note: `Funding roughly flat (${(latest * 100).toFixed(3)}%)` };
}

function assessOiTrend(oiHistory) {
  if (!oiHistory || !oiHistory.points || oiHistory.points.length < 3) {
    return { trend: "unknown", note: "Not enough open interest history to assess a trend" };
  }
  const points = oiHistory.points;
  const latest = points[points.length - 1].openInterest;
  const mid = points[Math.floor(points.length / 2)].openInterest;
  const first = points[0].openInterest;

  const stillBuilding = latest > mid && mid > first;
  const flattening = latest <= mid;

  if (stillBuilding) {
    return { trend: "building", note: "Open interest still climbing — more leveraged positions stacking in" };
  }
  if (flattening) {
    return { trend: "flattening", note: "Open interest has flattened or dropped — positions may be closing" };
  }
  return { trend: "mixed", note: "Open interest trend unclear" };
}

// Simple lower-high check: compare the peak of the most recent half of the
// candle window against the peak of the earlier half. A lower recent peak
// is the "failure to reclaim the high" pattern from the strategy doc.
function assessPriceStructure(candles) {
  if (!candles || candles.length < 6) {
    return { structure: "unknown", note: "Not enough candle history to assess price structure" };
  }
  const mid = Math.floor(candles.length / 2);
  const earlierHigh = Math.max(...candles.slice(0, mid).map((c) => c.high));
  const recentHigh = Math.max(...candles.slice(mid).map((c) => c.high));

  if (recentHigh < earlierHigh) {
    const pct = ((earlierHigh - recentHigh) / earlierHigh) * 100;
    return { structure: "lower_high", earlierHigh, recentHigh, note: `Lower high forming — recent peak is ${pct.toFixed(1)}% below the earlier peak` };
  }
  return { structure: "new_high", earlierHigh, recentHigh, note: "Price is still making new highs — no structural failure yet" };
}

// Combines all three signals into one phase label. This is a SOFT signal —
// per your call, it never blocks a setup, it just labels it clearly so you
// can judge whether it's actually time to enter or still too early.
function assessEntryTiming({ fundingHistory, oiHistory, candles }) {
  const funding = assessFundingTrend(fundingHistory);
  const oi = assessOiTrend(oiHistory);
  const structure = assessPriceStructure(candles);

  const exhaustionSignals = [
    funding.trend === "flipping",
    oi.trend === "flattening",
    structure.structure === "lower_high",
  ].filter(Boolean).length;

  const buildingSignals = [
    funding.trend === "rising",
    oi.trend === "building",
    structure.structure === "new_high",
  ].filter(Boolean).length;

  let phase, phaseLabel;
  if (exhaustionSignals >= 2) {
    phase = "flip_confirmed";
    phaseLabel = "FLIP CONFIRMED — exhaustion signals present";
  } else if (buildingSignals >= 2) {
    phase = "too_early";
    phaseLabel = "TOO EARLY — momentum still building, per your strategy this is not yet the entry window";
  } else {
    phase = "mixed";
    phaseLabel = "MIXED SIGNALS — some exhaustion, some still building";
  }

  return {
    phase,
    phaseLabel,
    funding,
    oi,
    structure,
  };
}

module.exports = { assessEntryTiming };
