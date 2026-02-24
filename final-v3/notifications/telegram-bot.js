require("dotenv").config();
const https    = require("https");
const fs       = require("fs");
const path     = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const config   = require("../config");
const affiliate = require("../modules/affiliate/affiliate");

const client    = new Anthropic({ apiKey: config.anthropic.api_key });
const BOT_TOKEN = config.telegram.bot_token;
const CHAT_ID   = config.telegram.chat_id;
const DATA_DIR  = path.join(process.cwd(), "data");

let lastUpdateId = 0;
let isPaused     = false;

function telegramRequest(method, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/${method}`,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let b = "";
      res.on("data", c => b += c);
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.write(data); req.end();
  });
}

async function send(text) {
  return telegramRequest("sendMessage", { chat_id: CHAT_ID, text, parse_mode: "HTML" });
}

async function getUpdates() {
  const r = await telegramRequest("getUpdates", { offset: lastUpdateId + 1, timeout: 10, limit: 10 });
  return r?.result || [];
}

function getContext() {
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); } catch { return {}; } };
  const state    = read("state.json");
  const treasury = read("treasury.json");
  const nicheH   = read("niche-history.json");
  const gumroad  = read("gumroad-state.json");
  const product  = gumroad.products?.find(p => p.niche === state.niche && p.status === "published");
  const aff      = affiliate.getSummary();
  return {
    is_paused: isPaused,
    day: state.day || 0,
    niche: state.niche || "selecting...",
    niche_days: nicheH.current ? Math.floor((Date.now() - new Date(nicheH.current.started_at)) / 86400000) : 0,
    pivot_count: nicheH.pivot_count || 0,
    owner_earned: treasury.owner_total_earned || 0,
    agent_budget: treasury.agent_budget || 0,
    total_sales: gumroad.sales_count || 0,
    tier: treasury.current_tier || "Starter 60/40",
    product_name: product?.name || "creating soon",
    product_price: product?.price || null,
    product_url: product?.url || null,
    youtube_videos: state.youtube_videos || 0,
    videos_built: state.videos_built || 0,
    emails_sent: state.emails_total || 0,
    printify_products: state.printify_products || 0,
    affiliate_programs: aff.active_programs,
    affiliate_estimate: aff.estimated_monthly,
    niche_score: nicheH.current?.score || "N/A",
    last_run: state.last_run || "not yet",
  };
}

async function aiReply(msg, ctx) {
  const r = await client.messages.create({
    model: config.anthropic.model, max_tokens: 400,
    system: `You are a helpful assistant for an autonomous AI business. Answer in plain English, short and clear — under 4 sentences. Use real numbers from the context. Owner's name: ${config.owner.name}.`,
    messages: [{ role: "user", content: `Agent data: ${JSON.stringify(ctx)}\n\nOwner asked: "${msg}"\n\nAnswer based on real data only.` }],
  });
  return r.content[0].text;
}

async function handleMessage(message) {
  const text   = message.text?.trim() || "";
  const chatId = message.chat?.id?.toString();
  if (chatId !== CHAT_ID?.toString()) return;

  const lower = text.toLowerCase();
  const ctx   = getContext();

  if (lower === "/status" || lower === "status") {
    await send(`📊 <b>Business Status</b>\n\n${ctx.is_paused ? "⏸ PAUSED" : "✅ Running"}\n🎯 Niche: <b>${ctx.niche}</b> (day ${ctx.niche_days})\n💰 You've earned: <b>$${ctx.owner_earned.toFixed(2)}</b>\n🛒 Sales: ${ctx.total_sales}\n📹 Videos: ${ctx.youtube_videos} scripts / ${ctx.videos_built} built\n📦 Etsy products: ${ctx.printify_products}\n✉️ Emails sent: ${ctx.emails_sent}\n🔗 Affiliate programs: ${ctx.affiliate_programs}\n📅 Day ${ctx.day}`);
    return;
  }

  if (lower.includes("how much") || lower.includes("money") || lower.includes("earned") || lower.includes("made")) {
    await send(`💰 <b>Your Money</b>\n\nTotal earned: <b>$${ctx.owner_earned.toFixed(2)}</b>\nSales: ${ctx.total_sales}\nSplit: ${ctx.tier}\nAgent budget: $${ctx.agent_budget.toFixed(2)}\n\n${ctx.product_url ? `Product: ${ctx.product_url}` : "Product being created..."}`);
    return;
  }

  if (lower.includes("product") || lower.includes("link") || lower.includes("gumroad")) {
    await send(ctx.product_url
      ? `🛍️ <b>${ctx.product_name}</b>\nPrice: $${ctx.product_price}\nLink: ${ctx.product_url}`
      : `🛍️ Product is being created — check back after tomorrow's 8am run.`);
    return;
  }

  if (lower.includes("pause") || lower.includes("stop")) {
    isPaused = true;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "paused.flag"), new Date().toISOString());
    await send(`⏸ <b>Agent paused.</b>\nWon't run tomorrow morning.\nSend "resume" to turn it back on.`);
    return;
  }

  if (lower.includes("resume") || lower.includes("unpause") || lower === "/resume") {
    isPaused = false;
    try { fs.unlinkSync(path.join(DATA_DIR, "paused.flag")); } catch {}
    await send(`▶️ <b>Agent resumed.</b>\nWill run tomorrow at 8am as normal.`);
    return;
  }

  if (lower.includes("affiliate") || lower.includes("commission")) {
    await send(`🔗 <b>Affiliate Programs</b>\n\nActive: ${ctx.affiliate_programs}\nEstimated: ${ctx.affiliate_estimate}\n\nTo add more, sign up and add to Railway Variables:\n• AFFILIATE_CANVA (canva.com/affiliates)\n• AFFILIATE_CONVERTKIT (partners.convertkit.com)\n• AFFILIATE_NOTION (notion.so/referral)\n• AFFILIATE_BEEHIIV (beehiiv.com/earn)`);
    return;
  }

  if (lower.includes("niche") || lower.includes("pivot") || lower.includes("topic")) {
    await send(`🎯 <b>Niche Status</b>\n\nCurrent: <b>${ctx.niche}</b>\nScore: ${ctx.niche_score}/10\nActive: ${ctx.niche_days} days\nPivots: ${ctx.pivot_count}\n\nAgent checks every Sunday and switches automatically if underperforming.`);
    return;
  }

  if (lower.includes("youtube") || lower.includes("video")) {
    await send(`📹 <b>YouTube</b>\n\nScripts written: ${ctx.youtube_videos}\nVideos built: ${ctx.videos_built}\nTarget: 1,000 subs + 4,000 watch hours to monetize\n\nNew script every weekday automatically.`);
    return;
  }

  if (lower.includes("unlock") || lower.includes("etsy") || lower.includes("when")) {
    await send(`🔓 <b>Unlocks</b>\n\n${ctx.owner_earned >= 500  ? "✅" : "🔒"} Etsy/Printify — ${ctx.owner_earned >= 500  ? "Active!" : `needs $500 (you have $${ctx.owner_earned.toFixed(2)})`}\n${ctx.owner_earned >= 1000 ? "✅" : "🔒"} AI Video — ${ctx.owner_earned >= 1000 ? "Active!" : "needs $1,000"}\n${ctx.owner_earned >= 2000 ? "✅" : "🔒"} AI Images — ${ctx.owner_earned >= 2000 ? "Active!" : "needs $2,000"}`);
    return;
  }

  if (lower === "/help" || lower === "help") {
    await send(`🤖 <b>What you can ask me:</b>\n\n"how much have I made?"\n"what niche are we in?"\n"what's my product link?"\n"when does Etsy unlock?"\n"how's YouTube going?"\n"show me affiliate programs"\n"pause the agent"\n"resume the agent"\n\nOr ask anything in plain English — I'll figure it out.\n\n/status — full snapshot\n/help — this menu`);
    return;
  }

  // AI fallback for anything else
  try {
    const reply = await aiReply(text, ctx);
    await send(reply);
  } catch {
    await send(`I had trouble with that one. Try asking "how much have I made?" or send /status for a full update.`);
  }
}

async function startPolling() {
  console.log("  📱 Telegram bot listening...");
  await send(`🤖 <b>Bot Online</b>\n\nAsk me anything about your business.\nTry: "how much have I made?" or /status`).catch(() => {});
  while (true) {
    try {
      const updates = await getUpdates();
      for (const u of updates) {
        lastUpdateId = u.update_id;
        if (u.message) await handleMessage(u.message);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
}

module.exports = { startPolling, send };
if (require.main === module) startPolling().catch(err => { console.error(err.message); process.exit(1); });
```

---

### File 4 of 8 — `Procfile`
This already exists in your repo — click it → pencil → delete everything → paste this → commit
```
web: node -r dotenv/config dashboard/server.js
worker: node -r dotenv/config scheduler.js
bot: node -r dotenv/config notifications/telegram-bot.js
