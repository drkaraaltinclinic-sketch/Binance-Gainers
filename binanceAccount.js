// binanceAccount.js
//
// Auto-fetches your real Binance futures balance so the position-sizing
// calculator can run without you typing a collateral number in every
// scan. This is a READ-ONLY signed request — it queries your account
// balance, nothing else. It does not, and will never, place, modify, or
// cancel any order. That boundary doesn't move regardless of what
// permissions the API key itself has.
//
// Needs BINANCE_API_KEY and BINANCE_API_SECRET — an "Enable Reading"-only
// key is all this requires; trading/withdrawal permissions are never
// needed for this feature and should stay off the key regardless.

const crypto = require("crypto");
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

function sign(queryString, secret) {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

async function getFuturesAvailableBalance() {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    return { ok: false, reason: "BINANCE_API_KEY or BINANCE_API_SECRET not set" };
  }

  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}&recvWindow=5000`;
  const signature = sign(queryString, apiSecret);
  const url = `${FAPI}/fapi/v3/balance?${queryString}&signature=${signature}`;

  try {
    const res = await fetchWithTimeout(url, { headers: { "X-MBX-APIKEY": apiKey } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `Binance ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const data = await res.json();
    const usdt = Array.isArray(data) ? data.find((a) => a.asset === "USDT") : null;
    if (!usdt) return { ok: false, reason: "No USDT balance entry found in account" };

    return {
      ok: true,
      availableBalance: parseFloat(usdt.availableBalance),
      walletBalance: parseFloat(usdt.balance),
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { getFuturesAvailableBalance };
