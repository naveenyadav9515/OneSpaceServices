/**
 * Finds — and optionally removes — Gmail messages recorded more than once.
 *
 * Why this exists: both collections declare a unique index on
 * (user, gmailMessageId), and in production neither was necessarily built.
 *
 *   - Expense declared it with `sparse` alongside `partialFilterExpression`, and
 *     with `$ne` inside that filter. MongoDB accepts neither, so it never built.
 *   - PendingTransaction declares it correctly, but MongoDB refuses to build a
 *     unique index over data that already violates it — and duplicates were
 *     already there, created by the concurrent syncs the index was meant to stop.
 *
 * Either way the failure is silent: Mongoose reports an index build error on an
 * event nobody listens to, so the app starts up looking healthy with no index,
 * and the duplicate guard in the automation engine — which relies on catching
 * error 11000 — quietly does nothing.
 *
 * Run this before trusting either index.
 *
 * Usage:
 *   node checkExpenseDuplicates.js          # report only, changes nothing
 *   node checkExpenseDuplicates.js --fix    # keep the oldest of each group, delete the rest
 */

const mongoose = require('mongoose');
const config = require('./config/index');
const { ensureSrvResolvable } = require('./config/dns');

const APPLY = process.argv.includes('--fix');

/** Console-shaped logger, so config/dns can report through the same channel. */
const logger = { info: console.log, warn: console.warn, error: console.error };

/** Collections carrying a gmailMessageId that must be unique per user. */
const TARGETS = [
  { label: 'expenses', collection: 'expenses' },
  { label: 'pending transactions', collection: 'pendingtransactions' },
];

/**
 * Groups documents by (user, gmailMessageId), keeping only groups with more than
 * one member. Sorted oldest-first so index 0 of `ids` is always the keeper.
 * @param {string} collectionName
 * @returns {Promise<Array<{_id: object, ids: object[], count: number}>>}
 */
async function findDuplicateGroups(collectionName) {
  return mongoose.connection.db.collection(collectionName).aggregate([
    { $match: { gmailMessageId: { $type: 'string' } } },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: { user: '$user', gmailMessageId: '$gmailMessageId' },
        ids: { $push: '$_id' },
        amounts: { $push: '$amount' },
        statuses: { $push: '$status' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
}

/**
 * Reports, and optionally cleans, one collection.
 * @returns {Promise<number>} surplus rows still present afterwards
 */
async function processCollection({ label, collection }) {
  const groups = await findDuplicateGroups(collection);

  if (groups.length === 0) {
    console.log(`✅ ${label}: no duplicates — the unique index can build cleanly.\n`);
    return 0;
  }

  const extras = groups.reduce((sum, g) => sum + g.count - 1, 0);
  console.log(`⚠️  ${label}: ${groups.length} message(s) recorded more than once — ${extras} surplus row(s).`);

  for (const g of groups.slice(0, 20)) {
    const statuses = g.statuses?.filter(Boolean).join('/') || 'n/a';
    console.log(`     ${g._id.gmailMessageId} · user ${g._id.user} · ${g.count} copies · amounts ${g.amounts.join(', ')} · status ${statuses}`);
  }
  if (groups.length > 20) console.log(`     ... and ${groups.length - 20} more`);

  if (!APPLY) {
    console.log('');
    return extras;
  }

  const toDelete = groups.flatMap(g => g.ids.slice(1));
  const { deletedCount } = await mongoose.connection.db
    .collection(collection)
    .deleteMany({ _id: { $in: toDelete } });

  console.log(`   🧹 Deleted ${deletedCount} surplus row(s), keeping the oldest of each group.`);

  const remaining = await findDuplicateGroups(collection);
  console.log(remaining.length === 0
    ? '   ✅ No duplicates remain — the unique index can now build.\n'
    : `   ⚠️  ${remaining.length} group(s) still duplicated.\n`);

  return remaining.reduce((sum, g) => sum + g.count - 1, 0);
}

(async () => {
  await ensureSrvResolvable(config.db.uri, logger);
  await mongoose.connect(config.db.uri, { serverSelectionTimeoutMS: 10000 });

  console.log(`\nConnected to ${mongoose.connection.name}. Scanning for duplicate Gmail records...\n`);

  let outstanding = 0;
  for (const target of TARGETS) {
    outstanding += await processCollection(target);
  }

  if (!APPLY && outstanding > 0) {
    console.log('Report only — nothing was changed.');
    console.log('Re-run with --fix to keep the OLDEST row in each group and delete the rest.');
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('\n❌ Failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
