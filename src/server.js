const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const connectDB = require('./config/database');
const { initGridFS } = require('./config/gridfs');
const { swaggerSetup } = require('./config/swagger');
const { startCleanupJob } = require('./utils/cleanupJob');
const { initializeProcessors, closeQueues } = require('./config/queue');
const schedulerService = require('./services/scheduler.service');
const { startSyncCronJobs, stopSyncCronJobs } = require('./jobs/syncCronJobs');
const { assertBrevoConfigured } = require('./services/otpService');

const app = express();

const MIN_SECRET_LENGTH = 32;

const parseCorsOrigins = () => {
  return (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const assertSecureRuntimeConfig = () => {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  const insecureMarkers = ['change-this', 'replace-with', 'replace_', 'your-', 'example'];
  const requiredSecrets = [
    { key: 'JWT_SECRET', value: process.env.JWT_SECRET },
    { key: 'JWT_REFRESH_SECRET', value: process.env.JWT_REFRESH_SECRET },
    { key: 'ADMIN_SECRET_KEY', value: process.env.ADMIN_SECRET_KEY },
    { key: 'MONO_WEBHOOK_SECRET', value: process.env.MONO_WEBHOOK_SECRET },
  ];

  for (const secret of requiredSecrets) {
    if (!secret.value || secret.value.length < MIN_SECRET_LENGTH) {
      throw new Error(`${secret.key} must be set to a secure value at least ${MIN_SECRET_LENGTH} characters long`);
    }

    const normalized = secret.value.toLowerCase();
    if (insecureMarkers.some((marker) => normalized.includes(marker))) {
      throw new Error(`${secret.key} is using an insecure placeholder value`);
    }
  }

  const corsOrigins = parseCorsOrigins();
  if (corsOrigins.length === 0 || corsOrigins.includes('*')) {
    throw new Error('CORS_ORIGIN must be an explicit comma-separated allowlist and cannot contain "*"');
  }
};

// Swagger documentation
swaggerSetup(app);

// Middleware
app.use(helmet());
const corsOrigins = parseCorsOrigins();
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({
  verify: (req, res, buffer) => {
    if (req.originalUrl?.includes('/api/v1/bank/webhook')) {
      req.rawBody = Buffer.from(buffer);
    }
  },
}));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

// API routes
const apiRoutes = require('./routes');
app.use('/api/v1', apiRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
let server;

const getNetworkUrls = () => {
  if (HOST !== '0.0.0.0') {
    return [`http://${HOST}:${PORT}`];
  }

  const interfaces = os.networkInterfaces();
  const urls = [];

  for (const networkInterface of Object.values(interfaces)) {
    for (const address of networkInterface || []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.push(`http://${address.address}:${PORT}`);
      }
    }
  }

  return urls;
};

const bootstrap = async () => {
  try {
    assertSecureRuntimeConfig();
    assertBrevoConfigured();

    // Connect to MongoDB first
    await connectDB();

    // Start cleanup job only after MongoDB is ready
    startCleanupJob();

    // Initialize GridFS after MongoDB is connected
    initGridFS();

    // Initialize queue processors after DB connection
    initializeProcessors();

    // Start notification schedulers
    schedulerService.start();

    // Start sync cron jobs
    startSyncCronJobs();

    server = app.listen(PORT, HOST, () => {
      console.log(`Server is running on ${HOST}:${PORT}`);
      for (const url of getNetworkUrls()) {
        console.log(`API reachable at ${url}/api/v1`);
      }
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Failed to bootstrap server:', error);
    process.exit(1);
  }
};

bootstrap();

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} signal received: closing server gracefully`);

  if (!server) {
    process.exit(0);
  }
  
  server.close(async () => {
    console.log('HTTP server closed');
    
    // Stop scheduler
    schedulerService.stop();
    
    // Stop sync cron jobs
    stopSyncCronJobs();
    
    // Close queue connections
    await closeQueues();
    
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
