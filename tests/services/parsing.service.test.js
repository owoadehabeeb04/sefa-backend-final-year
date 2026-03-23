const {
  extractStatementDateRange,
  extractTransactionsFromPDFTextDetailed,
  parseCSVWithMetadata,
} = require('../../src/services/parsing.service');

describe('parsing.service', () => {
  it('parses Access Bank CSV statements with metadata', async () => {
    const csv = [
      'Transaction Date,Value Date,Narration,Debit,Credit,Reference,Balance',
      '01/03/2026,01/03/2026,POS PURCHASE SHOPRITE,5000,,REF001,15000',
      '02/03/2026,02/03/2026,SALARY PAYMENT,,120000,REF002,135000',
    ].join('\n');

    const result = await parseCSVWithMetadata(Buffer.from(csv));

    expect(result.detectedBank).toBe('access');
    expect(result.parser).toBe('access_csv');
    expect(result.sourceRecordCount).toBe(2);
    expect(result.validRecordCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].type).toBe('debit');
    expect(result.transactions[1].type).toBe('credit');
  });

  it('detects OPay statements from PDF text without mislabeling them as UBA', () => {
    const pdfText = [
      'OPay Digital Services Limited',
      'Statement Period: 01/03/2026 - 03/03/2026',
      '01/03/2026 Transfer from John Doe 15,000.00 CR',
      '02/03/2026 Utility Payment 2,500.00 DR',
    ].join('\n');

    const result = extractTransactionsFromPDFTextDetailed(pdfText, {
      fileName: 'opay_statement.pdf',
    });

    expect(result.detectedBank).toBe('opay');
    expect(result.detectedBankDisplayName).toBe('OPay');
    expect(result.detectedBank).not.toBe('uba');
    expect(result.validRecordCount).toBe(2);
  });

  it('merges wrapped PDF descriptions into a single transaction row', () => {
    const pdfText = [
      'OPay Digital Services Limited',
      'Statement Period: 01/03/2026 - 03/03/2026',
      '01/03/2026 POS PURCHASE',
      'IKEJA CITY MALL 5,000.00 DR',
      '02/03/2026 SALARY PAYMENT 120,000.00 CR',
    ].join('\n');

    const result = extractTransactionsFromPDFTextDetailed(pdfText);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].description).toContain('IKEJA CITY MALL');
    expect(result.transactions[0].direction).toBe('debit');
    expect(result.transactions[1].direction).toBe('credit');
  });

  it('flags suspicious date collapse instead of silently accepting one repeated date', () => {
    const pdfText = [
      'Statement Period: 01/03/2026 - 17/03/2026',
      '10/03/2026 POS PURCHASE SHOPRITE 1,000.00 DR',
      '10/03/2026 AIRTIME PURCHASE 1,500.00 DR',
      '10/03/2026 NIP TRANSFER 3,500.00 DR',
      '10/03/2026 SALARY PAYMENT 200,000.00 CR',
    ].join('\n');

    const result = extractTransactionsFromPDFTextDetailed(pdfText);

    expect(result.validRecordCount).toBe(4);
    expect(result.needsReview).toBe(true);
    expect(result.qualityFlags).toContain('suspicious_date_collapse');
  });

  it('extracts statement date ranges across month boundaries', () => {
    const text = 'Statement Period: 28 Feb 2026 - 03 Mar 2026';

    const result = extractStatementDateRange(text);

    expect(result).not.toBeNull();
    expect(result.from.getFullYear()).toBe(2026);
    expect(result.from.getMonth()).toBe(1);
    expect(result.from.getDate()).toBe(28);
    expect(result.to.getFullYear()).toBe(2026);
    expect(result.to.getMonth()).toBe(2);
    expect(result.to.getDate()).toBe(3);
  });
});
