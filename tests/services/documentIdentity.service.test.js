const {
  classifyDocumentIdentity,
  scoreDeterministicIdentity,
} = require('../../src/services/documentIdentity.service');

describe('documentIdentity.service', () => {
  it('scores OPay header evidence above UBA aliases', () => {
    const identity = scoreDeterministicIdentity({
      fileName: 'wallet_statement.pdf',
      headerText: 'OPay Digital Services Limited Statement of Account',
      rawText: 'Balance after transaction Transaction type Fee',
      tableHeaders: ['Transaction Type', 'Balance After Transaction'],
    });

    expect(identity.bankSlug).toBe('opay');
    expect(identity.displayName).toBe('OPay');
    expect(identity.confidence).toBe('high');
  });

  it('uses the upload hint when provided', async () => {
    const identity = await classifyDocumentIdentity({
      bankHint: 'First Bank',
      fileName: 'blurry_scan.pdf',
      rawText: 'unreadable scan',
    });

    expect(identity.bankSlug).toBe('firstbank');
    expect(identity.source).toBe('upload_hint');
    expect(identity.confidence).toBe('high');
  });

  it('returns unknown for low-confidence mixed evidence', () => {
    const identity = scoreDeterministicIdentity({
      fileName: 'statement.pdf',
      headerText: 'Account statement',
      rawText: 'Opening balance Closing balance',
      tableHeaders: ['Date', 'Description', 'Amount'],
    });

    expect(identity.bankSlug).toBe('unknown');
    expect(['unknown', 'low']).toContain(identity.confidence);
  });
});
