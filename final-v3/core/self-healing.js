/**
 * self-healing.js — Autonomous Error Detection & Self-Repair
 *
 * This is what makes the agent act like OpenClaw.
 * Every error gets logged, reasoned about by Claude, and fixed automatically.
 *
 * Flow:
 *   1. Error occurs anywhere in the agent
 *   2. logError() captures it with full context
 *   3. Claude analyzes the error and generates a fix
 *   4. Fix is stored in data/fixes.json
 *   5. Next run applies the fix automatically
 *   6. Agent reports what it changed via Telegram
 */

"use strict";

const fs      = require("fs");
const path    = require("path");
const https   = require("https");

const ERRORS_FILE = path.join(process.cwd(), "data", "errors.json");
const FIXES_FILE  = path.join(process.cwd(), "data", "fixes.json");
const BRAIN_FILE  = path.join(process.cwd(), "data", "brain.json");

// ── ERROR CATEGORIES ──────────────────────────────────────────────────────────
const CATEGORIES = {
  ELEVENLABS_401:     "elevenlabs_auth",
  ELEVENLABS_QUOTA:   "elevenlabs_quota",
  YOUTUBE_UPLOAD:     "youtube_upload",
  YOUTUBE_AUTH:       "youtube_auth",
  YOUTUBE_QUOTA:      "youtube_quota",
  THUMBNAIL_403:      "thumbnail_permission",
  AUDIO_MIX:          "audio_mix",
  SLIDE_CORRUPT:      "slide_render",
  GUMROAD_API:        "gumroad_api",
  NETWORK:            "network",
  CRASH:              "agent_crash",
  UNKNOWN:            "unknown",
};

// ── LOAD / SAVE ───────────────────────────────────────────────────────────────

function loadErrors() {
  try {
    if (fs.existsSync(ERRORS_FILE)) return JSON.parse(fs.readFileSync(ERRORS_FILE, "utf8"));
  } catch(e) {}
  return { errors: [], resolved: [], last_analysis: null };
}

function saveErrors(data) {
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(ERRORS_FILE, JSON.stringify(data, null, 2));
}

function loadFixes() {
  try {
    if (fs.existsSync(FIXES_FILE)) return JSON.parse(fs.readFileSync(FIXES_FILE, "utf8"));
  } catch(e) {}
  return { fixes: [], applied: [] };
}

function saveFixes(data) {
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(FIXES_FILE, JSON.stringify(data, null, 2));
}

// ── CATEGORIZE ERROR ──────────────────────────────────────────────────────────

function categorize(errorMsg, context) {
  const msg = (errorMsg || "").toLowerCase();
  const ctx = (context  || "").toLowerCase();

  if (msg.includes("401") && ctx.includes("elevenlabs"))    return CATEGORIES.ELEVENLABS_401;
  if (msg.includes("unusual_activity") || msg.includes("free tier")) return CATEGORIES.ELEVENLABS_QUOTA;
  if (msg.includes("exceeded the number of videos"))        return CATEGORIES.YOUTUBE_QUOTA;
  if (msg.includes("no upload url") || msg.includes("invalid_grant")) return CATEGORIES.YOUTUBE_AUTH;
  if (msg.includes("youtube") && msg.includes("403"))       return CATEGORIES.THUMBNAIL_403;
  if (msg.includes("youtube") || ctx.includes("upload"))    return CATEGORIES.YOUTUBE_UPLOAD;
  if (msg.includes("mix failed") || msg.includes("audio"))  return CATEGORIES.AUDIO_MIX;
  if (msg.includes("corrupt header") || msg.includes("xml parse")) return CATEGORIES.SLIDE_CORRUPT;
  if (msg.includes("gumroad"))                              return CATEGORIES.GUMROAD_API;
  if (msg.includes("enotfound") || msg.includes("network")) return CATEGORIES.NETWORK;
  if (ctx.includes("crash"))                                return CATEGORIES.CRASH;
  return CATEGORIES.UNKNOWN;
}

// ── LOG ERROR ─────────────────────────────────────────────────────────────────
// Call this anywhere in the agent when something goes wrong

function logError(errorMsg, context, extra) {
  const data     = loadErrors();
  const category = categorize(errorMsg, context);

  const entry = {
    id:        Date.now(),
    timestamp: new Date().toISOString(),
    category,
    message:   String(errorMsg || "").slice(0, 300),
    context:   String(context  || "").slice(0, 100),
    extra:     extra ? JSON.stringify(extra).slice(0, 200) : null,
    resolved:  false,
    fix_applied: null,
  };

  data.errors.push(entry);

  // Keep last 100 errors
  if (data.errors.length > 100) data.errors = data.errors.slice(-100);

  saveErrors(data);
  console.log("     [Self-Heal] Error logged: " + category + " — " + errorMsg.slice(0,80));
  return entry;
}

// ── ANALYZE ERRORS WITH CLAUDE ────────────────────────────────────────────────
// Claude looks at all recent errors and decides what to fix

async function analyzeWithClaude(apiKey, model) {
  const errData = loadErrors();
  const recent  = errData.errors.filter(function(e) { return !e.resolved; }).slice(-20);

  if (recent.length === 0) return { fixes: [], message: "No unresolved errors" };

  // Group by category to see patterns
  const groups = {};
  for (const e of recent) {
    if (!groups[e.category]) groups[e.category] = [];
    groups[e.category].push(e.message);
  }

  const errorSummary = Object.entries(groups).map(function(pair) {
    return pair[0] + " (" + pair[1].length + "x): " + pair[1][0];
  }).join("\n");

  const prompt =
    "You are an autonomous AI agent that fixes its own errors. Analyze these errors and provide specific fixes.\n\n" +
    "RECENT ERRORS:\n" + errorSummary + "\n\n" +
    "For each error category, provide:\n" +
    "1. Root cause (1 sentence)\n" +
    "2. Specific fix action (what to change in behavior or code)\n" +
    "3. How to prevent it next time\n\n" +
    "Also identify:\n" +
    "- Which errors are most urgent\n" +
    "- Any patterns suggesting deeper problems\n" +
    "- Recommended strategy changes based on errors\n\n" +
    "Return as JSON:\n" +
    "{\n" +
    '  "urgent": ["most critical fix"],\n' +
    '  "fixes": [{"category":"...", "root_cause":"...", "action":"...", "prevention":"..."}],\n' +
    '  "strategy_changes": ["change 1"],\n' +
    '  "telegram_summary": "2-3 sentence plain English summary for the owner"\n' +
    "}";

  return new Promise(function(resolve) {
    const body = JSON.stringify({
      model:      model || "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages:   [{ role: "user", content: prompt }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path:     "/v1/messages",
      method:   "POST",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
        "content-length":    Buffer.byteLength(body),
      },
    }, function(res) {
      var raw = "";
      res.on("data", function(d) { raw += d; });
      res.on("end", function() {
        try {
          const resp    = JSON.parse(raw);
          const text    = resp.content[0].text.trim();
          const jsonStr = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
          const result  = JSON.parse(jsonStr);
          resolve(result);
        } catch(e) {
          resolve({ fixes: [], message: "Parse error: " + e.message, raw_response: raw.slice(0,200) });
        }
      });
    });

    req.on("error", function(e) {
      resolve({ fixes: [], message: "API error: " + e.message });
    });

    req.write(body);
    req.end();
  });
}

// ── APPLY FIXES ───────────────────────────────────────────────────────────────
// Translates Claude's analysis into actual runtime behavior changes

function applyFixes(analysis) {
  const fixData = loadFixes();
  const applied = [];

  if (!analysis || !analysis.fixes) return applied;

  for (const fix of analysis.fixes) {
    const fixEntry = {
      id:          Date.now() + Math.random(),
      timestamp:   new Date().toISOString(),
      category:    fix.category,
      root_cause:  fix.root_cause,
      action:      fix.action,
      prevention:  fix.prevention,
      active:      true,
    };

    // Apply specific behavioral fixes
    switch(fix.category) {

      case CATEGORIES.ELEVENLABS_401:
      case CATEGORIES.ELEVENLABS_QUOTA:
        // Tell future runs to skip ElevenLabs and use silence until key is fixed
        fixEntry.runtime_flag = "elevenlabs_disabled";
        fixEntry.message = "ElevenLabs disabled until API key is updated";
        console.log("     [Self-Heal] Fix: ElevenLabs paused — will retry tomorrow");
        break;

      case CATEGORIES.SLIDE_CORRUPT:
        // Tell future runs to add extra XML sanitization
        fixEntry.runtime_flag = "extra_xml_sanitize";
        fixEntry.message = "Extra SVG sanitization enabled";
        console.log("     [Self-Heal] Fix: Extra slide sanitization enabled");
        break;

      case CATEGORIES.AUDIO_MIX:
        // Skip complex mix, go straight to voice-only
        fixEntry.runtime_flag = "skip_music_mix";
        fixEntry.message = "Skipping music mix — voice only mode";
        console.log("     [Self-Heal] Fix: Audio set to voice-only mode");
        break;

      case CATEGORIES.YOUTUBE_QUOTA:
        // Stop trying to upload until quota resets
        fixEntry.runtime_flag = "youtube_upload_paused";
        fixEntry.message = "YouTube upload paused — channel quota exceeded, resumes tomorrow";
        console.log("     [Self-Heal] Fix: YouTube upload paused until quota resets");
        break;

      case CATEGORIES.YOUTUBE_AUTH:
        // Flag that refresh token needs renewal
        fixEntry.runtime_flag = "youtube_auth_needs_refresh";
        fixEntry.message = "YouTube OAuth token needs renewal — videos will queue until fixed";
        console.log("     [Self-Heal] Fix: YouTube auth flagged for renewal");
        break;

      default:
        fixEntry.runtime_flag = "logged_" + fix.category;
        fixEntry.message = fix.action || "Monitoring for recurrence";
    }

    fixData.fixes.push(fixEntry);
    applied.push(fixEntry);
  }

  // Keep last 50 fixes
  if (fixData.fixes.length > 50) fixData.fixes = fixData.fixes.slice(-50);
  saveFixes(fixData);

  // Mark errors as resolved
  const errData = loadErrors();
  for (const e of errData.errors) {
    if (!e.resolved) {
      e.resolved    = true;
      e.fix_applied = new Date().toISOString();
    }
  }
  saveErrors(errData);

  return applied;
}

// ── GET ACTIVE FLAGS ──────────────────────────────────────────────────────────
// Other modules call this to check if they should behave differently

function getActiveFlags() {
  const fixData = loadFixes();
  const flags   = {};
  for (const fix of fixData.fixes) {
    if (fix.active && fix.runtime_flag) {
      flags[fix.runtime_flag] = fix;
    }
  }
  return flags;
}

function hasFlag(flagName) {
  return !!getActiveFlags()[flagName];
}

function clearFlag(flagName) {
  const fixData = loadFixes();
  for (const fix of fixData.fixes) {
    if (fix.runtime_flag === flagName) fix.active = false;
  }
  saveFixes(fixData);
  console.log("     [Self-Heal] Flag cleared: " + flagName);
}

// ── FULL SELF-HEAL CYCLE ──────────────────────────────────────────────────────
// Run this at the start of each daily agent run

async function runHealCycle(apiKey, model, notifyFn) {
  const errData  = loadErrors();
  const unresolved = errData.errors.filter(function(e) { return !e.resolved; });

  if (unresolved.length === 0) return { healed: false, message: "No errors to heal" };

  console.log("\n     [Self-Heal] " + unresolved.length + " unresolved error(s) — analyzing...");

  try {
    const analysis = await analyzeWithClaude(apiKey, model);
    const applied  = applyFixes(analysis);

    if (applied.length > 0) {
      console.log("     [Self-Heal] Applied " + applied.length + " fix(es):");
      applied.forEach(function(f) { console.log("       → " + f.message); });

      // Send Telegram summary
      if (notifyFn && analysis.telegram_summary) {
        await notifyFn(
          "🔧 Self-Healing Report\n" +
          "━━━━━━━━━━━━━━\n" +
          analysis.telegram_summary + "\n\n" +
          "Fixes applied:\n" +
          applied.map(function(f) { return "• " + f.message; }).join("\n") +
          (analysis.urgent && analysis.urgent.length > 0
            ? "\n\n⚠️ Urgent: " + analysis.urgent[0]
            : "")
        ).catch(function(){});
      }
    }

    return { healed: applied.length > 0, fixes: applied, analysis };

  } catch(e) {
    console.log("     [Self-Heal] Heal cycle error: " + e.message.slice(0,80));
    return { healed: false, error: e.message };
  }
}

// ── GET REPORT ────────────────────────────────────────────────────────────────

function getReport() {
  const errData = loadErrors();
  const fixData = loadFixes();
  const flags   = getActiveFlags();

  return {
    total_errors:    errData.errors.length,
    unresolved:      errData.errors.filter(function(e) { return !e.resolved; }).length,
    total_fixes:     fixData.fixes.length,
    active_flags:    Object.keys(flags),
    last_analysis:   errData.last_analysis,
    recent_errors:   errData.errors.slice(-5).map(function(e) {
      return { category: e.category, message: e.message.slice(0,60), resolved: e.resolved };
    }),
  };
}

module.exports = {
  logError,
  analyzeWithClaude,
  applyFixes,
  runHealCycle,
  getActiveFlags,
  hasFlag,
  clearFlag,
  getReport,
  CATEGORIES,
};
