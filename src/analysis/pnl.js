const axios = require('axios');
const { config } = require('../config');
const db = require('../storage/db');
const logger = require('../utils/logger');

// Minimum price threshold to treat an outcome as the winner when the market
// hasn't been officially closed yet (UMA dispute window causes lag).
const PRICE_SETTLE_THRESHOLD = 0.95;
// Threshold for an officially-closed market (should be 1.0, but allow rounding).
const OFFICIAL_SETTLE_THRESHOLD = 0.99;

async function checkPendingSignals() {
  const pending = db.getPendingSignals();

  logger.info(`[PNL] Checking ${pending.length} pending signal(s) for resolution`);
  if (pending.length === 0) return;

  let settled = 0;
  let skippedNotDue = 0;
  let skippedNotClosed = 0;

  for (const signal of pending) {
    // ── 1. Grace-period gate: only check after end_date + 2 h ────────────────
    if (signal.end_date) {
      const endMs = new Date(signal.end_date).getTime();
      if (isNaN(endMs)) {
        logger.warn(`[PNL] Signal ${signal.id} has unparseable end_date: "${signal.end_date}"`);
      } else if (Date.now() < endMs + 2 * 60 * 60 * 1000) {
        skippedNotDue++;
        continue;
      }
    }

    // ── 2. Fetch market from Gamma API ────────────────────────────────────────
    let data;
    try {
      const res = await axios.get(
        `${config.POLYMARKET_GAMMA_URL}/markets/${signal.market_id}`,
        { timeout: 10000 }
      );
      data = res.data;
    } catch (err) {
      logger.warn(`[PNL] API fetch failed for market ${signal.market_id}: ${err.message}`);
      continue;
    }

    if (!data) {
      logger.warn(`[PNL] Empty response for market ${signal.market_id}`);
      continue;
    }

    const endDatePassed = signal.end_date
      ? Date.now() > new Date(signal.end_date).getTime()
      : true;

    const officialClose = data.closed === true || data.resolved === true;

    // ── 3. Determine winner from outcome prices ───────────────────────────────
    const outcomes = parseJsonField(data.outcomes);
    const prices   = parseJsonField(data.outcomePrices || data.prices);

    logger.info(
      `[PNL] Market ${signal.market_id} | ` +
      `active=${data.active} closed=${data.closed} resolved=${data.resolved} | ` +
      `end_date=${signal.end_date} end_passed=${endDatePassed} | ` +
      `prices=${JSON.stringify(prices)}`
    );

    // Find the highest-priced outcome
    let winnerIdx = -1;
    let maxPrice = 0;
    for (let i = 0; i < prices.length; i++) {
      const p = parseFloat(prices[i] || 0);
      if (p > maxPrice) { maxPrice = p; winnerIdx = i; }
    }

    // Require a stricter threshold for official closes, looser for price-based
    const threshold = officialClose ? OFFICIAL_SETTLE_THRESHOLD : PRICE_SETTLE_THRESHOLD;
    const canSettle = officialClose || (endDatePassed && maxPrice >= PRICE_SETTLE_THRESHOLD);

    if (!canSettle || winnerIdx < 0 || maxPrice < threshold) {
      skippedNotClosed++;
      logger.info(
        `[PNL] Signal ${signal.id} not ready — officialClose=${officialClose} ` +
        `maxPrice=${maxPrice.toFixed(4)} threshold=${threshold} endPassed=${endDatePassed}`
      );
      continue;
    }

    const winnerName = outcomes[winnerIdx];
    logger.info(
      `[PNL] Settling signal ${signal.id} | ` +
      `winner="${winnerName}" (${(maxPrice * 100).toFixed(1)}%) | ` +
      `bot_bet="${signal.outcome}" | ` +
      `method=${officialClose ? 'official' : 'price-based'}`
    );

    // ── 4. Calculate P&L and write to DB ─────────────────────────────────────
    const won  = winnerName.toLowerCase() === signal.outcome.toLowerCase();
    const odds = signal.outcome_odds || signal.market_odds || 0.5;
    // Profit = (shares bought) × $1 payout − cost; shares = MAX_BET / odds
    const pnl  = won
      ? parseFloat((config.MAX_BET_SIZE * (1 / odds - 1)).toFixed(2))
      : -config.MAX_BET_SIZE;

    db.updateSignalResult(signal.id, { won, pnl });

    logger.info(
      `[PNL] ✓ Settled | ${won ? `WON  +$${pnl}` : `LOST -$${config.MAX_BET_SIZE}`} | ` +
      `"${(signal.market_question || '').slice(0, 55)}"`
    );
    settled++;
  }

  logger.info(
    `[PNL] Done — settled=${settled} skipped_not_due=${skippedNotDue} skipped_not_closed=${skippedNotClosed}`
  );
}

function parseJsonField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return []; } }
  return [];
}

module.exports = { checkPendingSignals };
