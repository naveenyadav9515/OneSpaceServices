const mongoose = require('mongoose');
const Expense = require('./models/Expense');
const User = require('./models/User');
const config = require('./config/index');

async function seed() {
  try {
    await mongoose.connect(config.db.uri);
    
    const users = await User.find();
    if (users.length === 0) throw new Error('No users found');

    await Expense.deleteMany({}); // Clear all expenses

    const categories = ['Food', 'Transport', 'Shopping', 'Utilities', 'Entertainment', 'Health', 'Other'];
    const merchants = ['Amazon', 'Starbucks', 'Uber', 'Electricity Board', 'Netflix', 'Walmart', 'Apple', 'Local Market', 'Pharmacy'];
    const paymentMethods = ['UPI', 'Credit Card', 'Debit Card', 'Cash'];

    let totalExpenses = [];

    for (const user of users) {
      const now = new Date();
      // Generate 120 expenses per user over the last 60 days
      for (let i = 0; i < 120; i++) {
        const randomDaysAgo = Math.floor(Math.random() * 60);
        const date = new Date();
        date.setDate(now.getDate() - randomDaysAgo);
        
        const cat = categories[Math.floor(Math.random() * categories.length)];
        
        // Calibrate amounts to hit ~25,000 per month (approx 800/day).
        // 120 expenses / 60 days = 2 expenses/day on average.
        // So average expense should be ~400.
        let amount = Math.floor(Math.random() * 300) + 50;
        
        if (cat === 'Utilities') amount = Math.floor(Math.random() * 2000) + 1000;
        if (cat === 'Shopping') amount = Math.floor(Math.random() * 3000) + 500;
        if (cat === 'Food') amount = Math.floor(Math.random() * 400) + 100;
        if (cat === 'Transport') amount = Math.floor(Math.random() * 200) + 50;

        const merch = merchants[Math.floor(Math.random() * merchants.length)];
        totalExpenses.push({
          user: user._id,
          title: merch,
          amount,
          category: cat,
          merchant: merch,
          paymentMethod: paymentMethods[Math.floor(Math.random() * paymentMethods.length)],
          date: date,
          tags: ['auto-seed']
        });
      }

      // Add a few hefty expenses strictly for THIS month to guarantee 60-90% budget (Budget = 30k)
      // E.g., Rent/Utilities 15000, Shopping 5000
      totalExpenses.push({ user: user._id, title: 'House Rent', amount: 15000, category: 'Utilities', merchant: 'Rent', paymentMethod: 'Net Banking', date: new Date(), tags: ['auto-seed', 'rent'] });
      totalExpenses.push({ user: user._id, title: 'Amazon Shopping', amount: 4500, category: 'Shopping', merchant: 'Amazon', paymentMethod: 'Credit Card', date: new Date(), tags: ['auto-seed'] });
      
      // Ensure data for today/yesterday for trends
      const yesterday = new Date();
      yesterday.setDate(now.getDate() - 1);
      totalExpenses.push({ user: user._id, title: 'Dinner with Friends', amount: 820, category: 'Food', merchant: 'Dinner', paymentMethod: 'UPI', date: new Date(), tags: ['auto-seed'] });
      totalExpenses.push({ user: user._id, title: 'Movie Tickets', amount: 1200, category: 'Entertainment', merchant: 'Movies', paymentMethod: 'Credit Card', date: yesterday, tags: ['auto-seed'] });
    }

    await Expense.insertMany(totalExpenses);
    console.log(`Successfully seeded ${totalExpenses.length} realistic expenses across ${users.length} users!`);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

seed();
