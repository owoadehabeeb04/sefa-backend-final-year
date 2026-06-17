const MonthlyInsightSnapshot = require('../../models/MonthlyInsightSnapshot');
const financialDashboard = require('./financialDashboard.service');
const { toObjectId } = require('./insightHelpers');

/**
 * insightSnapshot.service
 *
 * Caching layer for the financial dashboard. Heavy aggregation runs once per
 * user per month; the result is stored in MonthlyInsightSnapshot and reused
 * until invalidated (write to expense/income/budget/category, bank sync,
 * statement import confirm). The AI summary is stored separately so it can be
 * (re)generated/streamed without recomputing the whole snapshot.
 */

const CALCULATION_VERSION = MonthlyInsightSnapshot.CALCULATION_VERSION;

/**
 * Map a calculated dashboard object onto the persisted snapshot shape.
 */
function toSnapshotDocument(userId, dashboard) {
  return {
    userId: toObjectId(userId),
    periodKey: dashboard.periodKey,
    periodLabel: dashboard.periodLabel,
    periodStart: dashboard.periodStart,
    periodEnd: dashboard.periodEnd,

    totalIncome: dashboard.totalIncome,
    totalExpenses: dashboard.totalExpenses,
    balance: dashboard.balance,
    spendingRate: dashboard.spendingRate,
    budgetUsage: dashboard.budgetUsage,
    savingsPotential: dashboard.savingsPotential,
    previousPeriod: dashboard.previousPeriod,

    categoryBreakdown: dashboard.categoryBreakdown,
    pieChart: dashboard.pieChart,
    spendingDrivers: dashboard.spendingDrivers,
    savingsOpportunities: dashboard.savingsOpportunities,
    budgetHealth: dashboard.budgetHealth,

    lastCalculatedAt: new Date(),
    stale: false,
    calculationVersion: CALCULATION_VERSION,
    hasData: dashboard.hasData,
  };
}

/**
 * Shape a snapshot document into the public dashboard payload returned to the
 * client. Includes the savings summary derived at read time so the response is
 * stable regardless of whether it came from cache or a fresh calculation.
 */
function toPublicPayload(snapshot) {
  const savingsOpportunities = snapshot.savingsOpportunities || [];
  const totalEstimatedSavings = savingsOpportunities.reduce(
    (total, entry) => total + Number(entry.estimatedSavings || 0),
    0
  );

  return {
    period: snapshot.periodLabel,
    periodKey: snapshot.periodKey,
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    hasData: snapshot.hasData,
    hasBudgets: snapshot.budgetHealth?.hasBudgets || false,
    lastCalculatedAt: snapshot.lastCalculatedAt,
    fromCache: snapshot.__fromCache || false,

    snapshot: {
      totalIncome: snapshot.totalIncome,
      totalExpenses: snapshot.totalExpenses,
      balance: snapshot.balance,
      spendingRate: snapshot.spendingRate,
      budgetUsage: snapshot.budgetUsage,
      savingsPotential: snapshot.savingsPotential,
      previousPeriod: snapshot.previousPeriod || null,
    },
    categoryBreakdown: snapshot.categoryBreakdown || [],
    pieChart: snapshot.pieChart || [],
    spendingDrivers: snapshot.spendingDrivers || {},
    savingsOpportunities,
    savingsSummary: {
      totalEstimatedSavings,
      percentOfExpenses: snapshot.totalExpenses
        ? Number(((totalEstimatedSavings / snapshot.totalExpenses) * 100).toFixed(1))
        : 0,
    },
    budgetHealth: snapshot.budgetHealth || {},
    aiSummary: snapshot.aiSummary || null,
  };
}

/**
 * Recalculate and persist the snapshot for a user/period (upsert).
 * Always returns the fresh document.
 */
async function recalculateSnapshot(userId, opts = {}) {
  const dashboard = await financialDashboard.buildDashboardForPeriod(userId, opts);
  const doc = toSnapshotDocument(userId, dashboard);

  const snapshot = await MonthlyInsightSnapshot.findOneAndUpdate(
    { userId: doc.userId, periodKey: doc.periodKey },
    // Preserve any existing AI summary unless it's now stale (handled by caller).
    { $set: doc },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  snapshot.__fromCache = false;
  return snapshot;
}

/**
 * Get a usable snapshot for a user/period. Returns the cached one when fresh and
 * the calculation version matches; otherwise recalculates.
 *
 * @param {Object} [opts]
 * @param {string} [opts.periodKey]
 * @param {boolean} [opts.forceRefresh]
 */
async function getOrBuildSnapshot(userId, opts = {}) {
  const period = financialDashboard.resolvePeriod(opts);

  if (!opts.forceRefresh) {
    const cached = await MonthlyInsightSnapshot.findOne({
      userId: toObjectId(userId),
      periodKey: period.periodKey,
    }).lean();

    if (
      cached &&
      cached.stale !== true &&
      cached.calculationVersion === CALCULATION_VERSION
    ) {
      cached.__fromCache = true;
      return cached;
    }
  }

  return recalculateSnapshot(userId, { periodKey: period.periodKey });
}

/**
 * Public dashboard payload (Layer 1-3 data), cached.
 */
async function getDashboard(userId, opts = {}) {
  const snapshot = await getOrBuildSnapshot(userId, opts);
  return toPublicPayload(snapshot);
}

/**
 * Persist an AI summary onto a snapshot without recomputing analytics.
 */
async function saveAiSummary(userId, periodKey, aiSummary) {
  await MonthlyInsightSnapshot.updateOne(
    { userId: toObjectId(userId), periodKey },
    { $set: { aiSummary: { ...aiSummary, generatedAt: new Date() } } }
  ).catch(() => null);
}

/**
 * Invalidate (mark stale) a user's snapshots. Safe to call from write hooks; it
 * never throws. When `periodKey` is omitted, all of the user's snapshots are
 * invalidated (a transaction may move between months on edit).
 */
async function invalidateUser(userId, periodKey = null) {
  if (!userId) return;
  try {
    await MonthlyInsightSnapshot.markStaleForUser(toObjectId(userId), periodKey);
  } catch (_error) {
    // Invalidation must never break the originating write.
  }
}

module.exports = {
  getDashboard,
  getOrBuildSnapshot,
  invalidateUser,
  recalculateSnapshot,
  saveAiSummary,
  toPublicPayload,
  toSnapshotDocument,
};
