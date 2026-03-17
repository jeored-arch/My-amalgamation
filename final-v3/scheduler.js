/**
 * scheduler.js — CLOUD SCHEDULER
 * ════════════════════════════════
 * Keeps the agent running 24/7 on Railway.
 * Wakes the agent every day at 8am (your timezone).
 * Also runs a weekly niche health check every Sunday.
 *
 * This replaces cron/Task Scheduler when running in the cloud.
 * Railway keeps this process alive permanently.
 */

require("dotenv").config();

const { execSync } = require("child_process");
const path         = require("path");
const config       = require("./config");
const { auditLog } = require("./security/vault");
const notify       = require("./notifications/notify");

const TZ = config.owner.timezone || "America/Chicago";

function nowIn(tz) {
  return new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
}

function padded(n) { return String(n).padStart(2, "0"); }

function timeStr(date) {
  return `${padded(date.getHours())}:${padded(date.getMinutes())}`;
}

let lastAgentRun   = null;   // YYYY-MM-DD string
let lastNicheCheck = null;   // YYYY-MM-DD string (weekly)
let isRunning      = false;

async function runAgent() {
  if (isRunning) {
    console.log("  ⏳ Agent already running — skipping duplicate trigger");
    return;
  }
  isRunning = true;
  console.log(`\n  🤖 [${new Date().toISOString()}] Starting daily agent run...`);

  try {
    await new Promise(function(resolve, reject) {
      var child = require("child_process").spawn(
        "node", ["-r", "dotenv/config", "agent.js"],
        { stdio: "inherit", cwd: __dirname }
      );
      var timer = setTimeout(function() {
        child.kill();
        resolve(); // Don't reject — just move on after 90 min
      }, 90 * 60 * 1000);
      child.on("close", function(code) {
        clearTimeout(timer);
        resolve();
      });
      child.on("error", function(err) {
        clearTimeout(timer);
        console.error("  → Spawn error: " + err.message);
        resolve();
      });
    });
    auditLog("SCHEDULED_RUN_COMPLETE", { timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("  ❌ Agent run failed:", err.message);
    auditLog("SCHEDULED_RUN_FAILED", { error: err.message }, "alert");
    await notify.sendTelegram(`🚨 <b>Scheduled run failed</b>\n\nError: ${err.message.slice(0, 200)}\n\nWill retry tomorrow at 8am.`).catch(function(){});
  } finally {
    isRunning = false;
  }
}

async function tick() {
  const now     = nowIn(TZ);
  const today   = `${now.getFullYear()}-${padded(now.getMonth()+1)}-${padded(now.getDate())}`;
  const time    = timeStr(now);
  const dayOfWeek = now.getDay(); // 0=Sun

  // ── DAILY AGENT RUN (8:00am) ──────────────────────────────────────────────
  if (time === "08:00" && lastAgentRun !== today) {
    lastAgentRun = today;
    await runAgent();
  }

  // ── WEEKLY NICHE CHECK (Sunday 9:00am) ───────────────────────────────────
  if (dayOfWeek === 0 && time === "09:00" && lastNicheCheck !== today) {
    lastNicheCheck = today;
    console.log("\n  🔍 Running weekly niche health check...");
    try {
      execSync("node -r dotenv/config scripts/niche-check.js", {
        stdio: "inherit",
        cwd:   __dirname,
        timeout: 10 * 60 * 1000,
      });
    } catch (err) {
      console.error("  ⚠ Niche check failed:", err.message);
    }
  }
}

// ── STARTUP ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║  ⏰  CLOUD SCHEDULER — Running 24/7 on Railway       ║
║  Daily agent: 8:00am ${(TZ || "").padEnd(25)}║
║  Niche check: Sundays 9:00am                         ║
╚══════════════════════════════════════════════════════╝
`);

  auditLog("SCHEDULER_STARTED", { timezone: TZ, platform: "railway" });

  // ── PERSISTENT HTTP SERVER ─────────────────────────────────────────────────
  // Keeps the store alive 24/7 even when agent.js is not running
  try {
    const http = require("http");
    const { handleRequest } = require("./dashboard/server");
    const PORT = parseInt(process.env.PORT || 3000);
    const httpServer = http.createServer(handleRequest);
    httpServer.on("error", function(e) {
      if (e.code === "EADDRINUSE") {
        console.log("  → Port " + PORT + " already in use — store already running");
      } else {
        console.log("  → HTTP server error: " + e.message);
      }
    });
    httpServer.listen(PORT, function() {
      console.log("  ✓  Store running 24/7 at https://" + (process.env.RAILWAY_PUBLIC_DOMAIN || ("localhost:" + PORT)) + "/store");
    });
  } catch(e) {
    console.log("  → Could not start HTTP server: " + e.message);
  }
  // ──────────────────────────────────────────────────────────────────────────

  await notify.sendTelegram(`
☁️ <b>Cloud Scheduler Started</b>

Your agent is now running 24/7 on Railway.
It will wake up automatically at 8:00am (${TZ}) every day.

You don't need to do anything.
Daily report will arrive in your email each morning.
Sale pings will arrive here on Telegram instantly.
  `.trim()).catch(() => {});

  // Check every 30 seconds
  setInterval(tick, 30 * 1000);

  // Run first check immediately in case we missed today's run
  await tick();
}

main().catch(err => {
  console.error("Scheduler crashed:", err.message);
  process.exit(1);
});
