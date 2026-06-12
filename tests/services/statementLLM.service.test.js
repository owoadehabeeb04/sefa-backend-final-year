const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/services/llm/azureOpenAI.service', () => ({
  completeJson: jest.fn(),
  completeJsonResponses: jest.fn(),
}));

const { completeJson, completeJsonResponses } = require('../../src/services/llm/azureOpenAI.service');
const {
  extractStatementTransactions,
  summarizeStatementMetadata,
} = require('../../src/services/statementLLM.service');

describe('statementLLM.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('extracts normalized rows from Azure JSON responses', async () => {
    completeJsonResponses.mockResolvedValue({
      json: {
        transactions: [
          {
            transactionDate: '2026-06-01',
            description: 'POS PURCHASE FOODCO',
            rawDescription: 'POS PURCHASE FOODCO',
            counterParty: 'FOODCO',
            transactionType: 'POS',
            debit: '5000',
            credit: null,
            amount: '5000',
            balance: '125000',
            direction: 'debit',
            classification: 'expense',
            transactionId: 'REF001',
            confidence: 0.84,
          },
        ],
      },
    });

    const tempPath = path.join(os.tmpdir(), `statement-${Date.now()}.pdf`);
    await fs.promises.writeFile(tempPath, Buffer.from('fake-pdf'), 'utf8');

    const result = await extractStatementTransactions({
      filePath: tempPath,
      fileName: 'statement.pdf',
      mimeType: 'application/pdf',
      fileType: 'pdf',
    });

    expect(completeJsonResponses).toHaveBeenCalled();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].amount).toBe(5000);
    expect(result.rows[0].direction).toBe('debit');
    expect(result.metadata.confidenceSummary.averageConfidence).toBe(0.84);

    await fs.promises.unlink(tempPath).catch(() => undefined);
  });

  it('sends pdf uploads to the responses api once per import', async () => {
    completeJsonResponses.mockResolvedValue({
      json: {
        transactions: [],
      },
    });

    const tempPath = path.join(os.tmpdir(), `statement-${Date.now()}.pdf`);
    await fs.promises.writeFile(tempPath, 'fake pdf body', 'utf8');

    await extractStatementTransactions({
      filePath: tempPath,
      fileName: 'statement.pdf',
      mimeType: 'application/pdf',
      fileType: 'pdf',
    });

    expect(completeJsonResponses).toHaveBeenCalledTimes(1);

    await fs.promises.unlink(tempPath).catch(() => undefined);
  });

  it('uses chunked text prompting for excel-style table rows', async () => {
    completeJson.mockResolvedValue({
      json: {
        transactions: [
          {
            transactionDate: '2026-06-01',
            description: 'ATM Withdrawal',
            rawDescription: 'ATM Withdrawal',
            counterParty: null,
            transactionType: 'ATM',
            debit: 2000,
            credit: null,
            amount: 2000,
            balance: 98000,
            direction: 'debit',
            classification: 'expense',
            transactionId: 'ROW001',
            confidence: 0.77,
          },
        ],
      },
    });

    const result = await extractStatementTransactions({
      fileType: 'xlsx',
      tableRows: [
        ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
        ['2026-06-01', 'ATM Withdrawal', '2000', '', '98000'],
      ],
    });

    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(completeJsonResponses).not.toHaveBeenCalled();
    expect(result.rows[0].transactionId).toBe('ROW001');
    expect(result.metadata.extractionMode).toBe('table_prompt');
  });

  it('summarizes statement metadata from a compact Azure response', async () => {
    completeJson.mockResolvedValue({
      json: {
        bankName: 'OPay',
        currency: 'NGN',
      },
    });

    const result = await summarizeStatementMetadata({
      fileName: 'opay-statement.pdf',
      fileType: 'pdf',
      text: 'OPay account statement',
      extractedRows: [{ description: 'Transfer', amount: 2000 }],
    });

    expect(result.bankName).toBe('OPay');
    expect(result.currency).toBe('NGN');
  });
});
