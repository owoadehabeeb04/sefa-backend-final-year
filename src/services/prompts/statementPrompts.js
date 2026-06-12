const { SEFA_MASTER_AI_SYSTEM_PROMPT, safeJson, truncate } = require('./financePrompts');

const STATEMENT_CHUNK_PREVIEW_LIMIT = 16000;
const METADATA_PREVIEW_LIMIT = 9000;

const STATEMENT_TRANSACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['transactions'],
  properties: {
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'transactionDate',
          'description',
          'rawDescription',
          'counterParty',
          'transactionType',
          'debit',
          'credit',
          'amount',
          'balance',
          'direction',
          'classification',
          'transactionId',
          'confidence',
        ],
        properties: {
          transactionDate: { type: ['string', 'null'] },
          description: { type: 'string' },
          rawDescription: { type: 'string' },
          counterParty: { type: ['string', 'null'] },
          transactionType: { type: ['string', 'null'] },
          debit: { type: ['number', 'null'] },
          credit: { type: ['number', 'null'] },
          amount: { type: ['number', 'null'] },
          balance: { type: ['number', 'null'] },
          direction: {
            type: 'string',
            enum: ['debit', 'credit', 'unknown'],
          },
          classification: {
            type: 'string',
            enum: ['expense', 'income', 'unknown'],
          },
          transactionId: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

const buildStatementExtractionPrompts = ({
  fileType = 'unknown',
  chunkIndex = 0,
  totalChunks = 1,
  chunkLabel = 'statement_chunk',
  serializedChunk = '',
}) => ({
  system: `${SEFA_MASTER_AI_SYSTEM_PROMPT}

Task-specific role:
You are SEFA's bank statement transaction extraction engine.

Your task:
Extract only the actual financial transaction rows present in the supplied statement chunk and return them as strict JSON.

Return strict JSON only with this exact shape:
{
  "transactions": [
    {
      "transactionDate": "ISO-8601 date string or null",
      "description": "string",
      "rawDescription": "string",
      "counterParty": "string or null",
      "transactionType": "string or null",
      "debit": "number or null",
      "credit": "number or null",
      "amount": "number or null",
      "balance": "number or null",
      "direction": "debit|credit|unknown",
      "classification": "expense|income|unknown",
      "transactionId": "string or null",
      "confidence": "number between 0 and 1"
    }
  ]
}

Rules:
- Extract transaction rows only. Ignore headers, footers, summaries, opening balance labels, page numbers, and instructions.
- Never invent rows that are not present in the supplied content.
- Preserve the row order from the chunk.
- Preserve amounts and dates carefully.
- Use null for fields you cannot determine safely.
- If direction is unclear, use "unknown".
- If the row looks like money leaving the account, use classification "expense".
- If the row looks like money entering the account, use classification "income".
- Treat "transfer to", wallet top-ups, and similar outgoing transfers as "expense".
- Treat "transfer from", incoming transfers, and received transfers as "income".
- Amount, debit, and credit must be positive numbers when present.
- Confidence must be honest. Use lower confidence when dates, amounts, or direction are unclear.
- Do not include markdown.
- Do not include prose outside the JSON object.`,
  prompt: safeJson({
    task: 'extract_statement_transactions',
    fileType,
    chunkIndex: chunkIndex + 1,
    totalChunks,
    chunkLabel,
    statementChunk: truncate(serializedChunk, STATEMENT_CHUNK_PREVIEW_LIMIT),
  }),
});

const buildStatementMetadataPrompts = ({
  fileName = '',
  fileType = 'unknown',
  contentPreview = '',
  extractedRows = [],
}) => ({
  system: `${SEFA_MASTER_AI_SYSTEM_PROMPT}

Task-specific role:
You summarize high-level metadata for an imported bank statement.

Return strict JSON only with this exact shape:
{
  "bankName": "string or null",
  "currency": "string or null"
}

Rules:
- Use only the supplied filename, content preview, and extracted rows.
- If you cannot safely identify the bank name, return null.
- If currency is unclear, return "NGN" only when the statement clearly looks Nigerian, otherwise return null.
- Do not invent unsupported details.
- Do not include markdown or prose outside the JSON object.`,
  prompt: safeJson({
    task: 'summarize_statement_metadata',
    fileName,
    fileType,
    contentPreview: truncate(contentPreview, METADATA_PREVIEW_LIMIT),
    extractedRows: extractedRows.slice(0, 25),
  }),
});

module.exports = {
  buildStatementExtractionPrompts,
  buildStatementMetadataPrompts,
  STATEMENT_TRANSACTION_JSON_SCHEMA,
};
