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
const AdminController = require("./controllers/admin-controller");

const errorHandler = require("./middleware/errorHandler");
const logger = require("./utils/logger");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// Initialize Redis connection (non-blocking)
if (process.env.REDIS_ENABLED !== "false") {
  redisClient.connect().catch((err) => {
    console.warn(
      "Redis connection failed, continuing without cache:",
      err.message,
    );
  });
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        fontSrc: ["'self'", "data:", "https://cdn.jsdelivr.net"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
      },
    },
  }),
);

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

app.get("/", AdminController.getHome);
app.get("/admin/customers", AdminController.getCustomers);
app.get("/admin/customers/new", AdminController.getNewCustomer);
app.post("/admin/customers", AdminController.createCustomer);
app.get("/admin/customers/:customerId/edit", AdminController.getEditCustomer);
app.post("/admin/customers/:customerId", AdminController.updateCustomer);
app.get("/admin/customers/:customerId/tokens", AdminController.getCustomerTokens);
app.post(
  "/admin/customers/:customerId/api-key",
  AdminController.saveCustomerApiKey,
);
app.post(
  "/admin/customers/:customerId/tokens",
  AdminController.saveTokenBatch,
);
app.post(
  "/admin/customers/:customerId/tokens/:batchId/delete",
  AdminController.deleteTokenBatch,
);
app.post(
  "/admin/customers/:customerId/delete",
  AdminController.deleteCustomer,
);

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
app.get("/api/v3/chat/sessions", MultiCustomerController.getChatSessions);
app.get(
  "/api/v3/chat/sessions/:sessionId",
  MultiCustomerController.getChatSession,
);
app.post("/api/v3/chat/sessions", MultiCustomerController.createChatSession);
app.delete(
  "/api/v3/chat/sessions/:sessionId",
  MultiCustomerController.deleteChatSession,
);
app.delete("/api/v3/chat/sessions", MultiCustomerController.clearAllChatSessions);
app.get("/api/v3/chat/search", MultiCustomerController.searchChatMessages);
app.get("/api/v3/chat/stats", MultiCustomerController.getChatStats);
app.get(
  "/api/multi-customer/deepseek/usage",
  MultiCustomerController.getDeepSeekUsage,
);
app.post(
  "/api/multi-customer/usage/reset",
  MultiCustomerController.resetMonthlyUsage,
);
//Purchase
// Token Management Routes
app.get("/api/multi-customer/balance", MultiCustomerController.getTokenBalance);
app.get(
  "/api/multi-customer/purchase/history",
  MultiCustomerController.getPurchaseHistory,
);
app.post(
  "/api/multi-customer/purchase",
  MultiCustomerController.purchaseTokens,
);
app.get("/api/multi-customer/companies", MultiCustomerController.getCompanies);

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
  if (req.path.startsWith("/api/")) {
    return res
      .status(404)
      .json({ message: "Not Found", success: false, status: 404 });
  }

  res.status(404).render("error", {
    title: "404 - Page Not Found",
    message: "The page you're looking for doesn't exist.",
  });
});

//Error handler
app.use(errorHandler);

//Start Server
const server = app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
  logger.info(`API URL: http://localhost:${PORT}/api`);
  logger.info(`Admin UI: http://localhost:${PORT}/`);
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
