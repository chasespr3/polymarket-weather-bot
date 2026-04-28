const { config } = require('../config');

// Calculate expected value as a percentage
// EV% = (confidence * profit_per_share) - ((1 - confidence) * cost_per_share)
// All normalized to a $1 share
function calculateEV(confidence, marketPrice) {
  const conf = confidence / 100;
  const profit = 1.0 - marketPrice;   // profit if correct ($1 payout - cost)
  const loss = marketPrice;            // loss if wrong (cost of share)
  const ev = conf * profit - (1 - conf) * loss;
  return (ev / marketPrice) * 100;     // as % of capital deployed
}

// Find the best outcome in a market given Claude's recommendation
function findRecommendedOutcome(market, recommendedOutcomeName) {
  return market.outcomes.find(
    o => o.name.toLowerCase() === recommendedOutcomeName?.toLowerCase()
  ) || market.outcomes[0];
}

// Determine the aggregate trader position (which outcome do top traders prefer?)
function aggregateTraderPosition(traders, outcomes) {
  if (!traders || traders.length === 0) return null;
  const counts = {};
  for (const outcome of outcomes) {
    counts[outcome.name.toLowerCase()] = 0;
  }
  for (const trader of traders) {
    if (!trader.position) continue;
    const key = trader.position.toLowerCase();
    if (counts[key] !== undefined) counts[key]++;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || null;
}

// Core signal evaluation — returns a signal object or null
function evaluateSignal({ market, analysis, traders }) {
  if (!analysis) return null;

  const { confidence, recommended_outcome, rationale, risk,
          weather_analysis, news_analysis, trader_alignment } = analysis;

  // Find the outcome Claude recommends
  const recommendedOutcome = findRecommendedOutcome(market, recommended_outcome);
  if (!recommendedOutcome) return null;

  const marketOdds = recommendedOutcome.price;

  // Skip if market odds and bot confidence are too close (no edge)
  if (Math.abs(confidence - marketOdds * 100) < 5) return null;

  // EV must be positive and bot must have higher confidence than market
  if (confidence <= marketOdds * 100) return null;

  const evPercent = calculateEV(confidence, marketOdds);
  if (evPercent <= 0) return null;

  // Liquidity and volume gates
  if (market.liquidity < config.MIN_LIQUIDITY_USD) return null;
  if (market.volume24h < config.MIN_VOLUME_USD) return null;

  // Internal confidence gate
  if (confidence < config.MIN_CONFIDENCE_SCORE) return null;

  // Top trader alignment check
  const traderTopOutcome = aggregateTraderPosition(traders, market.outcomes);
  const tradersAgree = !traderTopOutcome ||
    traderTopOutcome === recommended_outcome?.toLowerCase();

  return {
    market,
    outcome: recommended_outcome,
    confidence,
    marketOdds,
    evPercent,
    rationale,
    risk,
    weatherAnalysis: weather_analysis,
    newsAnalysis: news_analysis,
    traderAlignment: trader_alignment,
    tradersAgree,
    topTraders: traders.filter(t => t.winRate > 0).slice(0, 5),
    meetsAlertThreshold: confidence >= config.SIGNAL_CONFIDENCE_FOR_ALERT,
  };
}

module.exports = { evaluateSignal, calculateEV };
