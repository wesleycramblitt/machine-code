/**
 * Live listings: OpenAI-compatible /models discovery with explicit
 * ok/unconfigured/failed outcomes. Uses a local HTTP server — no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fetchLiveListing } from "../dist/catalogue/discovery.js";

function start(handler) {
  const server = createServer(handler);
  return (async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address();
    return {
      url: `http://127.0.0.1:${port}`,
      async close() {
        server.close();
        await once(server, "close").catch(() => {});
      },
    };
  })();
}

const json = (obj, status = 200) => (req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

test("live listing returns ids and requires auth", async () => {
  const seen = [];
  const srv = await start((req, res) => {
    seen.push(req.headers.authorization ?? null);
    json({ data: [{ id: "a" }, { id: "b" }, { id: 42 }, {}] })(req, res);
  });
  try {
    process.env.MC_TEST_LIVE_KEY = "sekret";
    const ok = await fetchLiveListing({ baseUrl: srv.url, envKeys: ["MC_TEST_LIVE_KEY"] }, "p");
    assert.equal(ok.ok, true);
    assert.deepEqual([...ok.ids].sort(), ["a", "b"]);
    assert.equal(seen[0], "Bearer sekret");
    delete process.env.MC_TEST_LIVE_KEY;
  } finally {
    await srv.close();
  }
});

test("missing key and bad responses are unconfigured/failed, never throw", async () => {
  const missing = await fetchLiveListing({ baseUrl: "http://127.0.0.1:1", envKeys: ["MC_TEST_MISSING_KEY_XYZ"] }, "p");
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "unconfigured");

  const noBase = await fetchLiveListing({ envKeys: ["X"] }, "p");
  assert.equal(noBase.ok, false);
  assert.equal(noBase.reason, "unconfigured");

  const srv = await start(json({ error: "nope" }, 401));
  try {
    process.env.MC_TEST_LIVE_KEY = "sekret";
    const denied = await fetchLiveListing({ baseUrl: srv.url, envKeys: ["MC_TEST_LIVE_KEY"] }, "p");
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, "failed");
    delete process.env.MC_TEST_LIVE_KEY;
  } finally {
    await srv.close();
  }

  const bad = await start(json({ data: "nope" }));
  try {
    process.env.MC_TEST_LIVE_KEY = "sekret";
    const shape = await fetchLiveListing({ baseUrl: bad.url, envKeys: ["MC_TEST_LIVE_KEY"] }, "p");
    assert.equal(shape.ok, false);
    assert.equal(shape.reason, "failed");
    delete process.env.MC_TEST_LIVE_KEY;
  } finally {
    await bad.close();
  }
});
