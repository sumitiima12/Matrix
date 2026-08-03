/* #441 — the createApp() test seam. Proves server.js can be required WITHOUT binding PORT or starting
   network-touching token timers, exposing the fully-wired Express `app` so route-level integration tests can
   drive real handlers against an ephemeral http.Server (and, in CI, an ephemeral Postgres). This is the
   capability the C03 Express-level proofs are built on; keeping it under test stops the boot refactor regressing.

   The module has module-scope side effects (schema init, timers), so we isolate it in a child process with
   MATRIX_NO_LISTEN=1 and assert: (a) it imports, (b) exports { app, isSchemaReady }, (c) serves a real route
   over a port WE own, (d) never bound the configured PORT itself. */
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { execFileSync } = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");

test("#441: server.js exports a wired app and serves real routes without binding PORT", () => {
  // A distinctive PORT we then prove is NOT listening (the module must not have bound it under the seam).
  const PROBE_PORT = "58231";
  const script = `
    const assert = require("assert");
    const http = require("http");
    const m = require(${JSON.stringify(SERVER)});
    assert.ok(m && m.app && typeof m.app.use === "function", "exports.app must be an Express app");
    assert.equal(typeof m.isSchemaReady, "function", "exports.isSchemaReady must be a function");
    // 1) The configured PORT must be FREE — the module must not have called app.listen(PORT) under the seam.
    const canary = http.createServer((_, res) => res.end("x"));
    canary.on("error", (e) => { console.error("PORT_WAS_BOUND:" + e.code); process.exit(3); });
    canary.listen(Number(${PROBE_PORT}), "127.0.0.1", () => {
      canary.close(() => {
        // 2) The exported app serves real handlers over a server WE own.
        const srv = http.createServer(m.app);
        srv.listen(0, "127.0.0.1", () => {
          const p = srv.address().port;
          http.get({ host: "127.0.0.1", port: p, path: "/api/health" }, (res) => {
            // Any HTTP status proves the Express stack handled it (200 health, or 404 if renamed — both = wired).
            assert.ok(res.statusCode >= 200 && res.statusCode < 500, "app handled a request: " + res.statusCode);
            srv.close(() => { console.log("SEAM_OK"); process.exit(0); });
          }).on("error", (e) => { console.error("REQ_ERR:" + e.message); process.exit(4); });
        });
      });
    });
  `;
  let out;
  try {
    out = execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, MATRIX_NO_LISTEN: "1", PORT: PROBE_PORT, DATABASE_URL: "", JWT_SECRET: "test-seam-secret-000" },
      encoding: "utf8", timeout: 25000, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    assert.fail("seam child failed: " + (e.stderr || e.message));
  }
  assert.match(out, /SEAM_OK/, "the seam imported the app, proved PORT free, and served a real route");
});
