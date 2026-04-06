// src/services/metadataService.js
// ... (previous code remains the same until the getFullSchemaForAI method)

/**
 * Get full database schema formatted for AI prompts.
 * @returns {string} Formatted schema text
 */

const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

/**
 * MetadataService loads and provides access to database schema information,
 * field mappings, synonyms, and business logic for AI-powered SQL generation.
 */
class MetadataService {
  constructor() {
    // Path to metadata JSON file (adjust if needed)
    this.metadataPath = path.join(
      __dirname,
      "../../config/database-metadata.json",
    );
    this.metadata = null;
    this.cachedSchemaText = null;

    // Indexes for quick lookups
    this.tableMap = new Map(); // table_name -> table object
    this.fieldMap = new Map(); // table.field -> {table, field}
    this.synonymMap = new Map(); // synonym -> array of {table, field}

    this.loadMetadata();
  }

  /**
   * Load metadata from JSON file and build indexes.
   */
  loadMetadata() {
    try {
      const rawData = fs.readFileSync(this.metadataPath, "utf8");
      this.metadata = JSON.parse(rawData);
      this.cachedSchemaText = null;
      logger.info("Metadata loaded successfully");
      this.buildIndexes();
    } catch (error) {
      logger.error(`Failed to load metadata: ${error.message}`);
      // Fallback to empty metadata to prevent crashes
      this.metadata = { tables: [] };
    }
  }

  /**
   * Build lookup maps for fast access.
   */
  buildIndexes() {
    this.tableMap.clear();
    this.fieldMap.clear();
    this.synonymMap.clear();

    if (!this.metadata.tables) return;

    this.metadata.tables.forEach((table) => {
      // Table map: by technical name and display name
      this.tableMap.set(table.table_name, table);
      if (table.display_name) {
        this.tableMap.set(table.display_name.toLowerCase(), table);
      }

      // Field maps
      table.fields.forEach((field) => {
        const fieldKey = `${table.table_name}.${field.field_name}`;
        this.fieldMap.set(fieldKey, { table, field });

        // Index synonyms
        if (field.synonyms && Array.isArray(field.synonyms)) {
          field.synonyms.forEach((synonym) => {
            const lowerSyn = synonym.toLowerCase();
            if (!this.synonymMap.has(lowerSyn)) {
              this.synonymMap.set(lowerSyn, []);
            }
            this.synonymMap.get(lowerSyn).push({ table, field });
          });
        }
      });
    });

    logger.info(
      `Indexed ${this.tableMap.size} tables, ${this.fieldMap.size} fields, ${this.synonymMap.size} synonyms`,
    );
  }

  /**
   * Get full database schema formatted for AI prompts.
   * @returns {string} Formatted schema text
   */
  getFullSchemaForAI() {
    if (this.cachedSchemaText) {
      return this.cachedSchemaText;
    }

    if (!this.metadata.tables || this.metadata.tables.length === 0) {
      return "No database schema available.";
    }

    let schemaText = "DATABASE SCHEMA WITH BUSINESS MAPPINGS:\n\n";

    this.metadata.tables.forEach((table) => {
      schemaText += `\n📊 TABLE: ${table.table_name}`;
      if (table.display_name) schemaText += ` (${table.display_name})`;
      schemaText += `\n   Description: ${table.description || "No description"}\n`;
      if (table.primary_key)
        schemaText += `   Primary Key: ${table.primary_key}\n`;
      if (table.date_field)
        schemaText += `   Date Field: ${table.date_field}\n`;

      // Include default filter if present
      if (table.default_filter) {
        schemaText += `   🔍 IMPORTANT: For sales queries, always apply filter: ${table.default_filter}\n`;
      }

      schemaText += `\n   FIELDS:\n`;

      table.fields.forEach((field) => {
        schemaText += `   • ${field.field_name}`;
        if (field.display_name) schemaText += ` → "${field.display_name}"`;
        schemaText += `\n`;
        schemaText += `     Type: ${field.data_type}\n`;
        schemaText += `     Description: ${field.description || "No description"}\n`;
        if (field.business_meaning) {
          schemaText += `     Business Meaning: ${field.business_meaning}\n`;
        }
        if (field.synonyms && field.synonyms.length > 0) {
          schemaText += `     Synonyms: ${field.synonyms.join(", ")}\n`;
        }
        if (field.aggregations && field.aggregations.length > 0) {
          schemaText += `     Can be Aggregated: ${field.aggregations.join(", ")}\n`;
        }
        if (field.references) {
          schemaText += `     Foreign Key: References ${field.references.table}.${field.references.field}\n`;
        }
        if (field.filter_value) {
          schemaText += `     Default Filter Value: ${field.filter_value} (use in WHERE clause for sales data)\n`;
        }
        if (field.sample_values && field.sample_values.length > 0) {
          schemaText += `     Sample Values: ${field.sample_values.join(", ")}\n`;
        }
        schemaText += `\n`;
      });

      if (table.joins && table.joins.length > 0) {
        schemaText += "   COMMON JOINS:\n";
        table.joins.forEach((join) => {
          schemaText += `   • JOIN ${join.join_table} ON ${join.condition}\n`;
          if (join.description)
            schemaText += `     Purpose: ${join.description}\n`;
        });
        schemaText += `\n`;
      }
    });

    this.cachedSchemaText = schemaText;
    return this.cachedSchemaText;
  }

  /**
   * Get all table names.
   * @returns {string[]}
   */
  getAllTables() {
    return this.metadata.tables.map((t) => t.table_name);
  }

  /**
   * Get full metadata for a specific table.
   * @param {string} tableName - Technical or display name
   * @returns {object|null}
   */
  getTableInfo(tableName) {
    const key = tableName.toLowerCase();
    return this.tableMap.get(key) || null;
  }

  /**
   * Get field information for a given table and field.
   * @param {string} tableName
   * @param {string} fieldName
   * @returns {object|null}
   */
  getFieldInfo(tableName, fieldName) {
    const key = `${tableName}.${fieldName}`;
    const entry = this.fieldMap.get(key);
    return entry ? entry.field : null;
  }

  /**
   * Find fields that match a business term (using synonyms).
   * @param {string} term - Business term (e.g., "customer", "sales")
   * @returns {Array} Array of {table, field} objects
   */
  getFieldForBusinessTerm(term) {
    const lowerTerm = term.toLowerCase();
    return this.synonymMap.get(lowerTerm) || [];
  }

  /**
   * Extract all business terms from a user query and map them to fields.
   * @param {string} query - User's natural language query
   * @returns {Array} Array of mapped terms with table and field details
   */
  extractBusinessTerms(query) {
    const lowerQuery = query.toLowerCase();
    const matchedTerms = [];

    this.synonymMap.forEach((mappings, synonym) => {
      // Check if synonym appears as a whole word (simple approach)
      // For better accuracy, use regex with word boundaries
      const regex = new RegExp(`\\b${synonym}\\b`, "i");
      if (regex.test(lowerQuery)) {
        // Add each mapping (there might be multiple fields for same synonym)
        mappings.forEach((mapping) => {
          matchedTerms.push({
            term: synonym,
            table: mapping.table.table_name,
            field: mapping.field.field_name,
            displayName: mapping.field.display_name,
            description: mapping.field.description,
          });
        });
      }
    });

    // Deduplicate by (table, field)
    const unique = [];
    const seen = new Set();
    for (const term of matchedTerms) {
      const key = `${term.table}.${term.field}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(term);
      }
    }
    return unique;
  }

  /**
   * Generate a complete AI prompt including schema, query, and instructions.
   * @param {string} userQuery - User's natural language question
   * @param {string} intent - Optional detected intent (e.g., 'top_customers')
   * @returns {string} Prompt for DeepSeek
   */
  generateAIPrompt(userQuery, intent = null) {
    const schema = this.getFullSchemaForAI();

    let prompt = `
You are a SQL expert for a sales ERP system. Convert the user's natural language question into an accurate MSSQL query.

${schema}

USER QUESTION: "${userQuery}"

RULES:
1. Use ONLY the tables and fields defined in the schema above.
2. When a business term appears, map it to the corresponding database field using the synonyms provided.
3. Use proper JOINs based on the relationships defined in the schema.
4. Add meaningful column aliases (e.g., CustomerName, TotalSales).
5. Include appropriate WHERE clauses for date ranges if mentioned.
6. For ranking queries (e.g., "top 10 customers"), use TOP with ORDER BY.
7. For aggregation queries, use GROUP BY with appropriate fields.
8. Return ONLY the SQL query, no explanations or markdown formatting.
`;

    if (
      intent &&
      this.metadata.predefined_queries &&
      this.metadata.predefined_queries[intent]
    ) {
      prompt += `\nREFERENCE PATTERN (you can adapt this):\n${this.metadata.predefined_queries[intent].sql}\n\n`;
    }

    prompt += `SQL QUERY:`;

    return prompt;
  }

  /**
   * Get the default filter for a table (if defined).
   * @param {string} tableName - Technical name of the table
   * @returns {string|null} Default filter string or null
   */
  getDefaultFilter(tableName) {
    const table = this.getTableInfo(tableName);
    return table?.default_filter || null;
  }

  /**
   * Validate that a set of fields exist in the schema.
   * @param {string} tableName
   * @param {string[]} fieldNames
   * @returns {boolean}
   */
  validateFields(tableName, fieldNames) {
    const table = this.getTableInfo(tableName);
    if (!table) return false;
    const validFieldNames = table.fields.map((f) => f.field_name);
    return fieldNames.every((field) => validFieldNames.includes(field));
  }

  /**
   * Get join condition between two tables.
   * @param {string} fromTable - Starting table
   * @param {string} toTable - Table to join
   * @returns {string|null} Join condition or null if not defined
   */
  getJoinCondition(fromTable, toTable) {
    const table = this.getTableInfo(fromTable);
    if (!table || !table.joins) return null;
    const join = table.joins.find((j) => j.join_table === toTable);
    return join ? join.condition : null;
  }

  /**
   * Generate a SQL template for common query patterns.
   * @param {string} intent - One of 'top_customers', 'monthly_comparison', etc.
   * @param {object} params - Replacement parameters
   * @returns {string|null}
   */
  generateSQLTemplate(intent, params = {}) {
    // Use predefined queries if available, else return null
    if (
      this.metadata.predefined_queries &&
      this.metadata.predefined_queries[intent]
    ) {
      let sql = this.metadata.predefined_queries[intent].sql;
      // Replace parameters
      for (const [key, value] of Object.entries(params)) {
        sql = sql.replace(new RegExp(`{${key}}`, "g"), value);
      }
      return sql;
    }

    // Fallback to built-in templates (optional)
    const templates = {
      top_customers: `
                SELECT TOP {limit}
                    c.{customer_name_field} AS Customer,
                    SUM(s.{amount_field}) AS TotalSales
                FROM {order_table} s
                INNER JOIN {customer_table} c ON s.{customer_join_field} = c.{customer_key}
                {where_clause}
                GROUP BY c.{customer_name_field}
                ORDER BY TotalSales DESC
            `,
      monthly_comparison: `
                SELECT
                    YEAR(s.{date_field}) AS Year,
                    MONTH(s.{date_field}) AS Month,
                    SUM(s.{amount_field}) AS TotalSales,
                    COUNT(*) AS OrderCount
                FROM {order_table} s
                {where_clause}
                GROUP BY YEAR(s.{date_field}), MONTH(s.{date_field})
                ORDER BY Year DESC, Month DESC
            `,
    };

    if (!templates[intent]) return null;

    // Apply default mappings (can be overridden by params)
    const defaultMappings = {
      order_table: "sales_order",
      customer_table: "customer_master",
      amount_field: "total_amount",
      customer_name_field: "cust_name",
      customer_join_field: "cust_code",
      customer_key: "cust_code",
      date_field: "so_date",
      limit: 10,
    };

    const merged = { ...defaultMappings, ...params };
    let sql = templates[intent];
    for (const [key, value] of Object.entries(merged)) {
      sql = sql.replace(new RegExp(`{${key}}`, "g"), value);
    }
    if (params.where_clause) {
      sql = sql.replace("{where_clause}", `WHERE ${params.where_clause}`);
    } else {
      sql = sql.replace("{where_clause}", "");
    }
    return sql;
  }
}

module.exports = MetadataService;
