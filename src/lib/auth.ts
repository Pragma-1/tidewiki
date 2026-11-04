import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BASE_URL, DATA_DIR, ISSUER } from "./config";
import { db, now } from "./db";
import { decrypt, encrypt, hmac, randomToken, safeEqual, sha256 } from "./crypto";
import { checkPasswordStrength, hashPassword, needsRehash, verifyDummy, verifyPassword } from "./password";
import { consume, isBlocked, purgeRateLimits, recordFailure } from "./rate-limit";
import { clearLock, lockedFor, nameKey, purgeLockouts, registerFailure, userKey } from "./lockout";
import { translate, type Lang } from "./i18n";
import { getSettings } from "./settings";
import { generateSecret, otpauthUri, verifyTotp } from "./totp";
import { audit } from "./audit";
import { EMAIL_RE, HttpError, USERNAME_RE } from "./validate";
import { isMailConfigured, sendMail } from "./mail";
import { renderMail } from "./mail-template";
import { policyFromSettings } from "./password-policy";
import { mfaRequiredFor } from "./roles";
import { seedPages } from "./seed";

export type Role = "admin" | "editor" | "viewer";
export type UserRow = {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  role: Role;
  disabled: number;
  totp_secret_enc: string | null;
  totp_pending_enc: string | null;
  totp_enabled: number;
  totp_last_step: number;
  recovery_hashes: string;
  created_at: number;
  password_changed_at: number;
  is_owner: number;
};
export type SessionUser = {
  id: number;
  username: string;
  email: string;
  role: Role;
  totpEnabled: boolean;
  isOwner: boolean;
  needs2faSetup: boolean;
  mfaRequired: boolean;
  sessionHash: string;
};

/**
 * Per-IP throttle that only applies when the client IP is actually known (trusted proxy configured).
 * Without it, a shared "unknown" bucket would let one attacker lock every visitor out, so we skip it
 * and rely on per-account lock-out plus the capped Argon2 concurrency instead.
 */
const ipAllowed = (key: string, ip: string | null, limit: number, windowSec: number) =>
  ip === null || consume(`${key}:${ip}`, limit, windowSec);

const MFA_TTL = 5 * 60;
const MFA_MAX_ATTEMPTS = 5;

export const userById = (id: number) => db().prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow | undefined;
const userByLogin = (login: string) =>
  db().prepare("SELECT * FROM users WHERE username=? OR email=?").get(login, login) as UserRow | undefined;
export const userCount = () => (db().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

/* ---------------------------------------------------------------- sessions */

export function createSession(
  userId: number,
  kind: "full" | "mfa",
  ttlSec: number,
  ip: string | null,
  ua: string | null,
) {
  const token = randomToken(32);
  const t = now();
  db()
    .prepare(
      "INSERT INTO sessions(id_hash,user_id,kind,created_at,last_seen,expires_at,ip,user_agent) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(sha256(token), userId, kind, t, t, t + ttlSec, ip, ua ? ua.slice(0, 200) : null);
  // At most 30 sessions per person: the oldest ones are dropped.
  db()
    .prepare(
      `DELETE FROM sessions WHERE user_id=? AND id_hash IN (SELECT id_hash FROM sessions WHERE user_id=? ORDER BY last_seen DESC LIMIT -1 OFFSET 30)`,
    )
    .run(userId, userId);
  return token; // only the hash is stored: a leaked DB can't be replayed as cookies
}

export function resolveSession(token: string | undefined | null): SessionUser | null {
  if (!token || token.length < 40 || token.length > 100) return null;
  const hash = sha256(token);
  const s = db().prepare("SELECT * FROM sessions WHERE id_hash=? AND kind='full'").get(hash) as
    { user_id: number; expires_at: number; last_seen: number } | undefined;
  if (!s) return null;
  const t = now();
  if (s.expires_at <= t) {
    db().prepare("DELETE FROM sessions WHERE id_hash=?").run(hash);
    return null;
  }
  const u = userById(s.user_id);
  if (!u || u.disabled) return null;
  if (t - s.last_seen > 60) db().prepare("UPDATE sessions SET last_seen=? WHERE id_hash=?").run(t, hash);
  const mfaRequired = mfaRequiredFor(getSettings(), u.role);
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    totpEnabled: !!u.totp_enabled,
    isOwner: !!u.is_owner,
    needs2faSetup: mfaRequired && !u.totp_enabled,
    mfaRequired,
    sessionHash: hash,
  };
}

export const destroySession = (token: string | undefined) => {
  if (token) db().prepare("DELETE FROM sessions WHERE id_hash=?").run(sha256(token));
};
export const revokeUserSessions = (userId: number, exceptHash?: string) =>
  db()
    .prepare("DELETE FROM sessions WHERE user_id=? AND id_hash IS NOT ?")
    .run(userId, exceptHash ?? null);

export function listSessions(userId: number) {
  return db()
    .prepare(
      "SELECT id_hash, created_at, last_seen, ip, user_agent FROM sessions WHERE user_id=? AND kind='full' AND expires_at>? ORDER BY last_seen DESC",
    )
    .all(userId, now()) as {
    id_hash: string;
    created_at: number;
    last_seen: number;
    ip: string | null;
    user_agent: string | null;
  }[];
}

/** Public handle for a session: derived from (never equal to) the stored hash, which is derived from the cookie. */
export const sessionHandle = (idHash: string) => sha256(`session-handle:${idHash}`).slice(0, 24);

/** Signs out one of the person's own sessions. Returns whether it was the current one. */
export function revokeOwnSession(user: SessionUser, handle: string, ip: string | null): { current: boolean } {
  if (!/^[0-9a-f]{24}$/.test(handle)) throw new HttpError(404, "That session no longer exists.");
  const target = listSessions(user.id).find((s) => safeEqual(sessionHandle(s.id_hash), handle));
  if (!target) throw new HttpError(404, "That session no longer exists.");
  db().prepare("DELETE FROM sessions WHERE id_hash=? AND user_id=?").run(target.id_hash, user.id);
  audit("session.revoked", user.id, ip);
  return { current: target.id_hash === user.sessionHash };
}

export function revokeOtherSessions(user: SessionUser, ip: string | null): number {
  const n = db().prepare("DELETE FROM sessions WHERE user_id=? AND id_hash<>?").run(user.id, user.sessionHash).changes;
  audit("session.revoked_others", user.id, ip, String(n));
  return n;
}

function housekeeping() {
  if (Math.random() < 0.05) {
    db().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
    db().prepare("DELETE FROM reset_tokens WHERE expires_at <= ?").run(now());
    purgeRateLimits();
    purgeLockouts();
  }
}

/* ------------------------------------------------------------------- login */

export type LoginResult =
  | { status: "ok"; token: string; ttl: number }
  | { status: "mfa"; token: string; ttl: number }
  | { status: "fail" }
  | { status: "blocked"; retryIn: number };

const unknownNameRows = () =>
  (
    db().prepare("SELECT COUNT(*) n FROM (SELECT 1 FROM lockouts WHERE user_id IS NULL LIMIT 20000)").get() as {
      n: number;
    }
  ).n;
const failKey = (u: UserRow | undefined, ident: string) => (u ? userKey(u.id) : nameKey(ident));

/** Counts a failure; when it triggers a lock, records it in the security log. */
function fail(key: string, user: UserRow | undefined, ip: string | null) {
  // Counters for names that don't exist are bounded, so spraying random names can't grow the table forever.
  if (!user && unknownNameRows() >= 20_000) return;
  const locked = registerFailure(key, getSettings().max_login_attempts, user?.id ?? null);
  if (locked && user) audit("login.locked", user.id, ip, `${Math.round(locked / 60)} min`, user.id);
}

export async function attemptLogin(
  ident: string,
  password: string,
  ip: string | null,
  ua: string | null,
): Promise<LoginResult> {
  housekeeping();
  const cfg = getSettings();
  // Coarse per-IP throttle (only when a trusted proxy tells us the real client IP).
  if (!ipAllowed("login:ip", ip, 40, 900)) return { status: "blocked", retryIn: 900 };
  const user = userByLogin(ident);
  const key = failKey(user, ident);
  const wait = lockedFor(key);
  if (wait > 0) {
    // Log a blocked attempt at most once a minute per account, so hammering a locked account can't flood the log.
    if (user && consume(`audit:blocked:${user.id}`, 1, 60)) audit("login.blocked", user.id, ip);
    return { status: "blocked", retryIn: wait };
  }

  if (!user) {
    await verifyDummy(password);
    fail(key, undefined, ip);
    return { status: "fail" };
  }
  const ok = await verifyPassword(user.password_hash, password);
  if (!ok || user.disabled) {
    fail(key, user, ip);
    audit("login.failed", user.id, ip);
    return { status: "fail" };
  }
  if (needsRehash(user.password_hash)) {
    db()
      .prepare("UPDATE users SET password_hash=? WHERE id=?")
      .run(await hashPassword(password), user.id);
  }
  if (user.totp_enabled) {
    const token = createSession(user.id, "mfa", MFA_TTL, ip, ua);
    return { status: "mfa", token, ttl: MFA_TTL };
  }
  clearLock(key);
  const ttl = cfg.session_hours * 3600;
  audit("login.ok", user.id, ip);
  return { status: "ok", token: createSession(user.id, "full", ttl, ip, ua), ttl };
}

const normRecovery = (c: string) => c.replace(/[\s-]/g, "").toLowerCase();

export async function completeMfa(
  mfaToken: string | undefined,
  code: string,
  ip: string | null,
  ua: string | null,
): Promise<
  | { status: "ok"; token: string; ttl: number }
  | { status: "fail" }
  | { status: "blocked"; retryIn: number }
  | { status: "expired" }
> {
  if (!mfaToken) return { status: "expired" };
  const hash = sha256(mfaToken);
  const s = db().prepare("SELECT * FROM sessions WHERE id_hash=? AND kind='mfa'").get(hash) as
    { user_id: number; expires_at: number; attempts: number } | undefined;
  if (!s || s.expires_at <= now()) {
    if (s) db().prepare("DELETE FROM sessions WHERE id_hash=?").run(hash);
    return { status: "expired" };
  }
  const user = userById(s.user_id);
  const cfg = getSettings();
  if (!user || user.disabled || !user.totp_enabled) return { status: "expired" };
  const key = userKey(user.id);
  const wait = lockedFor(key);
  if (wait > 0 || s.attempts >= MFA_MAX_ATTEMPTS) {
    db().prepare("DELETE FROM sessions WHERE id_hash=?").run(hash);
    return { status: "blocked", retryIn: wait };
  }
  db().prepare("UPDATE sessions SET attempts=attempts+1 WHERE id_hash=?").run(hash);

  let ok = false;
  const clean = code.trim();
  if (/^\d{6}$/.test(clean)) {
    for (const d of deviceRows(user.id)) {
      let secret: string;
      try {
        secret = decrypt(d.secret_enc, `user:${user.id}:totp`);
      } catch {
        continue;
      }
      const step = verifyTotp(secret, clean, Date.now(), d.last_step);
      // Atomic replay protection per device: a time-step can only ever be accepted once.
      if (
        step !== null &&
        db()
          .prepare("UPDATE totp_devices SET last_step=?, last_used_at=? WHERE id=? AND user_id=? AND last_step<?")
          .run(step, now(), d.id, user.id, step).changes === 1
      ) {
        ok = true;
        break;
      }
    }
  } else {
    const h = hmac(normRecovery(clean));
    ok = db()
      .transaction(() => {
        const list = JSON.parse(userById(user.id)!.recovery_hashes) as string[];
        const idx = list.findIndex((x) => safeEqual(x, h));
        if (idx < 0) return false;
        list.splice(idx, 1); // recovery codes are single-use
        db().prepare("UPDATE users SET recovery_hashes=? WHERE id=?").run(JSON.stringify(list), user.id);
        return true;
      })
      .immediate();
    if (ok) audit("2fa.recovery_used", user.id, ip);
  }
  if (!ok) {
    fail(key, user, ip);
    audit("2fa.failed", user.id, ip);
    return { status: "fail" };
  }

  db().prepare("DELETE FROM sessions WHERE id_hash=?").run(hash);
  clearLock(key);
  const ttl = cfg.session_hours * 3600;
  audit("login.ok", user.id, ip, "2fa");
  return { status: "ok", token: createSession(user.id, "full", ttl, ip, ua), ttl };
}

/* ------------------------------------------------------------ registration */

export function validateIdentity(username: string, email: string) {
  if (!USERNAME_RE.test(username))
    throw new HttpError(400, "Username: 3–32 characters, letters, digits, dot, dash or underscore.", "username");
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new HttpError(400, "Enter a valid e-mail address.", "email");
}

export async function insertUser(username: string, email: string, password: string, role: Role): Promise<number> {
  const hash = await hashPassword(password);
  try {
    const t = now();
    return Number(
      db()
        .prepare(
          "INSERT INTO users(username,email,password_hash,role,created_at,password_changed_at) VALUES(?,?,?,?,?,?)",
        )
        .run(username, email, hash, role, t, t).lastInsertRowid,
    );
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message))
      throw new HttpError(409, "That username or e-mail address is already in use.");
    throw e;
  }
}

export async function registerUser(username: string, email: string, password: string, ip: string | null) {
  const cfg = getSettings();
  if (!cfg.allow_registration) throw new HttpError(403, "Registration is turned off.");
  if (!consume(`register:${ip ?? "any"}`, ip ? 5 : 30, 3600))
    throw new HttpError(429, "Too many sign-ups. Try again later.");
  validateIdentity(username, email);
  const weak = checkPasswordStrength(password, policyFromSettings(cfg), { username, email });
  if (weak) throw new HttpError(400, weak, "password");
  const id = await insertUser(username, email, password, cfg.registration_role);
  audit("user.registered", id, ip);
  return id;
}

/* ------------------------------------------------------------ first-run setup */

const SETUP_FILE = () => path.join(/* turbopackIgnore: true */ DATA_DIR, "setup-token");

export function ensureSetupToken(): string | null {
  if (userCount() > 0) {
    rmSync(SETUP_FILE(), { force: true });
    return null;
  }
  if (process.env.WIKI_SETUP_TOKEN && process.env.WIKI_SETUP_TOKEN.length >= 16) return process.env.WIKI_SETUP_TOKEN;
  if (!existsSync(SETUP_FILE())) writeFileSync(SETUP_FILE(), randomBytes(18).toString("base64url"), { mode: 0o600 });
  return readFileSync(SETUP_FILE(), "utf8").trim();
}

export async function setupAdmin(token: string, username: string, email: string, password: string, ip: string | null) {
  if (!ipAllowed("setup", ip, 10, 900)) throw new HttpError(429, "Too many attempts. Try again later.");
  const expected = ensureSetupToken();
  if (!expected) throw new HttpError(403, "Setup is already complete.");
  // Global (not per-IP) limit on wrong tokens: without a trusted proxy the client IP is unknown,
  // and a short custom WIKI_SETUP_TOKEN must not be guessable by unlimited tries.
  if (isBlocked("setup:badtoken", 10))
    throw new HttpError(429, "Too many wrong setup tokens. Try again in 15 minutes.");
  if (!safeEqual(token.trim(), expected)) {
    recordFailure("setup:badtoken", 900);
    audit("setup.bad_token", null, ip);
    throw new HttpError(403, "That setup token is not correct.");
  }
  validateIdentity(username, email);
  const policy = policyFromSettings(getSettings());
  const weak = checkPasswordStrength(
    password,
    { ...policy, minLength: Math.max(12, policy.minLength) },
    { username, email },
  );
  if (weak) throw new HttpError(400, weak, "password");
  const hash = await hashPassword(password);
  const id = db()
    .transaction(() => {
      if (userCount() > 0) throw new HttpError(403, "Setup is already complete."); // closes the race between two setup requests
      const t = now();
      const uid = Number(
        db()
          .prepare(
            "INSERT INTO users(username,email,password_hash,role,is_owner,created_at,password_changed_at) VALUES(?,?,?,'admin',1,?,?)",
          )
          .run(username, email, hash, t, t).lastInsertRowid,
      );
      seedPages(uid, getSettings().language);
      return uid;
    })
    .immediate();
  rmSync(SETUP_FILE(), { force: true });
  audit("setup.admin_created", id, ip);
  return id;
}

/* ---------------------------------------------------------- password reset */

const RESET_TTL = 30 * 60;

/** Always resolves quietly: callers must answer identically whether or not the e-mail exists. */
export async function requestPasswordReset(
  email: string,
  ip: string | null,
  lang: Lang = getSettings().language,
): Promise<void> {
  if (!getSettings().allow_password_reset || !isMailConfigured()) return;
  if (!ipAllowed("reset:ip", ip, 10, 3600)) return;
  if (!consume("reset:global", 300, 3600)) return; // hard ceiling, also bounds the per-address counters
  if (!consume(`reset:mail:${email.toLowerCase()}`, 3, 3600)) return;
  const user = db().prepare("SELECT * FROM users WHERE email=?").get(email) as UserRow | undefined;
  if (!user || user.disabled) return;
  const token = randomToken(32);
  db().transaction(() => {
    db().prepare("DELETE FROM reset_tokens WHERE user_id=?").run(user.id); // only the newest link works
    db()
      .prepare("INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)")
      .run(sha256(token), user.id, now() + RESET_TTL);
  })();
  audit("reset.requested", user.id, ip);
  // The token travels in the URL fragment so it never reaches server logs or Referer headers.
  const link = `${BASE_URL}/reset#token=${token}`;
  const site = getSettings().site_name;
  const t = (x: string, p?: Record<string, string | number>) => translate(lang, x, p);
  const mail = renderMail({
    site,
    heading: t("Reset your password"),
    preheader: t("Open the link within 30 minutes to choose a new password."),
    paragraphs: [
      t("Hello {name},", { name: user.username }),
      t("someone asked to reset the password for your {site} account.", { site }),
      t("Open this link within 30 minutes to choose a new password:"),
    ],
    button: { label: t("Choose a new password"), url: link },
    linkFallback: t("If the button doesn’t work, copy this link into your browser:"),
    footer: t("If you didn’t ask for this, ignore this e-mail — your password stays unchanged."),
  });
  void sendMail(user.email, t("{site}: reset your password", { site }), mail.text, mail.html).catch((e) =>
    console.error("[mail] reset mail failed:", e?.message),
  );
}

export async function performPasswordReset(token: string, password: string, ip: string | null) {
  if (!ipAllowed("reset:use", ip, 20, 3600)) throw new HttpError(429, "Too many attempts. Try again later.");
  if (!/^[A-Za-z0-9_-]{30,100}$/.test(token)) throw new HttpError(400, "This reset link is invalid or has expired.");
  const row = db().prepare("SELECT user_id, expires_at FROM reset_tokens WHERE token_hash=?").get(sha256(token)) as
    { user_id: number; expires_at: number } | undefined;
  if (!row || row.expires_at <= now()) throw new HttpError(400, "This reset link is invalid or has expired.");
  const user = userById(row.user_id);
  if (!user || user.disabled) throw new HttpError(400, "This reset link is invalid or has expired.");
  const weak = checkPasswordStrength(password, policyFromSettings(getSettings()), {
    username: user.username,
    email: user.email,
  });
  if (weak) throw new HttpError(400, weak, "password");
  const hash = await hashPassword(password);
  const used = db()
    .transaction(() => {
      // DELETE ... changes makes the token strictly single-use even under concurrency.
      if (db().prepare("DELETE FROM reset_tokens WHERE token_hash=?").run(sha256(token)).changes !== 1) return false;
      db().prepare("DELETE FROM reset_tokens WHERE user_id=?").run(user.id);
      db().prepare("UPDATE users SET password_hash=?, password_changed_at=? WHERE id=?").run(hash, now(), user.id);
      revokeUserSessions(user.id);
      return true;
    })
    .immediate();
  if (!used) throw new HttpError(400, "This reset link is invalid or has expired.");
  clearLock(userKey(user.id));
  audit("password.reset", user.id, ip);
  // 2FA stays enforced: a reset never bypasses the second factor.
}

/* ----------------------------------------------------------------- account */

export async function changePassword(user: SessionUser, current: string, next: string, ip: string | null) {
  const row = userById(user.id)!;
  if (!(await verifyPassword(row.password_hash, current)))
    throw new HttpError(403, "Your current password is not correct.", "current");
  const weak = checkPasswordStrength(next, policyFromSettings(getSettings()), {
    username: row.username,
    email: row.email,
  });
  if (weak) throw new HttpError(400, weak, "password");
  db()
    .prepare("UPDATE users SET password_hash=?, password_changed_at=? WHERE id=?")
    .run(await hashPassword(next), now(), user.id);
  revokeUserSessions(user.id, user.sessionHash);
  audit("password.changed", user.id, ip);
}

async function requirePassword(user: SessionUser, password: string) {
  if (!consume(`reauth:${user.id}`, 10, 900)) throw new HttpError(429, "Too many attempts. Try again later.");
  if (!(await verifyPassword(userById(user.id)!.password_hash, password)))
    throw new HttpError(403, "Your password is not correct.", "password");
}

/* ------------------------------------------------------ authenticator devices */

export const MAX_DEVICES = 10;
type DeviceRow = {
  id: number;
  name: string;
  secret_enc: string;
  last_step: number;
  created_at: number;
  last_used_at: number | null;
};
const deviceRows = (userId: number) =>
  db().prepare("SELECT * FROM totp_devices WHERE user_id=? ORDER BY id").all(userId) as DeviceRow[];
export const listDevices = (userId: number) =>
  deviceRows(userId).map(({ id, name, created_at, last_used_at }) => ({ id, name, created_at, last_used_at }));

const DEVICE_NAME_RE = /^[^\u0000-\u001f\u007f<>]{1,40}$/u;
const cleanDeviceName = (name: unknown, fallback: string) => {
  const n = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  if (!n) return fallback;
  if (!DEVICE_NAME_RE.test(n)) throw new HttpError(400, "Device name: up to 40 characters.", "name");
  return n;
};

/** Starts adding an authenticator (first one or another one). The secret stays pending until a code proves it works. */
export async function beginTotpSetup(user: SessionUser, password: string) {
  await requirePassword(user, password);
  if (deviceRows(user.id).length >= MAX_DEVICES)
    throw new HttpError(400, `You can register at most ${MAX_DEVICES} authenticator devices.`);
  const secret = generateSecret();
  db()
    .prepare("UPDATE users SET totp_pending_enc=? WHERE id=?")
    .run(encrypt(secret, `user:${user.id}:totp`), user.id);
  return { secret, uri: otpauthUri(secret, user.email, getSettings().site_name.replace(/[:]/g, "") || ISSUER) };
}

export function makeRecoveryCodes(): { plain: string[]; hashes: string[] } {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const plain = Array.from({ length: 10 }, () => {
    const b = randomBytes(10);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { plain, hashes: plain.map((c) => hmac(normRecovery(c))) };
}

/** Confirms the pending authenticator. Returns fresh recovery codes for the first device, null for additional ones. */
export function enableTotp(user: SessionUser, code: string, ip: string | null, name?: unknown): string[] | null {
  const row = userById(user.id)!;
  if (!row.totp_pending_enc) throw new HttpError(400, "Start the setup again.");
  if (!consume(`totp-enable:${user.id}`, 10, 900)) throw new HttpError(429, "Too many attempts. Try again later.");
  const devName = cleanDeviceName(name, "Authenticator");
  const secret = decrypt(row.totp_pending_enc, `user:${user.id}:totp`);
  const step = verifyTotp(secret, code.trim());
  if (step === null)
    throw new HttpError(400, "That code didn’t match. Check the time on your phone and try again.", "code");
  return db()
    .transaction(() => {
      const count = deviceRows(user.id).length;
      if (count >= MAX_DEVICES)
        throw new HttpError(400, `You can register at most ${MAX_DEVICES} authenticator devices.`);
      // Only the pending secret that was just verified is consumed (a parallel setup can't swap it).
      if (
        db()
          .prepare("UPDATE users SET totp_pending_enc=NULL WHERE id=? AND totp_pending_enc=?")
          .run(user.id, row.totp_pending_enc).changes !== 1
      )
        throw new HttpError(400, "Start the setup again.");
      db()
        .prepare("INSERT INTO totp_devices(user_id,name,secret_enc,last_step,created_at) VALUES(?,?,?,?,?)")
        .run(user.id, devName, encrypt(secret, `user:${user.id}:totp`), step, now());
      if (count === 0) {
        const rc = makeRecoveryCodes();
        db()
          .prepare("UPDATE users SET totp_enabled=1, recovery_hashes=? WHERE id=?")
          .run(JSON.stringify(rc.hashes), user.id);
        audit("2fa.enabled", user.id, ip, devName);
        return rc.plain;
      }
      audit("2fa.device_added", user.id, ip, devName);
      return null;
    })
    .immediate();
}

export function renameDevice(user: SessionUser, id: number, name: unknown, ip: string | null) {
  const n = cleanDeviceName(name, "");
  if (!n) throw new HttpError(400, "Device name: up to 40 characters.", "name");
  if (db().prepare("UPDATE totp_devices SET name=? WHERE id=? AND user_id=?").run(n, id, user.id).changes !== 1)
    throw new HttpError(404, "That device no longer exists.");
  audit("2fa.device_renamed", user.id, ip, n);
}

/** Removes one authenticator. Removing the last one turns two-factor off — unless the role requires it. */
export async function removeDevice(user: SessionUser, id: number, password: string, ip: string | null) {
  await requirePassword(user, password);
  db()
    .transaction(() => {
      const devs = deviceRows(user.id);
      const dev = devs.find((d) => d.id === id);
      if (!dev) throw new HttpError(404, "That device no longer exists.");
      const last = devs.length === 1;
      if (last && mfaRequiredFor(getSettings(), userById(user.id)!.role))
        throw new HttpError(
          403,
          "Two-factor authentication is required for your role. Add another device before removing this one.",
        );
      db().prepare("DELETE FROM totp_devices WHERE id=? AND user_id=?").run(id, user.id);
      if (last) {
        db()
          .prepare("UPDATE users SET totp_enabled=0, totp_pending_enc=NULL, recovery_hashes='[]' WHERE id=?")
          .run(user.id);
        audit("2fa.disabled", user.id, ip, dev.name);
      } else audit("2fa.device_removed", user.id, ip, dev.name);
    })
    .immediate();
}

/** Turns two-factor off completely (all devices, all recovery codes). */
export async function disableTotp(user: SessionUser, password: string, ip: string | null) {
  if (mfaRequiredFor(getSettings(), userById(user.id)!.role))
    throw new HttpError(403, "Two-factor authentication is required for your role.");
  await requirePassword(user, password);
  db().transaction(() => {
    db().prepare("DELETE FROM totp_devices WHERE user_id=?").run(user.id);
    db()
      .prepare(
        "UPDATE users SET totp_enabled=0, totp_secret_enc=NULL, totp_pending_enc=NULL, recovery_hashes='[]' WHERE id=?",
      )
      .run(user.id);
  })();
  audit("2fa.disabled", user.id, ip);
}

export async function regenerateRecoveryCodes(
  user: SessionUser,
  password: string,
  ip: string | null,
): Promise<string[]> {
  await requirePassword(user, password);
  if (!user.totpEnabled) throw new HttpError(400, "Turn on two-factor authentication first.");
  const rc = makeRecoveryCodes();
  db().prepare("UPDATE users SET recovery_hashes=? WHERE id=?").run(JSON.stringify(rc.hashes), user.id);
  audit("2fa.recovery_regenerated", user.id, ip);
  return rc.plain;
}

/* ---------------------------------------------------------- profile */

/** Changes the person's own username and/or e-mail address. Needs the current password. */
export async function updateProfile(
  user: SessionUser,
  input: { username: string; email: string; password: string },
  ip: string | null,
  lang: Lang = getSettings().language,
) {
  const username = input.username.trim(),
    email = input.email.trim();
  validateIdentity(username, email);
  const row = userById(user.id)!;
  const nameChanged = username !== row.username,
    mailChanged = email !== row.email;
  if (!nameChanged && !mailChanged) return { changed: false };
  await requirePassword(user, input.password);
  try {
    db().transaction(() => {
      db().prepare("UPDATE users SET username=?, email=? WHERE id=?").run(username, email, user.id);
      // Reset links already sent to the old address stop working.
      if (mailChanged) db().prepare("DELETE FROM reset_tokens WHERE user_id=?").run(user.id);
    })();
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message))
      throw new HttpError(409, "That username or e-mail address is already in use.");
    throw e;
  }
  if (nameChanged) audit("account.username_changed", user.id, ip, `${row.username} → ${username}`);
  if (mailChanged) {
    audit("account.email_changed", user.id, ip);
    // Tell the old address, so a hijacked session can't quietly move the account away.
    if (isMailConfigured()) {
      const site = getSettings().site_name;
      const t = (x: string, p?: Record<string, string | number>) => translate(lang, x, p);
      const mail = renderMail({
        site,
        heading: t("Your e-mail address was changed"),
        paragraphs: [
          t("Hello {name},", { name: username }),
          t("the e-mail address of your {site} account was just changed. Messages now go to the new address.", {
            site,
          }),
        ],
        facts: [[t("New address"), email.replace(/^(.).*(@.*)$/, "$1…$2")]],
        footer: t("If this wasn’t you, contact an administrator right away."),
      });
      void sendMail(row.email, t("{site}: e-mail address changed", { site }), mail.text, mail.html).catch((e) =>
        console.error("[mail] notice failed:", e?.message),
      );
    }
  }
  return { changed: true };
}

export const recoveryCodesLeft = (userId: number) =>
  (JSON.parse(userById(userId)?.recovery_hashes ?? "[]") as string[]).length;
