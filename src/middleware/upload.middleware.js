const multer = require('multer');
const { getGridFSBucket } = require('../config/gridfs');

/**
 * Upload Middleware using Multer + GridFS
 * Handles CSV and PDF bank statement uploads
 */

// File size limit: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Allowed file types
const ALLOWED_MIME_TYPES = [
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel', // Sometimes CSV is detected as this
  'application/pdf'
];

const ALLOWED_EXTENSIONS = ['.csv', '.pdf'];

/**
 * Multer storage using GridFS
 */
const storage = multer.memoryStorage(); // Store in memory first, then upload to GridFS

/**
 * File filter for validation
 */
const fileFilter = (req, file, cb) => {
  // Check file extension
  const ext = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));
  
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return cb(new Error(`Invalid file type. Only ${ALLOWED_EXTENSIONS.join(', ')} files are allowed.`), false);
  }
  
  // Check MIME type
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error(`Invalid MIME type. Only CSV and PDF files are allowed.`), false);
  }
  
  cb(null, true);
};

/**
 * Multer upload instance
 */
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1 // Only one file at a time
  }
});

/**
 * Upload middleware for single file
 * Field name: 'file'
 */
const uploadSingle = upload.single('file');

/**
 * Error handler for multer errors
 */
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB.`
      });
    }
    
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        message: 'Only one file can be uploaded at a time.'
      });
    }
    
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        success: false,
        message: 'Unexpected field name. Use "file" as the field name.'
      });
    }
    
    return res.status(400).json({
      success: false,
      message: `Upload error: ${err.message}`
    });
  }
  
  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }
  
  next();
};

/**
 * Middleware to validate file presence
 */
const validateFile = (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'No file uploaded. Please upload a CSV or PDF file.'
    });
  }
  
  next();
};

/**
 * Middleware to upload file to GridFS
 * Adds fileId and fileMetadata to req
 */
const uploadToGridFS = async (req, res, next) => {
  try {
    if (!req.file) {
      return next();
    }
    
    const bucket = getGridFSBucket();
    
    if (!bucket) {
      throw new Error('GridFS not initialized');
    }
    
    const filename = `${Date.now()}-${req.file.originalname}`;
    
    const uploadStream = bucket.openUploadStream(filename, {
      metadata: {
        userId: req.user.id,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedAt: new Date()
      }
    });
    
    return new Promise((resolve, reject) => {
      uploadStream.on('finish', () => {
        req.fileId = uploadStream.id;
        req.fileMetadata = {
          id: uploadStream.id,
          filename,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size
        };
        
        console.log(`✅ File uploaded to GridFS: ${filename} (${uploadStream.id})`);
        resolve();
        next();
      });
      
      uploadStream.on('error', (error) => {
        console.error('❌ GridFS upload error:', error);
        reject(error);
      });
      
      uploadStream.end(req.file.buffer);
    });
  } catch (error) {
    console.error('❌ Upload to GridFS failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to upload file to storage.'
    });
  }
};

/**
 * Complete upload middleware chain
 */
const handleFileUpload = [
  uploadSingle,
  handleUploadError,
  validateFile,
  uploadToGridFS
];

/**
 * Get file type from filename
 */
const getFileType = (filename) => {
  const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
  
  if (ext === '.csv') return 'csv';
  if (ext === '.pdf') return 'pdf';
  
  return 'unknown';
};

/**
 * Validate file size
 */
const validateFileSize = (size) => {
  return size <= MAX_FILE_SIZE;
};

/**
 * Format file size for display
 */
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};

module.exports = {
  uploadSingle,
  handleUploadError,
  validateFile,
  uploadToGridFS,
  handleFileUpload,
  getFileType,
  validateFileSize,
  formatFileSize,
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS
};
