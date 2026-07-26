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
    gmailSyncLookbackDays: parseInt(process.env.GMAIL_SYNC_LOOKBACK_DAYS, 10) || 30,
    pubsubVerificationToken: process.env.PUBSUB_VERIFICATION_TOKEN || '',
    pubsubTopic: process.env.GCP_PUBSUB_TOPIC || 'gmail-expenses-topic',
    gcpProjectId: process.env.GCP_PROJECT_ID || 'onespace26',
  }
};
