const mongoose = require('mongoose');

const Category = require('../../src/models/Category');
const Expense = require('../../src/models/Expense');
const Income = require('../../src/models/Income');
const ImportedTransactionMap = require('../../src/models/ImportedTransactionMap');
const StatementImport = require('../../src/models/StatementImport');
const StatementImportRow = require('../../src/models/StatementImportRow');
const { confirmStatementImport } = require('../../src/services/statementImport.service');

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
});
