/**
 * auth.js — signed session tokens (HS256 JWT) built on Node's crypto. No dependency.
 *
 * Pure and side-effect-free (except reading the default secret from env once), so it can be
 * unit-tested directly. server.js requires signToken/verifyToken/requireAuth/storageKeyFor
 * from here.
 */
const crypto = require("crypto");

// Default secret from env; if unset, a random per-boot secret (tokens then invalidate on
// restart — fine for dev, but set JWT_SECRET in production).
const DEFAULT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.JWT_SECRET) {
  console.warn("[auth] JWT_SECRET not set — using a random per-boot secret; users will be logged out on each restart. Set JWT_SECRET in production.");
}
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

/** Sign a token for userId. `secret` and `ttlMs` are injectable for testing. */
function signToken(userId, secret = DEFAULT_SECRET, ttlMs = TOKEN_TTL_MS) {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson({ sub: String(userId), iat: Date.now(), exp: Date.now() + ttlMs });
  const sig = b64url(crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

/** Verify a token; returns { userId } or null. `secret` injectable for testing. */
function verifyToken(token, secret = DEFAULT_SECRET) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = b64url(crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  // Constant-time comparison to avoid timing attacks on the signature.
  if (sig.length !== expected.length) return null;
  let sigBuf, expBuf;
  try { sigBuf = Buffer.from(sig); expBuf = Buffer.from(expected); } catch { return null; }
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()); }
  catch { return null; }
  if (!data || !data.sub || !data.exp || Date.now() > data.exp) return null;
  return { userId: data.sub };
}

/* Middleware: require a valid token. Reads `Authorization: Bearer <token>`, verifies it,
   and attaches req.authUserId (the trusted userId). Rejects with 401 otherwise. */
function requireAuth(req, res, next) {
  const h = req.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : (req.query.token || "");
  const v = verifyToken(token);
  if (!v) return res.status(401).json({ error: "Authentication required." });
  req.authUserId = v.userId;
  next();
}

/* The app stores state + trades under "ph_<phone>", but the token's subject is the bare
   phone. Map to the storage key so existing data stays reachable. */
const storageKeyFor = (userId) => {
  const u = String(userId || "");
  return u.startsWith("ph_") ? u : "ph_" + u;
};

/* Strip a leading "ph_" — used by admin identity comparisons where the env value may be the
   bare phone but the app sends the prefixed id (or vice-versa). */
const stripPh = (s) => String(s || "").replace(/^ph_/, "");

module.exports = { signToken, verifyToken, requireAuth, storageKeyFor, stripPh, DEFAULT_SECRET, TOKEN_TTL_MS };
