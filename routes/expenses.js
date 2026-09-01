const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expenseController');
const { protect } = require('../middleware/auth');
const { syncLimiter } = require('../middleware/rate-limiter');

// All expense routes require authentication
router.use(protect);

router.get('/summary', expenseController.getExpenseSummary);
// Declared before '/:id' so these are never swallowed as an expense id.
router.patch('/budget', expenseController.updateBudget);
router.get('/categories', expenseController.getCategories);
router.put('/categories', expenseController.updateCategories);
router.patch('/categories/reassign', expenseController.reassignCategory);

router.get('/pending', expenseController.getPendingTransactions);
router.post('/pending/simulate', expenseController.simulateAutoLog);
router.post('/pending/:id', expenseController.processPendingTransaction);
// Throttled per user: each call starts a Gmail scan, so button-mashing spends
// Google quota rather than ours. Mounted after `protect` so req.user exists.
router.post('/sync', syncLimiter, expenseController.syncExpenses);

// Gmail Automation Settings
router.get('/automation/status', expenseController.getAutomationStatus);
router.patch('/automation/settings', expenseController.updateAutomationSettings);
router.post('/automation/disconnect', expenseController.disconnectGmail);

router.route('/')
  .post(expenseController.createExpense)
  .get(expenseController.getExpenses);

router.route('/:id')
  .put(expenseController.updateExpense)
  .delete(expenseController.deleteExpense);

module.exports = router;
