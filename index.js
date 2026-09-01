const app = require('./app');
const config = require('./config/index');
const logger = require('./config/logger');
const connectDB = require('./config/database');

const PORT = config.port;

// Start Server
const server = app.listen(PORT, async () => {
  logger.info(`🚀 OneSpaceServices running in ${config.env} mode on port ${PORT}`);
  
  // Connect to DB after server is listening
  await connectDB();
  
  logger.info(`👉 Test endpoint: http://localhost:${PORT}/api/health`);

  // 🔄 Time-Aware Keep-Alive: configured in app.js middleware + utils/keep-alive.js.
  // The wake-up middleware runs before routes so the first user request of the day
  // activates the self-ping timer. The timer stops at 11 PM IST to save credits.
  const keepAlive = require('./utils/keep-alive');
  keepAlive.configure(logger);

  // ⚙️ Gmail sync worker + reconciliation sweep.
  //
  // The worker drains the durable job queue; the sweep re-reads every connected
  // mailbox's retention window on a fixed interval. The sweep is what guarantees
  // no transaction is missed — pushes, watches and watermarks are all allowed to
  // fail without losing one.
  //
  // A developer machine pointed at the production database must NOT run these:
  // the worker would lease production jobs and sync real users' mailboxes from a
  // laptop. Set DISABLE_GMAIL_SYNC_WORKER=true locally; production leaves it unset.
  require('./automation/gmail/sync-scheduler').start();

  // 📅 Gmail Watch Renewal: Google's users.watch expires after 7 days.
  // We renew all active watches every 6 days, and also run it once on startup (after 5 seconds).
  //
  // A developer machine pointed at the production database must NOT run this:
  // users.watch re-registers the mailbox against whatever topic THIS process is
  // configured with, so a local restart could silently redirect (or drop)
  // production's push notifications. Set DISABLE_GMAIL_WATCH_RENEWAL=true
  // locally; production leaves it unset.
  if (process.env.DISABLE_GMAIL_WATCH_RENEWAL === 'true') {
    logger.warn('📅 Gmail watch renewal DISABLED for this process (DISABLE_GMAIL_WATCH_RENEWAL=true)');
  } else {
    setTimeout(async () => {
      try {
        logger.info('📅 Running initial Gmail watch renewal check...');
        const { renewAllWatches } = require('./automation/gmail/gmail-watch-manager');
        await renewAllWatches();
      } catch (err) {
        logger.error('📅 Gmail watch renewal check failed:', err.message);
      }
    }, 5000);

    const RENEWAL_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000; // 6 days
    setInterval(async () => {
      try {
        logger.info('📅 Starting scheduled Gmail watch renewal...');
        const { renewAllWatches } = require('./automation/gmail/gmail-watch-manager');
        await renewAllWatches();
      } catch (err) {
        logger.error('📅 Gmail watch renewal scheduler error:', err.message);
      }
    }, RENEWAL_INTERVAL_MS);
    logger.info('📅 Scheduled Gmail watch renewal enabled (every 6 days)');
  }
});

// Handle Unhandled Rejections (Safety Net)
process.on('unhandledRejection', (err) => {
  logger.error('💥 UNHANDLED REJECTION! Shutting down gracefully...');
  logger.error(`${err.name}: ${err.message}`);
  server.close(() => {
    process.exit(1);
  });
});
