// storage.js
//
// Resolves WHERE persistent data files live. Railway wipes the app's
// filesystem on every redeploy — which, with how often this app gets
// deployed, meant history.json was being erased constantly and nothing
// ever actually accumulated. A Railway Volume is persistent disk that
// survives redeploys; when one is attached, Railway automatically sets
// RAILWAY_VOLUME_MOUNT_PATH at runtime, and everything below lands there.
//
// Without a volume (local dev, or before you've attached one), it falls
// back to the app directory — everything still works, it just won't
// survive a redeploy. The /api/status endpoint reports which mode is
// active so it's never a mystery.

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || __dirname;
const IS_PERSISTENT = !!(process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR);

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
  console.error(`[storage] could not ensure data dir ${DATA_DIR}: ${err.message}`);
}

function dataPath(filename) {
  return path.join(DATA_DIR, filename);
}

function readJson(filename, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(filename), "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filename, data) {
  fs.writeFileSync(dataPath(filename), JSON.stringify(data, null, 2));
}

module.exports = { DATA_DIR, IS_PERSISTENT, dataPath, readJson, writeJson };
