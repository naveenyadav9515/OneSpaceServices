/**
 * Expense Processor — Deduplication and PendingTransaction creation.
 *
 * Receives parsed transaction objects from the engine and:
 * 1. Checks for duplicates using gmailMessageId (primary key)
 * 2. Checks for duplicates using amount+merchant+date (secondary, same-minute window)
 * 3. Creates PendingTransaction records for new, unique transactions
 */

const PendingTransaction = require('../../models/PendingTransaction');
const Expense = require('../../models/Expense');
const GmailSyncedMessage = require('../../models/GmailSyncedMessage');
const { GENERIC_MERCHANT } = require('../parsers/base-parser');

/**
 * Narrows a batch of Gmail message IDs down to the ones we have never resolved.
 *
 * This runs *before* any `messages.get`, which is the whole point: deduplication
 * used to happen after the download, so every sync paid full Gmail quota for
 * mail it was about to discard as a duplicate.
 *
 * Three sources are consulted, not just the ledger, so the first sync after this
 * change already skips everything previously recorded instead of re-fetching the
 * entire window once to rebuild the ledger from scratch.
 *
 * @param {string} userId
 * @param {string[]} messageIds
 * @returns {Promise<string[]>} the subset that still needs fetching, input order preserved
 */
async function filterUnprocessedMessageIds(userId, messageIds) {
  if (!messageIds.length) return [];

  const [ledger, pending, expenses] = await Promise.all([
    GmailSyncedMessage.find({ user: userId, messageId: { $in: messageIds } }).select('messageId').lean(),
    PendingTransaction.find({ user: userId, gmailMessageId: { $in: messageIds } }).select('gmailMessageId').lean(),
    Expense.find({ user: userId, gmailMessageId: { $in: messageIds } }).select('gmailMessageId').lean(),
  ]);

  const seen = new Set([
    ...ledger.map(d => d.messageId),
    ...pending.map(d => d.gmailMessageId),
    ...expenses.map(d => d.gmailMessageId),
  ]);

  return messageIds.filter(id => !seen.has(id));
}

/**
 * Records the engine's verdict for messages it has finished with.
 *
 * Best-effort: a ledger write that fails costs us a re-fetch next sync, which is
 * strictly better than failing a sync that otherwise succeeded. Duplicate-key
 * errors are expected whenever two syncs overlap and are not worth reporting.
 *
 * @param {string} userId
 * @param {Array<{id: string, outcome: string}>} entries
 * @returns {Promise<void>}
 */
async function recordProcessedMessages(userId, entries) {
  if (!entries.length) return;

  try {
    await GmailSyncedMessage.bulkWrite(
      entries.map(({ id, outcome }) => ({
        updateOne: {
          filter: { user: userId, messageId: id },
          update: { $set: { outcome: outcome || '', syncedAt: new Date() } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (err) {
    const writeErrors = err?.writeErrors || [];
    const allDuplicates = writeErrors.length > 0 && writeErrors.every(e => (e.err?.code ?? e.code) === 11000);
    if (err?.code === 11000 || allDuplicates) return;
    console.warn(`[ExpenseProcessor] Could not update the Gmail message ledger: ${err.message}`);
  }
}

/**
 * Checks if a transaction is a duplicate.
 * Uses two deduplication strategies:
 *   1. gmailMessageId (exact match — guaranteed unique per email)
 *   2. amount + merchant + date within the same minute window
 *
 * @param {string} userId - User's MongoDB ObjectId
 * @param {object} transaction - Parsed transaction { amount, merchant, date, gmailMessageId }
 * @returns {Promise<boolean>} true if duplicate
 */
async function isDuplicate(userId, transaction) {
  // Strategy 1: Check by Gmail Message ID (most reliable)
  if (transaction.gmailMessageId) {
    const byMessageId = await PendingTransaction.findOne({
      user: userId,
      gmailMessageId: transaction.gmailMessageId,
    });
    if (byMessageId) return true;

    // Also check Expense collection (in case it was already approved)
    const inExpenses = await Expense.findOne({
      user: userId,
      gmailMessageId: transaction.gmailMessageId,
    });
    if (inExpenses) return true;
  }

  // Strategy 2: Check by amount + merchant + same minute window.
  //
  // Only safe with a real merchant name. When extraction fell back to the
  // generic placeholder, this check would collapse two genuinely different
  // same-amount transactions in the same minute into one — so we skip it.
  // Such records still carry a gmailMessageId, so Strategy 1 covers them.
  if (!transaction.merchant || transaction.merchant === GENERIC_MERCHANT) {
    return false;
  }

  const minuteStart = new Date(transaction.date);
  minuteStart.setSeconds(0, 0);
  const minuteEnd = new Date(minuteStart.getTime() + 59999);

  const duplicateInHistory = await Expense.findOne({
    user: userId,
    amount: transaction.amount,
    merchant: transaction.merchant,
    date: { $gte: minuteStart, $lte: minuteEnd },
  });
  if (duplicateInHistory) return true;

  const duplicateInPending = await PendingTransaction.findOne({
    user: userId,
    amount: transaction.amount,
    merchant: transaction.merchant,
    date: { $gte: minuteStart, $lte: minuteEnd },
  });
  if (duplicateInPending) return true;

  return false;
}

/**
 * Creates a PendingTransaction from a parsed transaction.
 *
 * Returns null (rather than throwing) when the unique index rejects the insert,
 * which happens when a concurrent sync — e.g. the manual button racing a Pub/Sub
 * push — created the same record first. That is a duplicate, not an error.
 *
 * @param {string} userId - User's MongoDB ObjectId
 * @param {object} transaction - Parsed transaction data
 * @returns {Promise<object|null>} Created PendingTransaction document, or null if already present
 */
async function createPendingTransaction(userId, transaction) {
  try {
    return await createPendingTransactionUnsafe(userId, transaction);
  } catch (err) {
    if (err && err.code === 11000) return null;
    throw err;
  }
}

/**
 * Performs the actual insert. Split out so the duplicate-key guard above stays legible.
 * @param {string} userId
 * @param {object} transaction
 * @returns {Promise<object>}
 */
async function createPendingTransactionUnsafe(userId, transaction) {
  return PendingTransaction.create({
    user: userId,
    amount: transaction.amount,
    merchant: transaction.merchant,
    paymentMethod: transaction.paymentMethod || 'UPI',
    status: 'Pending',
    date: transaction.date,
    notes: transaction.rawSubject
      ? `Auto-detected from email: "${transaction.rawSubject.substring(0, 80)}"`
      : 'Auto-detected bank transaction',
    gmailMessageId: transaction.gmailMessageId,
    source: 'gmail_auto',
    bank: transaction.bank || 'Unknown',
    transactionType: transaction.transactionType || 'Debit',
    parsedSuccessfully: transaction.parsedSuccessfully !== false,
    rawSubject: transaction.rawSubject || '',
  });
}

module.exports = {
  isDuplicate,
  createPendingTransaction,
  filterUnprocessedMessageIds,
  recordProcessedMessages,
};
