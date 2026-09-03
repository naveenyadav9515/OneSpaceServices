const Expense = require('../models/Expense');
const PendingTransaction = require('../models/PendingTransaction');
const User = require('../models/User');
const config = require('../config/index');
const AppError = require('../utils/AppError');

exports.getExpenses = async (req, res, next) => {
  try {
    const rawExpenses = await Expense.find({ user: req.user.id }).sort({ date: -1 }).lean();
    const expenses = rawExpenses.map((exp) => ({
      ...exp,
      source: exp.source && exp.source !== 'manual' ? exp.source : (exp.gmailMessageId ? 'gmail_auto' : 'manual'),
    }));
    res.status(200).json({
      status: 'success',
      count: expenses.length,
      data: expenses,
    });
  } catch (error) {
    next(error);
  }
};

exports.getExpenseById = async (req, res, next) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, user: req.user.id });
    if (!expense) {
      return res.status(404).json({ status: 'error', message: 'Expense not found' });
    }
    res.status(200).json({
      status: 'success',
      data: expense,
    });
  } catch (error) {
    next(error);
  }
};

exports.createExpense = async (req, res, next) => {
  try {
    const { title, amount, category, merchant, tags, notes, date, paymentMethod } = req.body;
    
    const expense = await Expense.create({
      user: req.user.id,
      title: (title && title.trim()) || '',
      amount,
      category,
      merchant,
      tags,
      notes,
      date,
      paymentMethod,
      source: 'manual',
      isManuallyEdited: false,
    });

    res.status(201).json({
      status: 'success',
      data: expense,
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

const DEFAULT_CATEGORIES = [
  'Food & Dining',
  'Transport',
  'Shopping',
  'Utilities',
  'Entertainment',
  'Health',
  'Other',
];

/**
 * Get user's category list synchronized with MongoDB.
 */
exports.getCategories = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('expenseCategories').lean();
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    let categories = user.expenseCategories;

    // Only seed with initial defaults if expenseCategories is never set (null / undefined)
    if (categories === undefined || categories === null) {
      const [expenseCats, pendingCats] = await Promise.all([
        Expense.distinct('category', { user: req.user.id }),
        PendingTransaction.distinct('category', { user: req.user.id }),
      ]);

      const seen = new Set();
      const initial = [];

      // 1. Add defaults
      DEFAULT_CATEGORIES.forEach((name) => {
        seen.add(name.toLowerCase());
        initial.push({ name, shortName: '' });
      });

      // 2. Discover any custom categories from actual user expenses
      [...expenseCats, ...pendingCats].forEach((cat) => {
        if (cat && typeof cat === 'string' && cat.trim().length > 0) {
          const trimmed = cat.trim();
          if (!seen.has(trimmed.toLowerCase())) {
            seen.add(trimmed.toLowerCase());
            initial.push({ name: trimmed, shortName: '' });
          }
        }
      });

      categories = initial;

      // Persist initial array to database so subsequent updates/deletes are permanently preserved
      await User.findByIdAndUpdate(req.user.id, { $set: { expenseCategories: initial } });
    }

    // Ensure 'Other' is always present and placed at the very end
    const filtered = (categories || []).filter((c) => c && c.name && c.name.toLowerCase() !== 'other');
    const otherCat = (categories || []).find((c) => c && c.name && c.name.toLowerCase() === 'other') || { name: 'Other', shortName: '' };
    const result = [...filtered, otherCat];

    res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update user's category list across all devices.
 */
exports.updateCategories = async (req, res, next) => {
  try {
    const { categories } = req.body;
    if (!Array.isArray(categories)) {
      return res.status(400).json({ status: 'error', message: 'Categories must be an array' });
    }

    const sanitized = categories
      .filter((c) => c && typeof c.name === 'string' && c.name.trim().length > 0)
      .map((c) => ({
        name: c.name.trim(),
        shortName: typeof c.shortName === 'string' ? c.shortName.trim() : '',
      }));

    const hasOther = sanitized.some((c) => c.name.toLowerCase() === 'other');
    if (!hasOther) {
      sanitized.push({ name: 'Other', shortName: '' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: { expenseCategories: sanitized } },
      { new: true, runValidators: true }
    ).select('expenseCategories').lean();

    res.status(200).json({
      status: 'success',
      data: user.expenseCategories,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Move every transaction from one category to another.
 *
 * Backs both renaming and deleting a category on the client. Categories are a
 * client-side list, but the transactions carrying them are not — without this
 * a deleted category would leave its expenses pointing at a name that no
 * longer exists, and they would quietly vanish from every breakdown. Pending
 * rows are moved too, so a queued Gmail transaction does not reintroduce the
 * dead name when it is approved.
 */
exports.reassignCategory = async (req, res, next) => {
  try {
    const from = typeof req.body.from === 'string' ? req.body.from.trim() : '';
    const to = typeof req.body.to === 'string' ? req.body.to.trim() : '';

    if (!from || !to) {
      return res.status(400).json({ status: 'error', message: 'Both "from" and "to" categories are required.' });
    }

    if (from === to) {
      return res.status(200).json({ status: 'success', data: { expensesUpdated: 0, pendingUpdated: 0 } });
    }

    const [expenses, pending] = await Promise.all([
      Expense.updateMany({ user: req.user.id, category: from }, { $set: { category: to } }),
      PendingTransaction.updateMany({ user: req.user.id, category: from }, { $set: { category: to } }),
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        expensesUpdated: expenses.modifiedCount || 0,
        pendingUpdated: pending.modifiedCount || 0,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.updateExpense = async (req, res, next) => {
  try {
    const { title, amount, category, merchant, tags, notes, date, paymentMethod } = req.body;

    const updates = { title, amount, category, merchant, tags, notes, date, paymentMethod };
    // A field the client omitted should keep its stored value rather than being
    // written to undefined.
    Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);

    // Track that this transaction was modified manually
    updates.isManuallyEdited = true;
    updates.lastEditedAt = new Date();

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
};exports.getExpenseSummary = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    
    // Convert current UTC time to IST offset (UTC+5:30) for accurate boundary checks
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const istNow = new Date(utcTime + (3600000 * 5.5));
    const currentYear = istNow.getFullYear();
    const currentMonth = istNow.getMonth(); // 0-indexed

    // Determine target month and year from query params if provided
    let year = currentYear;
    let month = currentMonth; // 0-indexed

    if (req.query.year && !isNaN(parseInt(req.query.year, 10))) {
      year = parseInt(req.query.year, 10);
    }
    if (req.query.month && !isNaN(parseInt(req.query.month, 10))) {
      const qm = parseInt(req.query.month, 10);
      if (qm >= 1 && qm <= 12) {
        month = qm - 1; // Convert 1-12 to 0-11
      }
    }

    const isCurrentMonth = year === currentYear && month === currentMonth;
    const isPastMonth = year < currentYear || (year === currentYear && month < currentMonth);
    const isFutureMonth = year > currentYear || (year === currentYear && month > currentMonth);

    // ── 1. Time Boundaries (in IST, stored as UTC in Mongoose) ──
    const monthNumStr = String(month + 1).padStart(2, '0');
    const startOfMonth = new Date(`${year}-${monthNumStr}-01T00:00:00.000+05:30`);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const endOfMonth = new Date(`${year}-${monthNumStr}-${String(daysInMonth).padStart(2, '0')}T23:59:59.999+05:30`);
    
    let daysPassed = daysInMonth;
    let daysLeft = 0;
    let dayOfMonth = daysInMonth;

    if (isCurrentMonth) {
      daysPassed = Math.max(1, istNow.getDate());
      daysLeft = Math.max(0, daysInMonth - daysPassed);
      dayOfMonth = istNow.getDate();
    } else if (isFutureMonth) {
      daysPassed = 0;
      daysLeft = daysInMonth;
      dayOfMonth = 1;
    }

    // ── 2. Previous month boundaries (for trend comparison) ──
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const prevDaysInMonth = new Date(prevYear, prevMonth + 1, 0).getDate();
    const prevMonthNumStr = String(prevMonth + 1).padStart(2, '0');

    const startOfPrevMonth = new Date(`${prevYear}-${prevMonthNumStr}-01T00:00:00.000+05:30`);
    const endOfPrevMonth = new Date(`${prevYear}-${prevMonthNumStr}-${String(prevDaysInMonth).padStart(2, '0')}T23:59:59.999+05:30`);

    // ── 3. Fetch ONLY relevant expenses using MongoDB queries ──
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
    const budgetUser = await User.findById(userId).select('monthlyBudget').lean();
    const budgetTarget =
      budgetUser?.monthlyBudget != null && budgetUser.monthlyBudget > 0
        ? budgetUser.monthlyBudget
        : config.app.expenseMonthlyBudget;
    const budgetUsedPct = budgetTarget > 0 ? Math.round((monthlySpend / budgetTarget) * 100) : 0;

    // ── 6. Top Categories (from this month only) ──
    const categoryTotals = {};
    thisMonthExpenses.forEach(e => {
      categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount;
    });
    
    const topCategories = Object.keys(categoryTotals)
      .map(cat => ({
        name: cat,
        amount: categoryTotals[cat],
        percentage: monthlySpend === 0 ? 0 : Math.round((categoryTotals[cat] / monthlySpend) * 1000) / 10
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    // ── 7. Chart Data ──
    const IST_OFFSET_MS = 5.5 * 3600000;
    const istMidnight = (d) => new Date(d.getTime() - IST_OFFSET_MS);

    const chartLabels = [];
    const chartData = [];
    const chartDays = [];
    let weeklyTotal = 0;

    if (isCurrentMonth) {
      // Rolling 7 days ending today
      const istShadow = (offsetDays) =>
        new Date(Date.UTC(istNow.getFullYear(), istNow.getMonth(), istNow.getDate() + offsetDays));

      const startOfChartRange = istMidnight(istShadow(-6));
      const endOfChartRange = new Date(istMidnight(istShadow(1)).getTime() - 1);

      const weekExpenses = await Expense.find({
        user: userId,
        date: { $gte: startOfChartRange, $lte: endOfChartRange }
      });

      for (let offset = -6; offset <= 0; offset++) {
        const shadow = istShadow(offset);
        const dStart = istMidnight(shadow);
        const dEnd = new Date(istMidnight(istShadow(offset + 1)).getTime() - 1);

        const dayTotal = weekExpenses
          .filter(e => e.date >= dStart && e.date <= dEnd)
          .reduce((sum, e) => sum + e.amount, 0);

        const label = shadow.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

        chartLabels.push(label);
        chartData.push(dayTotal);
        chartDays.push({
          label,
          dayOfMonth: shadow.getUTCDate(),
          month: shadow.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
          date: dStart.toISOString(),
          amount: dayTotal,
          isToday: offset === 0,
          isFuture: false,
        });

        weeklyTotal += dayTotal;
      }
    } else {
      // Past or other month: 7 evenly spaced sample days / weeks across the month
      const sampleDays = [1, Math.min(5, daysInMonth), Math.min(10, daysInMonth), Math.min(15, daysInMonth), Math.min(20, daysInMonth), Math.min(25, daysInMonth), daysInMonth];
      for (const d of sampleDays) {
        const shadow = new Date(Date.UTC(year, month, d));
        const dStart = istMidnight(shadow);
        const dEnd = new Date(istMidnight(new Date(Date.UTC(year, month, d + 1))).getTime() - 1);

        const dayTotal = thisMonthExpenses
          .filter(e => e.date >= dStart && e.date <= dEnd)
          .reduce((sum, e) => sum + e.amount, 0);

        const label = `D${d}`;
        chartLabels.push(label);
        chartData.push(dayTotal);
        chartDays.push({
          label,
          dayOfMonth: d,
          month: shadow.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
          date: dStart.toISOString(),
          amount: dayTotal,
          isToday: false,
          isFuture: isFutureMonth,
        });
        weeklyTotal += dayTotal;
      }
    }

    // ── 7b. Month Daily totals ──
    const monthDaily = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dayStart = istMidnight(new Date(Date.UTC(year, month, day)));
      const dayEnd = new Date(istMidnight(new Date(Date.UTC(year, month, day + 1))).getTime() - 1);

      monthDaily.push(
        thisMonthExpenses
          .filter(e => e.date >= dayStart && e.date <= dayEnd)
          .reduce((sum, e) => sum + e.amount, 0)
      );
    }

    // ── 8. Trend calculation ──
    const prevDailyAvg = prevMonthSpend / prevDaysInMonth;
    const currentDailyAvg = daysPassed > 0 ? monthlySpend / daysPassed : 0;
    
    let trendPct = 0;
    let trendStatus = 'flat';
    if (prevDailyAvg > 0 && currentDailyAvg > 0) {
      trendPct = Math.round(((currentDailyAvg - prevDailyAvg) / prevDailyAvg) * 100);
      trendStatus = trendPct > 0 ? 'up' : trendPct < 0 ? 'down' : 'flat';
      trendPct = Math.abs(trendPct);
    }

    // ── 9. Forecast ──
    let estimatedSpend = monthlySpend;
    let statusText = '';
    let statusColor = 'var(--lm-color-success)';

    if (isPastMonth) {
      estimatedSpend = monthlySpend;
      const isOver = monthlySpend > budgetTarget;
      statusText = isOver 
        ? `Closed at ₹${monthlySpend.toLocaleString('en-IN')} (₹${(monthlySpend - budgetTarget).toLocaleString('en-IN')} over budget).`
        : `Closed at ₹${monthlySpend.toLocaleString('en-IN')} (₹${(budgetTarget - monthlySpend).toLocaleString('en-IN')} saved).`;
      statusColor = isOver ? 'var(--lm-color-error)' : 'var(--lm-color-success)';
    } else if (isCurrentMonth) {
      estimatedSpend = Math.round(currentDailyAvg * daysInMonth);
      const isHealthy = estimatedSpend <= budgetTarget;
      statusText = isHealthy ? "You're on track to stay within budget." : "You're projected to exceed your budget.";
      statusColor = isHealthy ? 'var(--lm-color-success)' : 'var(--lm-color-error)';
    } else {
      estimatedSpend = 0;
      statusText = 'Upcoming month';
      statusColor = 'var(--lm-color-text-secondary)';
    }
    
    // ── 10. Insight ──
    const prevCategoryTotals = {};
    prevMonthExpenses.forEach(e => {
      const catName = e.category || 'Other';
      prevCategoryTotals[catName] = (prevCategoryTotals[catName] || 0) + e.amount;
    });

    const topCat = topCategories[0]?.name || 'Other';
    const topCatThisMonth = categoryTotals[topCat] || 0;
    const topCatPrevMonth = prevCategoryTotals[topCat] || 0;
    
    let insightPct = 0;
    let insightText = '';
    if (topCatPrevMonth > 0) {
      insightPct = Math.round(((topCatThisMonth - topCatPrevMonth) / topCatPrevMonth) * 100);
      if (insightPct > 0) {
        insightText = `Spent ${insightPct}% more on ${topCat} compared to previous month.`;
      } else if (insightPct < 0) {
        insightText = `Reduced ${topCat} spending by ${Math.abs(insightPct)}% vs previous month.`;
      } else {
        insightText = `${topCat} spending was consistent with previous month.`;
      }
    } else if (topCatThisMonth > 0) {
      insightText = `${topCat} is top category at ₹${topCatThisMonth.toLocaleString('en-IN')}.`;
    } else {
      insightText = 'No expense records found for this period.';
    }

    const monthDate = new Date(year, month, 1);
    const monthName = monthDate.toLocaleDateString('en-US', { month: 'long' });

    res.status(200).json({
      status: 'success',
      data: {
        month: month + 1,
        year,
        monthName,
        isCurrentMonth,
        isPastMonth,
        isFutureMonth,
        monthlySpend,
        budgetTarget,
        budgetUsedPct,
        budgetStatus: monthlySpend <= budgetTarget ? 'Healthy' : 'At Risk',
        spent: monthlySpend,
        available: Math.max(0, budgetTarget - monthlySpend),
        daysLeft,
        daysInMonth,
        dayOfMonth,
        topCategories,
        spendingTrend: {
          labels: chartLabels,
          data: chartData,
          days: chartDays,
          weekStart: startOfMonth.toISOString(),
          weekEnd: endOfMonth.toISOString(),
          avgPerWeek: Math.round(weeklyTotal),
          trendPct,
          trendStatus
        },
        monthDaily,
        forecast: {
          estimatedSpend,
          statusText,
          statusColor
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
        title: expenseData.title || expenseData.merchant || pending.title || pending.merchant || 'Expense',
        amount: expenseData.amount ?? pending.amount,
        merchant: expenseData.merchant || pending.merchant,
        category: expenseData.category || pending.category,
        paymentMethod: expenseData.paymentMethod || pending.paymentMethod,
        date: pending.date,
        tags: expenseData.tags || pending.tags,
        notes: expenseData.notes || pending.notes,
        gmailMessageId: pending.gmailMessageId,
        source: pending.source || (pending.gmailMessageId ? 'gmail_auto' : 'manual'),
        isManuallyEdited: false,
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

    const { title, amount, merchant, paymentMethod, date } = req.body;
    
    // Simulate parsing email to a pending transaction
    const pending = await PendingTransaction.create({
      user: req.user.id,
      title: title || merchant || 'Simulated Merchant',
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
