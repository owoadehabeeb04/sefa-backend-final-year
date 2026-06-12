const mongoose = require('mongoose');

const normalizeExternalId = (value) => {
  if (value == null) {
    return undefined;
  }

  const normalized = String(value).trim();
  return normalized || undefined;
};

const expenseSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required'],
    index: true
  },
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: [true, 'Category ID is required']
  },
  amount: {
    type: Number,
    required: [true, 'Amount is required'],
    min: [0.01, 'Amount must be greater than 0']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  date: {
    type: Date,
    required: [true, 'Date is required'],
    default: Date.now,
    index: true
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'bank_transfer', 'mobile_money', 'other'],
    default: 'cash'
  },
  location: {
    type: String,
    trim: true,
    maxlength: [200, 'Location cannot exceed 200 characters']
  },
  tags: [{
    type: String,
    trim: true
  }],
  attachments: [{
    url: String,
    type: {
      type: String,
      enum: ['image', 'pdf', 'other']
    },
    filename: String
  }],
  isRecurring: {
    type: Boolean,
    default: false
  },
  recurringConfig: {
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'bi-weekly', 'monthly', 'quarterly', 'yearly']
    },
    nextDate: Date,
    endDate: Date
  },
  synced: {
    type: Boolean,
    default: true
  },
  localId: {
    type: String,
    sparse: true // For offline sync support
  },

  // Import tracking fields
  isImported: {
    type: Boolean,
    default: false,
    index: true
  },
  statementTimeProvided: {
    type: Boolean,
    default: false
  },
  importJobId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
    sparse: true
  },
  externalId: {
    type: String,
    trim: true,
    set: normalizeExternalId
  },
  isTransfer: {
    type: Boolean,
    default: false,
    index: true
  },
  transferPairId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Income',
    default: null,
    sparse: true // Links to matching income transfer
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries (cursor pagination uses date + createdAt)
expenseSchema.index({ userId: 1, date: -1 });
expenseSchema.index({ userId: 1, date: -1, createdAt: -1 }); // Cursor keyset pagination
expenseSchema.index({ userId: 1, categoryId: 1, date: -1 });
expenseSchema.index({ userId: 1, createdAt: -1 });
expenseSchema.index({ userId: 1, synced: 1 }); // For offline sync
expenseSchema.index(
  { userId: 1, externalId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      externalId: { $type: 'string' }
    }
  }
); // For duplicate detection on imported transactions only
expenseSchema.index({ userId: 1, isImported: 1, importJobId: 1 }); // For import queries
expenseSchema.index({ userId: 1, isTransfer: 1 }); // For excluding transfers from analytics

// Virtual for formatted amount (with currency)
expenseSchema.virtual('formattedAmount').get(function() {
  return `₦${this.amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
});

// Method to check if expense is from current month
expenseSchema.methods.isCurrentMonth = function() {
  const now = new Date();
  const expenseDate = new Date(this.date);
  return expenseDate.getMonth() === now.getMonth() && 
         expenseDate.getFullYear() === now.getFullYear();
};

// Static method to get total expenses for a user within a date range
expenseSchema.statics.getTotalByDateRange = async function(userId, startDate, endDate) {
  const result = await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        date: { $gte: new Date(startDate), $lte: new Date(endDate) }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    }
  ]);
  
  return result[0] || { total: 0, count: 0 };
};

// Static method to get expenses grouped by day (for AI "high spending days" insight)
expenseSchema.statics.getByDay = async function(userId, startDate, endDate) {
  const result = await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        date: { $gte: new Date(startDate), $lte: new Date(endDate) }
      }
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);
  return result.map(r => ({ date: r._id, total: r.total, count: r.count }));
};

// Static method to get expenses grouped by category
expenseSchema.statics.getByCategory = async function(userId, startDate, endDate) {
  return await this.aggregate([
    {
      $match: {
        userId: new mongoose.Types.ObjectId(userId),
        date: { $gte: new Date(startDate), $lte: new Date(endDate) }
      }
    },
    {
      $lookup: {
        from: 'categories',
        localField: 'categoryId',
        foreignField: '_id',
        as: 'category'
      }
    },
    {
      $unwind: '$category'
    },
    {
      $group: {
        _id: '$categoryId',
        categoryName: { $first: '$category.name' },
        categoryIcon: { $first: '$category.icon' },
        categoryColor: { $first: '$category.color' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
        percentage: { $sum: '$amount' } // Will calculate percentage later
      }
    },
    {
      $sort: { total: -1 }
    }
  ]);
};

// Pre-save hook to validate category type
expenseSchema.pre('save', async function(next) {
  if (this.isNew || this.isModified('categoryId')) {
    const Category = mongoose.model('Category');
    const category = await Category.findById(this.categoryId);
    
    if (!category) {
      throw new Error('Category not found');
    }
    
    if (category.type !== 'expense') {
      throw new Error('Selected category is not an expense category');
    }
  }
  next();
});

module.exports = mongoose.model('Expense', expenseSchema);
