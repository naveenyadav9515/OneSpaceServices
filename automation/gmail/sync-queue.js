/**
 * Queue operations for Gmail sync jobs.
 *
 * Kept separate from the worker that drains it so the webhook — which only ever
 * enqueues — does not pull the engine and its dependencies into the request
 * path. See `models/GmailSyncJob` for why the queue exists at all.
 */

const GmailSyncJob = require('../../models/GmailSyncJob');

/** Backoff between attempts on a job that keeps failing. */
const RETRY_BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];

/**
 * Queues a sync for a user, merging with anything already queued for them.
 *
 * `full` is sticky: a sweep's request cannot be downgraded by a push arriving
 * afterwards, because the sweep is the mechanism that guarantees completeness
 * and a narrower run would not satisfy it. `dueAt` takes the earliest of the two,
 * so the most urgent trigger sets the schedule.
 *
 * @param {string} userId
 * @param {{full?: boolean, reason?: string, delayMs?: number}} [options]
 * @returns {Promise<void>}
 */
async function enqueueSync(userId, { full = false, reason = 'push', delayMs = 0 } = {}) {
  if (!userId) return;

  const dueAt = new Date(Date.now() + Math.max(0, delayMs));
  const update = {
    // Bumped on every request. The worker compares it on completion so a push
    // that arrives mid-run is not deleted along with the run it raced.
    $set: { requestedAt: new Date(), reason },
    $min: { dueAt },
    $setOnInsert: { attempts: 0, leasedAt: null },
  };

  // Only ever set `full`, never clear it — see the note above.
  if (full) update.$set.full = true;
  else update.$setOnInsert.full = false;

  try {
    await GmailSyncJob.updateOne({ user: userId }, update, { upsert: true });
  } catch (err) {
    // A concurrent upsert for the same user loses the unique-index race. The
    // winner's row already represents this request, so there is nothing to do.
    if (err?.code === 11000) return;
    throw err;
  }
}

/**
 * Claims the next due job, if there is one.
 *
 * Atomic find-and-update, so two workers — in this process or another container
 * — cannot lease the same row. A lease older than the TTL is treated as
 * abandoned, which is what recovers jobs from a process killed mid-run.
 *
 * @returns {Promise<object|null>} the leased job, or null when nothing is due
 */
async function leaseNextJob() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - GmailSyncJob.LEASE_TTL_MS);

  return GmailSyncJob.findOneAndUpdate(
    {
      dueAt: { $lte: now },
      $or: [
        { leasedAt: null },
        { leasedAt: { $exists: false } },
        { leasedAt: { $lt: staleBefore } },
      ],
    },
    { $set: { leasedAt: now }, $inc: { attempts: 1 } },
    { sort: { dueAt: 1 }, new: true },
  ).lean();
}

/**
 * Retires a finished job.
 *
 * The delete is conditional on `requestedAt` being untouched since the lease.
 * If a push arrived while the run was in flight, that push may be announcing
 * mail that landed after the query was issued — deleting the row would discard
 * the only record of it. In that case the row is released instead and runs
 * again immediately.
 *
 * @param {object} job the leased job
 * @returns {Promise<void>}
 */
async function completeJob(job) {
  const result = await GmailSyncJob.deleteOne({
    _id: job._id,
    requestedAt: job.requestedAt,
  });

  if (result.deletedCount === 0) {
    await GmailSyncJob.updateOne(
      { _id: job._id },
      { $set: { leasedAt: null, dueAt: new Date(), attempts: 0 } },
    );
  }
}

/**
 * Re-queues a job after a failed or deferred run.
 *
 * @param {object} job the leased job
 * @param {{delayMs?: number, error?: string}} [options] `delayMs` overrides the
 *   attempt-based backoff — used for a deferred backlog slice, which is not a
 *   failure and should resume at once.
 * @returns {Promise<void>}
 */
async function releaseJob(job, { delayMs = null, error = null } = {}) {
  if (delayMs === null && job.attempts >= GmailSyncJob.MAX_ATTEMPTS) {
    console.error(`[GmailQueue] Dropping job for user ${job.user} after ${job.attempts} attempts: ${error || 'unknown error'}. The next sweep will re-queue it.`);
    await GmailSyncJob.deleteOne({ _id: job._id });
    return;
  }

  const backoff = delayMs !== null
    ? delayMs
    : RETRY_BACKOFF_MS[Math.min(job.attempts - 1, RETRY_BACKOFF_MS.length - 1)];

  await GmailSyncJob.updateOne(
    { _id: job._id },
    {
      $set: {
        leasedAt: null,
        dueAt: new Date(Date.now() + backoff),
        lastError: error,
        // A deferred slice is progress, not a failure — clearing the counter
        // stops a long backlog from exhausting the attempt budget and being
        // dropped halfway through.
        ...(delayMs !== null ? { attempts: 0 } : {}),
      },
    },
  );
}

/** Removes any queued work for a user. Called on disconnect. */
async function clearJobsForUser(userId) {
  try {
    await GmailSyncJob.deleteMany({ user: userId });
  } catch (err) {
    console.warn(`[GmailQueue] Could not clear queued jobs: ${err.message}`);
  }
}

module.exports = {
  enqueueSync,
  leaseNextJob,
  completeJob,
  releaseJob,
  clearJobsForUser,
};
