const axios = require("axios");
const logger = require("../utils/logger");

class DeepSeekService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.apiUrl =
      process.env.DEEPSEEK_API_URL ||
      "https://api.deepseek.com/v1/chat/completions";
    this.sqlTimeout = this.parseTimeout(
      process.env.DEEPSEEK_SQL_TIMEOUT_MS,
      30000,
    );
    this.insightsTimeout = this.parseTimeout(
      process.env.DEEPSEEK_INSIGHTS_TIMEOUT_MS,
      30000,
    );
  }

  parseTimeout(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  async callDeepSeek(prompt, temperature = 0.7, maxTokens = 1000, timeoutMs) {
    try {
      logger.debug(`Calling DeepSeek API with prompt length: ${prompt.length}`);

      const response = await axios.post(
        this.apiUrl,
        {
          model: "deepseek-chat",
          messages: [
            {
              role: "system",
              content:
                "You are a SQL expert and sales analytics assistant. Generate accurate, efficient SQL queries and provide insightful analysis.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: temperature,
          max_tokens: maxTokens,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: timeoutMs || this.sqlTimeout,
        },
      );

      const result = response.data.choices[0].message.content;
      logger.debug(`DeepSeek API response received, length: ${result.length}`);

      return result;
    } catch (error) {
      logger.error(`DeepSeek API error: ${error.message}`);
      if (error.response) {
        logger.error(`API Response: ${JSON.stringify(error.response.data)}`);
      }
      throw new Error(`Failed to get response from AI: ${error.message}`);
    }
  }

  async generateSQL(userQuery, metadata) {
    const prompt = `
You are a SQL expert for a sales ERP system.

DATABASE METADATA:
${metadata}

USER QUERY: "${userQuery}"

INSTRUCTIONS:
1. Generate ONLY the SQL query, no explanations
2. Use MSSQL syntax
3. Use the exact table and field names from the metadata
4. Add meaningful column aliases
5. Include appropriate JOINs based on relationships
6. For ranking queries, use TOP with ORDER BY
7. For aggregation, use GROUP BY correctly
8. Ensure the query is safe and optimized
9. Always include a TOP 100 clause unless the user explicitly asks for a different number.
10. IMPORTANT: Only include the billdata table (line items) in JOINs if the query explicitly asks for item-level details such as product names, quantities, rates, or line totals. For summary queries (e.g., total sales by customer, monthly sales, state-wise summary), use only the billmast table. Do not add unnecessary joins.
11. IMPORTANT: In billmast, the real physical columns are serial and srchr. Names like billno, returnno, returnchr, serialno, or bill chr are display captions or aliases only. Never reference those as database columns. Use serial and srchr in SQL, and only alias them in SELECT if needed.


SQL QUERY:
`;

    const sqlQuery = await this.callDeepSeek(
      prompt,
      0.1,
      1000,
      this.sqlTimeout,
    );

    // Clean up the response (remove markdown code blocks)
    let cleanedQuery = sqlQuery
      .replace(/```sql\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    return cleanedQuery;
  }

  async generateInsights(userQuery, sqlQuery, results) {
    const sampleResults = this.buildInsightSample(results);

    // Add currency instruction at the beginning of prompt
    const prompt = `
**CRITICAL CURRENCY INSTRUCTION:**
- This is an INDIAN business application
- ALL monetary values are in INDIAN RUPEES (₹, INR)
- NEVER use $ (dollar) symbol or USD
- ALWAYS use ₹ (rupee) symbol or "Rs."
- Format large numbers with Indian comma system: ₹1,00,000 (not 100,000)
- Use Indian numbering: Lakh (1,00,000), Crore (1,00,00,000)
- Examples: ₹25,000, ₹1.5 Lakh, ₹10 Lakh, ₹1 Crore

Based on the following sales data analysis:

Original Question: "${userQuery}"
SQL Query Executed: ${sqlQuery}
Results Sample: ${JSON.stringify(sampleResults, null, 2)}
Total Rows: ${results.length}

Provide a professional business analysis with:
1. Key Findings (3-5 bullet points) - Use ₹ for all currency values
2. Important Metrics and Trends - Show amounts in ₹ with Indian formatting
3. Actionable Recommendations
4. Any Notable Anomalies or Opportunities

Format with clear sections and bullet points for easy reading.
`;

    try {
      let response = await this.callDeepSeek(
        prompt,
        0.7,
        500,
        this.insightsTimeout,
      );

      // Post-process to ensure no $ symbols remain
      response = this.formatCurrencyToINR(response);

      return response;
    } catch (error) {
      logger.warn(`Insights call retrying after failure: ${error.message}`);
      let response = await this.callDeepSeek(
        prompt,
        0.7,
        500,
        this.insightsTimeout,
      );

      // Post-process for retry as well
      response = this.formatCurrencyToINR(response);

      return response;
    }
  }

  /**
   * Format currency from $ to ₹ in the response text
   */
  formatCurrencyToINR(text) {
    if (!text) return text;

    let formatted = text;

    // Replace $ symbol with ₹
    formatted = formatted.replace(/\$/g, "₹");

    // Replace USD with INR
    formatted = formatted.replace(/USD/gi, "INR");

    // Replace "dollars" with "rupees"
    formatted = formatted.replace(/dollars?/gi, "rupees");

    // Convert Western number format to Indian format (optional)
    // Matches patterns like 23.5M, 6.2M, etc.
    formatted = formatted.replace(/(\d+(?:\.\d+)?)\s*M/gi, (match, num) => {
      const value = parseFloat(num) * 1000000;
      return this.formatIndianNumber(value);
    });

    // Matches patterns like $1,234,567 or 1,234,567
    formatted = formatted.replace(
      /(\d{1,3}(?:,\d{3})+(?:\.\d+)?)/g,
      (match) => {
        const num = parseFloat(match.replace(/,/g, ""));
        if (isNaN(num)) return match;
        return this.formatIndianNumber(num);
      },
    );

    return formatted;
  }

  /**
   * Convert number to Indian format (e.g., 1,00,000 instead of 100,000)
   */
  formatIndianNumber(num) {
    if (isNaN(num)) return num;

    const numStr = Math.floor(num).toString();
    const lastThree = numStr.slice(-3);
    const otherNumbers = numStr.slice(0, -3);

    let formatted;
    if (otherNumbers !== "") {
      formatted =
        otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + lastThree;
    } else {
      formatted = lastThree;
    }

    // Add decimal if exists
    const decimal = (num % 1).toFixed(2).slice(1);
    if (decimal !== ".00") {
      formatted += decimal;
    }

    return `₹${formatted}`;
  }

  buildInsightSample(results) {
    return results.slice(0, 10).map((row) => {
      const entries = Object.entries(row).slice(0, 8);
      return Object.fromEntries(entries);
    });
  }
}

module.exports = DeepSeekService;
