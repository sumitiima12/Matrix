/* RFC-6238 TOTP (HMAC-SHA1, 30s step, 6 digits) from a base32 secret — the same 6-digit code an
   authenticator app shows. Dependency-free so the FYERS house feed can log in unattended.

   Extracted verbatim from server.js (R23-P3-05 module split) so the code path is independently
   unit-testable against the RFC-6238 published test vectors and no longer inflates the 7k-line server. */
const crypto = require("crypto");

function totpCode(secretB32, atMs = Date.now()) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of String(secretB32 || "").toUpperCase().replace(/[^A-Z2-7]/g, "")) bits += A.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  let counter = Math.floor(atMs / 1000 / 30);
  const cb = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { cb[i] = counter & 0xff; counter = Math.floor(counter / 256); }
  const h = crypto.createHmac("sha1", Buffer.from(bytes)).update(cb).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, "0");
}

module.exports = { totpCode };
