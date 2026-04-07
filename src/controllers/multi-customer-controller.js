//Multi Company
const sql = require("mssql");
const dbRouter = require("../config/database-router");
const MultiCustomerDeepSeekService = require("../services/multi-customer-service");
const MetadataService = require("../services/metadataService");
const logger = require("../utils/logger");
const DeepSeekService = require("../services/deepseekService");

class MultiCustomerController {
  constructor() {
    this.deepseekService = new MultiCustomerDeepSeekService();
    this.metadataService = new MetadataService();
  }

  /**
   * Main endpoint - authenticate via API key
   */
  processQuery = async (req, res, next) => {
    const startTime = Date.now();
    let totalActualTokens = 0;
    let totalActualCost = 0;
    let tokenDetails = {};

    try {
      // Authenticate via API key
      const apiKey = req.headers["authorization"]?.replace("Bearer ", "");
      if (!apiKey) {
        return res.status(401).json({
          success: false,
          error: "API key required. Use Authorization: Bearer <your_api_key>",
        });
      }

      // Validate API key and get customer
      const keyInfo = await dbRouter.validateApiKey(apiKey);
      const customerId = keyInfo.customer_id;

      // Check monthly limit
      const withinLimit = await dbRouter.checkCustomerLimit(customerId);
      if (!withinLimit) {
        return res.status(429).json({
          success: false,
          error: "Monthly API limit exceeded. Please upgrade your plan.",
        });
      }

      const { query, company_ids = null } = req.body;

      if (!query) {
        return res.status(400).json({
          success: false,
          error: "Query is required",
        });
      }

      logger.info(`[Customer: ${customerId}] Processing query: ${query}`);

      // Company detection (if needed)
      let targetCompanyIds = company_ids;
      let targetCompanyIdResutl = null;
      if (!targetCompanyIds) {
        targetCompanyIdResutl = await this.extractCompanyReferencesWithAI(
          customerId,
          query,
          apiKey,
        );
        targetCompanyIds = targetCompanyIdResutl?.companyids || null;
        logger.info(
          `[Customer: ${customerId}] AI detected companies: ${targetCompanyIds ? targetCompanyIds.join(", ") : "all"}`,
        );
      }

      // Get customer info
      const customerInfo = await dbRouter.getCustomerInfo(customerId);

      // Get customer's companies
      let targetCompanies = [];
      if (targetCompanyIds && targetCompanyIds.length > 0) {
        targetCompanies = await dbRouter.getCustomerCompanies(
          customerId,
          targetCompanyIds,
        );
      } else {
        targetCompanies = await dbRouter.getCustomerCompanies(customerId);
      }

      const companyIdList = targetCompanies.map((c) => c.company_id);
      logger.info(
        `[Customer: ${customerId}] Target companies: ${companyIdList.join(", ")}`,
      );

      if (targetCompanies.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No active companies found for this customer",
        });
      }

      // Get metadata
      const metadata = this.metadataService.getFullSchemaForAI();

      // ============ 1. Generate SQL ============
      const sqlResult = await this.deepseekService.generateSQL(
        customerId,
        query,
        metadata,
      );
      const sqlQuery = sqlResult.sqlQuery;
      logger.info(`[Customer: ${customerId}] Generated SQL: ${sqlQuery}`);

      // ============ 2. Execute Query ============
      const multiCompanyResult = await dbRouter.executeAcrossCompanies(
        customerId,
        companyIdList,
        (companyInfo) => sqlQuery,
      );

      // Combine all data
      const allData = [];
      for (const result of multiCompanyResult.results) {
        if (result.success) {
          allData.push(...result.data);
        }
      }

      const processingTime = Date.now() - startTime;
      logger.info(
        `[Customer: ${customerId}] Total rows: ${allData.length} from ${multiCompanyResult.results.length} companies in ${processingTime}ms`,
      );

      // ============ 3. Generate Insights ============
      const insightResult = await this.deepseekService.generateInsights(
        customerId,
        query,
        sqlQuery,
        allData,
      );
      const insights = insightResult.insights;

      // ============ 4. Generate Chart Recommendation ============
      const chartResult = await this.deepseekService.recommendChartType(
        customerId,
        query,
        sqlQuery,
        allData,
      );
      const chartConfig = chartResult.chartConfig;

      // ============ 5. Calculate Token Usage (Actual from API) ============
      // Reset counters
      totalActualTokens = 0;
      totalActualCost = 0;
      tokenDetails = {
        company_detection: null,
        sql_generation: null,
        insights_generation: null,
        chart_recommendation: null,
        totals: {
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 0,
          input_cost_cache_hit: 0,
          input_cost_cache_miss: 0,
          output_cost: 0,
        },
      };

      if (targetCompanyIdResutl?.usage) {
        totalActualTokens += targetCompanyIdResutl.usage.total_tokens;
        totalActualCost += targetCompanyIdResutl.cost.total;
        tokenDetails.company_detection = {
          prompt_tokens: targetCompanyIdResutl.usage.prompt_tokens,
          prompt_cache_hit_tokens:
            targetCompanyIdResutl.usage.prompt_cache_hit_tokens || 0,
          prompt_cache_miss_tokens:
            targetCompanyIdResutl.usage.prompt_cache_miss_tokens || 0,
          completion_tokens: targetCompanyIdResutl.usage.completion_tokens,
          total_tokens: targetCompanyIdResutl.usage.total_tokens,
          cost: targetCompanyIdResutl.cost,
        };
        tokenDetails.totals.prompt_cache_hit_tokens +=
          targetCompanyIdResutl.usage.prompt_cache_hit_tokens || 0;
        tokenDetails.totals.prompt_cache_miss_tokens +=
          targetCompanyIdResutl.usage.prompt_cache_miss_tokens || 0;
        tokenDetails.totals.input_cost_cache_hit +=
          targetCompanyIdResutl.cost.input_cache_hit || 0;
        tokenDetails.totals.input_cost_cache_miss +=
          targetCompanyIdResutl.cost.input_cache_miss || 0;
        tokenDetails.totals.output_cost +=
          targetCompanyIdResutl.cost.output || 0;
      }
      // Aggregate from SQL generation
      if (sqlResult.usage) {
        totalActualTokens += sqlResult.usage.total_tokens;
        totalActualCost += sqlResult.cost.total;
        tokenDetails.sql_generation = {
          prompt_tokens: sqlResult.usage.prompt_tokens,
          prompt_cache_hit_tokens: sqlResult.usage.prompt_cache_hit_tokens || 0,
          prompt_cache_miss_tokens:
            sqlResult.usage.prompt_cache_miss_tokens || 0,
          completion_tokens: sqlResult.usage.completion_tokens,
          total_tokens: sqlResult.usage.total_tokens,
          cost: sqlResult.cost,
        };
        tokenDetails.totals.prompt_cache_hit_tokens +=
          sqlResult.usage.prompt_cache_hit_tokens || 0;
        tokenDetails.totals.prompt_cache_miss_tokens +=
          sqlResult.usage.prompt_cache_miss_tokens || 0;
        tokenDetails.totals.input_cost_cache_hit +=
          sqlResult.cost.input_cache_hit || 0;
        tokenDetails.totals.input_cost_cache_miss +=
          sqlResult.cost.input_cache_miss || 0;
        tokenDetails.totals.output_cost += sqlResult.cost.output || 0;
      }

      // Aggregate from Insights generation
      if (insightResult.usage) {
        totalActualTokens += insightResult.usage.total_tokens;
        totalActualCost += insightResult.cost.total;
        tokenDetails.insights_generation = {
          prompt_tokens: insightResult.usage.prompt_tokens,
          prompt_cache_hit_tokens:
            insightResult.usage.prompt_cache_hit_tokens || 0,
          prompt_cache_miss_tokens:
            insightResult.usage.prompt_cache_miss_tokens || 0,
          completion_tokens: insightResult.usage.completion_tokens,
          total_tokens: insightResult.usage.total_tokens,
          cost: insightResult.cost,
        };
        tokenDetails.totals.prompt_cache_hit_tokens +=
          insightResult.usage.prompt_cache_hit_tokens || 0;
        tokenDetails.totals.prompt_cache_miss_tokens +=
          insightResult.usage.prompt_cache_miss_tokens || 0;
        tokenDetails.totals.input_cost_cache_hit +=
          insightResult.cost.input_cache_hit || 0;
        tokenDetails.totals.input_cost_cache_miss +=
          insightResult.cost.input_cache_miss || 0;
        tokenDetails.totals.output_cost += insightResult.cost.output || 0;
      }

      // Aggregate from Chart recommendation
      if (chartResult.usage) {
        totalActualTokens += chartResult.usage.total_tokens;
        totalActualCost += chartResult.cost.total;
        tokenDetails.chart_recommendation = {
          prompt_tokens: chartResult.usage.prompt_tokens,
          prompt_cache_hit_tokens:
            chartResult.usage.prompt_cache_hit_tokens || 0,
          prompt_cache_miss_tokens:
            chartResult.usage.prompt_cache_miss_tokens || 0,
          completion_tokens: chartResult.usage.completion_tokens,
          total_tokens: chartResult.usage.total_tokens,
          cost: chartResult.cost,
        };
        tokenDetails.totals.prompt_cache_hit_tokens +=
          chartResult.usage.prompt_cache_hit_tokens || 0;
        tokenDetails.totals.prompt_cache_miss_tokens +=
          chartResult.usage.prompt_cache_miss_tokens || 0;
        tokenDetails.totals.input_cost_cache_hit +=
          chartResult.cost.input_cache_hit || 0;
        tokenDetails.totals.input_cost_cache_miss +=
          chartResult.cost.input_cache_miss || 0;
        tokenDetails.totals.output_cost += chartResult.cost.output || 0;
      }

      // Calculate estimated tokens (for comparison, optional)
      const estimatedTokens = Math.round(
        (query.length + sqlQuery.length + JSON.stringify(allData).length) / 4,
      );

      // Calculate accuracy percentage
      const tokenAccuracy =
        totalActualTokens > 0
          ? (
              (1 -
                Math.abs(totalActualTokens - estimatedTokens) /
                  totalActualTokens) *
              100
            ).toFixed(1)
          : 0;

      // ============ 6. Track Usage in Database ============
      await dbRouter.trackUsage(
        customerId,
        companyIdList,
        query,
        sqlQuery,
        totalActualTokens, // Actual tokens from API
        totalActualCost, // Actual cost from API
        processingTime,
        estimatedTokens, // Estimated tokens (for comparison)
        tokenAccuracy, // Accuracy percentage
        tokenDetails.totals, // Detailed cache breakdown
      );

      // Log token usage for debugging
      logger.info(`[Customer: ${customerId}] Token Usage - 
            Actual: ${totalActualTokens}, 
            Estimated: ${estimatedTokens}, 
            Accuracy: ${tokenAccuracy}%,
            Cost: $${totalActualCost.toFixed(6)} (₹${(totalActualCost * 85).toFixed(2)})`);

      // ============ 7. Return Response ============
      res.json({
        success: true,
        customer_id: customerId,
        customer_name: customerInfo.customer_name,
        query: query,
        sqlQuery: sqlQuery,
        data: allData,
        insights: insights,
        chartConfig: chartConfig,
        token_usage: {
          actual: totalActualTokens,
          estimated: estimatedTokens,
          accuracy: `${tokenAccuracy}%`,
          breakdown: tokenDetails,
        },
        cost: {
          actual_usd: totalActualCost,
          estimated_usd: (estimatedTokens / 1000000) * 0.28,
          inr: `₹${(totalActualCost * 85).toFixed(2)}`,
        },
        companies: {
          total: companyIdList.length,
          successful: multiCompanyResult.results.filter((r) => r.success)
            .length,
          failed: multiCompanyResult.errors.length,
          details: multiCompanyResult.results.map((r) => ({
            company_id: r.company_id,
            company_name: r.company_name,
            row_count: r.rowCount,
            success: r.success,
          })),
        },
        rowCount: allData.length,
        processing_time_ms: processingTime,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Error in processQuery: ${error.message}`);
      next(error);
    }
  };
  processQuery2 = async (req, res, next) => {
    const startTime = Date.now();
    let totalActualTokens = 0;
    let totalActualCost = 0;
    let tokenDetails = {};

    try {
      // Authenticate via API key
      const apiKey = req.headers["authorization"]?.replace("Bearer ", "");
      if (!apiKey) {
        return res.status(401).json({
          success: false,
          error: "API key required. Use Authorization: Bearer <your_api_key>",
        });
      }

      // Validate API key and get customer
      const keyInfo = await dbRouter.validateApiKey(apiKey);
      const customerId = keyInfo.customer_id;

      // Check monthly limit
      const withinLimit = await dbRouter.checkCustomerLimit(customerId);
      if (!withinLimit) {
        return res.status(429).json({
          success: false,
          error: "Monthly API limit exceeded. Please upgrade your plan.",
        });
      }

      const {
        query,
        company_ids = null, // Optional: specific company IDs
      } = req.body;

      let targetCompanyIds = company_ids;
      // If no explicit company IDs, try AI detection
      if (!targetCompanyIds) {
        targetCompanyIds = await this.extractCompanyReferencesWithAI(
          customerId,
          query,
          apiKey,
        );
        logger.info(
          `[Customer: ${customerId}] AI detected companies: ${targetCompanyIds ? targetCompanyIds.join(", ") : "all"}`,
        );
      }

      if (!query) {
        return res.status(400).json({
          success: false,
          error: "Query is required",
        });
      }

      logger.info(`[Customer: ${customerId}] Processing query: ${query}`);

      // Get customer info
      const customerInfo = await dbRouter.getCustomerInfo(customerId);

      // Get customer's companies (from THEIR MainDB)
      let targetCompanies = [];
      if (!targetCompanyIds) {
        if (company_ids && company_ids.length > 0) {
          // Get specific companies
          targetCompanies = await dbRouter.getCustomerCompanies(
            customerId,
            company_ids,
          );
        } else {
          // Get all active companies
          targetCompanies = await dbRouter.getCustomerCompanies(customerId);
        }
      } else {
        targetCompanies = await dbRouter.getCustomerCompanies(
          customerId,
          targetCompanyIds,
        );
      }

      const companyIdList = targetCompanies.map((c) => c.company_id);
      logger.info(
        `[Customer: ${customerId}] Target companies: ${companyIdList.join(", ")}`,
      );

      if (targetCompanies.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No active companies found for this customer",
        });
      }

      // Get metadata (from your metadata service)
      const metadata = this.metadataService.getFullSchemaForAI();

      // Generate SQL using DeepSeek
      // const sqlQuery = await this.deepseekService.generateSQL(
      //   customerId,
      //   query,
      //   metadata,
      // );
      // Generate SQL using DeepSeek (NOW RETURNS USAGE)
      const sqlResult = await this.deepseekService.generateSQL(
        customerId,
        query,
        metadata,
      );
      const sqlQuery = sqlResult.sqlQuery;
      //const sqlQuery = sqlResult;

      // Capture SQL generation tokens
      // if (sqlResult.usage) {
      //   totalActualTokens += sqlResult.usage.total_tokens;
      //   totalActualCost += sqlResult.cost.total;
      //   tokenDetails.sqlGeneration = {
      //     prompt_tokens: sqlResult.usage.prompt_tokens,
      //     completion_tokens: sqlResult.usage.completion_tokens,
      //     total_tokens: sqlResult.usage.total_tokens,
      //     cost: sqlResult.cost.total,
      //   };
      // }

      logger.info(`[Customer: ${customerId}] Generated SQL: ${sqlQuery}`);

      // Execute across selected companies
      const multiCompanyResult = await dbRouter.executeAcrossCompanies(
        customerId,
        companyIdList,
        (companyInfo) => sqlQuery,
      );

      // Combine all data
      const allData = [];
      for (const result of multiCompanyResult.results) {
        if (result.success) {
          allData.push(...result.data);
        }
      }

      const processingTime = Date.now() - startTime;
      logger.info(
        `[Customer: ${customerId}] Total rows: ${allData.length} from ${multiCompanyResult.results.length} companies in ${processingTime}ms`,
      );

      // Generate insights (NOW RETURNS USAGE)
      const insightResult = await this.deepseekService.generateInsights(
        customerId,
        query,
        sqlQuery,
        allData,
      );
      const insights = insightResult.insights;

      // Capture insights generation tokens
      // if (insightResult.usage) {
      //   totalActualTokens += insightResult.usage.total_tokens;
      //   totalActualCost += insightResult.cost.total;
      //   tokenDetails.insightsGeneration = {
      //     prompt_tokens: insightResult.usage.prompt_tokens,
      //     completion_tokens: insightResult.usage.completion_tokens,
      //     total_tokens: insightResult.usage.total_tokens,
      //     cost: insightResult.cost.total,
      //   };
      // }

      // const insights = await this.deepseekService.generateInsights(
      //   customerId,
      //   query,
      //   sqlQuery,
      //   allData,
      // );

      // **NEW: Generate chart recommendation**
      // const chartConfig = await this.deepseekService.recommendChartType(
      //   customerId,
      //   query,
      //   sqlQuery,
      //   allData,
      // );

      // Generate chart recommendation (NOW RETURNS USAGE)
      const chartResult = await this.deepseekService.recommendChartType(
        customerId,
        query,
        sqlQuery,
        allData,
      );
      const chartConfig = chartResult.chartConfig;

      // Capture chart recommendation tokens
      // if (chartResult.usage) {
      //   totalActualTokens += chartResult.usage.total_tokens;
      //   totalActualCost += chartResult.cost.total;
      //   tokenDetails.chartRecommendation = {
      //     prompt_tokens: chartResult.usage.prompt_tokens,
      //     completion_tokens: chartResult.usage.completion_tokens,
      //     total_tokens: chartResult.usage.total_tokens,
      //     cost: chartResult.cost.total,
      //   };
      // }

      // Track usage (approximate tokens - you can get exact from DeepSeek response)
      // const estimatedTokens =
      //   (query.length + sqlQuery.length + JSON.stringify(allData).length) / 4;
      // const estimatedCost = (estimatedTokens / 1000000) * 0.28;

      // Calculate accuracy percentage
      // const tokenAccuracy =
      //   totalActualTokens > 0
      //     ? (
      //         (1 -
      //           Math.abs(totalActualTokens - estimatedTokens) /
      //             totalActualTokens) *
      //         100
      //       ).toFixed(1)
      //     : 0;

      // Calculate totals with proper cache pricing
      let totalActualTokens = 0;
      let totalActualCost = 0;
      let tokenDetails = {
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 0,
        input_cost_cache_hit: 0,
        input_cost_cache_miss: 0,
        output_cost: 0,
      };

      // Aggregate from all three calls
      for (const result of [sqlResult, insightResult, chartResult]) {
        if (result.usage) {
          totalActualTokens += result.usage.total_tokens;
          totalActualCost += result.cost.total;
          tokenDetails.prompt_cache_hit_tokens +=
            result.usage.prompt_cache_hit_tokens || 0;
          tokenDetails.prompt_cache_miss_tokens +=
            result.usage.prompt_cache_miss_tokens || 0;
          tokenDetails.input_cost_cache_hit += result.cost.input_cache_hit || 0;
          tokenDetails.input_cost_cache_miss +=
            result.cost.input_cache_miss || 0;
          tokenDetails.output_cost += result.cost.output || 0;
        }
      }

      // Track with detailed token info
      await dbRouter.trackUsage(
        customerId,
        companyIdList,
        query,
        sqlQuery,
        totalActualTokens,
        totalActualCost,
        processingTime,
        estimatedTokens,
        tokenAccuracy,
        tokenDetails,
      );

      // await dbRouter.trackUsage(
      //   customerId,
      //   companyIdList,
      //   query,
      //   sqlQuery,
      //   totalActualTokens,
      //   totalActualCost,
      //   tokenAccuracy,
      //   estimatedTokens,
      //   estimatedCost,
      //   processingTime,
      // );

      // Log token comparison for debugging
      // logger.info(`[Customer: ${customerId}] Token Usage -
      //       Actual: ${totalActualTokens},
      //       Cost: ₹${(totalActualCost * 85).toFixed(2)}`);

      res.json({
        success: true,
        customer_id: customerId,
        customer_name: customerInfo.customer_name,
        query: query,
        sqlQuery: sqlQuery,
        data: allData,
        insights: insights,
        chartConfig: chartConfig, // ← Add this
        token_usage: {
          actual: totalActualTokens,
          estimated: 0, //Math.round(estimatedTokens),
          accuracy: 0, //`${tokenAccuracy}%`,
          details: tokenDetails,
        },
        cost: {
          actual: totalActualCost,
          estimated: estimatedCost,
          inr: `₹${(totalActualCost * 85).toFixed(2)}`,
        },
        companies: {
          total: companyIdList.length,
          successful: multiCompanyResult.results.filter((r) => r.success)
            .length,
          failed: multiCompanyResult.errors.length,
          details: multiCompanyResult.results.map((r) => ({
            company_id: r.company_id,
            company_name: r.company_name,
            row_count: r.rowCount,
            success: r.success,
          })),
        },
        rowCount: allData.length,
        processing_time_ms: processingTime,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Error in processQuery: ${error.message}`);
      next(error);
    }
  };

  getCustomerApiKey = async (req, res, next) => {
    try {
      const { customer_id: customerId } = req.body;

      if (!customerId) {
        return res.status(400).json({
          success: false,
          error: "customer_id is required",
        });
      }

      const apiKey = await this.deepseekService.getCustomerApiKey(customerId);

      res.json({
        success: true,
        customer_id: customerId,
        api_key: apiKey,
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get customer's companies (from THEIR MainDB)
   */
  getCompanies = async (req, res, next) => {
    try {
      const apiKey = req.headers["authorization"]?.replace("Bearer ", "");
      if (!apiKey) {
        return res.status(401).json({ error: "API key required" });
      }

      const keyInfo = await dbRouter.validateApiKey(apiKey);
      const customerId = keyInfo.customer_id;

      const companies = await dbRouter.getCustomerCompanies(customerId);

      res.json({
        success: true,
        customer_id: customerId,
        companies: companies.map((c) => ({
          company_id: c.company_id,
          company_name: c.company_name,
          company_code: c.company_code,
          db_name: c.company_db_name,
          is_active: true,
        })),
      });
    } catch (error) {
      next(error);
    }
  };

  /**
   * Get customer usage statistics
   */
  getUsage = async (req, res, next) => {
    try {
      const apiKey = req.headers["authorization"]?.replace("Bearer ", "");
      if (!apiKey) {
        return res.status(401).json({ error: "API key required" });
      }

      const keyInfo = await dbRouter.validateApiKey(apiKey);
      const customerId = keyInfo.customer_id;

      const registry = await dbRouter.connectRegistry();
      const [rows] = await registry.execute(
        `SELECT 
                    DATE(query_timestamp) as date,
                    COUNT(*) as query_count,
                    SUM(tokens_used) as total_tokens,
                    SUM(cost) as total_cost,
                    AVG(processing_time_ms) as avg_processing_time
                 FROM customer_usage 
                 WHERE customer_id = ? 
                 GROUP BY DATE(query_timestamp)
                 ORDER BY date DESC
                 LIMIT 30`,
        [customerId],
      );

      // Get current month usage
      const [currentMonth] = await registry.execute(
        `SELECT 
                    used_this_month as tokens_used,
                    monthly_limit as token_limit
                 FROM customer_api_keys 
                 WHERE customer_id = ? AND is_active = TRUE`,
        [customerId],
      );

      res.json({
        success: true,
        customer_id: customerId,
        current_month: currentMonth[0] || {
          tokens_used: 0,
          token_limit: 100000,
        },
        daily_usage: rows,
      });
    } catch (error) {
      next(error);
    }
  };

  // Add this method to your controller
  async extractCompanyReferences(customerId, userQuery) {
    const companies = await dbRouter.getCustomerCompanies(customerId);
    const detectedCompanyIds = [];

    const lowerQuery = userQuery.toLowerCase();

    // Check each company name in the query
    for (const company of companies) {
      const companyNameLower = company.company_name.toLowerCase();
      const companyCodeLower = company.company_code.toLowerCase();

      // Look for company name or code in query
      if (
        lowerQuery.includes(companyNameLower) ||
        lowerQuery.includes(companyCodeLower) ||
        (lowerQuery.includes("only") &&
          lowerQuery.includes(companyNameLower.split(" ")[0]))
      ) {
        detectedCompanyIds.push(company.company_id);
      }
    }

    // Check for keywords that indicate all companies
    const allKeywords = [
      "all companies",
      "all divisions",
      "entire organization",
      "consolidated",
      "overall",
    ];
    for (const keyword of allKeywords) {
      if (lowerQuery.includes(keyword)) {
        return null; // null means all companies
      }
    }

    // Check for single company indicators
    const singleKeywords = ["only", "just", "specifically", "particular"];
    if (
      detectedCompanyIds.length === 0 &&
      singleKeywords.some((k) => lowerQuery.includes(k))
    ) {
      // User wants only one company but didn't specify which
      // You could return first company or ask for clarification
      return null; // Or return [companies[0].company_id]
    }

    return detectedCompanyIds.length > 0 ? detectedCompanyIds : null;
  }

  async extractCompanyReferencesWithAI(customerId, userQuery, apiKey) {
    const companies = await dbRouter.getCustomerCompanies(customerId);

    const companiesList = companies
      .map(
        (c) =>
          `- ${c.company_name} (ID: ${c.company_id}, Code: ${c.company_code})`,
      )
      .join("\n");

    const prompt = `
You are a company name detector. Given this user query and available companies, identify which company/companies they want.

AVAILABLE COMPANIES:
${companiesList}

USER QUERY: "${userQuery}"

INSTRUCTIONS:
1. Return ONLY a JSON object, no other text
2. If user wants ONE specific company: {"company_ids": [id]}
3. If user wants MULTIPLE companies: {"company_ids": [id1, id2]}
4. If user wants ALL companies or doesn't specify: {"company_ids": null}
5. If user says "only X company" or "just X", return only that company

Example responses:
- {"company_ids": [1]}
- {"company_ids": [1, 2]}
- {"company_ids": null}

Now respond with JSON only:
`;

    try {
      const deepseek = new DeepSeekService(apiKey);
      const response = await deepseek.callDeepSeek(prompt, 0.1, 100);
      let companyIds = null;
      try {
        const result = JSON.parse(response.content);
        companyIds = result.company_ids;
      } catch (parseError) {
        logger.warn(
          `AI company detection JSON parse failed, falling back to all companies: ${parseError.message}`,
        );
      }

      return {
        companyids: companyIds,
        usage: response.usage,
        cost: response.cost,
      };
    } catch (error) {
      logger.error(`AI company detection failed: ${error.message}`);
      return null; // Fallback to all companies
    }
  }

  /**
   * Get token usage statistics for customer
   */
  getTokenUsageStats = async (req, res, next) => {
    try {
      // Authenticate via API key
      const apiKey = req.headers["authorization"]?.replace("Bearer ", "");
      if (!apiKey) {
        return res.status(401).json({
          success: false,
          error: "API key required",
        });
      }

      // Validate API key and get customer
      const keyInfo = await dbRouter.validateApiKey(apiKey);
      const customerId = keyInfo.customer_id;

      const registry = await dbRouter.connectRegistry();

      // Get customer's API key info (monthly limit)
      const keyResult = await registry
        .request()
        .input("customerId", sql.VarChar, customerId).query(`SELECT
                  id,
                  customer_id,
                  monthly_limit,
                  used_this_month,
                  used_this_month_actual,
                  last_reset_date,
                  is_active
                FROM customer_api_keys
                WHERE customer_id = @customerId AND is_active = 0`);
      const keyRows = keyResult.recordset;

      if (keyRows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "API key configuration not found",
        });
      }

      const keyInfo_data = keyRows[0];

      // Get usage statistics from customer_usage table
      const usageResult = await registry
        .request()
        .input("customerId", sql.VarChar, customerId).query(`SELECT
                  COUNT(*) as total_queries,
                  SUM(tokens_used_actual) as total_tokens_actual,
                  SUM(tokens_used_estimated) as total_tokens_estimated,
                  SUM(cost_actual) as total_cost_actual,
                  SUM(cost_estimated) as total_cost_estimated,
                  AVG(token_accuracy_percent) as avg_accuracy,
                  AVG(processing_time_ms) as avg_processing_time,
                  MIN(query_timestamp) as first_query_date,
                  MAX(query_timestamp) as last_query_date
                FROM customer_usage
                WHERE customer_id = @customerId
                  AND query_timestamp >= DATEADD(DAY, -30, GETDATE())`);
      const usageRows = usageResult.recordset;

      // Get daily usage for chart
      const dailyResult = await registry
        .request()
        .input("customerId", sql.VarChar, customerId).query(`SELECT TOP 30
                  CAST(query_timestamp AS DATE) as date,
                  COUNT(*) as query_count,
                  SUM(tokens_used_actual) as tokens_used,
                  SUM(cost_actual) as cost
                FROM customer_usage
                WHERE customer_id = @customerId
                  AND query_timestamp >= DATEADD(DAY, -30, GETDATE())
                GROUP BY CAST(query_timestamp AS DATE)
                ORDER BY date DESC`);
      const dailyRows = dailyResult.recordset;

      // Get recent queries
      const recentResult = await registry
        .request()
        .input("customerId", sql.VarChar, customerId).query(`SELECT TOP 10
                  id,
                  query_text,
                  tokens_used_actual,
                  cost_actual,
                  processing_time_ms,
                  query_timestamp,
                  token_accuracy_percent
                FROM customer_usage
                WHERE customer_id = @customerId
                ORDER BY query_timestamp DESC`);
      const recentRows = recentResult.recordset;

      // Calculate balance
      const monthlyLimit = keyInfo_data.monthly_limit || 100000;
      const usedTokens =
        keyInfo_data.used_this_month_actual ||
        keyInfo_data.used_this_month ||
        0;
      const balanceTokens = monthlyLimit - usedTokens;
      const usagePercent = (usedTokens / monthlyLimit) * 100;

      // Check if reset needed
      const lastReset = keyInfo_data.last_reset_date;
      const now = new Date();
      let needsReset = false;

      if (lastReset) {
        const lastResetDate = new Date(lastReset);
        if (
          lastResetDate.getMonth() !== now.getMonth() ||
          lastResetDate.getFullYear() !== now.getFullYear()
        ) {
          needsReset = true;
        }
      }

      res.json({
        success: true,
        customer_id: customerId,
        token_limits: {
          monthly_limit: monthlyLimit,
          used_this_month: usedTokens,
          balance_tokens: balanceTokens,
          usage_percentage: Math.round(usagePercent),
          needs_reset: needsReset,
          last_reset_date: keyInfo_data.last_reset_date,
        },
        statistics: {
          total_queries: usageRows[0].total_queries || 0,
          total_tokens_actual: usageRows[0].total_tokens_actual || 0,
          total_tokens_estimated: usageRows[0].total_tokens_estimated || 0,
          total_cost_actual: usageRows[0].total_cost_actual || 0,
          total_cost_estimated: usageRows[0].total_cost_estimated || 0,
          avg_accuracy: Math.round(usageRows[0].avg_accuracy || 0),
          avg_processing_time: Math.round(
            usageRows[0].avg_processing_time || 0,
          ),
          first_query_date: usageRows[0].first_query_date,
          last_query_date: usageRows[0].last_query_date,
        },
        daily_usage: dailyRows,
        recent_queries: recentRows,
        reset_action: {
          can_reset: needsReset,
          reset_endpoint: "/api/multi-customer/usage/reset",
        },
      });
    } catch (error) {
      logger.error(`Error in getTokenUsageStats: ${error.message}`);
      next(error);
    }
  };

  /**
   * Reset monthly usage counter
   */
  resetMonthlyUsage = async (req, res, next) => {
    try {
      const apiKey = req.headers["authorization"]?.replace("Bearer ", "");
      if (!apiKey) {
        return res.status(401).json({
          success: false,
          error: "API key required",
        });
      }

      const keyInfo = await dbRouter.validateApiKey(apiKey);
      const customerId = keyInfo.customer_id;

      const registry = await dbRouter.connectRegistry();

      // Reset the usage counters
      await registry.execute(
        `UPDATE customer_api_keys 
             SET used_this_month = 0,
                 used_this_month_actual = 0,
                 last_reset_date = CURDATE()
             WHERE customer_id = ?`,
        [customerId],
      );

      res.json({
        success: true,
        message: "Monthly usage reset successfully",
        reset_date: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Error in resetMonthlyUsage: ${error.message}`);
      next(error);
    }
  };

  /**
   * Purchase tokens endpoint
   */
  purchaseTokens = async (req, res, next) => {
    try {
      const apiKey = req.headers["authorization"]?.replace("Bearer ", "");
      const keyInfo = await dbRouter.validateApiKey(apiKey);
      const customerId = keyInfo.customer_id;

      const { payment_amount, payment_currency = "USD" } = req.body;

      const result = await dbRouter.purchaseTokens(
        customerId,
        payment_amount,
        payment_currency,
      );

      // Get updated balance
      const balance = await dbRouter.getTokenBalance(customerId);

      res.json({
        success: true,
        purchase: result,
        current_balance: balance.summary,
      });
    } catch (error) {
      logger.error(`Purchase error: ${error.message}`);
      next(error);
    }
  };

  /**
   * Get token balance endpoint
   */
  getTokenBalance = async (req, res, next) => {
    try {
      const apiKey = req.headers["authorization"]?.replace("Bearer ", "");
      const keyInfo = await dbRouter.validateApiKey(apiKey);
      const customerId = keyInfo.customer_id;

      const balance = await dbRouter.getTokenBalance(customerId);

      res.json({
        success: true,
        customer_id: customerId,
        ...balance,
      });
    } catch (error) {
      logger.error(`Balance error: ${error.message}`);
      next(error);
    }
  };
}

module.exports = new MultiCustomerController();
