const mongoose = require('mongoose');

const BudgetSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  category: {
    type: String,
    required: [true, 'Category is required'],
    index: true
  },
  amount: {
    type: Number,
    required: [true, 'Budget amount is required'],
    min: [0, 'Budget amount cannot be negative']
  },
  period: {
    type: String,
    enum: ['monthly', 'weekly', 'custom'],
    default: 'monthly'
  },
  startDate: {
    type: Date,
    default: () => {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), 1);
    }
  },
  endDate: {
    type: Date,
    default: () => {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  warningThreshold: {
    type: Number,
    default: 80,
    min: 0,
    max: 100
  },
  criticalThreshold: {
    type: Number,
    default: 100,
    min: 0,
    max: 100
  },
  warningNotificationSent: {
    type: Boolean,
    default: false
  },
  criticalNotificationSent: {
    type: Boolean,
    default: false
  },
  rollover: {
    type: Boolean,
    default: false,
    description: 'Whether unused budget carries over to next period'
  },
  notes: {
    type: String,
    maxlength: 500
  }
}, {
  timestamps: true
});

// Indexes
BudgetSchema.index({ userId: 1, category: 1, period: 1 });
BudgetSchema.index({ userId: 1, isActive: 1 });
BudgetSchema.index({ startDate: 1, endDate: 1 });

// Virtual for spent amount (calculated from expenses)
BudgetSchema.virtual('spent', {
  ref: 'Expense',
  localField: '_id',
  foreignField: 'budgetId',
  count: false
});

// Methods

/**
 * Calculate current spending for this budget
 * @returns {Promise<Number>}
 */
BudgetSchema.methods.calculateSpending = async function() {
  const Expense = mongoose.model('Expense');
  
  const result = await Expense.aggregate([
    {
      $match: {
        userId: this.userId,
        category: this.category,
        date: {
          $gte: this.startDate,
          $lte: this.endDate
        }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' }
      }
    }
  ]);

  return result[0]?.total || 0;
};

/**
 * Calculate budget progress percentage
 * @returns {Promise<Object>}
 */
BudgetSchema.methods.getProgress = async function() {
  const spent = await this.calculateSpending();
  const percentage = (spent / this.amount) * 100;
  const remaining = this.amount - spent;

  return {
    spent,
    amount: this.amount,
    remaining: remaining > 0 ? remaining : 0,
    overspent: remaining < 0 ? Math.abs(remaining) : 0,
    percentage: Math.round(percentage * 100) / 100,
    status: percentage >= 100 ? 'exceeded' : percentage >= this.warningThreshold ? 'warning' : 'ok'
  };
};

/**
 * Check if budget needs notification
 * @returns {Promise<Object|null>}
 */
BudgetSchema.methods.checkNotificationNeeded = async function() {
  const progress = await this.getProgress();

  // Critical notification
  if (progress.percentage >= this.criticalThreshold && !this.criticalNotificationSent) {
    return {
      type: 'critical',
      progress
    };
  }

  // Warning notification
  if (progress.percentage >= this.warningThreshold && !this.warningNotificationSent) {
    return {
      type: 'warning',
      progress
    };
  }

  return null;
};

/**
 * Reset notification flags for new period
 */
BudgetSchema.methods.resetNotifications = function() {
  this.warningNotificationSent = false;
  this.criticalNotificationSent = false;
};

/**
 * Renew budget for next period
 * @returns {Promise<Budget>}
 */
BudgetSchema.methods.renewForNextPeriod = async function() {
  const Budget = mongoose.model('Budget');

  // Deactivate current budget
  this.isActive = false;
  await this.save();

  // Calculate next period dates
  let startDate, endDate;
  
  if (this.period === 'monthly') {
    const nextMonth = new Date(this.endDate);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    
    startDate = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1);
    endDate = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (this.period === 'weekly') {
    startDate = new Date(this.endDate);
    startDate.setDate(startDate.getDate() + 1);
    
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
  }

  // Handle rollover
  let newAmount = this.amount;
  if (this.rollover) {
    const spent = await this.calculateSpending();
    const unused = this.amount - spent;
    if (unused > 0) {
      newAmount += unused;
    }
  }

  // Create new budget for next period
  const newBudget = new Budget({
    userId: this.userId,
    category: this.category,
    amount: newAmount,
    period: this.period,
    startDate,
    endDate,
    warningThreshold: this.warningThreshold,
    criticalThreshold: this.criticalThreshold,
    rollover: this.rollover,
    isActive: true,
    warningNotificationSent: false,
    criticalNotificationSent: false
  });

  return await newBudget.save();
};

// Static methods

/**
 * Get all active budgets for a user
 * @param {ObjectId} userId - User ID
 * @returns {Promise<Array>}
 */
BudgetSchema.statics.getUserBudgets = async function(userId) {
  return await this.find({ userId, isActive: true }).sort({ category: 1 });
};

/**
 * Get budget with progress for a specific category
 * @param {ObjectId} userId - User ID
 * @param {String} category - Category name
 * @returns {Promise<Object|null>}
 */
BudgetSchema.statics.getBudgetWithProgress = async function(userId, category) {
  const budget = await this.findOne({
    userId,
    category,
    isActive: true
  });

  if (!budget) {
    return null;
  }

  const progress = await budget.getProgress();

  return {
    ...budget.toObject(),
    progress
  };
};

/**
 * Get all budgets with progress for a user
 * @param {ObjectId} userId - User ID
 * @returns {Promise<Array>}
 */
BudgetSchema.statics.getAllBudgetsWithProgress = async function(userId) {
  const budgets = await this.getUserBudgets(userId);
  
  const budgetsWithProgress = await Promise.all(
    budgets.map(async (budget) => {
      const progress = await budget.getProgress();
      return {
        ...budget.toObject(),
        progress
      };
    })
  );

  return budgetsWithProgress;
};

/**
 * Create or update budget
 * @param {ObjectId} userId - User ID
 * @param {String} category - Category name
 * @param {Number} amount - Budget amount
 * @param {Object} options - Additional options
 * @returns {Promise<Budget>}
 */
BudgetSchema.statics.createOrUpdate = async function(userId, category, amount, options = {}) {
  const existingBudget = await this.findOne({
    userId,
    category,
    isActive: true
  });

  if (existingBudget) {
    existingBudget.amount = amount;
    existingBudget.warningThreshold = options.warningThreshold || existingBudget.warningThreshold;
    existingBudget.criticalThreshold = options.criticalThreshold || existingBudget.criticalThreshold;
    existingBudget.rollover = options.rollover !== undefined ? options.rollover : existingBudget.rollover;
    existingBudget.notes = options.notes !== undefined ? options.notes : existingBudget.notes;
    
    // Reset notification flags if amount changed significantly
    const amountChange = Math.abs((amount - existingBudget.amount) / existingBudget.amount);
    if (amountChange > 0.1) { // If changed by more than 10%
      existingBudget.resetNotifications();
    }
    
    return await existingBudget.save();
  }

  return await this.create({
    userId,
    category,
    amount,
    period: options.period || 'monthly',
    startDate: options.startDate,
    endDate: options.endDate,
    warningThreshold: options.warningThreshold || 80,
    criticalThreshold: options.criticalThreshold || 100,
    rollover: options.rollover || false,
    notes: options.notes
  });
};

module.exports = mongoose.model('Budget', BudgetSchema);
