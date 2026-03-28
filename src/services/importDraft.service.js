const Category = require('../models/Category');
const ImportDraftRow = require('../models/ImportDraftRow');
const { getSupportedBanks } = require('./bankProfiles');
const { buildDraftRows } = require('./transactionIngest.service');

const GENERIC_BANK_OPTION = {
  slug: 'generic',
  displayName: 'Other / Unsupported bank',
};

const directionToCategoryType = (direction) => (direction === 'credit' ? 'income' : 'expense');

const normalizeDraftDirection = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (['credit', 'cr', 'income', 'deposit'].includes(normalized)) {
    return 'credit';
  }

  if (['debit', 'dr', 'expense', 'withdrawal'].includes(normalized)) {
    return 'debit';
  }

  return null;
};

const getImportBankOptions = () => [...getSupportedBanks(), GENERIC_BANK_OPTION];

const summarizeDraftRows = (rows = []) => {
  const includedRows = rows.filter((row) => !row.excluded);
  const excludedRows = rows.length - includedRows.length;
  const debitTotal = includedRows
    .filter((row) => row.direction === 'debit')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const creditTotal = includedRows
    .filter((row) => row.direction === 'credit')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const lowConfidenceRows = rows.filter((row) => row.confidence === 'low').length;
  const flaggedRows = rows.filter((row) => (row.issueFlags || []).length > 0).length;

  return {
    totalRows: rows.length,
    includedRows: includedRows.length,
    excludedRows,
    debitTotal,
    creditTotal,
    lowConfidenceRows,
    flaggedRows,
  };
};

const getDraftRows = async (importJobId, userId) =>
  ImportDraftRow.find({ importJobId, userId }).sort({ rowIndex: 1 });

const refreshImportJobDraftSummary = async (importJob) => {
  const rows = await getDraftRows(importJob._id, importJob.userId);
  importJob.draftSummary = summarizeDraftRows(rows);
  return importJob.draftSummary;
};

const replaceImportDraftRows = async ({ importJob, parsed, context }) => {
  const draft = await buildDraftRows(parsed.transactions, context, {
    allowAi: true,
    bankDetectionConfidence: parsed.bankDetectionConfidence,
    ocrProvider: parsed.ocrProvider,
  });

  await ImportDraftRow.deleteMany({
    importJobId: importJob._id,
    userId: importJob.userId,
  });

  if (draft.rows.length > 0) {
    await ImportDraftRow.insertMany(
      draft.rows.map((row, index) => ({
        importJobId: importJob._id,
        userId: importJob.userId,
        rowIndex: index,
        ...row,
      })),
    );
  }

  importJob.draftSummary = summarizeDraftRows(draft.rows);

  return {
    ...draft,
    summary: importJob.draftSummary,
  };
};

const validateCategoryForDraft = async ({ userId, categoryId, direction }) => {
  if (!categoryId) {
    return null;
  }

  const category = await Category.findOne({
    _id: categoryId,
    userId,
    type: directionToCategoryType(direction),
    isActive: true,
  }).select('_id name icon color type');

  if (!category) {
    const error = new Error('Selected category not found or does not match the transaction type');
    error.statusCode = 400;
    throw error;
  }

  return category;
};

const suggestDraftCategory = async ({ userId, row, bankDetectionConfidence = 'medium', ocrProvider = null }) => {
  const draft = await buildDraftRows(
    [
      {
        date: row.date,
        amount: row.amount,
        description: row.description,
        direction: row.direction,
        reference: row.reference,
        balance: row.balance,
        rawData: row.rawData,
      },
    ],
    {
      userId,
      provider: 'statement_draft',
      externalIdScope: 'statement-draft',
    },
    {
      allowAi: true,
      bankDetectionConfidence,
      ocrProvider,
    },
  );

  return draft.rows[0] || null;
};

module.exports = {
  GENERIC_BANK_OPTION,
  getDraftRows,
  getImportBankOptions,
  normalizeDraftDirection,
  refreshImportJobDraftSummary,
  replaceImportDraftRows,
  suggestDraftCategory,
  summarizeDraftRows,
  validateCategoryForDraft,
};
