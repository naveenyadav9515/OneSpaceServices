const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true,
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    match: [/^\S+@\S+\.\S+$/, 'Please use a valid email address'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false, // Don't return password in queries by default
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },
  avatarUrl: String,
  gmailConnected: {
    type: Boolean,
    default: false,
  },
  googleRefreshToken: {
    type: String,
    select: false,
  },
  /**
   * The last access token Google issued, encrypted, with its expiry.
   *
   * A client holding only a refresh token must redeem it at the token endpoint
   * before its first API call. That cache used to live in process memory only,
   * so every container restart — routine on Render — forced one redemption per
   * user on their next sync. Google throttles redemptions per (client, user)
   * more aggressively than Gmail throttles reads, which made restarts, not
   * mailbox size, the likeliest cause of a 429.
   *
   * Persisting the token lets a cold process resume using it for the remainder
   * of its hour. It is a cache: losing it costs one redemption, never
   * correctness.
   */
  gmailAccessToken: {
    type: String,
    select: false,
  },
  gmailAccessTokenExpiry: {
    type: Date,
    default: null,
  },
  /**
   * The Gmail address that was actually authorised, which may differ from the
   * OneSpace login email. Pub/Sub notifications identify a mailbox by this
   * address, so matching on `email` alone silently drops their notifications.
   */
  gmailAddress: {
    type: String,
    lowercase: true,
    default: null,
    index: true,
  },
  /**
   * The user's own monthly spending budget.
   *
   * This used to be config.app.expenseMonthlyBudget — one EXPENSE_MONTHLY_BUDGET
   * env var shared by every account on the server, which meant a personal target
   * was neither personal nor changeable without a redeploy. Null means "never
   * set", so the summary can fall back to the old default for existing users
   * instead of showing them a budget of zero.
   */
  monthlyBudget: {
    type: Number,
    default: null,
    min: [0, 'Budget cannot be negative'],
  },
  expenseAutomationEnabled: {
    type: Boolean,
    default: false,
  },
  expenseAutomationBanks: {
    type: [String],
    default: [],
  },
  expenseCategories: {
    type: [{
      name: { type: String, required: true, trim: true },
      shortName: { type: String, trim: true, default: '' },
    }],
    default: undefined,
  },
  gmailWatchExpiry: {
    type: Date,
    default: null,
  },
  gmailHistoryId: {
    type: String,
    default: null,
  },
  /**
   * Scopes Google actually granted, as reported by the token response.
   *
   * Stored because Google's consent screen lets the user untick Gmail access
   * while still completing the flow — without this we cannot tell a genuinely
   * connected account from one that will 403 on every request.
   */
  gmailScopes: {
    type: [String],
    default: [],
  },
  gmailConnectedAt: {
    type: Date,
    default: null,
  },
  gmailLastSyncAt: {
    type: Date,
    default: null,
  },
  /**
   * Why the last Gmail operation failed, so the UI can say something better than
   * "not connected" — which is indistinguishable from "never connected" and is
   * exactly what left users re-authorising in a loop.
   */
  gmailLastError: {
    code: { type: String, default: null },
    message: { type: String, default: null },
    at: { type: Date, default: null },
  },
  /**
   * Do not call Google for this user before this time.
   *
   * Set from Google's `Retry-After`, or from a default cooldown when it sends
   * none. Without it, a rate-limited account kept syncing on every Pub/Sub push
   * and on every press of the Refresh button — each rejected call counting
   * against the same quota and pushing the recovery further out. Cleared on the
   * first successful sync.
   */
  gmailRetryAfter: {
    type: Date,
    default: null,
  },
  /**
   * Held while a sync is running for this user; null when idle.
   *
   * The engine also keeps an in-process guard, but that only covers one Node
   * process. A restart mid-sync, or a second instance, could still run a
   * concurrent scan of the same mailbox and double the quota spend. This claim
   * lives in the database, so it holds across both.
   *
   * Treated as stale (and reclaimable) once older than the engine's lock TTL —
   * otherwise a process that dies mid-sync would block the user permanently.
   */
  gmailSyncLockedAt: {
    type: Date,
    default: null,
  },
  /**
   * Start of the window the *incremental* (push-driven) query scans.
   *
   * Advanced only after a run that resolved every message it found, and always
   * set back by `gmailSync.overlapMinutes` so a late-delivered alert cannot fall
   * behind it. Purely an optimisation for narrowing the query — the periodic
   * full sweep re-reads the whole retention window regardless, so a wrong or
   * missing watermark costs latency, never a lost transaction.
   */
  gmailSyncWatermark: {
    type: Date,
    default: null,
  },
  /**
   * When Gmail last pushed a notification for this mailbox.
   *
   * A watch can die quietly: it lapses, or the user files bank alerts out of the
   * INBOX it subscribes to, and Google simply stops calling. Nothing in the
   * request path notices, because "no pushes" looks exactly like "no new mail".
   * Comparing this against what the sweep actually finds is what surfaces it.
   */
  gmailLastPushAt: {
    type: Date,
    default: null,
  },
  /** When the last reconciliation sweep completed for this user. */
  gmailLastSweepAt: {
    type: Date,
    default: null,
  },
  /**
   * Messages the last sweep found that the push path should already have caught.
   *
   * This is the miss-detector for the whole feature. In a healthy system it is
   * always 0; a non-zero value means real-time delivery is broken and the sweep
   * is the only thing still recording that user's transactions.
   */
  gmailLastSweepMissed: {
    type: Number,
    default: 0,
  },
  /**
   * When a watch was last re-registered because it had stopped delivering.
   *
   * Google asks that `users.watch` be called at most about once a day per
   * mailbox, and the repair below fires off a condition that can persist across
   * several sweeps, so it needs its own throttle rather than reusing the
   * expiry-driven renewal schedule.
   */
  gmailWatchRepairedAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

// Pre-save hook to hash passwords before saving to the database
userSchema.pre('save', async function() {
  // Only hash if the password was modified or is new
  if (!this.isModified('password')) return;
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to verify passwords during login
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
