const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const path = require("path");
const redisClient = require("../config/redis");

dotenv.config();

const analyticsController = require("./controllers/analyticsController");
const MultiCustomerController = require("./controllers/multi-customer-controller");

const errorHandler = require("./middleware/errorHandler");
const logger = require("./utils/logger");

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Redis connection (non-blocking)
if (process.env.REDIS_ENABLED !== "false") {
  redisClient.connect().catch((err) => {
    console.warn(
      "Redis connection failed, continuing without cache:",
      err.message,
    );
  });
}

app.use(helmet());

app.use(
  cors({
    origin: "*",
    credentials: true,
    //methods:["GET","POST","PUT","DELETE"],
    //allowedHeaders:["Content-Type","Authorization"],
    //maxAge:86400,
    //preflightContinue:false,
    //optionsSuccessStatus:200,
  }),
);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, //15 Minutes
  max: 100,
  message: "Too many requests from this IP, please try again after 15 minutes",
  //standardHeaders:true,
  //legacyHeaders:false,
});

app.use("/api/", limiter);

//Body Parsing Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

//Request Loggin Middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

//Health Check EndPoint
app.get("/health", (req, res) => {
  res.status(200).json({
    message: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
  });
});

//Multi Company
app.post("/api/multi-customer/analytics", MultiCustomerController.processQuery);
app.post(
  "/api/multi-customer/customer-api-key",
  MultiCustomerController.getCustomerApiKey,
);
app.get(
  "/api/multi-customer/usage/stats",
  MultiCustomerController.getTokenUsageStats,
);
app.post(
  "/api/multi-customer/usage/reset",
  MultiCustomerController.resetMonthlyUsage,
);

//API Routes
app.post("/api/analytics", analyticsController.processQuery);
app.get("/api/analytics/suggestions", analyticsController.getSuggestions);
app.get(
  "/api/analytics/predefined/:type",
  analyticsController.getPredefinedAnalytics,
);
app.get("/api/metadata/tables", analyticsController.getTables);
app.get("/api/metadata/tables/:tableName", analyticsController.getTableInfo);

//cache
// Cache management endpoints (add authentication in production)
app.post("/api/admin/cache/clear", analyticsController.clearCache);
app.get("/api/admin/cache/stats", analyticsController.getCacheStats);

//404 handler
app.use((req, res) => {
  res.status(404).json({ message: "Not Found", success: false, status: 404 });
});

//Error handler
app.use(errorHandler);

//Start Server
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
  logger.info(`API URL: http://localhost:${PORT}/api`);
});

//Gracefull Shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received");
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("SIGINT received");
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

module.exports = app;
