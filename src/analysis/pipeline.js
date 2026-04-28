const { config } = require('../config');
const logger = require('../utils/logger');
const polymarket = require('../services/polymarket');
const { analyzeMarket, extractLocation } = require('../services/claude');
const telegram = require('../services/telegram');
const { evaluateSignal } = require('./signals');
const { checkPendingSignals } = require('./pnl');
const db = require('../storage/db');

// Process a batch of markets in parallel (capped at 5 concurrent)
async function processMarketBatch(markets) {
  const CONCURRENCY = 5;
  const signals = [];

  for (let i = 0; i < markets.length; i += CONCURRENCY) {
    const batch = markets.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(processMarket));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) signals.push(r.value);
    }
  }
  return signals;
}

async function processMarket(market) {
  const location = extractLocation(market.question);

  // Trader fetch runs in parallel; weather is fetched inside analyzeMarket (cached)
  const [tradersResult, analysis] = await Promise.allSettled([
    polymarket.fetchMarketTraders(market.conditionId, market.id),
    analyzeMarket({ market, location }),
  ]);

  const traders = tradersResult.status === 'fulfilled' ? tradersResult.value : [];
  const result = analysis.status === 'fulfilled' ? analysis.value : null;

  if (!result) {
    logger.debug(`[SCORE] ${market.question.slice(0, 70)} — skipped (not a supported market type)`);
    return null;
  }

  const signal = evaluateSignal({ market, analysis: result, traders });
  const ev = signal ? `EV +${signal.evPercent.toFixed(1)}%` : 'no edge';
  const tag = signal?.meetsAlertThreshold ? ' *** ALERT ***' : '';
  logger.info(`[SCORE] ${market.question.slice(0, 70)} | confidence=${result.confidence}% outcome="${result.recommended_outcome}" ${ev}${tag}`);

  return signal;
}

// Main pipeline: run one full scan cycle
async function runScanCycle(stats) {
  const cycleStart = Date.now();
  logger.info('Starting scan cycle', { cycle: stats.cycles + 1 });

  // 1. Fetch all weather markets
  let rawMarkets;
  try {
    rawMarkets = await polymarket.fetchWeatherMarkets();
  } catch (err) {
    logger.error('Market fetch failed', { error: err.message });
    return;
  }

  // 2. Normalize and filter by liquidity/volume
  const allMarkets = rawMarkets
    .map(polymarket.normalizeMarket)
    .filter(m => !m.resolved && m.liquidity >= config.MIN_LIQUIDITY_USD && m.volume24h >= config.MIN_VOLUME_USD);

  // Prioritize daily temperature markets first, shuffle the rest for variety
  const isTempMarket = m => /highest|lowest\s+(temperature|temp)/i.test(m.question);
  const tempMarkets = allMarkets.filter(isTempMarket);
  const otherMarkets = allMarkets.filter(m => !isTempMarket(m)).sort(() => Math.random() - 0.5);
  const markets = [...tempMarkets, ...otherMarkets].slice(0, config.MAX_MARKETS_PER_CYCLE);

  stats.marketsScanned += markets.length;
  logger.info(`Analyzing ${markets.length} qualifying weather markets`);

  if (markets.length === 0) {
    logger.info('No qualifying markets found this cycle');
    stats.cycles++;
    return;
  }

  // Track markets in DB
  for (const m of markets) {
    db.upsertMarketWatched(m.id, m.question, m.outcomes.map(o => o.price));
  }

  // 3. Analyze markets and collect signals
  const signals = await processMarketBatch(markets);

  // 4. Send alerts for high-confidence signals
  let alertsSentThisCycle = 0;
  for (const signal of signals) {
    if (!signal || !signal.meetsAlertThreshold) continue;

    if (db.wasRecentlySignaled(signal.market.id, signal.outcome, config.SIGNAL_COOLDOWN_MS)) {
      logger.debug('Skipping duplicate signal', { marketId: signal.market.id, outcome: signal.outcome });
      continue;
    }

    logger.info('Signal meets alert threshold', {
      market: signal.market.question.slice(0, 60),
      outcome: signal.outcome,
      confidence: signal.confidence,
      ev: signal.evPercent.toFixed(1),
    });

    const sent = await telegram.sendSignal(signal);
    db.saveSignal({
      marketId: signal.market.id,
      conditionId: signal.market.conditionId,
      question: signal.market.question,
      outcome: signal.outcome,
      confidence: signal.confidence,
      marketOdds: signal.marketOdds,
      evPercent: signal.evPercent,
      topTraders: signal.topTraders,
      rationale: signal.rationale,
      risk: signal.risk,
      telegramSent: sent,
      endDate: signal.market.endDate || null,
      outcomeOdds: signal.marketOdds,
    });

    if (sent) { stats.signalsSent++; alertsSentThisCycle++; }
  }

  // 5. Settle any pending signals whose markets have now resolved
  await checkPendingSignals().catch(err =>
    logger.warn('P&L check error', { error: err.message })
  );

  stats.cycles++;
  stats.lastCycle = new Date().toISOString();
  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  logger.info(`Cycle complete`, { elapsed: `${elapsed}s`, marketsAnalyzed: markets.length, alertsSent: alertsSentThisCycle });
}

module.exports = { runScanCycle };
