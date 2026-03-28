const {
  requireVerifiedEmail,
  requireOnboardingComplete,
  requireOnboardingInProgress,
} = require('./auth');

const checkOnboardingCompleted = [requireVerifiedEmail, requireOnboardingComplete];
const checkOnboardingNotCompleted = [requireVerifiedEmail, requireOnboardingInProgress];

module.exports = {
  checkOnboardingCompleted,
  checkOnboardingNotCompleted,
};
