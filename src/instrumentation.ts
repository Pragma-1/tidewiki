export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  (await import("./lib/process-safety")).installSafetyNet();
  const { ensureSetupToken } = await import("./lib/auth");
  const { loadMasterKey } = await import("./lib/crypto");
  loadMasterKey(); // fail fast on a bad key instead of at first login
  const { syncSystemPages } = await import("./lib/seed");
  const { getSettings } = await import("./lib/settings");
  syncSystemPages("de");
  void getSettings; // built-in pages follow the site language while unedited
  const { startRetentionJob } = await import("./lib/retention");
  startRetentionJob(); // GDPR storage limitation for logs, IPs, sessions
  const token = ensureSetupToken();
  if (token) {
    console.log("\n[tidewiki] No administrator exists yet.");
    console.log(`[tidewiki] Open /setup and enter this one-time setup token: ${token}\n`);
  }
}
