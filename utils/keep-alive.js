/**
 * Time-Aware Keep-Alive for Render Free Tier
 *
 * Prevents Render from sleeping the server during a configurable active window
 * while saving credits outside that window.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  GitHub Actions cron (.github/workflows/keep-alive.yml)             │
 * │  fires at 7 AM IST → wakes the server from Render's cold sleep     │
 * │                                                                      │
 * │  That first request hits the middleware below, which starts the      │
 * │  self-ping interval. The interval keeps the server alive until       │
 * │  11 PM IST, then stops. Render sleeps the server overnight.         │
 * │                                                                      │
 * │  Next morning the cron fires again → cycle repeats.                 │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Environment variables (all optional, sensible defaults):
 *   KEEP_ALIVE_START_HOUR_IST  — Hour (0–23) in IST when pinging may begin.  Default: 7 (7 AM)
 *   KEEP_ALIVE_END_HOUR_IST    — Hour (0–23) in IST when pinging stops.      Default: 23 (11 PM)
 *   KEEP_ALIVE_INTERVAL_MIN    — Minutes between pings.                       Default: 10
 *
 * Usage:
 *   app.js   → `app.use(require('./utils/keep-alive').middleware);`  (before routes)
 *   index.js → `require('./utils/keep-alive').configure(logger);`   (after listen)
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

let keepAliveTimer = null;
let selfUrl = null;
let log = console; // replaced by configure()

// Configurable — read from env in configure()
let START_HOUR_IST = 7;  // 7 AM IST
let END_HOUR_IST = 23;   // 11 PM IST
let INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Returns the current hour in IST (0–23). */
function getCurrentISTHour() {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  return nowIST.getUTCHours();
}

/** Returns true if current IST hour falls within the active window. */
function isWithinActiveWindow() {
  const hour = getCurrentISTHour();
  return hour >= START_HOUR_IST && hour < END_HOUR_IST;
}

/** Starts the keep-alive interval if not already running and within the active window. */
function startKeepAlive() {
  if (keepAliveTimer) return;           // already running
  if (!selfUrl) return;                 // not on Render
  if (!isWithinActiveWindow()) return;  // outside active hours

  keepAliveTimer = setInterval(async () => {
    // Stop pinging once we leave the active window
    if (!isWithinActiveWindow()) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      log.info(`😴 Keep-alive stopped (${END_HOUR_IST}:00 IST). GitHub Actions will wake the server at ${START_HOUR_IST}:00 IST tomorrow.`);
      return;
    }
    try {
      const res = await fetch(`${selfUrl}/api/health`);
      log.info(`♻️ Keep-alive ping: ${res.status}`);
    } catch (err) {
      log.warn(`♻️ Keep-alive ping failed: ${err.message}`);
    }
  }, INTERVAL_MS);

  log.info(`♻️ Keep-alive activated (every ${INTERVAL_MS / 60000} min, ${START_HOUR_IST}:00–${END_HOUR_IST}:00 IST) → ${selfUrl}`);
}

/**
 * Express middleware — mounted early in app.js (before routes).
 * Any request during the active window starts the keep-alive if it isn't running.
 * Skips /api/health to avoid the keep-alive's own pings re-triggering itself.
 */
function middleware(req, res, next) {
  if (!keepAliveTimer && req.path !== '/api/health') {
    startKeepAlive(); // no-ops if outside the window
  }
  next();
}

/**
 * Called once from index.js after the server starts listening.
 * Reads env config, wires up the logger, and starts immediately if within
 * the active window (handles the GitHub Actions cron wake-up case).
 */
function configure(logger) {
  log = logger;
  selfUrl = process.env.RENDER_EXTERNAL_URL || null;

  // Read configurable hours from env
  if (process.env.KEEP_ALIVE_START_HOUR_IST != null) {
    START_HOUR_IST = parseInt(process.env.KEEP_ALIVE_START_HOUR_IST, 10);
  }
  if (process.env.KEEP_ALIVE_END_HOUR_IST != null) {
    END_HOUR_IST = parseInt(process.env.KEEP_ALIVE_END_HOUR_IST, 10);
  }
  if (process.env.KEEP_ALIVE_INTERVAL_MIN != null) {
    INTERVAL_MS = parseInt(process.env.KEEP_ALIVE_INTERVAL_MIN, 10) * 60 * 1000;
  }

  if (!selfUrl) {
    log.info('♻️ Keep-alive skipped (RENDER_EXTERNAL_URL not set — not running on Render).');
    return;
  }

  log.info(`♻️ Keep-alive window: ${START_HOUR_IST}:00–${END_HOUR_IST}:00 IST, every ${INTERVAL_MS / 60000} min → ${selfUrl}`);

  if (isWithinActiveWindow()) {
    // Server booted/woken during active hours — start immediately
    startKeepAlive();
  } else {
    log.info(`😴 Outside active window (${START_HOUR_IST}:00–${END_HOUR_IST}:00 IST). Server will sleep until GitHub Actions cron wakes it.`);
  }
}

module.exports = { middleware, configure };
