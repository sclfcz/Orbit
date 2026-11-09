import { describe, expect, it } from "vitest";
import { createBlobUrlCache } from "../ui/attachment-cache.js";

describe("attachment blob cache (ADR-0014)", () => {
  it("fetches each id once, including concurrent callers", async () => {
    let loads = 0;
    let urls = 0;
    const cache = createBlobUrlCache({
      load: async (id: string) => {
        loads += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { id };
      },
      createUrl: (blob: unknown) => {
        urls += 1;
        return `blob:${(blob as { id: string }).id}:${urls}`;
      },
      revokeUrl: () => {},
    });
    const first = await Promise.all([cache.get("a"), cache.get("a"), cache.get("a")]);
    expect(loads).toBe(1);
    expect(new Set(first).size).toBe(1);
    await cache.get("a");
    await cache.get("a");
    expect(loads).toBe(1);
  });

  it("keeps at most 32 entries and revokes the oldest", async () => {
    const revoked: string[] = [];
    const cache = createBlobUrlCache({
      load: async (id: string) => ({ id }),
      createUrl: (blob: unknown) => `blob:${(blob as { id: string }).id}`,
      revokeUrl: (url: string) => revoked.push(url),
      limit: 32,
    });
    for (let i = 0; i < 33; i += 1) await cache.get(`id-${i}`);
    expect(cache.size()).toBe(32);
    expect(cache.has("id-0")).toBe(false);
    expect(revoked).toContain("blob:id-0");
  });

  it("revokes every cached URL on clear (the pagehide path)", async () => {
    const revoked: string[] = [];
    const cache = createBlobUrlCache({
      load: async (id: string) => ({ id }),
      createUrl: (blob: unknown) => `blob:${(blob as { id: string }).id}`,
      revokeUrl: (url: string) => revoked.push(url),
    });
    await cache.get("a");
    await cache.get("b");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(revoked.sort()).toEqual(["blob:a", "blob:b"]);
  });
});
