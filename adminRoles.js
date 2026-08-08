"use strict";
/* adminRoles.js — PURE role-based access control for admin actions. No I/O, so the security boundary is
   unit-tested without a running server.

   Four roles, ranked. A route declares the MINIMUM role it needs; a caller passes only if their role rank is
   >= the required rank.

     readonly (1) — can view dashboards/audit, change nothing.
     support  (2) — readonly + operational actions that don't move money or change security
                     (pause a user/strategy, reconcile, add incident notes).
     admin    (3) — support + user administration (approve/block, clear data).
     owner    (4) — everything, including dangerous actions (rotate credentials, unapprove-and-revoke,
                     manage other admins).

   Backward compatibility: the pre-existing ADMIN_USER_IDS list maps to `owner`, so the current single admin
   keeps full access with no env change. Additional tiers are opt-in via ADMIN_ADMIN_IDS / ADMIN_SUPPORT_IDS /
   ADMIN_READONLY_IDS. */

const ROLE_RANK = { readonly: 1, support: 2, admin: 3, owner: 4 };
const RANK_ROLE = { 1: "readonly", 2: "support", 3: "admin", 4: "owner" };

/* Parse a comma-separated env list of user ids into a clean Set (bare phone, no "ph_" prefix, trimmed). */
function parseIds(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((x) => x.trim().replace(/^ph_/, ""))
      .filter(Boolean)
  );
}

/* Build the role table from an env-like object. Highest role wins if an id appears in more than one list. */
function buildRoleTable(env = {}) {
  return {
    owner: parseIds(env.ADMIN_USER_IDS),        // existing list = owners (back-compat)
    admin: parseIds(env.ADMIN_ADMIN_IDS),
    support: parseIds(env.ADMIN_SUPPORT_IDS),
    readonly: parseIds(env.ADMIN_READONLY_IDS),
  };
}

/* The effective role for a user id (highest they appear in), or null if they're not an admin at all. */
function resolveAdminRole(uid, env = {}) {
  const id = String(uid || "").trim().replace(/^ph_/, "");
  if (!id) return null;
  const t = buildRoleTable(env);
  if (t.owner.has(id)) return "owner";
  if (t.admin.has(id)) return "admin";
  if (t.support.has(id)) return "support";
  if (t.readonly.has(id)) return "readonly";
  return null;
}

/* Does `role` satisfy the required minimum? Fails CLOSED: an unknown/blank caller role OR an unknown required
   role both deny (a typo'd minRole must never accidentally grant access). */
function roleSatisfies(role, minRole) {
  const have = ROLE_RANK[role] || 0;
  const need = ROLE_RANK[minRole] || 0;
  if (have <= 0 || need <= 0) return false;
  return have >= need;
}

/* Is admin configured at all? (any tier populated) — used so an unconfigured deployment denies everything. */
function adminConfigured(env = {}) {
  const t = buildRoleTable(env);
  return t.owner.size + t.admin.size + t.support.size + t.readonly.size > 0;
}

module.exports = { ROLE_RANK, RANK_ROLE, parseIds, buildRoleTable, resolveAdminRole, roleSatisfies, adminConfigured };
