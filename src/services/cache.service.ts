export class CacheService {
  private cache = new Map<string, { data: any; timestamp: number }>();
  private defaultTTL = 3600000; // 1 hour in milliseconds

  /**
   * Set cache item
   */
  set(key: string, data: any, ttl: number = this.defaultTTL): void {
    this.cache.set(key, {
      data: data,
      timestamp: Date.now() + ttl,
    });
  }

  /**
   * Get cache item
   */
  get(key: string): any | null {
    const item = this.cache.get(key);

    if (!item) return null;

    // Check if expired
    if (Date.now() > item.timestamp) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Remove specific cache item
   */
  remove(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }
}
