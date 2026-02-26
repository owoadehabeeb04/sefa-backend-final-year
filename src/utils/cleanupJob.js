/**
 * Cleanup Job - Removes unverified users older than 24 hours
 */

const User = require('../models/User');

/**
 * Run cleanup job to delete unverified users
 */
const runCleanup = async () => {
  try {
    console.log('🧹 Running cleanup job for unverified users...');
    await User.cleanupUnverifiedUsers();
  } catch (error) {
    console.error('❌ Cleanup job failed:', error);
  }
};

/**
 * Start cleanup job interval (runs every 6 hours)
 */
const startCleanupJob = () => {
  // Run immediately on startup
  runCleanup();
  
  // Run every 6 hours
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setInterval(runCleanup, SIX_HOURS);
  
  console.log('✅ Cleanup job scheduled to run every 6 hours');
};

module.exports = { runCleanup, startCleanupJob };
