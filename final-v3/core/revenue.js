/**
 * core/revenue.js
 * ════════════════
 * Connects to Gumroad API in READ-ONLY mode.
 * Tracks sales, calculates revenue, detects new sales for notifications.
 *
 * SECURITY: This module can ONLY read data. It cannot initiate
 * payouts, issue refunds, or modify your account in any way.
 * Payout control remains 100% with you in the Gumroad dashboard.
 */

const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const config = require("../config");
const { auditLog, assertReadOnlyFinancial } = require("../security/vault");

const DATA_DIR     = path.join(process.cwd(), "data");
const SALES_CACHE  = path.join(DATA_DIR, "sales-cache.json");
const REVENUE_FILE = path.join(DATA_DIR, "revenue.json");

// ── GUMROAD API (READ ONLY) ───────────────────────────────────────────────────

function gumroadGet(endpoint) {
  assertReadOnlyFinancial(endpoint); // throws if not on allowlist

  return new Promise((resolve, reject) => {
    const key = config.gumroad.api_key;
    if (!key) return resolve({ success: false, reason: "no_api_key", sales: [], products: [] });

    const options = {
      hostname: "api.gumroad.com",
      path: endpoint,
      method: "GET",
      headers: { "Authorization": `Bearer ${key}` },
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ success: false, raw: raw.slice(0, 200) }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── SALES TRACKING ────────────────────────────────────────────────────────────

async function fetchRecentSales(days = 7) {
  const after = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

  try {
    const data = await gumroadGet(`/v2/sales?after=${after}`);
    if (data.success === false) {
      // Gumroad key not set — return demo data so the rest of the system works
      return getDemoSales();
    }
    auditLog("GUMROAD_SALES_FETCHED", { count: data.sales?.length || 0 });
    return data.sales || [];
  } catch (err) {
    auditLog("GUMROAD_FETCH_ERROR", { error: err.message }, "warn");
    return [];
  }
}

function getDemoSales() {
  // Returns realistic demo data when Gumroad key not yet configured
  return []; // empty until real sales come in
}

// ── REVENUE CALCULATION ────────────────────────────────────────────────────────

function calculateRevenue(sales) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let today = 0, month = 0, total = 0, count = 0;

  for (const sale of sales) {
    const saleDate = new Date(sale.created_at || sale.sale_timestamp || Date.now());
    const amount = parseFloat(sale.price || sale.amount_cents / 100 || 0);

    total += amount;
    count++;
    if (saleDate >= todayStart) today += amount;
    if (saleDate >= monthStart) month += amount;
  }

  return { today, month, total, count };
}

// ── NEW SALE DETECTION ─────────────────────────────────────────────────────────

function loadSalesCache() {
  if (!fs.existsSync(SALES_CACHE)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(SALES_CACHE, "utf8"));
    return new Set(data.seen_ids || []);
  } catch { return new Set(); }
}

function saveSalesCache(seenIds) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SALES_CACHE, JSON.stringify({ seen_ids: [...seenIds] }, null, 2));
}

function detectNewSales(sales) {
  const seen = loadSalesCache();
  const newSales = sales.filter(s => !seen.has(s.id));

  if (newSales.length > 0) {
    newSales.forEach(s => seen.add(s.id));
    saveSalesCache(seen);
    auditLog("NEW_SALES_DETECTED", { count: newSales.length }, "financial");
  }

  return newSales;
}

// ── SAVE + LOAD REVENUE STATE ─────────────────────────────────────────────────

function saveRevenueState(stats) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = loadRevenueState();
  const updated = {
    ...current,
    ...stats,
    last_updated: new Date().toISOString(),
    history: [
      ...(current.history || []),
      { date: new Date().toISOString().split("T")[0], today: stats.today, total: stats.total }
    ].slice(-90), // keep 90 days
  };
  fs.writeFileSync(REVENUE_FILE, JSON.stringify(updated, null, 2));
  return updated;
}

function loadRevenueState() {
  if (!fs.existsSync(REVENUE_FILE)) {
    return { today: 0, month: 0, total: 0, count: 0, history: [], last_updated: null };
  }
  try { return JSON.parse(fs.readFileSync(REVENUE_FILE, "utf8")); }
  catch { return { today: 0, month: 0, total: 0, count: 0, history: [], last_updated: null }; }
}

// ── PAYOUT INFO ───────────────────────────────────────────────────────────────
// This just explains payout options — the agent never initiates payouts

function getPayoutInfo() {
  return {
    primary: {
      method: "Gumroad → Bank Account (ACH)",
      schedule: "Weekly (set in Gumroad dashboard)",
      control: "YOU only — via Gumroad dashboard",
      url: "https://app.gumroad.com/settings/bank-account",
    },
    secondary: {
      method: "PayPal",
      setup: "Add as payout method in Gumroad settings",
      url: "https://app.gumroad.com/settings/payment",
    },
    crypto: config.payouts.crypto.enabled ? {
      method: `${config.payouts.crypto.currency} wallet`,
      note: "Manual — withdraw from Gumroad, convert via exchange",
      address: config.payouts.crypto.address ? "configured" : "not configured",
    } : { method: "Disabled", note: "Enable in config.js" },
    security_note: "The agent has ZERO ability to move your money. All payouts are controlled exclusively by you in the Gumroad dashboard.",
  };
}

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────

async function runRevenueCheck() {
  const sales = await fetchRecentSales(30);
  const newSales = detectNewSales(sales);
  const stats = calculateRevenue(sales);
  const saved = saveRevenueState(stats);

  return { sales, newSales, stats, saved };
}

module.exports = {
  runRevenueCheck,
  loadRevenueState,
  getPayoutInfo,
  fetchRecentSales,
  detectNewSales,
};
