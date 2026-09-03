const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Expense = require('../models/Expense');
const PendingTransaction = require('../models/PendingTransaction');
const User = require('../models/User');
const expenseController = require('../controllers/expenseController');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Expense.deleteMany({});
  await PendingTransaction.deleteMany({});
  await User.deleteMany({});
});

describe('Transaction Merge Logic', () => {
  it('merges multiple expenses into a primary expense correctly', async () => {
    const user = await User.create({
      firstName: 'Test',
      lastName: 'User',
      email: 'merge-test@example.com',
      password: 'password123',
    });

    const exp1 = await Expense.create({
      user: user._id,
      title: 'Lunch at Cafe',
      amount: 250,
      category: 'Food',
      merchant: 'Cafe Mocha',
      paymentMethod: 'UPI',
      date: new Date('2026-08-01'),
      tags: ['food', 'lunch'],
      notes: 'Good coffee',
    });

    const exp2 = await Expense.create({
      user: user._id,
      title: 'Cafe Dessert',
      amount: 150,
      category: 'Food',
      merchant: 'Cafe Mocha',
      paymentMethod: 'UPI',
      date: new Date('2026-08-01'),
      tags: ['dessert', 'food'],
      notes: 'Brownie',
    });

    const exp3 = await Expense.create({
      user: user._id,
      title: 'Tip',
      amount: 50,
      category: 'Food',
      merchant: 'Cafe Mocha',
      paymentMethod: 'Cash',
      date: new Date('2026-08-01'),
      tags: ['tip'],
      notes: '',
    });

    const req = {
      user: { id: user._id.toString() },
      body: {
        primaryId: exp1._id.toString(),
        mergeIds: [exp2._id.toString(), exp3._id.toString()],
      },
    };

    let responseData = null;
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        responseData = data;
        return this;
      },
    };

    await expenseController.mergeExpenses(req, res, () => {});

    expect(res.statusCode).toBe(200);
    expect(responseData.status).toBe('success');
    expect(responseData.data.amount).toBe(450); // 250 + 150 + 50
    expect(responseData.data.title).toBe('Lunch at Cafe');
    expect(responseData.data.isManuallyEdited).toBe(true);

    // Tags should be combined
    expect(responseData.data.tags).toEqual(expect.arrayContaining(['food', 'lunch', 'dessert', 'tip']));

    // Secondary expenses should be deleted
    const remaining = await Expense.find({ user: user._id });
    expect(remaining.length).toBe(1);
    expect(remaining[0]._id.toString()).toBe(exp1._id.toString());
    expect(remaining[0].amount).toBe(450);
  });

  it('merges pending transactions into a primary pending transaction', async () => {
    const user = await User.create({
      firstName: 'Test',
      lastName: 'User 2',
      email: 'merge-pending-test@example.com',
      password: 'password123',
    });

    const p1 = await PendingTransaction.create({
      user: user._id,
      title: 'Swiggy Order',
      amount: 320,
      category: 'Food',
      merchant: 'Swiggy',
      paymentMethod: 'UPI',
      date: new Date(),
      status: 'Pending',
      tags: ['delivery'],
    });

    const p2 = await PendingTransaction.create({
      user: user._id,
      title: 'Swiggy Delivery Tip',
      amount: 40,
      category: 'Food',
      merchant: 'Swiggy',
      paymentMethod: 'UPI',
      date: new Date(),
      status: 'Pending',
      tags: ['tip'],
    });

    const req = {
      user: { id: user._id.toString() },
      body: {
        primaryId: p1._id.toString(),
        mergeIds: [p2._id.toString()],
      },
    };

    let responseData = null;
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        responseData = data;
        return this;
      },
    };

    await expenseController.mergePendingTransactions(req, res, () => {});

    expect(res.statusCode).toBe(200);
    expect(responseData.status).toBe('success');
    expect(responseData.data.amount).toBe(360); // 320 + 40

    // p1 updated, p2 marked as Rejected
    const updatedP1 = await PendingTransaction.findById(p1._id);
    expect(updatedP1.amount).toBe(360);
    expect(updatedP1.status).toBe('Pending');

    const updatedP2 = await PendingTransaction.findById(p2._id);
    expect(updatedP2.status).toBe('Rejected');
  });
});
