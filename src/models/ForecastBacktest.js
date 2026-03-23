const mongoose = require('mongoose');

const forecastBacktestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  horizonDays: {
    type: Number,
    required: true,
    enum: [7, 30],
  },
  evaluationDate: {
    type: Date,
    required: true,
  },
  trainingWindow: {
    startDate: Date,
    endDate: Date,
  },
  forecastWindow: {
    startDate: Date,
    endDate: Date,
  },
  predictedExpenseTotal: {
    type: Number,
    default: 0,
  },
  actualExpenseTotal: {
    type: Number,
    default: 0,
  },
  predictedIncomeTotal: {
    type: Number,
    default: 0,
  },
  actualIncomeTotal: {
    type: Number,
    default: 0,
  },
  predictedNetBalance: {
    type: Number,
    default: 0,
  },
  actualNetBalance: {
    type: Number,
    default: 0,
  },
  maeExpense: {
    type: Number,
    default: 0,
  },
  maeIncome: {
    type: Number,
    default: 0,
  },
  mapeExpense: {
    type: Number,
    default: 0,
  },
  mapeIncome: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

forecastBacktestSchema.index({ userId: 1, horizonDays: 1, evaluationDate: -1 });
forecastBacktestSchema.index(
  { userId: 1, horizonDays: 1, evaluationDate: 1 },
  { unique: true }
);

module.exports = mongoose.model('ForecastBacktest', forecastBacktestSchema);
