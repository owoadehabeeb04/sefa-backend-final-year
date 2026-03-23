const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const otpService = require('../services/otpService');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false // Don't return password by default
  },
  currency: {
    type: String,
    default: 'NGN',
    uppercase: true
  },
  preferences: {
    notifications: {
      type: Boolean,
      default: true
    },
    theme: {
      type: String,
      enum: ['light', 'dark'],
      default: 'light'
    },
    language: {
      type: String,
      default: 'en'
    }
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  onboardingCompleted: {
    type: Boolean,
    default: false
  },
  onboardingStatus: {
    type: String,
    enum: ['started', 'profile_completed', 'consent_given', 'categories_initialized', 'completed'],
    default: 'started'
  },
  financialProfile: {
    incomeType: {
      type: String,
      enum: ['salary', 'business', 'freelance', 'mixed', 'other']
    },
    incomeFrequency: {
      type: String,
      enum: ['weekly', 'bi-weekly', 'monthly', 'quarterly', 'annually']
    },
    averageIncome: Number,
    financialGoals: [String]
  },
  consent: {
    dataAnalysis: {
      type: Boolean,
      default: false
    },
    timestamp: Date
  },
  otp: {
    code: String,
    expiresAt: Date
  },
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  monthlyBudgetLimit: {
    type: Number,
    default: null,
    min: 0
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to generate OTP using OTP service
userSchema.methods.generateOTP = function() {
  const otpData = otpService.generateOTP();
  this.otp = {
    code: otpData.code,
    expiresAt: otpData.expiresAt
  };
  return otpData.code;
};

// Method to verify OTP using OTP service
userSchema.methods.verifyOTP = function(code) {
  if (!this.otp || !this.otp.code) {
    return { valid: false, message: 'OTP not found' };
  }
  return otpService.verifyOTP(code, this.otp.code, this.otp.expiresAt);
};

// Method to clear OTP
userSchema.methods.clearOTP = function() {
  this.otp = undefined;
};

// Method to check if OTP is expired
userSchema.methods.isOTPExpired = function() {
  if (!this.otp || !this.otp.expiresAt) return true;
  return otpService.isOTPExpired(this.otp.expiresAt);
};

// Create index for cleanup of unverified users
userSchema.index({ isVerified: 1, createdAt: 1 });

// Static method to cleanup unverified users older than 24 hours
userSchema.statics.cleanupUnverifiedUsers = async function() {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  try {
    const result = await this.deleteMany({
      isVerified: false,
      createdAt: { $lt: twentyFourHoursAgo }
    });
    
    console.log(`Cleaned up ${result.deletedCount} unverified user(s) older than 24 hours`);
    return result;
  } catch (error) {
    console.error('Error cleaning up unverified users:', error);
    throw error;
  }
};

module.exports = mongoose.model('User', userSchema);
