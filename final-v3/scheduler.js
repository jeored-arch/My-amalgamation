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

// ── VIDEO FREQUENCY CONFIG ────────────────────────────────────────────────────
// Alternates between 2-day and 3-day gaps to average ~2.5 days between videos.
// Saves ~40% on ElevenLabs credits vs daily posting.
// Pattern: post on day 0, skip day 1, post day 2, skip days 3+4, post day 5...
var RUN_INTERVALS = [2, 3]; // days between runs, alternates
var intervalIndex = 0;      // which interval we're currently using
var lastRunDate   = null;   // Date object of last successful run

function isDueToRun(now) {
  if (!lastRunDate) return true; // never run before — go immediately
  var gapDays = RUN_INTERVALS[intervalIndex % RUN_INTERVALS.length];
  var msSinceRun = now - lastRunDate;
  var daysSinceRun = msSinceRun / (1000 * 60 * 60 * 24);
  return daysSinceRun >= gapDays;
}

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

  // ── VIDEO RUN (every 2-3 days at 8:00am) ─────────────────────────────────
  // Alternates 2-day / 3-day gaps to save ~40% on ElevenLabs credits.
  if (time === "08:00" && lastAgentRun !== today && isDueToRun(now)) {
    lastAgentRun = today;
    lastRunDate  = now;
    intervalIndex++;
    var nextGap = RUN_INTERVALS[intervalIndex % RUN_INTERVALS.length];
    console.log("  📅 Video scheduled — next run in " + nextGap + " days");
    await notify.sendTelegram("📅 <b>Agent running today</b>\nNext video in " + nextGap + " days\nSaving ElevenLabs credits between runs.").catch(function(){});
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
║  Videos: every 2-3 days 8:00am ${(TZ || "").padEnd(25)}║
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
Videos post every 2-3 days at 8:00am (${TZ}).
This saves ~40% on ElevenLabs credits.

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
