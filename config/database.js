const mongoose = require('mongoose');
const logger = require('./logger');
const config = require('./index');
const { ensureSrvResolvable } = require('./dns');

/**
 * Connects to MongoDB with connection retry logic.
 * Handles transient DNS and network timeouts.
 *
 * Resolution is verified once up front rather than left to the driver. A
 * `mongodb+srv://` URI needs an SRV lookup through Node's own resolver, and when
 * that resolver is misconfigured every attempt fails identically with
 * `querySrv ECONNREFUSED` — five retries of a lookup that cannot succeed, ending
 * in a message that blames the database for what is a DNS problem. @see ./dns
 */
const connectDB = async (retries = 5, delay = 5000) => {
  await ensureSrvResolvable(config.db.uri, logger);

  for (let i = 0; i < retries; i++) {
    try {
      logger.info(`🔌 Attempting to connect to MongoDB (Attempt ${i + 1}/${retries})...`);

      const conn = await mongoose.connect(config.db.uri, {
        serverSelectionTimeoutMS: 5000, // Fast failure for health checks
      });

      logger.info(`✅ MongoDB Connected: ${conn.connection.host}`);
      logger.info(`📦 Database: ${conn.connection.name}`);
      return conn;
    } catch (err) {
      logger.error(`❌ Connection Attempt ${i + 1} Failed: ${err.message}`);

      // Retrying a name that cannot be looked up just burns 25 seconds before
      // reporting the same thing, so say what is actually wrong immediately.
      if (/querySrv|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/.test(err.message)) {
        logger.error('   ↳ This is name resolution failing, not the cluster refusing you.');
        logger.error('   ↳ Set DNS_SERVERS (e.g. DNS_SERVERS=1.1.1.1,8.8.8.8) or switch MONGO_URI to the non-SRV "mongodb://" form.');
      }

      if (i < retries - 1) {
        logger.info(`⏳ Waiting ${delay / 1000}s before retrying...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  logger.error('❌ All MongoDB connection attempts failed. Exiting...');
  process.exit(1);
};

// Graceful Shutdown Events
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  logger.info('🛑 Mongoose connection disconnected through app termination (SIGINT)');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await mongoose.connection.close();
  logger.info('🛑 Mongoose connection disconnected through app termination (SIGTERM)');
  process.exit(0);
});

module.exports = connectDB;
