const Groq = require('groq-sdk');

const {
  BANK_PROFILES,
  findBankProfile,
  getSupportedBanks,
  normalizeBankText,
  resolveBankProfile,
} = require('./bankProfiles');

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const GROQ_BANK_CLASSIFIER_MODEL =
  process.env.GROQ_BANK_CLASSIFIER_MODEL ||
  process.env.GROQ_MODEL ||
  'llama-3.3-70b-versatile';

const GROQ_TIMEOUT_MS = 1800;
const MAX_EVIDENCE_TEXT = 5000;

const CONFIDENCE_ORDER = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const withTimeout = async (promise, timeoutMs) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Groq bank classifier timed out')), timeoutMs);
    }),
  ]);

const makeIdentityResult = (overrides = {}) => ({
  bankSlug: 'unknown',
  displayName: 'Unknown bank',
  confidence: 'unknown',
  source: 'unknown',
  parserHint: null,
  reasons: [],
  ...overrides,
});

const toConfidenceLabel = (score) => {
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score >= 2) return 'low';
  return 'unknown';
};

const joinEvidence = (...parts) =>
  parts
    .flat()
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join('\n');

const buildEvidenceText = (evidence = {}) => {
  const text = joinEvidence(
    evidence.fileName && `File name: ${evidence.fileName}`,
    evidence.headerText && `Header text:\n${evidence.headerText}`,
    evidence.rawText && `Document text:\n${evidence.rawText}`,
    evidence.tableHeaders?.length ? `Table headers: ${evidence.tableHeaders.join(', ')}` : null,
    evidence.accountNumberHint && `Account hint: ${evidence.accountNumberHint}`,
  );

  return text.slice(0, MAX_EVIDENCE_TEXT);
};

const scoreDeterministicIdentity = (evidence = {}) => {
  const haystacks = [
    String(evidence.fileName || ''),
    String(evidence.headerText || ''),
    String(evidence.rawText || ''),
    Array.isArray(evidence.tableHeaders) ? evidence.tableHeaders.join(' ') : '',
  ];

  const normalizedHaystacks = haystacks.map(normalizeBankText);
  const scoreBoard = BANK_PROFILES.map((profile) => {
    let score = 0;
    const reasons = [];

    for (const alias of profile.aliases) {
      const normalizedAlias = normalizeBankText(alias);
      if (!normalizedAlias) continue;

      if (normalizedHaystacks[1]?.includes(normalizedAlias)) {
        score += 4;
        reasons.push(`header matched "${alias}"`);
      } else if (normalizedHaystacks[2]?.includes(normalizedAlias)) {
        score += 3;
        reasons.push(`text matched "${alias}"`);
      } else if (normalizedHaystacks[0]?.includes(normalizedAlias)) {
        score += 2;
        reasons.push(`file name matched "${alias}"`);
      }
    }

    for (const keyword of profile.statementKeywords) {
      const normalizedKeyword = normalizeBankText(keyword);
      if (normalizedHaystacks[1]?.includes(normalizedKeyword)) {
        score += 2;
        reasons.push(`header keyword "${keyword}"`);
      } else if (normalizedHaystacks[2]?.includes(normalizedKeyword)) {
        score += 1;
        reasons.push(`text keyword "${keyword}"`);
      }
    }

    return {
      profile,
      score,
      reasons: Array.from(new Set(reasons)).slice(0, 4),
    };
  }).sort((left, right) => right.score - left.score);

  const best = scoreBoard[0];
  const second = scoreBoard[1];

  if (!best || best.score < 2 || (second && best.score - second.score < 2)) {
    return makeIdentityResult({
      confidence: best?.score >= 2 ? 'low' : 'unknown',
      source: 'deterministic',
      reasons: best?.reasons || [],
    });
  }

  return makeIdentityResult({
    bankSlug: best.profile.slug,
    displayName: best.profile.displayName,
    confidence: toConfidenceLabel(best.score),
    source: 'deterministic',
    parserHint: best.profile.parserKey,
    reasons: best.reasons,
  });
};

const parseJsonObject = (value) => {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    const objectMatch = String(value).match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;

    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      return null;
    }
  }
};

const classifyWithGroq = async (evidence = {}) => {
  if (!groq || process.env.NODE_ENV === 'test') {
    return null;
  }

  const evidenceText = buildEvidenceText(evidence);
  if (!evidenceText) {
    return null;
  }

  const supportedBanks = getSupportedBanks();
  const completion = await withTimeout(
    groq.chat.completions.create({
      model: GROQ_BANK_CLASSIFIER_MODEL,
      temperature: 0.1,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            'You classify Nigerian bank statements. Return ONLY valid JSON with keys bankSlug, confidence, reasons. bankSlug must be one of the provided values or "unknown". confidence must be "high", "medium", "low", or "unknown".',
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'classify_bank_statement',
            supportedBanks,
            evidence: {
              fileName: evidence.fileName || null,
              headerText: evidence.headerText || null,
              tableHeaders: evidence.tableHeaders || [],
              accountNumberHint: evidence.accountNumberHint || null,
              rawText: evidenceText,
            },
          }),
        },
      ],
    }),
    GROQ_TIMEOUT_MS,
  );

  const parsed = parseJsonObject(completion?.choices?.[0]?.message?.content);
  if (!parsed?.bankSlug) {
    return null;
  }

  const profile = findBankProfile(parsed.bankSlug);
  if (!profile) {
    return makeIdentityResult({
      confidence: parsed.confidence || 'unknown',
      source: 'groq',
      reasons: parsed.reasons || [],
    });
  }

  return makeIdentityResult({
    bankSlug: profile.slug,
    displayName: profile.displayName,
    confidence: parsed.confidence || 'medium',
    source: 'groq',
    parserHint: profile.parserKey,
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 4) : [],
  });
};

const chooseBetterIdentity = (primary, secondary) => {
  if (!secondary) return primary;
  if (!primary) return secondary;

  if (CONFIDENCE_ORDER[secondary.confidence] > CONFIDENCE_ORDER[primary.confidence]) {
    return secondary;
  }

  return primary;
};

const classifyDocumentIdentity = async (evidence = {}) => {
  const hintedProfile = resolveBankProfile(evidence.bankHint);
  if (hintedProfile) {
    return makeIdentityResult({
      bankSlug: hintedProfile.slug,
      displayName: hintedProfile.displayName,
      confidence: 'high',
      source: 'upload_hint',
      parserHint: hintedProfile.parserKey,
      reasons: ['user supplied bank hint'],
    });
  }

  const deterministic = scoreDeterministicIdentity(evidence);
  let selected = deterministic;

  try {
    const groqResult = await classifyWithGroq(evidence);
    if (groqResult && groqResult.bankSlug !== 'unknown') {
      if (deterministic.bankSlug === groqResult.bankSlug && deterministic.bankSlug !== 'unknown') {
        selected = chooseBetterIdentity(groqResult, deterministic);
        selected.reasons = Array.from(new Set([...(groqResult.reasons || []), ...(deterministic.reasons || [])])).slice(0, 4);
      } else if (groqResult.confidence === 'high') {
        selected = groqResult;
      } else if (deterministic.confidence === 'unknown' || deterministic.confidence === 'low') {
        selected = groqResult;
      }
    }
  } catch (error) {
    selected = makeIdentityResult({
      ...deterministic,
      reasons: [...(deterministic.reasons || []), `Groq unavailable: ${error.message}`].slice(0, 4),
    });
  }

  if (selected.bankSlug === 'unknown') {
    return makeIdentityResult({
      confidence: selected.confidence,
      source: selected.source,
      reasons: selected.reasons,
    });
  }

  return selected;
};

module.exports = {
  GROQ_BANK_CLASSIFIER_MODEL,
  buildEvidenceText,
  classifyDocumentIdentity,
  getSupportedBanks,
  makeIdentityResult,
  scoreDeterministicIdentity,
};
