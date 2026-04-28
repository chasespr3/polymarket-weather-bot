// Uses Node.js built-in sqlite (available since Node 22.5, stable in Node 23+)
// Falls back to JSON file persistence if unavailable
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const DB_PATH = path.join(process.cwd(), 'signals.db');
const JSON_PATH = path.join(process.cwd(), 'signals.json');

let db = null;
let useJson = false;

// ── SQLite via built-in node:sqlite ─────────────────────────────────────────
function tryInitSqlite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);
    db.exec(`PRAGMA journal_mode = WAL`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_id TEXT NOT NULL,
        condition_id TEXT,
        market_question TEXT,
        outcome TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        market_odds REAL,
        ev_percent REAL,
        top_traders TEXT,
        rationale TEXT,
        risk TEXT,
        telegram_sent INTEGER DEFAULT 0,
        signal_time INTEGER NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_signals_market ON signals(market_id, signal_time);
      CREATE TABLE IF NOT EXISTS markets_watched (
        market_id TEXT PRIMARY KEY,
        question TEXT,
        last_checked INTEGER,
        last_odds TEXT,
        resolved INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bot_stats (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    logger.info('SQLite (node:sqlite) initialized', { path: DB_PATH });
    return true;
  } catch (err) {
    logger.warn('node:sqlite unavailable, using JSON fallback', { error: err.message });
    return false;
  }
}

// ── JSON fallback state ──────────────────────────────────────────────────────
let jsonState = { signals: [], markets: {}, stats: {} };

function loadJson() {
  try {
    if (fs.existsSync(JSON_PATH)) {
      jsonState = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    }
  } catch { /* start fresh */ }
}

function saveJson() {
  // Keep only last 500 signals to avoid unbounded growth
  if (jsonState.signals.length > 500) {
    jsonState.signals = jsonState.signals.slice(-500);
  }
  try {
    fs.writeFileSync(JSON_PATH, JSON.stringify(jsonState, null, 2));
  } catch (err) {
    logger.warn('JSON state save failed', { error: err.message });
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
function init() {
  const ok = tryInitSqlite();
  if (!ok) {
    useJson = true;
    loadJson();
  }
}
init();

// ── Public API ───────────────────────────────────────────────────────────────
function wasRecentlySignaled(marketId, outcomeName, cooldownMs) {
  const cutoff = Date.now() - cooldownMs;
  if (!useJson) {
    const stmt = db.prepare(
      `SELECT id FROM signals WHERE market_id = ? AND outcome = ? AND signal_time > ? LIMIT 1`
    );
    return !!stmt.get(marketId, outcomeName, cutoff);
  }
  return jsonState.signals.some(
    s => s.market_id === marketId && s.outcome === outcomeName && s.signal_time > cutoff
  );
}

function saveSignal(signal) {
  const row = {
    market_id: signal.marketId,
    condition_id: signal.conditionId || null,
    market_question: signal.question,
    outcome: signal.outcome,
    confidence: signal.confidence,
    market_odds: signal.marketOdds,
    ev_percent: signal.evPercent,
    top_traders: JSON.stringify(signal.topTraders || []),
    rationale: signal.rationale,
    risk: signal.risk,
    telegram_sent: signal.telegramSent ? 1 : 0,
    signal_time: Date.now(),
  };

  if (!useJson) {
    db.prepare(`
      INSERT INTO signals
        (market_id, condition_id, market_question, outcome, confidence,
         market_odds, ev_percent, top_traders, rationale, risk, telegram_sent, signal_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.market_id, row.condition_id, row.market_question, row.outcome,
      row.confidence, row.market_odds, row.ev_percent, row.top_traders,
      row.rationale, row.risk, row.telegram_sent, row.signal_time
    );
    return;
  }
  jsonState.signals.push(row);
  saveJson();
}

function getRecentSignals(limit = 10) {
  if (!useJson) {
    return db.prepare(`SELECT * FROM signals ORDER BY signal_time DESC LIMIT ?`).all(limit);
  }
  return [...jsonState.signals].reverse().slice(0, limit);
}

function getTotalSignalCount() {
  if (!useJson) {
    return db.prepare('SELECT COUNT(*) as count FROM signals').get().count;
  }
  return jsonState.signals.length;
}

function upsertMarketWatched(marketId, question, odds) {
  if (!useJson) {
    db.prepare(`
      INSERT INTO markets_watched (market_id, question, last_checked, last_odds)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(market_id) DO UPDATE SET
        last_checked = excluded.last_checked,
        last_odds = excluded.last_odds
    `).run(marketId, question, Date.now(), JSON.stringify(odds));
    return;
  }
  jsonState.markets[marketId] = { question, last_checked: Date.now(), last_odds: odds };
  saveJson();
}

function markMarketResolved(marketId) {
  if (!useJson) {
    db.prepare(`UPDATE markets_watched SET resolved = 1 WHERE market_id = ?`).run(marketId);
    return;
  }
  if (jsonState.markets[marketId]) jsonState.markets[marketId].resolved = true;
  saveJson();
}

function setStat(key, value) {
  if (!useJson) {
    db.prepare(`INSERT INTO bot_stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, String(value));
    return;
  }
  jsonState.stats[key] = String(value);
  saveJson();
}

function getStat(key) {
  if (!useJson) {
    const row = db.prepare('SELECT value FROM bot_stats WHERE key = ?').get(key);
    return row ? row.value : null;
  }
  return jsonState.stats[key] ?? null;
}

module.exports = {
  wasRecentlySignaled,
  saveSignal,
  getRecentSignals,
  getTotalSignalCount,
  upsertMarketWatched,
  markMarketResolved,
  setStat,
  getStat,
};
