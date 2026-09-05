// services/cacheService.js
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX    = 100;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  if (cache.size >= CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

// Used after a write (a committed fix) makes a cached analysis stale. Storing
// null would work but would leave a dead entry holding a slot in the LRU.
function invalidateCached(key) {
  return cache.delete(key);
}

function getCacheSize() {
  return cache.size;
}

module.exports = { getCached, setCached, invalidateCached, getCacheSize, CACHE_TTL_MS, CACHE_MAX };