const { classifyStatementRow } = require('../../src/services/statementClassifier.service');

describe('statementClassifier.service', () => {
  it('maps outgoing transfers to expense rows', () => {
    const result = classifyStatementRow({
      description: 'Transfer to savings wallet',
      amount: 10000,
      debit: 10000,
      credit: 0,
      transactionDate: '2026-06-11',
    });

    expect(result.direction).toBe('debit');
    expect(result.classification).toBe('expense');
  });

  it('maps incoming transfers to income rows', () => {
    const result = classifyStatementRow({
      description: 'Transfer from John Doe',
      amount: 25000,
      debit: 0,
      credit: 25000,
      transactionDate: '2026-06-11',
    });

    expect(result.direction).toBe('credit');
    expect(result.classification).toBe('income');
  });
});
