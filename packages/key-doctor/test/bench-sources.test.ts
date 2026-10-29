import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { burstResult, percentile, rateLimitHeaders, summarize, toMarkdown, type BenchResult } from "../scripts/bench-sources-lib.ts";

describe("bench-sources helpers", () => {
  it("percentile uses nearest rank over sorted values", () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([10], 95), 10);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  });

  it("summarize times successes only and splits 429s from other failures", () => {
    const s = summarize([
      { ms: 300, status: 200 },
      { ms: 100, status: 200 },
      { ms: 50, status: 429 },
      { ms: 15_000, status: 0 },
      { ms: 80, status: 200, rpcError: true },
    ]);
    assert.deepEqual(s, { n: 5, ok: 2, limited: 1, failed: 2, p50: 100, p95: 300, min: 100, max: 300 });
  });

  it("keeps rate-limit headers only", () => {
    const h = rateLimitHeaders(
      new Headers({ "X-RateLimit-Remaining": "4", "Retry-After": "10", "set-cookie": "s=1", "ratelimit-limit": "6" }).entries(),
    );
    assert.deepEqual(h, { "x-ratelimit-remaining": "4", "retry-after": "10", "ratelimit-limit": "6" });
  });

  it("burstResult finds the first 429", () => {
    const b = burstResult(
      [
        { ms: 1, status: 200 },
        { ms: 1, status: 200 },
        { ms: 1, status: 429, headers: { "retry-after": "60" } },
      ],
      30,
    );
    assert.deepEqual(b, { sent: 3, ok: 2, limited: 1, firstLimitedAt: 3, wallMs: 30, headers: { "retry-after": "60" } });
    assert.equal(burstResult([{ ms: 1, status: 200 }], 1).firstLimitedAt, null);
  });

  it("the Markdown holds counts, never account names", () => {
    const r: BenchResult = {
      schema: "kd.bench_sources.v1",
      network: "testnet",
      run_at: "2026-10-30T00:00:00Z",
      runs: 2,
      account: { keys: 3 },
      dao: { members: 4 },
      nearblocks_key: false,
      nearblocks_key_fields: ["created", "public_key"],
      sources: [
        {
          source: "rpc.testnet.near.org",
          kind: "rpc",
          calls: { "block (final)": summarize([{ ms: 120, status: 200 }, { ms: 200, status: 429 }]) },
          scan: { ...summarize([{ ms: 900, status: 200 }]), members: 4 },
          burst: burstResult([{ ms: 1, status: 429, headers: { "retry-after": "5" } }], 10),
        },
      ],
    };
    const md = toMarkdown(r);
    assert.match(md, /\| rpc\.testnet\.near\.org \| block \(final\) \| 1\/2 \| 120 \| 120 \| 120–120 \| 1× 429 \|/);
    assert.match(md, /full scan \(4 members\)/);
    assert.match(md, /`retry-after: 5`/);
    assert.match(md, /Account: 3 keys\. DAO: 4 council members\. NearBlocks API key: no \(free tier\)\./);
    assert.match(md, /`created`, `public_key`/);
  });
});
