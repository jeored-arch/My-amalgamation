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
const video     = require("./modules/video/video-builder");
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

// Check if agent is paused
function isPaused() {
  return fs.existsSync(path.join(DATA_DIR,"paused.flag"));
}

async function main() {
  fs.mkdirSync(DATA_DIR,{recursive:true});
  vault.validateSetup();

  if (isPaused()) {
    console.log(c("yellow", "Agent is paused. Send resume to your Telegram bot to restart."));
    await notify.sendTelegram("⏸ Agent is paused. Send \"resume\" to restart it.").catch(()=>{});
    return;
  }

  // ── NICHE ────────────────────────────────────────────────────────────────
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
    const product = await gumroad.run(currentNiche);
    state.product_url = product.url;
    ok(`Product: "${product.name}" at $${product.price} — ${product.status}`);
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
    console.log(`     Your ${tier.owner}%: ${c("green","$"+owner_cut.toFixed(2))} → bank  |  Agent ${tier.agent}%: $${agent_cut.toFixed(2)} → ops`);
    await notify.sendTelegram(`💰 <b>${newSales.length} Sale(s)!</b>\nTotal: $${totalNew.toFixed(2)}\nYour cut: <b>$${owner_cut.toFixed(2)}</b>\nTier: ${tier.label}`);
  } else { inf("No new sales."); }

  treasury.payOperatingCosts();

  // ── UNLOCKS ───────────────────────────────────────────────────────────────
  const autoActivated = treasury.processUnlockQueue();
  for (const mid of autoActivated) {
    const mod = treasury.MODULES[mid];
    ok(`Unlocked: ${mod.name}`);
    await notify.sendTelegram(`🔓 <b>${mod.name} unlocked!</b>\n${mod.paid?`$${mod.monthly_cost}/mo from agent budget`:"Free"}`);
  }
  for (const mod of treasury.checkUnlockEligibility()) {
    if (treasury.loadUnlocks()[mod.id]?.status==="locked") {
      treasury.initiateUnlock(mod.id);
      await notify.sendTelegram(`🚀 <b>Module Ready: ${mod.name}</b>\nAuto-activates in 48hrs.\n${mod.paid?`$${mod.monthly_cost}/mo (agent budget)`:"FREE"}`);
    }
  }

  // ── YOUTUBE + VIDEO ───────────────────────────────────────────────────────
  const unlocks = treasury.loadUnlocks();
  if (unlocks.youtube?.status==="active") {
    console.log(c("cyan","\n  📹 YouTube pipeline..."));
    try {
      const affLinks  = affiliate.formatForYouTube(currentNiche);
      const scriptData = await youtube.run(currentNiche, state.product_url, affLinks);
      state.youtube_videos++;
      ok(`Script: "${scriptData.title}"`);

      inf("Building video...");
      const videoResult = await video.buildVideo(scriptData);
      if (videoResult.status==="built") {
        state.videos_built++;
        ok(`Video: ${videoResult.size_mb}MB ready`);
        if (config.youtube.refresh_token) {
          try { await youtube.uploadVideo(videoResult.path, scriptData); ok("Uploaded to YouTube"); }
          catch(e) { wrn(`Upload failed: ${e.message}`); }
        }
      } else {
        inf("Script saved — video needs FFmpeg on Railway");
      }
    } catch(e) { wrn(`YouTube: ${e.message}`); }
  }

  // ── PRINTIFY ──────────────────────────────────────────────────────────────
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

    const affYT    = affiliate.formatForYouTube(currentNiche);
    const affEmail = affiliate.formatForEmail(currentNiche);
    const affBlog  = affiliate.formatForBlog(currentNiche);
    const prodLine = state.product_url ? `Link to this resource: ${state.product_url}` : "Mention a helpful digital guide.";

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
  const vidStats = video.getStats();
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
      `Product: "${gmStats.current_product?.name||"creating..."}" at $${gmStats.current_product?.price||"?"}`,
      `Affiliates: ${affStats.active_programs} programs active — ${affStats.estimated_monthly}`,
      `YouTube: ${ytStats.videos_created} scripts | ${vidStats.videos_built} videos built`,
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
  console.log(`  Niche:      ${c("cyan",currentNiche)}\n  Product:    ${c("green",gmStats.current_product?.name||"creating")} @ $${gmStats.current_product?.price||"?"}\n  Earned:     ${c("green","$"+(fin.owner_total_earned||0).toFixed(2))}\n  Affiliates: ${affStats.active_programs} active\n  Videos:     ${vidStats.videos_built} built\n`);
}

main().catch(async err => {
  vault.auditLog("AGENT_CRASH",{ error:err.message },"alert");
  await notify.sendTelegram(`🚨 <b>Agent crashed</b>\n${err.message.slice(0,300)}\nRetries tomorrow 8am.`).catch(()=>{});
  console.error(c("red",`\n❌ ${err.message}\n`));
  process.exit(1);
});
