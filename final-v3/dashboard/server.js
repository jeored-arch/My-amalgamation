/**
 * dashboard/server.js
 * ════════════════════
 * Password-protected web dashboard.
 * Shows revenue, agent activity, security log, payout info.
 * 
 * Start: node dashboard/server.js
 * Visit: http://localhost:3000
 */

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const url    = require("url");
const config = require("../config");
const { createSession, validateSession, destroySession, checkIP, getRecentAuditLogs, getAlerts, auditLog } = require("../security/vault");
const { loadRevenueState, getPayoutInfo } = require("../core/revenue");

const PORT = config.security.dashboard_port;

// ── PARSE BODY ────────────────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        if (req.headers["content-type"]?.includes("application/json")) {
          resolve(JSON.parse(body));
        } else {
          const params = new URLSearchParams(body);
          resolve(Object.fromEntries(params));
        }
      } catch { resolve({}); }
    });
  });
}

// ── COOKIE HELPERS ────────────────────────────────────────────────────────────

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";
  const match = cookies.split(";").find(c => c.trim().startsWith(`${name}=`));
  return match ? match.split("=")[1]?.trim() : null;
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${value}`, "HttpOnly", "Path=/"];
  if (options.maxAge) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  res.setHeader("Set-Cookie", parts.join("; "));
}

// ── HTML HELPERS ──────────────────────────────────────────────────────────────

function page(title, body, headExtra = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Agent HQ</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
${headExtra}
<style>
  :root {
    --bg: #080c0e;
    --surface: #0e1418;
    --border: #1a2228;
    --text: #c8d6e0;
    --muted: #4a6070;
    --green: #00e676;
    --blue: #40c4ff;
    --yellow: #ffd740;
    --red: #ff5252;
    --purple: #b388ff;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; }
  body { background:var(--bg); color:var(--text); font-family:'IBM Plex Sans',monospace; font-size:14px; }
  a { color:var(--blue); text-decoration:none; }
  a:hover { text-decoration:underline; }

  /* Layout */
  .layout { display:grid; grid-template-columns:220px 1fr; min-height:100vh; }
  .sidebar { background:var(--surface); border-right:1px solid var(--border); padding:24px 0; display:flex; flex-direction:column; }
  .main { padding:32px; overflow-y:auto; }

  /* Sidebar */
  .logo { padding:0 20px 24px; border-bottom:1px solid var(--border); }
  .logo-text { font-family:'IBM Plex Mono'; color:var(--green); font-size:13px; font-weight:600; letter-spacing:1px; }
  .logo-sub { color:var(--muted); font-size:11px; margin-top:2px; }
  .nav { padding:20px 0; flex:1; }
  .nav a { display:block; padding:10px 20px; color:var(--muted); font-size:13px; transition:all .15s; }
  .nav a:hover, .nav a.active { color:var(--text); background:rgba(255,255,255,.04); text-decoration:none; border-left:2px solid var(--green); padding-left:18px; }
  .nav-label { padding:12px 20px 6px; color:var(--muted); font-size:10px; letter-spacing:2px; text-transform:uppercase; }
  .sidebar-footer { padding:16px 20px; border-top:1px solid var(--border); }

  /* Cards */
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; margin-bottom:28px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:20px; }
  .card-label { color:var(--muted); font-size:10px; letter-spacing:2px; text-transform:uppercase; margin-bottom:10px; font-family:'IBM Plex Mono'; }
  .card-value { font-size:26px; font-weight:600; font-family:'IBM Plex Mono'; }
  .card-sub { color:var(--muted); font-size:11px; margin-top:4px; }
  .green { color:var(--green); }
  .blue { color:var(--blue); }
  .yellow { color:var(--yellow); }
  .purple { color:var(--purple); }
  .red { color:var(--red); }

  /* Section */
  .section { background:var(--surface); border:1px solid var(--border); border-radius:8px; margin-bottom:20px; overflow:hidden; }
  .section-header { padding:14px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
  .section-title { font-family:'IBM Plex Mono'; font-size:12px; letter-spacing:1px; text-transform:uppercase; color:var(--muted); }
  .section-body { padding:20px; }

  /* Table */
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { color:var(--muted); font-size:10px; letter-spacing:1px; text-transform:uppercase; text-align:left; padding:8px 12px; border-bottom:1px solid var(--border); font-weight:500; }
  td { padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.04); }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:rgba(255,255,255,.02); }

  /* Progress */
  .progress-bar { background:#1a2228; border-radius:4px; height:6px; overflow:hidden; margin-top:8px; }
  .progress-fill { height:6px; border-radius:4px; background:linear-gradient(90deg, var(--green), var(--blue)); transition:width .5s; }

  /* Badge */
  .badge { display:inline-block; padding:3px 10px; border-radius:12px; font-size:10px; font-weight:600; letter-spacing:1px; text-transform:uppercase; font-family:'IBM Plex Mono'; }
  .badge-green { background:rgba(0,230,118,.15); color:var(--green); }
  .badge-blue { background:rgba(64,196,255,.15); color:var(--blue); }
  .badge-yellow { background:rgba(255,215,64,.15); color:var(--yellow); }
  .badge-red { background:rgba(255,82,82,.15); color:var(--red); }

  /* Page header */
  .page-header { margin-bottom:28px; }
  .page-title { font-size:22px; font-weight:600; color:#fff; margin-bottom:4px; }
  .page-sub { color:var(--muted); font-size:13px; }

  /* Login */
  .login-wrap { min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); }
  .login-box { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:40px; width:360px; }
  .login-logo { font-family:'IBM Plex Mono'; color:var(--green); font-size:14px; font-weight:600; letter-spacing:2px; margin-bottom:24px; }
  .login-title { font-size:20px; font-weight:600; color:#fff; margin-bottom:6px; }
  .login-sub { color:var(--muted); font-size:13px; margin-bottom:28px; }
  input[type=password], input[type=text] { width:100%; background:#0e1418; border:1px solid var(--border); border-radius:6px; padding:12px 14px; color:var(--text); font-family:'IBM Plex Mono'; font-size:14px; outline:none; transition:border .15s; }
  input:focus { border-color:var(--green); }
  button { width:100%; background:var(--green); color:#000; border:none; border-radius:6px; padding:13px; font-size:14px; font-weight:600; cursor:pointer; margin-top:16px; font-family:'IBM Plex Sans'; transition:opacity .15s; }
  button:hover { opacity:.85; }
  .error-msg { color:var(--red); font-size:12px; margin-top:10px; }

  /* Log */
  .log-entry { padding:10px 0; border-bottom:1px solid rgba(255,255,255,.04); display:grid; grid-template-columns:140px 80px 1fr; gap:12px; align-items:start; font-size:12px; font-family:'IBM Plex Mono'; }
  .log-entry:last-child { border-bottom:none; }
  .log-ts { color:var(--muted); }
  .log-action { color:var(--blue); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .log-details { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* Payout section */
  .payout-item { padding:14px 0; border-bottom:1px solid rgba(255,255,255,.04); display:flex; justify-content:space-between; align-items:center; }
  .payout-item:last-child { border-bottom:none; }
  .payout-label { color:var(--muted); font-size:12px; }
  .payout-value { font-family:'IBM Plex Mono'; font-size:13px; color:var(--text); }

  /* Alert banner */
  .alert-banner { background:rgba(255,82,82,.1); border:1px solid rgba(255,82,82,.3); border-radius:8px; padding:14px 20px; margin-bottom:20px; display:flex; align-items:center; gap:12px; }
  .alert-banner .icon { font-size:18px; }
  .alert-banner .text { font-size:13px; color:var(--red); }

  @media(max-width:768px) {
    .layout { grid-template-columns:1fr; }
    .sidebar { display:none; }
  }
</style>
</head>
<body>${body}</body>
</html>`;
}

function dashboardLayout(activeNav, content) {
  const revenue = loadRevenueState();
  const nav = [
    ["Overview", "/", "📊"],
    ["Revenue", "/revenue", "💰"],
    ["Activity Log", "/activity", "📋"],
    ["Security", "/security", "🔒"],
    ["Payouts", "/payouts", "🏦"],
  ];

  return page("Agent HQ", `
<div class="layout">
  <aside class="sidebar">
    <div class="logo">
      <div class="logo-text">AGENT HQ</div>
      <div class="logo-sub">Autonomous Business</div>
    </div>
    <nav class="nav">
      <div class="nav-label">Monitor</div>
      ${nav.map(([label, href, icon]) => 
        `<a href="${href}" class="${activeNav === href ? "active" : ""}">${icon} ${label}</a>`
      ).join("")}
    </nav>
    <div class="sidebar-footer">
      <div style="color:var(--muted);font-size:11px;margin-bottom:8px;">Total Revenue</div>
      <div style="color:var(--green);font-family:'IBM Plex Mono';font-size:18px;font-weight:600;">$${revenue.total?.toFixed(2) || "0.00"}</div>
      <a href="/logout" style="display:block;margin-top:14px;color:var(--muted);font-size:12px;">Sign out →</a>
    </div>
  </aside>
  <main class="main">${content}</main>
</div>
`);
}

// ── PAGES ─────────────────────────────────────────────────────────────────────

function loginPage(error = "") {
  return page("Login", `
<div class="login-wrap">
  <div class="login-box">
    <div class="login-logo">● AGENT HQ</div>
    <div class="login-title">Owner Access</div>
    <div class="login-sub">This dashboard is private. Enter your password to continue.</div>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Your dashboard password" autofocus autocomplete="current-password">
      ${error ? `<div class="error-msg">⚠ ${error}</div>` : ""}
      <button type="submit">Access Dashboard →</button>
    </form>
  </div>
</div>
`);
}

function overviewPage() {
  const revenue = loadRevenueState();
  const payout = getPayoutInfo();
  const alerts = getAlerts(24);
  const logs = getRecentAuditLogs(24).slice(0, 5);

  const goalPct = Math.min(100, ((revenue.total || 0) / 2000) * 100).toFixed(1);

  return dashboardLayout("/", `
<div class="page-header">
  <div class="page-title">Overview</div>
  <div class="page-sub">Last updated: ${revenue.last_updated ? new Date(revenue.last_updated).toLocaleString() : "never"}</div>
</div>

${alerts.length > 0 ? `
<div class="alert-banner">
  <span class="icon">🚨</span>
  <span class="text">${alerts.length} security alert(s) in the last 24 hours. <a href="/security">View details →</a></span>
</div>` : ""}

<div class="cards">
  <div class="card">
    <div class="card-label">Today's Revenue</div>
    <div class="card-value green">$${(revenue.today || 0).toFixed(2)}</div>
    <div class="card-sub">Depositing to your bank</div>
  </div>
  <div class="card">
    <div class="card-label">This Month</div>
    <div class="card-value blue">$${(revenue.month || 0).toFixed(2)}</div>
    <div class="card-sub">Automatic weekly payout</div>
  </div>
  <div class="card">
    <div class="card-label">Total Earned</div>
    <div class="card-value yellow">$${(revenue.total || 0).toFixed(2)}</div>
    <div class="card-sub">${revenue.count || 0} sales total</div>
  </div>
  <div class="card">
    <div class="card-label">Security</div>
    <div class="card-value ${alerts.length > 0 ? "red" : "green"}">${alerts.length > 0 ? alerts.length + " alerts" : "Clean"}</div>
    <div class="card-sub">${alerts.length > 0 ? "Review security tab" : "No threats detected"}</div>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <span class="section-title">Revenue Goal Progress</span>
    <span class="badge badge-blue">$2,000/month</span>
  </div>
  <div class="section-body">
    <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
      <span style="color:var(--muted);font-size:12px;">$${(revenue.total||0).toFixed(2)} earned</span>
      <span style="color:var(--green);font-size:12px;">${goalPct}%</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:${goalPct}%"></div></div>
    <div style="color:var(--muted);font-size:11px;margin-top:10px;">$${(2000-(revenue.total||0)).toFixed(2)} remaining to goal</div>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <span class="section-title">Your Payout Method</span>
    <a href="/payouts" style="font-size:12px;">Manage →</a>
  </div>
  <div class="section-body">
    <div class="payout-item">
      <span class="payout-label">Primary payout</span>
      <span class="payout-value">${payout.primary.method}</span>
    </div>
    <div class="payout-item">
      <span class="payout-label">Schedule</span>
      <span class="payout-value">${payout.primary.schedule}</span>
    </div>
    <div class="payout-item">
      <span class="payout-label">Control</span>
      <span class="payout-value green">${payout.primary.control}</span>
    </div>
    <div style="margin-top:14px;padding:12px;background:rgba(0,230,118,.06);border:1px solid rgba(0,230,118,.2);border-radius:6px;font-size:12px;color:var(--muted);">
      🔒 ${payout.security_note}
    </div>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <span class="section-title">Recent Agent Activity</span>
    <a href="/activity" style="font-size:12px;">View all →</a>
  </div>
  <div class="section-body">
    ${logs.length === 0 ? '<div style="color:var(--muted);font-size:13px;">No activity logged yet. Run the agent to see activity.</div>' : 
      logs.map(e => `
        <div class="log-entry">
          <span class="log-ts">${new Date(e.ts).toLocaleTimeString()}</span>
          <span class="log-action">${e.action?.slice(0,20)}</span>
          <span class="log-details">${JSON.stringify(e.details || {}).slice(0,80)}</span>
        </div>`).join("")}
  </div>
</div>
`);
}

function revenuePage() {
  const revenue = loadRevenueState();
  const history = (revenue.history || []).slice(-14).reverse();

  return dashboardLayout("/revenue", `
<div class="page-header">
  <div class="page-title">Revenue</div>
  <div class="page-sub">All sales data is read from Gumroad. Payouts go to your verified bank account.</div>
</div>

<div class="cards">
  <div class="card">
    <div class="card-label">Today</div>
    <div class="card-value green">$${(revenue.today||0).toFixed(2)}</div>
  </div>
  <div class="card">
    <div class="card-label">This Month</div>
    <div class="card-value blue">$${(revenue.month||0).toFixed(2)}</div>
  </div>
  <div class="card">
    <div class="card-label">All Time</div>
    <div class="card-value yellow">$${(revenue.total||0).toFixed(2)}</div>
  </div>
  <div class="card">
    <div class="card-label">Total Sales</div>
    <div class="card-value purple">${revenue.count||0}</div>
  </div>
</div>

<div class="section">
  <div class="section-header"><span class="section-title">Daily Revenue History (Last 14 Days)</span></div>
  <div class="section-body">
    <table>
      <thead><tr><th>Date</th><th>Daily Revenue</th><th>Running Total</th></tr></thead>
      <tbody>
        ${history.length === 0 
          ? `<tr><td colspan="3" style="color:var(--muted);text-align:center;padding:24px;">No history yet. Revenue data appears after first agent run.</td></tr>`
          : history.map(h => `
            <tr>
              <td style="font-family:'IBM Plex Mono';">${h.date}</td>
              <td class="green" style="font-family:'IBM Plex Mono';">$${(h.today||0).toFixed(2)}</td>
              <td style="font-family:'IBM Plex Mono';color:var(--muted);">$${(h.total||0).toFixed(2)}</td>
            </tr>`).join("")}
      </tbody>
    </table>
  </div>
</div>

<div class="section">
  <div class="section-header"><span class="section-title">Gumroad Dashboard</span></div>
  <div class="section-body" style="color:var(--muted);font-size:13px;">
    <p style="margin-bottom:12px;">For full sales details, customer info, and payout management — access your Gumroad dashboard directly:</p>
    <a href="https://app.gumroad.com/dashboard" target="_blank" rel="noopener" 
       style="display:inline-block;background:rgba(64,196,255,.1);border:1px solid rgba(64,196,255,.3);border-radius:6px;padding:10px 18px;color:var(--blue);font-size:13px;">
      Open Gumroad Dashboard →
    </a>
  </div>
</div>
`);
}

function activityPage() {
  const logs = getRecentAuditLogs(72);

  return dashboardLayout("/activity", `
<div class="page-header">
  <div class="page-title">Activity Log</div>
  <div class="page-sub">Every action taken by the agent — last 72 hours. Immutable audit trail.</div>
</div>

<div class="section">
  <div class="section-header">
    <span class="section-title">${logs.length} events</span>
    <span class="badge badge-blue">Read-only log</span>
  </div>
  <div class="section-body" style="padding:0;">
    <table>
      <thead><tr><th>Time</th><th>Severity</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>
        ${logs.length === 0 
          ? `<tr><td colspan="4" style="color:var(--muted);text-align:center;padding:24px;">No activity yet.</td></tr>`
          : logs.reverse().map(e => `
            <tr>
              <td style="font-family:'IBM Plex Mono';font-size:11px;white-space:nowrap;">${new Date(e.ts).toLocaleString()}</td>
              <td><span class="badge badge-${e.severity === "alert" ? "red" : e.severity === "financial" ? "green" : e.severity === "warn" ? "yellow" : "blue"}">${e.severity||"info"}</span></td>
              <td style="font-family:'IBM Plex Mono';font-size:12px;">${e.action||""}</td>
              <td style="font-size:11px;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${JSON.stringify(e.details||{})}</td>
            </tr>`).join("")}
      </tbody>
    </table>
  </div>
</div>
`);
}

function securityPage() {
  const alerts = getAlerts(72);
  const recent = getRecentAuditLogs(24);
  const payout = getPayoutInfo();

  return dashboardLayout("/security", `
<div class="page-header">
  <div class="page-title">Security</div>
  <div class="page-sub">Agent access controls and financial security status.</div>
</div>

${alerts.length > 0 ? `
<div class="alert-banner">
  <span class="icon">🚨</span>
  <span class="text">${alerts.length} security alert(s) in the last 72 hours. Review below.</span>
</div>` : `
<div style="background:rgba(0,230,118,.06);border:1px solid rgba(0,230,118,.2);border-radius:8px;padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;gap:10px;">
  <span>✅</span>
  <span style="font-size:13px;color:var(--green);">No security alerts in the last 72 hours.</span>
</div>`}

<div class="section">
  <div class="section-header"><span class="section-title">Financial Security Controls</span></div>
  <div class="section-body">
    ${[
      ["Agent financial access", "READ ONLY", "green", "Agent can view sales data — cannot move money"],
      ["Payout control", "YOU ONLY", "green", "Only you can trigger payouts via Gumroad dashboard"],
      ["Refund authority", "YOU ONLY", "green", "Agent cannot issue refunds without your action"],
      ["Account changes", "BLOCKED", "green", "Agent cannot modify your Gumroad account settings"],
      ["API key scope", "READ-ONLY ENDPOINTS", "green", "Gumroad API calls limited to allowlisted read endpoints"],
    ].map(([label, value, color, note]) => `
    <div class="payout-item">
      <div>
        <div style="font-size:13px;">${label}</div>
        <div style="color:var(--muted);font-size:11px;margin-top:2px;">${note}</div>
      </div>
      <span class="badge badge-${color}">${value}</span>
    </div>`).join("")}
  </div>
</div>

<div class="section">
  <div class="section-header"><span class="section-title">Payout Security</span></div>
  <div class="section-body" style="font-size:13px;color:var(--muted);line-height:1.7;">
    <p>Your money is secured through multiple layers:</p>
    <ul style="margin:12px 0 0 20px;">
      <li>Gumroad holds funds and pays out only to your <strong>verified bank account on file</strong></li>
      <li>Changing the bank account requires your Gumroad login + email verification</li>
      <li>This agent has <strong>no credentials to access your Gumroad account</strong> — only a read-only API key</li>
      <li>Read-only API keys cannot initiate payouts, refunds, or account changes</li>
      <li>Every agent action is logged and you receive a daily email summary</li>
    </ul>
    <div style="margin-top:16px;">
      <a href="${payout.primary.url}" target="_blank" rel="noopener" 
         style="color:var(--blue);font-size:12px;">Manage bank account in Gumroad →</a>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-header"><span class="section-title">Security Alerts (Last 72h)</span></div>
  <div class="section-body" style="padding:0;">
    <table>
      <thead><tr><th>Time</th><th>Alert</th><th>Details</th></tr></thead>
      <tbody>
        ${alerts.length === 0
          ? `<tr><td colspan="3" style="color:var(--muted);text-align:center;padding:24px;">No alerts. System is secure.</td></tr>`
          : alerts.map(e => `
            <tr>
              <td style="font-family:'IBM Plex Mono';font-size:11px;white-space:nowrap;">${new Date(e.ts).toLocaleString()}</td>
              <td class="red" style="font-family:'IBM Plex Mono';font-size:12px;">${e.action}</td>
              <td style="font-size:11px;color:var(--muted);">${JSON.stringify(e.details||{})}</td>
            </tr>`).join("")}
      </tbody>
    </table>
  </div>
</div>
`);
}

function payoutsPage() {
  const payout = getPayoutInfo();
  return dashboardLayout("/payouts", `
<div class="page-header">
  <div class="page-title">Payouts</div>
  <div class="page-sub">Where your money goes. You control all payouts — the agent cannot touch them.</div>
</div>

<div style="background:rgba(0,230,118,.06);border:1px solid rgba(0,230,118,.2);border-radius:8px;padding:16px 20px;margin-bottom:24px;">
  <div style="color:var(--green);font-weight:600;margin-bottom:6px;">🔒 Your Money Is Fully Secured</div>
  <div style="color:var(--muted);font-size:13px;line-height:1.6;">${payout.security_note}</div>
</div>

<div class="section">
  <div class="section-header">
    <span class="section-title">Primary Payout — ${payout.primary.method}</span>
    <span class="badge badge-green">Active</span>
  </div>
  <div class="section-body">
    <div class="payout-item"><span class="payout-label">Method</span><span class="payout-value">${payout.primary.method}</span></div>
    <div class="payout-item"><span class="payout-label">Schedule</span><span class="payout-value">${payout.primary.schedule}</span></div>
    <div class="payout-item"><span class="payout-label">Who controls it</span><span class="payout-value green">${payout.primary.control}</span></div>
    <div style="margin-top:16px;">
      <a href="${payout.primary.url}" target="_blank" rel="noopener"
         style="display:inline-block;background:rgba(64,196,255,.1);border:1px solid rgba(64,196,255,.3);border-radius:6px;padding:10px 18px;color:var(--blue);font-size:13px;">
        Manage Bank Account in Gumroad →
      </a>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <span class="section-title">Secondary Payout — PayPal</span>
    <span class="badge badge-yellow">Optional</span>
  </div>
  <div class="section-body" style="color:var(--muted);font-size:13px;">
    <p style="margin-bottom:12px;">${payout.secondary.setup}</p>
    <a href="${payout.secondary.url}" target="_blank" rel="noopener" style="color:var(--blue);">Add PayPal in Gumroad settings →</a>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <span class="section-title">Crypto Payout — ${payout.crypto.currency || "USDC"}</span>
    <span class="badge badge-${payout.crypto.method === "Disabled" ? "red" : "blue"}">${payout.crypto.method === "Disabled" ? "Disabled" : "Manual"}</span>
  </div>
  <div class="section-body" style="color:var(--muted);font-size:13px;">
    ${payout.crypto.method === "Disabled"
      ? `<p>Enable in <code>config.js</code> by setting <code>payouts.crypto.enabled = true</code> and adding your wallet address.</p>`
      : `<p>${payout.crypto.note}</p><p style="margin-top:8px;">Wallet: <code style="font-family:'IBM Plex Mono'">${payout.crypto.address}</code></p>`}
  </div>
</div>
`);
}

// ── SERVER ────────────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  const { pathname } = url.parse(req.url);
  const ip = req.socket.remoteAddress;

  // IP check
  if (!checkIP(ip)) {
    res.writeHead(403); res.end("Forbidden");
    return;
  }

  // Auth check (except /login and /logout)
  const token = getCookie(req, "session");
  const isAuthed = validateSession(token);

  // ── LOGIN ──
  if (pathname === "/login") {
    if (req.method === "POST") {
      parseBody(req).then(body => {
        const newToken = createSession(body.password);
        if (newToken) {
          res.setHeader("Set-Cookie", `session=${newToken}; HttpOnly; Path=/; Max-Age=86400`);
          res.writeHead(302, { Location: "/" });
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(loginPage("Incorrect password. Try again."));
        }
      });
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(loginPage());
    }
    return;
  }

  // ── LOGOUT ──
  if (pathname === "/logout") {
    destroySession(token);
    res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
    res.writeHead(302, { Location: "/login" });
    res.end();
    return;
  }

  // Redirect to login if not authed
  if (!isAuthed) {
    res.writeHead(302, { Location: "/login" });
    res.end();
    return;
  }

  // ── PROTECTED PAGES ──
  res.writeHead(200, { "Content-Type": "text/html" });
  switch (pathname) {
    case "/":         res.end(overviewPage()); break;
    case "/revenue":  res.end(revenuePage()); break;
    case "/activity": res.end(activityPage()); break;
    case "/security": res.end(securityPage()); break;
    case "/payouts":  res.end(payoutsPage()); break;
    default:
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(dashboardLayout("/", `<div class="page-header"><div class="page-title">404 — Not Found</div></div>`));
  }
}

// ── START ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`\n  🔒 Dashboard running at: http://localhost:${PORT}`);
    console.log(`  Password: set in DASHBOARD_PASSWORD env var`);
    console.log(`  Press Ctrl+C to stop\n`);
    auditLog("DASHBOARD_STARTED", { port: PORT });
  });
}

module.exports = { handleRequest };
