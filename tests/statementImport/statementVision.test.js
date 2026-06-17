const fs = require('fs');
const path = require('path');
const os = require('os');

const pdfToImages = require('../../src/utils/pdfToImages');
const statementVision = require('../../src/services/statementVision.service');

// A tiny but valid single-page PDF used for conversion tests.
const MINI_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 58 >>
stream
BT /F1 18 Tf 40 100 Td (Hello Statement Page) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Size 6 /Root 1 0 R >>
%%EOF`;

describe('pdfToImages utility', () => {
  it('chunks pages into batches of 1-3', () => {
    const pages = [1, 2, 3, 4, 5].map((n) => ({ pageNumber: n }));
    expect(pdfToImages.chunkPages(pages, 2).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(pdfToImages.chunkPages(pages, 3).map((b) => b.length)).toEqual([3, 2]);
    // batch size is clamped to the 1..3 range
    expect(pdfToImages.chunkPages(pages, 10).map((b) => b.length)).toEqual([3, 2]);
    expect(pdfToImages.chunkPages(pages, 0).map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it('reports availability and converts a PDF to page images, then cleans up', async () => {
    const available = await pdfToImages.isPdfImageConversionAvailable();
    if (!available) {
      // Environment without native canvas — fallback path is exercised elsewhere.
      return;
    }

    const tmp = path.join(os.tmpdir(), `sefa-test-${Date.now()}.pdf`);
    await fs.promises.writeFile(tmp, MINI_PDF);

    try {
      const { pageCount, pages } = await pdfToImages.convertPdfToPageImages(tmp, { scale: 1.5 });
      expect(pageCount).toBe(1);
      expect(pages).toHaveLength(1);
      expect(pages[0].pageNumber).toBe(1);
      expect(fs.existsSync(pages[0].imagePath)).toBe(true);

      const dataUrl = await pdfToImages.readPageAsDataUrl(pages[0]);
      expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);

      await pdfToImages.cleanupPageImages(pages);
      expect(fs.existsSync(pages[0].imagePath)).toBe(false);
    } finally {
      await fs.promises.unlink(tmp).catch(() => undefined);
    }
  });

  it('throws a typed PdfTooLargeError above the page cap', async () => {
    const available = await pdfToImages.isPdfImageConversionAvailable();
    if (!available) return;

    const tmp = path.join(os.tmpdir(), `sefa-test-cap-${Date.now()}.pdf`);
    await fs.promises.writeFile(tmp, MINI_PDF);
    try {
      await expect(
        pdfToImages.convertPdfToPageImages(tmp, { maxPages: 0 })
      ).rejects.toMatchObject({ code: 'PDF_TOO_LARGE' });
    } finally {
      await fs.promises.unlink(tmp).catch(() => undefined);
    }
  });
});

describe('statementVision parsing', () => {
  it('normalizes a strict-schema payload, preserving page/row numbers', () => {
    const parsed = statementVision.parseVisionPayload(
      {
        statement: { bankName: 'OPay', currency: 'NGN', confidence: 0.9 },
        structure: { detectedFormat: 'debit_credit', confidence: 0.8 },
        rows: [
          {
            pageNumber: 2,
            rowNumber: 1,
            transactionDate: '2026-06-01',
            description: 'POS Purchase',
            debit: '1,500',
            credit: null,
            amount: '1500',
            direction: 'debit',
            classification: 'expense',
            balance: '20,000',
            transactionId: 'TXN1',
            confidence: 0.95,
            status: 'ready',
            validationErrors: [],
          },
        ],
        warnings: ['One row was blurry'],
      },
      [{ pageNumber: 2 }]
    );

    expect(parsed.rows).toHaveLength(1);
    const row = parsed.rows[0];
    expect(row.pageNumber).toBe(2);
    expect(row.rowNumber).toBe(1);
    expect(row.debit).toBe(1500); // currency string parsed
    expect(row.amount).toBe(1500);
    expect(row.balance).toBe(20000);
    expect(row.direction).toBe('debit');
    expect(row.classification).toBe('expense');
    expect(parsed.statement.bankName).toBe('OPay');
    expect(parsed.warnings).toContain('One row was blurry');
  });

  it('accepts a bare rows array and falls back to the batch page number', () => {
    const parsed = statementVision.parseVisionPayload(
      [{ description: 'Salary', amount: 50000, direction: 'credit', classification: 'income' }],
      [{ pageNumber: 3 }]
    );
    expect(parsed.rows[0].pageNumber).toBe(3);
    expect(parsed.rows[0].amount).toBe(50000);
    expect(parsed.rows[0].classification).toBe('income');
  });

  it('clamps confidence and marks unknown direction/classification safely', () => {
    const row = statementVision.normalizeVisionRow(
      { description: 'Mystery', amount: 100, direction: 'sideways', classification: 'maybe', confidence: 5 },
      1,
      1
    );
    expect(row.direction).toBe('unknown');
    expect(row.classification).toBe('unknown');
    expect(row.confidence).toBeLessThanOrEqual(1);
  });

  it('extractRowsFromPageImages degrades gracefully when AI returns nothing (test env)', async () => {
    // In the test env the Azure client returns null, so batches "fail" softly and
    // the function returns empty rows with warnings rather than throwing.
    const result = await statementVision.extractRowsFromPageImages({
      pages: [{ pageNumber: 1, imagePath: '/tmp/none.png', mimeType: 'image/png' }],
      batchSize: 1,
    });
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.rows).toHaveLength(0);
    expect(result.metadata.provider).toBe('azure-openai');
  });

  it('auditExtractedRows returns empty findings and never throws in test env', async () => {
    const audit = await statementVision.auditExtractedRows({
      rows: [{ rowNumber: 1, description: 'x', amount: 10 }],
      statement: { bankName: 'Test' },
    });
    expect(audit).toEqual({ warnings: [], rowSuggestions: [] });
  });
});
