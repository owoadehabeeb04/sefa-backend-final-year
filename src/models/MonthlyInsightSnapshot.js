const mongoose = require('mongoose');

/**
 * MonthlyInsightSnapshot
 *
 * Caches the calculated financial-intelligence dashboard for a user for a given
 * period (month). The heavy aggregation is computed once and reused until the
 * snapshot is marked stale by a write to the underlying data (expense, income,
 * budget, category, bank sync, statement import).
 *
 * Core principle: the backend calculates and stores real numbers here. The AI
 * layer only explains what is already stored — it never writes chart numbers.
 */
const CalculationVersion = 1;

const categoryBreakdownSchema = new mongoose.Schema(
  {
    categoryId: { type: String, default: null },
    categoryName: { type: String, required: true },
    totalSpent: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    transactionCount: { type: Number, default: 0 },
    averageTransaction: { type: Number, default: 0 },
    color: { type: String, default: '#94a3b8' },
  },
  { _id: false }
);

const pieSliceSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    value: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    categoryId: { type: String, default: null },
    color: { type: String, default: '#94a3b8' },
    formattedAmount: { type: String, default: '' },
  },
  { _id: false }
);

const savingsOpportunitySchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: { type: String, default: 'category' }, // category | subscription | budget
    title: { type: String, required: true },
    categoryName: { type: String, default: null },
    estimatedSavings: { type: Number, default: 0 },
    confidence: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' },
    reason: { type: String, default: '' },
  },
  { _id: false }
);

const budgetHealthItemSchema = new mongoose.Schema(
  {
    categoryName: { type: String, required: true },
    budgetAmount: { type: Number, default: 0 },
    spent: { type: Number, default: 0 },
    percentUsed: { type: Number, default: 0 },
    remaining: { type: Number, default: 0 },
    // within_budget | close_to_limit | over_budget | no_budget
    status: {
      type: String,
      enum: ['within_budget', 'close_to_limit', 'over_budget', 'no_budget'],
      default: 'no_budget',
    },
    color: { type: String, default: '#94a3b8' },
  },
  { _id: false }
);

const monthlyInsightSnapshotSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Canonical period key, e.g. "2026-06" — uniquely identifies a month per user.
    periodKey: { type: String, required: true, index: true },
    periodLabel: { type: String, default: '' }, // e.g. "June 2026"
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    // --- Financial snapshot ---
    totalIncome: { type: Number, default: 0 },
    totalExpenses: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    spendingRate: { type: Number, default: 0 }, // expenses / income (0..1+)
    budgetUsage: { type: Number, default: 0 }, // spent / total monthly budget (%)
    savingsPotential: { type: Number, default: 0 },

    // Previous-period comparison (null when no previous data exists)
    previousPeriod: {
      type: new mongoose.Schema(
        {
          periodKey: String,
          periodLabel: String,
          totalIncome: Number,
          totalExpenses: Number,
          balance: Number,
          expensesChange: Number, // absolute change vs previous
          expensesChangePercent: Number,
        },
        { _id: false }
      ),
      default: null,
    },

    // --- Analytics blocks ---
    categoryBreakdown: { type: [categoryBreakdownSchema], default: [] },
    pieChart: { type: [pieSliceSchema], default: [] },
    // Spending Drivers — "what's taking most of the user's money"
    spendingDrivers: { type: mongoose.Schema.Types.Mixed, default: {} },
    savingsOpportunities: { type: [savingsOpportunitySchema], default: [] },
    budgetHealth: { type: mongoose.Schema.Types.Mixed, default: {} },

    // --- AI ---
    aiSummary: {
      type: new mongoose.Schema(
        {
          shortSummary: String,
          detailedExplanation: String,
          actions: [String],
          generatedAt: Date,
          model: String,
        },
        { _id: false }
      ),
      default: null,
    },

    // --- Cache bookkeeping ---
    lastCalculatedAt: { type: Date, default: Date.now },
    stale: { type: Boolean, default: false, index: true },
    calculationVersion: { type: Number, default: CalculationVersion },
    hasData: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One snapshot per user per period.
monthlyInsightSnapshotSchema.index({ userId: 1, periodKey: 1 }, { unique: true });
// Fast lookup of fresh snapshots.
monthlyInsightSnapshotSchema.index({ userId: 1, stale: 1, lastCalculatedAt: -1 });

monthlyInsightSnapshotSchema.statics.CALCULATION_VERSION = CalculationVersion;

/**
 * Mark all of a user's snapshots stale. Used by write-side invalidation hooks.
 * @param {ObjectId|string} userId
 * @param {string} [periodKey] - if provided, only that period is invalidated
 */
monthlyInsightSnapshotSchema.statics.markStaleForUser = async function (userId, periodKey = null) {
  if (!userId) return { matchedCount: 0, modifiedCount: 0 };
  const filter = { userId };
  if (periodKey) filter.periodKey = periodKey;
  return this.updateMany(filter, { $set: { stale: true } }).catch(() => ({ matchedCount: 0, modifiedCount: 0 }));
};

module.exports = mongoose.model('MonthlyInsightSnapshot', monthlyInsightSnapshotSchema);
