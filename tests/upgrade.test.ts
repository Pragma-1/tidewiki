import "./setup-env";
import { describe, expect, it } from "vitest";
import path from "node:path";
import { openDb, db } from "@/lib/db";
import { DATA_DIR } from "@/lib/config";
import { encrypt } from "@/lib/crypto";
import { hotp, base32Decode, generateSecret } from "@/lib/totp";
import { getSettings } from "@/lib/settings";
import { search } from "@/lib/search";
import * as auth from "@/lib/auth";
import { hashPassword } from "@/lib/password";

describe("upgrade from the previous release (schema v4)", () => {
  it("moves the authenticator into a device, splits the 2FA setting per role and indexes all pages", async () => {
    const file = path.join(DATA_DIR, "wiki.db");
    const old = openDb(file, 4);
    expect(old.pragma("user_version", { simple: true })).toBe(4);
    const secret = generateSecret();
    const t = Math.floor(Date.now() / 1000);
    const pw = await hashPassword("tidal-marsh-lantern-47");
    const id = Number(
      old
        .prepare(
          "INSERT INTO users(username,email,password_hash,role,is_owner,created_at,password_changed_at,totp_enabled,totp_secret_enc,totp_last_step,recovery_hashes) VALUES('alt','alt@example.com',?,'admin',1,?,?,1,?,?,'[]')",
        )
        .run(pw, t, t, "", 0).lastInsertRowid,
    );
    old.prepare("UPDATE users SET totp_secret_enc=? WHERE id=?").run(encrypt(secret, `user:${id}:totp`), id);
    old.prepare("INSERT INTO settings(key,value) VALUES('require_2fa','true')").run();
    old
      .prepare(
        "INSERT INTO pages(slug,title,parent_id,position,content,rev,created_at,updated_at) VALUES('alt','Alte Seite',NULL,1,'Vorhandene Inhalte mit Bitte',1,?,?)",
      )
      .run(t, t);
    old.close();

    const d = db(); // the app opens and migrates
    expect(d.pragma("user_version", { simple: true })).toBe(5);
    const s = getSettings();
    expect([s.require_2fa_admin, s.require_2fa_editor, s.require_2fa_viewer]).toEqual([true, true, true]);
    expect(d.prepare("SELECT 1 FROM settings WHERE key='require_2fa'").get()).toBeUndefined();
    const devs = auth.listDevices(id);
    expect(devs).toHaveLength(1);
    expect(d.prepare("SELECT totp_secret_enc FROM users WHERE id=?").get(id)).toEqual({ totp_secret_enc: null });
    expect(d.prepare("SELECT name FROM sqlite_master WHERE name='pages_fts'").get()).toBeUndefined();
    // the migrated device still signs in
    const r = await auth.attemptLogin("alt", "tidal-marsh-lantern-47", null, null);
    expect(r.status).toBe("mfa");
    if (r.status !== "mfa") return;
    const code = hotp(base32Decode(secret), Math.floor(Date.now() / 30000));
    expect((await auth.completeMfa(r.token, code, null, null)).status).toBe("ok");
    // existing pages are searchable by substring right away
    expect(search("itte").hits.map((h) => h.slug)).toEqual(["alt"]);
    expect(search("halte").hits.map((h) => h.slug)).toEqual(["alt"]);
  });
});
