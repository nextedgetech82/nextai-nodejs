const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const path = require("path");
const session = require("express-session");
const flash = require("connect-flash");
const methodOverride = require("method-override");

const redisClient = require("../config/redis");

dotenv.config();

const analyticsController = require("./controllers/analyticsController");
const MultiCustomerController = require("./controllers/multi-customer-controller");
const AdminController = require("./controllers/admin-controller");

const errorHandler = require("./middleware/errorHandler");
const logger = require("./utils/logger");

const app = express();
const PORT = process.env.PORT || 3000;

// ============ VIEW ENGINE SETUP ============
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ============ STATIC FILES ============
app.use(express.static(path.join(__dirname, "public")));

// ============ SESSION & FLASH MIDDLEWARE ============
app.use(
  session({
    secret: process.env.SESSION_SECRET || "your-secret-key",
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 }, // 1 hour
  }),
);
app.use(flash());
app.use(methodOverride("_method"));

// Make flash messages available to all views
app.use((req, res, next) => {
  res.locals.success_msg = req.flash("success_msg");
  res.locals.error_msg = req.flash("error_msg");
  res.locals.error = req.flash("error");
  next();
});

// Initialize Redis connection (non-blocking)
if (process.env.REDIS_ENABLED !== "false") {
  redisClient.connect().catch((err) => {
    console.warn(
      "Redis connection failed, continuing without cache:",
      err.message,
    );
  });
}

// ============ SECURITY MIDDLEWARE ============
app.use(helmet());

app.use(
  cors({
    origin: "*",
    credentials: true,
  }),
);

// Rate limiting for API
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, //15 Minutes
  max: 100,
  message: "Too many requests from this IP, please try again after 15 minutes",
});

app.use("/api/", limiter);

// Body Parsing Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Request Logging Middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url}`);
  next();
});

// ============ HEALTH CHECK ============
app.get("/health", (req, res) => {
  res.status(200).json({
    message: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
  });
});

// ============ ADMIN DASHBOARD ROUTES (WEB UI) ============
app.get("/", (req, res) => res.redirect("/admin/customers"));
app.get("/admin", (req, res) => res.redirect("/admin/customers"));

// Customer Management Routes
app.get("/admin/customers", AdminController.getCustomers);
app.get("/admin/customers/add", AdminController.getAddCustomer);
app.post("/admin/customers/add", AdminController.postAddCustomer);
app.get("/admin/customers/edit/:id", AdminController.getEditCustomer);
app.post("/admin/customers/edit/:id", AdminController.postEditCustomer);
app.delete("/admin/customers/delete/:id", AdminController.deleteCustomer);
app.get("/admin/customers/purchase/:id", AdminController.getPurchaseTokens);
app.post("/admin/customers/purchase/:id", AdminController.postPurchaseTokens);
app.get("/admin/customers/usage/:id", AdminController.getCustomerUsage);

// ============ API ROUTES (Multi-Customer) ============
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

// Token Management Routes
app.get("/api/multi-customer/balance", MultiCustomerController.getTokenBalance);
app.post(
  "/api/multi-customer/purchase",
  MultiCustomerController.purchaseTokens,
);
app.get("/api/multi-customer/companies", MultiCustomerController.getCompanies);

// ============ API ROUTES (Analytics) ============
app.post("/api/analytics", analyticsController.processQuery);
app.get("/api/analytics/suggestions", analyticsController.getSuggestions);
app.get(
  "/api/analytics/predefined/:type",
  analyticsController.getPredefinedAnalytics,
);
app.get("/api/metadata/tables", analyticsController.getTables);
app.get("/api/metadata/tables/:tableName", analyticsController.getTableInfo);

// ============ CACHE MANAGEMENT ROUTES ============
app.post("/api/admin/cache/clear", analyticsController.clearCache);
app.get("/api/admin/cache/stats", analyticsController.getCacheStats);

// ============ 404 HANDLER ============
app.use((req, res) => {
  // Check if it's an API request or web request
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ message: "Not Found", success: false, status: 404 });
  } else {
    res.status(404).render("error", {
      title: "404 - Page Not Found",
      message: "The page you're looking for doesn't exist",
    });
  }
});

// ============ ERROR HANDLER ============
app.use(errorHandler);

// ============ START SERVER ============
const server = app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
  logger.info(`API URL: http://localhost:${PORT}/api`);
  logger.info(`Admin Dashboard: http://localhost:${PORT}/admin/customers`);
});

// ============ GRACEFUL SHUTDOWN ============
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
