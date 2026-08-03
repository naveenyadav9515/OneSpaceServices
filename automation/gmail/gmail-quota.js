/**
 * Per-user rate governor for Gmail calls, denominated in quota units.
 *
 * This replaces a fixed in-flight count. The old reasoning was that Gmail allows
 * 250 quota units per user per second and `messages.get` costs 5, so 50 requests
 * could be in flight and 5 was therefore an order of magnitude clear of the
 * limit. That conflates concurrency with rate: 250 units/second is a *rate*, and
 * a fixed pool only maps onto one via round-trip latency. Five workers against a
 * fast connection at ~200ms per call is 25 requests/second — 125 units/second,
 * half the ceiling, not a tenth of it. On a slow connection the same five
 * workers barely reach a tenth. The number was neither safe nor efficient; it
 * was just arbitrary.
 *
 * Pacing by units removes latency from the equation. Workers go as fast as the
 * network allows until they reach the configured units-per-second, and no
 * faster, whatever the concurrency happens to be.
 *
 * Implemented as a virtual-time reservation rather than a token count: each
 * caller is handed the instant its request may start, and the cursor advances by
 * the cost of that request. The bookkeeping is synchronous, so concurrent
 * callers cannot interleave into an over-issue — the failure mode a
 * read-then-write token counter has.
 */

const config = require('../../config/index');

/** Quota unit costs, from Google's published per-method table. */
const COST = {
  messagesList: 5,
  messagesGet: 5,
  watch: 100,
};

/**
 * Credit a caller may accumulate while idle, expressed as seconds of allowance.
 *
 * Without it, a mailbox that has been quiet for an hour still trickles its first
 * few requests out one pace-interval apart. Gmail's limit is a moving average,
 * so a short burst against a long idle period is exactly what it is designed to
 * absorb.
 */
const MAX_BURST_SECONDS = 2;

/** Most users tracked at once. Each entry is two numbers; the cap is for hygiene. */
const MAX_TRACKED_USERS = 1000;

/** @param {number} ms @returns {Promise<void>} */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** @type {Map<string, {availableAt: number}>} */
const buckets = new Map();

/** Units per second allowed per user; read once so tests can reason about it. */
function unitsPerSecond() {
  const configured = config.gmailSync?.quotaUnitsPerSecond;
  return Number.isFinite(configured) && configured > 0 ? configured : 100;
}

/**
 * Drop the least-recently-used entries once the map is over its ceiling.
 * `reserve` re-inserts on every hit, so insertion order is LRU order.
 */
function evict() {
  while (buckets.size > MAX_TRACKED_USERS) {
    const oldest = buckets.keys().next().value;
    buckets.delete(oldest);
  }
}

/**
 * Claims `units` of this user's budget and reports how long to wait first.
 *
 * Synchronous by design — see the file header. Callers should not use this
 * directly; `spend` is the ergonomic wrapper.
 *
 * @param {string} userId
 * @param {number} units
 * @returns {number} milliseconds to wait before issuing the request
 */
function reserve(userId, units) {
  const key = String(userId || 'anonymous');
  const now = Date.now();
  const perSecond = unitsPerSecond();

  const bucket = buckets.get(key) || { availableAt: now };
  buckets.delete(key);
  buckets.set(key, bucket);
  evict();

  // Idle credit is capped: a mailbox quiet for an hour may burst, but not
  // unboundedly, or the first sync after a long gap becomes the spike this
  // module exists to prevent.
  const earliest = now - MAX_BURST_SECONDS * 1000;
  if (bucket.availableAt < earliest) bucket.availableAt = earliest;

  const startAt = bucket.availableAt;
  bucket.availableAt = startAt + (units / perSecond) * 1000;

  return Math.max(0, startAt - now);
}

/**
 * Waits for this user's quota budget, then runs the call.
 *
 * @template T
 * @param {string} userId
 * @param {number} units cost of the call — use the `COST` table
 * @param {() => Promise<T>} call
 * @returns {Promise<T>}
 */
async function spend(userId, units, call) {
  const waitMs = reserve(userId, units);
  if (waitMs > 0) await sleep(waitMs);
  return call();
}

/**
 * Forgets a user's pacing state. Called on disconnect so a reconnect starts
 * clean rather than inheriting a cursor pushed into the future.
 * @param {string} userId
 */
function resetUser(userId) {
  buckets.delete(String(userId));
}

module.exports = {
  COST,
  spend,
  reserve,
  resetUser,
  unitsPerSecond,
};
