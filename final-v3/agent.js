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
const affiliate = require("./modules/affiliate/affiliate");
const brain     = require("./core/brain");
const heal      = require("./core/self-healing");
const products  = require("./core/product-engine");
const store     = require("./core/store");
const pinterest = require("./modules/pinterest/pinterest");
const blogger   = require("./modules/blogger/blogger");
const reddit    = require("./modules/reddit/reddit");

const client     = new Anthropic({ apiKey: config.anthropic.api_key });
const DATA_DIR   = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const C = { reset:"\x1b[0m",bright:"\x1b[1m",green:"\x1b[32m",yellow:"\x1b[33m",cyan:"\x1b[36m",red:"\x1b[31m" };
const c   = (col,txt) => `${C[col]}${txt}${C.reset}`;
const ok  = (msg) => console.log(`  ${c("green","✓")}  ${msg}`);
const inf = (msg) => console.log(`  ${c("cyan","→")}  ${msg}`);
const wrn = (msg) => console.log(`  ${c("yellow","⚠")}  ${msg}`);

function loadState() {
  // Try state.json first
  if (fs.existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE,"utf8"));
      if (s && s.day > 0) return s;
    } catch {}
  }
  // Fallback: recover day count from brain.json so resets don't lose progress
  const BRAIN_FILE = path.join(DATA_DIR, "brain.json");
  let recoveredDay = 0;
  try {
    if (fs.existsSync(BRAIN_FILE)) {
      const brain = JSON.parse(fs.readFileSync(BRAIN_FILE,"utf8"));
      recoveredDay = brain.performance?.total_videos || brain.daily_logs?.length || 0;
      if (recoveredDay > 0) console.log("  → State recovered from brain: Day " + recoveredDay);
    }
  } catch {}
  return { day:recoveredDay, niche:null, product_url:null, emails_total:0, content_total:0, youtube_videos:0, videos_built:0, printify_products:0, last_run:null };
}

function saveState(s) {
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(STATE_FILE, JSON.stringify({...s, last_run:new Date().toISOString()},null,2));
}

function isPaused() {
  return fs.existsSync(path.join(DATA_DIR,"paused.flag"));
}

// ── HEARTBEAT ──────────────────────────────────────────────────────────────────
async function heartbeat() {
  try {
    const state = loadState();
    const ytStats = youtube.getGrowthStatus();
    const healReport = heal.getReport();
    await notify.sendTelegram(
      `💓 Agent Heartbeat\n` +
      `Niche: ${state.niche||"selecting..."}\n` +
      `Videos: ${ytStats.videos_uploaded} uploaded\n` +
      `Revenue: $${(state.revenue||0).toFixed(2)}\n` +
      `Errors: ${healReport.unresolved} unresolved\n` +
      `Store: https://${process.env.RAILWAY_PUBLIC_DOMAIN||"localhost"}/store`
    ).catch(()=>{});
  } catch(e) {}
}

// ── MAIN ───────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(DATA_DIR,{recursive:true});
  vault.validateSetup();

  // ── START HTTP SERVER ──────────────────────────────────────────────────────
  const http = require("http");
  const { handleRequest } = require("./dashboard/server");
  const PORT = parseInt(process.env.PORT || config.security.dashboard_port || 3000);
  const httpServer = http.createServer(handleRequest);
  httpServer.on("error", function(e) {
    if (e.code === "EADDRINUSE") {
      console.log("     → Port " + PORT + " in use — server already running");
    } else {
      console.log("     → HTTP server error: " + e.message);
    }
  });
  httpServer.listen(PORT, () => {
    console.log("  ✓  Store available at https://" + (process.env.RAILWAY_PUBLIC_DOMAIN || ("localhost:" + PORT)) + "/store");
  });

  // Global handlers so one failure never kills the whole agent
  process.on("uncaughtException", function(e) {
    console.log("  → Uncaught: " + e.message.slice(0,150));
  });
  process.on("unhandledRejection", function(e) {
    console.log("  → Unhandled rejection: " + (e && e.message ? e.message.slice(0,150) : String(e).slice(0,150)));
  });
  // ──────────────────────────────────────────────────────────────────────────

  if (isPaused()) {
    await notify.sendTelegram("⏸ Agent paused. Send /resume to restart.").catch(()=>{});
    return;
  }

  // ── SELF-HEAL ──────────────────────────────────────────────────────────────
  console.log("\n  🔧 Self-healing check...");
  const healResult = await heal.runHealCycle(config.anthropic.api_key, config.anthropic.model).catch(e => ({ fixes:[], flags:{} }));
  const flags = healResult.flags || {};
  inf(`No errors to heal — clean start`);

  // ── NICHE ──────────────────────────────────────────────────────────────────
  inf("Checking niche...");
  console.log(c("cyan","\n  🎯 Selecting optimal niche..."));
  const currentNiche = await niche.initializeNiche();
  const nicheStatus  = niche.getNicheStatus();
  const state = loadState();
  state.niche = currentNiche;

  console.log(c("green",
    `╔══════════════════════════════════════════════════════════════════╗\n` +
    `║  🤖  AUTONOMOUS AGENT v7  —  Self-Healing Brain                 ║\n` +
    `║  Niche: ${currentNiche.slice(0,47).padEnd(47)}   ║\n` +
    `║  Day ${String(state.day+1).padEnd(4)} │ Pivots: ${String(nicheStatus?.pivot_count||0).padEnd(3)} │ Errors healed: ${String(healResult.fixes?.length||0).padEnd(10)}║\n` +
    `╚══════════════════════════════════════════════════════════════════╝`
  ));

  // ── AFFILIATE ──────────────────────────────────────────────────────────────
  console.log(c("cyan","\n  🛍️  Product..."));
  try {
    const affResult = await affiliate.getActiveProduct(currentNiche);
    if (affResult?.url) {
      state.product_url = affResult.url;
      ok(`Product: "${affResult.name}" at $${affResult.price} — ${affResult.url}`);
    }
  } catch(e) { wrn("Affiliate: " + e.message.slice(0,80)); }

  // ── REVENUE ────────────────────────────────────────────────────────────────
  console.log(c("cyan","\n  💳 Revenue check..."));
  try {
    const { newSales } = await revenue.runRevenueCheck();
    let totalNew = 0;
    for (const sale of newSales) {
      totalNew += parseFloat(sale.price||0);
      await notify.notifySale(sale);
    }
    if (totalNew > 0) {
      const { owner_cut, tier } = treasury.processRevenue(totalNew);
      brain.recordSale(totalNew, currentNiche);
      ok(`${newSales.length} sale(s) — $${totalNew.toFixed(2)}`);
      await notify.sendTelegram(`💰 ${newSales.length} Sale(s)!\nTotal: $${totalNew.toFixed(2)}\nYour cut: $${owner_cut.toFixed(2)}`);
      heal.clearFlag("elevenlabs_disabled");
    } else {
      inf("No new sales.");
    }
  } catch(e) {
    heal.logError(e.message, "revenue_check");
    wrn(`Revenue: ${e.message}`);
  }

  treasury.payOperatingCosts();

  // ── YOUTUBE ────────────────────────────────────────────────────────────────
  console.log(c("cyan","\n  📹 YouTube pipeline..."));
  let videoAngle = "general", videoTitle = "", videoUrl = null, blogUrl = null;

  if (flags.youtube_upload_paused) {
    wrn("YouTube upload paused by self-healer — building video only");
    await notify.sendTelegram("⏸ YouTube upload still paused — quota issue. Check YouTube Studio.").catch(()=>{});
  }

  try {
    const result = await youtube.run(currentNiche, state.product_url, null, flags);

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
      heal.clearFlag("youtube_upload_paused");
      heal.clearFlag("youtube_auth_needs_refresh");
      await notify.sendTelegram(`🎬 Video LIVE!\n"${result.title}"\n${result.upload.url}\nAngle: ${videoAngle} | Day ${state.day+1}`);
    }

    brain.recordVideo({ title:result.title||"", niche:currentNiche, angle:videoAngle, theme:result.theme||"deep-blue", url:videoUrl });

  } catch(e) {
    heal.logError(e.message, "youtube_pipeline");
    wrn(`YouTube: ${e.message}`);
    console.log("     → Stack: " + e.stack?.slice(0,200));
  }

  // ── PINTEREST ──────────────────────────────────────────────────────────────
  try {
    const pinterestResult = await pinterest.run(
      currentNiche,
      videoUrl,
      videoTitle,
      state.product_url,
      null
    );
    if (pinterestResult.status === "complete") {
      const pinCount = (pinterestResult.video_pin ? 1 : 0) + (pinterestResult.product_pin ? 1 : 0);
      if (pinCount > 0) ok(`Pinterest: ${pinCount} pin(s) live`);
    }
  } catch(e) {
    console.log("     → Pinterest: " + e.message.slice(0, 100));
  }

  // ── BLOGGER ────────────────────────────────────────────────────────────────
  try {
    const blogFile = path.join(process.cwd(), "output/content", `post-day-${state.day+1}.md`);
    const blogContent = fs.existsSync(blogFile)
      ? "<p>" + fs.readFileSync(blogFile, "utf8").replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>") + "</p>"
      : null;
    const blogResult = await blogger.run(currentNiche, blogContent, videoUrl, state.product_url);
    if (blogResult.status === "complete") {
      blogUrl = blogResult.url;
      ok(`Blog post live: ${blogResult.url}`);
      await notify.sendTelegram(`📝 Blog Post Live!\n${blogResult.url}`).catch(()=>{});
    }
  } catch(e) {
    console.log("     → Blogger: " + e.message.slice(0, 100));
  }

  // ── REDDIT ────────────────────────────────────────────────────────────────
  try {
    const redditResult = await reddit.run(currentNiche, blogUrl, videoUrl, videoTitle);
    if (redditResult.status === "complete") {
      ok(`Reddit post live: r/${redditResult.subreddit}`);
      await notify.sendTelegram(`🤖 Reddit Post Live!
r/${redditResult.subreddit}
${redditResult.url||""}`).catch(()=>{});
    }
  } catch(e) {
    console.log("     → Reddit: " + e.message.slice(0, 100));
  }

  // ── PRODUCTS ───────────────────────────────────────────────────────────────
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
        ok(`Live on store: ${productResult.url}`);
        await notify.sendTelegram(
          `🛍️ New Product Live!\n"${productResult.title}"\n` +
          `Price: $${productResult.price} (competitors charge $${productResult.competitor_price})\n` +
          `Store: ${productResult.url}\n\nInsight: ${productResult.insight}`
        ).catch(()=>{});
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

  // ── CONTENT ────────────────────────────────────────────────────────────────
  console.log(c("cyan","\n  ✉️  Content & outreach..."));
  try {
    ["output/content","output/outreach","output/reports"].forEach(d =>
      fs.mkdirSync(path.join(process.cwd(),d),{recursive:true})
    );
    const stratBrief = brain.getStrategyBrief(currentNiche);
    const blogRes = await client.messages.create({
      model:config.anthropic.model, max_tokens:1500,
      messages:[{role:"user",content:`Write a 300-word SEO blog post about "${currentNiche}". Include a compelling title, 3 actionable tips, and a natural mention of a digital guide as a resource. Make it genuinely useful.`}]
    });
    fs.writeFileSync(path.join(process.cwd(),"output/content",`post-day-${state.day+1}.md`),
      `# Day ${state.day+1} — ${currentNiche}\n\n${blogRes.content[0].text}`);
    state.content_total++;

    const emailRes = await client.messages.create({
      model:config.anthropic.model, max_tokens:1200,
      messages:[{role:"user",content:`Write 20 cold email templates for "${currentNiche}" targeting small business owners. Each: subject + under 80 words body. Casual, human, not spammy. Mention our digital guide naturally.`}]
    });
    fs.writeFileSync(path.join(process.cwd(),"output/outreach",`emails-day-${state.day+1}.txt`),
      emailRes.content[0].text);
    state.emails_total += 20;
    ok("Blog post + 20 emails done");
  } catch(e) { wrn(`Content: ${e.message}`); }

  // ── WRAP UP ────────────────────────────────────────────────────────────────
  state.day++;
  saveState(state);

  const healReport = heal.getReport();
  const ytStats    = youtube.getGrowthStatus();
  const prodStats  = store.getStoreStats ? store.getStoreStats() : { total_products: 0 };
  const pinStats   = pinterest.getStats();
  const blogStats   = blogger.getStats();
  const redditStats = reddit.getStats();

  console.log(c("green",`\n  ✅  Day ${state.day} done — back at 8am tomorrow`));
  console.log(
    `  Niche:      ${currentNiche}\n` +
    `  Revenue:    $${(state.revenue||0).toFixed(2)}\n` +
    `  Videos:     ${ytStats.videos_uploaded} uploaded\n` +
    `  Brain:      ${ytStats.videos_created} tracked | learning winning\n` +
    `  Products:   ${prodStats.total_products||0} created\n` +
    `  Blog posts: ${blogStats.total_posts||0} published\n` +
    `  Reddit:     ${redditStats.total_posts||0} posts live\n` +
    `  Self-Heal:  ${healReport.total_errors} errors caught | ${healReport.unresolved} unresolved\n` +
    `  Pinterest:  ${pinStats.total_pins} total pins\n`
  );

  await notify.sendTelegram(
    `✅ Day ${state.day} Complete!\n` +
    `Niche: ${currentNiche}\n` +
    `Video: ${videoUrl || "building"}\n` +
    `Blog: ${blogStats.last_url || "none"}\n` +
    `Pinterest: ${pinStats.total_pins} pins\n` +
    `Store: https://${process.env.RAILWAY_PUBLIC_DOMAIN||"localhost"}/store`
  ).catch(()=>{});
}

main().catch(async err => {
  vault.auditLog("AGENT_CRASH",{error:err.message},"alert");
  await notify.sendTelegram(`🚨 Agent crashed\nError: ${err.message.slice(0,300)}\nScheduler retries tomorrow at 8am.`).catch(()=>{});
  console.error(c("red",`\n❌ ${err.message}\n`));
});
