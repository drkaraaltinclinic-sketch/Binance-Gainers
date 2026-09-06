// orderBookWatcher.js
//
// Background spoofing-pattern detector: watches the order book for a small
// list of tickers continuously (not tied to any button press or browser
// tab), looking for the specific signature described in the whale-squeeze
// strategy — an unusually large order appearing, then vanishing WITHOUT a
// matching volume of trades filling it. That combination (gone, but not
// traded away) is what you'd expect from a cancelled spoof order; a wall
// that gets filled by real volume is normal market activity, not spoofing.
//
// Honesty note, same standard as the rest of this app: this is a heuristic
// built from two real, checkable signals (order book depth + trade
// volume), not a confirmed detector of manipulation. A wall can vanish for
// innocent reasons too (a market maker repricing, a bot rebalancing).
// Treat detections as "worth a manual look," not proof.

const FAPI = "https://fapi.binance.com";

async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// symbol -> { levels: [{price, qty, side}], checkedAt: ms }
const lastSnapshots = new Map();

async function fetchDepth(symbol, limit = 100) {
  const res = await fetchWithTimeout(`${FAPI}/fapi/v1/depth?symbol=${symbol}&limit=${limit}`);
  if (!res.ok) throw new Error(`depth ${res.status}`);
  const j = await res.json();
  return {
    bids: j.bids.map(([price, qty]) => ({ price, qty: parseFloat(qty) })),
    asks: j.asks.map(([price, qty]) => ({ price, qty: parseFloat(qty) })),
  };
}

// Sum traded quantity since a given time (ms) — used to check whether a
// vanished wall was actually filled by real trading or just cancelled.
async function fetchTradedVolumeSince(symbol, sinceMs) {
  const res = await fetchWithTimeout(`${FAPI}/fapi/v1/aggTrades?symbol=${symbol}&startTime=${sinceMs}&limit=1000`);
  if (!res.ok) throw new Error(`aggTrades ${res.status}`);
  const j = await res.json();
  return j.reduce((sum, t) => sum + parseFloat(t.q), 0);
}

// A level counts as "large" if it's well above the typical size of other
// levels on the same side — a robust relative measure that works
// regardless of how liquid or illiquid a given token's book normally is.
function findLargeLevels(levels, multiplier = 6) {
  if (levels.length < 5) return [];
  const qtys = levels.map((l) => l.qty).sort((a, b) => a - b);
  const median = qtys[Math.floor(qtys.length / 2)];
  if (median <= 0) return [];
  return levels.filter((l) => l.qty >= median * multiplier);
}

async function pollTicker(symbol) {
  const now = Date.now();
  let depth;
  try {
    depth = await fetchDepth(symbol);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const largeBids = findLargeLevels(depth.bids).map((l) => ({ ...l, side: "bid" }));
  const largeAsks = findLargeLevels(depth.asks).map((l) => ({ ...l, side: "ask" }));
  const currentLarge = [...largeBids, ...largeAsks];

  const prev = lastSnapshots.get(symbol);
  lastSnapshots.set(symbol, { levels: currentLarge, checkedAt: now });

  if (!prev) {
    // First poll for this ticker — nothing to compare against yet.
    return { ok: true, detections: [] };
  }

  const detections = [];
  for (const prevLevel of prev.levels) {
    const stillThere = currentLarge.find((l) => l.side === prevLevel.side && l.price === prevLevel.price);
    const shrunkOrGone = !stillThere || stillThere.qty < prevLevel.qty * 0.3;

    if (shrunkOrGone) {
      const vanishedQty = prevLevel.qty - (stillThere ? stillThere.qty : 0);
      try {
        const tradedVolume = await fetchTradedVolumeSince(symbol, prev.checkedAt);
        // If real trading volume since the wall appeared covers most of
        // what vanished, it was likely filled, not pulled — not a
        // detection. If trading volume is small relative to the vanished
        // size, that's the "gone but not traded away" spoof signature.
        if (tradedVolume < vanishedQty * 0.2) {
          detections.push({
            symbol,
            side: prevLevel.side,
            price: prevLevel.price,
            vanishedQty,
            tradedVolumeSince: tradedVolume,
            detectedAt: new Date(now).toISOString(),
          });
        }
      } catch (err) {
        // Couldn't confirm with trade data — skip rather than guess.
      }
    }
  }

  return { ok: true, detections };
}

let watcherInterval = null;
let getWatchlistFn = null;
let onDetectionFn = null;

function startWatcher({ getWatchlist, onDetection, intervalMs = 30000 }) {
  getWatchlistFn = getWatchlist;
  onDetectionFn = onDetection;
  if (watcherInterval) clearInterval(watcherInterval);

  watcherInterval = setInterval(async () => {
    const tickers = getWatchlistFn();
    for (const ticker of tickers) {
      const symbol = `${ticker.toUpperCase()}USDT`;
      const result = await pollTicker(symbol);
      if (!result.ok) {
        console.error(`[order-book-watcher] ${symbol}: ${result.reason}`);
        continue;
      }
      for (const detection of result.detections) {
        console.error(`[order-book-watcher] possible spoof: ${JSON.stringify(detection)}`);
        onDetectionFn(detection);
      }
    }
  }, intervalMs);

  console.log(`[order-book-watcher] started, polling every ${intervalMs / 1000}s`);
}

module.exports = { startWatcher, pollTicker, findLargeLevels };
