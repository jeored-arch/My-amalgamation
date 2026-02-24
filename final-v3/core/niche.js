/**
 * core/niche.js — SMART NICHE ENGINE
 * ════════════════════════════════════
 * The agent's niche intelligence system.
 *
 * HOW IT WORKS:
 * 1. On first run: researches 20+ niches, scores each on 5 criteria,
 *    picks the best one, tells you via Telegram what it chose and why
 * 2. Every 7 days: checks performance metrics against targets
 * 3. If a niche is underperforming after 30 days: auto-pivots,
 *    notifies you, explains the switch, starts fresh in new niche
 * 4. Keeps history of all niches tried so it never repeats a failure
 *
 * SCORING CRITERIA (each 0-10):
 *   - YouTube RPM potential (higher = more ad revenue per 1k views)
 *   - Search demand (people actively looking for this content)
 *   - Competition gap (demand exists but quality content is lacking)
 *   - Affiliate product availability (products to recommend for commission)
 *   - Etsy/product viability (can we sell physical/digital products here)
 *
 * PIVOT TRIGGERS (any one of these = consider switching):
 *   - After 30 days: fewer than 3 Gumroad sales
 *   - After 45 days: YouTube under 200 views total
 *   - After 60 days: Etsy under 50 impressions
 *   - Monthly revenue growth under 10% for 2 consecutive months
 */

const fs   = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const config  = require("../config");
const { auditLog } = require("../security/vault");
const notify  = require("../notifications/notify");

const client    = new Anthropic({ apiKey: config.anthropic.api_key });
const DATA_DIR  = path.join(process.cwd(), "data");
const NICHE_FILE = path.join(DATA_DIR, "niche-history.json");

// ── NICHE CANDIDATES ──────────────────────────────────────────────────────────
// Pre-seeded list of proven high-RPM niches with known characteristics.
// Agent scores these + discovers more via AI research.

const SEED_NICHES = [
  { name: "AI tools for small business",       rpm: 9, demand: 9, gap: 8, affiliate: 9, etsy: 7 },
  { name: "Personal finance for millennials",  rpm: 9, demand: 9, gap: 6, affiliate: 8, etsy: 6 },
  { name: "Passive income strategies 2025",    rpm: 8, demand: 9, gap: 7, affiliate: 8, etsy: 8 },
  { name: "AI productivity for solopreneurs",  rpm: 8, demand: 8, gap: 8, affiliate: 9, etsy: 8 },
  { name: "Credit repair and building",        rpm: 9, demand: 8, gap: 7, affiliate: 7, etsy: 6 },
  { name: "Side hustles for 9-5 workers",      rpm: 7, demand: 9, gap: 6, affiliate: 8, etsy: 9 },
  { name: "Etsy seller tips and tools",        rpm: 7, demand: 8, gap: 7, affiliate: 7, etsy: 9 },
  { name: "ChatGPT for everyday use",          rpm: 8, demand: 9, gap: 7, affiliate: 8, etsy: 7 },
  { name: "Digital products business",         rpm: 7, demand: 8, gap: 7, affiliate: 7, etsy: 9 },
  { name: "Notion productivity systems",       rpm: 7, demand: 8, gap: 6, affiliate: 7, etsy: 9 },
  { name: "Amazon FBA for beginners",          rpm: 8, demand: 8, gap: 6, affiliate: 8, etsy: 5 },
  { name: "Real estate investing basics",      rpm: 9, demand: 8, gap: 6, affiliate: 7, etsy: 6 },
  { name: "YouTube automation business",       rpm: 8, demand: 8, gap: 7, affiliate: 8, etsy: 7 },
  { name: "Email marketing for creators",      rpm: 7, demand: 7, gap: 8, affiliate: 8, etsy: 7 },
  { name: "Canva design for entrepreneurs",    rpm: 6, demand: 8, gap: 7, affiliate: 7, etsy: 9 },
];

// ── SCORING ───────────────────────────────────────────────────────────────────

function scoreNiche(niche) {
  // Weighted score: RPM matters most for YouTube, demand for all channels
  const score = (
    (niche.rpm       * 2.0) +  // YouTube monetization potential
    (niche.demand    * 2.0) +  // Search volume / audience size
    (niche.gap       * 1.5) +  // Competition gap (easier to rank)
    (niche.affiliate * 1.5) +  // Commission revenue potential
    (niche.etsy      * 1.0)    // Product sales potential
  ) / 8.0;

  return parseFloat(score.toFixed(2));
}

// ── LOAD / SAVE NICHE STATE ───────────────────────────────────────────────────

function loadNicheHistory() {
  if (fs.existsSync(NICHE_FILE)) {
    try { return JSON.parse(fs.readFileSync(NICHE_FILE, "utf8")); }
    catch {}
  }
  return {
    current:       null,   // { name, score, started_at, pivot_count }
    history:       [],     // all niches tried, with reason for leaving
    failed:        [],     // niches that flopped — never retry these
    pivot_count:   0,
    last_evaluated: null,
  };
}

function saveNicheHistory(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NICHE_FILE, JSON.stringify(
    { ...state, last_updated: new Date().toISOString() }, null, 2
  ));
}

// ── AI RESEARCH ───────────────────────────────────────────────────────────────
// Uses Claude to discover additional niches and validate scoring

async function researchAdditionalNiches(failed_niches = []) {
  const failedList = failed_niches.join(", ") || "none";

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 2000,
    system: "You are an expert YouTube channel strategist and digital product market researcher. You have deep knowledge of which niches make money in 2025.",
    messages: [{
      role: "user",
      content: `Research and identify 10 high-potential niches for a fully autonomous AI business in 2025.

The business runs: YouTube faceless channel + Gumroad digital products + Etsy print-on-demand.

REQUIREMENTS for a good niche:
- High YouTube RPM ($5+) — finance, AI, business, productivity score highest
- Strong evergreen search demand (not just a trend)
- Underserved — lots of search volume but weak existing content
- Has affiliate products with 20%+ commissions
- Works for Etsy products (quotes, designs, planners related to niche)

AVOID: overly saturated niches, niches requiring personal brand, seasonal only niches.
FAILED niches to exclude: ${failedList}

For each niche score it 1-10 on: rpm, demand, gap, affiliate, etsy

Return ONLY a JSON array:
[
  {
    "name": "niche name",
    "rpm": 8,
    "demand": 9,
    "gap": 7,
    "affiliate": 8,
    "etsy": 7,
    "reasoning": "one sentence why this wins right now"
  }
]`
    }]
  });

  try {
    const text  = response.content[0].text;
    const clean = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return [];
  }
}

// ── PICK BEST NICHE ───────────────────────────────────────────────────────────

async function pickBestNiche(failed_niches = []) {
  console.log("     → Researching niches with AI...");

  // Get AI-researched niches
  const aiNiches = await researchAdditionalNiches(failed_niches);

  // Combine seed + AI niches, filter out failed ones
  const allNiches = [...SEED_NICHES, ...aiNiches]
    .filter(n => !failed_niches.includes(n.name));

  // Score all niches
  const scored = allNiches
    .map(n => ({ ...n, score: scoreNiche(n) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const top3 = scored.slice(0, 3);

  console.log(`     → Top niche selected: "${best.name}" (score: ${best.score}/10)`);
  console.log(`     → Runner-ups: ${top3.slice(1).map(n => n.name).join(" | ")}`);

  auditLog("NICHE_SELECTED", {
    niche: best.name,
    score: best.score,
    scores: { rpm: best.rpm, demand: best.demand, gap: best.gap },
  });

  return { best, top3, all_scored: scored };
}

// ── PERFORMANCE EVALUATION ────────────────────────────────────────────────────
// Called weekly to assess whether current niche is working

function evaluatePerformance(nicheState, metrics) {
  const {
    days_active     = 0,
    gumroad_sales   = 0,
    youtube_views   = 0,
    etsy_impressions = 0,
    monthly_revenue = 0,
    prev_month_revenue = 0,
  } = metrics;

  const issues   = [];
  const warnings = [];
  let should_pivot = false;

  // Hard pivot triggers (definitive underperformance)
  if (days_active >= 30 && gumroad_sales < 3) {
    issues.push(`Only ${gumroad_sales} Gumroad sales after ${days_active} days (target: 3+)`);
    should_pivot = true;
  }
  if (days_active >= 45 && youtube_views < 200) {
    issues.push(`Only ${youtube_views} YouTube views after ${days_active} days (target: 200+)`);
    should_pivot = true;
  }
  if (days_active >= 60 && etsy_impressions < 50) {
    issues.push(`Only ${etsy_impressions} Etsy impressions after ${days_active} days (target: 50+)`);
    should_pivot = true;
  }

  // Growth stall warning (2 months of <10% growth)
  if (days_active >= 60 && prev_month_revenue > 0) {
    const growth = (monthly_revenue - prev_month_revenue) / prev_month_revenue;
    if (growth < 0.10) {
      warnings.push(`Revenue growth only ${(growth * 100).toFixed(1)}% (target: 10%+/mo)`);
      if (days_active >= 90) {
        issues.push("Revenue stalled for 90+ days — niche exhausted");
        should_pivot = true;
      }
    }
  }

  // Early warning signs (don't pivot yet, but flag)
  if (days_active >= 14 && gumroad_sales === 0) {
    warnings.push("No Gumroad sales yet after 2 weeks — consider checking cold email quality");
  }
  if (days_active >= 21 && youtube_views < 50) {
    warnings.push("YouTube views very low — check title/thumbnail optimization");
  }

  return { should_pivot, issues, warnings, days_active };
}

// ── AUTO PIVOT ────────────────────────────────────────────────────────────────

async function executePivot(reason, currentNiche, agentState) {
  const history = loadNicheHistory();

  // Mark current niche as failed
  history.failed.push(currentNiche);
  history.history.push({
    name:      currentNiche,
    started:   history.current?.started_at,
    ended:     new Date().toISOString(),
    reason,
    pivot_num: history.pivot_count + 1,
  });
  history.pivot_count++;

  // Pick new niche avoiding all failed ones
  console.log("\n  🔄 Pivoting niche...");
  const { best, top3 } = await pickBestNiche(history.failed);

  // Update state
  history.current = {
    name:       best.name,
    score:      best.score,
    started_at: new Date().toISOString(),
    pivot_num:  history.pivot_count,
    reasoning:  best.reasoning,
  };
  history.last_evaluated = new Date().toISOString();
  saveNicheHistory(history);

  // Notify owner
  await notify.sendTelegram(`
🔄 <b>Niche Auto-Pivot — Day ${agentState.day}</b>

The agent detected underperformance and has switched niches automatically.

<b>Left:</b> ${currentNiche}
<b>Reason:</b> ${reason}

<b>New niche:</b> ${best.name}
<b>Score:</b> ${best.score}/10
<b>Why:</b> ${best.reasoning || "High RPM + strong demand + competition gap"}

<b>Also considered:</b>
${top3.slice(1).map(n => `• ${n.name} (${n.score}/10)`).join("\n")}

The agent is rebuilding content strategy for the new niche now.
No action needed from you.
  `.trim());

  auditLog("NICHE_PIVOT", {
    from: currentNiche,
    to:   best.name,
    reason,
    pivot_number: history.pivot_count,
  });

  return { new_niche: best.name, pivot_count: history.pivot_count };
}

// ── WEEKLY CHECK ──────────────────────────────────────────────────────────────

async function weeklyNicheCheck(agentState, revenueStats) {
  const history = loadNicheHistory();
  if (!history.current) return { status: "no_niche_set" };

  const started   = new Date(history.current.started_at);
  const days_active = Math.floor((Date.now() - started.getTime()) / 86400000);

  // Build metrics from agent state
  const metrics = {
    days_active,
    gumroad_sales:    revenueStats.count          || 0,
    youtube_views:    agentState.youtube_views_total || 0,
    etsy_impressions: agentState.etsy_impressions  || 0,
    monthly_revenue:  revenueStats.month           || 0,
    prev_month_revenue: agentState.prev_month_revenue || 0,
  };

  const evaluation = evaluatePerformance(history.current, metrics);
  history.last_evaluated = new Date().toISOString();

  // Send weekly status via Telegram
  const statusEmoji = evaluation.should_pivot ? "🔴" : evaluation.warnings.length > 0 ? "🟡" : "🟢";

  await notify.sendTelegram(`
${statusEmoji} <b>Weekly Niche Report — Day ${agentState.day}</b>

<b>Current niche:</b> ${history.current.name}
<b>Active for:</b> ${days_active} days
<b>Score:</b> ${history.current.score}/10

<b>Performance:</b>
• Gumroad sales: ${metrics.gumroad_sales}
• YouTube views: ${metrics.youtube_views}
• Monthly revenue: $${metrics.monthly_revenue.toFixed(2)}

${evaluation.warnings.length > 0 ? `⚠️ <b>Warnings:</b>\n${evaluation.warnings.map(w => `• ${w}`).join("\n")}` : ""}
${evaluation.issues.length > 0 ? `🔴 <b>Issues:</b>\n${evaluation.issues.map(i => `• ${i}`).join("\n")}` : ""}
${evaluation.should_pivot ? "\n<b>→ Auto-pivoting to better niche now...</b>" : "\n✅ Niche is performing — staying the course."}
  `.trim());

  if (evaluation.should_pivot) {
    const reason = evaluation.issues[0] || "Underperformance detected";
    return await executePivot(reason, history.current.name, agentState);
  }

  saveNicheHistory(history);
  return { status: "staying", evaluation, niche: history.current.name };
}

// ── INITIALIZE NICHE (first run) ─────────────────────────────────────────────

async function initializeNiche() {
  const history = loadNicheHistory();

  // Already has a niche — don't change it
  if (history.current) return history.current.name;

  console.log("\n  🎯 Selecting optimal niche...");
  const { best, top3 } = await pickBestNiche([]);

  history.current = {
    name:       best.name,
    score:      best.score,
    started_at: new Date().toISOString(),
    pivot_num:  0,
    reasoning:  best.reasoning,
    scores: {
      rpm: best.rpm, demand: best.demand, gap: best.gap,
      affiliate: best.affiliate, etsy: best.etsy,
    },
  };
  history.last_evaluated = new Date().toISOString();
  saveNicheHistory(history);

  // Tell owner what was picked and why
  await notify.sendTelegram(`
🎯 <b>Niche Selected — Agent Day 1</b>

After scoring ${SEED_NICHES.length}+ niches across 5 criteria, your business will operate in:

<b>"${best.name}"</b>
Score: ${best.score}/10

Why this wins:
• YouTube RPM: ${best.rpm}/10 — high ad revenue per 1,000 views
• Search demand: ${best.demand}/10 — people actively searching
• Competition gap: ${best.gap}/10 — underserved, easier to rank
• Affiliate products: ${best.affiliate}/10 — strong commission potential
• Etsy viability: ${best.etsy}/10 — great for products

${best.reasoning ? `Agent reasoning: ${best.reasoning}` : ""}

<b>Also scored highly:</b>
${top3.slice(1).map(n => `• ${n.name} (${n.score}/10)`).join("\n")}

The agent will monitor this niche weekly and auto-pivot if it underperforms.
No action needed from you.
  `.trim());

  auditLog("NICHE_INITIALIZED", { niche: best.name, score: best.score });
  return best.name;
}

// ── GET CURRENT STATUS ────────────────────────────────────────────────────────

function getCurrentNiche() {
  const history = loadNicheHistory();
  return history.current?.name || null;
}

function getNicheStatus() {
  const history = loadNicheHistory();
  if (!history.current) return { status: "not_set" };

  const days = Math.floor(
    (Date.now() - new Date(history.current.started_at).getTime()) / 86400000
  );

  return {
    niche:        history.current.name,
    score:        history.current.score,
    days_active:  days,
    pivot_count:  history.pivot_count,
    pivots_tried: history.history.map(h => h.name),
    last_checked: history.last_evaluated,
  };
}

module.exports = {
  initializeNiche,
  getCurrentNiche,
  getNicheStatus,
  weeklyNicheCheck,
  pickBestNiche,
  evaluatePerformance,
  executePivot,
};
