// Page-level attachment blob cache (ADR-0014): the same id is fetched once even across
// work-driven feed re-renders, with bounded LRU memory. Pure enough to test without a DOM.
export function createBlobUrlCache({
  load,
  createUrl = (blob) => URL.createObjectURL(blob),
  revokeUrl = (url) => URL.revokeObjectURL(url),
  limit = 32,
}) {
  const entries = new Map(); // id -> { promise, url, cancelled }

  function touch(id, entry) {
    entries.delete(id);
    entries.set(id, entry);
  }

  function evict() {
    while (entries.size > limit) {
      const [id, entry] = entries.entries().next().value;
      entries.delete(id);
      if (entry.url) {
        revokeUrl(entry.url);
      } else {
        entry.cancelled = true;
      }
    }
  }

  async function get(id) {
    const existing = entries.get(id);
    if (existing) {
      touch(id, existing);
      return existing.promise;
    }
    const entry = { url: null, cancelled: false, promise: null };
    entry.promise = (async () => {
      const blob = await load(id);
      const url = createUrl(blob);
      if (entry.cancelled) {
        revokeUrl(url);
        throw new Error(`attachment ${id} was evicted before it settled`);
      }
      entry.url = url;
      return url;
    })().catch((error) => {
      if (entries.get(id) === entry) entries.delete(id);
      throw error;
    });
    entries.set(id, entry);
    evict();
    return entry.promise;
  }

  function clear() {
    for (const entry of entries.values()) {
      if (entry.url) revokeUrl(entry.url);
      else entry.cancelled = true;
    }
    entries.clear();
  }

  return {
    get,
    clear,
    size: () => entries.size,
    has: (id) => entries.has(id),
    peek: (id) => entries.get(id)?.url ?? null,
  };
}
