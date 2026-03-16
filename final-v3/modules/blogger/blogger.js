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
  return { total_posts: 0, last_post: null, last_url: null };
}

function saveStats(s) {
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2));
}

function getStats() { return loadStats(); }

// ── ACCESS TOKEN ─────────────────────────────────────────────────────────────
function getAccessToken() {
  return new Promise(function(resolve, reject) {
    if (!CLIENT_SECRET || !REFRESH_TOKEN) return reject(new Error("Missing OAuth credentials"));
    var body = [
      "client_id="     + encodeURIComponent(CLIENT_ID     || ""),
      "client_secret=" + encodeURIComponent(CLIENT_SECRET || ""),
      "refresh_token=" + encodeURIComponent(REFRESH_TOKEN || ""),
      "grant_type=refresh_token"
    ].join("&");
    var req = https.request({
      hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
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

function extractVideoId(url) {
  var match = (url || "").match(/youtu\.be\/([^?]+)/) || (url || "").match(/v=([^&]+)/);
  return match ? match[1] : "";
}

// ── BUILD FULL STYLED POST ────────────────────────────────────────────────────
function buildPostHTML(niche, blogContent, videoUrl, productUrl) {
  var storeUrl  = "https://" + STORE_DOMAIN + "/store";
  var videoId   = videoUrl ? extractVideoId(videoUrl) : null;
  var today     = new Date().toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" });

  // Parse blog content into sections
  var sections  = parseSections(blogContent || "");

  var videoSection = videoId ? `
    <div style="margin:32px 0;">
      <h2 style="font-family:Arial,sans-serif;font-size:20px;color:#1a1a2e;border-left:4px solid #0066cc;padding-left:12px;margin-bottom:16px;">
        📺 Watch The Full Video
      </h2>
      <div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);">
        <iframe src="https://www.youtube.com/embed/${videoId}"
          style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;"
          allowfullscreen></iframe>
      </div>
      <p style="font-family:Arial,sans-serif;font-size:13px;color:#666;margin-top:8px;text-align:center;">
        Subscribe to <strong>SmallBiz AI Hub</strong> for daily business tips
      </p>
    </div>` : "";

  var contentSection = `
    <div style="margin:32px 0;">
      <h2 style="font-family:Arial,sans-serif;font-size:20px;color:#1a1a2e;border-left:4px solid #0066cc;padding-left:12px;margin-bottom:16px;">
        💡 What You'll Learn
      </h2>
      ${sections}
    </div>`;

  var affiliateSection = `
    <div style="background:linear-gradient(135deg,#e8f4fd,#d6eaf8);border:1px solid #a9cce3;border-radius:8px;padding:20px;margin:32px 0;">
      <h3 style="font-family:Arial,sans-serif;font-size:17px;color:#1a5276;margin:0 0 8px 0;">
        🎙️ The AI Voice Tool Powering This Content
      </h3>
      <p style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a2e;margin:0 0 12px 0;">
        Every video on this channel uses <strong>ElevenLabs</strong> for voiceover — the most realistic AI voice tool available. 
        If you create content or want to automate your business with AI voice, this is the tool I use every single day.
      </p>
      <a href="${ELEVENLABS_LINK}" target="_blank"
        style="display:inline-block;background:#0066cc;color:#fff;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:10px 20px;border-radius:6px;text-decoration:none;">
        Try ElevenLabs Free →
      </a>
    </div>`;

  var storeSection = `
    <div style="background:linear-gradient(135deg,#fef9e7,#fdebd0);border:1px solid #f0b27a;border-radius:8px;padding:20px;margin:32px 0;">
      <h3 style="font-family:Arial,sans-serif;font-size:17px;color:#784212;margin:0 0 8px 0;">
        🛒 Free Business Toolkits & Digital Guides
      </h3>
      <p style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a2e;margin:0 0 12px 0;">
        Get our ready-to-use templates, guides, and toolkits designed specifically for small business owners. 
        Instant download — no fluff, just tools that work.
      </p>
      <a href="${storeUrl}" target="_blank"
        style="display:inline-block;background:#e67e22;color:#fff;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:10px 20px;border-radius:6px;text-decoration:none;">
        Browse the Store →
      </a>
    </div>`;

  var footerSection = `
    <div style="border-top:2px solid #eee;margin-top:40px;padding-top:20px;text-align:center;">
      <p style="font-family:Arial,sans-serif;font-size:13px;color:#888;margin:0;">
        Published by <strong>SmallBiz AI Hub</strong> · ${today}<br>
        <a href="https://www.youtube.com/@SmallBizAIHub" target="_blank" style="color:#0066cc;text-decoration:none;">YouTube</a> · 
        <a href="${storeUrl}" target="_blank" style="color:#0066cc;text-decoration:none;">Store</a> · 
        <a href="https://smallbizaidaily.blogspot.com" target="_blank" style="color:#0066cc;text-decoration:none;">Blog</a>
      </p>
    </div>`;

  // Hero header
  var header = `
    <div style="background:linear-gradient(135deg,#1a1a2e,#0066cc);border-radius:8px;padding:28px 24px;margin-bottom:32px;text-align:center;">
      <p style="font-family:Arial,sans-serif;font-size:12px;color:#a0c4ff;margin:0 0 8px 0;letter-spacing:2px;text-transform:uppercase;">SmallBiz AI Hub</p>
      <h1 style="font-family:Arial,sans-serif;font-size:26px;color:#ffffff;margin:0 0 8px 0;line-height:1.3;">
        ${niche}
      </h1>
      <p style="font-family:Arial,sans-serif;font-size:13px;color:#cce4ff;margin:0;">
        Daily tips to grow and automate your small business with AI
      </p>
    </div>`;

  return header + videoSection + contentSection + affiliateSection + storeSection + footerSection;
}

// ── PARSE BLOG CONTENT INTO STYLED SECTIONS ───────────────────────────────────
function parseSections(content) {
  if (!content) return "<p style='font-family:Arial,sans-serif;font-size:15px;color:#333;'>Check back soon for today's tips.</p>";

  // Strip markdown heading hashes and split into paragraphs
  var lines = content
    .replace(/<p>|<\/p>|<br>/g, "\n")
    .split("\n")
    .map(function(l) { return l.trim(); })
    .filter(function(l) { return l.length > 0; });

  var html = "";
  var tipCount = 0;
  var tipColors = ["#0066cc", "#e67e22", "#27ae60"];

  lines.forEach(function(line) {
    // Detect headings (markdown # or bold lines)
    if (/^#+\s/.test(line)) {
      var text = line.replace(/^#+\s/, "");
      html += `<h3 style="font-family:Arial,sans-serif;font-size:17px;color:#1a1a2e;margin:24px 0 8px 0;">${text}</h3>`;
    }
    // Detect tip lines (numbered or bullet)
    else if (/^(\d+\.|[-*•])/.test(line)) {
      var color = tipColors[tipCount % tipColors.length];
      tipCount++;
      var text = line.replace(/^(\d+\.|[-*•])\s*/, "");
      html += `
        <div style="display:flex;align-items:flex-start;margin:12px 0;padding:12px 16px;background:#f8f9fa;border-radius:6px;border-left:3px solid ${color};">
          <span style="font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:${color};margin-right:10px;min-width:20px;">${tipCount}.</span>
          <p style="font-family:Arial,sans-serif;font-size:14px;color:#333;margin:0;line-height:1.6;">${text}</p>
        </div>`;
    }
    // Regular paragraph
    else {
      html += `<p style="font-family:Arial,sans-serif;font-size:15px;color:#444;line-height:1.7;margin:12px 0;">${line}</p>`;
    }
  });

  return html;
}

// ── PUBLISH POST ─────────────────────────────────────────────────────────────
function publishPost(accessToken, title, content, labels) {
  return new Promise(function(resolve, reject) {
    if (!BLOG_ID) return reject(new Error("BLOGGER_BLOG_ID not set"));
    var body = JSON.stringify({ title: title, content: content, labels: labels || [] });
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
    var today = new Date().toLocaleDateString("en-US", { month:"long", day:"numeric", year:"numeric" });
    var title = niche + " Tips for Small Business Owners — " + today;
    var labels = niche.split(/[\s\/,]+/)
      .filter(function(w) { return w.length > 2; })
      .slice(0, 5)
      .concat(["small business", "AI tools", "business tips"]);
    var html   = buildPostHTML(niche, blogContent, videoUrl, productUrl);
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
