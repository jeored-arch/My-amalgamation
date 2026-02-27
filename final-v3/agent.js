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
const brain     = require("./core/brain");
const heal      = require("./core/self-healing");
const products  = require("./core/product-engine");
const store     = require("./core/store");

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

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────
async function heartbeat() {
  try {
    console.log("\n[Heartbeat] " + new Date().toLocaleTimeString("en-US",{timeZone:config.owner.timezone}));
    const { newSales } = await revenue.runRevenueCheck().catch(() => ({ newSales:[] }));
    const state = loadState();
    for (const sale of newSales) {
      const amount = parseFloat(sale.price||0);
      brain.recordSale(amount, state.niche);
      await notify.sendTelegram(
        `💰 SALE! $${amount.toFixed(2)}\n` +
        `Product: ${sale.product_name || "Digital product"}\n` +
        `Time: ${new Date().toLocaleTimeString("en-US",{timeZone:config.owner.timezone})}`
      ).catch(()=>{});
    }
    const hour = new Date().getHours();
    if (hour === 12) {
      const r = brain.getReport();
      await notify.sendTelegram(
        `📊 Midday Check-in\n━━━━━━━━━━━━━━\nDay ${state.day}\n` +
        `Revenue: $${r.total_revenue.toFixed(2)}\nVideos: ${r.total_videos}\n` +
        `Days since sale: ${r.days_since_sale}\n✅ Agent running`
      ).catch(()=>{});
    }
  } catch(e) {
    heal.logError(e.message, "heartbeat");
    console.log("[Heartbeat] error: " + e.message.slice(0,80));
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(DATA_DIR,{recursive:true});
  vault.validateSetup();

  // Start the store server
  try { store.startStore(); } catch(e) { console.log("  → Store: " + e.message); }

  if (isPaused()) {
    await notify.sendTelegram("⏸ Agent paused. Send /resume to restart.").catch(()=>{});
    return;
  }

  // ── SELF-HEAL FIRST — before anything else ────────────────────────────
  // Agent reads yesterday's errors, reasons about them, applies fixes
  console.log("\n  🔧 Self-healing check...");
  const healResult = await heal.runHealCycle(
    config.anthropic.api_key,
    config.anthropic.model,
    notify.sendTelegram.bind(notify)
  );
  if (healResult.healed) {
    ok(`Self-healed ${healResult.fixes.length} issue(s) from previous run`);
  } else {
    inf("No errors to heal — clean start");
  }

  // Read active flags set by self-healer
  const flags = heal.getActiveFlags();
  if (Object.keys(flags).length > 0) {
    inf("Active behavior flags: " + Object.keys(flags).join(", "));
  }

  // ── BRAIN MORNING BRIEF ───────────────────────────────────────────────
  const state       = loadState();
  const brainReport = brain.getReport();
  const stratBrief  = brain.getStrategyBrief();

  await notify.sendTelegram(brain.getMorningBrief(state.day+1, state.niche||"researching...")).catch(()=>{});

  if ((state.day+1) % 7 === 0 && state.day > 0) {
    const { decisions } = brain.analyzeAndUpdateStrategy();
    if (decisions.length > 0) {
      ok("7-day strategy updated: " + decisions[0]);
      await notify.sendTelegram(
        `🧠 Weekly Strategy (Day ${state.day+1})\n━━━━━━━━━━━━━━\n` +
        decisions.map(d=>"• "+d).join("\n")
      ).catch(()=>{});
    }
  }

  // ── NICHE ─────────────────────────────────────────────────────────────
  inf("Checking niche...");
  if (brainReport.pivot_needed && state.day > 14) {
    inf("Brain recommends pivot — 14 days low views");
    await notify.sendTelegram("🔄 Auto-pivot triggered by brain").catch(()=>{});
  }

  const currentNiche = await niche.initializeNiche();
  const nicheStatus  = niche.getNicheStatus();
  state.niche = currentNiche;

  console.log(c("green",`
╔══════════════════════════════════════════════════════════════════╗
║  🤖  AUTONOMOUS AGENT v7  —  Self-Healing Brain                 ║
║  Niche: ${currentNiche.slice(0,48).padEnd(48)}   ║
║  Day ${String(state.day+1).padEnd(4)} │ Pivots: ${String(nicheStatus?.pivot_count||0).padEnd(3)} │ Errors healed: ${String(healResult.fixes?.length||0).padEnd(2)}         ║
╚══════════════════════════════════════════════════════════════════╝`));

  vault.auditLog("AGENT_STARTED",{ day:state.day+1, niche:currentNiche, version:7 });
  await notify.notifyAgentStarted(state.day+1);

  // ── PRODUCT ───────────────────────────────────────────────────────────
  console.log(c("cyan","\n  🛍️  Product..."));
  try {
    const productUrl   = process.env.MANUAL_PRODUCT_URL  || null;
    const productName  = process.env.MANUAL_PRODUCT_NAME || "Credit Score Kickstart Kit";
    const productPrice = parseFloat(process.env.MANUAL_PRODUCT_PRICE || "7");
    state.product_url  = productUrl;
    ok(`Product: "${productName}" at $${productPrice} — ${productUrl||"no URL set"}`);
  } catch(e) {
    heal.logError(e.message, "product_setup");
    wrn(`Product: ${e.message}`);
  }

  // ── REVENUE ───────────────────────────────────────────────────────────
  console.log(c("cyan","\n  💳 Revenue check..."));
  let newSales = [], revStats = {}, totalNew = 0;
  try {
    const rev = await revenue.runRevenueCheck();
    newSales  = rev.newSales;
    revStats  = rev.stats;
    for (const sale of newSales) {
      totalNew += parseFloat(sale.price||0);
      await notify.notifySale(sale);
    }
    if (totalNew > 0) {
      const { owner_cut, tier } = treasury.processRevenue(totalNew);
      brain.recordSale(totalNew, currentNiche);
      ok(`${newSales.length} sale(s) — $${totalNew.toFixed(2)}`);
      await notify.sendTelegram(`💰 ${newSales.length} Sale(s)!\nTotal: $${totalNew.toFixed(2)}\nYour cut: $${owner_cut.toFixed(2)}`);
      // Clear "no sales" flag if it was set
      heal.clearFlag("elevenlabs_disabled");
    } else {
      inf("No new sales.");
    }
  } catch(e) {
    heal.logError(e.message, "revenue_check");
    wrn(`Revenue: ${e.message}`);
  }

  treasury.payOperatingCosts();

  // ── YOUTUBE ───────────────────────────────────────────────────────────
  console.log(c("cyan","\n  📹 YouTube pipeline..."));
  let videoAngle = "general", videoTitle = "", videoUrl = null;

  // Check if upload was paused by self-healer from a previous run
  if (flags.youtube_upload_paused) {
    wrn("YouTube upload paused by self-healer (quota exceeded) — building video only");
    await notify.sendTelegram("⏸ YouTube upload still paused — quota issue from previous run. Check YouTube Studio.").catch(()=>{});
  }

  try {
    const result = await youtube.run(currentNiche, state.product_url, stratBrief, flags);

    console.log("     → YouTube result: " + JSON.stringify({
      status: result.status,
      uploadStatus: result.upload?.status,
      url: result.upload?.url,
    }));

    state.youtube_videos++;
    videoTitle = result.title || "";
    videoAngle = result.angle || "general";
    ok(`Script: "${result.title}"`);

    if (result.upload?.status === "success" && result.upload?.url) {
      state.videos_built++;
      videoUrl = result.upload.url;
      ok(`Uploaded to YouTube: ${result.upload.url}`);
      // Clear any youtube flags on success
      heal.clearFlag("youtube_upload_paused");
      heal.clearFlag("youtube_auth_needs_refresh");
      await notify.sendTelegram(`🎬 Video LIVE!\n"${result.title}"\n${result.upload.url}\nAngle: ${videoAngle} | Day ${state.day+1}`);
    } else if (result.status === "complete") {
      state.videos_built++;
      ok(`Video built — upload pending`);
      if (result.upload) {
        const uploadErr = JSON.stringify(result.upload);
        console.log("     → Upload detail: " + uploadErr.slice(0,200));
        // Log upload failures for self-healer to analyze
        if (result.upload.status === "error") {
          heal.logError(result.upload.message || "upload failed", "youtube_upload", result.upload);
        }
      }
    } else if (result.status === "no_video") {
      heal.logError("video build returned no_video status", "youtube_build");
      wrn("Video build failed");
    }

    // Always record in brain
    brain.recordVideo({ title:result.title||"", niche:currentNiche, angle:videoAngle, theme:result.theme||"deep-blue", url:videoUrl });

  } catch(e) {
    heal.logError(e.message, "youtube_pipeline");
    wrn(`YouTube: ${e.message}`);
    console.log("     → Stack: " + e.stack?.slice(0,200));
  }

  // ── PRODUCTS ──────────────────────────────────────────────────────────
  console.log(c("cyan","\n  🏭 Product creation..."));
  try {
    const productResult = await products.run(
      currentNiche,
      config.anthropic.api_key,
      config.anthropic.model
    );
    if (productResult.status === "created") {
      ok(`New product: "${productResult.title}" at $${productResult.price} (competitors: $${productResult.competitor_price})`);
      if (productResult.url) {
        ok(`Live on Gumroad: ${productResult.url}`);
        await notify.sendTelegram(
          `🛍️ New Product Live!\n"${productResult.title}"\n` +
          `Price: $${productResult.price} (competitors charge $${productResult.competitor_price})\n` +
          `Payhip: ${productResult.url}\n\nInsight: ${productResult.insight}`
        ).catch(()=>{});
      } else {
        inf(`Product built locally — add GUMROAD_ACCESS_TOKEN to Railway to auto-publish`);
      }
    } else if (productResult.status === "skipped") {
      inf("Product already created today");
    } else if (productResult.status === "error") {
      heal.logError(productResult.message, "product_engine");
      wrn(`Product: ${productResult.message}`);
    }
  } catch(e) {
    heal.logError(e.message, "product_engine");
    wrn(`Product engine: ${e.message}`);
  }

  // ── PRINTIFY (when unlocked) ───────────────────────────────────────────
  const unlocks = treasury.loadUnlocks();
  if (unlocks.printify?.status==="active" && [1,3,5].includes(new Date().getDay())) {
    console.log(c("cyan","\n  🛒 Printify pipeline..."));
    try {
      const result = await printify.run(currentNiche);
      state.printify_products += result.products?.length||0;
      ok(`${result.products?.length||0} Etsy products`);
    } catch(e) {
      heal.logError(e.message, "printify");
      wrn(`Printify: ${e.message}`);
    }
  }

  // ── CONTENT ───────────────────────────────────────────────────────────
  console.log(c("cyan","\n  ✉️  Content & outreach..."));
  try {
    ["output/content","output/outreach","output/reports"]
      .forEach(d => fs.mkdirSync(path.join(process.cwd(),d),{recursive:true}));

    const affEmail = affiliate.formatForEmail(currentNiche);
    const affBlog  = affiliate.formatForBlog(currentNiche);
    const prodLine = state.product_url ? `Link to this resource: ${state.product_url}` : "Mention a helpful digital guide.";

    const [blogRes, emailRes] = await Promise.all([
      client.messages.create({ model:config.anthropic.model, max_tokens:1500,
        messages:[{ role:"user", content:`Write a 300-word SEO blog post about "${currentNiche}". Title, 3 actionable tips. ${prodLine}${affBlog}` }] }),
      client.messages.create({ model:config.anthropic.model, max_tokens:1000,
        messages:[{ role:"user", content:`Write 5 cold outreach emails for "${currentNiche}" targeting small business owners. Each: subject + under 80 words. ${prodLine}${affEmail}` }] }),
    ]);

    fs.writeFileSync(path.join(process.cwd(),"output/content",`day-${state.day+1}.md`), blogRes.content[0].text);
    fs.writeFileSync(path.join(process.cwd(),"output/outreach",`emails-day-${state.day+1}.txt`), emailRes.content[0].text);
    state.emails_total  += 20;
    state.content_total += 1;
    ok("Blog post + 20 emails done");
  } catch(e) {
    heal.logError(e.message, "content_generation");
    wrn(`Content: ${e.message}`);
  }

  // ── LOG DAY ───────────────────────────────────────────────────────────
  brain.logDay({ day_number:state.day+1, niche:currentNiche, video_title:videoTitle, angle:videoAngle, sales:newSales.length, revenue:totalNew, notes:videoUrl?`Live: ${videoUrl}`:"Upload pending" });

  // ── RUN HEAL CYCLE AGAIN AT END OF DAY ───────────────────────────────
  // Any errors from TODAY get analyzed and fixes queued for tomorrow
  const endOfDayHeal = await heal.runHealCycle(
    config.anthropic.api_key,
    config.anthropic.model,
    notify.sendTelegram.bind(notify)
  );
  if (endOfDayHeal.healed) {
    ok(`End-of-day self-heal: ${endOfDayHeal.fixes.length} fix(es) queued for tomorrow`);
  }

  // ── SAVE + REPORT ─────────────────────────────────────────────────────
  state.day++;
  saveState(state);

  const fin        = treasury.getStatus();
  const ytStats    = youtube.getGrowthStatus();
  const affStats   = affiliate.getSummary();
  const brainFinal = brain.getReport();
  const healReport = heal.getReport();
    const prodStats  = products.getStats();
    const storeStats = store.getStoreStats();

  await notify.sendDailyReport({
    day: state.day,
    date: new Date().toLocaleDateString("en-US",{timeZone:config.owner.timezone}),
    revenue_today: revStats.today||0, revenue_total: revStats.total||0,
    emails_sent: state.emails_total, content_published: state.content_total,
    sales_count: revStats.count||0, phase: fin.tier?.label||"Starter",
    actions:[
      `Niche: "${currentNiche}"`,
      `YouTube: ${ytStats.videos_created} videos | Best angle: ${brainFinal.best_angle||"learning..."}`,
      `Brain: ${brainFinal.total_videos} tracked | $${brainFinal.total_revenue.toFixed(2)} revenue`,
      `Products: ${prodStats.products_created} created | Revenue: $${(prodStats.total_revenue||0).toFixed(2)}`,
      `Store: ${storeStats.active_products} live | ${storeStats.total_orders} orders | $${storeStats.total_revenue.toFixed(2)} revenue`,
      `Self-Heal: ${healReport.total_errors} errors caught | ${healReport.active_flags.length} active fixes`,
      `Earned: $${(fin.owner_total_earned||0).toFixed(2)}`,
    ],
    alerts: vault.getAlerts(24),
    next_steps:[
      brainFinal.focus_angle ? `Tomorrow: "${brainFinal.focus_angle}" angle` : "Need 7 videos for strategy",
      healReport.active_flags.length > 0 ? `Active fixes: ${healReport.active_flags.join(", ")}` : "All systems healthy",
    ],
  });

  console.log(c("green",`\n  ✅  Day ${state.day} done — back at 8am tomorrow\n`));
  console.log(
    `  Niche:      ${c("cyan",currentNiche)}\n` +
    `  Revenue:    ${c("green","$"+(fin.owner_total_earned||0).toFixed(2))}\n` +
    `  Videos:     ${state.videos_built} uploaded\n` +
    `  Brain:      ${brainFinal.total_videos} tracked | ${brainFinal.best_angle||"learning"} winning\n` +
    `  Products:   ${prodStats.products_created} created\n` +
    `  Self-Heal:  ${healReport.total_errors} errors caught | ${healReport.unresolved} unresolved\n`
  );
}

// ── ENTRY POINT ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args[0] === "--heartbeat") {
  heartbeat().catch(e => {
    heal.logError(e.message, "heartbeat_crash");
    console.log("[Heartbeat] fatal: " + e.message);
  });
} else {
  main().catch(async err => {
    heal.logError(err.message, "agent_crash");
    vault.auditLog("AGENT_CRASH",{ error:err.message },"alert");
    await notify.sendTelegram(`❌ Agent crashed: ${err.message.slice(0,300)}\nSelf-healer will analyze before next run.`).catch(()=>{});
    console.error(c("red",`\n❌ ${err.message}\n`));
    process.exit(1);
  });
}
