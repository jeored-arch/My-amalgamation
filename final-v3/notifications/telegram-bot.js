require("dotenv").config();
const https     = require("https");
const fs        = require("fs");
const path      = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const config    = require("../config");
const affiliate = require("../modules/affiliate/affiliate");

const client    = new Anthropic({ apiKey: config.anthropic.api_key });
const BOT_TOKEN = config.telegram.bot_token;
const CHAT_ID   = config.telegram.chat_id;
const DATA_DIR  = path.join(process.cwd(), "data");

var lastUpdateId = 0;
var isPaused     = false;

function telegramRequest(method, body) {
  return new Promise(function(resolve) {
    var data = JSON.stringify(body);
    var opts = {
      hostname: "api.telegram.org",
      path:     "/bot" + BOT_TOKEN + "/" + method,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    var req = https.request(opts, function(res) {
      var b = "";
      res.on("data", function(c) { b += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(b)); } catch(e) { resolve(null); }
      });
    });
    req.on("error", function() { resolve(null); });
    req.write(data);
    req.end();
  });
}

function send(text) {
  return telegramRequest("sendMessage", {
    chat_id:    CHAT_ID,
    text:       text,
    parse_mode: "HTML",
  });
}

function getUpdates() {
  return telegramRequest("getUpdates", {
    offset:  lastUpdateId + 1,
    timeout: 10,
    limit:   10,
  }).then(function(r) { return (r && r.result) ? r.result : []; });
}

function readFile(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), "utf8"));
  } catch(e) { return {}; }
}

function getContext() {
  var state    = readFile("state.json");
  var treasury = readFile("treasury.json");
  var nicheH   = readFile("niche-history.json");
  var gumroad  = readFile("gumroad-state.json");
  var product  = null;
  if (gumroad.products) {
    for (var i = 0; i < gumroad.products.length; i++) {
      if (gumroad.products[i].niche === state.niche && gumroad.products[i].status === "published") {
        product = gumroad.products[i];
        break;
      }
    }
  }
  var aff = affiliate.getSummary();
  var nichedays = 0;
  if (nicheH.current && nicheH.current.started_at) {
    nichedays = Math.floor((Date.now() - new Date(nicheH.current.started_at).getTime()) / 86400000);
  }
  return {
    is_paused:          isPaused,
    day:                state.day || 0,
    niche:              state.niche || "selecting...",
    niche_days:         nichedays,
    pivot_count:        nicheH.pivot_count || 0,
    owner_earned:       treasury.owner_total_earned || 0,
    agent_budget:       treasury.agent_budget || 0,
    total_sales:        gumroad.sales_count || 0,
    tier:               treasury.current_tier || "Starter 60/40",
    product_name:       product ? product.name : "creating soon",
    product_price:      product ? product.price : null,
    product_url:        product ? product.url : null,
    youtube_videos:     state.youtube_videos || 0,
    videos_built:       state.videos_built || 0,
    emails_sent:        state.emails_total || 0,
    printify_products:  state.printify_products || 0,
    affiliate_programs: aff.active_programs,
    affiliate_estimate: aff.estimated_monthly,
    niche_score:        nicheH.current ? nicheH.current.score : "N/A",
    last_run:           state.last_run || "not yet",
  };
}

function aiReply(msg, ctx) {
  return client.messages.create({
    model:      config.anthropic.model,
    max_tokens: 400,
    system:     "You are a helpful assistant for an autonomous AI business. Answer in plain English, short and clear — under 4 sentences. Use real numbers from the context provided. Owner name: " + config.owner.name,
    messages:   [{ role: "user", content: "Agent data: " + JSON.stringify(ctx) + "\n\nOwner asked: " + msg + "\n\nAnswer based on real data only." }],
  }).then(function(r) { return r.content[0].text; });
}

function handleMessage(message) {
  var text   = (message.text || "").trim();
  var chatId = String(message.chat ? message.chat.id : "");

  if (chatId !== String(CHAT_ID)) { return Promise.resolve(); }

  console.log("Telegram message: " + text);

  var lower = text.toLowerCase();
  var ctx   = getContext();

  if (lower === "/status" || lower === "status") {
    return send("<b>Business Status</b>\n\n" +
      (ctx.is_paused ? "PAUSED" : "Running") + "\n" +
      "Niche: <b>" + ctx.niche + "</b> (day " + ctx.niche_days + ")\n" +
      "You earned: <b>$" + ctx.owner_earned.toFixed(2) + "</b>\n" +
      "Sales: " + ctx.total_sales + "\n" +
      "YouTube scripts: " + ctx.youtube_videos + "\n" +
      "Videos built: " + ctx.videos_built + "\n" +
      "Etsy products: " + ctx.printify_products + "\n" +
      "Emails sent: " + ctx.emails_sent + "\n" +
      "Affiliate programs: " + ctx.affiliate_programs + "\n" +
      "Day: " + ctx.day);
  }

  if (lower.includes("how much") || lower.includes("money") || lower.includes("earned") || lower.includes("made")) {
    return send("<b>Your Money</b>\n\n" +
      "Total earned: <b>$" + ctx.owner_earned.toFixed(2) + "</b>\n" +
      "Sales: " + ctx.total_sales + "\n" +
      "Split: " + ctx.tier + "\n" +
      "Agent budget: $" + ctx.agent_budget.toFixed(2) + "\n\n" +
      (ctx.product_url ? "Product: " + ctx.product_url : "Product being created..."));
  }

  if (lower.includes("product") || lower.includes("link") || lower.includes("gumroad")) {
    if (ctx.product_url) {
      return send("<b>" + ctx.product_name + "</b>\nPrice: $" + ctx.product_price + "\nLink: " + ctx.product_url);
    }
    return send("Product is being created — check back after tomorrow 8am run.");
  }

  if (lower.includes("pause") || lower.includes("stop")) {
    isPaused = true;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "paused.flag"), new Date().toISOString());
    return send("Agent paused. Send \"resume\" to turn it back on.");
  }

  if (lower.includes("resume") || lower.includes("unpause")) {
    isPaused = false;
    try { fs.unlinkSync(path.join(DATA_DIR, "paused.flag")); } catch(e) {}
    return send("Agent resumed. Will run tomorrow at 8am.");
  }

  if (lower.includes("affiliate") || lower.includes("commission")) {
    return send("<b>Affiliate Programs</b>\n\nActive: " + ctx.affiliate_programs + "\nEstimated: " + ctx.affiliate_estimate + "\n\nAdd more in Railway Variables:\nAFFILIATE_CANVA\nAFFILIATE_CONVERTKIT\nAFFILIATE_NOTION\nAFFILIATE_BEEHIIV");
  }

  if (lower.includes("niche") || lower.includes("topic") || lower.includes("pivot")) {
    return send("<b>Niche Status</b>\n\nCurrent: <b>" + ctx.niche + "</b>\nScore: " + ctx.niche_score + "/10\nActive: " + ctx.niche_days + " days\nPivots: " + ctx.pivot_count + "\n\nAgent checks every Sunday and switches automatically if needed.");
  }

  if (lower.includes("youtube") || lower.includes("video")) {
    return send("<b>YouTube</b>\n\nScripts: " + ctx.youtube_videos + "\nVideos built: " + ctx.videos_built + "\nTarget: 1,000 subs + 4,000 watch hours to monetize");
  }

  if (lower.includes("unlock") || lower.includes("etsy") || lower.includes("when")) {
    var e500  = ctx.owner_earned >= 500  ? "Active!" : "needs $500 (have $"  + ctx.owner_earned.toFixed(2) + ")";
    var e1000 = ctx.owner_earned >= 1000 ? "Active!" : "needs $1,000";
    var e2000 = ctx.owner_earned >= 2000 ? "Active!" : "needs $2,000";
    return send("<b>Unlocks</b>\n\nEtsy/Printify: " + e500 + "\nAI Video: " + e1000 + "\nAI Images: " + e2000);
  }

  if (lower === "/help" || lower === "help") {
    return send("<b>What you can ask me:</b>\n\n\"how much have I made?\"\n\"what niche are we in?\"\n\"what's my product link?\"\n\"when does Etsy unlock?\"\n\"how's YouTube going?\"\n\"show affiliate programs\"\n\"pause the agent\"\n\"resume the agent\"\n\n/status — full snapshot\n/help — this menu");
  }

  return aiReply(text, ctx).then(function(reply) {
    return send(reply);
  }).catch(function() {
    return send("Try asking \"how much have I made?\" or send /status for a full update.");
  });
}

function poll() {
  getUpdates().then(function(updates) {
    var chain = Promise.resolve();
    updates.forEach(function(u) {
      lastUpdateId = u.update_id;
      if (u.message) {
        chain = chain.then(function() { return handleMessage(u.message); });
      }
    });
    return chain;
  }).catch(function() {}).then(function() {
    setTimeout(poll, 3000);
  });
}

console.log("Telegram bot starting...");
send("Bot Online - ask me anything about your business. Try: \"how much have I made?\" or /status").catch(function() {});
poll();
