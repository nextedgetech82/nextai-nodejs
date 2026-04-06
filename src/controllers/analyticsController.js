const DatabaseService = require("../services/databaseService");
const DeepSeekService = require("../services/deepseekService");
const MetadataService = require("../services/metadataService");
const CacheService = require("../services/cacheService");
const logger = require("../utils/logger");

class AnalyticsController {
  constructor() {
    this.databaseService = new DatabaseService();
    this.deepseekService = new DeepSeekService(process.env.DEEPSEEK_API_KEY);
    this.metadataService = new MetadataService();
    this.cacheService = CacheService;

    // Initialize cache
    this.cacheService.initialize();
  }

  processQuery = async (req, res, next) => {
    try {
      const {
        query,
        skipCache = false,
        insights: insightsRequested = true,
      } = req.body;

      if (!query) {
        return res.status(400).json({
          success: false,
          error: "Query is required",
        });
      }

      logger.info(`Processing query: ${query}`);

      // Generate cache key
      const cacheKey = this.cacheService.generateKey(query, {
        timestamp: this.getTimeBucket(query), // Smart cache based on query type
      });

      // Check cache (unless skipCache is true)
      let cachedResponse = null;
      if (!skipCache && process.env.REDIS_ENABLED !== "false") {
        cachedResponse = await this.cacheService.get(cacheKey);
      }

      if (cachedResponse) {
        logger.info(`✅ Returning cached response for: ${query}`);
        return res.json({
          ...cachedResponse,
          cached: true,
          timestamp: new Date().toISOString(),
        });
      }

      // Cache miss - process normally
      const startTime = Date.now();

      // Step 1: Get metadata
      const metadata = this.metadataService.getFullSchemaForAI();

      // Step 2: Generate SQL
      const sqlQuery = await this.deepseekService.generateSQL(query, metadata);
      logger.info(`Generated SQL: ${sqlQuery}`);

      // Step 3: Validate SQL
      await this.databaseService.validateQuery(sqlQuery);

      // Step 4: Execute query
      const results = await this.databaseService.executeQuery(sqlQuery);
      logger.info(`Query returned ${results.length} rows`);

      let insights = null;
      let insightsError = null;
      const shouldGenerateInsights =
        insightsRequested === true ||
        insightsRequested === "true" ||
        insightsRequested === 1;

      // Step 5: Generate insights only when requested
      if (shouldGenerateInsights) {
        try {
          insights = await this.deepseekService.generateInsights(
            query,
            sqlQuery,
            results,
          );
        } catch (error) {
          insightsError = error.message;
          insights =
            "Insights are temporarily unavailable for this request, but the SQL results are complete.";
          logger.warn(`Insights generation failed: ${error.message}`);
        }
      }

      // Prepare response
      const response = {
        success: true,
        query: query,
        sqlQuery: sqlQuery,
        data: results,
        insights: insights,
        rowCount: results.length,
        processingTime: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        cached: false,
        insightsRequested: shouldGenerateInsights,
        insightsAvailable: shouldGenerateInsights && !insightsError,
        insightsError,
      };

      // Determine cache TTL based on query type
      const queryType = this.detectQueryType(query);

      // Cache the response
      await this.cacheService.smartSet(cacheKey, response, queryType);
      logger.info(`💾 Cached response for query type: ${queryType}`);

      // Step 6: Return response
      res.json(response);
      // res.json({
      //   success: true,
      //   query: query,
      //   sqlQuery: sqlQuery,
      //   data: results,
      //   insights: insights,
      //   rowCount: results.length,
      //   timestamp: new Date().toISOString(),
      // });
    } catch (error) {
      logger.error(`Error in processQuery: ${error.message}`);
      next(error);
    }
  };

  getSuggestions = async (req, res, next) => {
    try {
      const suggestions = [
        "Show top 10 customers by sales value in the last 30 days",
        "Compare sales this month vs last month with percentage change",
        "Show state-wise sales summary with top performing states",
        "List party-wise sales summary with customer segmentation",
        "What are our best selling products by quantity?",
        "Show monthly sales trend for the current year",
        "Which customers have the highest outstanding balance?",
        "Show sales by product category with growth percentage",
        "List customers with declining sales month over month",
        "Show average order value by customer type",
      ];

      res.json({ suggestions });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Detect query type for intelligent caching
   */
  detectQueryType(query) {
    const lowerQuery = query.toLowerCase();

    if (
      lowerQuery.includes("trend") ||
      lowerQuery.includes("monthly") ||
      lowerQuery.includes("over time")
    ) {
      return "trend";
    } else if (lowerQuery.includes("top") || lowerQuery.includes("best")) {
      return "static";
    } else if (
      lowerQuery.includes("realtime") ||
      lowerQuery.includes("current")
    ) {
      return "real-time";
    } else if (lowerQuery.includes("summary") || lowerQuery.includes("total")) {
      return "summary";
    }
    return "general";
  }

  /**
   * Get time bucket for cache key (reduce cache fragmentation)
   */
  getTimeBucket(query) {
    const lowerQuery = query.toLowerCase();

    // For trend queries, use hourly buckets
    if (lowerQuery.includes("trend") || lowerQuery.includes("monthly")) {
      const now = new Date();
      return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    }

    // For real-time queries, use minute-level buckets
    if (lowerQuery.includes("realtime")) {
      const now = new Date();
      return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${Math.floor(now.getMinutes() / 5)}`;
    }

    // For other queries, use hour-level buckets
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
  }

  /**
   * Clear cache endpoint (admin only - add authentication)
   */
  clearCache = async (req, res, next) => {
    try {
      const { pattern = "*" } = req.body;
      await this.cacheService.invalidatePattern(pattern);

      res.json({
        success: true,
        message: `Cache cleared for pattern: analytics:${pattern}*`,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get cache stats
   */
  getCacheStats = async (req, res, next) => {
    try {
      const stats = await this.cacheService.getStats();
      res.json({
        success: true,
        stats: stats,
      });
    } catch (error) {
      next(error);
    }
  };

  getPredefinedAnalytics = async (req, res, next) => {
    try {
      const { type } = req.params;

      const predefinedQueries = {
        "top-customers": "Show top 10 customers by sales value",
        "monthwise-comparison":
          "Compare sales month over month for the last 6 months",
        "sales-summary": "Give me a sales summary for this month",
        "party-summary":
          "Show party-wise sales summary with customer segmentation",
        statewise:
          "Show state-wise sales distribution with performance ranking",
      };

      if (!predefinedQueries[type]) {
        return res.status(400).json({
          success: false,
          error: "Invalid analytics type",
        });
      }

      req.body = { query: predefinedQueries[type] };
      return this.processQuery(req, res, next);
    } catch (error) {
      next(error);
    }
  };

  getTables = async (req, res, next) => {
    try {
      const tables = this.metadataService.getAllTables();
      res.json({
        success: true,
        tables: tables,
      });
    } catch (error) {
      next(error);
    }
  };

  getTableInfo = async (req, res, next) => {
    try {
      const { tableName } = req.params;
      const tableInfo = this.metadataService.getTableInfo(tableName);

      if (!tableInfo) {
        return res.status(404).json({
          success: false,
          error: "Table not found",
        });
      }

      res.json({
        success: true,
        table: tableInfo,
      });
    } catch (error) {
      next(error);
    }
  };
}

module.exports = new AnalyticsController();
