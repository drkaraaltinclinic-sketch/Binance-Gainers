// githubWriter.js
//
// Generic "safely update a JSON file on GitHub" utility. Reads the file,
// hands the parsed object to a merge function that mutates it as real
// JavaScript (never as text), then commits the result back — which CANNOT
// produce invalid JSON, unlike a human hand-editing raw text (which broke
// known-exchange-wallets.json three separate times before this existed).
//
// Needs a GitHub Personal Access Token with write access — see README for
// how to create one scoped as narrowly as possible (just this repo,
// just Contents read/write).

const GITHUB_API = "https://api.github.com";

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getConfig() {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!token || !owner || !repo) {
    return { ok: false, reason: "GITHUB_TOKEN, GITHUB_OWNER, or GITHUB_REPO not set" };
  }
  return { ok: true, token, owner, repo };
}

// mergeFn receives the current parsed JSON (or {} if the file doesn't
// parse) and must return the updated object to write back.
async function updateGithubJsonFile(filePath, mergeFn, commitMessage) {
  const cfg = getConfig();
  if (!cfg.ok) return cfg;

  const { token, owner, repo } = cfg;
  const apiUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let currentSha, currentData;
  try {
    const getRes = await fetchWithTimeout(apiUrl, { headers });
    if (!getRes.ok) {
      const body = await getRes.text().catch(() => "");
      return { ok: false, reason: `GitHub GET ${getRes.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    const getData = await getRes.json();
    currentSha = getData.sha;
    const decoded = Buffer.from(getData.content, "base64").toString("utf8");
    currentData = JSON.parse(decoded);
  } catch (err) {
    return { ok: false, reason: `Failed to fetch/parse ${filePath}: ${err.message}` };
  }

  const updatedData = mergeFn(currentData);
  const newContent = JSON.stringify(updatedData, null, 2) + "\n";
  const newContentBase64 = Buffer.from(newContent, "utf8").toString("base64");

  try {
    const putRes = await fetchWithTimeout(apiUrl, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ message: commitMessage, content: newContentBase64, sha: currentSha }),
    });
    if (!putRes.ok) {
      const body = await putRes.text().catch(() => "");
      return { ok: false, reason: `GitHub PUT ${putRes.status}${body ? `: ${body.slice(0, 200)}` : ""}` };
    }
    return { ok: true, data: updatedData };
  } catch (err) {
    return { ok: false, reason: `Failed to commit update: ${err.message}` };
  }
}

async function saveWatchedWallet({ ticker, chainId, address }) {
  const tickerKey = ticker.toUpperCase();
  return updateGithubJsonFile(
    "known-exchange-wallets.json",
    (config) => {
      if (!config.watchedWallets) config.watchedWallets = {};
      const existing = config.watchedWallets[tickerKey];
      if (existing && Array.isArray(existing.addresses)) {
        if (!existing.addresses.includes(address)) existing.addresses.push(address);
        if (!existing.chainId) existing.chainId = chainId;
      } else {
        config.watchedWallets[tickerKey] = { chainId, addresses: [address] };
      }
      return config;
    },
    `Add watched wallet for ${tickerKey} (via BINANCE GAINERS dashboard)`
  );
}

async function addToWatchlist(ticker) {
  const tickerKey = ticker.toUpperCase();
  return updateGithubJsonFile(
    "watchlist.json",
    (config) => {
      if (!Array.isArray(config.tickers)) config.tickers = [];
      if (!config.tickers.includes(tickerKey)) config.tickers.push(tickerKey);
      return config;
    },
    `Add ${tickerKey} to order book spoof watchlist`
  );
}

async function removeFromWatchlist(ticker) {
  const tickerKey = ticker.toUpperCase();
  return updateGithubJsonFile(
    "watchlist.json",
    (config) => {
      config.tickers = (config.tickers || []).filter((t) => t !== tickerKey);
      return config;
    },
    `Remove ${tickerKey} from order book spoof watchlist`
  );
}

module.exports = { saveWatchedWallet, addToWatchlist, removeFromWatchlist, updateGithubJsonFile };
