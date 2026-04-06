const sql = require("mssql");
const logger = require("../utils/logger");

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_HOST,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT) || 1433,
  options: {
    encrypt: process.env.DB_ENCRYPT === "true",
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === "true",
    enableArithAbort: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let pool = null;

async function getConnection() {
  try {
    if (pool) {
      return pool;
    }

    logger.info("Connecting to MSSQL database...");
    pool = await sql.connect(config);
    logger.info("Database connected successfully");

    return pool;
  } catch (err) {
    logger.error(`Database connection failed: ${err.message}`);
    throw err;
  }
}

async function closeConnection() {
  if (pool) {
    await pool.close();
    logger.info("Database connection closed");
  }
}

module.exports = {
  getConnection,
  closeConnection,
  sql,
};
