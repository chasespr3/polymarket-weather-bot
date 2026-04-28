const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const { config } = require('../config');
const logger = require('../utils/logger');
const cache = require('../utils/cache');

const NEWS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes per city
const NEWS_MIN_DELAY_MS = 1000;            // ≥1 s between API calls

const newsClient = axios.create({
  baseURL: 'https://newsapi.org/v2',
  timeout: 10000,
  params: { apiKey: config.NEWS_API_KEY },
});
axiosRetry(newsClient, {
  retries: 2,
  retryDelay: axiosRetry.exponentialDelay,
  // Don't retry 429s — we need to wait, not immediately retry
  retryCondition: err => axiosRetry.isNetworkOrIdempotentRequestError(err) && err.response?.status !== 429,
});

// Serial rate limiter — ensures at least NEWS_MIN_DELAY_MS between outbound calls
let _lastNewsCallAt = 0;
let _pending = Promise.resolve();

function throttledGet(params) {
  _pending = _pending.then(async () => {
    const wait = NEWS_MIN_DELAY_MS - (Date.now() - _lastNewsCallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastNewsCallAt = Date.now();
    return newsClient.get('/everything', { params });
  });
  return _pending;
}

// Fetch recent articles relevant to a market
async function fetchNewsForMarket(marketQuestion, location) {
  const query = buildQuery(marketQuestion, location);
  const cacheKey = `news:${query.toLowerCase().replace(/\s+/g, '_').slice(0, 80)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await throttledGet({
      q: query,
      sortBy: 'publishedAt',
      pageSize: 5,
      language: 'en',
    });

    const articles = (data.articles || []).map(a => ({
      title: a.title,
      source: a.source?.name,
      publishedAt: a.publishedAt,
      description: a.description,
      url: a.url,
    }));

    const result = { query, articles, fetchedAt: new Date().toISOString() };
    cache.set(cacheKey, result, NEWS_CACHE_TTL_MS);
    return result;
  } catch (err) {
    if (err.response?.status === 429) {
      logger.warn('News API rate limited (429) — returning empty for this market', { query });
    } else {
      logger.warn('News fetch failed', { query, error: err.message });
    }
    return { query, articles: [], fetchedAt: new Date().toISOString() };
  }
}

function buildQuery(marketQuestion, location) {
  const weatherTerms = ['hurricane', 'storm', 'temperature', 'snow', 'flood', 'tornado', 'drought', 'heat', 'frost'];
  const found = weatherTerms.filter(t => marketQuestion.toLowerCase().includes(t));
  const terms = found.length > 0 ? [found[0], 'weather'] : ['weather'];
  if (location) terms.push(location.split(',')[0].trim());
  return terms.join(' ');
}

// Format news for Claude context
function summarizeNews(newsData) {
  if (!newsData || newsData.articles.length === 0) {
    return 'No recent news articles found for this market topic.';
  }
  return newsData.articles
    .slice(0, 5)
    .map((a, i) => `${i + 1}. [${a.source}] ${a.title} (${a.publishedAt?.slice(0, 10)}): ${a.description || ''}`)
    .join('\n');
}

module.exports = { fetchNewsForMarket, summarizeNews };
