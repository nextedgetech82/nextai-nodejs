//Multi Company
const axios = require("axios");
const sql = require("mssql");
const logger = require("../utils/logger");
const dbRouter = require("../config/database-router");

class MultiCustomerDeepSeekService {
  constructor() {
    this.apiUrl = "https://api.deepseek.com/v1/chat/completions";
  }

  async callDeepSeek(apiKey, prompt, temperature = 0.7, maxTokens = 1000) {
    const response = await axios.post(
      this.apiUrl,
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "You are a SQL expert for MSSQL databases.",
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
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    //return response.data.choices[0].message.content;
    // Return both content AND usage data
    return {
      content: response.data.choices[0].message.content,
      usage: response.data.usage, // ← This contains actual token counts
      cost: {
        input: (response.data.usage.prompt_tokens / 1000000) * 0.28,
        output: (response.data.usage.completion_tokens / 1000000) * 0.42,
        total: (response.data.usage.total_tokens / 1000000) * 0.28,
      },
    };
  }

  async getCustomerApiKey(customerId) {
    const registry = await dbRouter.connectRegistry();
    const result = await registry
      .request()
      .input("customerId", sql.VarChar, customerId).query(`SELECT api_key
              FROM customer_api_keys
              WHERE customer_id = @customerId AND is_active = 0`);
    const rows = result.recordset;

    if (rows.length === 0) {
      throw new Error(
        `No customer-specific API key configured for ${customerId}`,
      );
    }

    return rows[0].api_key;
  }

  async generateSQL(customerId, userQuery, metadata) {
    const apiKey = await this.getCustomerApiKey(customerId);

    const accountingInstruction = `
**ACCOUNTING VOUCHER HANDLING RULES:**

The accvchrmst table stores all accounting transactions:

**RECEIPTS (Money In):**
- 'BR' = Bank Receipt (Cheque, RTGS, NEFT, UPI, IMPS)
- 'CR' = Cash Receipt (Physical cash received)

**PAYMENTS (Money Out):**
- 'BP' = Bank Payment (Cheque, RTGS, NEFT, UPI, IMPS)
- 'CP' = Cash Payment (Physical cash paid)

**ADJUSTMENTS:**
- 'DR' = Debit Note (Customer owes us more)
- 'CRN' = Credit Note (We owe customer more)
- 'JV' = Journal Voucher (Transfer entries)
- 'QR' = Cheque Return (Bounced cheque)

**Voucher Type (vchrtype):**
- 'advance' = Advance receipt/payment (before bill)
- 'against bill' = Bill-to-bill settlement

**Voucher On (von) for Debit/Credit Notes:**
- 'SALE' = Sales side (customer transactions)
- 'PURCHASE' = Purchase side (vendor transactions)

**When generating SQL for accounting queries:**

1. **Receipts**: code IN ('BR', 'CR')
2. **Bank Receipts**: code = 'BR'
3. **Cash Receipts**: code = 'CR'
4. **Payments**: code IN ('BP', 'CP')
5. **Bank Payments**: code = 'BP'
6. **Cash Payments**: code = 'CP'
7. **Debit Notes**: code = 'DR'
8. **Credit Notes**: code = 'CRN'
9. **Journal Entries**: code = 'JV'
10. **Cheque Returns**: code = 'QR'
11. **Advance Receipts**: code IN ('BR', 'CR') AND vchrtype = 'advance'
12. **Bill-to-Bill Payments**: code IN ('BP', 'CP') AND vchrtype = 'against bill'
13. **Cash Flow**: Receipts (BR, CR) - Payments (BP, CP)
14. **Outstanding**: Sales (S) - Receipts (BR, CR) + Debit Notes (DR) - Credit Notes (CRN)
`;
    // Enhanced instruction for handling sales vs returns
    const billTypeInstruction = `
**BILL TYPE HANDLING RULES:**

The billmast table has a 'code' field that determines bill type:
- 'S' = Sales Bill (regular customer purchases)
- 'SR' = Sales Return (customer returns, credit notes)

When generating SQL queries:

1. **If user asks about "sales", "revenue", "sold" :**
   Add WHERE code = 'S'

2. **If user asks about "returns", "sales return", "credit notes", "returned items":**
   Add WHERE code = 'SR'

3. **If user asks for "net sales" or "sales after returns":**
   Use: SUM(CASE WHEN code = 'S' THEN netamt ELSE 0 END) - SUM(CASE WHEN code = 'SR' THEN netamt ELSE 0 END)

4. **If user asks for "return rate" or "return percentage":**
   Compare quantities/amounts between code='S' and code='SR'

5. **If user asks for "top returned items":**
   Use WHERE code = 'SR' and group by itemname

6. **If user doesn't specify bill type but asks generic "transactions":**
   Include both types, but clearly label them

7. **If user asks about "purchase", "purchase", "purchase bill" :**
   Add WHERE code = 'P'

8. **If user asks about "purchase return", "purchase return", "purchase return bill" :**
   Add WHERE code = 'PR'

9. **If user asks about "jobwork bill" :**
   Add WHERE code = 'FJ'

10. **If user asks for "net purchase" or "purchase after returns":**
   Use: SUM(CASE WHEN code = 'P' THEN netamt ELSE 0 END) - SUM(CASE WHEN code = 'PR' THEN netamt ELSE 0 END)

11. **If user asks for "purchase return rate" or "purchase return percentage":**
   Compare quantities/amounts between code='P' and code='PR'

12. **If user asks for "top purchase returned items":**
   Use WHERE code = 'PR' and group by itemname

13. **now Sharing List Of Code With Description which data stored in Billmast and billdata tables
    "S" For "Sale Bill", "Sale Invoice"
    "SR" For "Sale Return", "Sales Return Bill", "Sale Return Bill"
    "P" For "Ready Purchase Bill", "Purchase Bill", "Finish Purchase", "Finish Purchase Bill"
    "PR" For "Ready Purchase Return Bill", "Purchase Return Bill", "Finish Purchase Return", "Finish Purchase Return Bill"
    "FJ" For "Jobwork Bill", "Jobwork Invoice", "Finish Jobwork", "Finish Jobwork Bill"
    "FJR" For "Jobwork Return Bill", "Jobwork Return Invoice", "Finish Jobwork Return", "Finish Jobwork Return Bill"
    "G" For "Grey Bill", "Grey Purchase", "Grey Purchase Bill"
    "GR" For "Grey Return", "Grey Purchase Return", "Grey Purchase Return Bill"
    "MR" For "Mill Receive", "Mill Receive Bill", "Mill GP"
    "OP" For "General Purchase Bill", "Other Purchas Bill", "Expense Bill"
    "OR" For "General Purchase Return Bill", "Other Purchase Return Bill", "Expense Return Bill"
    "OS" For "General Sale Bill", "Rent Sale", "Rent Sale Bill" 
14. **Always Show Month Name not month number and Month Name Of First 3 Character With Last 2 Digit Of Year 
Example queries:
- "Show top 10 items sold" → code = 'S'
- "Show top 10 items returned" → code = 'SR'
- "Show net sales by month" → SUM(code='S') - SUM(code='SR')
15. **Column reality check for billmast**:
    The real physical columns are always serial and srchr.
    Terms like billno, returnno, returnchr, serialno, and bill chr are only captions or aliases.
    NEVER generate SQL using fake columns such as returnchr or returnno.
    For sales return or purchase return queries, still use serial and srchr in SQL and alias them only in SELECT if needed.
`;

    const prompt = `
You are a SQL expert for a sales ERP system.

CUSTOMER: ${customerId}

${billTypeInstruction}

${accountingInstruction}

DATABASE SCHEMA:
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
11. IMPORTANT: In billmast, serial and srchr are the actual database columns. Names like returnno, returnchr, billno, serialno, and bill chr are aliases only and must never be used as physical column names in SQL.

SQL QUERY:
`;

    try {
      const result = await this.callDeepSeek(apiKey, prompt, 0.1, 1000);
      let sqlQuery = result.content;
      sqlQuery = sqlQuery
        .replace(/```sql\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();

      return sqlQuery;

      //return sqlQuery;
    } catch (error) {
      logger.error(
        `DeepSeek API error for customer ${customerId}: ${error.message}`,
      );
      throw new Error(`AI service error: ${error.message}`);
    }
  }

  async generateInsights(customerId, userQuery, sqlQuery, results) {
    const apiKey = await this.getCustomerApiKey(customerId);

    const prompt = `
**CRITICAL: All currency values are in INDIAN RUPEES (₹). Use ₹ symbol, never $.**
- This is an INDIAN business application
- ALL monetary values are in INDIAN RUPEES (₹, INR)
- NEVER use $ (dollar) symbol or USD
- ALWAYS use ₹ (rupee) symbol or "Rs."
- Format large numbers with Indian comma system: ₹1,00,000 (not 100,000)
- Use Indian numbering: Lakh (1,00,000), Crore (1,00,00,000)
- Examples: ₹25,000, ₹1.5 Lakh, ₹10 Lakh, ₹1 Crore


Based on the following sales data analysis for customer ${customerId}:

Original Question: "${userQuery}"
SQL Query Executed: ${sqlQuery}
Results Sample: ${JSON.stringify(results.slice(0, 20), null, 2)}
Total Rows: ${results.length}

Provide a professional business analysis with:
1. Key Findings (3-5 bullet points) - Use ₹ for all currency
2. Important Metrics and Trends
3. Actionable Recommendations
4. Any Notable Anomalies or Opportunities

Format with clear sections and bullet points for easy reading.
`;

    try {
      const response = await axios.post(
        this.apiUrl,
        {
          model: "deepseek-chat",
          messages: [
            {
              role: "system",
              content:
                "You are a sales analytics expert. All currency is in Indian Rupees (₹).",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.7,
          max_tokens: 800,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );

      let insights = response.data.choices[0].message.content;
      insights = insights.replace(/\$/g, "₹").replace(/USD/gi, "INR");

      //return insights;
      // Return both insights AND usage data
      return {
        insights: insights,
        usage: response.data.usage,
        cost: {
          input: (response.data.usage.prompt_tokens / 1000000) * 0.28,
          output: (response.data.usage.completion_tokens / 1000000) * 0.42,
          total: (response.data.usage.total_tokens / 1000000) * 0.28,
        },
      };
    } catch (error) {
      logger.error(
        `Insights error for customer ${customerId}: ${error.message}`,
      );
      return {
        insights: "Unable to generate insights at this time.",
        usage: null,
        cost: null,
      };
    }
  }

  /**
   * Analyze data and recommend the best chart type
   */
  async recommendChartType(customerId, userQuery, sqlQuery, results) {
    const sampleData = results.slice(0, 20);

    const prompt = `
You are a data visualization expert. Analyze the following data and recommend the best chart type.

USER QUERY: "${userQuery}"
SQL QUERY: ${sqlQuery}

DATA SAMPLE (first 20 rows):
${JSON.stringify(sampleData, null, 2)}

TOTAL ROWS: ${results.length}

Based on the data structure and user intent, recommend the most appropriate chart type.

**CHART OPTIONS:**
- **bar**: For comparing categories (e.g., top customers, sales by region)
- **line**: For trends over time (e.g., monthly sales, growth patterns)
- **pie**: For showing proportions/percentages (e.g., market share, category distribution)
- **horizontalBar**: For comparing categories with long labels
- **doughnut**: Similar to pie but with hole in center
- **radar**: For comparing multiple metrics across categories
- **scatter**: For showing correlations between two variables
- **table**: When chart doesn't make sense (raw data display)

**CONSIDERATIONS:**
1. Number of data points (pie works best with ≤ 7 categories)
2. Data type (time series → line, categories → bar)
3. User intent (comparison, trend, composition, distribution)
4. Data structure (single metric per category → bar/pie, multiple metrics → bar group)

Return a JSON object with:
{
    "chartType": "bar|line|pie|horizontalBar|doughnut|radar|scatter|table",
    "title": "Suggested chart title",
    "xAxis": "Field name for X-axis/categories",
    "yAxis": "Field name for Y-axis/values",
    "explanation": "Why this chart type is recommended",
    "options": {
        "isStacked": false,
        "showLegend": true,
        "tooltipFormat": "currency|number|percentage"
    }
}

    Return ONLY the JSON object, no other text.
  `;

    try {
      const apiKey = await this.getCustomerApiKey(customerId);
      const response = await this.callDeepSeek(apiKey, prompt, 0.3, 500);
      const responseText = response.content;
      // Parse JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const chartConfig = JSON.parse(jsonMatch[0]);
        //return chartConfig;
        // Return chart config WITH usage data
        return {
          chartConfig: chartConfig,
          usage: response.usage,
          cost: response.cost,
        };
      }
      //return this.getDefaultChartConfig(results);
      const defaultConfig = this.getDefaultChartConfig(results);
      return {
        chartConfig: defaultConfig,
        usage: null,
        cost: null,
      };
    } catch (error) {
      logger.error(`Chart recommendation failed: ${error.message}`);
      //return this.getDefaultChartConfig(results);
      return {
        chartConfig: this.getDefaultChartConfig(results),
        usage: null,
        cost: null,
      };
    }
  }

  /**
   * Fallback chart recommendation based on data structure
   */
  getDefaultChartConfig(results) {
    if (!results || results.length === 0) {
      return { chartType: "table", explanation: "No data available" };
    }

    const firstRow = results[0];
    const fields = Object.keys(firstRow);

    // Find numeric fields for values
    const numericFields = fields.filter((f) => typeof firstRow[f] === "number");
    const stringFields = fields.filter((f) => typeof firstRow[f] === "string");

    // Detect if it's time series data
    const hasDateField = fields.some(
      (f) =>
        f.toLowerCase().includes("date") ||
        f.toLowerCase().includes("month") ||
        f.toLowerCase().includes("year"),
    );

    // Detect if it's category data
    const hasCategoryField = stringFields.length > 0;

    if (hasDateField && numericFields.length > 0) {
      return {
        chartType: "line",
        title: "Trend Analysis",
        xAxis:
          fields.find(
            (f) =>
              f.toLowerCase().includes("date") ||
              f.toLowerCase().includes("month"),
          ) || fields[0],
        yAxis: numericFields[0],
        explanation: "Line chart recommended for time-based trends",
        options: { showLegend: true, tooltipFormat: "number" },
      };
    } else if (hasCategoryField && numericFields.length > 0) {
      if (results.length <= 7) {
        return {
          chartType: "pie",
          title: "Distribution Analysis",
          xAxis: stringFields[0],
          yAxis: numericFields[0],
          explanation:
            "Pie chart recommended for proportion analysis with limited categories",
          options: { showLegend: true, tooltipFormat: "percentage" },
        };
      } else {
        return {
          chartType: "bar",
          title: "Category Comparison",
          xAxis: stringFields[0],
          yAxis: numericFields[0],
          explanation:
            "Bar chart recommended for comparing multiple categories",
          options: { showLegend: true, tooltipFormat: "number" },
        };
      }
    }

    return {
      chartType: "table",
      title: "Data View",
      xAxis: null,
      yAxis: null,
      explanation: "Table view recommended for this data structure",
      options: {},
    };
  }
}

module.exports = MultiCustomerDeepSeekService;
