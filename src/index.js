require('dotenv').config();
const express = require('express');
const { config, validateConfig } = require('./config');
const logger = require('./utils/logger');
const { runScanCycle } = require('./analysis/pipeline');
const { sendHeartbeat, sendError, sendStartupMessage } = require('./services/telegram');
const db = require('./storage/db');

try {
  validateConfig();
} catch (err) {
  console.error(`STARTUP ERROR: ${err.message}`);
  process.exit(1);
}

const startTime = Date.now();
const stats = {
  startedAt: new Date().toISOString(),
  cycles: 0,
  marketsScanned: 0,
  signalsSent: 0,
  lastCycle: null,
  isRunning: false,
};

// ── Scan loop ────────────────────────────────────────────────────────────────
async function tick() {
  if (stats.isRunning) { logger.warn('Previous cycle still running, skipping tick'); return; }
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

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${s % 60}s`;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtPnl(pnl) {
  if (pnl == null) return `<span class="muted">—</span>`;
  const sign = pnl >= 0 ? '+' : '';
  const cls = pnl >= 0 ? 'pos' : 'neg';
  return `<span class="${cls}">${sign}$${Math.abs(pnl).toFixed(2)}</span>`;
}

// Render odds with enough decimal places so sub-1% values never round to "0%"
function fmtOdds(v) {
  if (v == null) return '—';
  const pct = v * 100;
  if (pct === 0)  return '0%';
  if (pct < 0.1)  return pct.toFixed(2) + '%';
  if (pct < 1)    return pct.toFixed(2) + '%';
  if (pct < 10)   return pct.toFixed(1) + '%';
  return pct.toFixed(0) + '%';
}

function signalRows(signals) {
  if (signals.length === 0) {
    return `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:32px">No signals yet — bot is scanning markets</td></tr>`;
  }
  return signals.map(s => {
    const dt = new Date(s.signal_time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const odds = fmtOdds(s.outcome_odds);
    const status = s.resolved ? (s.won ? 'Won' : 'Lost') : 'Pending';
    const statusCls = s.resolved ? (s.won ? 'badge-won' : 'badge-lost') : 'badge-pending';
    const confCls = s.confidence >= 90 ? 'pos' : s.confidence >= 80 ? 'warn' : 'muted';
    return `<tr>
      <td class="muted nowrap">${dt}</td>
      <td><span class="ellipsis" title="${esc(s.market_question)}">${esc((s.market_question || '—').slice(0, 55))}</span></td>
      <td><strong>${esc(s.outcome)}</strong></td>
      <td><span class="${confCls}">${s.confidence}%</span></td>
      <td class="muted">${odds}</td>
      <td class="muted">$3.00</td>
      <td><span class="badge ${statusCls}">${status}</span></td>
      <td>${fmtPnl(s.pnl)}</td>
    </tr>`;
  }).join('');
}

// ── Dashboard ────────────────────────────────────────────────────────────────
function buildDashboard() {
  const pnl = db.getDashboardStats();
  const signals = db.getAllSignals();
  const uptime = formatUptime(Date.now() - startTime);

  const pnlSign = pnl.netPnl >= 0 ? '+' : '';
  const pnlCls = pnl.netPnl >= 0 ? 'pos' : 'neg';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="60">
  <title>🌩️ Weather Bot</title>
  <style>
    :root {
      --bg:      #0d1117;
      --surface: #161b22;
      --border:  #21262d;
      --text:    #c9d1d9;
      --heading: #e6edf3;
      --muted:   #8b949e;
      --blue:    #58a6ff;
      --green:   #3fb950;
      --red:     #f85149;
      --yellow:  #d29922;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
           background: var(--bg); color: var(--text); min-height: 100vh; padding: 24px 16px; }
    a { color: var(--blue); text-decoration: none; }

    .wrap { max-width: 1100px; margin: 0 auto; }

    /* ── Header ── */
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 28px;
              padding-bottom: 20px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--green);
           box-shadow: 0 0 8px var(--green); flex-shrink: 0;
           animation: pulse 2.5s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .header h1 { font-size: 1.25rem; font-weight: 600; color: var(--heading); }
    .header-meta { margin-left: auto; text-align: right; font-size: 0.8rem; color: var(--muted); line-height: 1.5; }

    /* ── Hero cards ── */
    .heroes { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
              gap: 14px; margin-bottom: 20px; }
    .hero { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }
    .hero-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: .08em;
                  color: var(--muted); margin-bottom: 8px; }
    .hero-value { font-size: 2rem; font-weight: 700; color: var(--heading); line-height: 1; }

    /* ── Stats strip ── */
    .stats-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
                   gap: 0; background: var(--surface); border: 1px solid var(--border);
                   border-radius: 10px; margin-bottom: 24px; overflow: hidden; }
    .stat { padding: 16px 12px; text-align: center; border-right: 1px solid var(--border); }
    .stat:last-child { border-right: none; }
    .stat-v { font-size: 1.15rem; font-weight: 600; color: var(--blue); }
    .stat-l { font-size: 0.7rem; color: var(--muted); margin-top: 4px; }

    /* ── Table ── */
    .section-head { font-size: 0.95rem; font-weight: 600; color: var(--heading);
                    margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
    .count-badge { font-size: 0.75rem; font-weight: 500; background: var(--border);
                   color: var(--muted); border-radius: 20px; padding: 2px 8px; }
    .tbl-wrap { overflow-x: auto; border-radius: 10px; border: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    thead th { background: var(--surface); color: var(--muted); font-weight: 500;
               padding: 10px 14px; text-align: left; white-space: nowrap;
               border-bottom: 1px solid var(--border); }
    tbody td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: rgba(88,166,255,.04); }
    .nowrap { white-space: nowrap; }
    .ellipsis { display: inline-block; max-width: 260px; overflow: hidden;
                text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }

    /* ── Badges ── */
    .badge { display: inline-block; padding: 2px 9px; border-radius: 20px;
             font-size: 0.72rem; font-weight: 600; }
    .badge-won     { background: rgba(63,185,80,.15);  color: var(--green); }
    .badge-lost    { background: rgba(248,81,73,.15);  color: var(--red);   }
    .badge-pending { background: rgba(210,153,34,.15); color: var(--yellow);}

    /* ── Colour helpers ── */
    .pos  { color: var(--green); font-weight: 600; }
    .neg  { color: var(--red);   font-weight: 600; }
    .warn { color: var(--yellow); }
    .muted{ color: var(--muted); }

    /* ── Footer ── */
    .footer { margin-top: 28px; text-align: center; font-size: 0.75rem; color: var(--muted); }

    @media(max-width:600px) {
      .hero-value { font-size: 1.5rem; }
      .ellipsis   { max-width: 130px; }
      .stats-strip{ grid-template-columns: repeat(4, 1fr); }
    }
  </style>
</head>
<body>
<div class="wrap">

  <!-- Header -->
  <div class="header">
    <div class="dot"></div>
    <h1>🌩️ Polymarket Weather Bot</h1>
    <div class="header-meta">
      Uptime: <strong>${uptime}</strong><br>
      Last cycle: <strong>${stats.lastCycle ? new Date(stats.lastCycle).toLocaleTimeString() : 'pending'}</strong>
    </div>
  </div>

  <!-- Hero cards -->
  <div class="heroes">
    <div class="hero">
      <div class="hero-label">Net P&amp;L</div>
      <div class="hero-value ${pnlCls}">${pnlSign}$${Math.abs(pnl.netPnl).toFixed(2)}</div>
    </div>
    <div class="hero">
      <div class="hero-label">Win Rate</div>
      <div class="hero-value">${pnl.winRate}%</div>
    </div>
    <div class="hero">
      <div class="hero-label">Total Signals</div>
      <div class="hero-value">${pnl.total}</div>
    </div>
    <div class="hero">
      <div class="hero-label">Cycles Run</div>
      <div class="hero-value">${stats.cycles}</div>
    </div>
  </div>

  <!-- Stats strip -->
  <div class="stats-strip">
    <div class="stat"><div class="stat-v">${pnl.wins}</div><div class="stat-l">Wins</div></div>
    <div class="stat"><div class="stat-v">${pnl.losses}</div><div class="stat-l">Losses</div></div>
    <div class="stat"><div class="stat-v">${pnl.pending}</div><div class="stat-l">Pending</div></div>
    <div class="stat"><div class="stat-v">$${pnl.totalWagered.toFixed(2)}</div><div class="stat-l">Wagered</div></div>
    <div class="stat"><div class="stat-v">$${pnl.totalReturned.toFixed(2)}</div><div class="stat-l">Returned</div></div>
    <div class="stat"><div class="stat-v ${pnl.bestWin != null ? 'pos' : 'muted'}">${pnl.bestWin != null ? '+$' + pnl.bestWin.toFixed(2) : '—'}</div><div class="stat-l">Best Win</div></div>
    <div class="stat"><div class="stat-v ${pnl.worstLoss != null ? 'neg' : 'muted'}">${pnl.worstLoss != null ? '-$' + Math.abs(pnl.worstLoss).toFixed(2) : '—'}</div><div class="stat-l">Worst Loss</div></div>
    <div class="stat"><div class="stat-v">${stats.marketsScanned.toLocaleString()}</div><div class="stat-l">Scanned</div></div>
  </div>

  <!-- Signals table -->
  <div class="section-head">
    Signal History
    <span class="count-badge">${signals.length}</span>
  </div>
  <div class="tbl-wrap">
    <table>
      <thead>
        <tr>
          <th>Date / Time</th>
          <th>Market</th>
          <th>Rec.</th>
          <th>Conf.</th>
          <th>Odds</th>
          <th>Bet</th>
          <th>Status</th>
          <th>P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        ${signalRows(signals)}
      </tbody>
    </table>
  </div>

  <div class="footer">
    Auto-refreshes every 60s &nbsp;·&nbsp;
    <a href="/signals">JSON API</a> &nbsp;·&nbsp;
    <a href="/health">Health</a> &nbsp;·&nbsp;
    Updated ${new Date().toLocaleString()}
  </div>

</div>
</body>
</html>`;
}

// ── Express server ────────────────────────────────────────────────────────────
function startDashboard() {
  const app = express();

  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(buildDashboard());
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: formatUptime(Date.now() - startTime), cycles: stats.cycles, lastCycle: stats.lastCycle });
  });

  app.get('/signals', (_req, res) => {
    res.json(db.getAllSignals());
  });

  app.get('/stats', (_req, res) => {
    res.json({ ...db.getDashboardStats(), bot: stats });
  });

  const server = app.listen(config.PORT, () => {
    logger.info(`Dashboard available at http://localhost:${config.PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Dashboard port ${config.PORT} in use — bot will run without dashboard. Set PORT= to change.`);
    } else {
      logger.warn('Dashboard server error', { error: err.message });
    }
  });
}

// ── Heartbeat every 6 hours ──────────────────────────────────────────────────
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

  await sendStartupMessage().catch(err =>
    logger.warn('Startup message failed', { error: err.message })
  );

  await tick();

  const interval = setInterval(async () => {
    await tick();
    maybeHeartbeat();
  }, config.SCAN_INTERVAL_MS);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { logger.info(`${sig} received, shutting down`); clearInterval(interval); process.exit(0); });
  }

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    sendError(`Uncaught exception: ${err.message}`).finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });
}

main().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
