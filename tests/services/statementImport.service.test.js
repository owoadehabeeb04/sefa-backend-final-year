const mongoose = require('mongoose');

const Category = require('../../src/models/Category');
const Expense = require('../../src/models/Expense');
const Income = require('../../src/models/Income');
const ImportedTransactionMap = require('../../src/models/ImportedTransactionMap');
const StatementImport = require('../../src/models/StatementImport');
const StatementImportRow = require('../../src/models/StatementImportRow');
const { confirmStatementImport } = require('../../src/services/statementImport.service');
const { buildScopedExternalId } = require('../../src/services/transactionIngest.service');

jest.mock('../../src/config/queue', () => ({
  addNotificationJob: jest.fn().mockResolvedValue({}),
}));

describe('statementImport.service confirm import', () => {
  const userId = new mongoose.Types.ObjectId();
  let expenseCategory;
  let incomeCategory;

  beforeEach(async () => {
    [expenseCategory, incomeCategory] = await Category.create([
      { userId, name: 'Food & Dining', type: 'expense', source: 'system' },
      { userId, name: 'Salary', type: 'income', source: 'system' },
    ]);
  });

  it('imports only ready rows into the existing finance models', async () => {
    const statementImport = await StatementImport.create({
      userId,
      fileName: 'statement.pdf',
      fileType: 'application/pdf',
      fileSize: 1024,
      status: 'reviewing',
    });

    await StatementImportRow.create([
      {
        userId,
        statementImportId: statementImport._id,
        transactionDate: new Date('2026-04-01T09:00:00.000Z'),
        description: 'Foodco meal',
        rawDescription: 'Foodco meal',
        amount: 5000,
        debit: 5000,
        direction: 'debit',
        classification: 'expense',
        categoryId: expenseCategory._id,
        suggestedCategoryName: expenseCategory.name,
        confidence: 0.9,
        status: 'ready',
      },
      {
        userId,
        statementImportId: statementImport._id,
        transactionDate: new Date('2026-04-02T09:00:00.000Z'),
        description: 'Payroll payment',
        rawDescription: 'Payroll payment',
        amount: 120000,
        credit: 120000,
        direction: 'credit',
        classification: 'income',
        categoryId: incomeCategory._id,
        suggestedCategoryName: incomeCategory.name,
        confidence: 0.9,
        status: 'ready',
      },
      {
        userId,
        statementImportId: statementImport._id,
        transactionDate: new Date('2026-04-03T09:00:00.000Z'),
        description: 'Duplicate row',
        rawDescription: 'Duplicate row',
        amount: 1000,
        debit: 1000,
        direction: 'debit',
        classification: 'expense',
        categoryId: expenseCategory._id,
        suggestedCategoryName: expenseCategory.name,
        confidence: 0.2,
        status: 'duplicate',
      },
    ]);

    const summary = await confirmStatementImport(userId, statementImport._id);

    expect(summary.importedRows).toBe(2);
    expect(await Expense.countDocuments({ userId })).toBe(1);
    expect(await Income.countDocuments({ userId })).toBe(1);
    expect(await ImportedTransactionMap.countDocuments({ userId, sourceRefId: statementImport._id })).toBe(2);
    expect(await StatementImportRow.countDocuments({ statementImportId: statementImport._id, status: 'imported' })).toBe(2);
  });

  it('imports distinct rows that share a transaction reference (bank charges) without a duplicate-key crash', async () => {
    const statementImport = await StatementImport.create({
      userId,
      fileName: 'opay.pdf',
      fileType: 'application/pdf',
      fileSize: 2048,
      status: 'reviewing',
    });

    // A transfer and its charges that the model tagged with the SAME reference.
    const sharedRef = 'FTN0251761783/1021670598';
    await StatementImportRow.create([
      {
        userId,
        statementImportId: statementImport._id,
        transactionDate: new Date('2026-06-03T09:00:00.000Z'),
        description: 'Transfer to OPay',
        rawDescription: 'Transfer to OPay',
        amount: 20000,
        debit: 20000,
        direction: 'debit',
        classification: 'expense',
        categoryId: expenseCategory._id,
        transactionId: sharedRef,
        confidence: 0.9,
        status: 'ready',
      },
      {
        userId,
        statementImportId: statementImport._id,
        transactionDate: new Date('2026-06-03T09:00:00.000Z'),
        description: 'SMS alert charge',
        rawDescription: 'SMS alert charge',
        amount: 324,
        debit: 324,
        direction: 'debit',
        classification: 'expense',
        categoryId: expenseCategory._id,
        transactionId: sharedRef, // same reference, different transaction
        confidence: 0.9,
        status: 'ready',
      },
    ]);

    const summary = await confirmStatementImport(userId, statementImport._id);

    expect(summary.importedRows).toBe(2);
    expect(await Expense.countDocuments({ userId })).toBe(2); // both saved, no E11000
    const externalIds = (await Expense.find({ userId }).select('externalId').lean()).map((e) => e.externalId);
    expect(new Set(externalIds).size).toBe(2); // externalIds are unique
  });

  it('is resilient when a row was already inserted by a prior partial confirm (skips, no crash)', async () => {
    const statementImport = await StatementImport.create({
      userId,
      fileName: 'retry.pdf',
      fileType: 'application/pdf',
      fileSize: 1024,
      status: 'reviewing', // still reviewing — a prior confirm threw before finishing
    });
    await StatementImportRow.create({
      userId,
      statementImportId: statementImport._id,
      transactionDate: new Date('2026-06-04T09:00:00.000Z'),
      description: 'Lunch',
      rawDescription: 'Lunch',
      amount: 2500,
      debit: 2500,
      direction: 'debit',
      classification: 'expense',
      categoryId: expenseCategory._id,
      transactionId: 'REF-A',
      confidence: 0.9,
      status: 'ready',
    });

    // Simulate the row's expense already committed by the failed prior attempt.
    const scopedExternalId = buildScopedExternalId(`statement:${statementImport._id}`, 'REF-A');
    await Expense.create({
      userId,
      categoryId: expenseCategory._id,
      amount: 2500,
      description: 'Lunch',
      date: new Date('2026-06-04T09:00:00.000Z'),
      isImported: true,
      importJobId: statementImport._id,
      externalId: scopedExternalId,
    });

    // Confirm should skip the already-inserted expense rather than crash on E11000.
    await expect(confirmStatementImport(userId, statementImport._id)).resolves.toBeDefined();
    expect(await Expense.countDocuments({ userId })).toBe(1); // not double-inserted
  });
});
