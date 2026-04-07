const logger = require("../utils/logger");

module.exports = (err, req, res, next) => {
  logger.error(`${req.method} ${req.url} - ${err.message}`);
  logger.error(err.stack);

  const statusCode = err.statusCode || 500;

  if (!req.path.startsWith("/api/")) {
    return res.status(statusCode).render("error", {
      title: `${statusCode} - Error`,
      message: err.message,
    });
  }

  res.status(statusCode).json({
    success: false,
    status: statusCode,
    message: err.message,
    stack: process.env.NODE_ENV === "development" ? err.stack : "",
  });
};
