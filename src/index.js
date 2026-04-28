require('dotenv').config();
const express = require('express');
const { config, validateConfig } = require('./config');
const logger = require('./utils/logger');
const { runScanCycle } = require('./analysis/pipeline');
const { sendHeartbeat, sendError, sendStartupMessage } = require('./services/telegram');
const db = require('./storage/db');

// ── Validate environment ─────────────────────────────────────────────────────
try {
  validateConfig();
} catch (err) {
  console.error(`STARTUP ERROR: ${err.message}`);
  process.exit(1);
}

// ── Bot runtime state ────────────────────────────────────────────────────────
const stats = {
  startedAt: new Date().toISOString(),
  cycles: 0,
  marketsScanned: 0,
  signalsSent: 0,
  lastCycle: null,
  isRunning: false,
};

// ── Main scan loop ───────────────────────────────────────────────────────────
async function tick() {
  if (stats.isRunning) {
    logger.warn('Previous cycle still running, skipping tick');
    return;
  }
  stats.isRunning = true;
  try {
    await runScanCycle(stats);
  } catch (err) {
    logger.error('Unhandled error in scan cycle', { error: err.message, stack: err.stack });
    await sendError(err.message).catch(() => {});
  } finally {
    stats.isRunning = false;
  }
}

// ── Dashboard / health server ────────────────────────────────────────────────
function startDashboard() {
  const app = express();

  app.get('/', (req, res) => {
    const recentSignals = db.getRecentSignals(10);
    const totalSignals = db.getTotalSignalCount();

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="60">
  <title>Polymarket Weather Bot</title>
  <style>
    body { font-family: monospace; background: #0d1117; color: #c9d1d9; padding: 24px; max-width: 900px; margin: 0 auto; }
    h1 { color: #58a6ff; }
    h2 { color: #8b949e; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
    .stat { display: inline-block; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 20px; margin: 8px; }
    .stat-value { font-size: 2em; color: #58a6ff; display: block; }
    .stat-label { font-size: 0.8em; color: #8b949e; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
    th { background: #161b22; color: #8b949e; padding: 8px; text-align: left; border: 1px solid #30363d; }
    td { padding: 8px; border: 1px solid #30363d; }
    tr:nth-child(even) { background: #0d1117; }
    .badge-high { color: #3fb950; }
    .badge-med  { color: #d29922; }
    .badge-low  { color: #f85149; }
    .status-ok  { color: #3fb950; }
    footer { margin-top: 32px; color: #8b949e; font-size: 0.75em; }
  </style>
</head>
<body>
  <h1>🌩️ Polymarket Weather Bot</h1>
  <p class="status-ok">● Running</p>

  <div>
    <div class="stat"><span class="stat-value">${stats.cycles}</span><span class="stat-label">Cycles</span></div>
    <div class="stat"><span class="stat-value">${stats.marketsScanned}</span><span class="stat-label">Markets Scanned</span></div>
    <div class="stat"><span class="stat-value">${totalSignals}</span><span class="stat-label">Total Signals</span></div>
    <div class="stat"><span class="stat-value">${stats.signalsSent}</span><span class="stat-label">Alerts Sent (session)</span></div>
  </div>

  <h2>Recent Signals</h2>
  ${recentSignals.length === 0 ? '<p style="color:#8b949e">No signals yet.</p>' : `
  <table>
    <tr>
      <th>Market</th><th>Outcome</th><th>Confidence</th><th>EV%</th><th>Time</th>
    </tr>
    ${recentSignals.map(s => {
      const conf = s.confidence;
      const cls = conf >= 90 ? 'badge-high' : conf >= 80 ? 'badge-med' : 'badge-low';
      return `<tr>
        <td>${s.market_question?.slice(0, 60) || '-'}</td>
        <td>${s.outcome}</td>
        <td class="${cls}">${s.confidence}%</td>
        <td>${s.ev_percent?.toFixed(1) || '-'}%</td>
        <td>${new Date(s.signal_time).toLocaleString()}</td>
      </tr>`;
    }).join('')}
  </table>`}

  <h2>Configuration</h2>
  <pre style="background:#161b22;padding:16px;border-radius:6px;border:1px solid #30363d">{
  "scanIntervalMinutes": ${config.SCAN_INTERVAL_MS / 60000},
  "alertThreshold": "${config.SIGNAL_CONFIDENCE_FOR_ALERT}%",
  "minLiquidity": "$${config.MIN_LIQUIDITY_USD}",
  "minVolume": "$${config.MIN_VOLUME_USD}",
  "maxBetSize": "$${config.MAX_BET_SIZE}/share",
  "lastCycle": "${stats.lastCycle || 'pending'}",
  "startedAt": "${stats.startedAt}"
}</pre>

  <footer>Auto-refreshes every 60s · Started ${stats.startedAt}</footer>
</body>
</html>`);
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', cycles: stats.cycles, lastCycle: stats.lastCycle });
  });

  app.get('/signals', (req, res) => {
    res.json(db.getRecentSignals(20));
  });

  const server = app.listen(config.PORT, () => {
    logger.info(`Dashboard available at http://localhost:${config.PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Dashboard port ${config.PORT} already in use — bot will run without dashboard. Set PORT= to use a different port.`);
    } else {
      logger.warn('Dashboard server error', { error: err.message });
    }
  });
}

// ── Heartbeat (every 6 hours) ────────────────────────────────────────────────
let heartbeatCount = 0;
function maybeHeartbeat() {
  heartbeatCount++;
  const cyclesPerHour = (60 * 60 * 1000) / config.SCAN_INTERVAL_MS;
  if (heartbeatCount >= cyclesPerHour * 6) {
    heartbeatCount = 0;
    sendHeartbeat(stats).catch(err => logger.warn('Heartbeat failed', { error: err.message }));
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────
async function main() {
  logger.info('Polymarket Weather Bot starting up', {
    scanInterval: `${config.SCAN_INTERVAL_MS / 1000}s`,
    alertThreshold: `${config.SIGNAL_CONFIDENCE_FOR_ALERT}%`,
    minLiquidity: `$${config.MIN_LIQUIDITY_USD}`,
  });

  startDashboard();

  await sendStartupMessage().catch(err => logger.warn('Startup message failed', { error: err.message }));

  // Initial scan immediately, then on interval
  await tick();

  const interval = setInterval(async () => {
    await tick();
    maybeHeartbeat();
  }, config.SCAN_INTERVAL_MS);

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      logger.info(`${sig} received, shutting down`);
      clearInterval(interval);
      process.exit(0);
    });
  }

  // Crash protection
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    sendError(`Uncaught exception: ${err.message}`).finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
