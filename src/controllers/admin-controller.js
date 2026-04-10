const sql = require("mssql");
const crypto = require("crypto");
const dbRouter = require("../config/database-router");

class AdminController {
  getHome = async (req, res, next) => {
    try {
      res.render("home", { title: "Admin Dashboard" });
    } catch (error) {
      next(error);
    }
  };

  getCustomers = async (req, res, next) => {
    try {
      const registry = await dbRouter.connectRegistry();
      const result = await registry.query(`SELECT
          customer_id,
          customer_name,
          customer_code,
          subscription_plan,
          status,
          created_at,
          updated_at,
          main_db_type,
          main_db_host,
          main_db_port,
          main_db_name,
          main_db_user,
          main_db_encrypt
        FROM customers
        ORDER BY created_at DESC, customer_name ASC`);

      res.render("customers/index", {
        title: "Customers",
        customers: result.recordset,
        toast: this.getToastFromRequest(req),
      });
    } catch (error) {
      next(error);
    }
  };

  getNewCustomer = async (req, res, next) => {
    try {
      res.render("customers/form", {
        title: "Add Customer",
        mode: "create",
        customer: this.getDefaultCustomer(),
        toast: this.getToastFromRequest(req),
      });
    } catch (error) {
      next(error);
    }
  };

  createCustomer = async (req, res, next) => {
    try {
      const customer = this.normalizeCustomerPayload(req.body);
      const registry = await dbRouter.connectRegistry();

      await registry
        .request()
        .input("customer_id", sql.VarChar(100), customer.customer_id)
        .input("customer_name", sql.VarChar(200), customer.customer_name)
        .input("customer_code", sql.VarChar(50), customer.customer_code)
        .input("subscription_plan", sql.VarChar(10), customer.subscription_plan)
        .input("status", sql.VarChar(10), customer.status)
        .input("main_db_type", sql.VarChar(10), customer.main_db_type)
        .input("main_db_host", sql.VarChar(200), customer.main_db_host)
        .input("main_db_port", sql.Int, customer.main_db_port)
        .input("main_db_name", sql.VarChar(200), customer.main_db_name)
        .input("main_db_user", sql.VarChar(100), customer.main_db_user)
        .input("main_db_password", sql.VarChar(200), customer.main_db_password)
        .input("main_db_encrypt", sql.Bit, customer.main_db_encrypt)
        .query(`INSERT INTO customers (
            customer_id,
            customer_name,
            customer_code,
            subscription_plan,
            status,
            created_at,
            updated_at,
            main_db_type,
            main_db_host,
            main_db_port,
            main_db_name,
            main_db_user,
            main_db_password,
            main_db_encrypt
          ) VALUES (
            @customer_id,
            @customer_name,
            @customer_code,
            @subscription_plan,
            @status,
            GETDATE(),
            GETDATE(),
            @main_db_type,
            @main_db_host,
            @main_db_port,
            @main_db_name,
            @main_db_user,
            @main_db_password,
            @main_db_encrypt
          )`);

      res.redirect(
        this.withToast("/admin/customers", "Customer saved successfully."),
      );
    } catch (error) {
      next(error);
    }
  };

  getEditCustomer = async (req, res, next) => {
    try {
      const registry = await dbRouter.connectRegistry();
      const result = await registry
        .request()
        .input("customerId", sql.VarChar(100), req.params.customerId)
        .query("SELECT * FROM customers WHERE customer_id = @customerId");

      if (result.recordset.length === 0) {
        return res.status(404).render("error", {
          title: "Customer Not Found",
          message: "The requested customer does not exist.",
        });
      }

      res.render("customers/form", {
        title: "Edit Customer",
        mode: "edit",
        customer: result.recordset[0],
        toast: this.getToastFromRequest(req),
      });
    } catch (error) {
      next(error);
    }
  };

  updateCustomer = async (req, res, next) => {
    try {
      const customerId = req.params.customerId;
      const customer = this.normalizeCustomerPayload(req.body, true);
      const registry = await dbRouter.connectRegistry();

      await registry
        .request()
        .input("customerId", sql.VarChar(100), customerId)
        .input("customer_name", sql.VarChar(200), customer.customer_name)
        .input("customer_code", sql.VarChar(50), customer.customer_code)
        .input("subscription_plan", sql.VarChar(10), customer.subscription_plan)
        .input("status", sql.VarChar(10), customer.status)
        .input("main_db_type", sql.VarChar(10), customer.main_db_type)
        .input("main_db_host", sql.VarChar(200), customer.main_db_host)
        .input("main_db_port", sql.Int, customer.main_db_port)
        .input("main_db_name", sql.VarChar(200), customer.main_db_name)
        .input("main_db_user", sql.VarChar(100), customer.main_db_user)
        .input("main_db_password", sql.VarChar(200), customer.main_db_password)
        .input("main_db_encrypt", sql.Bit, customer.main_db_encrypt)
        .query(`UPDATE customers SET
            customer_name = @customer_name,
            customer_code = @customer_code,
            subscription_plan = @subscription_plan,
            status = @status,
            updated_at = GETDATE(),
            main_db_type = @main_db_type,
            main_db_host = @main_db_host,
            main_db_port = @main_db_port,
            main_db_name = @main_db_name,
            main_db_user = @main_db_user,
            main_db_password = @main_db_password,
            main_db_encrypt = @main_db_encrypt
          WHERE customer_id = @customerId`);

      res.redirect(
        this.withToast("/admin/customers", "Customer updated successfully."),
      );
    } catch (error) {
      next(error);
    }
  };

  deleteCustomer = async (req, res, next) => {
    try {
      const registry = await dbRouter.connectRegistry();
      await registry
        .request()
        .input("customerId", sql.VarChar(100), req.params.customerId)
        .query("DELETE FROM customers WHERE customer_id = @customerId");

      res.redirect(
        this.withToast("/admin/customers", "Customer deleted successfully."),
      );
    } catch (error) {
      next(error);
    }
  };

  getCustomerTokens = async (req, res, next) => {
    try {
      const customerId = req.params.customerId;
      const registry = await dbRouter.connectRegistry();

      const [customerResult, apiKeyResult, batchesResult] = await Promise.all([
        registry
          .request()
          .input("customerId", sql.VarChar(100), customerId)
          .query("SELECT * FROM customers WHERE customer_id = @customerId"),
        registry
          .request()
          .input("customerId", sql.VarChar(100), customerId)
          .query(
            "SELECT TOP 1 * FROM customer_api_keys WHERE customer_id = @customerId ORDER BY id DESC",
          ),
        registry.request().input("customerId", sql.VarChar(100), customerId)
          .query(`SELECT
              id,
              customer_id,
              batch_id,
              tokens_allocated,
              tokens_remaining,
              purchase_amount,
              purchase_date,
              expiry_date,
              status
            FROM token_batches
            WHERE customer_id = @customerId
            ORDER BY purchase_date DESC, id DESC`),
      ]);

      if (customerResult.recordset.length === 0) {
        return res.status(404).render("error", {
          title: "Customer Not Found",
          message: "The requested customer does not exist.",
        });
      }

      res.render("customers/tokens", {
        title: "Customer Tokens",
        customer: customerResult.recordset[0],
        apiKeyRow:
          apiKeyResult.recordset[0] || this.getDefaultApiKeyConfig(customerId),
        batches: batchesResult.recordset,
        editingBatchId: req.query.editBatchId || "",
        toast: this.getToastFromRequest(req),
      });
    } catch (error) {
      next(error);
    }
  };

  saveCustomerApiKey = async (req, res, next) => {
    try {
      const customerId = req.params.customerId;
      const payload = this.normalizeApiKeyPayload(req.body, customerId);
      const registry = await dbRouter.connectRegistry();

      await registry
        .request()
        .input("customerId", sql.VarChar(100), customerId)
        .input("api_key", sql.VarChar(500), payload.api_key)
        .input("api_provider", sql.VarChar(50), payload.api_provider)
        .input("monthly_limit", sql.Int, payload.monthly_limit)
        .input("daily_limit", sql.Int, payload.daily_limit)
        .input("is_active", sql.Bit, payload.is_active)
        .query(`IF EXISTS (SELECT 1 FROM customer_api_keys WHERE customer_id = @customerId)
                BEGIN
                  UPDATE customer_api_keys
                  SET api_key = @api_key,
                      api_provider = @api_provider,
                      monthly_limit = @monthly_limit,
                      daily_limit = @daily_limit,
                      is_active = @is_active
                  WHERE customer_id = @customerId
                END
                ELSE
                BEGIN
                  INSERT INTO customer_api_keys (
                    customer_id,
                    api_key,
                    api_provider,
                    monthly_limit,
                    daily_limit,
                    used_this_month,
                    used_daily,
                    is_active,
                    used_this_month_actual,
                    allocated_tokens,
                    tokens_remaining,
                    total_tokens_purchased,
                    total_tokens_used,
                    expired_tokens,
                    payment_amount
                  ) VALUES (
                    @customerId,
                    @api_key,
                    @api_provider,
                    @monthly_limit,
                    @daily_limit,
                    0,
                    0,
                    @is_active,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0
                  )
                END`);

      await this.syncCustomerTokenSummary(customerId, registry);
      res.redirect(
        this.withToast(
          `/admin/customers/${customerId}/tokens`,
          "API key configuration saved successfully.",
        ),
      );
    } catch (error) {
      next(error);
    }
  };

  saveTokenBatch = async (req, res, next) => {
    try {
      const customerId = req.params.customerId;
      const batch = this.normalizeBatchPayload(req.body, customerId);
      const registry = await dbRouter.connectRegistry();

      if (batch.id) {
        await registry
          .request()
          .input("id", sql.Int, batch.id)
          .input("customerId", sql.VarChar(100), customerId)
          .input("batch_id", sql.VarChar(50), batch.batch_id)
          .input("tokens_allocated", sql.Int, batch.tokens_allocated)
          .input("tokens_remaining", sql.Int, batch.tokens_remaining)
          .input("purchase_amount", sql.Decimal(10, 2), batch.purchase_amount)
          .input("purchase_date", sql.DateTime, batch.purchase_date)
          .input("expiry_date", sql.Date, batch.expiry_date)
          .input("status", sql.VarChar(20), batch.status)
          .query(`UPDATE token_batches
                  SET batch_id = @batch_id,
                      tokens_allocated = @tokens_allocated,
                      tokens_remaining = @tokens_remaining,
                      purchase_amount = @purchase_amount,
                      purchase_date = @purchase_date,
                      expiry_date = @expiry_date,
                      status = @status
                  WHERE id = @id AND customer_id = @customerId`);
      } else {
        await registry
          .request()
          .input("customerId", sql.VarChar(100), customerId)
          .input("batch_id", sql.VarChar(50), batch.batch_id)
          .input("tokens_allocated", sql.Int, batch.tokens_allocated)
          .input("tokens_remaining", sql.Int, batch.tokens_remaining)
          .input("purchase_amount", sql.Decimal(10, 2), batch.purchase_amount)
          .input("purchase_date", sql.DateTime, batch.purchase_date)
          .input("expiry_date", sql.Date, batch.expiry_date)
          .input("status", sql.VarChar(20), batch.status)
          .query(`INSERT INTO token_batches (
                    customer_id,
                    batch_id,
                    tokens_allocated,
                    tokens_remaining,
                    purchase_amount,
                    purchase_date,
                    expiry_date,
                    status
                  ) VALUES (
                    @customerId,
                    @batch_id,
                    @tokens_allocated,
                    @tokens_remaining,
                    @purchase_amount,
                    @purchase_date,
                    @expiry_date,
                    @status
                  )`);
      }

      await this.syncCustomerTokenSummary(customerId, registry);
      res.redirect(
        this.withToast(
          `/admin/customers/${customerId}/tokens`,
          batch.id
            ? "Token batch updated successfully."
            : "Token batch added successfully.",
        ),
      );
    } catch (error) {
      next(error);
    }
  };

  deleteTokenBatch = async (req, res, next) => {
    try {
      const customerId = req.params.customerId;
      const registry = await dbRouter.connectRegistry();

      await registry
        .request()
        .input("id", sql.Int, Number.parseInt(req.params.batchId, 10))
        .input("customerId", sql.VarChar(100), customerId)
        .query(
          "DELETE FROM token_batches WHERE id = @id AND customer_id = @customerId",
        );

      await this.syncCustomerTokenSummary(customerId, registry);
      res.redirect(
        this.withToast(
          `/admin/customers/${customerId}/tokens`,
          "Token batch deleted successfully.",
        ),
      );
    } catch (error) {
      next(error);
    }
  };

  normalizeCustomerPayload(body, isEdit = false) {
    return {
      customer_id: isEdit ? null : String(body.customer_id || "").trim(),
      customer_name: String(body.customer_name || "").trim(),
      customer_code: this.nullableTrim(body.customer_code),
      subscription_plan: this.nullableTrim(body.subscription_plan),
      status: this.nullableTrim(body.status) || "active",
      main_db_type: this.nullableTrim(body.main_db_type) || "mssql",
      main_db_host: String(body.main_db_host || "").trim(),
      main_db_port: Number.parseInt(body.main_db_port, 10) || 1433,
      main_db_name: String(body.main_db_name || "").trim(),
      main_db_user: String(body.main_db_user || "").trim(),
      main_db_password: String(body.main_db_password || "").trim(),
      main_db_encrypt:
        body.main_db_encrypt === "on" ||
        body.main_db_encrypt === "true" ||
        body.main_db_encrypt === true,
    };
  }

  nullableTrim(value) {
    const trimmed = String(value || "").trim();
    return trimmed === "" ? null : trimmed;
  }

  getDefaultCustomer() {
    return {
      customer_id: "",
      customer_name: "",
      customer_code: "",
      subscription_plan: "basic",
      status: "active",
      main_db_type: "mssql",
      main_db_host: "",
      main_db_port: 1433,
      main_db_name: "",
      main_db_user: "",
      main_db_password: "",
      main_db_encrypt: false,
    };
  }

  getDefaultApiKeyConfig(customerId) {
    return {
      customer_id: customerId,
      api_key: "",
      api_provider: "deepseek",
      monthly_limit: 100000,
      daily_limit: 0,
      is_active: true,
      used_daily: 0,
      used_this_month: 0,
      used_this_month_actual: 0,
      allocated_tokens: 0,
      tokens_remaining: 0,
      total_tokens_purchased: 0,
      total_tokens_used: 0,
      expired_tokens: 0,
      payment_amount: 0,
    };
  }

  normalizeApiKeyPayload(body, customerId) {
    const apiKey = String(body.api_key || "").trim();
    return {
      customer_id: customerId,
      api_key: apiKey || this.generateApiKey(),
      api_provider: this.nullableTrim(body.api_provider) || "deepseek",
      monthly_limit: Number.parseInt(body.monthly_limit, 10) || 100000,
      daily_limit: Number.parseInt(body.daily_limit, 10) || 0,
      is_active:
        body.is_active === "on" ||
        body.is_active === "true" ||
        body.is_active === true,
    };
  }

  normalizeBatchPayload(body, customerId) {
    const allocated = Number.parseInt(body.tokens_allocated, 10) || 0;
    const remaining = Number.parseInt(body.tokens_remaining, 10);
    const purchaseDate = body.purchase_date
      ? new Date(body.purchase_date)
      : new Date();
    const expiryDate = new Date(purchaseDate);
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);

    return {
      id: Number.parseInt(body.id, 10) || null,
      customer_id: customerId,
      batch_id:
        String(body.batch_id || "").trim() ||
        `BATCH_${customerId}_${Date.now()}`,
      tokens_allocated: allocated,
      tokens_remaining: Number.isNaN(remaining) ? allocated : remaining,
      purchase_amount: Number.parseFloat(body.purchase_amount) || 0,
      purchase_date: purchaseDate,
      expiry_date: expiryDate,
      status: this.nullableTrim(body.status) || "active",
    };
  }

  async syncCustomerTokenSummary(customerId, registry) {
    const aggregateResult = await registry
      .request()
      .input("customerId", sql.VarChar(100), customerId).query(`SELECT
                ISNULL(SUM(tokens_allocated), 0) as total_allocated,
                ISNULL(SUM(tokens_remaining), 0) as total_remaining,
                ISNULL(SUM(purchase_amount), 0) as total_paid,
                ISNULL(SUM(CASE WHEN status = 'expired' THEN tokens_remaining ELSE 0 END), 0) as expired_tokens
              FROM token_batches
              WHERE customer_id = @customerId`);

    const aggregate = aggregateResult.recordset[0] || {};
    const totalAllocated = aggregate.total_allocated || 0;
    const totalRemaining = aggregate.total_remaining || 0;
    const expiredTokens = aggregate.expired_tokens || 0;
    const totalUsed = Math.max(
      totalAllocated - totalRemaining - expiredTokens,
      0,
    );

    await registry
      .request()
      .input("customerId", sql.VarChar(100), customerId)
      .input("api_key", sql.VarChar(500), this.generateApiKey())
      .input("allocated_tokens", sql.Int, totalAllocated)
      .input("tokens_remaining", sql.Int, totalRemaining)
      .input("total_tokens_purchased", sql.Int, totalAllocated)
      .input("total_tokens_used", sql.Int, totalUsed)
      .input("expired_tokens", sql.Int, expiredTokens)
      .input("payment_amount", sql.Decimal(10, 2), aggregate.total_paid || 0)
      .query(`IF EXISTS (SELECT 1 FROM customer_api_keys WHERE customer_id = @customerId)
              BEGIN
                UPDATE customer_api_keys
                SET allocated_tokens = @allocated_tokens,
                    tokens_remaining = @tokens_remaining,
                    total_tokens_purchased = @total_tokens_purchased,
                    total_tokens_used = @total_tokens_used,
                    expired_tokens = @expired_tokens,
                    payment_amount = @payment_amount
                WHERE customer_id = @customerId
              END
              ELSE
              BEGIN
                INSERT INTO customer_api_keys (
                  customer_id,
                  api_key,
                  api_provider,
                  monthly_limit,
                  daily_limit,
                  used_this_month,
                  used_daily,
                  is_active,
                  used_this_month_actual,
                  allocated_tokens,
                  tokens_remaining,
                  total_tokens_purchased,
                  total_tokens_used,
                  expired_tokens,
                  payment_amount
                ) VALUES (
                  @customerId,
                  @api_key,
                  'deepseek',
                  100000,
                  0,
                  0,
                  0,
                  1,
                  0,
                  @allocated_tokens,
                  @tokens_remaining,
                  @total_tokens_purchased,
                  @total_tokens_used,
                  @expired_tokens,
                  @payment_amount
                )
              END`);
  }

  generateApiKey() {
    return `ak_${crypto.randomBytes(24).toString("hex")}`;
  }

  getToastFromRequest(req) {
    const message = this.nullableTrim(req.query.toast);
    if (!message) {
      return null;
    }

    return {
      message,
      type: this.nullableTrim(req.query.toastType) || "success",
    };
  }

  withToast(path, message, type = "success") {
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}toast=${encodeURIComponent(message)}&toastType=${encodeURIComponent(type)}`;
  }
}

module.exports = new AdminController();
