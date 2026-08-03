const fs = require('fs');
const secretEnvPath = '/etc/secrets/.env';
if (fs.existsSync(secretEnvPath)) {
  require('dotenv').config({ path: secretEnvPath });
} else {
  require('dotenv').config();
}

// Fail-fast validation for critical environment variables
const requiredVariables = ['PORT', 'MONGO_URI', 'JWT_SECRET'];
requiredVariables.forEach((variable) => {
  if (!process.env[variable]) {
    console.error(`🚨 FATAL ERROR: Missing required environment variable: ${variable}`);
    process.exit(1);
  }
});

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10),
  
  db: {
    uri: (() => {
      let uri = process.env.MONGO_URI;
      const appEnv = (process.env.APP_ENV || process.env.NODE_ENV || 'development').toLowerCase();
      
      // Enforce DB isolation rules:
      // Release uses OneSpaceDB
      // Local/Development uses StOneSpaceDB
      if (appEnv === 'release') {
        return uri.replace(/\/[^/?]+(\?|$)/, '/OneSpaceDB$1');
      } else {
        return uri.replace(/\/[^/?]+(\?|$)/, '/StOneSpaceDB$1');
      }
    })(),
  },
  
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  },
  
  cors: {
    // Parse comma-separated string into array (e.g. "http://localhost:4200,https://onespace.com")
    origins: process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()) 
      : '*',
  },
  
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 1000, // 1000 requests per window
  },
  
  app: {
    maxWorkspaces: parseInt(process.env.MAX_WORKSPACES, 10) || 6,
    expenseMonthlyBudget: parseInt(process.env.EXPENSE_MONTHLY_BUDGET, 10) || 30000,
    pubsubVerificationToken: process.env.PUBSUB_VERIFICATION_TOKEN || '',
    pubsubTopic: process.env.GCP_PUBSUB_TOPIC || 'gmail-expenses-topic',
    gcpProjectId: process.env.GCP_PROJECT_ID || 'onespace26',
  },

  /**
   * Gmail sync tuning.
   *
   * The design is three-tiered: a push-driven incremental fetch for latency, an
   * unconditional reconciliation sweep for completeness, and a durable job queue
   * so neither depends on an HTTP request surviving. Completeness rests on the
   * sweep alone — every other knob here is a latency or cost optimisation.
   */
  gmailSync: {
    /**
     * How far back a full sweep looks.
     *
     * This is the retention window for the whole feature: a transaction whose
     * email is older than this and was never seen will never be picked up. Seven
     * days is a deliberate product choice, not a technical limit.
     */
    lookbackDays: parseInt(process.env.GMAIL_SYNC_LOOKBACK_DAYS, 10) || 7,

    /**
     * How far *behind* the last clean sync the incremental query starts.
     *
     * Gmail's `after:` filters on `internalDate` (when Google received the mail),
     * not on when we were told about it. A bank alert delayed in delivery can
     * therefore land behind a watermark set from wall-clock time, and would be
     * missed forever by a zero-overlap query. Re-scanning this overlap is free:
     * the message ledger drops those IDs before any `messages.get` is issued.
     */
    overlapMinutes: parseInt(process.env.GMAIL_SYNC_OVERLAP_MINUTES, 10) || 120,

    /**
     * Gap between reconciliation sweeps.
     *
     * This is the worst-case latency for a transaction whose push never arrived,
     * so it doubles as the recovery time for a lapsed watch, a Pub/Sub outage, or
     * a mailbox whose bank alerts are auto-archived out of the INBOX the watch
     * subscribes to. A sweep of an idle mailbox costs one `messages.list` (5 quota
     * units) and one indexed query, so a short interval is affordable.
     */
    sweepIntervalMinutes: parseInt(process.env.GMAIL_SWEEP_INTERVAL_MINUTES, 10) || 120,

    /** Delay before the startup sweep, so it never competes with boot. */
    startupSweepDelayMs: 30 * 1000,

    /** How often the worker looks for queued sync jobs. */
    workerPollMs: parseInt(process.env.GMAIL_WORKER_POLL_MS, 10) || 3000,

    /** Users synced at once by this process. Bounds memory and DB connections. */
    workerConcurrency: parseInt(process.env.GMAIL_WORKER_CONCURRENCY, 10) || 3,

    /**
     * Messages downloaded per run. Anything above it is re-queued immediately,
     * so a backlog drains by itself instead of waiting for a human to press
     * Refresh. Bounds how long one run can hold a worker slot.
     */
    maxFetchesPerRun: parseInt(process.env.GMAIL_MAX_FETCHES_PER_RUN, 10) || 150,

    /**
     * Quota units per second we allow ourselves, per user.
     *
     * Gmail's ceiling is 250 units/user/second. Staying at 40% leaves room for
     * anything else touching the same mailbox and absorbs the burstiness of a
     * moving-average limiter. `messages.get` and `messages.list` cost 5 units
     * each, so this is ~20 message fetches per second per user.
     */
    quotaUnitsPerSecond: parseInt(process.env.GMAIL_QUOTA_UNITS_PER_SECOND, 10) || 100,
  },
};
