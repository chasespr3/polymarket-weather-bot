const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const { config } = require('../config');
const logger = require('../utils/logger');
const cache = require('../utils/cache');

const gammaClient = axios.create({ baseURL: config.POLYMARKET_GAMMA_URL, timeout: 15000 });
const clobClient = axios.create({ baseURL: config.POLYMARKET_CLOB_URL, timeout: 15000 });
const dataClient = axios.create({ baseURL: config.POLYMARKET_DATA_URL, timeout: 15000 });

for (const client of [gammaClient, clobClient, dataClient]) {
  axiosRetry(client, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (err) => axiosRetry.isNetworkOrIdempotentRequestError(err) || err.response?.status >= 500,
  });
  if (config.POLYMARKET_API_KEY) {
    client.defaults.headers.common['Authorization'] = `Bearer ${config.POLYMARKET_API_KEY}`;
  }
}

// Fetch all active weather markets via the dedicated weather category tag.
// Primary path: GET /events?tag_slug=weather — the same source as polymarket.com/weather.
// Each event embeds its child markets directly, so one paginated events call
// replaces the previous full-market scan + keyword filter.
async function fetchWeatherMarkets() {
  const cacheKey = 'weather_markets';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let markets = await fetchFromWeatherCategory();

  // Fallback: if the category endpoint returns nothing (e.g. API change),
  // revert to scanning all markets with keyword filtering.
  if (markets.length === 0) {
    logger.warn('Weather category returned 0 markets, falling back to keyword scan');
    markets = await fetchByKeywordScan();
  }

  logger.info(`Found ${markets.length} weather markets on Polymarket`);
  cache.set(cacheKey, markets, config.MARKET_CACHE_TTL_MS);
  return markets;
}

// Query /events?tag_slug=weather and flatten the embedded markets arrays.
async function fetchFromWeatherCategory() {
  const markets = [];
  let offset = 0;

  while (true) {
    let page;
    try {
      const { data } = await gammaClient.get('/events', {
        params: {
          tag_slug: 'weather',
          active: true,
          closed: false,
          limit: config.MARKET_PAGE_SIZE,
          offset,
        },
      });
      page = Array.isArray(data) ? data : (data.data || data.events || []);
    } catch (err) {
      logger.error('Weather category fetch failed', { offset, error: err.message });
      break;
    }

    if (page.length === 0) break;

    for (const event of page) {
      const eventMarkets = Array.isArray(event.markets) ? event.markets : [];
      for (const m of eventMarkets) {
        // Attach event-level URL slug when individual market slug is absent
        if (!m.slug && event.slug) m.slug = event.slug;
        markets.push(m);
      }
    }

    if (page.length < config.MARKET_PAGE_SIZE) break;
    offset += config.MARKET_PAGE_SIZE;
    if (offset >= 2000) break; // safety cap
  }

  return markets;
}

// Legacy fallback: scan all markets and apply keyword filter.
async function fetchByKeywordScan() {
  const markets = [];
  let offset = 0;

  while (offset < 1000) {
    try {
      const { data } = await gammaClient.get('/markets', {
        params: { active: true, closed: false, limit: config.MARKET_PAGE_SIZE, offset },
      });
      const page = Array.isArray(data) ? data : (data.data || data.markets || []);
      if (page.length === 0) break;
      markets.push(...page.filter(isWeatherMarket));
      if (page.length < config.MARKET_PAGE_SIZE) break;
      offset += config.MARKET_PAGE_SIZE;
    } catch (err) {
      logger.error('Keyword scan page failed', { offset, error: err.message });
      break;
    }
  }

  return markets;
}

function isWeatherMarket(market) {
  const text = `${market.question || ''} ${market.description || ''} ${JSON.stringify(market.tags || '')}`.toLowerCase();
  if (config.WEATHER_BLOCKLIST.some(term => text.includes(term))) return false;
  return config.WEATHER_KEYWORDS.some(kw => text.includes(kw));
}

function parseJsonField(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
}

// Normalize a raw Gamma API market into our standard shape
function normalizeMarket(raw) {
  const outcomes = parseJsonField(raw.outcomes, []);
  const prices = parseJsonField(raw.outcomePrices || raw.prices, []);

  return {
    id: String(raw.id),
    conditionId: raw.conditionId || raw.condition_id || null,
    question: raw.question || raw.title || 'Unknown market',
    slug: raw.slug || null,
    url: raw.slug ? `https://polymarket.com/event/${raw.slug}` : 'https://polymarket.com',
    liquidity: parseFloat(raw.liquidity || raw.liquidityNum || 0),
    volume24h: parseFloat(raw.volume24hr || raw.volume || 0),
    outcomes: outcomes.map((name, i) => ({
      name: String(name),
      price: parseFloat(prices[i] || 0.5),           // price in [0,1] = implied probability
    })),
    endDate: raw.endDate || raw.end_date || null,
    active: raw.active !== false,
    closed: raw.closed === true,
    resolved: raw.resolved === true || raw.closed === true,
    tags: raw.tags || [],
  };
}

// Fetch enriched details for a single market
async function fetchMarketDetail(conditionId) {
  if (!conditionId) return null;
  try {
    const { data } = await clobClient.get(`/markets/${conditionId}`);
    return data;
  } catch (err) {
    logger.debug('CLOB market detail fetch failed', { conditionId, error: err.message });
    return null;
  }
}

// Fetch top traders positioned in a market
async function fetchMarketTraders(conditionId, marketId) {
  const cacheKey = `traders:${conditionId || marketId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const traders = [];

  // Primary: data-api positions endpoint
  try {
    const { data } = await dataClient.get('/positions', {
      params: {
        market_id: conditionId || marketId,
        limit: 50,
        sort_by: 'size',
        sort_direction: 'desc',
      },
    });
    const positions = Array.isArray(data) ? data : (data.data || data.positions || []);
    for (const pos of positions.slice(0, 50)) {
      traders.push(normalizeTrader(pos));
    }
  } catch (err) {
    logger.debug('Position fetch failed, trying alternate', { error: err.message });
  }

  // Fallback: try leaderboard endpoint scoped to market
  if (traders.length === 0) {
    try {
      const { data } = await dataClient.get('/leaderboard', {
        params: { market_id: conditionId || marketId, limit: 20 },
      });
      const rows = Array.isArray(data) ? data : (data.data || []);
      for (const row of rows) {
        traders.push(normalizeTrader(row));
      }
    } catch (err) {
      logger.debug('Leaderboard fetch also failed', { error: err.message });
    }
  }

  // Filter to only positive win-rate traders
  const positiveTraders = traders.filter(t => t.winRate > 0 && t.totalTrades > 0);

  cache.set(cacheKey, positiveTraders, config.TRADER_CACHE_TTL_MS);
  return positiveTraders;
}

function normalizeTrader(raw) {
  return {
    address: raw.proxyWallet || raw.address || raw.user || 'unknown',
    name: raw.name || raw.displayName || null,
    winRate: parseFloat(raw.pnlPercentage || raw.win_rate || raw.profitPercent || 0),
    totalTrades: parseInt(raw.tradesCount || raw.total_trades || 0),
    totalProfit: parseFloat(raw.profit || raw.totalProfit || 0),
    position: raw.outcome || raw.side || null,    // which outcome they're betting
    positionSize: parseFloat(raw.size || raw.amount || 0),
  };
}

// Fetch global top traders (by all-time win rate) - cached 30 min
async function fetchTopTraders() {
  const cacheKey = 'global_top_traders';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await dataClient.get('/leaderboard', {
      params: { limit: 100, sort_by: 'profit', sort_direction: 'desc' },
    });
    const traders = Array.isArray(data) ? data : (data.data || []);
    const normalized = traders.map(normalizeTrader).filter(t => t.winRate > 0);
    cache.set(cacheKey, normalized, config.TRADER_CACHE_TTL_MS);
    return normalized;
  } catch (err) {
    logger.warn('Could not fetch global top traders', { error: err.message });
    return [];
  }
}

module.exports = {
  fetchWeatherMarkets,
  normalizeMarket,
  fetchMarketDetail,
  fetchMarketTraders,
  fetchTopTraders,
  isWeatherMarket,
};
