/**
 * security/vault.js
 * ══════════════════
 * Handles all security:
 * - Dashboard authentication (session tokens)
 * - Action audit logging (every agent action recorded)
 * - IP allowlist enforcement
 * - API key validation on startup
 * - Read-only enforcement on financial data (agent can see revenue, never move money)
 */

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

const config = require("../config");

const LOG_DIR    = path.join(process.cwd(), "data", "logs");
const AUDIT_FILE = path.join(LOG_DIR, "audit.jsonl");
const SESSION_FILE = path.join(process.cwd(), "data", "sessions.json");

// ── STARTUP: Validate required keys ──────────────────────────────────────────

function validateSetup() {
  const required = {
    "ANTHROPIC_API_KEY": config.anthropic.api_key,
    "OWNER_EMAIL":       config.owner.email,
    "DASHBOARD_PASSWORD": config.owner.dashboard_password,
    "SESSION_SECRET":    config.security.session_secret,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v || v === "" || v === "changeme123" || v === "change-this-to-random-string")
    .map(([k]) => k);

  if (missing.length > 0) {
    console.error("\n🔴 SECURITY: Missing or default configuration values:");
    missing.forEach(k => console.error(`   → ${k}`));
    console.error("\nSet these in your .env file before running.\n");
    process.exit(1);
  }

  // Warn if dashboard password is weak
  if (config.owner.dashboard_password.length < 12) {
    console.warn("⚠️  WARNING: Dashboard password is short. Use 12+ characters.");
  }

  return true;
}

// ── AUDIT LOG ─────────────────────────────────────────────────────────────────
// Every agent action is written here. Immutable append-only log.

function auditLog(action, details = {}, severity = "info") {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const entry = JSON.stringify({
    ts:       new Date().toISOString(),
    severity,  // info | warn | alert | financial
    action,
    details,
    pid:      process.pid,
  });

  fs.appendFileSync(AUDIT_FILE, entry + "\n");
}

// ── FINANCIAL GUARD ───────────────────────────────────────────────────────────
// The agent uses Gumroad API in READ-ONLY mode.
// These are the ONLY Gumroad endpoints the agent is allowed to call.
// The agent can NEVER initiate payouts, refunds, or account changes.

const ALLOWED_GUMROAD_ENDPOINTS = [
  "/v2/sales",          // read sales data
  "/v2/products",       // read product listings
  "/v2/user",           // read account info
  "/v2/sales/",         // read individual sale (for details)
];

const BLOCKED_GUMROAD_ENDPOINTS = [
  "/v2/sales/refund",   // BLOCKED: no refunds without your approval
  "/v2/user/payouts",   // BLOCKED: no payout changes
  "/v2/products/delete",// BLOCKED: no product deletion
];

function assertReadOnlyFinancial(endpoint) {
  const isBlocked = BLOCKED_GUMROAD_ENDPOINTS.some(b => endpoint.includes(b));
  if (isBlocked) {
    auditLog("BLOCKED_FINANCIAL_WRITE_ATTEMPT", { endpoint }, "alert");
    throw new Error(`SECURITY BLOCK: Agent attempted write to financial endpoint: ${endpoint}`);
  }
  const isAllowed = ALLOWED_GUMROAD_ENDPOINTS.some(a => endpoint.startsWith(a));
  if (!isAllowed) {
    auditLog("UNKNOWN_ENDPOINT_BLOCKED", { endpoint }, "warn");
    throw new Error(`SECURITY BLOCK: Unknown endpoint not on allowlist: ${endpoint}`);
  }
  return true;
}

// ── SESSION MANAGEMENT (Dashboard Auth) ───────────────────────────────────────

function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function loadSessions() {
  if (!fs.existsSync(SESSION_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); }
  catch { return {}; }
}

function saveSessions(sessions) {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
}

function createSession(password) {
  if (password !== config.owner.dashboard_password) {
    auditLog("FAILED_LOGIN_ATTEMPT", { reason: "wrong_password" }, "alert");
    return null;
  }
  const token = generateSessionToken();
  const sessions = loadSessions();
  sessions[token] = {
    created: new Date().toISOString(),
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
  };
  saveSessions(sessions);
  auditLog("SESSION_CREATED", { token_prefix: token.slice(0, 8) });
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session) return false;
  if (new Date(session.expires) < new Date()) {
    delete sessions[token];
    saveSessions(sessions);
    return false;
  }
  return true;
}

function destroySession(token) {
  const sessions = loadSessions();
  delete sessions[token];
  saveSessions(sessions);
  auditLog("SESSION_DESTROYED", { token_prefix: token?.slice(0, 8) });
}

// ── IP GUARD ──────────────────────────────────────────────────────────────────

function checkIP(ip) {
  const allowed = config.security.allowed_ips;
  if (!allowed || allowed.length === 0) return true; // open if no restriction set
  const clean = ip.replace("::ffff:", "");
  if (allowed.includes(clean)) return true;
  auditLog("IP_BLOCKED", { ip: clean }, "alert");
  return false;
}

// ── AUDIT REPORT ──────────────────────────────────────────────────────────────

function getRecentAuditLogs(hours = 24) {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  return fs.readFileSync(AUDIT_FILE, "utf8")
    .trim().split("\n")
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(e => e && new Date(e.ts) > since);
}

function getAlerts(hours = 24) {
  return getRecentAuditLogs(hours).filter(e => e.severity === "alert");
}

module.exports = {
  validateSetup,
  auditLog,
  assertReadOnlyFinancial,
  createSession,
  validateSession,
  destroySession,
  checkIP,
  getRecentAuditLogs,
  getAlerts,
  ALLOWED_GUMROAD_ENDPOINTS,
};
