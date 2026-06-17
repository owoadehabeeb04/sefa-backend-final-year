const mongoose = require('mongoose');

const normalizeExternalId = (value) => {
  if (value == null) {
    return undefined;
  }

  const normalized = String(value).trim();
  return normalized || undefined;
};

const incomeSchema = new mongoose.Schema({
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
  source: {
    type: String,
    required: [true, 'Income source is required'],
    trim: true,
    maxlength: [200, 'Source cannot exceed 200 characters']
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
    default: 'bank_transfer'
  },
  tags: [{
    type: String,
    trim: true
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
    ref: 'Expense',
    default: null,
    sparse: true // Links to matching expense transfer
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries (cursor pagination uses date + createdAt)
incomeSchema.index({ userId: 1, date: -1 });
incomeSchema.index({ userId: 1, date: -1, createdAt: -1 }); // Cursor keyset pagination
incomeSchema.index({ userId: 1, categoryId: 1, date: -1 });
incomeSchema.index({ userId: 1, createdAt: -1 });
incomeSchema.index({ userId: 1, synced: 1 }); // For offline sync
incomeSchema.index(
  { userId: 1, externalId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      externalId: { $type: 'string' }
    }
  }
); // For duplicate detection on imported transactions only
incomeSchema.index({ userId: 1, isImported: 1, importJobId: 1 }); // For import queries
incomeSchema.index({ userId: 1, isTransfer: 1 }); // For excluding transfers from analytics

// Virtual for formatted amount (with currency)
incomeSchema.virtual('formattedAmount').get(function() {
  return `₦${this.amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
});

// Method to check if income is from current month
incomeSchema.methods.isCurrentMonth = function() {
  const now = new Date();
  const incomeDate = new Date(this.date);
  return incomeDate.getMonth() === now.getMonth() && 
         incomeDate.getFullYear() === now.getFullYear();
};

// Static method to get total income for a user within a date range
incomeSchema.statics.getTotalByDateRange = async function(userId, startDate, endDate) {
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

// Static method to get income grouped by category/source
incomeSchema.statics.getByCategory = async function(userId, startDate, endDate) {
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
        count: { $sum: 1 }
      }
    },
    {
      $sort: { total: -1 }
    }
  ]);
};

// Pre-save hook to validate category type
incomeSchema.pre('save', async function(next) {
  if (this.isNew || this.isModified('categoryId')) {
    const Category = mongoose.model('Category');
    const category = await Category.findById(this.categoryId);
    
    if (!category) {
      throw new Error('Category not found');
    }
    
    if (category.type !== 'income') {
      throw new Error('Selected category is not an income category');
    }
  }
  next();
});

// Invalidate cached insight snapshots when income changes.
incomeSchema.plugin(require('./plugins/invalidateInsightSnapshot'));

module.exports = mongoose.model('Income', incomeSchema);
