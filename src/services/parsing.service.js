const csvParser = require('csv-parser');
const pdfParse = require('pdf-parse');
const { Readable } = require('stream');

/**
 * Parsing Service for CSV and PDF bank statements
 * Supports multiple Nigerian bank formats
 */

/**
 * Detect bank from CSV headers
 * @param {Array} headers - CSV headers
 * @returns {string} Bank name or 'unknown'
 */
const detectBankFromHeaders = (headers) => {
  const headersLower = headers.map(h => h.toLowerCase().trim());
  
  // Access Bank format
  if (headersLower.includes('transaction date') && headersLower.includes('value date')) {
    return 'access';
  }
  
  // GTBank format
  if (headersLower.includes('posting date') && headersLower.includes('tranid')) {
    return 'gtbank';
  }
  
  // Zenith Bank format
  if (headersLower.includes('tran date') && headersLower.includes('reference')) {
    return 'zenith';
  }
  
  // UBA format
  if (headersLower.includes('trans date') && headersLower.includes('trans ref')) {
    return 'uba';
  }
  
  // First Bank format
  if (headersLower.includes('transaction_date') && headersLower.includes('narration')) {
    return 'firstbank';
  }
  
  // Generic format (date, description, amount columns)
  if (headersLower.some(h => h.includes('date')) && 
      headersLower.some(h => h.includes('description') || h.includes('narration')) &&
      headersLower.some(h => h.includes('amount') || h.includes('debit') || h.includes('credit'))) {
    return 'generic';
  }
  
  return 'unknown';
};

/**
 * Parse CSV buffer to transactions
 * @param {Buffer} fileBuffer - CSV file buffer
 * @returns {Promise<Array>} Parsed transactions
 */
const parseCSV = (fileBuffer) => {
  return new Promise((resolve, reject) => {
    const transactions = [];
    let headers = [];
    let bankFormat = 'unknown';
    
    const stream = Readable.from(fileBuffer.toString());
    
    stream
      .pipe(csvParser())
      .on('headers', (hdrs) => {
        headers = hdrs;
        bankFormat = detectBankFromHeaders(hdrs);
        console.log(`📊 Detected bank format: ${bankFormat}`);
      })
      .on('data', (row) => {
        try {
          const transaction = parseCSVRow(row, bankFormat);
          if (transaction) {
            transactions.push(transaction);
          }
        } catch (error) {
          console.warn('⚠️  Failed to parse CSV row:', error.message);
        }
      })
      .on('end', () => {
        console.log(`✅ Parsed ${transactions.length} transactions from CSV`);
        resolve(transactions);
      })
      .on('error', (error) => {
        reject(new Error(`CSV parsing failed: ${error.message}`));
      });
  });
};

/**
 * Parse individual CSV row based on bank format
 * @param {Object} row - CSV row object
 * @param {string} bankFormat - Detected bank format
 * @returns {Object|null} Parsed transaction
 */
const parseCSVRow = (row, bankFormat) => {
  let transaction = null;
  
  switch (bankFormat) {
    case 'access':
      transaction = parseAccessBankRow(row);
      break;
    case 'gtbank':
      transaction = parseGTBankRow(row);
      break;
    case 'zenith':
      transaction = parseZenithBankRow(row);
      break;
    case 'uba':
      transaction = parseUBARow(row);
      break;
    case 'firstbank':
      transaction = parseFirstBankRow(row);
      break;
    case 'generic':
      transaction = parseGenericRow(row);
      break;
    default:
      transaction = parseGenericRow(row);
  }
  
  return transaction;
};

/**
 * Parse Access Bank CSV row
 */
const parseAccessBankRow = (row) => {
  const date = parseDate(row['Transaction Date'] || row['Value Date']);
  const description = row['Narration'] || row['Description'] || '';
  const debit = parseAmount(row['Debit'] || row['Debit Amount']);
  const credit = parseAmount(row['Credit'] || row['Credit Amount']);
  const reference = row['Reference'] || row['Ref'] || '';
  
  if (!date) return null;
  
  const amount = debit || credit;
  if (!amount || amount === 0) return null;
  
  return {
    date,
    description: description.trim(),
    amount: Math.abs(amount),
    type: debit ? 'debit' : 'credit',
    reference,
    balance: parseAmount(row['Balance'])
  };
};

/**
 * Parse GTBank CSV row
 */
const parseGTBankRow = (row) => {
  const date = parseDate(row['Posting Date'] || row['Trans Date']);
  const description = row['Remarks'] || row['Narration'] || '';
  const debit = parseAmount(row['Debit']);
  const credit = parseAmount(row['Credit']);
  const reference = row['TranID'] || row['Reference'] || '';
  
  if (!date) return null;
  
  const amount = debit || credit;
  if (!amount || amount === 0) return null;
  
  return {
    date,
    description: description.trim(),
    amount: Math.abs(amount),
    type: debit ? 'debit' : 'credit',
    reference,
    balance: parseAmount(row['Balance'])
  };
};

/**
 * Parse Zenith Bank CSV row
 */
const parseZenithBankRow = (row) => {
  const date = parseDate(row['Tran Date'] || row['Transaction Date']);
  const description = row['Narration'] || row['Description'] || '';
  const debit = parseAmount(row['Debit']);
  const credit = parseAmount(row['Credit']);
  const reference = row['Reference'] || row['Ref No'] || '';
  
  if (!date) return null;
  
  const amount = debit || credit;
  if (!amount || amount === 0) return null;
  
  return {
    date,
    description: description.trim(),
    amount: Math.abs(amount),
    type: debit ? 'debit' : 'credit',
    reference,
    balance: parseAmount(row['Balance'])
  };
};

/**
 * Parse UBA CSV row
 */
const parseUBARow = (row) => {
  const date = parseDate(row['Trans Date'] || row['Transaction Date']);
  const description = row['Transaction Details'] || row['Narration'] || '';
  const debit = parseAmount(row['Debit']);
  const credit = parseAmount(row['Credit']);
  const reference = row['Trans Ref'] || row['Reference'] || '';
  
  if (!date) return null;
  
  const amount = debit || credit;
  if (!amount || amount === 0) return null;
  
  return {
    date,
    description: description.trim(),
    amount: Math.abs(amount),
    type: debit ? 'debit' : 'credit',
    reference,
    balance: parseAmount(row['Balance'])
  };
};

/**
 * Parse First Bank CSV row
 */
const parseFirstBankRow = (row) => {
  const date = parseDate(row['transaction_date'] || row['date']);
  const description = row['narration'] || row['description'] || '';
  const debit = parseAmount(row['debit']);
  const credit = parseAmount(row['credit']);
  const reference = row['reference'] || row['trans_ref'] || '';
  
  if (!date) return null;
  
  const amount = debit || credit;
  if (!amount || amount === 0) return null;
  
  return {
    date,
    description: description.trim(),
    amount: Math.abs(amount),
    type: debit ? 'debit' : 'credit',
    reference,
    balance: parseAmount(row['balance'])
  };
};

/**
 * Parse generic CSV row
 */
const parseGenericRow = (row) => {
  // Find date column
  const dateKey = Object.keys(row).find(k => 
    k.toLowerCase().includes('date')
  );
  
  // Find description column
  const descKey = Object.keys(row).find(k => 
    k.toLowerCase().includes('description') || 
    k.toLowerCase().includes('narration') ||
    k.toLowerCase().includes('details')
  );
  
  // Find amount columns
  const debitKey = Object.keys(row).find(k => 
    k.toLowerCase().includes('debit') || 
    k.toLowerCase().includes('withdrawal')
  );
  const creditKey = Object.keys(row).find(k => 
    k.toLowerCase().includes('credit') || 
    k.toLowerCase().includes('deposit')
  );
  const amountKey = Object.keys(row).find(k => 
    k.toLowerCase().includes('amount')
  );
  
  const date = parseDate(row[dateKey]);
  const description = row[descKey] || '';
  const debit = parseAmount(row[debitKey]);
  const credit = parseAmount(row[creditKey]);
  const amount = debit || credit || parseAmount(row[amountKey]);
  
  if (!date || !amount || amount === 0) return null;
  
  return {
    date,
    description: description.trim(),
    amount: Math.abs(amount),
    type: debit ? 'debit' : 'credit',
    reference: '',
    balance: null
  };
};

/**
 * Parse date string to Date object
 * @param {string} dateStr - Date string in various formats
 * @returns {Date|null} Parsed date
 */
const parseDate = (dateStr) => {
  if (!dateStr) return null;
  
  const str = dateStr.toString().trim();
  
  // Try different date formats
  const formats = [
    // DD/MM/YYYY
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/,
    // YYYY-MM-DD
    /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/,
    // MM/DD/YYYY
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/
  ];
  
  // Try ISO format first
  const isoDate = new Date(str);
  if (!isNaN(isoDate.getTime())) {
    return isoDate;
  }
  
  // Try DD/MM/YYYY (common in Nigeria)
  const match = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const day = parseInt(match[1]);
    const month = parseInt(match[2]) - 1; // 0-indexed
    const year = parseInt(match[3]);
    return new Date(year, month, day);
  }
  
  return null;
};

/**
 * Parse amount string to number
 * @param {string|number} amountStr - Amount string
 * @returns {number|null} Parsed amount
 */
const parseAmount = (amountStr) => {
  if (amountStr === null || amountStr === undefined || amountStr === '') return null;
  
  const str = amountStr.toString().trim();
  
  // Remove currency symbols and commas
  const cleaned = str
    .replace(/[₦$£€,\s]/g, '')
    .replace(/\((\d+\.?\d*)\)/, '-$1'); // Handle negative in parentheses
  
  const amount = parseFloat(cleaned);
  
  return isNaN(amount) ? null : amount;
};

/**
 * Parse PDF buffer to text
 * @param {Buffer} fileBuffer - PDF file buffer
 * @returns {Promise<string>} Extracted text
 */
const parsePDF = async (fileBuffer) => {
  try {
    const data = await pdfParse(fileBuffer);
    return data.text;
  } catch (error) {
    throw new Error(`PDF parsing failed: ${error.message}`);
  }
};

/**
 * Extract transactions from PDF text
 * This is a basic implementation - OCR service will handle complex PDFs
 * @param {string} text - Extracted PDF text
 * @returns {Array} Extracted transactions
 */
const extractTransactionsFromPDFText = (text) => {
  const transactions = [];
  const lines = text.split('\n');
  
  // Look for transaction patterns
  // This is a simple regex-based extraction
  // More sophisticated parsing would be in OCR service
  
  for (const line of lines) {
    // Skip empty lines and headers
    if (!line.trim() || line.includes('Date') || line.includes('Balance')) continue;
    
    // Try to extract: Date, Description, Amount
    // Pattern: DD/MM/YYYY ... NGN/₦ XXX,XXX.XX
    const match = line.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}).*?([₦NGN\s]*)([\d,]+\.?\d*)/);
    
    if (match) {
      const date = parseDate(match[1]);
      const amount = parseAmount(match[3]);
      
      if (date && amount) {
        // Extract description (text between date and amount)
        const description = line.substring(
          line.indexOf(match[1]) + match[1].length,
          line.indexOf(match[0]) + match[0].length - match[3].length
        ).trim();
        
        transactions.push({
          date,
          description,
          amount,
          type: 'unknown', // Will be determined by OCR or context
          reference: '',
          balance: null
        });
      }
    }
  }
  
  return transactions;
};

module.exports = {
  parseCSV,
  parsePDF,
  extractTransactionsFromPDFText,
  detectBankFromHeaders,
  parseDate,
  parseAmount
};
