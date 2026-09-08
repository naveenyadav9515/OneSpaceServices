const express = require('express');
const router = express.Router();
const nannaExpenseController = require('../controllers/nannaExpenseController');
const { protect } = require('../middleware/auth');

// All Nanna expense routes require authentication
router.use(protect);

// ── Month budget endpoints (must be before /:id to avoid swallowing 'budgets' as an id) ──
router.get('/budgets', nannaExpenseController.getMonthBudgets);
router.put('/budgets/:year/:month', nannaExpenseController.upsertMonthBudget);

// ── Expense CRUD ──
router.route('/')
  .get(nannaExpenseController.getNannaExpenses)
  .post(nannaExpenseController.createNannaExpense);

router.route('/:id')
  .put(nannaExpenseController.updateNannaExpense)
  .delete(nannaExpenseController.deleteNannaExpense);

module.exports = router;
