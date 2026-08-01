/**
 * Guards the Gmail quota fixes.
 *
 * The bug these cover: every sync re-downloaded every message in the lookback
 * window, and nothing serialised concurrent syncs or backed off after a 429. A
 * healthy account therefore rate-limited itself and the UI blamed Google.
 *
 * The Gmail transport is stubbed so the assertions are about *how many* calls
 * the engine makes, which is the thing that broke.
 */

const db = require('./setup');

jest.mock('../automation/gmail/gmail-monitor', () => {
  const actual = jest.requireActual('../automation/gmail/gmail-monitor');
  return {
    ...actual,
    createOAuth2Client: jest.fn(() => ({})),
    fetchEmailList: jest.fn(),
    fetchEmailContent: jest.fn(),
  };
});

const monitor = require('../automation/gmail/gmail-monitor');
const engine = require('../automation/engine');
const User = require('../models/User');
const GmailSyncedMessage = require('../models/GmailSyncedMessage');
const PendingTransaction = require('../models/PendingTransaction');
const { classifyGoogleError } = require('../utils/google-error.util');

/**
 * A debit alert the Axis parser recognises.
 * The body carries no date, so the parser falls back to Gmail's `internalDate` —
 * which keeps every fixture inside the sync window no matter when the suite runs.
 */
const debitAlert = (id, amount) => ({
  subject: `Debit alert! INR ${amount} debited`,
  from: 'Axis Bank <alerts@axis.bank.in>',
  body: `INR ${amount} has been debited from A/c no. XX1234 at STARBUCKS.`,
  metadata: { id, internalDate: String(Date.now()) },
});

/** Mail from the same sender that will never become a transaction. */
const promo = (id) => ({
  subject: 'Your monthly account statement is ready',
  from: 'Axis Bank <alerts@axis.bank.in>',
  body: 'Please find your statement attached.',
  metadata: { id, internalDate: String(Date.now()) },
});

/** Wires the stubbed transport to return `messages` and serve their content. */
function serveMailbox(messages) {
  monitor.fetchEmailList.mockResolvedValue(messages.map(m => ({ id: m.metadata.id })));
  monitor.fetchEmailContent.mockImplementation(async (_gmail, id) => {
    const found = messages.find(m => m.metadata.id === id);
    if (!found) throw new Error(`unexpected fetch for ${id}`);
    return found;
  });
}

async function makeUser(overrides = {}) {
  return User.create({
    firstName: 'Test',
    lastName: 'User',
    email: `u${Math.random().toString(36).slice(2)}@example.com`,
    password: 'password123',
    gmailConnected: true,
    expenseAutomationEnabled: true,
    googleRefreshToken: 'encrypted-token',
    ...overrides,
  });
}

beforeAll(async () => { await db.connect(); });
afterEach(async () => { await db.clearDatabase(); jest.clearAllMocks(); });
afterAll(async () => { await db.closeDatabase(); });

describe('Gmail quota consumption', () => {
  it('downloads each message once, no matter how many times sync runs', async () => {
    const user = await makeUser();
    serveMailbox([debitAlert('m1', 500), promo('m2'), debitAlert('m3', 250)]);

    const first = await engine.processUserEmails(user);
    expect(first.ok).toBe(true);
    expect(first.created).toBe(2);
    expect(monitor.fetchEmailContent).toHaveBeenCalledTimes(3);

    // The mailbox is unchanged. The old engine re-fetched all three, every time.
    monitor.fetchEmailContent.mockClear();
    const second = await engine.processUserEmails(user);

    expect(monitor.fetchEmailContent).not.toHaveBeenCalled();
    expect(second.ok).toBe(true);
    expect(second.created).toBe(0);
    expect(second.skipped.alreadySynced).toBe(3);
  });

  it('still downloads genuinely new mail after a previous sync', async () => {
    const user = await makeUser();
    serveMailbox([debitAlert('m1', 500)]);
    await engine.processUserEmails(user);

    monitor.fetchEmailContent.mockClear();
    serveMailbox([debitAlert('m1', 500), debitAlert('m2', 900)]);
    const result = await engine.processUserEmails(user);

    expect(monitor.fetchEmailContent).toHaveBeenCalledTimes(1);
    expect(monitor.fetchEmailContent).toHaveBeenCalledWith(expect.anything(), 'm2');
    expect(result.created).toBe(1);
  });

  it('remembers messages that produced nothing, so they are not re-fetched', async () => {
    // These are the expensive ones: they leave no PendingTransaction, so before
    // the ledger existed they were downloaded in full on every single sync.
    const user = await makeUser();
    serveMailbox([promo('p1'), promo('p2')]);

    await engine.processUserEmails(user);
    expect(await PendingTransaction.countDocuments({ user: user._id })).toBe(0);
    expect(await GmailSyncedMessage.countDocuments({ user: user._id })).toBe(2);

    monitor.fetchEmailContent.mockClear();
    await engine.processUserEmails(user);
    expect(monitor.fetchEmailContent).not.toHaveBeenCalled();
  });

  it('rebuilds skip state from existing transactions, without a ledger entry', async () => {
    // Covers the first sync after deploy: the ledger is empty but the mail was
    // already recorded, and re-downloading all of it is what triggers the 429.
    const user = await makeUser();
    await PendingTransaction.create({
      user: user._id, amount: 500, merchant: 'STARBUCKS',
      gmailMessageId: 'm1', source: 'gmail_auto', date: new Date(),
    });
    serveMailbox([debitAlert('m1', 500)]);

    const result = await engine.processUserEmails(user);

    expect(monitor.fetchEmailContent).not.toHaveBeenCalled();
    expect(result.skipped.alreadySynced).toBe(1);
  });

  it('records the ledger even when the sync aborts mid-walk', async () => {
    const user = await makeUser();
    monitor.fetchEmailList.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    monitor.fetchEmailContent
      .mockResolvedValueOnce(debitAlert('m1', 500))
      .mockRejectedValueOnce(Object.assign(new Error('Too many requests'), {
        response: { status: 429, data: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } } },
      }));

    const result = await engine.processUserEmails(user);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rate_limited');
    // m1 was paid for before the abort — losing that costs a re-download on the
    // retry, against the very quota that just ran out.
    const ledger = await GmailSyncedMessage.find({ user: user._id }).lean();
    expect(ledger.map(d => d.messageId)).toEqual(['m1']);
  });
});

describe('concurrency and backoff', () => {
  it('joins concurrent syncs for one user instead of racing them', async () => {
    const user = await makeUser();
    serveMailbox([debitAlert('m1', 500), debitAlert('m2', 700)]);

    const [a, b, c] = await Promise.all([
      engine.processUserEmails(user),
      engine.processUserEmails(user),
      engine.processUserEmails(user),
    ]);

    // One sync's worth of Gmail calls, not three.
    expect(monitor.fetchEmailList).toHaveBeenCalledTimes(1);
    expect(monitor.fetchEmailContent).toHaveBeenCalledTimes(2);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.created).toBe(2);
  });

  it('refuses to call Google while a cooldown is active', async () => {
    const user = await makeUser({ gmailRetryAfter: new Date(Date.now() + 4 * 60 * 1000) });
    serveMailbox([debitAlert('m1', 500)]);

    const result = await engine.processUserEmails(user);

    expect(monitor.fetchEmailList).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('syncs normally once the cooldown has passed', async () => {
    const user = await makeUser({ gmailRetryAfter: new Date(Date.now() - 1000) });
    serveMailbox([debitAlert('m1', 500)]);

    const result = await engine.processUserEmails(user);

    expect(result.ok).toBe(true);
    expect(result.created).toBe(1);
  });
});

describe('rate-limit classification', () => {
  it('reads Retry-After from a fetch Headers instance', () => {
    const failure = classifyGoogleError({
      message: 'Too many requests',
      response: { status: 429, headers: new Headers({ 'retry-after': '120' }), data: {} },
    });
    expect(failure.code).toBe('rate_limited');
    expect(failure.retryAfterMs).toBe(120000);
  });

  it('reads Retry-After from a plain header object', () => {
    const failure = classifyGoogleError({
      message: 'Too many requests',
      response: { status: 429, headers: { 'retry-after': '90' }, data: {} },
    });
    expect(failure.retryAfterMs).toBe(90000);
  });

  it('reads the deadline Gmail embeds in the message when it sends no header', () => {
    // Gmail's real per-user 429 sends no Retry-After header at all — the
    // deadline is only in the text. Observed verbatim in production.
    const until = new Date(Date.now() + 14 * 60 * 1000).toISOString();
    const failure = classifyGoogleError({
      message: `User-rate limit exceeded.  Retry after ${until}`,
      response: {
        status: 429,
        data: { error: { code: 429, message: `User-rate limit exceeded.  Retry after ${until}`,
          errors: [{ reason: 'rateLimitExceeded' }] } },
      },
    });

    expect(failure.code).toBe('rate_limited');
    // Within a second of the stated deadline, not the 5-minute default guess.
    expect(failure.retryAfterMs).toBeGreaterThan(13.9 * 60 * 1000);
    expect(failure.retryAfterMs).toBeLessThan(14.1 * 60 * 1000);
  });

  it('ignores an embedded deadline that has already passed', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const failure = classifyGoogleError({
      message: `User-rate limit exceeded.  Retry after ${past}`,
      response: { status: 429, data: {} },
    });

    // Falls through to the default rather than returning a negative wait.
    expect(failure.retryAfterMs).toBe(5 * 60 * 1000);
  });

  it('prefers the Retry-After header over a deadline in the message', () => {
    const far = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const failure = classifyGoogleError({
      message: `Rate limited. Retry after ${far}`,
      response: { status: 429, headers: { 'retry-after': '45' }, data: {} },
    });

    expect(failure.retryAfterMs).toBe(45000);
  });

  it('falls back to a default cooldown when Google sends no hint', () => {
    const failure = classifyGoogleError({
      message: 'User Rate Limit Exceeded',
      response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } },
    });
    expect(failure.code).toBe('rate_limited');
    expect(failure.retryAfterMs).toBe(5 * 60 * 1000);
  });

  it('leaves non-rate-limit failures without a cooldown', () => {
    const failure = classifyGoogleError({
      message: 'Invalid Credentials',
      response: { status: 401, data: { error: { status: 'UNAUTHENTICATED' } } },
    });
    expect(failure.code).toBe('auth_expired');
    expect(failure.retryAfterMs).toBeNull();
  });
});
