const Expense = require('../models/Expense');
const PendingTransaction = require('../models/PendingTransaction');
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
    const budgetTarget = config.app.expenseMonthlyBudget;
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

    // ── 7. Chart Data — last 7 days in IST ──
    const sevenDaysAgoIST = new Date(istNow);
    sevenDaysAgoIST.setDate(istNow.getDate() - 6);
    
    const startOfChartRange = new Date(`${sevenDaysAgoIST.getFullYear()}-${String(sevenDaysAgoIST.getMonth() + 1).padStart(2, '0')}-${String(sevenDaysAgoIST.getDate()).padStart(2, '0')}T00:00:00.000+05:30`);

    // Fetch 7-day expenses in a single query
    const weekExpenses = await Expense.find({
      user: userId,
      date: { $gte: startOfChartRange, $lte: now }
    });

    const chartLabels = [];
    const chartData = [];
    let weeklyTotal = 0;

    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfChartRange);
      d.setDate(d.getDate() + i);
      const dStart = new Date(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00.000+05:30`);
      const dEnd = new Date(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T23:59:59.999+05:30`);
      
      const dayTotal = weekExpenses
        .filter(e => e.date >= dStart && e.date <= dEnd)
        .reduce((sum, e) => sum + e.amount, 0);
        
      chartLabels.push(dStart.toLocaleDateString('en-US', { weekday: 'short' }));
      chartData.push(dayTotal);
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

exports.processPendingTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action, ...expenseData } = req.body; // action: 'approve' or 'ignore'

    const pending = await PendingTransaction.findOne({ _id: id, user: req.user.id });
    if (!pending) {
      return res.status(404).json({ status: 'error', message: 'Pending transaction not found' });
    }

    if (action === 'ignore') {
      pending.status = 'Rejected';
      await pending.save();
      return res.status(200).json({ status: 'success', message: 'Transaction ignored' });
    }

    if (action === 'approve') {
      pending.status = 'Approved';
      await pending.save();

      // Create actual expense
      const expense = await Expense.create({
        user: req.user.id,
        amount: expenseData.amount || pending.amount,
        merchant: expenseData.merchant || pending.merchant,
        category: expenseData.category || pending.category,
        paymentMethod: expenseData.paymentMethod || pending.paymentMethod,
        date: pending.date,
        tags: expenseData.tags || pending.tags,
        notes: expenseData.notes || pending.notes,
        gmailMessageId: pending.gmailMessageId
      });

      return res.status(201).json({ status: 'success', data: expense });
    }

    res.status(400).json({ status: 'error', message: 'Invalid action' });
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
    const user = await User.findById(req.user.id).select('+googleRefreshToken');

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
    const stats = await engine.processUserEmails(user);
    console.log('[SyncExpenses] Engine stats:', JSON.stringify(stats));

    // Google consent is gone — stop pretending the integration is live.
    if (stats.authExpired) {
      await User.findByIdAndUpdate(user._id, { gmailConnected: false, expenseAutomationEnabled: false });
      console.warn(`[SyncExpenses] Google credentials rejected for ${user.email}. Marked disconnected.`);
      return res.status(200).json({
        status: 'success',
        message: 'Gmail access has expired. Please reconnect your Gmail account.',
        data: { ...stats, reason: 'auth_expired' },
      });
    }

    if (!stats.ok) {
      return res.status(200).json({
        status: 'success',
        message: `Gmail sync failed: ${stats.error || 'unknown error'}`,
        data: stats,
      });
    }

    const message = stats.created > 0
      ? `Added ${stats.created} transaction${stats.created === 1 ? '' : 's'} for review.`
      : stats.processed > 0
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

    // If watch activation is needed when enabling automation
    if (user.gmailConnected && user.expenseAutomationEnabled) {
      try {
        const { activateWatch } = require('../automation/gmail/gmail-watch-manager');
        await activateWatch(user);
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

    const user = await User.findById(req.user.id).select('+googleRefreshToken');
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

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

    // Clear Gmail credentials and disable automation in db
    user.gmailConnected = false;
    user.googleRefreshToken = undefined;
    user.expenseAutomationEnabled = false;
    user.expenseAutomationBanks = [];
    user.gmailWatchExpiry = undefined;
    user.gmailHistoryId = undefined;
    await user.save();

    res.status(200).json({
      status: 'success',
      message: 'Gmail disconnected successfully'
    });
  } catch (error) {
    next(error);
  }
};
