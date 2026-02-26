// Utility functions for standardized API responses

const successResponse = (res, data, message = 'Operation successful', statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    data,
    message,
    timestamp: new Date().toISOString()
  });
};

const errorResponse = (res, message = 'Operation failed', statusCode = 400, error = null) => {
  const response = {
    success: false,
    error: {
      message,
      ...(error && { details: error })
    },
    timestamp: new Date().toISOString()
  };

  return res.status(statusCode).json(response);
};

module.exports = {
  successResponse,
  errorResponse
};


