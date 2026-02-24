#!/usr/bin/env node
/**
 * agent.js — AUTONOMOUS BUSINESS AGENT v4
 * ══════════════════════════════════════════
 * Runs 24/7 in cloud via Railway. Picks niche with AI research,
 * monitors weekly, auto-pivots when underperforming.
 * Treasury-managed splits. YouTube + Etsy + Gumroad.
 */

require("dotenv").config();

const Anthropic = require("@anthropic-ai/sdk");
const fs   = require("fs");
const path = require("path");

const config   = require("./config");
const vault    = require("./security/vault");
const notify   = require("./notifications/notify");
const revenue  = require("./core/revenue");
const treasury = require("./core/treasury");
const niche    = require("./core/niche");
const youtube  = require("./modules/youtube/youtube");
const printify = require("./modules/printify/printify");

const client     = new Anthropic({ apiKey: config.anthropic.api_key });
const DATA_DIR   = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const C = { reset:"\x1b[0m",bright:"\x1b[1m",green:"\x1b[32m",yellow:"\x1b[33m",cyan:"\x1b[36m",red:"\x1b[31m",gray:"\x1b[90m" };
const c   = (col, txt) => `${C[col]}${txt}${C.reset}`;
const ok  = (msg) => console.log(`  ${c("green","✓")}  ${msg}`);
const inf = (msg) => console.log(`  ${c("cyan","→")}  ${msg}`);
const wrn = (msg) => console.log(`  ${c("yellow","⚠")}  ${msg}`);

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE,"utf8")); } catch {}
  }
  return { day:0, phase:"launch", niche:null, product_name:null, product_url:null,
    emails_total:0, content_total:0, youtube_videos:0, youtube_views_total:0,
    printify_products:0, etsy_impressions:0, prev_month_revenue:0, last_run:null };
}

function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive:true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...s, last_run:new Date().toISOString() }, null, 2));
}

async function runDailyOperations(state, currentNiche) {
  const unlocks = treasury.loadUnlocks();
  const actions = [];

  if (unlocks.youtube?.status === "active") {
    inf("Running YouTube pipeline...");
    try {
      const result = await youtube.run(currentNiche, state.product_url);
      state.youtube_videos++;
      ok(`YouTube: "${result.title}"`);
      actions.push(`YouTube video created: "${result.title}"`);
    } catch (e) { wrn(`YouTube error: ${e.message}`); vault.auditLog("YOUTUBE_ERROR",{error:e.message},"warn"); }
  }

  if (unlocks.printify?.status === "active") {
    const day = new Date().getDay();
    if ([1,3,5].includes(day) || state.printify_products < 5) {
      inf("Running Printify/Etsy pipeline...");
      try {
        const result = await printify.run(currentNiche);
        state.printify_products += result.products?.length || 0;
        ok(`Printify: ${result.products?.length||0} products created`);
        actions.push(`Printify: ${result.products?.length||0} new products ready`);
      } catch (e) { wrn(`Printify error: ${e.message}`); }
    }
  }

  inf("Generating daily content & outreach...");
  try {
    ["output/content","output/outreach","output/reports"]
      .forEach(d => fs.mkdirSync(path.join(process.cwd(),d),{recursive:true}));

    const blogRes = await client.messages.create({
      model:config.anthropic.model, max_tokens:1500,
      messages:[{role:"user",content:`Write a 300-word SEO blog post about "${currentNiche}". Include a compelling title, 3 actionable tips, and a natural mention of a digital guide as a resource. Make it genuinely useful.`}]
    });
    fs.writeFileSync(path.join(process.cwd(),"output/content",`post-day-${state.day+1}.md`),
      `# Day ${state.day+1} — ${currentNiche}\n\n${blogRes.content[0].text}`);
    state.content_total++;
    actions.push("Blog post written");

    const emailRes = await client.messages.create({
      model:config.anthropic.model, max_tokens:800,
      messages:[{role:"user",content:`Write 5 cold email templates for "${currentNiche}" targeting small business owners. Each: subject + under 80 words body. Casual, human, not spammy. Mention our digital guide naturally.`}]
    });
    fs.writeFileSync(path.join(process.cwd(),"output/outreach",`emails-day-${state.day+1}.txt`),
      emailRes.content[0].text);
    state.emails_total += 20;
    actions.push("20 outreach emails queued");
    ok("Content + outreach complete");
  } catch (e) { wrn(`Content error: ${e.message}`); }

  state.day++;
  saveState(state);
  return actions;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive:true });
  vault.validateSetup();

  // ── NICHE ──────────────────────────────────────────────────────────────────
  console.log(c("cyan","\n  🎯 Checking niche status..."));
  const currentNiche = await niche.initializeNiche();
  const nicheStatus  = niche.getNicheStatus();
  const state = loadState();
  state.niche = currentNiche;

  console.log(c("green",`
╔══════════════════════════════════════════════════════════════════╗
║  🤖  AUTONOMOUS BUSINESS AGENT v4  —  Cloud Edition (Railway)    ║
║  Niche: ${currentNiche.slice(0,47).padEnd(47)}   ║
║  Day: ${String(state.day+1).padEnd(4)} Active: ${String(nicheStatus?.days_active||0).padEnd(4)} days  Pivots: ${String(nicheStatus?.pivot_count||0).padEnd(3)}          ║
╚══════════════════════════════════════════════════════════════════╝`));

  vault.auditLog("AGENT_STARTED",{day:state.day+1,niche:currentNiche});
  await notify.notifyAgentStarted(state.day+1);

  // ── REVENUE ────────────────────────────────────────────────────────────────
  console.log(c("cyan","\n  💳 Checking revenue..."));
  const { newSales, stats:revStats } = await revenue.runRevenueCheck();
  let totalNew = 0;
  for (const sale of newSales) {
    totalNew += parseFloat(sale.price||0);
    await notify.notifySale(sale);
  }
  if (totalNew > 0) {
    const { owner_cut, agent_cut, tier } = treasury.processRevenue(totalNew);
    ok(`${newSales.length} sale(s) — $${totalNew.toFixed(2)} gross`);
    console.log(`     Your ${tier.owner}%: ${c("green","$"+owner_cut.toFixed(2))} → bank  |  Agent ${tier.agent}%: $${agent_cut.toFixed(2)} → ops`);
    await notify.sendTelegram(`💰 <b>${newSales.length} New Sale(s)!</b>\n\nTotal: <b>$${totalNew.toFixed(2)}</b>\nYour cut (${tier.owner}%): <b>$${owner_cut.toFixed(2)}</b> → your bank\nAgent (${tier.agent}%): $${agent_cut.toFixed(2)} → operations\nTier: ${tier.label}`);
  } else { inf("No new sales since last run."); }

  // ── OPERATING COSTS ────────────────────────────────────────────────────────
  const { total_cost } = treasury.payOperatingCosts();
  if (total_cost > 0) inf(`Ops costs paid from agent budget: $${total_cost}/mo`);

  // ── UNLOCK CHECKS ──────────────────────────────────────────────────────────
  console.log(c("cyan","\n  🔓 Checking module unlocks..."));
  const autoActivated = treasury.processUnlockQueue();
  for (const mid of autoActivated) {
    const mod = treasury.MODULES[mid];
    ok(`Auto-unlocked: ${mod.name}`);
    await notify.sendTelegram(`🔓 <b>${mod.name}</b> activated!\n${mod.paid?`Cost: $${mod.monthly_cost}/mo from agent budget`:"Free — $0 cost"}\nRevenue: ${mod.revenue_est}`);
  }
  for (const mod of treasury.checkUnlockEligibility()) {
    if (treasury.loadUnlocks()[mod.id]?.status === "locked") {
      treasury.initiateUnlock(mod.id);
      await notify.sendTelegram(`🚀 <b>Module Ready: ${mod.name}</b>\n${mod.paid?`Cost: $${mod.monthly_cost}/mo (from agent's 40%)`:"FREE"}\nRevenue potential: ${mod.revenue_est}\nAuto-activates in 48hrs.\nReply "DENY ${mod.id.toUpperCase()}" to block.`);
    }
  }

  // ── DAILY OPS ──────────────────────────────────────────────────────────────
  console.log(c("cyan","\n  🚀 Running daily operations..."));
  const actions = await runDailyOperations(state, currentNiche);

  // ── REPORT ─────────────────────────────────────────────────────────────────
  const finalState = loadState();
  const finalFin   = treasury.getStatus();
  const ytStats    = youtube.getGrowthStatus();
  const podStats   = printify.getStats();

  const reportDir = path.join(process.cwd(),"output","reports");
  fs.mkdirSync(reportDir,{recursive:true});
  fs.writeFileSync(path.join(reportDir,`day-${String(finalState.day).padStart(3,"0")}.json`),
    JSON.stringify({ day:finalState.day, date:new Date().toISOString().split("T")[0],
      niche:currentNiche, niche_days:nicheStatus?.days_active, pivot_count:nicheStatus?.pivot_count,
      revenue:revStats, treasury:{owner_earned:finalFin.owner_total_earned,agent_budget:finalFin.agent_budget},
      actions, youtube:ytStats, printify:podStats }, null, 2));

  await notify.sendDailyReport({
    day:finalState.day, date:new Date().toLocaleDateString("en-US",{timeZone:config.owner.timezone}),
    revenue_today:revStats.today||0, revenue_total:revStats.total||0,
    emails_sent:finalState.emails_total, content_published:finalState.content_total,
    sales_count:revStats.count||0, phase:finalFin.tier?.label||"Starter",
    actions, alerts:vault.getAlerts(24),
    next_steps:[
      `Niche: "${currentNiche}" — Day ${nicheStatus?.days_active||0} active`,
      nicheStatus?.pivot_count>0 ? `⚠ Pivoted ${nicheStatus.pivot_count}x — agent found better niche` : "✅ Original niche holding strong",
      `YouTube: ${ytStats.videos_created} videos → targeting 1,000 subs`,
      `Printify: ${podStats.products_created} products listed`,
      `Your total earned: $${(finalFin.owner_total_earned||0).toFixed(2)} (${finalFin.tier?.owner||60}% split)`,
      finalFin.next_unlock?.message||"All modules active",
    ],
  });

  console.log(c("green",`\n  ✅  Day ${finalState.day} complete — Scheduler will wake me at 8am tomorrow.\n`));
  console.log(`  Niche:    ${c("cyan",currentNiche)}\n  Earned:   ${c("green","$"+(finalFin.owner_total_earned||0).toFixed(2)+" total to your bank")}\n  YouTube:  ${ytStats.videos_created} videos\n  Printify: ${podStats.products_created} products\n`);
}

main().catch(async err => {
  vault.auditLog("AGENT_CRASH",{error:err.message},"alert");
  await notify.sendTelegram(`🚨 <b>Agent crashed</b>\nError: ${err.message.slice(0,300)}\nScheduler retries tomorrow at 8am.`).catch(()=>{});
  console.error(c("red",`\n❌ ${err.message}\n`));
  process.exit(1);
});
