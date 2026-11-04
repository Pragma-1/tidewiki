import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
process.env.WIKI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "tidewiki-test-"));
