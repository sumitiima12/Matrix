/* C03 harness — restartable server/db simulator.
 *
 * A "process restart" for our tests means: throw away ALL in-memory state (module singletons, the in-memory
 * risk-halt set, the `pg` pool, timers) while the DURABLE store (PostgreSQL) persists. We simulate it by
 * clearing the require cache for the app's stateful modules and re-requiring them, so the freshly-loaded code
 * must recover EVERYTHING it needs from PostgreSQL alone — exactly what C03 startup recovery must do.
 *
 * Usage:
 *   const boot = () => freshRequire(["../../db.js"]);      // returns { db }
 *   let { db } = boot(); await db.initDb();                 // "first boot"
 *   ... place an order, inject a crash ...
 *   ({ db } = boot()); await db.initDb();                   // "restart": in-memory gone, PG remains
 *   ... assert startup recovery finds the orphaned attempt by orderTag ...
 *
 * Requires DATABASE_URL (a real ephemeral Postgres) — with the flat-file store there is no cross-restart
 * durability to test. `requirePgOrSkip()` centralises that guard.
 */
const path = require("path");

function requirePgOrSkip() {
  return process.env.DATABASE_URL ? false : "DATABASE_URL not set — restart-recovery tests need a real Postgres";
}

/* Clear the require cache for the given app modules (and their transitive app deps under the repo root), then
   re-require them, returning the fresh exports keyed by basename (e.g. { db, server }). Node built-ins and
   node_modules are left cached (only app state is reset — the pg driver is re-created on re-require of db). */
function freshRequire(relPaths, { fromDir = __dirname } = {}) {
  const root = path.resolve(__dirname, "..", "..");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(root) && !key.includes(`${path.sep}node_modules${path.sep}`)) delete require.cache[key];
  }
  const out = {};
  for (const rel of relPaths) {
    const abs = require.resolve(path.resolve(fromDir, rel));
    const mod = require(abs);
    out[path.basename(abs).replace(/\.[cm]?js$/, "")] = mod;
  }
  return out;
}

module.exports = { freshRequire, requirePgOrSkip };
