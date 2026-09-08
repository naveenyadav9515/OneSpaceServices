const express = require('express');
const router = express.Router();
const nannaExpenseController = require('../controllers/nannaExpenseController');
const { protect } = require('../middleware/auth');

// All Nanna expense routes require authentication
router.use(protect);

router.route('/')
  .get(nannaExpenseController.getNannaExpenses)
  .post(nannaExpenseController.createNannaExpense);

router.route('/:id')
  .put(nannaExpenseController.updateNannaExpense)
  .delete(nannaExpenseController.deleteNannaExpense);

module.exports = router;
