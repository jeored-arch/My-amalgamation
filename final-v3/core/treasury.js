/**
 * core/treasury.js — THE MONEY BRAIN
 * ════════════════════════════════════
 * Controls every dollar this business makes.
 * Your cut always comes first. Agent never touches your money.
 *
 * SPLIT TIERS (monthly revenue):
 *   $0    - $2,999  → You 60% | Agent 40%
 *   $3,000 - $6,999 → You 65% | Agent 35%
 *   $7,000 - $9,999 → You 70% | Agent 30%
 *   $10,000+        → You 70% ($7k+) | Agent 30%
 *
 * UNLOCK RULES:
 *   - $500 must be confirmed in YOUR bank before any paid unlock
 *   - Agent notifies you via Telegram when threshold hit
 *   - You have 48hrs to respond — no response = auto-unlock
 *   - Agent pays ALL upgrade costs from its own 40% budget
 *   - Your 60% is NEVER touched for operating costs
 */

const fs   = require("fs");
const path = require("path");
const { auditLog } = require("../security/vault");

const DATA_DIR      = path.join(process.cwd(), "data");
const TREASURY_FILE = path.join(DATA_DIR, "treasury.json");
const UNLOCK_FILE   = path.join(DATA_DIR, "unlocks.json");

// ── REVENUE TIERS ─────────────────────────────────────────────────────────────

const TIERS = [
  { min: 0,     max: 2999,    owner: 60, agent: 40, label: "Starter"  },
  { min: 3000,  max: 6999,    owner: 65, agent: 35, label: "Growing"  },
  { min: 7000,  max: 9999,    owner: 70, agent: 30, label: "Scaling"  },
  { min: 10000, max: Infinity, owner: 70, agent: 30, label: "10K Club" },
];

// ── MODULE UNLOCK DEFINITIONS ─────────────────────────────────────────────────

const MODULES = {
  youtube: {
    id:               "youtube",
    name:             "YouTube Automation",
    description:      "Scripts, uploads, SEO-optimized titles/descriptions daily",
    monthly_cost:     0,
    unlock_threshold: 0,      // FREE — unlocks immediately on first run
    owner_bank_min:   0,      // no minimum — it's free
    paid:             false,
    revenue_est:      "$50–400/mo (scales with subscribers)",
    priority:         1,
  },
  printify: {
    id:               "printify",
    name:             "Print-on-Demand (Printify + Etsy)",
    description:      "Auto-designs and lists t-shirts, mugs, posters on Etsy",
    monthly_cost:     0,
    unlock_threshold: 500,    // $500 banked by owner
    owner_bank_min:   500,
    paid:             false,
    revenue_est:      "$100–600/mo",
    priority:         2,
  },
  ai_video: {
    id:               "ai_video",
    name:             "AI Video Generation (Runway ML)",
    description:      "Cinematic AI clips for YouTube Shorts + Reels",
    monthly_cost:     15,
    unlock_threshold: 1000,
    owner_bank_min:   1000,
    paid:             true,
    revenue_est:      "$200–800/mo additional reach",
    priority:         3,
  },
  ai_images: {
    id:               "ai_images",
    name:             "AI Image Generation (DALL-E 3)",
    description:      "Product images, thumbnails, Etsy designs, ad creatives",
    monthly_cost:     15,
    unlock_threshold: 2000,
    owner_bank_min:   2000,
    paid:             true,
    revenue_est:      "+20–40% conversion lift across all channels",
    priority:         4,
  },
};

// ── LOAD / SAVE ───────────────────────────────────────────────────────────────

function loadTreasury() {
  if (fs.existsSync(TREASURY_FILE)) {
    try { return JSON.parse(fs.readFileSync(TREASURY_FILE, "utf8")); }
    catch {}
  }
  return {
    lifetime_revenue:     0,
    lifetime_owner_paid:  0,
    lifetime_agent_spent: 0,
    agent_budget:         0,    // agent's available balance
    monthly_revenue:      0,    // resets each month
    month_key:            currentMonthKey(),
    current_tier:         "Starter",
    owner_bank_estimate:  0,    // estimated cumulative paid to owner's bank
    history:              [],
    last_updated:         null,
  };
}

function saveTreasury(t) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TREASURY_FILE, JSON.stringify({
    ...t, last_updated: new Date().toISOString()
  }, null, 2));
}

function loadUnlocks() {
  if (fs.existsSync(UNLOCK_FILE)) {
    try { return JSON.parse(fs.readFileSync(UNLOCK_FILE, "utf8")); }
    catch {}
  }
  // Default: YouTube active immediately (free), others locked
  return {
    youtube:   { status: "active",  activated_at: new Date().toISOString(), monthly_cost: 0 },
    printify:  { status: "locked",  notified_at: null, auto_unlock_at: null, monthly_cost: 0 },
    ai_video:  { status: "locked",  notified_at: null, auto_unlock_at: null, monthly_cost: 15 },
    ai_images: { status: "locked",  notified_at: null, auto_unlock_at: null, monthly_cost: 15 },
  };
}

function saveUnlocks(u) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(UNLOCK_FILE, JSON.stringify(u, null, 2));
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ── GET CURRENT TIER ──────────────────────────────────────────────────────────

function getTier(monthly_revenue) {
  return TIERS.find(t => monthly_revenue >= t.min && monthly_revenue <= t.max) || TIERS[0];
}

// ── PROCESS REVENUE ───────────────────────────────────────────────────────────
// Called every time new sales come in. Splits correctly, logs everything.

function processRevenue(new_amount) {
  const treasury = loadTreasury();

  // Reset monthly counter if new month
  if (treasury.month_key !== currentMonthKey()) {
    treasury.last_month_revenue = treasury.monthly_revenue;
    treasury.monthly_revenue    = 0;
    treasury.month_key          = currentMonthKey();
    auditLog("MONTHLY_RESET", { last_month: treasury.last_month_revenue }, "financial");
  }

  treasury.monthly_revenue += new_amount;
  const tier = getTier(treasury.monthly_revenue);

  const owner_cut = parseFloat((new_amount * (tier.owner / 100)).toFixed(2));
  const agent_cut = parseFloat((new_amount * (tier.agent / 100)).toFixed(2));

  treasury.lifetime_revenue    += new_amount;
  treasury.lifetime_owner_paid += owner_cut;
  treasury.agent_budget        += agent_cut;
  treasury.owner_bank_estimate += owner_cut;
  treasury.current_tier         = tier.label;

  treasury.history.push({
    date:      new Date().toISOString(),
    amount:    new_amount,
    owner_cut,
    agent_cut,
    tier:      tier.label,
    owner_pct: tier.owner,
    agent_pct: tier.agent,
  });
  if (treasury.history.length > 365) treasury.history = treasury.history.slice(-365);

  saveTreasury(treasury);

  auditLog("REVENUE_SPLIT", {
    amount: new_amount, owner_cut, agent_cut,
    tier: tier.label, monthly_total: treasury.monthly_revenue,
  }, "financial");

  return { treasury, owner_cut, agent_cut, tier };
}

// ── PAY OPERATING COSTS ───────────────────────────────────────────────────────
// Deducts module subscription costs from AGENT budget only

function payOperatingCosts() {
  const treasury = loadTreasury();
  const unlocks  = loadUnlocks();

  let total_cost = 0;
  const payments = [];

  for (const [id, unlock] of Object.entries(unlocks)) {
    if (unlock.status === "active" && unlock.monthly_cost > 0) {
      const mod = MODULES[id];
      if (treasury.agent_budget >= unlock.monthly_cost) {
        treasury.agent_budget        -= unlock.monthly_cost;
        treasury.lifetime_agent_spent += unlock.monthly_cost;
        total_cost += unlock.monthly_cost;
        payments.push({ module: id, cost: unlock.monthly_cost });
        auditLog("OPERATING_COST_PAID", { module: id, cost: unlock.monthly_cost, from: "agent_budget" }, "financial");
      } else {
        // Can't afford it — deactivate the module
        unlocks[id].status = "suspended_insufficient_funds";
        auditLog("MODULE_SUSPENDED", { module: id, reason: "insufficient agent budget" }, "financial");
      }
    }
  }

  if (total_cost > 0) {
    saveTreasury(treasury);
    saveUnlocks(unlocks);
  }

  return { total_cost, payments };
}

// ── CHECK UNLOCK ELIGIBILITY ──────────────────────────────────────────────────

function checkUnlockEligibility() {
  const treasury = loadTreasury();
  const unlocks  = loadUnlocks();
  const eligible = [];

  for (const [id, mod] of Object.entries(MODULES)) {
    const unlock = unlocks[id];
    if (unlock.status !== "locked") continue;

    const owner_banked = treasury.owner_bank_estimate;
    const meets_bank   = owner_banked >= mod.owner_bank_min;
    const meets_budget = mod.paid
      ? treasury.agent_budget >= mod.monthly_cost * 3   // 3 months buffer
      : true;

    if (meets_bank && meets_budget) {
      eligible.push({ ...mod, owner_banked, agent_budget: treasury.agent_budget });
    }
  }

  return eligible;
}

// ── PROCESS UNLOCK QUEUE ──────────────────────────────────────────────────────
// Check pending unlocks — auto-activate if 48hrs passed

function processUnlockQueue() {
  const unlocks   = loadUnlocks();
  const activated = [];
  const now       = new Date();

  for (const [id, unlock] of Object.entries(unlocks)) {
    if (unlock.status === "pending_approval" && unlock.auto_unlock_at) {
      if (new Date(unlock.auto_unlock_at) <= now) {
        unlocks[id].status       = "active";
        unlocks[id].activated_at = now.toISOString();
        activated.push(id);
        auditLog("MODULE_AUTO_UNLOCKED", { module: id, reason: "48hr timeout" }, "financial");
      }
    }
  }

  if (activated.length > 0) saveUnlocks(unlocks);
  return activated;
}

// ── INITIATE UNLOCK NOTIFICATION ─────────────────────────────────────────────
// Marks module as pending, sets 48hr auto-unlock timer

function initiateUnlock(module_id) {
  const unlocks = loadUnlocks();
  const now     = new Date();
  const autoAt  = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  unlocks[module_id].status         = "pending_approval";
  unlocks[module_id].notified_at    = now.toISOString();
  unlocks[module_id].auto_unlock_at = autoAt.toISOString();

  saveUnlocks(unlocks);
  auditLog("UNLOCK_INITIATED", { module: module_id, auto_unlock_at: autoAt.toISOString() }, "financial");

  return { module_id, auto_unlock_at: autoAt };
}

// ── MANUAL APPROVE / REJECT ───────────────────────────────────────────────────

function approveUnlock(module_id) {
  const unlocks = loadUnlocks();
  unlocks[module_id].status       = "active";
  unlocks[module_id].activated_at = new Date().toISOString();
  saveUnlocks(unlocks);
  auditLog("UNLOCK_APPROVED", { module: module_id }, "financial");
}

function rejectUnlock(module_id) {
  const unlocks = loadUnlocks();
  unlocks[module_id].status = "locked";
  unlocks[module_id].notified_at    = null;
  unlocks[module_id].auto_unlock_at = null;
  saveUnlocks(unlocks);
  auditLog("UNLOCK_REJECTED", { module: module_id }, "financial");
}

// ── GET FULL FINANCIAL STATUS ─────────────────────────────────────────────────

function getStatus() {
  const treasury = loadTreasury();
  const unlocks  = loadUnlocks();
  const tier     = getTier(treasury.monthly_revenue);
  const active_modules = Object.entries(unlocks)
    .filter(([, u]) => u.status === "active")
    .map(([id]) => MODULES[id]?.name || id);
  const monthly_costs = Object.entries(unlocks)
    .filter(([, u]) => u.status === "active")
    .reduce((sum, [, u]) => sum + (u.monthly_cost || 0), 0);

  return {
    tier,
    monthly_revenue:    treasury.monthly_revenue,
    lifetime_revenue:   treasury.lifetime_revenue,
    owner_total_earned: treasury.lifetime_owner_paid,
    agent_budget:       parseFloat(treasury.agent_budget.toFixed(2)),
    monthly_costs,
    net_agent_budget:   parseFloat((treasury.agent_budget - monthly_costs).toFixed(2)),
    active_modules,
    unlocks,
    next_unlock:        getNextUnlock(treasury, unlocks),
  };
}

function getNextUnlock(treasury, unlocks) {
  for (const mod of Object.values(MODULES).sort((a, b) => a.priority - b.priority)) {
    if (unlocks[mod.id]?.status === "locked") {
      const needed = mod.owner_bank_min - treasury.owner_bank_estimate;
      return {
        module:  mod.name,
        cost:    mod.monthly_cost,
        need:    Math.max(0, needed),
        message: needed <= 0
          ? `${mod.name} ready to unlock!`
          : `$${needed.toFixed(0)} more to your bank unlocks ${mod.name}`,
      };
    }
  }
  return { message: "All modules unlocked!" };
}

module.exports = {
  MODULES, TIERS,
  loadTreasury, saveTreasury,
  loadUnlocks,  saveUnlocks,
  getTier, processRevenue, payOperatingCosts,
  checkUnlockEligibility, processUnlockQueue,
  initiateUnlock, approveUnlock, rejectUnlock,
  getStatus,
};
