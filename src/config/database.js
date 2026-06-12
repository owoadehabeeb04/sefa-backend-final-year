const mongoose = require('mongoose');

const ensureOptionalExternalIdIndex = async (conn, { collectionName, modelName }) => {
  const collection = conn.connection.db.collection(collectionName);
  let indexes = [];

  try {
    indexes = await collection.indexes();
  } catch (error) {
    if (error.codeName !== 'NamespaceNotFound' && error.code !== 26) {
      throw error;
    }
  }

  const legacyIndex = indexes.find((index) => index.name === 'userId_1_externalId_1');

  const hasLegacySparseOnlyIndex = Boolean(
    legacyIndex &&
      legacyIndex.unique === true &&
      legacyIndex.sparse === true &&
      !legacyIndex.partialFilterExpression
  );

  if (hasLegacySparseOnlyIndex) {
    await collection.dropIndex('userId_1_externalId_1');
    console.log(`Dropped legacy ${collectionName}.userId_1_externalId_1 index`);
  }

  await mongoose.model(modelName).createIndexes();
};

const connectDB = async () => {
  try {
    const mongoURI = process.env.MONGODB_URI;
    
    if (!mongoURI) {
      console.error('MONGODB_URI is not defined in environment variables');
      console.error('Please check your .env file');
      process.exit(1);
    }

    const conn = await mongoose.connect(mongoURI, {
      // Remove deprecated options - mongoose 6+ handles these automatically
    });

    console.log(`MongoDB Connected: ${conn.connection.host}`);
    console.log(`Database: ${conn.connection.name}`);

    await ensureOptionalExternalIdIndex(conn, { collectionName: 'expenses', modelName: 'Expense' });
    await ensureOptionalExternalIdIndex(conn, { collectionName: 'incomes', modelName: 'Income' });

    return conn;
  } catch (error) {
    console.error('Database connection error:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
