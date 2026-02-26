const express = require('express');
const router = express.Router();
const onboardingController = require('../controllers/onboardingController');
const { authenticate } = require('../middleware/auth');
const { checkOnboardingNotCompleted } = require('../middleware/checkOnboarding');

// All onboarding routes require authentication
// Some routes also check that onboarding is not yet completed

router.post('/profile', authenticate, checkOnboardingNotCompleted, onboardingController.setupProfile);
router.post('/consent', authenticate, checkOnboardingNotCompleted, onboardingController.recordConsent);
router.post('/complete', authenticate, checkOnboardingNotCompleted, onboardingController.completeOnboarding);
router.get('/status', authenticate, onboardingController.getOnboardingStatus);

module.exports = router;

