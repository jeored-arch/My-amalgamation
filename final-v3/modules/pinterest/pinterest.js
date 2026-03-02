/**
 * modules/pinterest/pinterest.js
 * ════════════════════════════════
 * Automatically creates Pinterest pins daily:
 * - One pin per YouTube video (thumbnail + link to video)
 * - One pin per product (thumbnail + link to store)
 * - Auto-creates boards by niche
 * - Runs after YouTube + product creation in agent.js
 */

require("dotenv").config();
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const ACCESS_TOKEN = process.env.PINTEREST_ACCESS_TOKEN || "";
const APP_ID       = process.env.PINTEREST_APP_ID || "";
const BASE_HOST    = "api.pinterest.com";

// ── API HELPER ────────────────────────────────────────────────────────────────

function apiRequest(method, apiPath, body) {
  return new Promise(function(resolve, reject) {
    if (!ACCESS_TOKEN) {
      reject(new Error("PINTEREST_ACCESS_TOKEN not set"));
      return;
    }
    var payload = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: BASE_HOST,
      path:     "/v5" + apiPath,
      method:   method,
      headers:  {
        "Authorization": "Bearer " + ACCESS_TOKEN,
        "Content-Type":  "application/json",
        "Accept":        "application/json",
      },
    };
    if (payload) opts.headers["Content-Length"] = Buffer.byteLength(payload);
    var req = https.request(opts, function(res) {
      var d = "";
      res.on("data", function(c){ d += c; });
      res.on("end", function() {
        try {
          var parsed = JSON.parse(d);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error("Pinterest API " + res.statusCode + ": " + JSON.stringify(parsed).slice(0, 200)));
          }
        } catch(e) {
          reject(new Error("Pinterest parse error: " + d.slice(0, 100)));
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── BOARD MANAGEMENT ──────────────────────────────────────────────────────────

function getBoardName(niche) {
  // Clean niche name into a Pinterest board name
  return niche
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .split(" ")
    .map(function(w){ return w.charAt(0).toUpperCase() + w.slice(1); })
    .join(" ")
    .slice(0, 50);
}

function getBoards() {
  return apiRequest("GET", "/boards?page_size=100");
}

function createBoard(name, description) {
  return apiRequest("POST", "/boards", {
    name:        name.slice(0, 50),
    description: (description || "Daily tips and strategies").slice(0, 500),
    privacy:     "PUBLIC",
  });
}

async function getOrCreateBoard(niche) {
  var boardName = getBoardName(niche);
  try {
    var boards = await getBoards();
    var existing = (boards.items || []).find(function(b) {
      return b.name.toLowerCase() === boardName.toLowerCase();
    });
    if (existing) {
      console.log("     → Board found: " + existing.name + " (" + existing.id + ")");
      return existing.id;
    }
    // Create new board
    var newBoard = await createBoard(boardName, "Daily " + niche + " tips, tools, and strategies.");
    console.log("     ✓ Board created: " + newBoard.name + " (" + newBoard.id + ")");
    return newBoard.id;
  } catch(e) {
    throw new Error("Board error: " + e.message);
  }
}

// ── PIN CREATION ──────────────────────────────────────────────────────────────

function createPin(boardId, title, description, imageUrl, linkUrl) {
  return apiRequest("POST", "/pins", {
    board_id:    boardId,
    title:       title.slice(0, 100),
    description: description.slice(0, 500),
    link:        linkUrl,
    media_source: {
      source_type: "image_url",
      url:         imageUrl,
    },
  });
}

// ── THUMBNAIL URL ─────────────────────────────────────────────────────────────

function getYouTubeThumbnailUrl(videoUrl) {
  // Extract video ID from YouTube URL
  var match = videoUrl.match(/(?:youtu\.be\/|youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/);
  if (!match) return null;
  return "https://img.youtube.com/vi/" + match[1] + "/maxresdefault.jpg";
}

function getStoreImageUrl(niche) {
  // Use a Pexels image for product pins if no thumbnail available
  // Falls back to a professional stock photo URL based on niche
  var keywords = niche.toLowerCase();
  if (keywords.includes("finance") || keywords.includes("money")) {
    return "https://images.pexels.com/photos/4386158/pexels-photo-4386158.jpeg?w=800";
  }
  if (keywords.includes("ai") || keywords.includes("tech")) {
    return "https://images.pexels.com/photos/8386440/pexels-photo-8386440.jpeg?w=800";
  }
  if (keywords.includes("business")) {
    return "https://images.pexels.com/photos/3184292/pexels-photo-3184292.jpeg?w=800";
  }
  return "https://images.pexels.com/photos/6476808/pexels-photo-6476808.jpeg?w=800";
}

// ── DEDUP TRACKING ────────────────────────────────────────────────────────────

var DATA_FILE = path.join(process.cwd(), "data", "pinterest-pins.json");

function loadPinned() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch(e) {}
  return { pins: [] };
}

function savePinned(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function alreadyPinned(url) {
  var data = loadPinned();
  return data.pins.some(function(p){ return p.url === url; });
}

function recordPin(url, title, type) {
  var data = loadPinned();
  data.pins.push({ url, title, type, date: new Date().toISOString() });
  savePinned(data);
}

// ── MAIN RUN ──────────────────────────────────────────────────────────────────

async function run(niche, videoUrl, videoTitle, productUrl, productTitle) {
  console.log("\n  📌 Pinterest module running...");

  if (!ACCESS_TOKEN) {
    console.log("     → No PINTEREST_ACCESS_TOKEN — skipping");
    return { status: "no_credentials" };
  }

  var results = { video_pin: null, product_pin: null };

  try {
    var boardId = await getOrCreateBoard(niche);

    // ── PIN 1: YouTube Video ─────────────────────────────────────────────
    if (videoUrl && videoTitle && !alreadyPinned(videoUrl)) {
      try {
        var thumbUrl = getYouTubeThumbnailUrl(videoUrl);
        if (thumbUrl) {
          var storeUrl = process.env.RAILWAY_PUBLIC_DOMAIN
            ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN + "/store"
            : "";
          var videoDesc =
            videoTitle + "\n\n" +
            "Watch the full video for complete breakdown and actionable tips.\n\n" +
            (storeUrl ? "🛒 Get our full toolkit: " + storeUrl + "\n\n" : "") +
            "#" + niche.replace(/\s+/g,"") + " #SmallBusiness #AITools #DigitalMarketing #MakeMoneyOnline";

          var videoPin = await createPin(boardId, videoTitle, videoDesc, thumbUrl, videoUrl);
          recordPin(videoUrl, videoTitle, "video");
          console.log("     ✓ Video pin created: " + videoPin.id);
          results.video_pin = videoPin.id;
        }
      } catch(e) {
        console.log("     → Video pin err: " + e.message.slice(0, 100));
      }
    } else if (alreadyPinned(videoUrl)) {
      console.log("     → Video already pinned — skipping");
    }

    // ── PIN 2: Product ───────────────────────────────────────────────────
    if (productUrl && productTitle && !alreadyPinned(productUrl)) {
      try {
        var productImageUrl = getStoreImageUrl(niche);
        var productDesc =
          "🎯 " + productTitle + "\n\n" +
          "Get this complete toolkit for just $29 — instant digital download.\n" +
          "Perfect for " + niche + ".\n\n" +
          "Click to get instant access →\n\n" +
          "#DigitalProducts #" + niche.replace(/\s+/g,"") + " #SmallBusinessTools #OnlineBusiness #PassiveIncome";

        var productPin = await createPin(boardId, productTitle, productDesc, productImageUrl, productUrl);
        recordPin(productUrl, productTitle, "product");
        console.log("     ✓ Product pin created: " + productPin.id);
        results.product_pin = productPin.id;
      } catch(e) {
        console.log("     → Product pin err: " + e.message.slice(0, 100));
      }
    } else if (productUrl && alreadyPinned(productUrl)) {
      console.log("     → Product already pinned — skipping");
    }

  } catch(e) {
    console.log("     → Pinterest err: " + e.message.slice(0, 150));
    return { status: "error", message: e.message };
  }

  var pinCount = (results.video_pin ? 1 : 0) + (results.product_pin ? 1 : 0);
  console.log("     ✓ Pinterest: " + pinCount + " pin(s) created today");
  return { status: "complete", ...results };
}

function getStats() {
  var data = loadPinned();
  return {
    total_pins:    data.pins.length,
    video_pins:    data.pins.filter(function(p){ return p.type === "video"; }).length,
    product_pins:  data.pins.filter(function(p){ return p.type === "product"; }).length,
    recent:        data.pins.slice(-5),
  };
}

module.exports = { run, getStats };
