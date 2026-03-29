const mongoose = require('mongoose');

const Category = require('../../src/models/Category');
const Expense = require('../../src/models/Expense');
const ImportedTransactionMap = require('../../src/models/ImportedTransactionMap');
const Income = require('../../src/models/Income');
const { ingestTransactions } = require('../../src/services/transactionIngest.service');

describe('transactionIngest.service', () => {
  const userId = new mongoose.Types.ObjectId();

  beforeEach(async () => {
    await Category.create([
      { userId, name: 'Food & Dining', type: 'expense', color: '#ef4444' },
      { userId, name: 'Salary', type: 'income', color: '#10b981' },
    ]);
  });

  it('imports unique synced transactions and treats reruns as duplicates', async () => {
    const syncLogId = new mongoose.Types.ObjectId();
    const connectionId = new mongoose.Types.ObjectId();
    const context = {
      userId,
      sourceType: 'bank_connection',
      sourceRefId: connectionId,
      importJobId: syncLogId,
      syncLogId,
      provider: 'mono',
      externalIdScope: 'mono',
    };

    const transactions = [
      {
        date: new Date('2026-03-01T09:00:00.000Z'),
        description: 'POS PURCHASE SHOPRITE',
        amount: 5000,
        type: 'debit',
        reference: 'REF001',
      },
      {
        date: new Date('2026-03-01T09:00:00.000Z'),
        description: 'POS PURCHASE SHOPRITE',
        amount: 5000,
        type: 'debit',
        reference: 'REF001',
      },
      {
        date: new Date('2026-03-02T09:00:00.000Z'),
        description: 'SALARY PAYMENT',
        amount: 120000,
        type: 'credit',
        reference: 'REF002',
      },
    ];

    const firstRun = await ingestTransactions(transactions, context, { allowAi: false });

    expect(firstRun.importedCount).toBe(2);
    expect(firstRun.duplicateCount).toBe(1);
    expect(firstRun.failedCount).toBe(0);
    expect(await Expense.countDocuments({ userId })).toBe(1);
    expect(await Income.countDocuments({ userId })).toBe(1);
    expect(await ImportedTransactionMap.countDocuments({ userId })).toBe(2);

    const secondRun = await ingestTransactions(
      [transactions[0], transactions[2]],
      {
        ...context,
        sourceRefId: new mongoose.Types.ObjectId(),
        importJobId: new mongoose.Types.ObjectId(),
        syncLogId: new mongoose.Types.ObjectId(),
      },
      { allowAi: false },
    );

    expect(secondRun.importedCount).toBe(0);
    expect(secondRun.duplicateCount).toBe(2);
    expect(await ImportedTransactionMap.countDocuments({ userId })).toBe(2);
  });

  it('detects transfer pairs and links the saved transactions', async () => {
    const syncLogId = new mongoose.Types.ObjectId();
    const connectionId = new mongoose.Types.ObjectId();

    const result = await ingestTransactions(
      [
        {
          date: new Date('2026-03-04T09:00:00.000Z'),
          description: 'Transfer to 0123456789',
          amount: 25000,
          type: 'debit',
          reference: 'TRF001',
        },
        {
          date: new Date('2026-03-04T09:10:00.000Z'),
          description: 'Transfer from 0123456789',
          amount: 25000,
          type: 'credit',
          reference: 'TRF002',
        },
      ],
      {
        userId,
        sourceType: 'bank_connection',
        sourceRefId: connectionId,
        importJobId: syncLogId,
        syncLogId,
        provider: 'mono',
        externalIdScope: 'mono',
      },
      { allowAi: false },
    );

    expect(result.importedCount).toBe(2);
    expect(result.transferCount).toBe(1);

    const savedExpense = await Expense.findOne({ userId, isTransfer: true });
    const savedIncome = await Income.findOne({ userId, isTransfer: true });

    expect(savedExpense).not.toBeNull();
    expect(savedIncome).not.toBeNull();
    expect(String(savedExpense.transferPairId)).toBe(String(savedIncome._id));
    expect(String(savedIncome.transferPairId)).toBe(String(savedExpense._id));
  });
});
