// Emergency tool, run inside the container:
//   docker exec tidewiki node tidewiki-cli.cjs unlock <username|e-mail>
//   docker exec tidewiki node tidewiki-cli.cjs unlock --all
//   docker exec tidewiki node tidewiki-cli.cjs locked
// It switches to the owner of the data folder before touching the database, so files never end up owned by root.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const data = process.env.WIKI_DATA_DIR || "/data";
const file = path.join(data, "wiki.db");
if (!fs.existsSync(file)) {
  console.error(`[tidewiki] No database at ${file}.`);
  process.exit(1);
}
if (process.getuid && process.getuid() === 0) {
  const st = fs.statSync(data);
  if (st.uid === 0) {
    console.error("[tidewiki] The data folder is owned by root; refusing to continue.");
    process.exit(1);
  }
  process.setgroups([]);
  process.setgid(st.gid);
  process.setuid(st.uid);
}

const Database = require("better-sqlite3");
const db = new Database(file);
db.pragma("busy_timeout = 5000");
const now = Math.floor(Date.now() / 1000);
const [cmd, arg] = process.argv.slice(2);

function audit(detail, target) {
  db.prepare("INSERT INTO audit_log(ts,user_id,event,ip,detail,target_id) VALUES(?,?,?,?,?,?)").run(
    now,
    null,
    "admin.unlock",
    null,
    `${detail} (command line)`,
    target ?? null,
  );
}

if (cmd === "locked") {
  const rows = db
    .prepare(
      "SELECT l.key, l.locked_until, u.username FROM lockouts l LEFT JOIN users u ON u.id=l.user_id WHERE l.locked_until>?",
    )
    .all(now);
  if (!rows.length) console.log("No active lock-outs.");
  for (const r of rows)
    console.log(
      `${r.username ?? r.key.replace(/^fail:id:/, "(unknown name) ")}  locked until ${new Date(r.locked_until * 1000).toISOString()}`,
    );
} else if (cmd === "unlock" && arg === "--all") {
  const n = db.prepare("DELETE FROM lockouts").run().changes;
  audit("all lock-outs lifted");
  console.log(`Lifted ${n} lock-out entr${n === 1 ? "y" : "ies"}.`);
} else if (cmd === "unlock" && arg) {
  const u = db
    .prepare("SELECT id, username, email FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE")
    .get(arg, arg);
  if (!u) {
    console.error(`No account "${arg}".`);
    process.exit(1);
  }
  db.prepare("DELETE FROM lockouts WHERE user_id=? OR key IN (?,?,?)").run(
    u.id,
    `fail:u:${u.id}`,
    `fail:id:${u.username.toLowerCase()}`,
    `fail:id:${u.email.toLowerCase()}`,
  );
  audit(u.username, u.id);
  console.log(`${u.username} can sign in again.`);
} else {
  console.log("Usage: node tidewiki-cli.cjs locked | unlock <username|e-mail> | unlock --all");
  process.exit(cmd ? 1 : 0);
}
