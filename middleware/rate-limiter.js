const rateLimit = require('express-rate-limit');
const config = require('../config/index');

/**
 * General API Rate Limiter
 * Limits standard API routes to prevent abuse or DoS.
 */
exports.apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs, // typically 15 minutes
  max: config.rateLimit.max, // Limit each IP to X requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  skip: () => process.env.NODE_ENV === 'development', // Skip in development
  message: {
    status: 'error',
    message: 'Too many requests from this IP, please try again after 15 minutes',
  },
});

/**
 * Per-user throttle for the manual Gmail sync.
 *
 * The general limiter is per-IP and set high enough (1000 / 15 min) that one
 * user holding down Refresh never trips it. Each press starts a Gmail scan, so
 * the cost of spamming it lands on Google's quota rather than ours — which is
 * exactly how the account got rate-limited in the first place.
 *
 * Keyed by user, not IP, so one impatient user cannot throttle everyone behind
 * the same NAT. The route is behind `protect`, so `req.user` is always set; the
 * fallback only exists so a future re-mount cannot crash the limiter.
 */
exports.syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: (req) => req.user?.id || 'unauthenticated',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development',
  message: {
    status: 'error',
    message: 'Too many sync requests. Gmail syncs automatically — please wait a minute before trying again.',
  },
});

/**
 * Strict Auth Rate Limiter
 * Heavily limits authentication routes to prevent brute-force password attacks.
 */
exports.authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 login/register requests per window
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development', // Skip in development
  message: {
    status: 'error',
    message: 'Too many login attempts from this IP, please try again after 15 minutes',
  },
});
