const fs = require('fs');

const StatementImport = require('../models/StatementImport');
const StatementImportRow = require('../models/StatementImportRow');
const Category = require('../models/Category');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const ImportedTransactionMap = require('../models/ImportedTransactionMap');

const { buildScopedExternalId } = require('./transactionIngest.service');
const { classifyStatementRow } = require('./statementClassifier.service');
const { suggestCategoryForRowWithAI } = require('./statementCategory.service');
const { detectDuplicateForRow } = require('./statementDuplicate.service');
const { detectFileType, extractStatementContent, safeUnlink } = require('./statementExtraction.service');
const { parseStatementSource } = require('./statementParser.service');
const { summarizeStatementMetadata } = require('./statementLLM.service');
const { hasTimeComponent, parseDateValue } = require('./statementStructure.service');

const FINAL_IMPORT_STATUSES = new Set(['imported', 'cancelled']);
const ACTIVE_POLL_STATUSES = new Set(['uploaded', 'extracting', 'parsed']);

const IMPORT_SOURCE_TYPE = 'import_job';

const formatRowForResponse = (row) => ({
  _id: row._id,
  id: row._id,
  statementImportId: row.statementImportId,
  transactionDate: row.transactionDate,
  transactionTimeProvided: Boolean(row.transactionTimeProvided),
  transactionType: row.transactionType,
  rawDescription: row.rawDescription,
  description: row.description,
  counterParty: row.counterParty,
  transactionId: row.transactionId,
  debit: row.debit,
  credit: row.credit,
  amount: row.amount,
  balance: row.balance ?? null,
  direction: row.direction,
  classification: row.classification,
  categoryId: row.categoryId?._id || row.categoryId || null,
  category: row.categoryId?.name
    ? {
        id: row.categoryId._id,
        _id: row.categoryId._id,
        name: row.categoryId.name,
        icon: row.categoryId.icon,
        color: row.categoryId.color,
        type: row.categoryId.type,
      }
    : null,
  suggestedCategoryName: row.suggestedCategoryName,
  confidence: row.confidence,
  status: row.status,
  duplicateHash: row.duplicateHash,
  isDuplicate: row.isDuplicate,
  validationErrors: row.validationErrors || [],
  importedTransactionId: row.importedTransactionId || null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const formatImportForResponse = (statementImport) => ({
  _id: statementImport._id,
  id: statementImport._id,
  fileName: statementImport.fileName,
  fileType: statementImport.fileType,
  fileSize: statementImport.fileSize,
  source: statementImport.source,
  bankName: statementImport.bankName,
  statementPeriodStart: statementImport.statementPeriodStart,
  statementPeriodEnd: statementImport.statementPeriodEnd,
  currency: statementImport.currency,
  status: statementImport.status,
  extractionMethod: statementImport.extractionMethod,
  extractionProvider: statementImport.extractionProvider,
  extractionModel: statementImport.extractionModel,
  extractionQualityScore: statementImport.extractionQualityScore,
  extractionConfidenceSummary: statementImport.extractionConfidenceSummary || null,
  totalRows: statementImport.totalRows,
  readyRows: statementImport.readyRows,
  needsReviewRows: statementImport.needsReviewRows,
  duplicateRows: statementImport.duplicateRows,
  failedRows: statementImport.failedRows,
  ignoredRows: statementImport.ignoredRows,
  importedRows: statementImport.importedRows,
  errorMessage: statementImport.errorMessage,
  isProcessing: ACTIVE_POLL_STATUSES.has(statementImport.status),
  canConfirm: statementImport.status === 'reviewing' && statementImport.readyRows > 0,
  createdAt: statementImport.createdAt,
  updatedAt: statementImport.updatedAt,
});

const buildScopedImportExternalId = (statementImportId, externalId) =>
  buildScopedExternalId(`statement:${statementImportId}`, externalId);

const ALLOWED_REVIEW_CLASSIFICATIONS = new Set(['income', 'expense']);

const describeStatementImportError = (error) => {
  const message = String(error?.message || '').trim();

  if (!message) {
    return 'We could not prepare a preview for this statement. Please try again with a clearer bank statement file.';
  }

  if (/no longer available/i.test(message)) {
    return 'The uploaded statement file is no longer available on the server. Please upload the statement again and wait for the preview to finish.';
  }

  if (/ocr fallback is unavailable/i.test(message)) {
    return 'SEFA could not scan this statement because OCR is not available right now. Try uploading a text-based PDF export or a clearer image scan.';
  }

  if (/could not find enough readable transaction details/i.test(message)) {
    return message;
  }

  if (/worksheet/i.test(message) || /excel statement/i.test(message)) {
    return `We could not read this spreadsheet statement. ${message}`;
  }

  return `We could not prepare a preview for this statement. ${message}`;
};

const computePeriod = (rows) => {
  const validDates = rows
    .map((row) => row.transactionDate)
    .filter((value) => value && !Number.isNaN(new Date(value).getTime()))
    .map((value) => new Date(value));

  if (!validDates.length) {
    return {
      statementPeriodStart: null,
      statementPeriodEnd: null,
    };
  }

  return {
    statementPeriodStart: new Date(Math.min(...validDates.map((date) => date.getTime()))),
    statementPeriodEnd: new Date(Math.max(...validDates.map((date) => date.getTime()))),
  };
};

const inferBankName = (fileName, text) => {
  const safeText = `${fileName || ''} ${text || ''}`.toLowerCase();
  if (safeText.includes('opay')) return 'OPay';
  if (safeText.includes('moniepoint')) return 'Moniepoint';
  if (safeText.includes('palmpay')) return 'PalmPay';
  return null;
};

const refreshImportCounters = async (statementImportId) => {
  const rows = await StatementImportRow.find({ statementImportId }).select('status');

  const counters = {
    totalRows: rows.length,
    readyRows: 0,
    needsReviewRows: 0,
    duplicateRows: 0,
    failedRows: 0,
    ignoredRows: 0,
    importedRows: 0,
  };

  for (const row of rows) {
    switch (row.status) {
      case 'ready':
        counters.readyRows += 1;
        break;
      case 'needs_review':
        counters.needsReviewRows += 1;
        break;
      case 'duplicate':
        counters.duplicateRows += 1;
        break;
      case 'failed':
        counters.failedRows += 1;
        break;
      case 'ignored':
        counters.ignoredRows += 1;
        break;
      case 'imported':
        counters.importedRows += 1;
        break;
      default:
        break;
    }
  }

  await StatementImport.findByIdAndUpdate(statementImportId, counters);
  return counters;
};

const buildRowStatus = (row, categorySuggestion, duplicateInfo, validationErrors) => {
  if (duplicateInfo.isDuplicate) {
    return 'duplicate';
  }

  if (validationErrors.length > 0 && !row.amount) {
    return 'failed';
  }

  if (
    !['income', 'expense'].includes(row.classification)
    || validationErrors.length > 0
    || categorySuggestion.usedFallback
    || categorySuggestion.confidence < 0.6
    || Number(row.confidence || 0) < 0.6
  ) {
    return 'needs_review';
  }

  return 'ready';
};

const buildStatementRows = async (statementImport, parsedRows) => {
  const uncategorizedCache = new Map();
  const seenKeys = new Set();
  const docs = [];

  for (const parsedRow of parsedRows) {
    const parserErrors = Array.isArray(parsedRow.validationErrors) ? parsedRow.validationErrors.filter(Boolean) : [];

    if (parserErrors.length > 0 && !parsedRow.amount) {
      docs.push({
        userId: statementImport.userId,
        statementImportId: statementImport._id,
        transactionDate: parsedRow.transactionDate || null,
        transactionTimeProvided: Boolean(parsedRow.transactionTimeProvided),
        transactionType: parsedRow.transactionType || null,
        rawDescription: parsedRow.rawDescription || '',
        description: parsedRow.description || parsedRow.rawDescription || '',
        counterParty: parsedRow.counterParty || null,
        transactionId: parsedRow.transactionId || null,
        debit: Math.abs(Number(parsedRow.debit || 0)),
        credit: Math.abs(Number(parsedRow.credit || 0)),
        amount: Math.abs(Number(parsedRow.amount || 0)),
        balance: parsedRow.balance ?? null,
        direction: 'unknown',
        classification: 'unknown',
        categoryId: null,
        suggestedCategoryName: null,
        confidence: Number(parsedRow.confidence || 0.1),
        status: 'failed',
        duplicateHash: null,
        isDuplicate: false,
        validationErrors: parserErrors,
      });
      continue;
    }

    const classification = classifyStatementRow(parsedRow);
    const categorySuggestion = await suggestCategoryForRowWithAI(
      {
        userId: statementImport.userId,
        classification: classification.classification,
        description: parsedRow.description,
        transactionType: parsedRow.transactionType,
        amount: parsedRow.amount,
      },
      uncategorizedCache,
    );

    const duplicateInfo = await detectDuplicateForRow(statementImport.userId, parsedRow);
    const localDuplicateKey = parsedRow.transactionId || duplicateInfo.duplicateHash;
    const isLocalDuplicate = seenKeys.has(localDuplicateKey);
    seenKeys.add(localDuplicateKey);

    const combinedErrors = [...parserErrors, ...classification.validationErrors];
    if (isLocalDuplicate) {
      combinedErrors.push('Duplicate transaction found within this statement');
    }

    const rowStatus = isLocalDuplicate
      ? 'duplicate'
      : buildRowStatus(
          {
            ...parsedRow,
            classification: classification.classification,
          },
          categorySuggestion,
          duplicateInfo,
          combinedErrors,
        );

    docs.push({
      userId: statementImport.userId,
      statementImportId: statementImport._id,
      transactionDate: parsedRow.transactionDate,
      transactionTimeProvided: Boolean(parsedRow.transactionTimeProvided),
      transactionType: parsedRow.transactionType || null,
      rawDescription: parsedRow.rawDescription || '',
      description: parsedRow.description || parsedRow.rawDescription || '',
      counterParty: parsedRow.counterParty || null,
      transactionId: parsedRow.transactionId || null,
      debit: Math.abs(Number(parsedRow.debit || 0)),
      credit: Math.abs(Number(parsedRow.credit || 0)),
      amount: Math.abs(Number(parsedRow.amount || 0)),
      balance: parsedRow.balance ?? null,
      direction: classification.direction,
      classification: classification.classification,
      categoryId: categorySuggestion.categoryId,
      suggestedCategoryName: categorySuggestion.suggestedCategoryName,
      confidence: Number(Math.min(categorySuggestion.confidence, parsedRow.confidence ?? categorySuggestion.confidence).toFixed(2)),
      status: rowStatus,
      duplicateHash: duplicateInfo.duplicateHash,
      isDuplicate: duplicateInfo.isDuplicate || isLocalDuplicate,
      validationErrors: combinedErrors,
    });
  }

  return docs;
};

const createStatementImportSession = async ({ userId, file }) => {
  return StatementImport.create({
    userId,
    fileName: file.originalname,
    fileType: file.mimetype || 'application/octet-stream',
    fileSize: file.size,
    source: 'manual_upload',
    status: 'uploaded',
  });
};

const processStatementImportJob = async ({ statementImportId, filePath }) => {
  const statementImport = await StatementImport.findById(statementImportId);
  if (!statementImport || statementImport.status === 'cancelled') {
    await safeUnlink(filePath);
    return { success: false, skipped: true };
  }

  try {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
    } catch (_error) {
      throw new Error('The uploaded statement file is no longer available. Please upload the statement again.');
    }

    statementImport.status = 'extracting';
    statementImport.errorMessage = null;
    await statementImport.save();

    const detectedFileType = detectFileType({
      filePath,
      fileName: statementImport.fileName,
      mimeType: statementImport.fileType,
    });

    statementImport.extractionMethod = ['pdf', 'image'].includes(detectedFileType)
      ? 'openai_file_prompt'
      : 'openai_table_prompt';
    statementImport.extractionProvider = 'azure-openai';
    statementImport.extractionModel = String(
      process.env.AZURE_OPENAI_MODEL_NAME || process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'azure-openai',
    ).trim();
    statementImport.extractionQualityScore = 0;
    statementImport.fileType = statementImport.fileType || detectedFileType;
    await statementImport.save();

    let extractedContent = null;
    if (!['pdf', 'image'].includes(detectedFileType)) {
      extractedContent = await extractStatementContent(filePath, {
        fileName: statementImport.fileName,
        mimeType: statementImport.fileType,
      });
    }

    const parsed = await parseStatementSource({
      filePath,
      fileName: statementImport.fileName,
      mimeType: statementImport.fileType,
      fileType: detectedFileType,
      text: extractedContent?.text || '',
      tableRows: extractedContent?.tableRows || null,
      allowAiFallback: true,
    });
    statementImport.status = 'parsed';
    statementImport.extractionConfidenceSummary = parsed.extractionMetadata?.confidenceSummary || {
      averageConfidence: 0,
      highConfidenceCount: 0,
      mediumConfidenceCount: 0,
      lowConfidenceCount: 0,
      unknownConfidenceCount: 0,
    };
    statementImport.extractionQualityScore = Number(
      statementImport.extractionConfidenceSummary.averageConfidence || 0,
    );
    await statementImport.save();

    await StatementImportRow.deleteMany({ statementImportId: statementImport._id });
    const rowDocs = await buildStatementRows(statementImport, parsed.rows);
    if (rowDocs.length > 0) {
      await StatementImportRow.insertMany(rowDocs, { ordered: false });
    }

    const counters = await refreshImportCounters(statementImport._id);
    const period = computePeriod(rowDocs);
    const metadata = await summarizeStatementMetadata({
      fileName: statementImport.fileName,
      fileType: detectedFileType,
      extractedRows: parsed.rows,
    });

    statementImport.status = 'reviewing';
    statementImport.statementPeriodStart = period.statementPeriodStart;
    statementImport.statementPeriodEnd = period.statementPeriodEnd;
    statementImport.bankName = metadata.bankName || inferBankName(statementImport.fileName, '');
    statementImport.currency = metadata.currency || 'NGN';
    statementImport.totalRows = counters.totalRows;
    statementImport.readyRows = counters.readyRows;
    statementImport.needsReviewRows = counters.needsReviewRows;
    statementImport.duplicateRows = counters.duplicateRows;
    statementImport.failedRows = counters.failedRows;
    statementImport.ignoredRows = counters.ignoredRows;
    statementImport.importedRows = counters.importedRows;
    await statementImport.save();

    return {
      success: true,
      importId: statementImport._id,
      totalRows: counters.totalRows,
      readyRows: counters.readyRows,
    };
  } catch (error) {
    statementImport.status = 'failed';
    statementImport.errorMessage = describeStatementImportError(error);
    await statementImport.save().catch(() => undefined);
    throw error;
  } finally {
    await safeUnlink(filePath);
  }
};

const getStatementImportById = async (userId, statementImportId) => {
  return StatementImport.findOne({ _id: statementImportId, userId });
};

const listStatementImports = async (userId, { page = 1, limit = 10 } = {}) => {
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
  const skip = (pageNum - 1) * limitNum;

  const [imports, total] = await Promise.all([
    StatementImport.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
    StatementImport.countDocuments({ userId }),
  ]);

  return {
    imports: imports.map(formatImportForResponse),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum) || 1,
      hasMore: skip + imports.length < total,
    },
  };
};

const getStatementImportRows = async (userId, statementImportId, { page = 1, limit = 25, status, search } = {}) => {
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const skip = (pageNum - 1) * limitNum;

  const query = { userId, statementImportId };
  if (status) {
    query.status = status;
  }
  if (search) {
    query.$or = [
      { description: { $regex: search, $options: 'i' } },
      { rawDescription: { $regex: search, $options: 'i' } },
      { counterParty: { $regex: search, $options: 'i' } },
    ];
  }

  const [rows, total] = await Promise.all([
    StatementImportRow.find(query)
      .populate('categoryId', 'name icon color type')
      .sort({ transactionDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limitNum),
    StatementImportRow.countDocuments(query),
  ]);

  return {
    rows: rows.map(formatRowForResponse),
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum) || 1,
      hasMore: skip + rows.length < total,
    },
  };
};

const validateRowCategory = async (userId, categoryId, classification) => {
  if (!categoryId) {
    return { valid: false, error: 'Category is required before a row can be approved' };
  }

  if (!['income', 'expense'].includes(classification)) {
    return { valid: false, error: 'Only income or expense rows can be approved for import' };
  }

  const category = await Category.findOne({
    _id: categoryId,
    userId,
    type: classification,
    isActive: true,
  }).select('_id name icon color type');

  if (!category) {
    return { valid: false, error: `Selected category is not an active ${classification} category` };
  }

  return { valid: true, category };
};

const recomputeRowState = async (statementImport, row) => {
  const duplicateInfo = await detectDuplicateForRow(statementImport.userId, row);
  const validationErrors = [];

  if (!row.description?.trim()) {
    validationErrors.push('Description is required');
  }
  if (!row.transactionDate || Number.isNaN(new Date(row.transactionDate).getTime())) {
    validationErrors.push('Transaction date is required');
  }
  if (!row.amount || row.amount <= 0) {
    validationErrors.push('Amount must be greater than zero');
  }

  const categoryValidation = await validateRowCategory(
    statementImport.userId,
    row.categoryId,
    row.classification,
  );
  if (!categoryValidation.valid && row.status !== 'ignored') {
    validationErrors.push(categoryValidation.error);
  }

  row.duplicateHash = duplicateInfo.duplicateHash;
  row.isDuplicate = duplicateInfo.isDuplicate;
  row.validationErrors = validationErrors;

  if (row.status === 'ignored') {
    return row;
  }

  if (duplicateInfo.isDuplicate) {
    row.status = 'duplicate';
    return row;
  }

  if (
    ['income', 'expense'].includes(row.classification)
    && validationErrors.length === 0
  ) {
    row.status = 'ready';
    return row;
  }

  row.status = 'needs_review';
  return row;
};

const updateStatementImportRow = async (userId, statementImportId, rowId, input) => {
  const statementImport = await getStatementImportById(userId, statementImportId);
  if (!statementImport) {
    throw new Error('Statement import not found');
  }
  if (FINAL_IMPORT_STATUSES.has(statementImport.status)) {
    throw new Error('This statement import can no longer be edited');
  }

  const row = await StatementImportRow.findOne({ _id: rowId, userId, statementImportId });
  if (!row) {
    throw new Error('Statement import row not found');
  }

  if (input.description !== undefined) {
    row.description = String(input.description || '').trim();
  }
  if (input.transactionDate !== undefined) {
    row.transactionDate = input.transactionDate ? parseDateValue(input.transactionDate) : null;
    row.transactionTimeProvided = Boolean(input.transactionDate && hasTimeComponent(input.transactionDate));
  }
  if (input.amount !== undefined) {
    row.amount = Math.abs(Number(input.amount || 0));
  }
  if (input.classification !== undefined) {
    if (!ALLOWED_REVIEW_CLASSIFICATIONS.has(input.classification)) {
      throw new Error('Classification must be either income or expense');
    }
    row.classification = input.classification;
  }
  if (input.categoryId !== undefined) {
    row.categoryId = input.categoryId || null;
  }
  if (input.status === 'ignored') {
    row.status = 'ignored';
  } else if (input.status && input.status !== row.status) {
    row.status = input.status;
  }

  if (row.classification === 'expense') {
    row.direction = 'debit';
    row.debit = row.amount;
    row.credit = 0;
  } else if (row.classification === 'income') {
    row.direction = 'credit';
    row.credit = row.amount;
    row.debit = 0;
  }

  await recomputeRowState(statementImport, row);
  await row.save();
  await refreshImportCounters(statementImportId);

  const populated = await StatementImportRow.findById(row._id).populate('categoryId', 'name icon color type');
  return formatRowForResponse(populated);
};

const buildImportPayloads = async (statementImport, rows) => {
  const expenses = [];
  const incomes = [];
  const mappings = [];

  for (const row of rows) {
    const rawExternalId = row.transactionId || row.duplicateHash || String(row._id);
    const scopedExternalId = buildScopedImportExternalId(statementImport._id, rawExternalId);

    if (row.classification === 'expense') {
      expenses.push({
        userId: statementImport.userId,
        categoryId: row.categoryId,
        amount: row.amount,
        description: row.description,
        date: row.transactionDate,
        statementTimeProvided: Boolean(row.transactionTimeProvided),
        paymentMethod: 'bank_transfer',
        location: row.counterParty || null,
        isImported: true,
        importJobId: statementImport._id,
        externalId: scopedExternalId,
      });
    } else {
      incomes.push({
        userId: statementImport.userId,
        categoryId: row.categoryId,
        amount: row.amount,
        source: row.counterParty || row.description,
        description: row.description,
        date: row.transactionDate,
        statementTimeProvided: Boolean(row.transactionTimeProvided),
        paymentMethod: 'bank_transfer',
        isImported: true,
        importJobId: statementImport._id,
        externalId: scopedExternalId,
      });
    }

    mappings.push({
      userId: statementImport.userId,
      sourceType: IMPORT_SOURCE_TYPE,
      sourceRefId: statementImport._id,
      importJobId: statementImport._id,
      provider: statementImport.bankName ? `statement_${statementImport.bankName.toLowerCase()}` : 'statement_import',
      externalId: rawExternalId,
      scopedExternalId,
      rowId: row._id,
      kind: row.classification,
      rawData: {
        statementImportId: statementImport._id,
        statementImportRowId: row._id,
        description: row.description,
        amount: row.amount,
        balance: row.balance ?? null,
        transactionDate: row.transactionDate,
      },
    });
  }

  return { expenses, incomes, mappings };
};

const confirmStatementImport = async (userId, statementImportId) => {
  const statementImport = await getStatementImportById(userId, statementImportId);
  if (!statementImport) {
    throw new Error('Statement import not found');
  }
  if (statementImport.status === 'imported') {
    throw new Error('This statement has already been imported');
  }
  if (statementImport.status === 'cancelled') {
    throw new Error('This statement import has been cancelled');
  }

  const rows = await StatementImportRow.find({
    userId,
    statementImportId,
    status: 'ready',
  });

  if (!rows.length) {
    throw new Error('There are no approved rows ready to import');
  }

  const payloads = await buildImportPayloads(statementImport, rows);
  const [createdExpenses, createdIncomes] = await Promise.all([
    payloads.expenses.length ? Expense.insertMany(payloads.expenses, { ordered: true }) : [],
    payloads.incomes.length ? Income.insertMany(payloads.incomes, { ordered: true }) : [],
  ]);

  const externalIdToTransactionId = new Map();
  for (const expense of createdExpenses) {
    externalIdToTransactionId.set(expense.externalId, expense._id);
  }
  for (const income of createdIncomes) {
    externalIdToTransactionId.set(income.externalId, income._id);
  }

  if (payloads.mappings.length) {
    await ImportedTransactionMap.bulkWrite(
      payloads.mappings.map((mapping) => ({
        updateOne: {
          filter: {
            userId,
            sourceType: mapping.sourceType,
            sourceRefId: mapping.sourceRefId,
            externalId: mapping.externalId,
          },
          update: {
            $set: {
              userId,
              sourceType: mapping.sourceType,
              sourceRefId: mapping.sourceRefId,
              importJobId: mapping.importJobId,
              provider: mapping.provider,
              externalId: mapping.externalId,
              expenseId:
                mapping.kind === 'expense'
                  ? externalIdToTransactionId.get(mapping.scopedExternalId)
                  : null,
              incomeId:
                mapping.kind === 'income'
                  ? externalIdToTransactionId.get(mapping.scopedExternalId)
                  : null,
              rawData: mapping.rawData,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  const bulkUpdates = rows.map((row) => {
    const rawExternalId = row.transactionId || row.duplicateHash || String(row._id);
    const scopedExternalId = buildScopedImportExternalId(statementImport._id, rawExternalId);
    return {
      updateOne: {
        filter: { _id: row._id },
        update: {
          $set: {
            status: 'imported',
            importedTransactionId: externalIdToTransactionId.get(scopedExternalId) || null,
          },
        },
      },
    };
  });

  if (bulkUpdates.length) {
    await StatementImportRow.bulkWrite(bulkUpdates, { ordered: false });
  }

  const counters = await refreshImportCounters(statementImportId);
  statementImport.status = 'imported';
  statementImport.totalRows = counters.totalRows;
  statementImport.readyRows = counters.readyRows;
  statementImport.needsReviewRows = counters.needsReviewRows;
  statementImport.duplicateRows = counters.duplicateRows;
  statementImport.failedRows = counters.failedRows;
  statementImport.ignoredRows = counters.ignoredRows;
  statementImport.importedRows = counters.importedRows;
  await statementImport.save();

  const { addNotificationJob } = require('../config/queue');
  await addNotificationJob({
    userId,
    type: 'import_complete',
    urgency: 'instant',
    data: {
      fileName: statementImport.fileName,
      importedRows: counters.importedRows,
      duplicateRows: counters.duplicateRows,
      ignoredRows: counters.ignoredRows,
      failedRows: counters.failedRows,
      needsReviewRows: counters.needsReviewRows,
    },
  }).catch(() => undefined);

  return {
    totalRows: counters.totalRows,
    importedRows: counters.importedRows,
    duplicateRows: counters.duplicateRows,
    ignoredRows: counters.ignoredRows,
    failedRows: counters.failedRows,
    needsReviewRows: counters.needsReviewRows,
  };
};

const cancelStatementImport = async (userId, statementImportId) => {
  const statementImport = await getStatementImportById(userId, statementImportId);
  if (!statementImport) {
    throw new Error('Statement import not found');
  }
  if (statementImport.status === 'imported') {
    throw new Error('Imported statements cannot be deleted');
  }

  await StatementImportRow.deleteMany({ userId, statementImportId });
  statementImport.status = 'cancelled';
  statementImport.errorMessage = null;
  statementImport.totalRows = 0;
  statementImport.readyRows = 0;
  statementImport.needsReviewRows = 0;
  statementImport.duplicateRows = 0;
  statementImport.failedRows = 0;
  statementImport.ignoredRows = 0;
  statementImport.importedRows = 0;
  await statementImport.save();
};

module.exports = {
  cancelStatementImport,
  confirmStatementImport,
  createStatementImportSession,
  formatImportForResponse,
  formatRowForResponse,
  getStatementImportById,
  getStatementImportRows,
  listStatementImports,
  processStatementImportJob,
  refreshImportCounters,
  updateStatementImportRow,
};
