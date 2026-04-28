const TelegramBot = require('node-telegram-bot-api');
const { config } = require('../config');
const logger = require('../utils/logger');

let bot;

function getBot() {
  if (!bot) {
    bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: false });
  }
  return bot;
}

async function sendSignal(signal) {
  const {
    market, outcome, confidence, marketOdds, evPercent,
    topTraders, weatherAnalysis, newsAnalysis, rationale, risk,
  } = signal;

  const traderLines = topTraders.length > 0
    ? topTraders.slice(0, 3).map(t =>
        `  • \`${t.address.slice(0, 10)}...\` — ${t.winRate.toFixed(1)}% win rate`
      ).join('\n')
    : '  • No trader data available';

  const contrarian = signal.traderAlignment === 'disagrees'
    ? '\n⚡ *CONTRARIAN SIGNAL* — Top traders betting opposite direction' : '';

  const message = [
    `🚨 *POLYMARKET WEATHER SIGNAL*`,
    ``,
    `📊 *Market:* ${escapeMarkdown(market.question)}`,
    `🎯 *Recommendation:* BET *${escapeMarkdown(outcome)}*`,
    `✅ *Confidence:* ${confidence}%`,
    `📈 *Market Odds:* ${(marketOdds * 100).toFixed(1)}% implied probability`,
    `💰 *Expected Value:* +${evPercent.toFixed(1)}%`,
    `💵 *Position Size:* Up to $${config.MAX_BET_SIZE}/share recommended`,
    contrarian,
    ``,
    `👥 *Top Traders Betting ${escapeMarkdown(outcome)}:*`,
    traderLines,
    ``,
    `📰 *News Summary:*`,
    escapeMarkdown(newsAnalysis || 'No recent news.'),
    ``,
    `🌡️ *Weather Analysis:*`,
    escapeMarkdown(weatherAnalysis || rationale),
    ``,
    `⚠️ *Key Risk:*`,
    escapeMarkdown(risk || 'Data confidence uncertain.'),
    ``,
    `🔗 [View Market](${market.url})`,
  ].join('\n');

  try {
    await getBot().sendMessage(config.TELEGRAM_CHAT_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: false,
    });
    logger.info('Telegram signal sent', { marketId: market.id, outcome, confidence });
    return true;
  } catch (err) {
    logger.error('Telegram send failed', { error: err.message });
    return false;
  }
}

async function sendHeartbeat(stats) {
  const message = [
    `🤖 *Weather Bot Heartbeat*`,
    ``,
    `⏱️ Running since: ${stats.startedAt}`,
    `🔄 Cycles completed: ${stats.cycles}`,
    `📡 Markets scanned: ${stats.marketsScanned}`,
    `🚨 Signals sent: ${stats.signalsSent}`,
    `🕐 Last cycle: ${stats.lastCycle}`,
  ].join('\n');

  try {
    await getBot().sendMessage(config.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('Heartbeat send failed', { error: err.message });
  }
}

async function sendError(message) {
  try {
    await getBot().sendMessage(config.TELEGRAM_CHAT_ID, `⚠️ Bot Error: ${message}`, {});
  } catch { /* swallow */ }
}

function escapeMarkdown(text) {
  if (!text) return '';
  // Escape special Markdown v1 characters
  return String(text).replace(/([_*[\]`])/g, '\\$1');
}

async function sendStartupMessage() {
  const message = [
    `🤖 *Polymarket Weather Bot is ONLINE*`,
    ``,
    `📡 Monitoring Polymarket weather category`,
    `⚙️ Settings: ${config.SIGNAL_CONFIDENCE_FOR_ALERT}% confidence threshold | $${config.MIN_LIQUIDITY_USD.toLocaleString()} min liquidity | ${config.MAX_MARKETS_PER_CYCLE} markets/cycle`,
    `🕐 Checking every ${Math.round(config.SCAN_INTERVAL_MS / 60000)} minute(s)`,
    `✅ All systems operational`,
  ].join('\n');

  await getBot().sendMessage(config.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
}

module.exports = { sendSignal, sendHeartbeat, sendError, sendStartupMessage };
