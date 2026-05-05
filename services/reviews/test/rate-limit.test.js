"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const rateLimit = require("express-rate-limit");

function createApp(opts) {
  const app = express();
  app.use(rateLimit(opts));
  app.get("/", (_req, res) => res.json({ ok: true }));
  return app;
}

async function withServer(opts, fn) {
  const server = http.createServer(createApp(opts));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(server) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/", method: "GET" },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("rate limiting", () => {
  it("allows requests under the limit", async () => {
    await withServer({ windowMs: 60_000, limit: 3 }, async (server) => {
      for (let i = 0; i < 3; i++)
        assert.equal((await request(server)).status, 200);
    });
  });

  it("returns 429 when the limit is exceeded", async () => {
    await withServer({ windowMs: 60_000, limit: 2 }, async (server) => {
      await request(server);
      await request(server);
      assert.equal((await request(server)).status, 429);
    });
  });

  // The services previously used `max` (v5 API); v8 still accepts it.
  it("deprecated max option still enforces the limit (v5 → v8 migration)", async () => {
    await withServer({ windowMs: 60_000, max: 1 }, async (server) => {
      assert.equal((await request(server)).status, 200);
      assert.equal((await request(server)).status, 429);
    });
  });

  // Verify the 1-hour window used by all services is correctly applied.
  it("1-hour window is reflected in X-RateLimit-Reset header", async () => {
    await withServer({ windowMs: 60 * 60 * 1000, limit: 5000 }, async (server) => {
      const { headers } = await request(server);
      const reset = Number(headers["x-ratelimit-reset"]);
      const now = Math.floor(Date.now() / 1000);
      assert.ok(reset > now && reset <= now + 60 * 60 + 10,
        `X-RateLimit-Reset should be ~1 hour from now`);
    });
  });
});
