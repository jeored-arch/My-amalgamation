require("dotenv").config();
const { execSync, spawn } = require("child_process");
const TZ = process.env.TZ || "America/Chicago";

function nowIn(tz) { return new Date(new Date().toLocaleString("en-US", { timeZone: tz })); }
function padded(n) { return String(n).padStart(2, "0"); }
function timeStr(d) { return padded(d.getHours()) + ":" + padded(d.getMinutes()); }

var lastAgentRun = null;
var lastNicheCheck = null;
var isRunning = false;

function startBot() {
  try {
    var bot = spawn("node", ["-r", "dotenv/config", "notifications/telegram-bot.js"], {
      cwd: __dirname,
      stdio: "inherit",
      detached: false,
    });
    bot.on("exit", function(code) {
      console.log("Bot exited - restarting in 5s...");
      setTimeout(startBot, 5000);
    });
    console.log("Telegram bot started");
  } catch (e) {
    console.log("Bot failed: " + e.message);
    setTimeout(startBot, 10000);
  }
}

function runAgent() {
  if (isRunning) { return; }
  isRunning = true;
  console.log("Starting daily agent run...");
  try {
    execSync("node -r dotenv/config agent.js", {
      stdio: "inherit",
      cwd: __dirname,
      timeout: 1800000,
    });
  } catch (err) {
    console.error("Agent failed: " + err.message);
  }
  isRunning = false;
}

function tick() {
  var now = nowIn(TZ);
  var today = now.getFullYear() + "-" + padded(now.getMonth() + 1) + "-" + padded(now.getDate());
  var time = timeStr(now);
  var day = now.getDay();

  if (time === "08:00" && lastAgentRun !== today) {
    lastAgentRun = today;
    runAgent();
  }

  if (day === 0 && time === "09:00" && lastNicheCheck !== today) {
    lastNicheCheck = today;
    try {
      execSync("node -r dotenv/config scripts/niche-check.js", {
        stdio: "inherit",
        cwd: __dirname,
        timeout: 600000,
      });
    } catch (e) {
      console.error("Niche check failed: " + e.message);
    }
  }
}

console.log("Scheduler starting on Railway...");
console.log("Daily agent: 8am " + TZ);
startBot();
setInterval(tick, 30000);
tick();
