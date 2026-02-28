const path = require('path');
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

const app = express();

// Start cleanup job for unverified users
startCleanupJob();

// Swagger documentation
swaggerSetup(app);

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || '*',
  credentials: true
}));
app.use(express.json());
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

const PORT = process.env.PORT || 3000;
let server;

const bootstrap = async () => {
  try {
    // Connect to MongoDB first
    await connectDB();

    // Initialize GridFS after MongoDB is connected
    initGridFS();

    // Initialize queue processors after DB connection
    initializeProcessors();

    // Start notification schedulers
    schedulerService.start();

    // Start sync cron jobs
    startSyncCronJobs();

    server = app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
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
