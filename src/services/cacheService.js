const redisClient = require("../../config/redis");
const logger = require("../utils/logger");
const crypto = require("crypto");

class CacheService {
  constructor() {
    this.defaultTTL = 3600; // 1 hour in seconds
    this.redis = null;
    this.initialize();
  }

  async initialize() {
    await redisClient.connect();
    this.redis = redisClient.getClient();
  }

  /**
   * Generate cache key from query and parameters
   */
  generateKey(query, parameters = {}) {
    const keyData = JSON.stringify({
      query: query.toLowerCase().trim(),
      ...parameters,
    });
    return `analytics:${crypto.createHash("md5").update(keyData).digest("hex")}`;
  }

  /**
   * Get cached data
   */
  async get(key) {
    if (!this.redis || !redisClient.isReady()) {
      return null;
    }

    try {
      const cached = await this.redis.get(key);
      if (cached) {
        logger.info(`✅ Cache hit for key: ${key}`);
        return JSON.parse(cached);
      }
      logger.info(`❌ Cache miss for key: ${key}`);
      return null;
    } catch (error) {
      logger.error(`Cache get error: ${error.message}`);
      return null;
    }
  }

  /**
   * Set cache with TTL
   */
  async set(key, data, ttl = this.defaultTTL) {
    if (!this.redis || !redisClient.isReady()) {
      return false;
    }

    try {
      await this.redis.setex(key, ttl, JSON.stringify(data));
      logger.info(`💾 Cached data for key: ${key} (TTL: ${ttl}s)`);
      return true;
    } catch (error) {
      logger.error(`Cache set error: ${error.message}`);
      return false;
    }
  }

  /**
   * Smart caching with configurable TTL based on data type
   */
  async smartSet(key, data, queryType = "general") {
    let ttl = this.defaultTTL;

    // Different TTL based on query type
    switch (queryType) {
      case "summary":
        ttl = 3600; // 1 hour - summary data
        break;
      case "trend":
        ttl = 7200; // 2 hours - trend data
        break;
      case "real-time":
        ttl = 300; // 5 minutes - real-time queries
        break;
      case "static":
        ttl = 86400; // 24 hours - static data (e.g., top customers)
        break;
      default:
        ttl = 3600;
    }

    return await this.set(key, data, ttl);
  }

  /**
   * Invalidate cache by pattern
   */
  async invalidatePattern(pattern) {
    if (!this.redis || !redisClient.isReady()) {
      return false;
    }

    try {
      const keys = await this.redis.keys(`analytics:${pattern}*`);
      if (keys.length > 0) {
        await this.redis.del(keys);
        logger.info(
          `🗑️ Invalidated ${keys.length} cache keys matching pattern: ${pattern}`,
        );
      }
      return true;
    } catch (error) {
      logger.error(`Cache invalidation error: ${error.message}`);
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    if (!this.redis || !redisClient.isReady()) {
      return { status: "disconnected" };
    }

    try {
      const keys = await this.redis.keys("analytics:*");
      return {
        status: "connected",
        totalKeys: keys.length,
        memory: await this.redis.info("memory"),
        hitRate: "calculated from logs",
      };
    } catch (error) {
      return { status: "error", message: error.message };
    }
  }
}

module.exports = new CacheService();
