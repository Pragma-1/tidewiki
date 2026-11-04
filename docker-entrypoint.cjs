// Container entrypoint: honours PUID/PGID (default 1000:1000), fixes ownership of the data
// directory, then permanently drops root before the app starts. If the container was
// started with a non-root user (compose `user:`), it just starts the app.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function die(msg) {
  console.error(`[tidewiki] ${msg}`);
  process.exit(1);
}

function chownTree(dir, uid, gid) {
  fs.lchownSync(dir, uid, gid);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) chownTree(p, uid, gid);
    else fs.lchownSync(p, uid, gid);
  }
}

if (typeof process.getuid === "function" && process.getuid() === 0) {
  const id = (name) => {
    const raw = (process.env[name] || "").trim() || "1000";
    if (!/^\d{1,9}$/.test(raw)) die(`${name} must be a number, got "${raw}".`);
    return Number(raw);
  };
  const uid = id("PUID"),
    gid = id("PGID");
  if (uid === 0 || gid === 0) die("PUID/PGID 0 (root) is not allowed. Use a normal user id such as 1000.");

  const data = process.env.WIKI_DATA_DIR || "/data";
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const st = fs.statSync(data);
  if (st.uid !== uid || st.gid !== gid) {
    console.log(`[tidewiki] Setting ownership of ${data} to ${uid}:${gid}`);
    chownTree(data, uid, gid);
  }

  process.setgroups([]);
  process.setgid(gid);
  process.setuid(uid);
  try {
    process.setuid(0);
    die("could not drop root privileges");
  } catch (e) {
    if (e.code !== "EPERM") throw e;
  }
  console.log(`[tidewiki] Running as ${process.getuid()}:${process.getgid()}`);
}

require("./server.js");
