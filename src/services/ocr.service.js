const { DocumentAnalysisClient, AzureKeyCredential } = require('@azure/ai-form-recognizer');
const vision = require('@google-cloud/vision');
const { parseDate, parseAmount } = require('./parsing.service');

/**
 * OCR Service for extracting transactions from scanned PDFs
 * Primary: Azure AI Document Intelligence
 * Fallback: Google Cloud Vision
 */

// Azure setup (support both legacy and new env variable names)
const azureEndpoint = process.env.AZURE_DOCUMENT_ENDPOINT || process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
const azureApiKey = process.env.AZURE_DOCUMENT_API_KEY || process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY;
const azureModelId = process.env.AZURE_DOCUMENT_MODEL_ID || 'prebuilt-layout';
let azureClient = null;

const isPlaceholderAzureEndpoint = azureEndpoint && (
  azureEndpoint.includes('your-resource') ||
  azureEndpoint.includes('example.com')
);

if (azureEndpoint && azureApiKey && !isPlaceholderAzureEndpoint) {
  azureClient = new DocumentAnalysisClient(
    azureEndpoint,
    new AzureKeyCredential(azureApiKey)
  );
  console.log('✅ Azure OCR configured');
} else if (isPlaceholderAzureEndpoint) {
  console.warn('⚠️  Azure OCR endpoint appears to be a placeholder value; Azure OCR disabled.');
}

const getAzureConfigStatus = () => ({
  hasEndpoint: !!azureEndpoint,
  hasApiKey: !!azureApiKey,
  isPlaceholderEndpoint: !!isPlaceholderAzureEndpoint,
  modelId: azureModelId,
  endpointHost: (() => {
    if (!azureEndpoint) return null;
    try {
      return new URL(azureEndpoint).host;
    } catch (_error) {
      return 'invalid-endpoint-format';
    }
  })(),
  enabled: !!azureClient
});

const getAzureErrorDetails = (error) => {
  const responseError = error?.response?.parsedBody?.error || error?.response?.body?.error;
  return {
    message: error?.message || 'Unknown Azure OCR error',
    name: error?.name || null,
    code: error?.code || responseError?.code || null,
    statusCode: error?.statusCode || error?.response?.status || null,
    details: responseError?.message || null
  };
};

// Google Cloud Vision setup
let googleClient = null;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  googleClient = new vision.ImageAnnotatorClient();
}

/**
 * Extract transactions from scanned PDF using OCR
 * @param {Buffer} fileBuffer - PDF file buffer
 * @returns {Promise<Array>} Extracted transactions
 */
const extractTransactionsFromScannedPDF = async (fileBuffer) => {
  // Try Azure first
  if (azureClient) {
    console.log('🔵 Using Azure Document Intelligence for OCR');
    try {
      return await extractWithAzure(fileBuffer);
    } catch (azureError) {
      const azureErrorDetails = getAzureErrorDetails(azureError);
      console.error('❌ Azure OCR failed with details:', azureErrorDetails);

      if (googleClient) {
        console.log('🟡 Azure failed, trying Google Cloud Vision');
        try {
          return await extractWithGoogle(fileBuffer);
        } catch (googleError) {
          throw new Error(`Both OCR services failed: Azure=${azureErrorDetails.message}; Google=${googleError.message}`);
        }
      }

      throw new Error(`Azure OCR failed: ${azureErrorDetails.message}`);
    }
  }

  // Fallback to Google Cloud Vision when Azure is not enabled
  if (!azureClient) {
    console.warn('⚠️  Azure OCR is not enabled. Config status:', getAzureConfigStatus());
  }

  if (googleClient) {
    console.log('🟡 Falling back to Google Cloud Vision for OCR');
    return await extractWithGoogle(fileBuffer);
  }

  throw new Error('No OCR service configured (Azure or Google)');
};

/**
 * Extract transactions using Azure Document Intelligence
 * @param {Buffer} fileBuffer - PDF file buffer
 * @returns {Promise<Array>} Extracted transactions
 */
const extractWithAzure = async (fileBuffer) => {
  const poller = await azureClient.beginAnalyzeDocument(
    azureModelId,
    fileBuffer
  );
  
  const { tables, keyValuePairs, content } = await poller.pollUntilDone();
  
  const transactions = [];
  
  // Strategy 1: Extract from tables
  if (tables && tables.length > 0) {
    console.log(`📊 Found ${tables.length} table(s) in document`);
    
    for (const table of tables) {
      const tableTransactions = extractTransactionsFromTable(table);
      transactions.push(...tableTransactions);
    }
  }

  // Strategy 2: Extract from key-value pairs
  if (keyValuePairs && keyValuePairs.length > 0 && transactions.length === 0) {
    console.log(`🔑 Found ${keyValuePairs.length} key-value pairs`);
    // This would require more sophisticated parsing
  }

  // Strategy 3: Parse raw content as fallback
  if (content && transactions.length === 0) {
    console.log('📝 Parsing raw content');
    const contentTransactions = parseContentForTransactions(content);
    transactions.push(...contentTransactions);
  }

  console.log(`✅ Azure extracted ${transactions.length} transactions`);
  return transactions;
};

/**
 * Extract transactions from Azure table structure
 * @param {Object} table - Azure table object
 * @returns {Array} Transactions
 */
const extractTransactionsFromTable = (table) => {
  const transactions = [];
  const headers = [];
  
  // Extract headers from first row
  for (const cell of table.cells) {
    if (cell.rowIndex === 0) {
      headers[cell.columnIndex] = cell.content.toLowerCase();
    }
  }
  
  // Find column indices
  const dateColIndex = headers.findIndex(h => h.includes('date'));
  const descColIndex = headers.findIndex(h => 
    h.includes('description') || h.includes('narration') || h.includes('details')
  );
  const debitColIndex = headers.findIndex(h => h.includes('debit') || h.includes('withdrawal'));
  const creditColIndex = headers.findIndex(h => h.includes('credit') || h.includes('deposit'));
  const amountColIndex = headers.findIndex(h => h.includes('amount'));
  const refColIndex = headers.findIndex(h => h.includes('reference') || h.includes('ref'));
  
  if (dateColIndex === -1) {
    console.warn('⚠️  No date column found in table');
    return transactions;
  }
  
  // Group cells by row
  const rows = {};
  for (const cell of table.cells) {
    if (cell.rowIndex === 0) continue; // Skip header row
    
    if (!rows[cell.rowIndex]) {
      rows[cell.rowIndex] = {};
    }
    rows[cell.rowIndex][cell.columnIndex] = cell.content;
  }
  
  // Parse each row
  for (const rowIndex in rows) {
    const row = rows[rowIndex];
    
    const date = parseDate(row[dateColIndex]);
    const description = row[descColIndex] || '';
    const debit = debitColIndex !== -1 ? parseAmount(row[debitColIndex]) : null;
    const credit = creditColIndex !== -1 ? parseAmount(row[creditColIndex]) : null;
    const amount = debit || credit || (amountColIndex !== -1 ? parseAmount(row[amountColIndex]) : null);
    const reference = refColIndex !== -1 ? row[refColIndex] : '';
    
    if (date && amount) {
      transactions.push({
        date,
        description: description.trim(),
        amount: Math.abs(amount),
        type: debit ? 'debit' : 'credit',
        reference,
        balance: null
      });
    }
  }
  
  return transactions;
};

/**
 * Parse content text for transactions
 * @param {string} content - Raw text content
 * @returns {Array} Transactions
 */
const parseContentForTransactions = (content) => {
  const transactions = [];
  const lines = content.split('\n');
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    // Try to match transaction pattern
    // Date ... Description ... Amount
    const match = line.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4,}).*?([\d,]+\.?\d*)/);
    
    if (match) {
      const date = parseDate(match[1]);
      const amount = parseAmount(match[2]);
      
      if (date && amount) {
        const description = line.substring(
          line.indexOf(match[1]) + match[1].length,
          line.lastIndexOf(match[2])
        ).trim();
        
        transactions.push({
          date,
          description,
          amount,
          type: 'unknown',
          reference: '',
          balance: null
        });
      }
    }
  }
  
  return transactions;
};

/**
 * Extract transactions using Google Cloud Vision
 * @param {Buffer} fileBuffer - PDF file buffer
 * @returns {Promise<Array>} Extracted transactions
 */
const extractWithGoogle = async (fileBuffer) => {
  try {
    const [result] = await googleClient.documentTextDetection({
      image: { content: fileBuffer.toString('base64') }
    });
    const fullTextAnnotation = result.fullTextAnnotation;
    
    if (!fullTextAnnotation || !fullTextAnnotation.text) {
      throw new Error('No text detected in document');
    }
    
    const text = fullTextAnnotation.text;
    console.log(`📝 Google extracted ${text.length} characters`);
    
    const transactions = parseContentForTransactions(text);
    
    console.log(`✅ Google extracted ${transactions.length} transactions`);
    return transactions;
  } catch (error) {
    throw new Error(`Google OCR failed: ${error.message}`);
  }
};

/**
 * Validate extracted transactions
 * @param {Array} transactions - Extracted transactions
 * @returns {Object} Validation result
 */
const validateExtractedTransactions = (transactions) => {
  const valid = [];
  const invalid = [];
  
  for (const transaction of transactions) {
    if (
      transaction.date instanceof Date &&
      !isNaN(transaction.date.getTime()) &&
      transaction.amount > 0 &&
      transaction.description
    ) {
      valid.push(transaction);
    } else {
      invalid.push({
        transaction,
        reason: !transaction.date ? 'Invalid date' :
                !transaction.amount ? 'Invalid amount' :
                !transaction.description ? 'Missing description' : 'Unknown'
      });
    }
  }
  
  return {
    valid,
    invalid,
    totalExtracted: transactions.length,
    validCount: valid.length,
    invalidCount: invalid.length,
    successRate: transactions.length > 0 
      ? (valid.length / transactions.length * 100).toFixed(2) 
      : 0
  };
};

/**
 * Check if OCR is configured and available
 * @returns {Object} Configuration status
 */
const checkOCRAvailability = () => {
  return {
    azure: {
      configured: !!(azureEndpoint && azureApiKey),
      endpoint: azureEndpoint ? '***configured***' : null
    },
    google: {
      configured: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
      credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || null
    },
    available: !!(azureClient || googleClient)
  };
};

module.exports = {
  extractTransactionsFromScannedPDF,
  extractWithAzure,
  extractWithGoogle,
  validateExtractedTransactions,
  checkOCRAvailability
};
