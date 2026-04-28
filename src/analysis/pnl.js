const axios = require('axios');
const { config } = require('../config');
const db = require('../storage/db');
const logger = require('../utils/logger');

// Check all unresolved signals whose end date has passed and settle them
async function checkPendingSignals() {
  const pending = db.getPendingSignals();
  if (pending.length === 0) return;

  logger.info(`Checking ${pending.length} pending signal(s) for resolution`);
  let settled = 0;

  for (const signal of pending) {
    // Only attempt once the market end date has passed (+ 2h grace period)
    if (signal.end_date) {
      const endMs = new Date(signal.end_date).getTime();
      if (isNaN(endMs) || Date.now() < endMs + 2 * 60 * 60 * 1000) continue;
    }

    try {
      const { data } = await axios.get(
        `${config.POLYMARKET_GAMMA_URL}/markets/${signal.market_id}`,
        { timeout: 10000 }
      );
      if (!data) continue;

      const isClosed = data.closed === true || data.resolved === true;
      if (!isClosed) continue;

      // Winning outcome is the one whose price settled at 1.0
      const outcomes = parseJsonField(data.outcomes);
      const prices = parseJsonField(data.outcomePrices || data.prices);
      let winnerName = null;
      for (let i = 0; i < outcomes.length; i++) {
        if (parseFloat(prices[i] || 0) >= 0.99) { winnerName = outcomes[i]; break; }
      }
      if (!winnerName) continue;

      const won = winnerName.toLowerCase() === signal.outcome.toLowerCase();
      const odds = signal.outcome_odds || signal.market_odds || 0.5;
      // Profit = shares bought × $1 payout − cost; shares = MAX_BET / odds
      const pnl = won
        ? parseFloat((config.MAX_BET_SIZE * (1 / odds - 1)).toFixed(2))
        : -config.MAX_BET_SIZE;

      db.updateSignalResult(signal.id, { won, pnl });
      logger.info(
        `Signal settled | ${won ? `WON +$${pnl}` : `LOST -$${config.MAX_BET_SIZE}`}`,
        { market: (signal.market_question || '').slice(0, 60), outcome: signal.outcome }
      );
      settled++;
    } catch (err) {
      logger.debug('Resolution check failed', { id: signal.id, error: err.message });
    }
  }

  if (settled > 0) logger.info(`Settled ${settled} signal(s) this cycle`);
}

function parseJsonField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return []; } }
  return [];
}

module.exports = { checkPendingSignals };
