# KMS integration for broker credentials — scope & staged plan

**Goal:** remove the single point of compromise in broker-credential storage. Today a full DB dump *plus* the
server's env leak = every user's broker access. Moving the encryption root of trust into a managed KMS means the
app can decrypt per-request without ever holding the master key material, and a DB dump alone is useless.

## Current state (as built)

`server.js` (around the `encryptCred`/`decryptCred` functions):

```js
const CRED_SECRET = process.env.CRED_KEY || process.env.JWT_SECRET || process.env.DATABASE_URL || "…fallback…";
const CRED_AESKEY = crypto.scryptSync(CRED_SECRET, "matrix-cred-salt-v1", 32);   // 256-bit key, derived once at boot
// encryptCred: AES-256-GCM(iv, CRED_AESKEY) → { v:1, iv, tag, ct }
// decryptCred: reverse
```

- Broker creds are AES-256-GCM encrypted at rest in `broker_creds` (blob `{v,iv,tag,ct}`), keyed off `CRED_KEY`.
- Startup already **requires** a strong dedicated `CRED_KEY` when live trading is enabled (`CRED_KEY_REQUIRED`
  / refuses weak keys with `TRADING_ENABLED`).
- **The gap:** `CRED_KEY` lives in the process environment. Whoever can read env + the DB can decrypt everything.
  Rotating `CRED_KEY` today orphans all existing creds (users must reconnect).

## Target: envelope encryption with a KMS-held root key

Keep AES-256-GCM for the actual cred blob (fast, local), but stop trusting env for the key:

- A **master key (KEK)** lives in AWS KMS / Cloudflare / GCP KMS and never leaves it.
- Each cred blob is encrypted with a **data key (DEK)**; the DEK is wrapped (encrypted) by the KEK via a single
  KMS call and stored *alongside* the blob. To decrypt, the app asks KMS to unwrap the DEK, then does AES locally.
- A DB dump now contains only wrapped DEKs — worthless without KMS access, which is IAM-gated and audited.
- **Rotation** becomes a KMS key-rotation + lazy re-wrap, with no user reconnect required.

Two envelope granularities — pick per cost/latency:
- **Per-record DEK** (`GenerateDataKey` on write, `Decrypt` on read): strongest blast-radius isolation, one KMS
  call per cred op. Fine at this scale.
- **Cached KEK-wrapped CRED_KEY** (unwrap once at boot, hold the AES key in memory only): near-zero KMS calls,
  but the working key is in process memory (still far better than env, and never on disk). Good default.

Recommend starting with the **cached-unwrap** model (least code, keeps the existing AES path) and moving to
per-record DEKs only if a threat model demands it.

## Code shape (mirrors the objectStore.js pattern)

Add `kms.js`, env-gated, default = today's behavior:

```
KMS_PROVIDER = none | aws            (default none → current CRED_KEY path, zero change)
KMS_KEY_ID   = arn:aws:kms:…:key/…   (the KEK)
AWS_REGION / creds via IAM role
```

- `kms.enabled()` → boolean.
- `kms.getCredKey()` → returns the 32-byte AES key: in `aws` mode, `Decrypt` the KEK-wrapped `CRED_KEY_WRAPPED`
  once and cache; in `none` mode, return the existing scrypt-derived key. `encryptCred`/`decryptCred` call this
  instead of the module-level `CRED_AESKEY`.
- Lazy `require("@aws-sdk/client-kms")` so the default install needs no new dependency.

Touch points: only `encryptCred` / `decryptCred` and their key source. `saveBrokerCred` / `getBrokerCred`
callers are unchanged.

## Staged rollout (dual-read, no user reconnect)

1. **Phase 0 — provision.** Create the KMS key + IAM policy scoped to the backend's role only. Wrap the current
   `CRED_KEY` with it once (offline), store the ciphertext as `CRED_KEY_WRAPPED`. `npm i @aws-sdk/client-kms`.
2. **Phase 1 — dual-read decrypt.** Ship `kms.js`. `decryptCred` tries the KMS-unwrapped key first, falls back to
   the legacy scrypt key on failure. `KMS_PROVIDER=none` still = today. Deploy with it off, verify KMS path in
   staging.
3. **Phase 2 — flip reads.** Set `KMS_PROVIDER=aws` in prod. Existing blobs (encrypted under the same key bytes,
   now sourced from KMS) decrypt unchanged. Monitor decrypt-failure logs for a full session.
4. **Phase 3 — writes via KMS + remove env key.** New/updated creds encrypt under the KMS-sourced key. Once
   confident, remove the raw `CRED_KEY` from env (keep only `CRED_KEY_WRAPPED` + KMS access). Now no plaintext key
   exists anywhere outside KMS.
5. **Phase 4 (optional) — per-record DEKs + rotation drill.** Migrate to per-blob DEKs and run a key-rotation
   drill (rotate KEK, confirm old blobs still decrypt via versioned DEK wrap).

## Rollback

Any phase: set `KMS_PROVIDER=none` → the app reverts to the env `CRED_KEY` path instantly (that's why the raw
`CRED_KEY` stays in env until Phase 3 is proven). No data migration is destructive; blobs are unchanged.

## Effort & dependencies

- Code: ~half a day for `kms.js` + wiring + dual-read (small, isolated).
- Infra: KMS key + IAM (an hour), the offline wrap of `CRED_KEY`.
- Dependency: `@aws-sdk/client-kms` (lazy-required).
- Risk: low — additive, flag-gated, dual-read, reversible. The only irreversible step is removing `CRED_KEY` from
  env in Phase 3, gated behind proven Phase 2 reads.

## Acceptance

- With `KMS_PROVIDER=aws` and `CRED_KEY` removed from env, the app starts, decrypts existing creds, and places a
  real exit — proving KMS is the sole key source.
- Revoking the backend's KMS IAM permission makes cred decryption fail closed (no plaintext fallback) — proving
  the DB alone is insufficient.
- Key rotation completes with zero user reconnects.
