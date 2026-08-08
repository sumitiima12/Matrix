"use strict";
/* pushSender.js — self-contained Web Push (RFC 8291 aes128gcm payload + RFC 8292 VAPID), built only on
   Node's crypto + undici. No third-party dependency, so npm ci / the lockfile stay untouched.

   Public surface:
     generateVapidKeys()                         → { publicKey, privateKey } (base64url raw)
     buildVapidHeaders(endpoint, keys, subject)  → { Authorization }         (for a given push origin)
     encryptPayload(plaintext, uaPublic, uaAuth) → { body, salt, serverPublicKey }  (aes128gcm record)
     sendPush(subscription, payloadObj, opts)    → posts to the push service, resolves {statusCode}

   All base64url in/out. `subscription` is the browser PushSubscription JSON:
     { endpoint, keys: { p256dh, auth } }. */

const crypto = require("crypto");
let undiciRequest = null;
try { undiciRequest = require("undici").request; } catch { /* undici optional in some test envs */ }

const b64u = {
  encode: (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (str) => Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/"), "base64"),
};

/* Generate a VAPID (application server) P-256 keypair as base64url raw bytes:
   public = 65-byte uncompressed point (0x04 || X || Y); private = 32-byte scalar. */
function generateVapidKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u.encode(ecdh.getPublicKey()), privateKey: b64u.encode(ecdh.getPrivateKey()) };
}

/* Build an EC private KeyObject from raw VAPID key bytes (needed to sign the VAPID JWT). */
function vapidPrivateKeyObject(publicKeyB64u, privateKeyB64u) {
  const pub = b64u.decode(publicKeyB64u);       // 0x04 || X(32) || Y(32)
  const priv = b64u.decode(privateKeyB64u);     // d(32)
  const x = pub.slice(1, 33), y = pub.slice(33, 65);
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: b64u.encode(x), y: b64u.encode(y), d: b64u.encode(priv) },
    format: "jwk",
  });
}

/* Origin (scheme://host) of a push endpoint — the VAPID JWT `aud`. */
function originOf(endpoint) {
  const u = new URL(endpoint);
  return `${u.protocol}//${u.host}`;
}

/* Signed VAPID Authorization header for a given push origin. Valid ~12h. */
function buildVapidHeaders(endpoint, keys, subject) {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: originOf(endpoint),
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject || "mailto:sumit.iima12@gmail.com",
  };
  const signingInput = b64u.encode(JSON.stringify(header)) + "." + b64u.encode(JSON.stringify(claims));
  const key = vapidPrivateKeyObject(keys.publicKey, keys.privateKey);
  // dsaEncoding 'ieee-p1363' → raw 64-byte r||s (JOSE), which is what VAPID/JWS ES256 requires.
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  const jwt = signingInput + "." + b64u.encode(sig);
  return { Authorization: `vapid t=${jwt}, k=${keys.publicKey}` };
}

/* aes128gcm content-encoding of `plaintext` for a subscription (RFC 8291 §3.4 + RFC 8188). */
function encryptPayload(plaintext, uaPublicB64u, uaAuthB64u, recordSize = 4096) {
  const uaPublic = b64u.decode(uaPublicB64u);   // 65 bytes
  const uaAuth = b64u.decode(uaAuthB64u);       // 16 bytes
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8");

  // Ephemeral application-server ECDH keypair (fresh per message).
  const as = crypto.createECDH("prime256v1");
  as.generateKeys();
  const asPublic = as.getPublicKey();                       // 65 bytes
  const ecdhSecret = as.computeSecret(uaPublic);            // 32 bytes shared secret

  const salt = crypto.randomBytes(16);

  // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info"||0x00||ua_public||as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdhSecret, uaAuth, keyInfo, 32));

  // CEK + NONCE per RFC 8188, keyed by the record salt.
  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0");
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0");
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, cekInfo, 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, nonceInfo, 12));

  // Single record: plaintext || 0x02 (last-record delimiter). No extra padding.
  const record = Buffer.concat([data, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // Header: salt(16) || rs(uint32 BE) || idlen(1) || keyid(as_public, 65)
  const rs = Buffer.alloc(4); rs.writeUInt32BE(recordSize, 0);
  const idlen = Buffer.from([asPublic.length]);
  const header = Buffer.concat([salt, rs, idlen, asPublic]);
  const body = Buffer.concat([header, ciphertext]);
  return { body, salt, serverPublicKey: asPublic };
}

/* Send one Web Push message. Returns { statusCode }. Throws on transport error.
   A 404/410 statusCode means the subscription is gone — caller should delete it. */
async function sendPush(subscription, payloadObj, opts = {}) {
  if (!undiciRequest) throw new Error("undici not available");
  const keys = opts.vapid;
  if (!keys || !keys.publicKey || !keys.privateKey) throw new Error("VAPID keys missing");
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys && subscription.keys.p256dh;
  const auth = subscription.keys && subscription.keys.auth;
  if (!endpoint || !p256dh || !auth) throw new Error("invalid subscription");

  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const { body } = encryptPayload(payload, p256dh, auth);
  const vapid = buildVapidHeaders(endpoint, keys, opts.subject);
  const ttl = Number.isFinite(opts.ttl) ? opts.ttl : 2419200;   // 28d default

  const res = await undiciRequest(endpoint, {
    method: "POST",
    headers: {
      ...vapid,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
      TTL: String(ttl),
      Urgency: opts.urgency || "normal",
    },
    body,
  });
  // Drain so the socket is released.
  try { await res.body.text(); } catch { /* ignore */ }
  return { statusCode: res.statusCode };
}

module.exports = { generateVapidKeys, buildVapidHeaders, encryptPayload, sendPush, originOf, _b64u: b64u };
