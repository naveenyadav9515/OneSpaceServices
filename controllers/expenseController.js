const Expense = require('../models/Expense');
const PendingTransaction = require('../models/PendingTransaction');
const User = require('../models/User');
const config = require('../config/index');
const AppError = require('../utils/AppError');

exports.getExpenses = async (req, res, next) => {
  try {
    const expenses = await Expense.find({ user: req.user.id }).sort({ date: -1 });
    res.status(200).json({
      status: 'success',
      count: expenses.length,
      data: expenses
    });
  } catch (error) {
    next(error);
  }
};

exports.createExpense = async (req, res, next) => {
  try {
    const { amount, category, merchant, tags, notes, date, paymentMethod } = req.body;
    
    const expense = await Expense.create({
      user: req.user.id,
      amount,
      category,
      merchant,
      tags,
      notes,
      date,
      paymentMethod
    });

    res.status(201).json({
      status: 'success',
      data: expense
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Edit an existing expense in place.
 *
 * Only the fields a user can actually change are copied across — spreading
 * req.body straight into the update would let a caller reassign `user` or
 * overwrite `gmailMessageId`, which is the key the sync engine uses to avoid
 * logging the same email twice. The `user` term in the filter is what scopes
 * the edit to the owner, exactly as deleteExpense does.
 */
/**
 * Set the signed-in user's monthly budget.
 *
 * Rejects anything that isn't a positive, finite number: the budget is a
 * divisor for budgetUsedPct and the safe-to-spend figure, so a zero or a
 * stray string would turn the whole summary into Infinity/NaN.
 */
exports.updateBudget = async (req, res, next) => {
  try {
    const value = Number(req.body.monthlyBudget);

    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Monthly budget must be a number greater than zero.',
      });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: { monthlyBudget: Math.round(value) } },
      { new: true, runValidators: true },
    ).select('monthlyBudget');

    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    res.status(200).json({ status: 'success', data: { monthlyBudget: user.monthlyBudget } });
  } catch (error) {
    next(error);
  }
};

exports.updateExpense = async (req, res, next) => {
  try {
    const { amount, category, merchant, tags, notes, date, paymentMethod } = req.body;

    const updates = { amount, category, merchant, tags, notes, date, paymentMethod };
    // A field the client omitted should keep its stored value rather than being
    // written to undefined.
    Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);

    const expense = await Expense.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $set: updates },
      { new: true, runValidators: true },
    );

    if (!expense) {
      return res.status(404).json({ status: 'error', message: 'Expense not found' });
    }

    res.status(200).json({ status: 'success', data: expense });
  } catch (error) {
    next(error);
  }
};

exports.deleteExpense = async (req, res, next) => {
  try {
    const expense = await Expense.findOneAndDelete({ _id: req.params.id, user: req.user.id });
    if (!expense) {
      return res.status(404).json({ status: 'error', message: 'Expense not found' });
    }
    res.status(200).json({ status: 'success', message: 'Expense deleted' });
  } catch (error) {
    next(error);
  }
};

exports.getExpenseSummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    
    // Convert current UTC time to IST offset (UTC+5:30) for accurate boundary checks
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istNow = new Date(utcTime + (3600000 * 5.5));
    const year = istNow.getFullYear();
    const month = istNow.getMonth(); // 0-indexed
    
    // ── 1. Time Boundaries (in IST, stored as UTC in Mongoose) ──
    const startOfMonth = new Date(`${year}-${String(month + 1).padStart(2, '0')}-01T00:00:00.000+05:30`);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const endOfMonth = new Date(`${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}T23:59:59.999+05:30`);
    
    const daysPassed = Math.max(1, istNow.getDate());
    const daysLeft = Math.max(0, daysInMonth - daysPassed);

    // ── 2. Previous month boundaries (for trend comparison) ──
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const prevDaysInMonth = new Date(prevYear, prevMonth + 1, 0).getDate();

    const startOfPrevMonth = new Date(`${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-01T00:00:00.000+05:30`);
    const endOfPrevMonth = new Date(`${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(prevDaysInMonth).padStart(2, '0')}T23:59:59.999+05:30`);

    // ── 3. Fetch ONLY relevant expenses using MongoDB queries (not all expenses!) ──
    const thisMonthExpenses = await Expense.find({
      user: userId,
      date: { $gte: startOfMonth, $lte: endOfMonth }
    });

    const prevMonthExpenses = await Expense.find({
      user: userId,
      date: { $gte: startOfPrevMonth, $lte: endOfPrevMonth }
    });

    // ── 4. Calculate monthly spend precisely ──
    const monthlySpend = thisMonthExpenses.reduce((sum, e) => sum + e.amount, 0);
    const prevMonthSpend = prevMonthExpenses.reduce((sum, e) => sum + e.amount, 0);

    // ── 5. Budget calculations ──
    // The user's own target. Accounts created before this was configurable have
    // null and keep the old shared default until they set one themselves.
    const budgetUser = await User.findById(userId).select('monthlyBudget').lean();
    const budgetTarget =
      budgetUser?.monthlyBudget != null && budgetUser.monthlyBudget > 0
        ? budgetUser.monthlyBudget
        : config.app.expenseMonthlyBudget;
    const budgetUsedPct = Math.min(100, Math.round((monthlySpend / budgetTarget) * 100));

    // ── 6. Top Categories (from this month only) ──
    const categoryTotals = {};
    thisMonthExpenses.forEach(e => {
      categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount;
    });
    
    const topCategories = Object.keys(categoryTotals)
      .map(cat => ({
        name: cat === 'Food' ? 'Food & Dining' : cat,
        amount: categoryTotals[cat],
        percentage: monthlySpend === 0 ? 0 : Math.round((categoryTotals[cat] / monthlySpend) * 1000) / 10
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    // ── 7. Chart Data — the current week, Sunday → Saturday, in IST ──
    // This was a rolling seven days ending today, which only lined up with the
    // calendar week when today happened to be a Saturday — on a Thursday it
    // read Fri…Thu and spanned two different weeks, so "this week's total"
    // included days from the previous one. Anchoring to Sunday makes the bars
    // and the weekly total describe the period the labels claim.
    const weekStartIST = new Date(istNow);
    weekStartIST.setDate(istNow.getDate() - istNow.getDay()); // getDay(): 0 = Sunday

    const startOfChartRange = new Date(`${weekStartIST.getFullYear()}-${String(weekStartIST.getMonth() + 1).padStart(2, '0')}-${String(weekStartIST.getDate()).padStart(2, '0')}T00:00:00.000+05:30`);

    // Through Saturday rather than `now`: the rest of the week still belongs to
    // it, those days simply have nothing in them yet.
    const weekEndIST = new Date(weekStartIST);
    weekEndIST.setDate(weekStartIST.getDate() + 6);
    const endOfChartRange = new Date(`${weekEndIST.getFullYear()}-${String(weekEndIST.getMonth() + 1).padStart(2, '0')}-${String(weekEndIST.getDate()).padStart(2, '0')}T23:59:59.999+05:30`);

    const weekExpenses = await Expense.find({
      user: userId,
      date: { $gte: startOfChartRange, $lte: endOfChartRange }
    });

    const chartLabels = [];
    const chartData = [];
    /**
     * Per-day detail for the trend chart. `labels`/`data` above stay as they
     * are, but a weekday initial alone can't say *which* Saturday, and the
     * client needs to know which day is today and which are still to come so
     * it can mark them rather than drawing them as genuine zeroes.
     */
    const chartDays = [];
    const todayKey = `${istNow.getFullYear()}-${istNow.getMonth()}-${istNow.getDate()}`;
    let weeklyTotal = 0;

    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfChartRange);
      d.setDate(d.getDate() + i);
      const dStart = new Date(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00.000+05:30`);
      const dEnd = new Date(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T23:59:59.999+05:30`);

      const dayTotal = weekExpenses
        .filter(e => e.date >= dStart && e.date <= dEnd)
        .reduce((sum, e) => sum + e.amount, 0);

      const isToday = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` === todayKey;

      chartLabels.push(dStart.toLocaleDateString('en-US', { weekday: 'short' }));
      chartData.push(dayTotal);
      chartDays.push({
        label: dStart.toLocaleDateString('en-US', { weekday: 'short' }),
        dayOfMonth: d.getDate(),
        month: dStart.toLocaleDateString('en-US', { month: 'short' }),
        date: dStart.toISOString(),
        amount: dayTotal,
        isToday,
        isFuture: dStart > istNow && !isToday,
      });

      weeklyTotal += dayTotal;
    }

    // ── 8. Real trend calculation ──
    // Compare current month's daily avg with previous month's daily avg
    const prevDailyAvg = prevMonthSpend / prevDaysInMonth;
    const currentDailyAvg = monthlySpend / daysPassed;
    
    let trendPct = 0;
    let trendStatus = 'flat';
    if (prevDailyAvg > 0) {
      trendPct = Math.round(((currentDailyAvg - prevDailyAvg) / prevDailyAvg) * 100);
      trendStatus = trendPct > 0 ? 'up' : trendPct < 0 ? 'down' : 'flat';
      trendPct = Math.abs(trendPct);
    }

    // ── 9. Forecast ──
    const estimatedSpend = Math.round(currentDailyAvg * daysInMonth);
    const isHealthy = estimatedSpend <= budgetTarget;
    
    // ── 10. Real Insight — find category with highest spend vs prev month ──
    const prevCategoryTotals = {};
    prevMonthExpenses.forEach(e => {
      const catName = e.category === 'Food' ? 'Food & Dining' : e.category;
      prevCategoryTotals[catName] = (prevCategoryTotals[catName] || 0) + e.amount;
    });

    const topCat = topCategories[0]?.name || 'Food & Dining';
    const topCatThisMonth = categoryTotals[topCat === 'Food & Dining' ? 'Food' : topCat] || 0;
    const topCatPrevMonth = prevCategoryTotals[topCat] || 0;
    
    let insightPct = 0;
    let insightText = '';
    if (topCatPrevMonth > 0) {
      insightPct = Math.round(((topCatThisMonth - topCatPrevMonth) / topCatPrevMonth) * 100);
      if (insightPct > 0) {
        insightText = `You're spending ${insightPct}% more on ${topCat} compared to last month.`;
      } else if (insightPct < 0) {
        insightText = `Great job! You've reduced ${topCat} spending by ${Math.abs(insightPct)}% vs last month.`;
      } else {
        insightText = `Your ${topCat} spending is consistent with last month.`;
      }
    } else if (topCatThisMonth > 0) {
      insightText = `${topCat} is your top category this month at ₹${topCatThisMonth.toLocaleString('en-IN')}.`;
    } else {
      insightText = 'Start logging expenses to get spending insights!';
    }

    res.status(200).json({
      status: 'success',
      data: {
        monthlySpend,
        budgetTarget,
        budgetUsedPct,
        budgetStatus: isHealthy ? 'Healthy' : 'At Risk',
        spent: monthlySpend,
        available: Math.max(0, budgetTarget - monthlySpend),
        daysLeft,
        daysInMonth,
        topCategories,
        spendingTrend: {
          labels: chartLabels,
          data: chartData,
          days: chartDays,
          weekStart: startOfChartRange.toISOString(),
          weekEnd: endOfChartRange.toISOString(),
          avgPerWeek: Math.round(weeklyTotal),
          trendPct,
          trendStatus
        },
        forecast: {
          estimatedSpend,
          statusText: isHealthy ? "You're on track to stay within budget." : "You're projected to exceed your budget.",
          statusColor: isHealthy ? 'var(--lm-color-success)' : 'var(--lm-color-error)'
        },
        insight: {
          highlightPct: `${Math.abs(insightPct)}%`,
          highlightCategory: topCat,
          text: insightText
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.getPendingTransactions = async (req, res, next) => {
  try {
    const pending = await PendingTransaction.find({ user: req.user.id, status: 'Pending' }).sort({ date: -1 });
    res.status(200).json({
      status: 'success',
      count: pending.length,
      data: pending
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Approve a detected transaction into an expense, or reject it
 * @route   POST /api/expenses/pending/:id
 * @access  Private
 *
 * The status change is a conditional update rather than read-then-write, so two
 * clients approving the same row (a double tap, or two devices) cannot both pass
 * the check. Whoever loses the race is told it is already handled.
 */
exports.processPendingTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action, ...expenseData } = req.body; // action: 'approve' or 'ignore'

    if (action !== 'approve' && action !== 'ignore') {
      return res.status(400).json({ status: 'error', message: 'Invalid action' });
    }

    const nextStatus = action === 'approve' ? 'Approved' : 'Rejected';

    // Claim the row: only a transaction still Pending can be acted on.
    const pending = await PendingTransaction.findOneAndUpdate(
      { _id: id, user: req.user.id, status: 'Pending' },
      { $set: { status: nextStatus } },
      { new: true },
    );

    if (!pending) {
      // Either it never existed or someone already dealt with it. Distinguish
      // the two so a double tap does not look like a missing record.
      const exists = await PendingTransaction.exists({ _id: id, user: req.user.id });
      return exists
        ? res.status(409).json({ status: 'error', message: 'This transaction has already been reviewed.' })
        : res.status(404).json({ status: 'error', message: 'Pending transaction not found' });
    }

    if (action === 'ignore') {
      return res.status(200).json({ status: 'success', message: 'Transaction ignored' });
    }

    try {
      const expense = await Expense.create({
        user: req.user.id,
        amount: expenseData.amount ?? pending.amount,
        merchant: expenseData.merchant || pending.merchant,
        category: expenseData.category || pending.category,
        paymentMethod: expenseData.paymentMethod || pending.paymentMethod,
        date: pending.date,
        tags: expenseData.tags || pending.tags,
        notes: expenseData.notes || pending.notes,
        gmailMessageId: pending.gmailMessageId,
      });

      return res.status(201).json({ status: 'success', data: expense });
    } catch (createErr) {
      // The expense for this Gmail message already exists — an earlier approval
      // got as far as creating it. The row is genuinely approved, so leave the
      // status alone and return what is already recorded.
      if (createErr?.code === 11000 && pending.gmailMessageId) {
        const existing = await Expense.findOne({ user: req.user.id, gmailMessageId: pending.gmailMessageId });
        if (existing) return res.status(200).json({ status: 'success', data: existing });
      }

      // Anything else (a validation failure on the edited amount, say) means no
      // expense was written. Marking the transaction Approved anyway would drop
      // it from the pending list with nothing to show for it — the user would
      // simply lose the record. Put it back so it can be reviewed again.
      await PendingTransaction.findOneAndUpdate(
        { _id: id, user: req.user.id, status: 'Approved' },
        { $set: { status: 'Pending' } },
      );
      console.error(`[Expenses] Approval failed for pending ${id}; restored to Pending:`, createErr.message);
      throw createErr;
    }
  } catch (error) {
    next(error);
  }
};

// Automatic log feature simulator (Mocking Gmail parser)
exports.simulateAutoLog = async (req, res, next) => {
  try {
    if (config.env === 'production') {
      return next(AppError.notFound('Route'));
    }

    const { amount, merchant, paymentMethod, date } = req.body;
    
    // Simulate parsing email to a pending transaction
    const pending = await PendingTransaction.create({
      user: req.user.id,
      amount: amount || Math.floor(Math.random() * 1000) + 100,
      merchant: merchant || 'Simulated Merchant',
      paymentMethod: paymentMethod || 'UPI',
      date: date || new Date(),
      status: 'Pending'
    });

    res.status(201).json({
      status: 'success',
      data: pending
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    On-demand synchronization of Gmail bank alerts (alternative to Pub/Sub)
 * @route   POST /api/expenses/sync
 * @access  Private
 *
 * Always responds 200 with a structured outcome so the client can distinguish
 * "nothing new" from "not connected" from "your Google consent expired".
 * Reporting every one of those as a bare success is what made a revoked token
 * look identical to an empty inbox.
 */
exports.syncExpenses = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.user.id).select('+googleRefreshToken +gmailAccessToken');

    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    console.log(`[SyncExpenses] User: ${user.email}, gmailConnected: ${user.gmailConnected}, hasRefreshToken: ${!!user.googleRefreshToken}`);

    if (!user.gmailConnected || !user.googleRefreshToken) {
      // Self-heal a half-connected account: flagged as connected but no token to use.
      if (user.gmailConnected && !user.googleRefreshToken) {
        await User.findByIdAndUpdate(user._id, { gmailConnected: false, expenseAutomationEnabled: false });
        console.warn(`[SyncExpenses] ${user.email} was flagged connected with no refresh token — reset to disconnected.`);
      }

      return res.status(200).json({
        status: 'success',
        message: 'Gmail is not connected. Connect your Gmail account to sync bank alerts.',
        data: { ok: false, reason: 'not_connected', created: 0, duplicates: 0, processed: 0 },
      });
    }

    const engine = require('../automation/engine');
    const { recordGmailError, recordGmailSyncSuccess, failureFromStats } = require('../utils/gmail-state.util');

    // A person pressing Refresh is asking "are you sure you have everything?",
    // not "check for anything since your watermark". Run the full window — it is
    // one `messages.list` wider than the incremental path, and every message it
    // re-lists is filtered out by the ledger before costing anything.
    const stats = await engine.processUserEmails(user, { mode: 'full', reason: 'manual' });
    console.log('[SyncExpenses] Engine stats:', JSON.stringify(stats));

    if (!stats.ok) {
      const failure = failureFromStats(stats);
      await recordGmailError(user._id, failure);

      // Only a genuinely dead credential justifies tearing down the connection.
      // Rate limits, a disabled Gmail API, and network blips are transient —
      // disconnecting on those is what forced users into a reconnect loop.
      if (failure.fatal) {
        const { invalidateOAuth2Client } = require('../automation/gmail/gmail-monitor');
        invalidateOAuth2Client(user._id);
        await User.findByIdAndUpdate(user._id, { gmailConnected: false, expenseAutomationEnabled: false });
        console.warn(`[SyncExpenses] Google credentials rejected for ${user.email} (${failure.code}). Marked disconnected.`);
      } else {
        console.error(`[SyncExpenses] Sync failed for ${user.email} (${failure.code}): ${failure.message}`);
      }

      return res.status(200).json({
        status: 'success',
        message: failure.message,
        data: { ...stats, reason: failure.code },
      });
    }

    await recordGmailSyncSuccess(user._id);

    // The run hit its per-run fetch cap. Hand the remainder to the worker rather
    // than telling the user to press the button again — the queue drains it in
    // the background and the pending list fills in on its own.
    if (stats.remaining > 0) {
      const { enqueueSync } = require('../automation/gmail/sync-queue');
      await enqueueSync(user._id, { full: true, reason: 'backlog' });
    }

    // `processed` counts only messages this run actually downloaded — anything
    // resolved by an earlier sync is filtered out before Gmail is called. Reading
    // "nothing new" off `processed` alone would therefore report a mailbox full of
    // already-recorded alerts as an empty one.
    const seen = stats.processed + (stats.skipped?.alreadySynced || 0);
    const message = stats.created > 0
      ? `Added ${stats.created} transaction${stats.created === 1 ? '' : 's'} for review.`
      : seen > 0
        ? 'No new transactions — everything found was already recorded.'
        : 'No bank emails found in the sync window.';

    return res.status(200).json({ status: 'success', message, data: stats });
  } catch (error) {
    console.error('[SyncExpenses] Error:', error);
    next(error);
  }
};

/**
 * @desc    Get current Gmail automation status
 * @route   GET /api/expenses/automation/status
 * @access  Private
 */
exports.getAutomationStatus = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const { getSupportedBanks } = require('../automation/parsers/parser-registry');
    
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    res.status(200).json({
      status: 'success',
      data: {
        gmailConnected: user.gmailConnected,
        expenseAutomationEnabled: user.expenseAutomationEnabled,
        enabledBanks: user.expenseAutomationBanks || [],
        supportedBanks: getSupportedBanks()
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update Gmail automation settings
 * @route   PATCH /api/expenses/automation/settings
 * @access  Private
 */
exports.updateAutomationSettings = async (req, res, next) => {
  try {
    const { expenseAutomationEnabled, enabledBanks } = req.body;
    const User = require('../models/User');
    
    const updateData = {};
    if (typeof expenseAutomationEnabled === 'boolean') {
      updateData.expenseAutomationEnabled = expenseAutomationEnabled;
    }
    if (Array.isArray(enabledBanks)) {
      updateData.expenseAutomationBanks = enabledBanks;
    }

    const user = await User.findByIdAndUpdate(req.user.id, updateData, { new: true });
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    // Register push notifications only when this user has no current watch.
    // Re-registering on every settings save spent a `users.watch` call per click
    // to replace a subscription that was already live.
    if (user.gmailConnected && user.expenseAutomationEnabled) {
      try {
        const { ensureWatch } = require('../automation/gmail/gmail-watch-manager');
        const registered = await ensureWatch(user);
        if (registered) console.log(`[Gmail Setup] Registered push notifications for ${user.email}`);
      } catch (watchErr) {
        console.error(`[Gmail Setup] Failed to re-activate push notifications for ${user.email}:`, watchErr.message);
      }
    }

    res.status(200).json({
      status: 'success',
      message: 'Automation settings updated successfully',
      data: {
        gmailConnected: user.gmailConnected,
        expenseAutomationEnabled: user.expenseAutomationEnabled,
        enabledBanks: user.expenseAutomationBanks
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Disconnect Gmail integration
 * @route   POST /api/expenses/automation/disconnect
 * @access  Private
 */
exports.disconnectGmail = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const { OAuth2Client } = require('google-auth-library');
    const { decryptSecret } = require('../utils/crypto.util');
    const { invalidateOAuth2Client } = require('../automation/gmail/gmail-monitor');

    const user = await User.findById(req.user.id).select('+googleRefreshToken +gmailAccessToken');
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    // Drop the cached client first. Its access token stays valid for up to an
    // hour after revocation, so leaving it in place lets a disconnected account
    // keep syncing until that token happens to expire.
    invalidateOAuth2Client(user._id);

    // Anything already queued would otherwise be leased by the worker moments
    // from now and try to sync a mailbox the user has just disconnected.
    const { clearJobsForUser } = require('../automation/gmail/sync-queue');
    await clearJobsForUser(user._id);

    // Try to revoke the token with Google
    if (user.googleRefreshToken) {
      try {
        const refreshToken = decryptSecret(user.googleRefreshToken);
        const oauth2Client = new OAuth2Client(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET
        );
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        await oauth2Client.revokeToken(refreshToken);
        console.log(`[Gmail Disconnect] Revoked Google OAuth token for user ${user.email}`);
      } catch (revokeErr) {
        // Log but don't fail, we want to clear local credentials anyway
        console.warn(`[Gmail Disconnect] Warning: Google OAuth token revoke failed:`, revokeErr.message);
      }
    }

    // Clear Gmail credentials, cached tokens and all sync state. A reconnect has
    // to start from a clean slate: a stale watermark left behind would make the
    // first incremental run after reconnecting skip everything before it.
    user.gmailConnected = false;
    user.googleRefreshToken = undefined;
    user.gmailAccessToken = undefined;
    user.gmailAccessTokenExpiry = null;
    user.expenseAutomationEnabled = false;
    user.expenseAutomationBanks = [];
    user.gmailWatchExpiry = undefined;
    user.gmailHistoryId = undefined;
    user.gmailRetryAfter = null;
    user.gmailSyncWatermark = null;
    user.gmailSyncLockedAt = null;
    user.gmailLastPushAt = null;
    user.gmailLastSweepAt = null;
    user.gmailLastSweepMissed = 0;
    user.gmailWatchRepairedAt = null;
    await user.save();

    res.status(200).json({
      status: 'success',
      message: 'Gmail disconnected successfully'
    });
  } catch (error) {
    next(error);
  }
};
