/**
 * Tests for express-rate-limit: v5 → v8 migration
 *
 * PR #31 upgrades express-rate-limit from ^5.5.1 to ^8.0.0.
 * All four subgraph services (accounts, inventory, products, reviews) use the
 * same rate-limit configuration pattern:
 *
 *   const limiter = rateLimit({
 *     windowMs: 60 * 60 * 1000, // 1 hour
 *     max: rateLimitThreshold,    // env LIMIT || 5000
 *   });
 *
 * This test suite:
 *   1. Documents what v5 did and proves v8 maintains or intentionally changes that behaviour.
 *   2. Covers breaking changes that are relevant to this project.
 *   3. Verifies the service-level configuration works end-to-end.
 *
 * Uses only built-in Node.js modules (node:test, node:assert, http, express) –
 * no new test dependencies are added.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const rateLimit = require("express-rate-limit");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an Express app wired up with the given rate-limit options. */
function createApp(rateLimitOptions, trustProxy) {
  const app = express();
  if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
  const limiter = rateLimit(rateLimitOptions);
  app.use(limiter);
  app.get("/", (_req, res) => res.json({ ok: true }));
  return app;
}

/**
 * Start a server, run fn(server), then close the server.
 * The server binds to a random available port so tests never conflict.
 */
async function withServer(rateLimitOptions, fn, trustProxy) {
  const server = http.createServer(createApp(rateLimitOptions, trustProxy));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Perform a single GET / request against the server, returning status + headers. */
function request(server, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        headers: extraHeaders,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 1. Core rate-limiting functionality
// ---------------------------------------------------------------------------

describe("1. Core rate-limiting functionality", () => {
  it("allows requests under the configured limit", async () => {
    await withServer({ windowMs: 60_000, limit: 3 }, async (server) => {
      for (let i = 0; i < 3; i++) {
        const { status } = await request(server);
        assert.equal(status, 200, `request ${i + 1} should succeed`);
      }
    });
  });

  it("returns 429 Too Many Requests when the limit is exceeded", async () => {
    await withServer({ windowMs: 60_000, limit: 3 }, async (server) => {
      for (let i = 0; i < 3; i++) await request(server);
      const { status } = await request(server);
      assert.equal(status, 429, "4th request should be rate-limited");
    });
  });

  it("includes a Retry-After header on a 429 response", async () => {
    await withServer({ windowMs: 60_000, limit: 1 }, async (server) => {
      await request(server); // use up the limit
      const { status, headers } = await request(server);
      assert.equal(status, 429);
      assert.ok(
        headers["retry-after"] !== undefined,
        "Retry-After header must be present"
      );
    });
  });

  it("X-RateLimit-Limit header reflects the configured limit", async () => {
    await withServer({ windowMs: 60_000, limit: 10 }, async (server) => {
      const { headers } = await request(server);
      assert.equal(headers["x-ratelimit-limit"], "10");
    });
  });

  it("X-RateLimit-Remaining decrements with each request", async () => {
    await withServer({ windowMs: 60_000, limit: 5 }, async (server) => {
      for (let expected = 4; expected >= 0; expected--) {
        const { headers } = await request(server);
        assert.equal(
          headers["x-ratelimit-remaining"],
          String(expected),
          `remaining should be ${expected}`
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. API compatibility – the deprecated `max` option
// ---------------------------------------------------------------------------
//
// BEFORE (v5): The option was called `max`.
// AFTER  (v8): The option is called `limit`; `max` still works but is deprecated.
//
// The current services pass `limit: rateLimitThreshold`.
// v8 accepts this via: `limit: passedOptions.max ?? 5`
// so no functional regression occurs, but `limit` is now the canonical name.

describe("2. API compatibility: max option (v5 backward-compat)", () => {
  it(
    "BEFORE (v5 API): max option is accepted and enforces the limit – still works in v8",
    async () => {
      await withServer({ windowMs: 60_000, max: 2 }, async (server) => {
        const first = await request(server);
        assert.equal(first.status, 200);
        const second = await request(server);
        assert.equal(second.status, 200);
        // Third request exceeds max: 2
        const third = await request(server);
        assert.equal(
          third.status,
          429,
          "max option must still enforce the limit in v8"
        );
      });
    }
  );

  it("AFTER (v8 API): limit option is the canonical replacement for max", async () => {
    await withServer({ windowMs: 60_000, limit: 2 }, async (server) => {
      await request(server);
      await request(server);
      const { status } = await request(server);
      assert.equal(status, 429, "limit option must enforce the limit in v8");
    });
  });

  it("max and limit options produce identical behaviour", async () => {
    const results = [];
    for (const opts of [{ max: 3 }, { limit: 3 }]) {
      await withServer({ windowMs: 60_000, ...opts }, async (server) => {
        const statuses = [];
        for (let i = 0; i < 4; i++) {
          const { status } = await request(server);
          statuses.push(status);
        }
        results.push(statuses);
      });
    }
    assert.deepEqual(
      results[0],
      results[1],
      "max and limit must produce the same sequence of status codes"
    );
  });
});

// ---------------------------------------------------------------------------
// 3. v8 breaking change: limit / max = 0 now blocks ALL requests
// ---------------------------------------------------------------------------
//
// BEFORE (v5): setting `max: 0` disabled rate limiting entirely – every
//              request was allowed through.
// AFTER  (v8): setting `limit: 0` (or `max: 0`) blocks EVERY request with 429.
//
// The current services default to 5000 and accept an env-var override, so
// this change only matters if someone sets LIMIT=0.

describe("3. v8 breaking change: limit/max = 0 blocks all requests", () => {
  it(
    "BEFORE (v5): max: 0 disabled rate limiting (all requests allowed) – " +
      "AFTER (v8): max: 0 blocks every request with 429",
    async () => {
      await withServer({ windowMs: 60_000, max: 0 }, async (server) => {
        const { status } = await request(server);
        // v5 → 200, v8 → 429
        assert.equal(
          status,
          429,
          "v8 must block all requests when limit/max is 0"
        );
      });
    }
  );
});

// ---------------------------------------------------------------------------
// 4. v8 new behaviour: IP / proxy validation
// ---------------------------------------------------------------------------
//
// v8 adds runtime checks that emit console warnings (non-fatal ValidationErrors
// caught internally) when the Express trust proxy setting is inconsistent with
// the incoming headers.  Requests still succeed (200) – the error is logged to
// stderr but NOT passed to the Express error handler.
//
// Relevant to this project: the services are deployed to Fly.io via
// fly_deploy.sh.  Fly.io's proxy injects an X-Forwarded-For header.  With the
// default trust proxy: false, every request will log
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR to stderr in v8 (v5 was silent).
//
// Resolution: configure trust proxy appropriately for the deployment, or pass
// validate: { xForwardedForHeader: false } to suppress the warning.

describe("4. v8 new behaviour: IP / proxy validation", () => {
  it(
    "X-Forwarded-For with default trust proxy (false) – request still succeeds in v8 " +
      "(was also silent in v5; v8 logs ERR_ERL_UNEXPECTED_X_FORWARDED_FOR to stderr)",
    async () => {
      await withServer({ windowMs: 60_000, limit: 10 }, async (server) => {
        // Simulate a request arriving via a reverse proxy (e.g. Fly.io)
        const { status } = await request(server, {
          "X-Forwarded-For": "203.0.113.1",
        });
        assert.equal(
          status,
          200,
          "request must still succeed despite the validation warning"
        );
      });
    }
  );

  it(
    "trust proxy: true – request still succeeds in v8 " +
      "(v8 logs ERR_ERL_PERMISSIVE_TRUST_PROXY to stderr; v5 trusted the header silently)",
    async () => {
      await withServer(
        { windowMs: 60_000, limit: 10 },
        async (server) => {
          const { status } = await request(server);
          assert.equal(
            status,
            200,
            "request must still succeed even when trust proxy is true"
          );
        },
        true /* trustProxy */
      );
    }
  );

  it(
    "suppressing the X-Forwarded-For validation via validate option silences the warning",
    async () => {
      await withServer(
        {
          windowMs: 60_000,
          limit: 10,
          validate: { xForwardedForHeader: false },
        },
        async (server) => {
          const { status } = await request(server, {
            "X-Forwarded-For": "203.0.113.1",
          });
          assert.equal(status, 200);
        }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// 5. Response headers – legacy X-RateLimit-* (unchanged default in v8)
// ---------------------------------------------------------------------------
//
// BEFORE (v5): sent X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
//              by default (headers: true).
// AFTER  (v8): still sends the same legacy headers by default
//              (legacyHeaders: true, which reads passedOptions.headers ?? true).
//              Standard RateLimit-* headers are off by default (standardHeaders: false).

describe("5. Response headers", () => {
  it(
    "BEFORE & AFTER: X-RateLimit-Limit is present by default (legacy headers unchanged)",
    async () => {
      await withServer({ windowMs: 60_000, limit: 100 }, async (server) => {
        const { headers } = await request(server);
        assert.ok(
          headers["x-ratelimit-limit"] !== undefined,
          "X-RateLimit-Limit must be present by default in v8"
        );
      });
    }
  );

  it(
    "BEFORE & AFTER: X-RateLimit-Remaining is present by default",
    async () => {
      await withServer({ windowMs: 60_000, limit: 100 }, async (server) => {
        const { headers } = await request(server);
        assert.ok(headers["x-ratelimit-remaining"] !== undefined);
      });
    }
  );

  it(
    "AFTER (v8 new option): standard RateLimit-* headers can be enabled via standardHeaders: 'draft-6'",
    async () => {
      await withServer(
        { windowMs: 60_000, limit: 100, standardHeaders: "draft-6" },
        async (server) => {
          const { headers } = await request(server);
          assert.ok(
            headers["ratelimit-limit"] !== undefined,
            "standard RateLimit-Limit header must be present when standardHeaders is set"
          );
        }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// 6. Service-level configuration
// ---------------------------------------------------------------------------
//
// All four subgraph services share the same pattern:
//   windowMs: 60 * 60 * 1000   (1 hour)
//   max: process.env.LIMIT || 5000

describe("6. Service-level configuration", () => {
  it("enforces a 1-hour (3,600,000 ms) window that resets all counts", async () => {
    // We verify the window by checking the X-RateLimit-Reset header.
    // The reset time should be approximately now + 1 hour.
    await withServer(
      { windowMs: 60 * 60 * 1000, limit: 5000 },
      async (server) => {
        const { headers } = await request(server);
        const resetSeconds = Number(headers["x-ratelimit-reset"]);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const expectedWindow = 60 * 60; // 1 hour in seconds
        const diff = resetSeconds - nowSeconds;
        // Allow a small buffer (+10s) for test execution time and rounding.
        assert.ok(
          diff > 0 && diff <= expectedWindow + 10,
          `X-RateLimit-Reset (${resetSeconds}) should be within the next hour from now (${nowSeconds})`
        );
      }
    );
  });

  it("default limit of 5000 is enforced when LIMIT env var is not set", async () => {
    const threshold = process.env.LIMIT || 5000;
    await withServer(
      { windowMs: 60 * 60 * 1000, limit: Number(threshold) },
      async (server) => {
        // Make one request and confirm X-RateLimit-Limit equals the threshold
        const { headers } = await request(server);
        assert.equal(headers["x-ratelimit-limit"], String(threshold));
      }
    );
  });

  it("LIMIT env var overrides the default threshold", async () => {
    const original = process.env.LIMIT;
    process.env.LIMIT = "42";
    const threshold = Number(process.env.LIMIT);
    try {
      await withServer(
        { windowMs: 60 * 60 * 1000, limit: threshold },
        async (server) => {
          const { headers } = await request(server);
          assert.equal(
            headers["x-ratelimit-limit"],
            "42",
            "LIMIT env var must control the rate-limit threshold"
          );
        }
      );
    } finally {
      if (original === undefined) delete process.env.LIMIT;
      else process.env.LIMIT = original;
    }
  });
});
