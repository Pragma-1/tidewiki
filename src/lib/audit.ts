import { db, now } from "./db";
import { translate } from "./i18n";
import { CATEGORIES, EVENT_LABELS, type AuditRow, type Category } from "./audit-shared";
export { CATEGORIES, EVENT_LABELS, eventId, type AuditRow, type Category } from "./audit-shared";

/** Security-relevant events only. Never put secrets, passwords or tokens into `detail`. */
export function audit(
  event: string,
  userId: number | null,
  ip: string | null,
  detail?: string,
  targetId?: number | null,
) {
  db()
    .prepare("INSERT INTO audit_log(ts,user_id,event,ip,detail,target_id) VALUES(?,?,?,?,?,?)")
    .run(now(), userId, event, ip, detail ? detail.slice(0, 300) : null, targetId ?? null);
}

export type AuditFilter = {
  q?: string;
  category?: Category;
  userId?: number;
  from?: number;
  to?: number;
  before?: number;
  limit?: number;
};

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function where(f: AuditFilter): { sql: string; args: unknown[] } {
  const parts: string[] = [],
    args: unknown[] = [];
  if (f.category && CATEGORIES[f.category]) {
    const ps = CATEGORIES[f.category].prefixes;
    parts.push(`(${ps.map(() => "a.event LIKE ? ESCAPE '\\'").join(" OR ")})`);
    args.push(...ps.map((p) => `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  }
  if (f.userId) {
    parts.push("(a.user_id=? OR a.target_id=?)");
    args.push(f.userId, f.userId);
  }
  if (f.from) {
    parts.push("a.ts>=?");
    args.push(f.from);
  }
  if (f.to) {
    parts.push("a.ts<?");
    args.push(f.to);
  }
  if (f.before) {
    parts.push("a.id<?");
    args.push(f.before);
  }
  const q = f.q?.trim();
  if (q) {
    const id = /^#?(\d{1,12})$/.exec(q);
    const needle = q.toLowerCase();
    // match the visible event names in both languages, so "Angemeldet" finds login.ok just like "Signed in"
    const labelHits = Object.entries(EVENT_LABELS)
      .filter(([, l]) => l.toLowerCase().includes(needle) || translate("de", l).toLowerCase().includes(needle))
      .map(([k]) => k);
    const ors = [
      "a.event LIKE ? ESCAPE '\\'",
      "a.detail LIKE ? ESCAPE '\\'",
      "a.ip LIKE ? ESCAPE '\\'",
      "u.username LIKE ? ESCAPE '\\'",
      "t.username LIKE ? ESCAPE '\\'",
    ];
    const orArgs: unknown[] = Array(5).fill(like(q));
    if (id) {
      ors.push("a.id=?");
      orArgs.push(Number(id[1]));
    }
    if (labelHits.length) {
      ors.push(`a.event IN (${labelHits.map(() => "?").join(",")})`);
      orArgs.push(...labelHits);
    }
    parts.push(`(${ors.join(" OR ")})`);
    args.push(...orArgs);
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

const BASE = `SELECT a.id, a.ts, a.event, a.ip, a.detail, a.user_id, u.username, a.target_id, t.username AS target_name
  FROM audit_log a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN users t ON t.id=a.target_id`;

export function queryAudit(f: AuditFilter): { rows: AuditRow[]; total: number } {
  const w = where(f);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const rows = db()
    .prepare(`${BASE} ${w.sql} ORDER BY a.id DESC LIMIT ?`)
    .all(...w.args, limit) as AuditRow[];
  const totalW = where({ ...f, before: undefined });
  const total = (
    db()
      .prepare(
        `SELECT COUNT(*) n FROM audit_log a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN users t ON t.id=a.target_id ${totalW.sql}`,
      )
      .get(...totalW.args) as { n: number }
  ).n;
  return { rows, total };
}

export function exportAudit(f: AuditFilter, max = 100_000): AuditRow[] {
  const w = where({ ...f, before: undefined });
  return db()
    .prepare(`${BASE} ${w.sql} ORDER BY a.id DESC LIMIT ?`)
    .all(...w.args, max) as AuditRow[];
}

/** RFC 4180 CSV with spreadsheet formula injection neutralised (cells starting with = + - @ tab CR). */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
