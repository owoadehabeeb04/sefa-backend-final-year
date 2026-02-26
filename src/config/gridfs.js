const mongoose = require('mongoose');
const Grid = require('gridfs-stream');

let gfs;
let gridfsBucket;

/**
 * Initialize GridFS for file storage
 * Call this after MongoDB connection is established
 */
const initGridFS = () => {
  const conn = mongoose.connection;

  if (conn.readyState !== 1) {
    throw new Error('MongoDB connection not ready. Initialize GridFS after connecting to MongoDB.');
  }

  // Initialize GridFS stream
  gfs = Grid(conn.db, mongoose.mongo);
  gfs.collection('uploads'); // Collection name for files

  // Initialize GridFSBucket (newer API)
  gridfsBucket = new mongoose.mongo.GridFSBucket(conn.db, {
    bucketName: 'uploads'
  });

  console.log('✅ GridFS initialized successfully');

  return { gfs, gridfsBucket };
};

/**
 * Get GridFS instance
 * @returns {Object} GridFS stream instance
 */
const getGFS = () => {
  if (!gfs) {
    throw new Error('GridFS not initialized. Call initGridFS() first.');
  }
  return gfs;
};

/**
 * Get GridFSBucket instance
 * @returns {GridFSBucket} GridFSBucket instance
 */
const getGridFSBucket = () => {
  if (!gridfsBucket) {
    throw new Error('GridFSBucket not initialized. Call initGridFS() first.');
  }
  return gridfsBucket;
};

/**
 * Upload file to GridFS
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} filename - Original filename
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<string>} File ID
 */
const uploadToGridFS = (fileBuffer, filename, metadata = {}) => {
  return new Promise((resolve, reject) => {
    const bucket = getGridFSBucket();

    const uploadStream = bucket.openUploadStream(filename, {
      metadata: {
        ...metadata,
        uploadedAt: new Date()
      }
    });

    uploadStream.on('error', (error) => {
      reject(error);
    });

    uploadStream.on('finish', (file) => {
      resolve(file._id.toString());
    });

    uploadStream.end(fileBuffer);
  });
};

/**
 * Download file from GridFS
 * @param {string} fileId - File ID
 * @returns {Promise<Buffer>} File buffer
 */
const downloadFromGridFS = (fileId) => {
  return new Promise((resolve, reject) => {
    const bucket = getGridFSBucket();
    const chunks = [];

    const downloadStream = bucket.openDownloadStream(
      new mongoose.Types.ObjectId(fileId)
    );

    downloadStream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    downloadStream.on('error', (error) => {
      reject(error);
    });

    downloadStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
};

/**
 * Delete file from GridFS
 * @param {string} fileId - File ID
 * @returns {Promise<void>}
 */
const deleteFromGridFS = async (fileId) => {
  const bucket = getGridFSBucket();
  await bucket.delete(new mongoose.Types.ObjectId(fileId));
};

/**
 * Get file metadata from GridFS
 * @param {string} fileId - File ID
 * @returns {Promise<Object>} File metadata
 */
const getFileMetadata = async (fileId) => {
  const bucket = getGridFSBucket();
  const files = await bucket.find({
    _id: new mongoose.Types.ObjectId(fileId)
  }).toArray();

  if (files.length === 0) {
    throw new Error('File not found');
  }

  return files[0];
};

/**
 * Check if file exists in GridFS
 * @param {string} fileId - File ID
 * @returns {Promise<boolean>}
 */
const fileExists = async (fileId) => {
  try {
    await getFileMetadata(fileId);
    return true;
  } catch (error) {
    return false;
  }
};

module.exports = {
  initGridFS,
  getGFS,
  getGridFSBucket,
  uploadToGridFS,
  downloadFromGridFS,
  deleteFromGridFS,
  getFileMetadata,
  fileExists
};
