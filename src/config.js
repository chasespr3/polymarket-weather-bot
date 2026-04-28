require('dotenv').config();

const config = {
  // Timing
  SCAN_INTERVAL_MS: (parseInt(process.env.SCAN_INTERVAL_MINUTES) || 1) * 60 * 1000,
  SIGNAL_COOLDOWN_MS: 6 * 60 * 60 * 1000,       // 6 hours between same-market alerts
  TRADER_CACHE_TTL_MS: 30 * 60 * 1000,           // 30 min trader cache
  SENTIMENT_CACHE_TTL_MS: 60 * 60 * 1000,        // 1 hour sentiment cache
  MARKET_CACHE_TTL_MS: 5 * 60 * 1000,            // 5 min market odds cache

  // Thresholds
  MIN_CONFIDENCE_SCORE: parseInt(process.env.MIN_CONFIDENCE_SCORE) || 75,
  SIGNAL_CONFIDENCE_FOR_ALERT: parseInt(process.env.SIGNAL_CONFIDENCE_FOR_ALERT) || 85,
  MIN_LIQUIDITY_USD: parseInt(process.env.MIN_LIQUIDITY_USD) || 1000,
  MIN_VOLUME_USD: parseInt(process.env.MIN_VOLUME_USD) || 500,
  MAX_BET_SIZE: parseFloat(process.env.MAX_BET_SIZE) || 3,

  // API keys
  OPENWEATHER_API_KEY: process.env.OPENWEATHER_API_KEY,
  NEWS_API_KEY: process.env.NEWS_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  POLYMARKET_API_KEY: process.env.POLYMARKET_API_KEY || null,

  // Polymarket API endpoints
  POLYMARKET_GAMMA_URL: 'https://gamma-api.polymarket.com',
  POLYMARKET_CLOB_URL: 'https://clob.polymarket.com',
  POLYMARKET_DATA_URL: 'https://data-api.polymarket.com',

  // Market config
  MARKET_PAGE_SIZE: 100,
  MAX_MARKETS_PER_CYCLE: parseInt(process.env.MAX_MARKETS_PER_CYCLE) || 50,
  TOP_TRADER_COUNT: 10,

  // Phrases that must appear for a market to be considered weather-related.
  // Kept deliberately specific — short words like "rain", "ice", "wind" are
  // omitted because they appear constantly in non-weather titles.
  WEATHER_KEYWORDS: [
    // Temperature — including Polymarket's "Highest/Lowest temperature in [City]" format
    'highest temperature', 'highest temp',
    'lowest temperature', 'lowest temp',
    'temperature in',
    'temperature', 'degrees fahrenheit', 'degrees celsius', '°f', '°c',
    'high temperature', 'low temperature', 'heat index',
    // Precipitation
    'rainfall', 'precipitation', 'inches of rain', 'mm of rain',
    'snowfall', 'inches of snow', 'snow accumulation',
    // Named storm events
    'hurricane', 'tropical storm', 'tropical depression',
    'typhoon', 'cyclone', 'named storm',
    // Severe weather
    'tornado', 'blizzard', 'nor\'easter',
    'flooding', 'flash flood', 'storm surge',
    'drought', 'heat wave', 'heatwave', 'cold snap',
    'frost', 'freeze', 'freezing',
    // Explicit weather framing
    'weather forecast', 'weather event', 'meteorological',
    'national weather service', 'noaa',
  ],

  // If any of these appear in the market text, discard it regardless of
  // whether a weather keyword also matched.
  WEATHER_BLOCKLIST: [
    'bitcoin', 'crypto', 'eth ', 'ethereum', 'solana', 'doge',
    'election', 'impeach', 'senate', 'congress', 'president', 'trump', 'biden',
    'stock', 'nasdaq', 's&p', 'dow jones', 'fed rate', 'interest rate',
    'elon', 'musk', 'spacex', 'tesla',
    'nfl', 'nba', 'mlb', 'nhl', 'fifa', 'bundesliga', 'premier league',
    'oscar', 'grammy', 'emmy', 'award',
    'war ', 'invasion', 'military', 'missile',
    'ipo ', 'merger', 'acquisition',
  ],

  // Server
  PORT: parseInt(process.env.PORT) || 3000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // Claude model
  CLAUDE_MODEL: 'claude-sonnet-4-6',
};

function validateConfig() {
  const required = [
    'OPENWEATHER_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
  ];
  const missing = required.filter(k => !config[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = { config, validateConfig };
