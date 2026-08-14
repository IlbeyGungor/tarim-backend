const errorHandler = (err, req, res, next) => {
  console.error('[Error]', err.message);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Sunucu hatası oluştu.',
    ...(err.apiCode && { code: err.apiCode }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
