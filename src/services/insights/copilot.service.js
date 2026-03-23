const InsightSession = require('../../models/InsightSession');
const { buildInsightsHub, runWhatIfScenario } = require('./insightHub.service');
const { clamp } = require('./insightHelpers');

function parseSavingsTarget(question = '') {
  const match = String(question).match(/(?:save|cut|reduce)\s*(?:ngn|n|naira|₦)?\s*([\d,]+(?:\.\d+)?)/i);
  if (!match) return null;
  return Number(String(match[1]).replace(/,/g, ''));
}

function detectIntent(question = '') {
  const normalized = String(question).toLowerCase();

  if (/month end|survive|last till|make it|run short|finish the month/.test(normalized)) {
    return 'forecast_survival';
  }

  if (/drain|draining|most spend|where money goes|spending the most|highest category/.test(normalized)) {
    return 'spending_drivers';
  }

  if (/suspicious|fraud|duplicate|anomaly|weird transaction|risky/.test(normalized)) {
    return 'risk_review';
  }

  if (/save|cut|reduce|trim|budget/.test(normalized)) {
    return 'savings_goal';
  }

  if (/what if|if i reduce|if my income drops|scenario/.test(normalized)) {
    return 'what_if';
  }

  return 'health_overview';
}

function createEvidenceSubset(hub, ids = []) {
  const byId = new Map((hub.evidence || []).map((entry) => [entry.id, entry]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function buildGeneralResponse(hub) {
  const evidenceCards = createEvidenceSubset(hub, ['health-score', 'forecast', 'behavior']);

  return {
    answer: `${hub.summary.headline} ${hub.summary.keyTakeaway} ${hub.summary.nextBestAction}`,
    evidenceCards,
    confidence: hub.confidence,
    actions: [hub.summary.nextBestAction, ...(hub.recommendations.weeklyNudges || []).slice(0, 2)],
    suggestedQuestions: hub.suggestedQuestions.slice(0, 3),
  };
}

function buildForecastResponse(hub) {
  const forecast = hub.forecast;
  const topRisk = forecast.likelyBudgetBreachCategories?.[0];
  const answer = forecast.projectedMonthEndBalance < 0
    ? `At this rate, month end may be hard. We expect about ₦${forecast.projectedMonthEndBalance.toLocaleString()} by month end. ${topRisk ? `${topRisk.categoryName} is the main problem area now.` : 'You need to slow down spending now.'}`
    : `Yes, you can likely reach month end if you continue like this. We expect about ₦${forecast.projectedMonthEndBalance.toLocaleString()} by month end. ${topRisk ? `${topRisk.categoryName} still needs watching.` : 'Just keep an eye on extra spending.'}`;

  return {
    answer,
    evidenceCards: createEvidenceSubset(hub, ['forecast', 'health-score']),
    confidence: Number(clamp((forecast.confidence + hub.healthScore.confidence) / 2, 0.4, 0.95).toFixed(2)),
    actions: [
      topRisk ? `Reduce ${topRisk.categoryName} this week.` : hub.recommendations.nextBestAction,
      hub.recommendations.weeklyNudges?.[0],
    ].filter(Boolean),
    suggestedQuestions: [
      'Which category may pass my budget?',
      'How much can I cut this week?',
      'What if my income drops by 10%?',
    ],
  };
}

function buildSpendingDriversResponse(hub) {
  const topCategories = (hub.forecast.categoryForecasts || []).slice(0, 3);
  const categorySummary = topCategories.length
    ? topCategories
        .map((entry) => `${entry.categoryName} (about ₦${entry.projectedSpend.toLocaleString()})`)
        .join(', ')
    : 'No clear area is standing out yet.';

  return {
    answer: `The main places your money is going are ${categorySummary}. ${hub.behaviorPatterns.persona.reason} ${hub.recommendations.nextBestAction}`,
    evidenceCards: createEvidenceSubset(hub, ['behavior', 'forecast', 'savings']),
    confidence: Number(clamp((hub.behaviorPatterns.confidence + hub.forecast.confidence) / 2, 0.4, 0.92).toFixed(2)),
    actions: [
      hub.recommendations.savingsActions?.[0]?.action,
      hub.behaviorPatterns.nudges?.[0],
    ].filter(Boolean),
    suggestedQuestions: [
      'How can I save N20,000 this month?',
      'Do I overspend more on weekends?',
      'Which habit is hurting my money most?',
    ],
  };
}

function buildRiskReviewResponse(hub) {
  const topAlert = hub.anomalies.alerts?.[0];
  const answer = topAlert
    ? `This is the main transaction to check: ${topAlert.title}. We flagged it because it does not look like your normal pattern. ${topAlert.recommendedAction}`
    : 'No serious risky transaction is showing right now.';

  return {
    answer,
    evidenceCards: createEvidenceSubset(hub, ['anomaly', 'health-score']),
    confidence: topAlert ? 0.78 : 0.88,
    actions: [
      topAlert?.recommendedAction || 'Keep checking your recent transactions.',
      hub.recommendations.weeklyNudges?.[1],
    ].filter(Boolean),
    suggestedQuestions: [
      'Show me the strangest transaction in the last 30 days.',
      'Are there duplicates I should review?',
      'Which category looks most risky?',
    ],
  };
}

function buildSavingsGoalResponse(hub, question) {
  const target = parseSavingsTarget(question);
  const actions = hub.recommendations.savingsActions || [];
  let runningTotal = 0;
  const chosenActions = [];

  for (const action of actions) {
    if (runningTotal >= (target || 15000)) break;
    chosenActions.push(action);
    runningTotal += Number(action.impact || 0);
  }

  const answer = target
    ? runningTotal >= target
      ? `Yes. You can try to save about ₦${runningTotal.toLocaleString()} if you focus on ${chosenActions.map((action) => action.title).join(', ')}.`
      : `Right now you have about ₦${runningTotal.toLocaleString()} clear saving chances. That is still below ₦${target.toLocaleString()}, so you may need to cut more or find extra income.`
    : `The best places to save now are ${chosenActions.map((action) => action.title).join(', ')}. Together they can save about ₦${runningTotal.toLocaleString()} in one month.`;

  return {
    answer,
    evidenceCards: createEvidenceSubset(hub, ['savings', 'forecast', 'behavior']),
    confidence: 0.8,
    actions: chosenActions.map((action) => action.action),
    suggestedQuestions: [
      'What if I cut food spending by 15%?',
      'Which saving step is easiest this week?',
      'How much are subscriptions taking in one year?',
    ],
  };
}

async function buildWhatIfResponse(userId, hub) {
  const scenario = await runWhatIfScenario(userId, {
    days: 30,
    categoryName: hub.forecast.likelyBudgetBreachCategories?.[0]?.categoryName
      || hub.forecast.categoryForecasts?.[0]?.categoryName
      || 'Food & Dining',
    reductionPercent: 15,
  });

  return {
    answer: `${scenario.explanation} If you do this, your month end balance may change by ₦${scenario.delta.projectedMonthEndBalance.toLocaleString()}.`,
    evidenceCards: createEvidenceSubset(hub, ['forecast', 'savings']),
    confidence: scenario.confidence,
    actions: [
      'Try cutting your top problem category by 15% this week.',
      'Check the result again after 5 to 7 days.',
    ],
    suggestedQuestions: [
      'What if my income drops by 10%?',
      'What if I cut transport by 10%?',
      'What one change can help me most?',
    ],
  };
}

async function answerInsightQuestion(userId, question, options = {}) {
  const hub = options.hub || await buildInsightsHub(userId, {
    months: options.months || 3,
    days: options.days || 30,
  });
  const intent = detectIntent(question);

  let response;
  if (intent === 'forecast_survival') response = buildForecastResponse(hub);
  else if (intent === 'spending_drivers') response = buildSpendingDriversResponse(hub);
  else if (intent === 'risk_review') response = buildRiskReviewResponse(hub);
  else if (intent === 'savings_goal') response = buildSavingsGoalResponse(hub, question);
  else if (intent === 'what_if') response = await buildWhatIfResponse(userId, hub);
  else response = buildGeneralResponse(hub);

  const session = await InsightSession.create({
    userId,
    question,
    normalizedIntent: intent,
    answer: response.answer,
    confidence: response.confidence,
    evidenceCards: response.evidenceCards,
    actions: response.actions,
    suggestedQuestions: response.suggestedQuestions,
    hubSnapshot: {
      generatedAt: hub.generatedAt,
      summary: hub.summary,
      confidence: hub.confidence,
    },
  });

  return {
    sessionId: String(session._id),
    answer: response.answer,
    evidenceCards: response.evidenceCards,
    confidence: response.confidence,
    actions: response.actions,
    suggestedQuestions: response.suggestedQuestions,
  };
}

module.exports = {
  answerInsightQuestion,
};
