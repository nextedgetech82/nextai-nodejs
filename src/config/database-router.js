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
}

module.exports = new DatabaseRouter();
