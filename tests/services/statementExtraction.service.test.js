const fs = require('fs');
const os = require('os');
const path = require('path');

describe('statementExtraction.service', () => {
  it('extracts worksheet rows from excel files when xlsx is available', async () => {
    jest.resetModules();
    jest.doMock('xlsx', () => ({
      readFile: jest.fn(() => ({
        SheetNames: ['Sheet1'],
        Sheets: { Sheet1: {} },
      })),
      utils: {
        sheet_to_json: jest.fn(() => [
          ['Date', 'Amount', 'DR/CR'],
          ['2024-01-01', '1500', 'CR'],
        ]),
      },
    }), { virtual: true });

    const { extractStatementContent } = require('../../src/services/statementExtraction.service');
    const result = await extractStatementContent('/tmp/mock-statement.xlsx', { fileName: 'statement.xlsx' });

    expect(result.fileType).toBe('xlsx');
    expect(result.extractionMethod).toBe('xlsx_parse');
    expect(result.tableRows[1][2]).toBe('CR');
  });

  it('detects statement image uploads as image files', async () => {
    const { detectFileType } = require('../../src/services/statementExtraction.service');

    expect(detectFileType({ fileName: 'statement-scan.jpg', mimeType: 'image/jpeg' })).toBe('image');
    expect(detectFileType({ fileName: 'statement-scan.png', mimeType: 'image/png' })).toBe('image');
  });
});
