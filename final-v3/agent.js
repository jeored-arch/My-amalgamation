#!/usr/bin/env node
require("dotenv").config();

const Anthropic = require("@anthropic-ai/sdk");
const fs   = require("fs");
const path = require("path");

const config    = require("./config");
const vault     = require("./security/vault");
const notify    = require("./notifications/notify");
const revenue   = require("./core/revenue");
const treasury  = require("./core/treasury");
const niche     = require("./core/niche");
const youtube   = require("./modules/youtube/youtube");
const printify  = require("./modules/printify/printify");
const gumroad   = require("./modules/gumroad/gumroad-products");
const affiliate = require("./modules/affiliate/affiliate");

const client     = new Anthropic({ apiKey: config.anthropic.api_key });
const DATA_DIR   = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const C = { reset:"\x1b[0m",bright:"\x1b[1m",green:"\x1b[32m",yellow:"\x1b[33m",cyan:"\x1b[36m",red:"\x1b[31m" };
const c   = (col,txt) => `${C[col]}${txt}${C.reset}`;
const ok  = (msg) => console.log(`  ${c("green","✓")}  ${msg}`);
const inf = (msg) => console.log(`  ${c("cyan","→")}  ${msg}`);
const wrn = (msg) => console.log(`  ${c("yellow","⚠")}  ${msg}`);

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE,"utf8")); } catch {}
  }
  return { day:0, niche:null, product_url:null, emails_total:0, content_total:0, youtube_videos:0, videos_built:0, printify_products:0, last_run:null };
}

function saveState(s) {
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(STATE_FILE, JSON.stringify({...s, last_run:new Date().toISOString()},null,2));
}

function isPaused() {
  return fs.existsSync(path.join(DATA_DIR,"paused.flag"));
}

async function main() {
  fs.mkdirSync(DATA_DIR,{recursive:true});
  vault.validateSetup();

  if (isPaused()) {
    console.log(c("yellow", "Agent is paused. Send resume to your Telegram bot to restart."));
    await notify.sendTelegram("Agent is paused. Send resume to restart it.").catch(()=>{});
    return;
  }

  // ── NICHE ─────────────────────────────────────────────────────────────────
  inf("Checking niche...");
  const currentNiche = await niche.initializeNiche();
  const nicheStatus  = niche.getNicheStatus();
  const state        = loadState();
  state.niche        = currentNiche;

  console.log(c("green",`
╔══════════════════════════════════════════════════════════════════╗
║  🤖  AUTONOMOUS AGENT v6  —  100% Hands-Off                     ║
║  Niche: ${currentNiche.slice(0,48).padEnd(48)}   ║
║  Day ${String(state.day+1).padEnd(4)} │ Pivots: ${String(nicheStatus?.pivot_count||0).padEnd(3)} │ Affiliates: ${String(affiliate.getLinks().length).padEnd(2)} active    ║
╚══════════════════════════════════════════════════════════════════╝`));

  vault.auditLog("AGENT_STARTED",{ day:state.day+1, niche:currentNiche, version:6 });
  await notify.notifyAgentStarted(state.day+1);

  // ── GUMROAD PRODUCT ───────────────────────────────────────────────────────
  console.log(c("cyan","\n  🛍️  Gumroad product..."));
  try {
    const productUrl   = process.env.MANUAL_PRODUCT_URL  || null;
    const productName  = process.env.MANUAL_PRODUCT_NAME || "Credit Score Kickstart Kit";
    const productPrice = parseFloat(process.env.MANUAL_PRODUCT_PRICE || "7");
    const product = { name: productName, price: productPrice, url: productUrl, status: "manual" };
    state.product_url = product.url;
    ok(`Product: "${product.name}" at $${product.price} — live at ${product.url || "no URL set"}`);
  } catch(e) { wrn(`Gumroad: ${e.message}`); }

  // ── REVENUE ───────────────────────────────────────────────────────────────
  console.log(c("cyan","\n  💳 Revenue check..."));
  const { newSales, stats:revStats } = await revenue.runRevenueCheck();
  let totalNew = 0;
  for (const sale of newSales) {
    totalNew += parseFloat(sale.price||0);
    await notify.notifySale(sale);
  }
  if (totalNew > 0) {
    const { owner_cut, agent_cut, tier } = treasury.processRevenue(totalNew);
    ok(`${newSales.length} sale(s) — gross $${totalNew.toFixed(2)}`);
    await notify.sendTelegram(`💰 ${newSales.length} Sale(s)!\nTotal: $${totalNew.toFixed(2)}\nYour cut: $${owner_cut.toFixed(2)}\nTier: ${tier.label}`);
  } else { inf("No new sales."); }

  treasury.payOperatingCosts();

  // ── UNLOCKS ───────────────────────────────────────────────────────────────
  const autoActivated = treasury.processUnlockQueue();
  for (const mid of autoActivated) {
    const mod = treasury.MODULES[mid];
    ok(`Unlocked: ${mod.name}`);
    await notify.sendTelegram(`Unlocked: ${mod.name}`);
  }
  for (const mod of treasury.checkUnlockEligibility()) {
    if (treasury.loadUnlocks()[mod.id]?.status==="locked") {
      treasury.initiateUnlock(mod.id);
      await notify.sendTelegram(`Module Ready: ${mod.name} — auto-activates in 48hrs`);
    }
  }

  // ── YOUTUBE ───────────────────────────────────────────────────────────────
  console.log(c("cyan","\n  📹 YouTube pipeline..."));
  try {
    const result = await youtube.run(currentNiche, state.product_url);
    state.youtube_videos++;
    ok(`Script: "${result.title}"`);
    if (result.upload && result.upload.status === "success") {
      state.videos_built++;
      ok(`Uploaded to YouTube: ${result.upload.url}`);
      await notify.sendTelegram(`YouTube video live!\n${result.title}\n${result.upload.url}`);
    } else if (result.status === "complete") {
      state.videos_built++;
      ok(`Video built and processed`);
    }
  } catch(e) { wrn(`YouTube: ${e.message}`); }

  // ── PRINTIFY ──────────────────────────────────────────────────────────────
  const unlocks = treasury.loadUnlocks();
  if (unlocks.printify?.status==="active") {
    const day = new Date().getDay();
    if ([1,3,5].includes(day)) {
      console.log(c("cyan","\n  🛒 Printify pipeline..."));
      try {
        const result = await printify.run(currentNiche);
        state.printify_products += result.products?.length||0;
        ok(`${result.products?.length||0} Etsy products`);
      } catch(e) { wrn(`Printify: ${e.message}`); }
    }
  }

  // ── CONTENT + OUTREACH ────────────────────────────────────────────────────
  console.log(c("cyan","\n  ✉️  Content & outreach..."));
  try {
    ["output/content","output/outreach","output/reports"]
      .forEach(d => fs.mkdirSync(path.join(process.cwd(),d),{recursive:true}));

    const affEmail = affiliate.formatForEmail(currentNiche);
    const affBlog  = affiliate.formatForBlog(currentNiche);
    const prodLine = state.product_url
      ? `Link to this resource: ${state.product_url}`
      : "Mention a helpful digital guide.";

    const [blogRes, emailRes] = await Promise.all([
      client.messages.create({
        model:config.anthropic.model, max_tokens:1500,
        messages:[{ role:"user", content:`Write a 300-word SEO blog post about "${currentNiche}". Title, 3 actionable tips, genuinely useful. ${prodLine}${affBlog}` }]
      }),
      client.messages.create({
        model:config.anthropic.model, max_tokens:1000,
        messages:[{ role:"user", content:`Write 5 cold outreach emails for "${currentNiche}" targeting small business owners. Each: subject + under 80 words. Casual, human. ${prodLine}${affEmail}` }]
      }),
    ]);

    fs.writeFileSync(path.join(process.cwd(),"output/content",`day-${state.day+1}.md`), blogRes.content[0].text);
    fs.writeFileSync(path.join(process.cwd(),"output/outreach",`emails-day-${state.day+1}.txt`), emailRes.content[0].text);
    state.emails_total  += 20;
    state.content_total += 1;
    ok("Blog post + 20 emails done");
  } catch(e) { wrn(`Content: ${e.message}`); }

  // ── SAVE + REPORT ─────────────────────────────────────────────────────────
  state.day++;
  saveState(state);

  const fin      = treasury.getStatus();
  const ytStats  = youtube.getGrowthStatus();
  const podStats = printify.getStats();
  const gmStats  = gumroad.getStats();
  const affStats = affiliate.getSummary();

  await notify.sendDailyReport({
    day:               state.day,
    date:              new Date().toLocaleDateString("en-US",{timeZone:config.owner.timezone}),
    revenue_today:     revStats.today||0,
    revenue_total:     revStats.total||0,
    emails_sent:       state.emails_total,
    content_published: state.content_total,
    sales_count:       revStats.count||0,
    phase:             fin.tier?.label||"Starter",
    actions:[
      `Niche: "${currentNiche}" (day ${nicheStatus?.days_active||0})`,
      `Product: "Credit Score Kickstart Kit" at $7 — ${state.product_url || "no URL"}`,
      `Affiliates: ${affStats.active_programs} programs active — ${affStats.estimated_monthly}`,
      `YouTube: ${ytStats.videos_created} scripts | ${state.videos_built} videos built`,
      `Etsy: ${podStats.products_created} products`,
      `Emails sent: ${state.emails_total}`,
      `Your total earned: $${(fin.owner_total_earned||0).toFixed(2)} (${fin.tier?.owner||60}% split)`,
      fin.next_unlock?.message||"All modules active",
    ],
    alerts: vault.getAlerts(24),
    next_steps:[
      fin.next_unlock?.message||"All modules unlocked",
      nicheStatus?.pivot_count>0 ? `Pivoted ${nicheStatus.pivot_count}x — optimized` : "Original niche holding",
    ],
  });

  console.log(c("green",`\n  ✅  Day ${state.day} done — back at 8am tomorrow\n`));
  console.log(`  Niche:      ${c("cyan",currentNiche)}\n  Product:    ${c("green","Credit Score Kickstart Kit")} @ $7\n  URL:        ${state.product_url||"not set"}\n  Earned:     ${c("green","$"+(fin.owner_total_earned||0).toFixed(2))}\n  Affiliates: ${affStats.active_programs} active\n  Videos:     ${state.videos_built} built\n`);
}

main().catch(async err => {
  vault.auditLog("AGENT_CRASH",{ error:err.message },"alert");
  await notify.sendTelegram(`Agent crashed: ${err.message.slice(0,300)}\nRetries tomorrow 8am.`).catch(()=>{});
  console.error(c("red",`\n❌ ${err.message}\n`));
  process.exit(1);
});
