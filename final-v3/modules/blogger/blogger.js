require("dotenv").config();
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const BLOG_ID       = process.env.BLOGGER_BLOG_ID;
const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;
const STORE_DOMAIN  = process.env.RAILWAY_PUBLIC_DOMAIN || "dailysmallbizai.com";
const ELEVENLABS_LINK = "https://try.elevenlabs.io/2pu1o9y92jl1";

const STATS_FILE = path.join(process.cwd(), "data", "blogger-stats.json");

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); } catch {}
  return { total_posts: 0, last_post: null };
}

function saveStats(s) {
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2));
}

function getStats() {
  return loadStats();
}

// ── GET ACCESS TOKEN ──────────────────────────────────────────────────────────
function getAccessToken() {
  return new Promise(function(resolve, reject) {
    if (!CLIENT_SECRET || !REFRESH_TOKEN) {
      return reject(new Error("Missing OAuth credentials"));
    }
    var body = [
      "client_id="     + encodeURIComponent(CLIENT_ID     || ""),
      "client_secret=" + encodeURIComponent(CLIENT_SECRET || ""),
      "refresh_token=" + encodeURIComponent(REFRESH_TOKEN || ""),
      "grant_type=refresh_token"
    ].join("&");

    var req = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers:  { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
    }, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try {
          var json = JSON.parse(data);
          if (json.access_token) return resolve(json.access_token);
          reject(new Error("Token error: " + (json.error_description || json.error || data.slice(0,100))));
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── BUILD POST HTML ───────────────────────────────────────────────────────────
function buildPostHTML(niche, blogContent, videoUrl, productUrl) {
  var storeUrl = "https://" + STORE_DOMAIN + "/store";

  var videoEmbed = videoUrl
    ? '<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;margin:20px 0;">' +
      '<iframe src="https://www.youtube.com/embed/' + extractVideoId(videoUrl) + '" ' +
      'style="position:absolute;top:0;left:0;width:100%;height:100%;" ' +
      'frameborder="0" allowfullscreen></iframe></div>'
    : "";

  var affiliateSection =
    '<div style="background:#f0f7ff;border-left:4px solid #0066cc;padding:16px;margin:24px 0;border-radius:4px;">' +
    '<p style="margin:0 0 8px 0;font-weight:bold;">🎙️ AI Voice Tool I Use Every Day</p>' +
    '<p style="margin:0;">The voiceover in my videos is powered by ElevenLabs — the best AI voice tool for content creators.' +
    ' <a href="' + ELEVENLABS_LINK + '" target="_blank">Try it free here →</a></p>' +
    '</div>';

  var storeSection =
    '<div style="background:#fff8e1;border-left:4px solid #ffa000;padding:16px;margin:24px 0;border-radius:4px;">' +
    '<p style="margin:0 0 8px 0;font-weight:bold;">🛒 Free Business Toolkits & Guides</p>' +
    '<p style="margin:0;">Get my digital guides and toolkits to help automate and grow your business.' +
    ' <a href="' + storeUrl + '" target="_blank">Browse the store →</a></p>' +
    '</div>';

  return videoEmbed + blogContent + affiliateSection + storeSection;
}

function extractVideoId(url) {
  var match = (url || "").match(/youtu\.be\/([^?]+)/) || (url || "").match(/v=([^&]+)/);
  return match ? match[1] : "";
}

// ── PUBLISH POST ─────────────────────────────────────────────────────────────
function publishPost(accessToken, title, content, labels) {
  return new Promise(function(resolve, reject) {
    if (!BLOG_ID) return reject(new Error("BLOGGER_BLOG_ID not set"));

    var body = JSON.stringify({
      title:   title,
      content: content,
      labels:  labels || [],
    });

    var req = https.request({
      hostname: "www.googleapis.com",
      path:     "/blogger/v3/blogs/" + BLOG_ID + "/posts/",
      method:   "POST",
      headers: {
        "Authorization":  "Bearer " + accessToken,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      }
    }, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try {
          var json = JSON.parse(data);
          if (json.url) return resolve({ status: "success", url: json.url, id: json.id });
          resolve({ status: "error", message: JSON.stringify(json).slice(0, 200) });
        } catch(e) { resolve({ status: "error", message: e.message }); }
      });
    });
    req.on("error", function(e) { resolve({ status: "error", message: e.message }); });
    req.write(body);
    req.end();
  });
}

// ── MAIN RUN ─────────────────────────────────────────────────────────────────
async function run(niche, blogContent, videoUrl, productUrl) {
  if (!BLOG_ID) {
    console.log("     → Blogger: BLOGGER_BLOG_ID not set — skipping");
    return { status: "skipped", reason: "no_blog_id" };
  }

  try {
    console.log("     → Posting to Blogger...");
    var accessToken = await getAccessToken();

    // Build title from niche
    var title = "Daily " + niche + " Tips — SmallBiz AI Hub";

    // Build labels/tags from niche words
    var labels = niche.split(/[\s\/,]+/)
      .filter(function(w) { return w.length > 2; })
      .slice(0, 5)
      .concat(["small business", "AI tools"]);

    var html = buildPostHTML(niche, blogContent || "<p>Daily tips for small business owners.</p>", videoUrl, productUrl);
    var result = await publishPost(accessToken, title, html, labels);

    if (result.status === "success") {
      var stats = loadStats();
      stats.total_posts++;
      stats.last_post = new Date().toISOString();
      stats.last_url  = result.url;
      saveStats(stats);
      console.log("     ✓ Blog post live: " + result.url);
      return { status: "complete", url: result.url };
    } else {
      console.log("     → Blogger error: " + result.message);
      return { status: "error", message: result.message };
    }

  } catch(e) {
    console.log("     → Blogger err: " + e.message.slice(0, 100));
    return { status: "error", message: e.message };
  }
}

module.exports = { run, getStats };
