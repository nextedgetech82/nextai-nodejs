const express = require("express");
const router = express.Router();
const dbRouter = require("../config/database-router");
const crypto = require("crypto");

// Generate API key for customer
function generateApiKey() {
  return `ak_${crypto.randomBytes(24).toString("hex")}`;
}

// Onboard new customer
router.post("/onboard", async (req, res) => {
  const {
    customer_id,
    customer_name,
    customer_code,
    subscription_plan,
    main_db_host,
    main_db_port,
    main_db_name,
    main_db_user,
    main_db_password,
  } = req.body;

  const registry = await dbRouter.connectRegistry();

  try {
    // Check if customer already exists
    const [existing] = await registry.execute(
      "SELECT customer_id FROM customers WHERE customer_id = ?",
      [customer_id],
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: "Customer ID already exists" });
    }

    // Register customer
    await registry.execute(
      `INSERT INTO customers 
             (customer_id, customer_name, customer_code, subscription_plan,
              main_db_host, main_db_port, main_db_name, main_db_user, main_db_password) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customer_id,
        customer_name,
        customer_code,
        subscription_plan,
        main_db_host,
        main_db_port || 1433,
        main_db_name,
        main_db_user,
        main_db_password,
      ],
    );

    // Generate and store API key
    const apiKey = generateApiKey();
    const monthlyLimit =
      subscription_plan === "enterprise"
        ? 500000
        : subscription_plan === "professional"
          ? 200000
          : 50000;

    await registry.execute(
      `INSERT INTO customer_api_keys (customer_id, api_key, monthly_limit) 
             VALUES (?, ?, ?)`,
      [customer_id, apiKey, monthlyLimit],
    );

    res.json({
      success: true,
      customer_id: customer_id,
      api_key: apiKey,
      message: "Customer onboarded successfully",
    });
  } catch (error) {
    console.error("Onboarding error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get all customers
router.get("/customers", async (req, res) => {
  const registry = await dbRouter.connectRegistry();
  const [rows] = await registry.execute(
    "SELECT customer_id, customer_name, customer_code, subscription_plan, status, created_at FROM customers",
  );
  res.json({ customers: rows });
});

// Update customer status
router.put("/customers/:customerId/status", async (req, res) => {
  const { customerId } = req.params;
  const { status } = req.body;

  const registry = await dbRouter.connectRegistry();
  await registry.execute(
    "UPDATE customers SET status = ? WHERE customer_id = ?",
    [status, customerId],
  );

  res.json({ success: true });
});

module.exports = router;
