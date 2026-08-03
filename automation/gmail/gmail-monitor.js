/**
 * Gmail Monitor — Gmail API transport.
 *
 * Owns everything that actually talks to Google:
 * - OAuth2 client construction, credential caching, and access-token reuse
 * - Retry policy for transient failures
 * - Message-list and message-content fetching, paced against the quota governor
 * - Building the two query shapes the sync uses
 *
 * Parsing lives in the parsers; orchestration lives in the engine. This file
 * knows nothing about banks or transactions.
 */

const { google } = require('googleapis');
const config = require('../../config/index');
const User = require('../../models/User');
const { decryptSecret, encryptSecret } = require('../../utils/crypto.util');
const { extractEmailBody } = require('../parsers/base-parser');
const { classifyGoogleError } = require('../../utils/google-error.util');
const quota = require('./gmail-quota');

/**
 * Safety cap on message-list pagination (100 messages per page).
 *
 * With a seven-day window and a sender-restricted query this is unreachable in
 * practice — it would take 2,000 bank alerts in a week. It exists so a
 * misconfigured query cannot page forever.
 */
const MAX_LIST_PAGES = 20;

/** Attempts per Gmail call, including the first. */
const MAX_ATTEMPTS = 3;

/** Base delay for the exponential backoff between those attempts. */
const BACKOFF_BASE_MS = 1000;

/** Refresh an access token this long before it actually expires. */
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

/**
 * Formats a Date into the day-granular form of Gmail's `after:` operator.
 * @param {Date} date
 * @returns {string} YYYY/MM/DD
 */
function formatGmailQueryDate(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

/**
 * Start of the retention window: now minus `gmailSync.lookbackDays`.
 *
 * This replaced a rule that took the earlier of "start of the previous month in
 * IST" and a configured lookback, which meant the window silently oscillated
 * between roughly 30 and 62 days depending on the calendar date. A flat rolling
 * window is what the product actually wants and is the same length every day.
 *
 * Nothing older than this is ever picked up, so this single number is the
 * feature's retention guarantee.
 * @returns {Date}
 */
function getSyncCutoffDate() {
  const days = config.gmailSync.lookbackDays;
  const safeDays = Number.isFinite(days) && days > 0 ? days : 7;
  return new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
}

/**
 * The sender clause shared by both query shapes.
 * @param {string[]} senderEmails
 * @returns {string}
 */
function senderClause(senderEmails) {
  if (senderEmails.length === 1) return `from:${senderEmails[0]}`;
  return `from:(${senderEmails.join(' OR ')})`;
}

/**
 * Query for a full sweep: every bank email in the retention window.
 *
 * Deliberately uses the day-granular `after:YYYY/MM/DD` form. This is the query
 * the completeness guarantee rests on, so it uses only the operator syntax that
 * has been running in production — the second-granular variant below is an
 * optimisation, and optimisations do not get to be load-bearing. Rounding down
 * to midnight UTC widens the window by up to a day, which the ledger absorbs at
 * the cost of one indexed lookup per known message.
 *
 * @param {string[]} senderEmails
 * @param {Date} cutoffDate
 * @returns {string}
 */
function buildFullQuery(senderEmails, cutoffDate) {
  return `after:${formatGmailQueryDate(cutoffDate)} ${senderClause(senderEmails)}`;
}

/**
 * Query for an incremental run: bank email that arrived since the watermark.
 *
 * Uses the Unix-timestamp form of `after:`, which is second-granular, so a push
 * fetches the handful of messages that are genuinely new instead of re-listing a
 * week. That narrowness is the point: it keeps the per-push cost at one
 * `messages.list` returning a near-empty result, rather than a full window scan
 * plus a large `$in` against the ledger.
 *
 * If Google ever stops honouring the timestamp form, this degrades to returning
 * too much or too little on the fast path — and the sweep still recovers every
 * message within `gmailSync.sweepIntervalMinutes`.
 *
 * @param {string[]} senderEmails
 * @param {Date} since
 * @returns {string}
 */
function buildIncrementalQuery(senderEmails, since) {
  const epochSeconds = Math.max(0, Math.floor(since.getTime() / 1000));
  return `after:${epochSeconds} ${senderClause(senderEmails)}`;
}

/**
 * Cache of live OAuth2 clients, keyed by user id.
 *
 * A fresh `OAuth2Client` holding only a refresh token has to redeem it at
 * `oauth2.googleapis.com/token` before the first API call. Building a new one per
 * sync — which every entry point used to do — meant one token exchange per sync,
 * per watch renewal, per Pub/Sub push. Google throttles refresh-token redemptions
 * per (client, user) and answers 429 well before Gmail itself would, so the sync
 * was rate-limited before it read a single message.
 *
 * Reusing the instance lets google-auth-library hold the access token for its
 * full hour and refresh it only when it actually expires. The token is also
 * mirrored to the user document, so a container restart resumes with it rather
 * than redeeming again — see `gmailAccessToken` on the User model.
 * @type {Map<string, {client: object, refreshToken: string, usedAt: number}>}
 */
const oauthClientCache = new Map();

/**
 * Most cached clients to keep.
 *
 * An unbounded cache is a slow memory leak: one entry per user who has ever
 * synced, each holding an access token, never released. The eviction order is
 * least-recently-used, and a miss now costs only a database read (or, at worst,
 * the token exchange this cache exists to avoid) — so a small ceiling is safe.
 */
const MAX_CACHED_CLIENTS = 500;

/**
 * Drop the least-recently-used entries until the cache is within its ceiling.
 * Map preserves insertion order and `createOAuth2Client` re-inserts on every
 * hit, so the oldest key is always the least recently used.
 */
function evictStaleClients() {
  while (oauthClientCache.size > MAX_CACHED_CLIENTS) {
    const oldest = oauthClientCache.keys().next().value;
    oauthClientCache.delete(oldest);
  }
}

/**
 * Mirrors a freshly issued access token onto the user document.
 *
 * Best-effort and deliberately not awaited by the caller: this is a cache warm,
 * and a failed write costs one extra token redemption after the next restart,
 * never a failed sync.
 * @param {string} userId
 * @param {{access_token?: string, expiry_date?: number}} tokens
 */
function persistAccessToken(userId, tokens) {
  if (!userId || !tokens?.access_token) return;

  User.findByIdAndUpdate(userId, {
    gmailAccessToken: encryptSecret(tokens.access_token),
    gmailAccessTokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  }).catch(err => {
    console.warn(`[GmailMonitor] Could not cache the access token: ${err.message}`);
  });
}

/**
 * Reads a still-valid access token off the user document, if there is one.
 * @param {object} user
 * @returns {{access_token: string, expiry_date: number}|null}
 */
function storedAccessToken(user) {
  if (!user?.gmailAccessToken || !user.gmailAccessTokenExpiry) return null;

  const expiry = new Date(user.gmailAccessTokenExpiry).getTime();
  if (!Number.isFinite(expiry) || expiry - TOKEN_EXPIRY_MARGIN_MS <= Date.now()) return null;

  try {
    return { access_token: decryptSecret(user.gmailAccessToken), expiry_date: expiry };
  } catch {
    // A key rotation makes old ciphertext unreadable. Fall back to the refresh
    // token rather than failing the sync.
    return null;
  }
}

/**
 * Creates — or reuses — an authenticated OAuth2 client for this user.
 *
 * The cached entry is discarded when the stored refresh token changes, so a
 * reconnect never keeps talking to Google with the credential it replaced.
 * @param {object} user - User document with googleRefreshToken (and, ideally, gmailAccessToken)
 * @returns {object} Authenticated OAuth2 client
 */
function createOAuth2Client(user) {
  const refreshToken = decryptSecret(user.googleRefreshToken);
  const key = String(user._id || user.id || '');

  const cached = key ? oauthClientCache.get(key) : null;
  if (cached && cached.refreshToken === refreshToken) {
    // Re-insert to mark it most-recently-used for the eviction order.
    oauthClientCache.delete(key);
    oauthClientCache.set(key, { ...cached, usedAt: Date.now() });
    return cached.client;
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  const credentials = { refresh_token: refreshToken };
  const stored = storedAccessToken(user);
  if (stored) {
    credentials.access_token = stored.access_token;
    credentials.expiry_date = stored.expiry_date;
  }
  oauth2Client.setCredentials(credentials);

  // Fires whenever the library redeems the refresh token. Mirroring the result
  // is what lets the *next* process skip the redemption entirely.
  if (key) {
    oauth2Client.on('tokens', (tokens) => persistAccessToken(key, tokens));
    oauthClientCache.set(key, { client: oauth2Client, refreshToken, usedAt: Date.now() });
    evictStaleClients();
  }
  return oauth2Client;
}

/**
 * Drops a user's cached client and pacing state. Call on disconnect and on any
 * fatal credential failure — otherwise a revoked token keeps its cached access
 * token until that token expires, and the user sees "connected" behaviour from a
 * dead grant.
 * @param {string} userId
 */
function invalidateOAuth2Client(userId) {
  oauthClientCache.delete(String(userId));
  quota.resetUser(userId);
}

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Runs a Gmail call, retrying transient failures with exponential backoff.
 *
 * Only retries what Google says is worth retrying, and honours `Retry-After`
 * when it sends one. A rate limit is deliberately NOT retried here: once Google
 * is refusing on quota grounds, retrying inside the same sync is what deepens
 * the block. The engine aborts and the cooldown keeps us away instead.
 *
 * @template T
 * @param {() => Promise<T>} call
 * @param {string} label used only in the log line
 * @returns {Promise<T>}
 */
async function withGoogleRetry(call, label) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await call();
    } catch (err) {
      lastErr = err;
      const failure = classifyGoogleError(err);

      if (!failure.retryable || failure.code === 'rate_limited' || attempt === MAX_ATTEMPTS) throw err;

      // Full jitter — a fixed backoff makes concurrent syncs retry in lockstep,
      // which reproduces the burst that caused the failure.
      const ceiling = failure.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** (attempt - 1);
      const delay = Math.round(Math.random() * ceiling);
      console.warn(`[GmailMonitor] ${label} failed (${failure.code}), retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * Fetches all matching message stubs, handling pagination.
 * @param {object} gmail - Authenticated Gmail API client
 * @param {string} query - Gmail search query
 * @param {{userId?: string}} [options] - `userId` paces the calls against that user's quota budget
 * @returns {Promise<Array<{id: string, threadId: string}>>} List of message stubs
 */
async function fetchEmailList(gmail, query, { userId } = {}) {
  let pageToken = null;
  let allMessages = [];
  let pages = 0;

  do {
    const listParams = {
      userId: 'me',
      q: query,
      maxResults: 100,
    };
    if (pageToken) listParams.pageToken = pageToken;

    const response = await quota.spend(userId, quota.COST.messagesList, () => withGoogleRetry(
      () => gmail.users.messages.list(listParams),
      `messages.list page ${pages + 1}`,
    ));
    const messages = response.data.messages || [];
    allMessages = allMessages.concat(messages);
    pageToken = response.data.nextPageToken || null;
    pages++;

    if (pages >= MAX_LIST_PAGES && pageToken) {
      console.warn(`[GmailMonitor] Stopped paginating at ${MAX_LIST_PAGES} pages (${allMessages.length} messages). Narrow the sync window if this recurs.`);
      break;
    }
  } while (pageToken);

  return allMessages;
}

/**
 * Fetches the full content of a single email and extracts subject, body, and metadata.
 * @param {object} gmail - Authenticated Gmail API client
 * @param {string} messageId - Gmail message ID
 * @param {{userId?: string}} [options] - `userId` paces the call against that user's quota budget
 * @returns {Promise<object>} { subject, from, body, metadata: { id, internalDate } }
 */
async function fetchEmailContent(gmail, messageId, { userId } = {}) {
  const msgData = await quota.spend(userId, quota.COST.messagesGet, () => withGoogleRetry(
    () => gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' }),
    `messages.get ${messageId}`,
  ));

  const payload = msgData.data.payload;
  const subjectHeader = payload.headers?.find(h => h.name.toLowerCase() === 'subject');
  const fromHeader = payload.headers?.find(h => h.name.toLowerCase() === 'from');

  return {
    subject: subjectHeader?.value || '',
    from: fromHeader?.value || '',
    body: extractEmailBody(payload),
    metadata: {
      id: messageId,
      internalDate: msgData.data.internalDate,
    },
  };
}

module.exports = {
  MAX_LIST_PAGES,
  formatGmailQueryDate,
  getSyncCutoffDate,
  createOAuth2Client,
  invalidateOAuth2Client,
  withGoogleRetry,
  fetchEmailList,
  fetchEmailContent,
  buildFullQuery,
  buildIncrementalQuery,
};
