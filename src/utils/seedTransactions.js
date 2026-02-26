/**
 * Seed Transactions Script
 * Creates 400 test transactions (300 expenses, 100 income) for testing
 */

const mongoose = require('mongoose');
require('dotenv').config();
const User = require('../models/User');
const Category = require('../models/Category');
const Expense = require('../models/Expense');
const Income = require('../models/Income');

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
    process.exit(1);
  }
};

// Seed data
const seedTransactions = async () => {
  try {
    const userEmail = 'owoadehabeeb04@gmail.com';
    
    // Find user
    const user = await User.findOne({ email: userEmail });
    if (!user) {
      console.error(`❌ User not found: ${userEmail}`);
      process.exit(1);
    }
    
    console.log(`✅ Found user: ${user.name} (${user.email})`);
    console.log(`📊 User ID: ${user._id}`);

    // Get user's categories
    const expenseCategories = await Category.find({ 
      userId: user._id, 
      type: 'expense',
      isActive: true 
    });
    
    const incomeCategories = await Category.find({ 
      userId: user._id, 
      type: 'income',
      isActive: true 
    });

    console.log(`📁 Found ${expenseCategories.length} expense categories`);
    console.log(`📁 Found ${incomeCategories.length} income categories`);

    if (expenseCategories.length === 0 || incomeCategories.length === 0) {
      console.error('❌ No categories found. Please complete onboarding first.');
      process.exit(1);
    }

    // Helper function to get random date in last 6 months
    const getRandomDate = () => {
      const now = new Date();
      const sixMonthsAgo = new Date(now.setMonth(now.getMonth() - 6));
      const randomTime = sixMonthsAgo.getTime() + Math.random() * (Date.now() - sixMonthsAgo.getTime());
      return new Date(randomTime);
    };

    // Helper function to get random item from array
    const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // Expense descriptions by category
    const expenseDescriptions = {
      'Food': ['Groceries', 'Restaurant', 'Fast food', 'Lunch', 'Dinner', 'Breakfast', 'Coffee', 'Snacks'],
      'Transport': ['Uber ride', 'Fuel', 'Bus fare', 'Taxi', 'Parking', 'Car maintenance'],
      'Rent': ['Monthly rent', 'House rent', 'Apartment payment'],
      'Entertainment': ['Movie tickets', 'Concert', 'Netflix', 'Spotify', 'Games', 'Books'],
      'Utilities': ['Electricity bill', 'Water bill', 'Internet', 'Phone bill', 'Gas'],
      'Healthcare': ['Hospital visit', 'Medication', 'Dental', 'Pharmacy', 'Lab test'],
      'Shopping': ['Clothes', 'Electronics', 'Shoes', 'Accessories', 'Furniture', 'Gadgets'],
      'Education': ['Course fee', 'Books', 'Training', 'Certification', 'Tuition'],
      'Other': ['Miscellaneous', 'Gift', 'Donation', 'Emergency', 'Repairs']
    };

    // Income sources
    const incomeSources = ['Monthly Salary', 'Freelance Project', 'Side Hustle', 'Bonus', 'Gift', 'Refund', 'Commission'];

    // Payment methods
    const paymentMethods = ['cash', 'card', 'bank_transfer', 'mobile_money'];

    // Generate 300 expenses
    console.log('\n💸 Creating 300 expenses...');
    const expenses = [];
    for (let i = 0; i < 300; i++) {
      const category = randomItem(expenseCategories);
      const categoryName = category.name;
      const descriptions = expenseDescriptions[categoryName] || expenseDescriptions['Other'];
      
      // Realistic amounts based on category
      let minAmount, maxAmount;
      switch (categoryName) {
        case 'Rent':
          minAmount = 50000;
          maxAmount = 200000;
          break;
        case 'Food':
          minAmount = 500;
          maxAmount = 15000;
          break;
        case 'Transport':
          minAmount = 200;
          maxAmount = 10000;
          break;
        case 'Utilities':
          minAmount = 2000;
          maxAmount = 25000;
          break;
        case 'Entertainment':
          minAmount = 1000;
          maxAmount = 20000;
          break;
        case 'Healthcare':
          minAmount = 3000;
          maxAmount = 50000;
          break;
        case 'Shopping':
          minAmount = 5000;
          maxAmount = 100000;
          break;
        default:
          minAmount = 500;
          maxAmount = 30000;
      }

      const amount = Math.floor(Math.random() * (maxAmount - minAmount + 1)) + minAmount;
      
      expenses.push({
        userId: user._id,
        categoryId: category._id,
        amount,
        description: randomItem(descriptions),
        date: getRandomDate(),
        paymentMethod: randomItem(paymentMethods),
        synced: true
      });
    }

    // Bulk insert expenses
    await Expense.insertMany(expenses);
    console.log('✅ 300 expenses created');

    // Generate 100 income entries
    console.log('\n💰 Creating 100 income entries...');
    const incomes = [];
    for (let i = 0; i < 100; i++) {
      const category = randomItem(incomeCategories);
      
      // Realistic income amounts
      let amount;
      const source = randomItem(incomeSources);
      
      if (source === 'Monthly Salary') {
        amount = Math.floor(Math.random() * (300000 - 100000 + 1)) + 100000;
      } else if (source === 'Freelance Project') {
        amount = Math.floor(Math.random() * (150000 - 20000 + 1)) + 20000;
      } else if (source === 'Bonus') {
        amount = Math.floor(Math.random() * (100000 - 30000 + 1)) + 30000;
      } else {
        amount = Math.floor(Math.random() * (50000 - 5000 + 1)) + 5000;
      }

      incomes.push({
        userId: user._id,
        categoryId: category._id,
        amount,
        source,
        description: `${source} payment`,
        date: getRandomDate(),
        paymentMethod: randomItem(['bank_transfer', 'cash', 'mobile_money']),
        synced: true
      });
    }

    // Bulk insert income
    await Income.insertMany(incomes);
    console.log('✅ 100 income entries created');

    // Show summary
    console.log('\n📊 SUMMARY:');
    console.log('═══════════════════════════════════');
    
    const totalExpenses = await Expense.countDocuments({ userId: user._id });
    const totalIncome = await Income.countDocuments({ userId: user._id });
    const totalExpenseAmount = expenses.reduce((sum, e) => sum + e.amount, 0);
    const totalIncomeAmount = incomes.reduce((sum, i) => sum + i.amount, 0);

    console.log(`👤 User: ${user.name}`);
    console.log(`📧 Email: ${user.email}`);
    console.log(`\n💸 Total Expenses: ${totalExpenses}`);
    console.log(`💰 Total Income: ${totalIncome}`);
    console.log(`📝 Total Transactions: ${totalExpenses + totalIncome}`);
    console.log(`\n💵 Total Expense Amount: ₦${totalExpenseAmount.toLocaleString()}`);
    console.log(`💵 Total Income Amount: ₦${totalIncomeAmount.toLocaleString()}`);
    console.log(`💵 Balance: ₦${(totalIncomeAmount - totalExpenseAmount).toLocaleString()}`);
    console.log('═══════════════════════════════════');
    console.log('\n✅ Seeding completed successfully!');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding Error:', error);
    process.exit(1);
  }
};

// Run seeding
connectDB().then(() => seedTransactions());
