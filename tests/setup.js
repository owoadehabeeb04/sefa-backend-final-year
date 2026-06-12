const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
process.env.AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || 'https://example-resource.openai.azure.com';
process.env.AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || 'test-azure-openai-key';
process.env.AZURE_OPENAI_DEPLOYMENT_NAME = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'test-deployment';
process.env.AZURE_OPENAI_MODEL_NAME = process.env.AZURE_OPENAI_MODEL_NAME || 'gpt-test';
process.env.AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
process.env.AZURE_OPENAI_MAX_TOKENS = process.env.AZURE_OPENAI_MAX_TOKENS || '800';
process.env.TAVILY_API_KEY = process.env.TAVILY_API_KEY || 'test-tavily-key';
process.env.SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || 'test-serpapi-key';

// Setup: Connect to in-memory MongoDB before all tests
beforeAll(async () => {
  // Close any existing connections
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  // Create in-memory MongoDB instance
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  // Connect to the in-memory database
  await mongoose.connect(mongoUri);

  console.log('Test database connected');
});

// Cleanup: Clear database between tests
afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    const collection = collections[key];
    await collection.deleteMany({});
  }
});

// Teardown: Disconnect and stop MongoDB after all tests
afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  
  if (mongoServer) {
    await mongoServer.stop();
  }

  console.log('Test database disconnected');
});
