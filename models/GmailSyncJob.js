const mongoose = require('mongoose');

/**
 * Durable queue of mailboxes waiting to be synced.
 *
 * Syncing used to run inline inside the Pub/Sub webhook. That made the trigger
 * as fragile as the request carrying it: a container restart mid-sync — routine
 * on Render — lost the notification outright, and Gmail never re-sends one. The
 * only recovery was the user noticing a missing transaction and pressing
 * Refresh.
 *
 * A row here survives the process. It also gives three things the inline path
 * could not:
 *
 *   - Coalescing. One row per user, claimed by `user`, so a burst of pushes for
 *     one mailbox collapses into a single run instead of a queue of identical
 *     scans.
 *   - Backpressure. While Google is rate-limiting, jobs simply sit until the
 *     cooldown lapses rather than being dropped on the floor.
 *   - Concurrency control. The worker leases a bounded number at a time, so 200
 *     simultaneous pushes cannot spawn 200 syncs on a small dyno.
 */

/**
 * How long a lease is honoured before another worker may steal the job.
 *
 * Must exceed the longest a healthy run can take — runs are capped at
 * `gmailSync.maxFetchesPerRun` messages, so seconds — and must be short enough
 * that a process killed mid-run does not strand the mailbox.
 */
const LEASE_TTL_MS = 5 * 60 * 1000;

/** Given up on after this many consecutive failures; the sweep re-queues it. */
const MAX_ATTEMPTS = 5;

const gmailSyncJobSchema = new mongoose.Schema({
  /**
   * Unique — this is what makes the queue coalescing rather than a backlog of
   * duplicate work.
   */
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },

  /**
   * Whether this run must scan the whole retention window.
   *
   * A sweep sets it and a push never clears it: if both are pending for one
   * user, the broader of the two has to win or the sweep's guarantee is quietly
   * downgraded to the push path's best effort.
   */
  full: {
    type: Boolean,
    default: false,
  },

  /** Diagnostic only — which trigger last touched this row. */
  reason: {
    type: String,
    default: 'push',
  },

  /** Earliest time a worker may pick this up. Carries the retry backoff. */
  dueAt: {
    type: Date,
    default: Date.now,
    index: true,
  },

  /**
   * Bumped by every enqueue, and compared on completion.
   *
   * A push arriving while the run it would have triggered is already in flight
   * must not be swallowed by that run's cleanup — the mail it is announcing may
   * have landed after the query was issued. The worker deletes the row only if
   * this value is unchanged since it leased it; otherwise the row survives and
   * runs again.
   */
  requestedAt: {
    type: Date,
    default: Date.now,
  },

  /** Held while a worker is running this job; null when idle. */
  leasedAt: {
    type: Date,
    default: null,
  },

  attempts: {
    type: Number,
    default: 0,
  },

  /** Why the last attempt failed, for operators reading the queue directly. */
  lastError: {
    type: String,
    default: null,
  },
}, { timestamps: true });

/** Drives the lease query: oldest-due first, skipping live leases. */
gmailSyncJobSchema.index({ dueAt: 1, leasedAt: 1 });

module.exports = mongoose.model('GmailSyncJob', gmailSyncJobSchema);
module.exports.LEASE_TTL_MS = LEASE_TTL_MS;
module.exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
