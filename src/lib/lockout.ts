import { db, now } from "./db";

/**
 * Escalating sign-in lock-out. Every time an account (or an unknown sign-in name) reaches the
 * failure limit inside FAIL_WINDOW, it is locked for the next step of the ladder:
 * 10 min → 20 min → 1 h → 3 h → 6 h → 12 h → 24 h (stays at 24 h).
 * A successful sign-in or an administrator unlock resets everything; after a full day without
 * a new lock the ladder starts again from the first step.
 */
import { LADDER } from "./lockout-ladder";
export { LADDER };
const FAIL_WINDOW = 15 * 60;
const LEVEL_DECAY = 24 * 3600;

type Row = {
  key: string;
  user_id: number | null;
  fails: number;
  window_start: number;
  level: number;
  locked_until: number;
};

export const userKey = (userId: number) => `fail:u:${userId}`;
export const nameKey = (ident: string) => `fail:id:${ident.toLowerCase().slice(0, 80)}`;

/** Seconds left on an active lock, or 0. */
export function lockedFor(key: string): number {
  const r = db().prepare("SELECT locked_until FROM lockouts WHERE key=?").get(key) as
    { locked_until: number } | undefined;
  return r ? Math.max(0, r.locked_until - now()) : 0;
}

/** Counts one failure. Returns the new lock duration in seconds when this failure triggered a lock. */
export function registerFailure(key: string, maxAttempts: number, userId: number | null): number | null {
  return db()
    .transaction(() => {
      const t = now();
      const r = db().prepare("SELECT * FROM lockouts WHERE key=?").get(key) as Row | undefined;
      let fails = 1,
        windowStart = t,
        level = 0;
      if (r) {
        level = r.level;
        if (r.locked_until > 0 && t - r.locked_until > LEVEL_DECAY) level = 0;
        if (t - r.window_start <= FAIL_WINDOW) {
          fails = r.fails + 1;
          windowStart = r.window_start;
        }
      }
      let lockedUntil = r?.locked_until ?? 0,
        duration: number | null = null;
      if (fails >= maxAttempts) {
        level = Math.min(level + 1, LADDER.length);
        duration = LADDER[level - 1];
        lockedUntil = t + duration;
        fails = 0;
        windowStart = t;
      }
      db()
        .prepare(
          `INSERT INTO lockouts(key,user_id,fails,window_start,level,locked_until) VALUES(?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET user_id=excluded.user_id, fails=excluded.fails, window_start=excluded.window_start, level=excluded.level, locked_until=excluded.locked_until`,
        )
        .run(key, userId, fails, windowStart, level, lockedUntil);
      return duration;
    })
    .immediate();
}

export const clearLock = (key: string) => {
  db().prepare("DELETE FROM lockouts WHERE key=?").run(key);
};

/** Active locks per user id (for the admin overview). */
export function activeUserLocks(): Map<number, number> {
  const rows = db()
    .prepare("SELECT user_id, locked_until FROM lockouts WHERE user_id IS NOT NULL AND locked_until>?")
    .all(now()) as { user_id: number; locked_until: number }[];
  return new Map(rows.map((r) => [r.user_id, r.locked_until]));
}

export const purgeLockouts = () =>
  db()
    .prepare("DELETE FROM lockouts WHERE locked_until < ? AND window_start < ?")
    .run(now() - LEVEL_DECAY, now() - LEVEL_DECAY);
