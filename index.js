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

  // 🔄 Self Keep-Alive: Prevents Render free tier from sleeping the server.
  // Pings own health endpoint every 10 minutes so Render sees continuous activity.
  // Uses RENDER_EXTERNAL_URL (auto-set by Render) to dynamically resolve the correct URL.
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
    setInterval(async () => {
      try {
        const res = await fetch(`${selfUrl}/api/health`);
        logger.info(`♻️ Keep-alive ping: ${res.status}`);
      } catch (err) {
        logger.warn(`♻️ Keep-alive ping failed: ${err.message}`);
      }
    }, KEEP_ALIVE_INTERVAL_MS);
    logger.info(`♻️ Self keep-alive enabled (every 10 minutes) → ${selfUrl}`);
  }

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
