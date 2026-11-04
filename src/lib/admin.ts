import { db, now } from "./db";
import { audit, exportAudit } from "./audit";
import { checkPasswordStrength, hashPassword, verifyPassword } from "./password";
import {
  insertUser,
  listSessions,
  revokeUserSessions,
  userById,
  validateIdentity,
  type Role,
  type UserRow,
} from "./auth";
import { activeUserLocks, clearLock, nameKey, userKey } from "./lockout";
import { consume } from "./rate-limit";
import { getSettings } from "./settings";
import { policyFromSettings } from "./password-policy";
import { HttpError } from "./validate";

export type AdminUser = {
  id: number;
  username: string;
  email: string;
  role: Role;
  disabled: number;
  totp_enabled: number;
  created_at: number;
  is_owner: number;
  last_login: number | null;
  locked_until: number | null;
};

export function listUsers(): AdminUser[] {
  const locks = activeUserLocks();
  const rows = db()
    .prepare(
      `SELECT u.id, u.username, u.email, u.role, u.disabled, u.totp_enabled, u.created_at, u.is_owner,
      (SELECT MAX(ts) FROM audit_log a WHERE a.user_id=u.id AND a.event='login.ok') AS last_login
    FROM users u ORDER BY u.is_owner DESC, u.username COLLATE NOCASE`,
    )
    .all() as Omit<AdminUser, "locked_until">[];
  return rows.map((r) => ({ ...r, locked_until: locks.get(r.id) ?? null }));
}

const activeAdmins = () =>
  (db().prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0").get() as { n: number }).n;
const ROLES: readonly Role[] = ["admin", "editor", "viewer"];
export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

/**
 * Who may touch whom:
 *  - the owner (super admin, the account created at setup) may manage everybody, but can't
 *    demote, disable or delete itself — ownership has to be handed over first;
 *  - other administrators manage editors and viewers, plus their own name/e-mail/password;
 *  - nobody but the owner creates administrators or changes an administrator account.
 */
function assertCanManage(actor: UserRow, target: UserRow) {
  if (actor.id === target.id) return;
  if (target.is_owner) throw new HttpError(403, "Only the owner can change the owner account.");
  if (target.role === "admin" && !actor.is_owner) throw new HttpError(403, "Only the owner can manage administrators.");
}

async function checkedPassword(password: string, username: string, email: string) {
  const weak = checkPasswordStrength(password, policyFromSettings(getSettings()), { username, email });
  if (weak) throw new HttpError(400, weak, "password");
  return hashPassword(password);
}

export async function createUser(
  actorId: number,
  input: { username: string; email: string; role: Role; password: string },
  ip: string | null,
) {
  const actor = userById(actorId)!;
  if (input.role === "admin" && !actor.is_owner) throw new HttpError(403, "Only the owner can create administrators.");
  validateIdentity(input.username, input.email);
  const weak = checkPasswordStrength(input.password, policyFromSettings(getSettings()), {
    username: input.username,
    email: input.email,
  });
  if (weak) throw new HttpError(400, weak, "password");
  const id = await insertUser(input.username, input.email, input.password, input.role);
  audit("admin.user_created", actorId, ip, `${input.username} (${input.role})`, id);
  return id;
}

export type UserPatch = {
  username?: string;
  email?: string;
  role?: Role;
  disabled?: boolean;
  password?: string;
  action?: "unlock" | "reset2fa" | "revoke_sessions" | "transfer_ownership";
};

export async function updateUser(actorId: number, targetId: number, patch: UserPatch, ip: string | null) {
  const actor = userById(actorId)!;
  const t = userById(targetId);
  if (!t) throw new HttpError(404, "User not found.");
  assertCanManage(actor, t);
  const self = actor.id === t.id;

  const username = patch.username ?? t.username,
    email = patch.email ?? t.email;
  if (patch.username !== undefined || patch.email !== undefined) validateIdentity(username, email);
  const newHash = patch.password !== undefined ? await checkedPassword(patch.password, username, email) : null;

  db()
    .transaction(() => {
      if (username !== t.username || email !== t.email) {
        try {
          db().prepare("UPDATE users SET username=?, email=? WHERE id=?").run(username, email, t.id);
        } catch (e) {
          if (e instanceof Error && /UNIQUE/.test(e.message))
            throw new HttpError(409, "That username or e-mail address is already in use.");
          throw e;
        }
        const changes = [username !== t.username && `${t.username} -> ${username}`, email !== t.email && "e-mail"]
          .filter(Boolean)
          .join(", ");
        audit("admin.user_updated", actorId, ip, changes, t.id);
      }
      if (patch.role !== undefined && patch.role !== t.role) {
        if (self) throw new HttpError(409, "You can’t change your own role.");
        if (patch.role === "admin" && !actor.is_owner)
          throw new HttpError(403, "Only the owner can create administrators.");
        if (t.role === "admin" && activeAdmins() <= 1)
          throw new HttpError(409, "There must always be at least one active administrator.");
        db().prepare("UPDATE users SET role=? WHERE id=?").run(patch.role, t.id);
        revokeUserSessions(t.id); // privileges changed: force a fresh sign-in
        audit("admin.role_changed", actorId, ip, `${username}: ${t.role} -> ${patch.role}`, t.id);
      }
      if (patch.disabled !== undefined && !!t.disabled !== patch.disabled) {
        if (patch.disabled && self) throw new HttpError(409, "You can’t disable your own account.");
        if (patch.disabled && t.role === "admin" && activeAdmins() <= 1)
          throw new HttpError(409, "There must always be at least one active administrator.");
        db()
          .prepare("UPDATE users SET disabled=? WHERE id=?")
          .run(patch.disabled ? 1 : 0, t.id);
        if (patch.disabled) revokeUserSessions(t.id);
        audit(patch.disabled ? "admin.user_disabled" : "admin.user_enabled", actorId, ip, username, t.id);
      }
      if (newHash) {
        db().prepare("UPDATE users SET password_hash=?, password_changed_at=? WHERE id=?").run(newHash, now(), t.id);
        revokeUserSessions(t.id);
        clearLock(userKey(t.id));
        audit("admin.password_set", actorId, ip, username, t.id);
      }
      switch (patch.action) {
        case "unlock":
          clearLock(userKey(t.id));
          clearLock(nameKey(t.username));
          clearLock(nameKey(t.email));
          audit("admin.unlock", actorId, ip, username, t.id);
          break;
        case "reset2fa":
          db().prepare("DELETE FROM totp_devices WHERE user_id=?").run(t.id);
          db()
            .prepare(
              "UPDATE users SET totp_enabled=0, totp_secret_enc=NULL, totp_pending_enc=NULL, recovery_hashes='[]' WHERE id=?",
            )
            .run(t.id);
          revokeUserSessions(t.id);
          audit("admin.2fa_reset", actorId, ip, username, t.id);
          break;
        case "revoke_sessions":
          revokeUserSessions(t.id);
          audit("admin.sessions_revoked", actorId, ip, username, t.id);
          break;
        case "transfer_ownership":
          if (!actor.is_owner) throw new HttpError(403, "Only the owner can hand over ownership.");
          if (self) throw new HttpError(409, "You already own this wiki.");
          if (t.role !== "admin" || t.disabled)
            throw new HttpError(409, "Ownership can only go to an active administrator.");
          db().prepare("UPDATE users SET is_owner=0 WHERE id=?").run(actor.id);
          db().prepare("UPDATE users SET is_owner=1 WHERE id=?").run(t.id);
          audit("admin.owner_transferred", actorId, ip, `${actor.username} -> ${username}`, t.id);
          break;
      }
    })
    .immediate();
}

/* ------------------------------------------------------------------ GDPR */

/**
 * Art. 17 erasure. Removes the account and every piece of personal data tied to it: sessions,
 * reset links, lock-out and rate-limit counters, and all security-log entries by or about the
 * person (their IP addresses included). Pages they wrote stay, because a wiki page belongs to
 * everyone — only the author link is cut, so history shows "deleted account".
 */
export function eraseUser(targetId: number, actor: { id: number; ip: string | null } | "self") {
  const t = userById(targetId);
  if (!t) throw new HttpError(404, "User not found.");
  const idents = [t.username, t.email].map((s) => s.toLowerCase());
  db()
    .transaction(() => {
      db().prepare("DELETE FROM audit_log WHERE user_id=? OR target_id=?").run(t.id, t.id);
      db()
        .prepare(`DELETE FROM lockouts WHERE user_id=? OR key IN (?,?,?)`)
        .run(t.id, userKey(t.id), nameKey(idents[0]), nameKey(idents[1]));
      db()
        .prepare(`DELETE FROM rate_limits WHERE key IN (?,?,?,?,?,?)`)
        .run(
          `reauth:${t.id}`,
          `totp-enable:${t.id}`,
          `reset:mail:${idents[1]}`,
          `search:u:${t.id}`,
          `mailtest:${t.id}`,
          `audit:blocked:${t.id}`,
        );
      db().prepare("DELETE FROM users WHERE id=?").run(t.id); // sessions + reset tokens cascade; page authorship -> NULL
      // A minimal, non-identifying record that an erasure happened (no name, no address, no IP of the person).
      if (actor === "self") audit("account.erased", null, null, `#${t.id}`);
      else audit("admin.user_deleted", actor.id, actor.ip, `#${t.id}`);
    })
    .immediate();
  // secure_delete overwrites freed pages; checkpointing also flushes old copies out of the WAL file.
  db().pragma("wal_checkpoint(TRUNCATE)");
}

export function deleteUser(actorId: number, targetId: number, ip: string | null) {
  const actor = userById(actorId)!;
  const t = userById(targetId);
  if (!t) throw new HttpError(404, "User not found.");
  if (t.id === actorId) throw new HttpError(409, "Delete your own account from your account page.");
  assertCanManage(actor, t);
  if (t.role === "admin" && !t.disabled && activeAdmins() <= 1)
    throw new HttpError(409, "There must always be at least one active administrator.");
  eraseUser(t.id, { id: actorId, ip });
}

/** Self-service erasure from the account page (password required). */
export async function eraseOwnAccount(userId: number, password: string) {
  if (!consume(`reauth:${userId}`, 10, 900)) throw new HttpError(429, "Too many attempts. Try again later.");
  const u = userById(userId)!;
  if (!(await verifyPassword(u.password_hash, password)))
    throw new HttpError(403, "Your password is not correct.", "password");
  if (u.is_owner)
    throw new HttpError(409, "You own this wiki. Hand ownership to another administrator in Settings first.");
  if (u.role === "admin" && !u.disabled && activeAdmins() <= 1)
    throw new HttpError(409, "There must always be at least one active administrator.");
  eraseUser(userId, "self");
}

/** Art. 15 / 20: everything stored about one person, as plain JSON (no hashes, no secrets). */
export function exportUserData(userId: number) {
  const u = userById(userId);
  if (!u) throw new HttpError(404, "User not found.");
  const pages = db()
    .prepare(
      `SELECT p.slug, p.title, r.rev, r.created_at FROM page_revisions r JOIN pages p ON p.id=r.page_id WHERE r.author_id=? ORDER BY r.created_at`,
    )
    .all(u.id);
  const created = db()
    .prepare("SELECT slug, title, created_at FROM pages WHERE created_by=? ORDER BY created_at")
    .all(u.id);
  return {
    exported_at: new Date().toISOString(),
    account: {
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      owner: !!u.is_owner,
      disabled: !!u.disabled,
      two_factor_enabled: !!u.totp_enabled,
      authenticator_devices: (
        db()
          .prepare("SELECT name, created_at, last_used_at FROM totp_devices WHERE user_id=? ORDER BY id")
          .all(u.id) as { name: string; created_at: number; last_used_at: number | null }[]
      ).map((d) => ({
        name: d.name,
        added_at: new Date(d.created_at * 1000).toISOString(),
        last_used_at: d.last_used_at ? new Date(d.last_used_at * 1000).toISOString() : null,
      })),
      created_at: new Date(u.created_at * 1000).toISOString(),
      password_changed_at: new Date(u.password_changed_at * 1000).toISOString(),
    },
    sessions: listSessions(u.id).map((s) => ({
      created_at: new Date(s.created_at * 1000).toISOString(),
      last_seen: new Date(s.last_seen * 1000).toISOString(),
      ip: s.ip,
      user_agent: s.user_agent,
    })),
    security_log: exportAudit({ userId: u.id }).map((a) => ({
      id: a.id,
      at: new Date(a.ts * 1000).toISOString(),
      event: a.event,
      by: a.username,
      about: a.target_name,
      ip: a.ip,
      detail: a.detail,
    })),
    pages_created: created,
    files_uploaded: db()
      .prepare("SELECT name, original_name, mime, size, created_at FROM media WHERE created_by=? ORDER BY created_at")
      .all(u.id),
    page_versions_written: pages,
    note: "Stored secrets (password hash, two-factor secret, recovery codes) are intentionally not included.",
  };
}
