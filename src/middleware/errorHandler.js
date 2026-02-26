// Global error handler middleware
// This is a wrapper for custom error handling if needed

const errorHandler = (err, req, res, next) => {
  // Custom error handling logic can be added here
  if (res.headersSent) {
    return next(err);
  }
  next(err);
};

module.exports = errorHandler;

