const crypto = require("crypto");
const sql = require("mssql");
const dbRouter = require("../config/database-router");

class ChatService {
  constructor() {
    this.pool = null;
  }

  async getPool() {
    if (!this.pool) {
      this.pool = await dbRouter.connectRegistry();
    }

    return this.pool;
  }

  buildSessionTitle(title) {
    const trimmed = String(title || "").trim();
    if (!trimmed) {
      return `Chat ${new Date().toLocaleString()}`;
    }

    return trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed;
  }

  serializeChartConfig(chartConfig) {
    if (!chartConfig) {
      return null;
    }

    const serialized = JSON.stringify(chartConfig);
    return serialized.length > 1000 ? serialized.slice(0, 1000) : serialized;
  }

  async createSession(customerId, title = null) {
    const pool = await this.getPool();
    const sessionId = crypto.randomUUID();
    const sessionTitle = this.buildSessionTitle(title);

    await pool
      .request()
      .input("sessionId", sql.VarChar(100), sessionId)
      .input("customerId", sql.VarChar(100), customerId)
      .input("sessionTitle", sql.NVarChar(500), sessionTitle).query(`
        INSERT INTO chat_sessions (
          session_id,
          customer_id,
          session_title,
          created_at,
          updated_at,
          is_active,
          total_messages,
          total_tokens_used
        )
        VALUES (
          @sessionId,
          @customerId,
          @sessionTitle,
          GETDATE(),
          GETDATE(),
          1,
          0,
          0
        )
      `);

    return { session_id: sessionId, session_title: sessionTitle };
  }

  async getSessions(customerId, limit = 50, offset = 0) {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("customerId", sql.VarChar(100), customerId)
      .input("offset", sql.Int, Math.max(0, offset))
      .input("limit", sql.Int, Math.max(1, limit)).query(`
        SELECT
          session_id,
          session_title,
          created_at,
          updated_at,
          is_active,
          total_messages,
          total_tokens_used
        FROM chat_sessions
        WHERE customer_id = @customerId
        ORDER BY updated_at DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    return result.recordset;
  }

  async getSession(sessionId, customerId) {
    const pool = await this.getPool();

    const sessionResult = await pool
      .request()
      .input("sessionId", sql.VarChar(100), sessionId)
      .input("customerId", sql.VarChar(100), customerId).query(`
        SELECT
          session_id,
          session_title,
          created_at,
          updated_at,
          total_messages,
          total_tokens_used
        FROM chat_sessions
        WHERE session_id = @sessionId
          AND customer_id = @customerId
      `);

    if (sessionResult.recordset.length === 0) {
      return null;
    }

    const messagesResult = await pool
      .request()
      .input("sessionId", sql.VarChar(100), sessionId)
      .input("customerId", sql.VarChar(100), customerId).query(`
        SELECT
          id,
          session_id,
          customer_id,
          message_type,
          content,
          sql_query,
          data_json,
          insights,
          chart_config,
          tokens_used,
          processing_time_ms,
          created_at,
          parent_message_id
        FROM chat_messages
        WHERE session_id = @sessionId
          AND customer_id = @customerId
        ORDER BY created_at ASC, id ASC
      `);

    return {
      session: sessionResult.recordset[0],
      messages: messagesResult.recordset,
    };
  }

  async saveMessage(
    sessionId,
    customerId,
    messageType,
    content,
    metadata = {},
  ) {
    const pool = await this.getPool();

    await pool
      .request()
      .input("sessionId", sql.VarChar(100), sessionId)
      .input("customerId", sql.VarChar(100), customerId)
      .input("messageType", sql.VarChar(20), messageType)
      .input("content", sql.NVarChar(sql.MAX), content || null)
      .input("sqlQuery", sql.NVarChar(sql.MAX), metadata.sqlQuery || null)
      .input(
        "dataJson",
        sql.NVarChar(sql.MAX),
        metadata.dataJson ? JSON.stringify(metadata.dataJson) : null,
      )
      .input("insights", sql.NVarChar(sql.MAX), metadata.insights || null)
      .input(
        "chartConfig",
        sql.NVarChar(1000),
        this.serializeChartConfig(metadata.chartConfig),
      )
      .input("tokensUsed", sql.Int, metadata.tokensUsed || 0)
      .input("processingTimeMs", sql.Int, metadata.processingTime || 0)
      .input(
        "parentMessageId",
        sql.Int,
        metadata.parentMessageId
          ? Number.parseInt(metadata.parentMessageId, 10)
          : null,
      ).query(`
        INSERT INTO chat_messages (
          session_id,
          customer_id,
          message_type,
          content,
          sql_query,
          data_json,
          insights,
          chart_config,
          tokens_used,
          processing_time_ms,
          created_at,
          parent_message_id
        )
        VALUES (
          @sessionId,
          @customerId,
          @messageType,
          @content,
          @sqlQuery,
          @dataJson,
          @insights,
          @chartConfig,
          @tokensUsed,
          @processingTimeMs,
          GETDATE(),
          @parentMessageId
        )
      `);

    await pool
      .request()
      .input("sessionId", sql.VarChar(100), sessionId)
      .input("customerId", sql.VarChar(100), customerId)
      .input("tokensUsed", sql.Int, metadata.tokensUsed || 0).query(`
        UPDATE chat_sessions
        SET
          updated_at = GETDATE(),
          total_messages = total_messages + 1,
          total_tokens_used = total_tokens_used + @tokensUsed
        WHERE session_id = @sessionId
          AND customer_id = @customerId
      `);
  }

  async updateSessionTitle(sessionId, customerId, title) {
    const pool = await this.getPool();
    await pool
      .request()
      .input("sessionId", sql.VarChar(100), sessionId)
      .input("customerId", sql.VarChar(100), customerId)
      .input("title", sql.NVarChar(500), this.buildSessionTitle(title)).query(`
        UPDATE chat_sessions
        SET
          session_title = @title,
          updated_at = GETDATE()
        WHERE session_id = @sessionId
          AND customer_id = @customerId
      `);
  }

  async deleteSession(sessionId, customerId) {
    const pool = await this.getPool();
    await pool
      .request()
      .input("sessionId", sql.VarChar(100), sessionId)
      .input("customerId", sql.VarChar(100), customerId).query(`
        UPDATE chat_sessions
        SET
          is_active = 0,
          updated_at = GETDATE()
        WHERE session_id = @sessionId
          AND customer_id = @customerId
      `);
  }

  async clearAllSessions(customerId) {
    const pool = await this.getPool();
    await pool.request().input("customerId", sql.VarChar(100), customerId)
      .query(`
        UPDATE chat_sessions
        SET
          is_active = 0,
          updated_at = GETDATE()
        WHERE customer_id = @customerId
      `);
  }

  async searchMessages(customerId, searchTerm, limit = 50) {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("customerId", sql.VarChar(100), customerId)
      .input("searchTerm", sql.NVarChar(500), `%${searchTerm}%`)
      .input("limit", sql.Int, Math.max(1, limit)).query(`
        SELECT
          cm.session_id,
          cs.session_title,
          cm.message_type,
          cm.content,
          cm.created_at,
          cm.tokens_used
        FROM chat_messages cm
        INNER JOIN chat_sessions cs
          ON cm.session_id = cs.session_id
         AND cm.customer_id = cs.customer_id
        WHERE cm.customer_id = @customerId
          AND cm.content LIKE @searchTerm
        ORDER BY cm.created_at DESC
        OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY
      `);

    return result.recordset;
  }

  async getChatStats(customerId) {
    const pool = await this.getPool();
    const result = await pool
      .request()
      .input("customerId", sql.VarChar(100), customerId).query(`
        SELECT
          COUNT(DISTINCT session_id) as total_sessions,
          ISNULL(SUM(total_messages), 0) as total_messages,
          ISNULL(SUM(total_tokens_used), 0) as total_tokens_used,
          ISNULL(AVG(CAST(total_messages AS FLOAT)), 0) as avg_messages_per_session,
          MAX(updated_at) as last_chat_date
        FROM chat_sessions
        WHERE customer_id = @customerId
      `);

    return result.recordset[0];
  }
}

module.exports = new ChatService();
