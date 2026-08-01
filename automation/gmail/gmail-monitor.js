/**
 * Gmail Monitor — Gmail API fetch and email retrieval logic.
 *
 * Handles:
 * - OAuth2 client setup with refresh token decryption
 * - Email list fetching with pagination
 * - Individual email content retrieval
 * - Email body extraction using base-parser utilities
 *
 * Does NOT parse emails — that's the parser's job.
 */

const { google } = require('googleapis');
const config = require('../../config/index');
const { decryptSecret } = require('../../utils/crypto.util');
const { extractEmailBody } = require('../parsers/base-parser');
const { classifyGoogleError } = require('../../utils/google-error.util');

/** Safety cap on message-list pagination (100 messages per page). */
const MAX_LIST_PAGES = 20;

/** Attempts per Gmail call, including the first. */
const MAX_ATTEMPTS = 3;

/** Base delay for the exponential backoff between those attempts. */
const BACKOFF_BASE_MS = 1000;

/**
 * Formats a Date object into Gmail query format (YYYY/MM/DD).
 * @param {Date} date
 * @returns {string}
 */
function formatGmailQueryDate(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

/**
 * Calculates the sync cutoff date — the earlier of:
 *   a) start of the previous month in IST, and
 *   b) now minus GMAIL_SYNC_LOOKBACK_DAYS.
 *
 * Taking the earlier of the two means the configured lookback can only ever
 * widen the window, never silently narrow it below the month-based floor.
 * @returns {Date}
 */
function getSyncCutoffDate() {
  const now = new Date();
  const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istNow = new Date(utcTime + (3600000 * 5.5));

  let year = istNow.getFullYear();
  let prevMonth = istNow.getMonth() - 1;
  if (prevMonth < 0) {
    prevMonth = 11;
    year -= 1;
  }

  const startOfPrevMonth = new Date(`${year}-${String(prevMonth + 1).padStart(2, '0')}-01T00:00:00.000+05:30`);

  const lookbackDays = config.app.gmailSyncLookbackDays;
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) return startOfPrevMonth;

  const lookbackCutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return lookbackCutoff < startOfPrevMonth ? lookbackCutoff : startOfPrevMonth;
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
 * full hour and refresh it only when it actually expires.
 * @type {Map<string, {client: object, refreshToken: string, usedAt: number}>}
 */
const oauthClientCache = new Map();

/**
 * Most cached clients to keep.
 *
 * An unbounded cache is a slow memory leak: one entry per user who has ever
 * synced, each holding an access token, never released. The eviction order is
 * least-recently-used, and a miss costs only the token exchange this cache
 * exists to avoid — so a small ceiling is safe.
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
 * Creates — or reuses — an authenticated OAuth2 client for this user.
 *
 * The cached entry is discarded when the stored refresh token changes, so a
 * reconnect never keeps talking to Google with the credential it replaced.
 * @param {object} user - User document with googleRefreshToken
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
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  if (key) {
    oauthClientCache.set(key, { client: oauth2Client, refreshToken, usedAt: Date.now() });
    evictStaleClients();
  }
  return oauth2Client;
}

/**
 * Drops a user's cached client. Call on disconnect and on any fatal credential
 * failure — otherwise a revoked token keeps its cached access token until that
 * token expires, and the user sees "connected" behaviour from a dead grant.
 * @param {string} userId
 */
function invalidateOAuth2Client(userId) {
  oauthClientCache.delete(String(userId));
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
 * Fetches all matching emails from Gmail, handling pagination.
 * @param {object} gmail - Authenticated Gmail API client
 * @param {string} query - Gmail search query
 * @returns {Promise<Array<{id: string, threadId: string}>>} List of message stubs
 */
async function fetchEmailList(gmail, query) {
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

    const response = await withGoogleRetry(
      () => gmail.users.messages.list(listParams),
      `messages.list page ${pages + 1}`,
    );
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
 * @returns {Promise<object>} { subject, body, metadata: { id, internalDate } }
 */
async function fetchEmailContent(gmail, messageId) {
  const msgData = await withGoogleRetry(
    () => gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' }),
    `messages.get ${messageId}`,
  );

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

/**
 * Builds a Gmail search query for bank transaction emails.
 * @param {string[]} senderEmails - List of bank sender email addresses
 * @param {Date} cutoffDate - Only fetch emails after this date
 * @returns {string} Gmail API query string
 */
function buildQuery(senderEmails, cutoffDate) {
  const dateStr = formatGmailQueryDate(cutoffDate);
  if (senderEmails.length === 1) {
    return `after:${dateStr} from:${senderEmails[0]}`;
  }
  // Multiple senders: from:(addr1 OR addr2 OR addr3)
  return `after:${dateStr} from:(${senderEmails.join(' OR ')})`;
}

module.exports = {
  formatGmailQueryDate,
  getSyncCutoffDate,
  createOAuth2Client,
  invalidateOAuth2Client,
  withGoogleRetry,
  fetchEmailList,
  fetchEmailContent,
  buildQuery,
};
