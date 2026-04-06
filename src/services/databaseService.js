const { getConnection, sql } = require("../config/database");
const logger = require("../utils/logger");

class DatabaseService {
  async executeQuery(query) {
    let connection = null;
    try {
      // Check if this is a data modification query
      const isModification = /^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(
        query.trim(),
      );

      connection = await getConnection();
      logger.debug(`Executing query: ${query}`);

      const result = await connection.request().query(query);

      if (isModification) {
        // Invalidate relevant cache
        await CacheService.invalidatePattern("*");
        logger.info("🔄 Cache invalidated due to data modification");
      }

      logger.debug(
        `Query executed successfully,rows returned: ${result.recordset.length}`,
      );
      return result.recordset;
    } catch (error) {
      logger.error("Failed to execute query", error);
      logger.error(`Failed Query : ${query}`);
      throw error;
    } finally {
      //   if (connection) {
      //     await connection.close();
      //     logger.debug("Database connection closed");
      //   }
    }
  }

  async validateQuery(query) {
    const dangerousKeywords = [
      "DROP",
      "DELETE",
      "UPDATE",
      "INSERT",
      "TRUNCATE",
      "ALTER",
      "CREATE",
      "GRANT",
      "REVOKE",
      "DROP",
      "MERGE",
      "ALTER",
      "EXEC",
      "DROP",
      "DROP TABLE",
      "DROP DATABASE",
      "DROP SCHEMA",
      "DROP VIEW",
      "DROP INDEX",
      "DROP TRIGGER",
      "DROP PROCEDURE",
      "DROP FUNCTION",
      "DROP TRIGGER",
      "DROP TRIGGER",
      "DROP TRIGGER",
      "EXE",
      "EXECUTE",
    ];
    try {
      const upperQuery = query.toUpperCase();

      for (const keyword of dangerousKeywords) {
        if (upperQuery.includes(keyword)) {
          logger.warn(
            `Query Validation Failed : Dangerous keyword ${keyword} found in query`,
          );
          throw new Error(`Dangerous keyword ${keyword} found in query`);
        }
      }
      return true;
    } catch (error) {
      logger.error("Failed to validate query", error);
      throw error;
    }
  }
  async testConnection() {
    try {
      const result = await this.executeQuery("SELECT GetDate() as CurrentTime");
      return {
        success: true,
        timestamp: result[0].CurrentTime,
        message: "Database connection successful",
      };
    } catch (error) {
      logger.error("Failed to test database connection", error);
      return {
        success: false,
        timestamp: null,
        message: "Database connection failed",
      };
    }
  }
}
module.exports = DatabaseService;
