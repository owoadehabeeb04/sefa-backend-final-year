jest.mock('../../src/services/statementLLM.service', () => ({
  extractStatementTransactions: jest.fn(),
}));

const { extractStatementTransactions } = require('../../src/services/statementLLM.service');
const {
  parseStatementSource,
  parseStructuredRows,
  parseStatementText,
} = require('../../src/services/statementParser.service');

describe('statementParser.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the LLM extraction path for statement sources', async () => {
    extractStatementTransactions.mockResolvedValue({
      rows: [
        {
          transactionDate: '2026-06-01',
          description: 'POS PURCHASE FOODCO',
          rawDescription: 'POS PURCHASE FOODCO',
          counterParty: 'FOODCO',
          transactionType: 'POS',
          debit: 5000,
          credit: 0,
          amount: 5000,
          balance: 125000,
          direction: 'debit',
          classification: 'expense',
          transactionId: 'REF-001',
          confidence: 0.88,
        },
      ],
      metadata: {
        confidenceSummary: {
          averageConfidence: 0.88,
          highConfidenceCount: 1,
          mediumConfidenceCount: 0,
          lowConfidenceCount: 0,
          unknownConfidenceCount: 0,
        },
      },
    });

    const result = await parseStatementSource({
      text: '2026-06-01 POS PURCHASE FOODCO 5,000.00 125,000.00',
      fileType: 'pdf',
    });

    expect(extractStatementTransactions).toHaveBeenCalled();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].direction).toBe('debit');
    expect(result.rows[0].classification).toBe('expense');
    expect(result.rows[0].transactionTimeProvided).toBe(false);
    expect(result.structure.detectedFormat).toBe('llm_normalized');
    expect(result.usedAiFallback).toBe(true);
  });

  it('keeps deterministic table parsing available for direct helper usage', () => {
    const result = parseStructuredRows([
      ['Date', 'Description', 'Debit', 'Credit', 'Balance', 'Reference'],
      ['2024-01-02', 'Foodco', '5000', '', '15000', 'REF001'],
      ['2024-01-03', 'Salary', '', '100000', '115000', 'REF002'],
    ]);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].direction).toBe('debit');
    expect(result.rows[1].direction).toBe('credit');
  });

  it('keeps deterministic text parsing available for helper usage', () => {
    const result = parseStatementText(`
      2023-12-30T15:47:49
      Transfer
      6930.00
      0.00
      12000.00
      MONIE POINT
      OPAYREF001
    `);

    expect(result.metrics.blockCount).toBe(1);
    expect(result.rows[0].transactionId).toBe('OPAYREF001');
    expect(result.rows[0].transactionTimeProvided).toBe(true);
  });
});
