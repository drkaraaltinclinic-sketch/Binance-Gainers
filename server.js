require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const ds = require("./dataSources");
const { scoreSqueezeProbability, gateConviction } = require("./scoring");
const { generateShortSetup } = require("./tradeSetup");
const { checkWalletTransfers } = require("./walletTrace");
const { appendReport, getRecent } = require("./history");
const { sendHeraldReport, sendSpoofAlert } = require("./mailer");
const { getLlmTokenHolders } = require("./llmHolders");
const { saveWatchedWallet, addToWatchlist, removeFromWatchlist } = require("./githubWriter");
const { assessEntryTiming } = require("./entryTiming");
const { getFuturesAvailableBalance } = require("./binanceAccount");
const { DATA_DIR, IS_PERSISTENT } = require("./storage");
const { logTrade, deleteTrade, loadTrades, getStats } = require("./tradeJournal");
const { calculatePositionSizing } = require("./positionSizing");
const { startWatcher } = require("./orderBookWatcher");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 8080;
// Captured once at process start — a fresh value here means a new
// deployment actually booted, which is what lets the dashboard detect
// "the redeploy finished" without needing any Railway API access.
const SERVER_STARTED_AT = new Date().toISOString();

async function analyzeTicker(ticker, includeLlmHolders, collateral, manualUnlockData) {
  const perp = await ds.hasBinancePerp(ticker);
  if (!perp.ok || !perp.listed) {
    return {
      ticker,
      cleared: false,
      vetoes: [perp.ok ? "No live Binance perpetual for this ticker" : perp.reason],
    };
  }
  const symbol = perp.symbol;

  const [funding, oi, book, klines, tokenomics, vwap, fundingHistory, oiHistory] = await Promise.all([
    ds.getFundingRate(symbol),
    ds.getOpenInterest(symbol),
    ds.getOrderBookImbalance(symbol),
    ds.getRecentKlines(symbol, "1h", 24),
    ds.getTokenomics(ticker),
    ds.getVwapScore(ticker, "7d"),
    ds.getFundingRateHistory(symbol, 3),
    ds.getOpenInterestHistory(symbol, "1h", 6),
  ]);

  // Log every failed source to Railway's Deploy Logs, so the real reason
  // is always visible there even if the UI only shows a short summary.
  for (const [name, result] of [
    ["funding", funding],
    ["openInterest", oi],
    ["orderBook", book],
    ["klines", klines],
    ["tokenomics", tokenomics],
    ["vwap", vwap],
    ["fundingHistory", fundingHistory],
    ["oiHistory", oiHistory],
  ]) {
    if (!result.ok) console.error(`[${ticker}] ${name} unavailable: ${result.reason}`);
  }

  // Per-strategy timing check: don't treat "funding and price are rising"
  // as a reason to short harder — that's stepping in front of the squeeze,
  // not catching its exhaustion. This is a soft label, never a hard block.
  const entryTiming = assessEntryTiming({
    fundingHistory: fundingHistory.ok ? fundingHistory : null,
    oiHistory: oiHistory.ok ? oiHistory : null,
    candles: klines.ok ? klines.candles : null,
  });

  // Opt-in only — this is the slowest and only per-call-cost data source,
  // so it never fires unless explicitly requested for this scan.
  let llmHolders = null;
  if (includeLlmHolders) {
    llmHolders = await getLlmTokenHolders(ticker);
    if (!llmHolders.ok) console.error(`[${ticker}] llmHolders unavailable: ${llmHolders.reason}`);
  }

  const atr = klines.ok ? ds.computeATR(klines.candles) : null;
  const priceChange24hPct =
    klines.ok && klines.candles.length > 1
      ? ((klines.candles[klines.candles.length - 1].close - klines.candles[0].close) /
          klines.candles[0].close) *
        100
      : null;

  const squeeze = scoreSqueezeProbability({
    fundingRate: funding.ok ? funding.fundingRate : null,
    imbalance: book.ok ? book.imbalance : null,
    priceChange24hPct,
    vwapScore: vwap.ok ? vwap.score : null,
  });

  const gate = gateConviction({
    squeezeScore: squeeze.score,
    perpListed: true,
    tokenomicsOk: tokenomics.ok,
    tokenomicsReason: tokenomics.ok ? null : tokenomics.reason,
  });
  if (gate.notes && gate.notes.length) {
    squeeze.notes = [...(squeeze.notes || []), ...gate.notes];
  }

  const walletTrace = await checkWalletTransfers(ticker);

  if (!gate.cleared) {
    return {
      ticker,
      cleared: false,
      vetoes: gate.vetoes,
      squeeze,
      entryTiming,
      tokenomics,
      vwap: vwap.ok ? vwap : null,
      walletTrace,
      llmHolders, // pass through as-is (success, failure+reason, or null if not requested)
      manualUnlockData,
    };
  }

  const markPrice = funding.ok ? funding.markPrice : tokenomics.ok ? tokenomics.price : null;
  const setup = generateShortSetup({ markPrice, atr, squeezeScore: squeeze.score });

  let positionSizing = null;
  if (setup && collateral) {
    positionSizing = calculatePositionSizing({
      collateral,
      marketCap: tokenomics.ok ? tokenomics.marketCap : null,
    });
    if (positionSizing.ok) {
      // Attach an exact USDT amount to each tranche, split by its existing
      // percentage — this is what turns "45% / 55%" into real dollar sizes.
      setup.entries = setup.entries.map((e) => ({
        ...e,
        sizeUsdt: +((positionSizing.maxPositionSize * e.sizePct) / 100).toFixed(2),
      }));
    }
  }

  return {
    ticker,
    symbol,
    cleared: !!setup,
    vetoes: setup ? [] : ["Insufficient price/ATR data to size a setup"],
    squeeze,
    entryTiming,
    tokenomics: tokenomics.ok ? tokenomics : null,
    tvl: null,
    funding: funding.ok ? funding : null,
    orderBook: book.ok ? book : null,
    vwap: vwap.ok ? vwap : null,
    walletTrace,
    llmHolders, // pass through as-is (success, failure+reason, or null if not requested)
    manualUnlockData,
    positionSizing,
    atr, // exposed so /api/live can recompute tranches from a fresh price without re-fetching klines
    priceChange24hPct,
    setup,
  };
}

app.get("/api/status", (req, res) => {
  res.json({
    agent: "BINANCE GAINERS",
    status: "online",
    startedAt: SERVER_STARTED_AT,
    storage: { dataDir: DATA_DIR, persistent: IS_PERSISTENT },
    configured: {
      dropstab: !!process.env.DROPSTAB_API_KEY,
      etherscan: !!process.env.ETHERSCAN_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      moralis: !!process.env.MORALIS_API_KEY,
      github: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO),
      binanceAccount: !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET),
      herald: !!(process.env.HERALD_GMAIL_USER && process.env.HERALD_GMAIL_APP_PASSWORD),
    },
  });
});

app.post("/api/scan", async (req, res) => {
  try {
    const tickers = (req.body.tickers || [])
      .map((t) => String(t).trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 3);

    if (tickers.length === 0) {
      return res.status(400).json({
        error:
          "No tickers provided. Check tokenomist.ai's free unlock calendar for tomorrow's unlocks, then enter up to 3 tickers.",
      });
    }

    const includeLlmHolders = !!req.body.includeLlmHolders;
    const manualUnlockData = req.body.manualUnlockData || null;

    let collateral = req.body.collateral ? Number(req.body.collateral) : null;
    let collateralSource = collateral ? "manual" : null;
    let balanceFetchError = null;

    if (!collateral) {
      const balance = await getFuturesAvailableBalance();
      if (balance.ok) {
        collateral = balance.availableBalance;
        collateralSource = "binance-auto";
      } else {
        balanceFetchError = balance.reason;
      }
    }

    const tokens = await Promise.all(
      tickers.map((t) => {
        const applies = manualUnlockData && manualUnlockData.ticker === t ? manualUnlockData : null;
        return analyzeTicker(t, includeLlmHolders, collateral, applies);
      })
    );

    const report = {
      generatedAt: new Date().toISOString(),
      tokens,
    };

    const saved = appendReport(report);

    let heraldResult = { ok: false, reason: "not requested" };
    if (req.body.sendHerald) {
      heraldResult = await sendHeraldReport(report);
      if (!heraldResult.ok) {
        console.error(`[herald] send failed: ${heraldResult.reason}`);
      }
    }

    res.json({
      report: saved,
      herald: heraldResult,
      collateralInfo: { collateral, source: collateralSource, autoFetchError: balanceFetchError },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/unlocks", async (req, res) => {
  try {
    const unlocks = await ds.getUpcomingUnlocks(48);
    if (!unlocks.ok) {
      return res.json({ ok: false, reason: unlocks.reason, suggestions: [] });
    }

    // Cross-check each upcoming unlock against a live Binance perp, and
    // return the first 3 that actually have one.
    const suggestions = [];
    for (const event of unlocks.events) {
      if (suggestions.length >= 3) break;
      const perp = await ds.hasBinancePerp(event.ticker);
      if (perp.ok && perp.listed) {
        suggestions.push({ ticker: event.ticker, date: event.dateStr, percentage: event.percentage });
      }
    }

    res.json({ ok: true, suggestions, totalUnlocksSeen: unlocks.totalEventsSeen });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message, suggestions: [] });
  }
});

app.post("/api/save-watched-wallet", async (req, res) => {
  try {
    const { ticker, chainId, address } = req.body;
    if (!ticker || !chainId || !address) {
      return res.status(400).json({ ok: false, reason: "ticker, chainId, and address are all required" });
    }
    const result = await saveWatchedWallet({ ticker: String(ticker), chainId: Number(chainId), address: String(address) });
    if (!result.ok) console.error(`[github-writer] save failed for ${ticker}: ${result.reason}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

// Lightweight, fast endpoint for live-tracking one ticker right before you
// act on it — only touches mark price, funding, and order book (the fields
// that actually move second to second). Deliberately skips tokenomics,
// holders, wallet trace, VWAP — those don't change fast enough to justify
// re-fetching on a tight polling loop, and doing so would just slow this
// down for no benefit. Recomputes the trade setup fresh off the live price
// using the SAME generateShortSetup logic as a full scan, so the numbers
// you see live are produced the identical way, just off fresher inputs.
app.get("/api/live", async (req, res) => {
  try {
    const ticker = String(req.query.ticker || "").trim().toUpperCase();
    const atr = req.query.atr ? Number(req.query.atr) : null;
    const priceChange24hPct = req.query.priceChange24hPct ? Number(req.query.priceChange24hPct) : null;
    if (!ticker) return res.status(400).json({ ok: false, reason: "ticker is required" });
    if (!atr) return res.status(400).json({ ok: false, reason: "atr is required (from a prior full scan)" });

    const perp = await ds.hasBinancePerp(ticker);
    if (!perp.ok || !perp.listed) {
      return res.json({ ok: false, reason: perp.ok ? "No live Binance perpetual for this ticker" : perp.reason });
    }

    const [funding, book] = await Promise.all([
      ds.getFundingRate(perp.symbol),
      ds.getOrderBookImbalance(perp.symbol),
    ]);

    if (!funding.ok) return res.json({ ok: false, reason: `funding unavailable: ${funding.reason}` });

    const squeeze = scoreSqueezeProbability({
      fundingRate: funding.fundingRate,
      imbalance: book.ok ? book.imbalance : null,
      priceChange24hPct,
      vwapScore: null,
    });
    const setup = generateShortSetup({ markPrice: funding.markPrice, atr, squeezeScore: squeeze.score });

    res.json({
      ok: true,
      ticker,
      markPrice: funding.markPrice,
      fundingRate: funding.fundingRate,
      imbalance: book.ok ? book.imbalance : null,
      squeeze,
      setup,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

app.get("/api/gainers", async (req, res) => {
  try {
    // Return the top 10 so you can see the whole leaderboard — the
    // dashboard auto-fills only the top 3 into the ticker boxes, but
    // shows all 10 in the note, so a token at #4-#10 isn't invisible.
    const result = await ds.getTopGainers(10);
    if (!result.ok) {
      return res.json({ ok: false, reason: result.reason, suggestions: [] });
    }
    const suggestions = result.gainers.map((g) => ({
      ticker: g.ticker,
      priceChangePercent: g.priceChangePercent,
      openPrice: g.openPrice,
      lastPrice: g.lastPrice,
      quoteVolume: g.quoteVolume,
      utcDayOpen: g.utcDayOpen,
      utcDayChangePercent: g.utcDayChangePercent,
    }));
    res.json({ ok: true, suggestions, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message, suggestions: [] });
  }
});

app.get("/api/history", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  res.json(getRecent(limit));
});

// ── Trade journal ───────────────────────────────────────────────────
app.get("/api/trades", (req, res) => {
  res.json({ ok: true, trades: loadTrades(), stats: getStats() });
});

app.post("/api/trades", (req, res) => {
  try {
    if (!req.body.ticker) return res.status(400).json({ ok: false, reason: "ticker is required" });
    const record = logTrade(req.body);
    res.json({ ok: true, trade: record, stats: getStats() });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

app.delete("/api/trades/:id", (req, res) => {
  try {
    const result = deleteTrade(req.params.id);
    res.json({ ok: true, ...result, stats: getStats() });
  } catch (err) {
    res.status(500).json({ ok: false, reason: err.message });
  }
});

// ── Order book spoof watchlist ──────────────────────────────────────
// In-memory set for immediate effect (the running watcher reads this
// directly), backed by watchlist.json on GitHub for persistence across
// deploys. Loaded once at boot from the file already in the deployed repo
// snapshot — no GitHub API call needed just to read it.
let currentWatchlist = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, "watchlist.json"), "utf8");
  const parsed = JSON.parse(raw);
  currentWatchlist = Array.isArray(parsed.tickers) ? parsed.tickers : [];
  console.log(`[watchlist] loaded at boot: ${JSON.stringify(currentWatchlist)}`);
} catch (err) {
  console.error(`[watchlist] failed to load watchlist.json at boot: ${err.message}`);
}

app.get("/api/watchlist", (req, res) => {
  res.json({ ok: true, tickers: currentWatchlist });
});

app.post("/api/watchlist/add", async (req, res) => {
  const ticker = String(req.body.ticker || "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ ok: false, reason: "ticker is required" });

  if (!currentWatchlist.includes(ticker)) currentWatchlist.push(ticker);

  const result = await addToWatchlist(ticker);
  if (!result.ok) console.error(`[watchlist] GitHub persist failed for add ${ticker}: ${result.reason}`);
  res.json({ ok: true, tickers: currentWatchlist, persisted: result.ok, persistReason: result.ok ? null : result.reason });
});

app.post("/api/watchlist/remove", async (req, res) => {
  const ticker = String(req.body.ticker || "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ ok: false, reason: "ticker is required" });

  currentWatchlist = currentWatchlist.filter((t) => t !== ticker);

  const result = await removeFromWatchlist(ticker);
  if (!result.ok) console.error(`[watchlist] GitHub persist failed for remove ${ticker}: ${result.reason}`);
  res.json({ ok: true, tickers: currentWatchlist, persisted: result.ok, persistReason: result.ok ? null : result.reason });
});

startWatcher({
  getWatchlist: () => currentWatchlist,
  onDetection: async (detection) => {
    const result = await sendSpoofAlert(detection);
    if (!result.ok) console.error(`[order-book-watcher] alert email failed: ${result.reason}`);
  },
  intervalMs: 30000,
});

app.listen(PORT, () => {
  console.log(`BINANCE GAINERS listening on port ${PORT}`);
});
