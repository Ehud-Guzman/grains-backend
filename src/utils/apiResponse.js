const success = (res, data, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    data,
    message
  });
};

const error = (res, message = 'An error occurred', errorCode = 'SERVER_ERROR', statusCode = 400) => {
  return res.status(statusCode).json({
    success: false,
    error: errorCode,
    message
  });
};

const paginated = (res, data, pagination, message = 'Success') => {
  return res.status(200).json({
    success: true,
    data,
    pagination,
    message
  });
};

module.exports = { success, error, paginated };
