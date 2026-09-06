// positionSizing.js
//
// Implements the over-collateralization sizing formula: given your total
// available collateral and a target Safety Multiplier (S — how far price
// would need to move against you before liquidation), computes the max
// position size that keeps you at that safety level.
//
// Position Size (USDT) = C / (S × (1 + MMR) - 1)
//
// IMPORTANT — this is a catastrophic tail-risk buffer, not your primary
// exit plan. Your stop-loss should trigger long before price gets anywhere
// near the liquidation price this calculates. Treat this as "how do I
// survive a huge adverse move without being liquidated," not "when do I
// exit" — that's what the existing stop-loss is for.
//
// MMR (Maintenance Margin Rate) is NOT fetched live per-symbol — Binance's
// exact bracket schedule requires signed/authenticated API access this app
// doesn't use elsewhere. A configurable default is used instead (0.05,
// matching the strategy doc's guidance for volatile altcoins). For very
// large position sizes, MMR increases at higher notional tiers — check
// Binance's actual bracket for your position size if you're sizing up big.

const DEFAULT_MMR = 0.05;

// Market-cap tiering from the strategy doc (S≥5 micro-cap, S≥3 mid-cap).
// The exact breakpoints between those two anchors, and anything above
// $500M, are my own reasonable interpolation, not from the doc — override
// with your own number if you don't agree with these specific cutoffs.
function tierSafetyMultiplier(marketCap) {
  if (marketCap == null) return { S: 5, tier: "unknown (defaulting to most conservative)" };
  if (marketCap < 100_000_000) return { S: 5, tier: "micro-cap (<$100M)" };
  if (marketCap < 200_000_000) return { S: 4, tier: "small-cap ($100M–$200M)" };
  if (marketCap < 500_000_000) return { S: 3, tier: "mid-cap ($200M–$500M)" };
  return { S: 2.5, tier: "large-cap (>$500M)" };
}

function calculatePositionSizing({ collateral, marketCap, mmr, safetyMultiplierOverride }) {
  if (!collateral || collateral <= 0) {
    return { ok: false, reason: "No collateral amount provided" };
  }

  const usedMmr = mmr != null ? mmr : DEFAULT_MMR;
  const tiered = tierSafetyMultiplier(marketCap);
  const S = safetyMultiplierOverride != null ? safetyMultiplierOverride : tiered.S;

  const denominator = S * (1 + usedMmr) - 1;
  if (denominator <= 0) {
    return { ok: false, reason: `Safety multiplier ${S} with MMR ${usedMmr} produces an invalid (non-positive) denominator — S needs to be higher` };
  }

  const maxPositionSize = collateral / denominator;

  return {
    ok: true,
    collateral,
    S,
    tier: tiered.tier,
    mmr: usedMmr,
    maxPositionSize,
  };
}

module.exports = { calculatePositionSizing, tierSafetyMultiplier, DEFAULT_MMR };
