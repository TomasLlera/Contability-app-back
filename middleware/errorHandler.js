const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';

  if (status >= 500) console.error(err);

  res.status(status).json({
    error: status < 500 || !isProd ? err.message : 'Error interno del servidor',
  });
}

module.exports = { asyncHandler, errorHandler };
