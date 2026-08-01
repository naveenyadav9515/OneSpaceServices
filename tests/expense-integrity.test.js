/**
 * Guards the correctness fixes around the expense automation flow.
 *
 * These cover invariants that were being asserted only in comments: the Gmail
 * message uniqueness index (which never built), the approval transition (which
 * could mark a transaction handled with no expense to show for it), and the
 * watch renewal sweep (which re-registered every mailbox on every restart).
 */

const db = require('./setup');
const mongoose = require('mongoose');

const Expense = require('../models/Expense');
const PendingTransaction = require('../models/PendingTransaction');
const User = require('../models/User');

beforeAll(async () => { await db.connect(); });
afterEach(async () => { await db.clearDatabase(); jest.clearAllMocks(); });
afterAll(async () => { await db.closeDatabase(); });

describe('Gmail message uniqueness', () => {
  // The index definition was `{ unique: true, sparse: true, partialFilterExpression:
  // { gmailMessageId: { $ne: null } } }` — two separate things MongoDB rejects, so
  // it silently never built and duplicates were possible.
  it('builds the Expense index instead of failing silently', async () => {
    // `init()` rejects when a schema index is invalid — exactly how the previous
    // definition failed. Reaching the assertions below means it built.
    await Expense.init();

    const indexes = await Expense.collection.indexes();
    const unique = indexes.find(i => i.unique && i.key?.gmailMessageId === 1);
    expect(unique).toBeDefined();
    expect(unique.partialFilterExpression).toEqual({ gmailMessageId: { $type: 'string' } });
  });

  it('refuses a second expense for the same Gmail message', async () => {
    await Expense.init();
    const user = new mongoose.Types.ObjectId();
    const row = { user, amount: 100, category: 'Food', merchant: 'Cafe', gmailMessageId: 'msg-1' };

    await Expense.create(row);
    await expect(Expense.create(row)).rejects.toMatchObject({ code: 11000 });
    expect(await Expense.countDocuments({ gmailMessageId: 'msg-1' })).toBe(1);
  });

  it('still allows unlimited manual expenses, which carry no message id', async () => {
    await Expense.init();
    const user = new mongoose.Types.ObjectId();
    const row = { user, amount: 100, category: 'Food', merchant: 'Cafe' };

    await Expense.create(row);
    await Expense.create(row);
    expect(await Expense.countDocuments({ user })).toBe(2);
  });
});

describe('pending transaction approval', () => {
  const controller = require('../controllers/expenseController');

  /** Minimal express doubles — enough to capture status and payload. */
  function mockRes() {
    const res = { statusCode: null, payload: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.payload = body; return res; };
    return res;
  }

  const run = (userId, id, body) => new Promise((resolve, reject) => {
    const res = mockRes();
    controller.processPendingTransaction(
      { params: { id }, body, user: { id: String(userId) } },
      res,
      (err) => reject(err),
    ).then(() => resolve(res), reject);
  });

  async function seedPending(userId, overrides = {}) {
    return PendingTransaction.create({
      user: userId, amount: 250, merchant: 'STARBUCKS', category: 'Food',
      date: new Date(), status: 'Pending', source: 'gmail_auto',
      gmailMessageId: 'msg-approve-1', ...overrides,
    });
  }

  it('creates the expense and marks the transaction approved', async () => {
    await Expense.init();
    const userId = new mongoose.Types.ObjectId();
    const pending = await seedPending(userId);

    const res = await run(userId, pending._id, { action: 'approve' });

    expect(res.statusCode).toBe(201);
    expect(await Expense.countDocuments({ user: userId })).toBe(1);
    expect((await PendingTransaction.findById(pending._id)).status).toBe('Approved');
  });

  it('does not create two expenses when the same approval arrives twice', async () => {
    await Expense.init();
    const userId = new mongoose.Types.ObjectId();
    const pending = await seedPending(userId);

    const [first, second] = await Promise.all([
      run(userId, pending._id, { action: 'approve' }),
      run(userId, pending._id, { action: 'approve' }),
    ]);

    expect(await Expense.countDocuments({ user: userId })).toBe(1);
    // One wins with 201; the loser is told it is already handled, not given a
    // duplicate or a 500.
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
  });

  it('restores the transaction to Pending when the expense cannot be written', async () => {
    // A negative amount fails Expense validation. Before the fix the row was
    // already flagged Approved, so it vanished from the pending list with no
    // expense recorded — the user simply lost it.
    await Expense.init();
    const userId = new mongoose.Types.ObjectId();
    const pending = await seedPending(userId);

    await expect(run(userId, pending._id, { action: 'approve', amount: -5 })).rejects.toBeDefined();

    expect(await Expense.countDocuments({ user: userId })).toBe(0);
    expect((await PendingTransaction.findById(pending._id)).status).toBe('Pending');
  });

  it('rejects an unknown action before touching the row', async () => {
    const userId = new mongoose.Types.ObjectId();
    const pending = await seedPending(userId);

    const res = await run(userId, pending._id, { action: 'destroy' });

    expect(res.statusCode).toBe(400);
    expect((await PendingTransaction.findById(pending._id)).status).toBe('Pending');
  });

  it('ignores a transaction without creating an expense', async () => {
    const userId = new mongoose.Types.ObjectId();
    const pending = await seedPending(userId);

    const res = await run(userId, pending._id, { action: 'ignore' });

    expect(res.statusCode).toBe(200);
    expect(await Expense.countDocuments({ user: userId })).toBe(0);
    expect((await PendingTransaction.findById(pending._id)).status).toBe('Rejected');
  });
});

describe('Gmail watch renewal', () => {
  jest.mock('../automation/gmail/gmail-monitor', () => ({
    ...jest.requireActual('../automation/gmail/gmail-monitor'),
    createOAuth2Client: jest.fn(() => ({})),
    withGoogleRetry: jest.fn(async (call) => call()),
  }));

  const watchManager = require('../automation/gmail/gmail-watch-manager');

  async function connectedUser(gmailWatchExpiry) {
    return User.create({
      firstName: 'W', lastName: 'User',
      email: `w${Math.random().toString(36).slice(2)}@example.com`,
      password: 'password123',
      gmailConnected: true, expenseAutomationEnabled: true,
      googleRefreshToken: 'encrypted', gmailWatchExpiry,
    });
  }

  it('leaves watches alone when they are nowhere near expiring', async () => {
    // This is the restart case: Render bounces the container, the sweep runs,
    // and every mailbox used to be re-registered for no reason.
    await connectedUser(new Date(Date.now() + 6 * 24 * 60 * 60 * 1000));
    const spy = jest.spyOn(watchManager, 'activateWatch');

    const stats = await watchManager.renewAllWatches();

    expect(spy).not.toHaveBeenCalled();
    expect(stats.renewed).toBe(0);
    expect(stats.notDue).toBe(1);
    spy.mockRestore();
  });

  it('treats a watch inside the threshold as due', async () => {
    await connectedUser(new Date(Date.now() + 60 * 60 * 1000));
    const due = await User.countDocuments({
      gmailConnected: true,
      gmailWatchExpiry: { $lte: new Date(Date.now() + watchManager.RENEWAL_THRESHOLD_MS) },
    });
    expect(due).toBe(1);
  });

  it('treats a user who has never been watched as due', async () => {
    await connectedUser(null);
    const due = await User.countDocuments({
      gmailConnected: true,
      $or: [{ gmailWatchExpiry: null }, { gmailWatchExpiry: { $exists: false } }],
    });
    expect(due).toBe(1);
  });
});
