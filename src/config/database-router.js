//for Multi Company
const sql = require("mssql");
const logger = require("../utils/logger");

class DatabaseRouter {
  constructor() {
    this.registryPool = null; // Central registry connection
    this.customerMainConnections = new Map(); // Customer MainDB connections
    this.companyConnections = new Map(); // Company DB connections
  }

  /**
   * Connect to Central Registry Database
   */
  async connectRegistry() {
    if (this.registryPool) return this.registryPool;

    const config = {
      user: process.env.REGISTRY_DB_USER,
      password: process.env.REGISTRY_DB_PASSWORD,
      server: process.env.REGISTRY_DB_HOST,
      database: process.env.REGISTRY_DB_NAME,
      port: parseInt(process.env.REGISTRY_DB_PORT, 10) || 1433,
      options: {
        encrypt: process.env.REGISTRY_DB_ENCRYPT === "true",
        trustServerCertificate: true,
        enableArithAbort: true,
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };

    this.registryPool = await new sql.ConnectionPool(config).connect();

    logger.info("Connected to AI Agent Registry Database");
    return this.registryPool;
  }

  /**
   * Get customer information from registry
   */
  async getCustomerInfo(customerId) {
    const registry = await this.connectRegistry();
    const result = await registry
      .request()
      .input("customerId", sql.VarChar, customerId)
      .query(
        "SELECT * FROM customers WHERE customer_id = @customerId AND status = 'active'",
      );
    const rows = result.recordset;

    if (rows.length === 0) {
      throw new Error(`Customer ${customerId} not found or inactive`);
    }

    return rows[0];
  }

  /**
   * Validate customer API key
   */
  async validateApiKey(apiKey) {
    const registry = await this.connectRegistry();
    const result = await registry.request().input("apiKey", sql.VarChar, apiKey)
      .query(`SELECT customer_id, monthly_limit, used_this_month
              FROM customer_api_keys
              WHERE api_key = @apiKey AND is_active = 0`);
    const rows = result.recordset;

    if (rows.length === 0) {
      logger.error("Invalid API key");
      throw new Error("Invalid API key");
    }

    return rows[0];
  }

  /**
   * Connect to customer's Main Database (where their company_master lives)
   */
  async connectToCustomerMainDB(customerId) {
    // Check cache
    if (this.customerMainConnections.has(customerId)) {
      return this.customerMainConnections.get(customerId);
    }

    const customerInfo = await this.getCustomerInfo(customerId);

    const config = {
      user: customerInfo.main_db_user,
      password: customerInfo.main_db_password,
      server: customerInfo.main_db_host,
      database: customerInfo.main_db_name,
      port: customerInfo.main_db_port,
      options: {
        encrypt: customerInfo.main_db_encrypt === 1,
        trustServerCertificate: true,
        enableArithAbort: true,
      },
    };

    const connection = await new sql.ConnectionPool(config).connect();
    this.customerMainConnections.set(customerId, connection);

    logger.info(
      `Connected to customer MainDB: ${customerInfo.main_db_name} (${customerId})`,
    );
    return connection;
  }

  /**
   * Get customer's companies from THEIR MainDB (not from registry)
   */
  async getCustomerCompanies(customerId, companyIds = null) {
    const customerInfo = await this.getCustomerInfo(customerId);
    const connection = await this.connectToCustomerMainDB(customerId);

    let query = `
            SELECT 
                companyid as company_id,
                companyname as company_name,
                companycode as company_code,
                '${customerInfo.main_db_host}' as company_db_host,
                '${customerInfo.main_db_port}' as company_db_port,
                companyid as company_db_name,
                '${customerInfo.main_db_user}' as company_db_user,                 
                '${customerInfo.main_db_password}' as company_db_password,
                ${customerInfo.main_db_encrypt ? 1 : 0} as company_db_encrypt
            FROM company
            WHERE 1 = 1
        `;

    if (companyIds && companyIds.length > 0) {
      query += ` AND companyid IN (${companyIds.map((_, index) => `@companyId${index}`).join(",")})`;
      const request = connection.request();
      companyIds.forEach((id, index) =>
        request.input(`companyId${index}`, sql.VarChar, id),
      );
      const result = await request.query(query);
      return result.recordset;
    }

    const result = await connection.request().query(query);
    return result.recordset;
  }

  /**
   * Get single company info
   */
  async getCompanyInfo(customerId, companyId) {
    const customerInfo = await this.getCustomerInfo(customerId);
    const connection = await this.connectToCustomerMainDB(customerId);

    const result = await connection
      .request()
      .input("companyId", sql.VarChar, companyId).query(`
                SELECT 
                    companyid as company_id,
                    companyname as company_name,
                    companycode as company_code,
                    '${customerInfo.main_db_host}' as company_db_host,
                    '${customerInfo.main_db_port}' as company_db_port,
                    companyid as company_db_name,
                    '${customerInfo.main_db_user}' as company_db_user,                 
                    '${customerInfo.main_db_password}' as company_db_password,
                    ${customerInfo.main_db_encrypt ? 1 : 0} as company_db_encrypt
                FROM company
                WHERE companyid = @companyId
            `);

    if (result.recordset.length === 0) {
      throw new Error(
        `Company ${companyId} not found for customer ${customerId}`,
      );
    }

    return result.recordset[0];
  }

  /**
   * Connect to a specific company's database
   */
  async connectToCompanyDB(customerId, companyId) {
    const cacheKey = `${customerId}_${companyId}`;

    // Check cache
    if (this.companyConnections.has(cacheKey)) {
      return this.companyConnections.get(cacheKey);
    }

    const companyInfo = await this.getCompanyInfo(customerId, companyId);

    const config = {
      user: companyInfo.company_db_user,
      password: companyInfo.company_db_password,
      server: companyInfo.company_db_host,
      database: companyInfo.company_db_name,
      port: Number.parseInt(companyInfo.company_db_port, 10) || 1433,
      options: {
        encrypt: companyInfo.company_db_encrypt === 1,
        trustServerCertificate: true,
        enableArithAbort: true,
      },
    };

    const connection = await new sql.ConnectionPool(config).connect();
    this.companyConnections.set(cacheKey, connection);

    logger.info(
      `Connected to company DB: ${companyInfo.company_db_name} (${customerId}/${companyId})`,
    );
    return connection;
  }

  /**
   * Execute query across multiple companies
   */
  async executeAcrossCompanies(customerId, companyIds, queryBuilder) {
    const results = [];
    const errors = [];

    for (const companyId of companyIds) {
      try {
        const connection = await this.connectToCompanyDB(customerId, companyId);
        const companyInfo = await this.getCompanyInfo(customerId, companyId);

        const query = queryBuilder(companyInfo);
        const result = await connection.request().query(query);

        // Add company context to each row
        const enrichedData = result.recordset.map((row) => ({
          ...row,
          company_id: companyId,
          company_name: companyInfo.company_name,
          company_code: companyInfo.company_code,
        }));

        results.push({
          company_id: companyId,
          company_name: companyInfo.company_name,
          data: enrichedData,
          rowCount: result.recordset.length,
          success: true,
        });

        logger.info(
          `Query executed for ${customerId}/company ${companyId}: ${result.recordset.length} rows`,
        );
      } catch (error) {
        logger.error(
          `Error for ${customerId}/company ${companyId}: ${error.message}`,
        );
        errors.push({
          company_id: companyId,
          error: error.message,
          success: false,
        });
      }
    }

    return { results, errors };
  }

  /**
   * Track customer usage
   */
  async trackUsage(
    customerId,
    companyIds,
    queryText,
    sqlQuery,
    actualTokens,
    actualCost,
    processingTimeMs,
    estimatedTokens = null,
    accuracy = null,
    tokenDetails = null,
  ) {
    const registry = await this.connectRegistry();
    const safeEstimatedTokens = Number.isFinite(estimatedTokens)
      ? estimatedTokens
      : null;
    const estimatedCost =
      safeEstimatedTokens === null ? 0 : (safeEstimatedTokens / 1000000) * 0.28;

    await registry
      .request()
      .input("customerId", sql.VarChar(100), customerId)
      .input("companyIds", sql.NVarChar(sql.MAX), JSON.stringify(companyIds))
      .input("queryText", sql.NVarChar(500), queryText.substring(0, 500))
      .input("sqlQuery", sql.NVarChar(sql.MAX), sqlQuery)
      .input("tokensUsedActual", sql.Int, actualTokens)
      .input("tokensUsedEstimated", sql.Int, safeEstimatedTokens)
      .input("costActual", sql.Decimal(18, 6), actualCost)
      .input("costEstimated", sql.Decimal(18, 6), estimatedCost)
      .input(
        "promptCacheHit",
        sql.Int,
        tokenDetails?.prompt_cache_hit_tokens || 0,
      )
      .input(
        "promptCacheMiss",
        sql.Int,
        tokenDetails?.prompt_cache_miss_tokens || 0,
      )
      .input(
        "inputCostCacheHit",
        sql.Decimal(18, 6),
        tokenDetails?.input_cost_cache_hit || 0,
      )
      .input(
        "inputCostCacheMiss",
        sql.Decimal(18, 6),
        tokenDetails?.input_cost_cache_miss || 0,
      )
      .input(
        "outputCost",
        sql.Decimal(18, 6),
        tokenDetails?.output_cost || 0,
      )
      .input("tokenAccuracy", sql.Decimal(5, 2), accuracy)
      .input("processingTimeMs", sql.Int, processingTimeMs)
      .query(`INSERT INTO customer_usage 
         (customer_id, company_ids, query_text, sql_query, 
          tokens_used_actual, tokens_used_estimated, cost_actual, cost_estimated,
          prompt_cache_hit_tokens, prompt_cache_miss_tokens,
          input_cost_cache_hit, input_cost_cache_miss, output_cost,
          token_accuracy_percent, processing_time_ms) 
         VALUES (@customerId, @companyIds, @queryText, @sqlQuery,
                 @tokensUsedActual, @tokensUsedEstimated, @costActual, @costEstimated,
                 @promptCacheHit, @promptCacheMiss,
                 @inputCostCacheHit, @inputCostCacheMiss, @outputCost,
                 @tokenAccuracy, @processingTimeMs)`);

    // Update monthly usage with ACTUAL tokens
    await registry
      .request()
      .input("actualTokens", sql.Int, actualTokens)
      .input("customerId", sql.VarChar(100), customerId)
      .query(`UPDATE customer_api_keys 
         SET used_this_month = used_this_month + @actualTokens,
             used_this_month_actual = used_this_month_actual + @actualTokens
         WHERE customer_id = @customerId`);
  }
  async trackUsage_old(
    customerId,
    companyIds,
    queryText,
    sqlQuery,
    actualTokens,
    actualCost,
    tokensUsed,
    cost,
    processingTimeMs,
    estimatedTokens = null,
    accuracy = null,
  ) {
    const registry = await this.connectRegistry();

    await registry
      .request()
      .input("customerId", sql.VarChar, customerId)
      .input("companyIds", sql.NVarChar(sql.MAX), JSON.stringify(companyIds))
      .input("queryText", sql.NVarChar(500), queryText.substring(0, 500))
      .input("sqlQuery", sql.NVarChar(sql.MAX), sqlQuery)
      .input("tokensUsed", sql.Int, tokensUsed)
      .input("cost", sql.Decimal(18, 4), cost)
      .input("processingTimeMs", sql.Int, processingTimeMs)
      .input("actualTokens", sql.Int, actualTokens)
      .input("estimatedTokens", sql.Int, estimatedTokens)
      .input("actualCost", sql.Decimal(18, 4), actualCost)
      .input(
        "cost_estimated",
        sql.Decimal(18, 4),
        (estimatedTokens / 1000000) * 0.28,
      )
      .input("token_accuracy_percent", sql.Int, accuracy)
      .query(`INSERT INTO customer_usage
              (customer_id, company_ids, query_text, sql_query, tokens_used, cost, processing_time_ms,
              tokens_used_actual, tokens_used_estimated, cost_actual, cost_estimated, token_accuracy_percent)
              VALUES (@customerId, @companyIds, @queryText, @sqlQuery, @tokensUsed, @cost, @processingTimeMs,
              @actualTokens, @estimatedTokens, @actualCost, @cost_estimated, @token_accuracy_percent)`);

    // Update monthly usage
    await registry
      .request()
      .input("tokensUsed", sql.Int, tokensUsed)
      .input("actualTokens", sql.Int, actualTokens)
      .input("customerId", sql.VarChar, customerId)
      .query(`UPDATE customer_api_keys
              SET used_this_month = used_this_month + @tokensUsed,
              used_this_month_actual = used_this_month_actual + @actualTokens
              WHERE customer_id = @customerId`);

    logger.info(
      `Tracked usage for ${customerId}: ${actualTokens} tokens (${accuracy}% accurate), ₹${(actualCost * 85).toFixed(2)}`,
    );
  }

  /**
   * Check if customer has exceeded their limit
   */
  async checkCustomerLimit(customerId) {
    const registry = await this.connectRegistry();
    const usageResult = await registry
      .request()
      .input("customerId", sql.VarChar, customerId)
      .query(`SELECT monthly_limit, used_this_month
              FROM customer_api_keys
              WHERE customer_id = @customerId AND is_active = 0`);
    const rows = usageResult.recordset;

    if (rows.length === 0) return true;

    const { monthly_limit, used_this_month } = rows[0];

    // Check if need to reset monthly counter
    const resetResult = await registry
      .request()
      .input("customerId", sql.VarChar, customerId)
      .query(
        "SELECT last_reset_date FROM customer_api_keys WHERE customer_id = @customerId",
      );
    const resetCheck = resetResult.recordset;

    const lastReset = resetCheck[0]?.last_reset_date;
    const now = new Date();

    if (!lastReset || new Date(lastReset).getMonth() !== now.getMonth()) {
      // Reset monthly usage
      await registry.request().input("customerId", sql.VarChar, customerId)
        .query(`UPDATE customer_api_keys
                SET used_this_month = 0, last_reset_date = CAST(GETDATE() AS DATE)
                WHERE customer_id = @customerId`);
      return true;
    }

    return used_this_month < monthly_limit;
  }

  /**
   * Close all connections
   */
  async closeAllConnections() {
    for (const conn of this.customerMainConnections.values()) {
      await conn.close();
    }
    for (const conn of this.companyConnections.values()) {
      await conn.close();
    }
    if (this.registryPool) {
      await this.registryPool.close();
    }
    this.customerMainConnections.clear();
    this.companyConnections.clear();
    logger.info("All database connections closed");
  }

  /**
   * Customer purchases additional tokens (MSSQL version)
   */
  async purchaseTokens(customerId, paymentAmount, paymentCurrency = "USD") {
    const pool = await this.getCustomerMainDB(customerId);

    // Convert to USD
    let amountUSD = paymentAmount;
    if (paymentCurrency === "INR") {
      amountUSD = paymentAmount / 85;
    }

    // Calculate tokens ($0.35 per 1M tokens)
    const tokensPerDollar = 1000000 / 0.35;
    const newTokens = Math.floor(amountUSD * tokensPerDollar);

    // Set expiry date (6 months from now)
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + 6);
    const expiryDateStr = expiryDate.toISOString().split("T")[0];

    // Generate unique batch ID
    const batchId = `BATCH_${customerId}_${Date.now()}`;

    // Check for expired tokens first
    await this.handleExpiredTokens(customerId);

    // Create new token batch
    await pool
      .request()
      .input("customerId", sql.VarChar, customerId)
      .input("batchId", sql.VarChar, batchId)
      .input("tokensAllocated", sql.Int, newTokens)
      .input("tokensRemaining", sql.Int, newTokens)
      .input("purchaseAmount", sql.Decimal(10, 2), amountUSD)
      .input("expiryDate", sql.Date, expiryDateStr).query(`
            INSERT INTO token_batches 
            (customer_id, batch_id, tokens_allocated, tokens_remaining, 
             purchase_amount, expiry_date, status)
            VALUES (@customerId, @batchId, @tokensAllocated, @tokensRemaining, 
                    @purchaseAmount, @expiryDate, 'active')
        `);

    // Update customer's total allocation
    await pool
      .request()
      .input("customerId", sql.VarChar, customerId)
      .input("newTokens", sql.Int, newTokens)
      .input("amountUSD", sql.Decimal(10, 2), amountUSD).query(`
            UPDATE customer_api_keys 
            SET allocated_tokens = ISNULL(allocated_tokens, 0) + @newTokens,
                tokens_remaining = ISNULL(tokens_remaining, 0) + @newTokens,
                total_tokens_purchased = ISNULL(total_tokens_purchased, 0) + @newTokens,
                payment_amount = ISNULL(payment_amount, 0) + @amountUSD
            WHERE customer_id = @customerId
        `);

    // Log transaction
    await pool
      .request()
      .input("customerId", sql.VarChar, customerId)
      .input("batchId", sql.VarChar, batchId)
      .input("newTokens", sql.Int, newTokens)
      .input(
        "description",
        sql.NVarChar,
        `Purchased ${newTokens.toLocaleString()} tokens for $${amountUSD}`,
      ).query(`
            INSERT INTO token_transactions 
            (customer_id, batch_id, transaction_type, tokens_amount, tokens_remaining_after, description)
            VALUES (@customerId, @batchId, 'purchase', @newTokens, @newTokens, @description)
        `);

    return {
      batch_id: batchId,
      tokens_purchased: newTokens,
      expiry_date: expiryDateStr,
    };
  }

  /**
   * Handle expired tokens (MSSQL version)
   */
  async handleExpiredTokens(customerId) {
    const pool = await this.getCustomerMainDB(customerId);
    const today = new Date().toISOString().split("T")[0];

    // Find expired batches
    const expiredResult = await pool
      .request()
      .input("customerId", sql.VarChar, customerId)
      .input("today", sql.Date, today).query(`
            SELECT batch_id, tokens_remaining 
            FROM token_batches 
            WHERE customer_id = @customerId 
              AND expiry_date < @today 
              AND status = 'active'
        `);

    const expiredBatches = expiredResult.recordset;
    let expiredTokens = 0;

    for (const batch of expiredBatches) {
      expiredTokens += batch.tokens_remaining;

      // Mark batch as expired
      await pool.request().input("batchId", sql.VarChar, batch.batch_id).query(`
                UPDATE token_batches 
                SET status = 'expired' 
                WHERE batch_id = @batchId
            `);

      // Log expiry
      await pool
        .request()
        .input("customerId", sql.VarChar, customerId)
        .input("batchId", sql.VarChar, batch.batch_id)
        .input("tokensRemaining", sql.Int, batch.tokens_remaining).query(`
                INSERT INTO token_transactions 
                (customer_id, batch_id, transaction_type, tokens_amount, description)
                VALUES (@customerId, @batchId, 'expiry', @tokensRemaining, 
                        'Expired ' + CAST(@tokensRemaining AS VARCHAR) + ' tokens')
            `);
    }

    if (expiredTokens > 0) {
      // Deduct expired tokens from remaining balance
      await pool
        .request()
        .input("customerId", sql.VarChar, customerId)
        .input("expiredTokens", sql.Int, expiredTokens).query(`
                UPDATE customer_api_keys 
                SET tokens_remaining = ISNULL(tokens_remaining, 0) - @expiredTokens,
                    expired_tokens = ISNULL(expired_tokens, 0) + @expiredTokens
                WHERE customer_id = @customerId
            `);

      logger.info(`Expired ${expiredTokens} tokens for customer ${customerId}`);
    }

    return expiredTokens;
  }

  /**
   * Use tokens (FIFO - oldest batch first) MSSQL version
   */
  async useTokens(customerId, tokensToUse) {
    const pool = await this.getCustomerMainDB(customerId);

    // Get active batches ordered by purchase date (oldest first)
    const batchesResult = await pool
      .request()
      .input("customerId", sql.VarChar, customerId).query(`
            SELECT batch_id, tokens_remaining, expiry_date
            FROM token_batches 
            WHERE customer_id = @customerId 
              AND status = 'active'
              AND tokens_remaining > 0
            ORDER BY purchase_date ASC
        `);

    const batches = batchesResult.recordset;
    let remainingToUse = tokensToUse;
    let totalUsed = 0;

    for (const batch of batches) {
      if (remainingToUse <= 0) break;

      const deductAmount = Math.min(batch.tokens_remaining, remainingToUse);

      // Update batch
      await pool
        .request()
        .input("batchId", sql.VarChar, batch.batch_id)
        .input("deductAmount", sql.Int, deductAmount).query(`
                UPDATE token_batches 
                SET tokens_remaining = tokens_remaining - @deductAmount
                WHERE batch_id = @batchId
            `);

      // Update batch status if depleted
      const newRemaining = batch.tokens_remaining - deductAmount;
      if (newRemaining === 0) {
        await pool.request().input("batchId", sql.VarChar, batch.batch_id)
          .query(`
                    UPDATE token_batches 
                    SET status = 'depleted' 
                    WHERE batch_id = @batchId
                `);
      }

      totalUsed += deductAmount;
      remainingToUse -= deductAmount;
    }

    // Update customer's total remaining
    await pool
      .request()
      .input("customerId", sql.VarChar, customerId)
      .input("totalUsed", sql.Int, totalUsed).query(`
            UPDATE customer_api_keys 
            SET tokens_remaining = ISNULL(tokens_remaining, 0) - @totalUsed,
                total_tokens_used = ISNULL(total_tokens_used, 0) + @totalUsed
            WHERE customer_id = @customerId
        `);

    // Log usage
    await pool
      .request()
      .input("customerId", sql.VarChar, customerId)
      .input("totalUsed", sql.Int, totalUsed).query(`
            INSERT INTO token_transactions 
            (customer_id, transaction_type, tokens_amount, description)
            VALUES (@customerId, 'usage', @totalUsed, 
                    'Used ' + CAST(@totalUsed AS VARCHAR) + ' tokens for API calls')
        `);

    return { success: true, used: totalUsed };
  }

  /**
   * Get customer token balance with batch details (MSSQL)
   */
  async getTokenBalance(customerId) {
    const pool = await this.getCustomerMainDB(customerId);

    // First, handle any expired tokens
    await this.handleExpiredTokens(customerId);

    // Get summary
    const summaryResult = await pool
      .request()
      .input("customerId", sql.VarChar, customerId).query(`
            SELECT 
                ISNULL(allocated_tokens, 0) as total_purchased,
                ISNULL(tokens_remaining, 0) as remaining,
                ISNULL(total_tokens_used, 0) as used,
                ISNULL(payment_amount, 0) as total_spent,
                ISNULL(expired_tokens, 0) as expired
            FROM customer_api_keys 
            WHERE customer_id = @customerId
        `);

    // Get batch details
    const batchesResult = await pool
      .request()
      .input("customerId", sql.VarChar, customerId).query(`
            SELECT 
                batch_id,
                purchase_date,
                tokens_allocated,
                tokens_remaining,
                expiry_date,
                status,
                DATEDIFF(day, GETDATE(), expiry_date) as days_until_expiry
            FROM token_batches 
            WHERE customer_id = @customerId 
              AND status IN ('active', 'depleted')
            ORDER BY purchase_date DESC
        `);

    // Get recent transactions
    const transactionsResult = await pool
      .request()
      .input("customerId", sql.VarChar, customerId).query(`
            SELECT TOP 20
                transaction_type,
                tokens_amount,
                description,
                created_at
            FROM token_transactions 
            WHERE customer_id = @customerId
            ORDER BY created_at DESC
        `);

    const summary = summaryResult.recordset[0] || {};
    const batches = batchesResult.recordset;
    const transactions = transactionsResult.recordset;

    // Calculate daily average usage (last 30 days)
    const usageResult = await pool
      .request()
      .input("customerId", sql.VarChar, customerId).query(`
            SELECT 
                ISNULL(AVG(daily_usage), 0) as avg_daily_usage
            FROM (
                SELECT 
                    CAST(created_at AS DATE) as usage_date,
                    SUM(tokens_amount) as daily_usage
                FROM token_transactions 
                WHERE customer_id = @customerId 
                  AND transaction_type = 'usage'
                  AND created_at >= DATEADD(day, -30, GETDATE())
                GROUP BY CAST(created_at AS DATE)
            ) as daily
        `);

    const avgDailyUsage = usageResult.recordset[0]?.avg_daily_usage || 0;
    const estimatedDaysRemaining =
      avgDailyUsage > 0 ? Math.floor(summary.remaining / avgDailyUsage) : 0;

    return {
      summary: {
        total_purchased: summary.total_purchased || 0,
        used: summary.used || 0,
        remaining: summary.remaining || 0,
        expired: summary.expired || 0,
        total_spent: summary.total_spent || 0,
        estimated_days_remaining: estimatedDaysRemaining,
        daily_average_usage: Math.round(avgDailyUsage),
      },
      batches: batches,
      recent_transactions: transactions,
    };
  }
}

module.exports = new DatabaseRouter();
