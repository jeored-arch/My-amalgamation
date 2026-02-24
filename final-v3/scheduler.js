require("dotenv").config();

const { execSync } = require("child_process");
const path = require("path");
const fs   = require("fs");

const TZ = process.env.TZ || "America/Chicago";

function nowIn(tz) {
  return new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
}

function padded(n) { return String(n).padStart(2, "0"); }
function timeStr(d) { return `${padded(d.getHours())}:${padded(d.getMinutes())}`; }

let lastAgentRun   = null;
let lastNicheCheck = null;
let isRunning      = false;

function startBot() {
  try {
    const { spawn } = require("child_process");
    const bot = spawn("node", ["-r", "dotenv/config", "notifications/telegram-bot.js"], {
      cwd:      __dirname,
      stdio:    "inherit",
      detached: false,
    });
    bot.on("exit", (code) => {
      console.log(`  📱 Bot exited (${code}) — restarting in 5 seconds...`);
      setTimeout(startBot, 5000);
    });
    console.log("  📱 Telegram bot started");
  } catch (e) {
    console.log(`  ⚠ Bot failed to start: ${e.message}`);
    setTimeout(startBot, 10000);
  }
}

async function runAgent() {
  if (isRunning) return;
  isRunning = true;
  console.log(`\n  🤖 [${new Date().toISOString()}] Starting daily agent run...`);
  try {
    execSync("node -r dotenv/config agent.js", {
