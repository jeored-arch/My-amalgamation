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
const ASSOCIATE_ID  = process.env.AMAZON_ASSOCIATE_ID || "jeored12-20";

function amazonLink(asin) {
  return "https://www.amazon.com/dp/" + asin + "?tag=" + ASSOCIATE_ID;
}

// Evergreen Amazon products matched to niche
var AMAZON_PRODUCTS = [
  // Business & Entrepreneurship
  { name: "Atomic Habits",                    asin: "0735211299", niches: ["productivity","business","habits","motivation","self improvement","remote","gig","gen z","first job"] },
  { name: "The $100 Startup",                 asin: "0307951529", niches: ["startup","business","entrepreneur","side hustle","passive income","first job"] },
  { name: "Profit First",                     asin: "073521414X", niches: ["finance","business","money","accounting","small business","profit","revenue"] },
  { name: "Building a StoryBrand",            asin: "0718033329", niches: ["marketing","business","content","branding","sales","small business"] },
  { name: "The Lean Startup",                 asin: "0307887898", niches: ["startup","business","entrepreneur","product","side hustle","automation"] },
  { name: "Company of One",                   asin: "0358033969", niches: ["solopreneur","freelance","business","small business","entrepreneur","remote"] },
  // Finance & Investing
  { name: "The Intelligent Investor",         asin: "0060555661", niches: ["investing","finance","stock","wealth","money","portfolio","market"] },
  { name: "I Will Teach You to Be Rich",      asin: "0761147489", niches: ["finance","money","budget","gig economy","personal finance","gen z","first job","remote"] },
  { name: "The Total Money Makeover",         asin: "159555078X", niches: ["finance","debt","budget","money","personal finance","gig","tax"] },
  { name: "Rich Dad Poor Dad",                asin: "1612680194", niches: ["investing","wealth","passive income","finance","money","real estate"] },
  { name: "The Simple Path to Wealth",        asin: "1533667926", niches: ["investing","stock","index fund","wealth","passive income","finance","retirement"] },
  { name: "Your Money or Your Life",          asin: "0143115766", niches: ["personal finance","budget","frugal","gen z","first job","gig economy","remote"] },
  // Tax & IRS
  { name: "Taxes Made Simple",                asin: "0981454224", niches: ["tax","irs","deduction","audit","gig economy","freelance","small business"] },
  { name: "J.K. Lasser Your Income Tax",      asin: "1119839270", niches: ["tax","irs","deduction","audit","income","small business","gig"] },
  // AI & Tech
  { name: "AI Superpowers",                   asin: "132854639X", niches: ["ai","automation","technology","business","future","investing","tools"] },
  { name: "The ChatGPT Millionaire",          asin: "B0BW1W8VTG", niches: ["ai","chatgpt","automation","small business","tools","side hustle","passive income"] },
  { name: "Human + Machine",                  asin: "1633693864", niches: ["ai","automation","business","technology","tools","productivity"] },
  // Content & YouTube
  { name: "Blue Yeti USB Microphone",         asin: "B00N1YPXW2", niches: ["content","youtube","creator","video","voice","podcasting"] },
  { name: "Show Your Work",                   asin: "076117897X", niches: ["content","marketing","creator","social media","personal brand","youtube"] },
  { name: "Crush It",                         asin: "0062295020", niches: ["content","social media","youtube","creator","personal brand","entrepreneur"] },
  // Credit & Gig Economy
  { name: "The Credit Repair Black Book",     asin: "B08BNPZ7J6", niches: ["credit","debt","score","finance","money","gig economy","gen z"] },
  { name: "The Gig Economy",                  asin: "0814438709", niches: ["gig economy","freelance","uber","doordash","side hustle","remote","independent"] },
];

function getAmazonLinksForNiche(nicheName, count) {
  count = count || 3;
  var lower = (nicheName || "").toLowerCase();
  return AMAZON_PRODUCTS
    .map(function(p) { return Object.assign({}, p, { url: amazonLink(p.asin), score: p.niches.filter(function(n){ return lower.includes(n); }).length }); })
    .sort(function(a,b){ return b.score - a.score; })
    .slice(0, count);
}

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
  var amazonProducts = getAmazonLinksForNiche(niche, 3);
  var storeUrl  = "https://" + STORE_DOMAIN + "/store";
  var videoId   = videoUrl ? extractVideoId(videoUrl) : null;
  var today     = new Date().toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" });
  var parsed    = parseContentBlocks(blogContent || "");

  // ── INLINE CSS (Blogger strips external sheets) ──────────────────────────────
  var css = `
    <style>
      .sb-wrap { max-width: 780px; margin: 0 auto; font-family: Georgia, 'Times New Roman', serif; color: #1A1208; line-height: 1.75; }
      .sb-wrap * { box-sizing: border-box; }
      .sb-wrap p { font-size: 16px; margin: 0 0 1.1em; color: #3D3020; }
      .sb-wrap h2 { font-family: 'Georgia', serif; font-size: 22px; font-weight: 700; color: #1A1208; margin: 2em 0 .6em; padding-bottom: .4em; border-bottom: 2px solid #E8DFC8; line-height: 1.3; }
      .sb-wrap h3 { font-family: Georgia, serif; font-size: 18px; font-weight: 700; color: #3D3020; margin: 1.6em 0 .5em; }
      .sb-wrap strong { font-weight: 700; color: #1A1208; }
      .sb-wrap a { color: #C8501A; }
      .sb-wrap ul, .sb-wrap ol { padding-left: 1.4em; margin: 0 0 1.1em; }
      .sb-wrap li { margin-bottom: .4em; font-size: 15px; color: #3D3020; }
      /* Hero */
      .sb-hero { background: linear-gradient(145deg,#1A0C04,#2D1A08,#1A2810); border-radius: 10px; padding: 32px 28px; margin-bottom: 28px; }
      .sb-hero-cat { display: inline-block; background: #C8501A; color: #fff; font-size: 10px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; padding: 4px 12px; border-radius: 3px; margin-bottom: 14px; font-family: monospace; }
      .sb-hero h1 { font-family: Georgia, serif; font-size: 28px; color: #FDFAF4; margin: 0 0 10px; line-height: 1.25; font-weight: 700; }
      .sb-hero-sub { font-size: 14px; color: rgba(253,250,244,.65); font-style: italic; margin: 0 0 18px; line-height: 1.6; }
      .sb-meta { display: flex; gap: 16px; flex-wrap: wrap; }
      .sb-meta span { font-size: 12px; color: rgba(253,250,244,.45); font-family: monospace; }
      /* Bottom Line */
      .sb-bottomline { background: #1A1208; border-radius: 10px; padding: 22px 26px; margin: 0 0 24px; position: relative; overflow: hidden; }
      .sb-bottomline::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg,#C8501A,#E8742A); }
      .sb-bl-label { font-size: 10px; font-family: monospace; letter-spacing: 2px; text-transform: uppercase; color: #E8742A; margin-bottom: 10px; font-weight: 700; }
      .sb-bl-text { font-size: 15px; line-height: 1.75; color: rgba(253,250,244,.85); }
      /* TL;DR */
      .sb-tldr { background: #FFFDF8; border: 1px solid #E8DFC8; border-radius: 10px; padding: 20px 24px; margin: 0 0 24px; }
      .sb-tldr-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid #E8DFC8; }
      .sb-tldr-title { font-family: Georgia, serif; font-size: 15px; font-weight: 700; color: #1A1208; }
      .sb-tldr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .sb-tldr-key { font-size: 10px; font-family: monospace; letter-spacing: 1px; text-transform: uppercase; color: #7A6A55; margin-bottom: 3px; font-weight: 700; }
      .sb-tldr-val { font-size: 14px; font-weight: 600; color: #1A1208; line-height: 1.4; }
      .sb-tldr-verdict { margin-top: 12px; padding-top: 12px; border-top: 1px solid #E8DFC8; font-size: 14px; font-style: italic; color: #3D3020; }
      .sb-tldr-warn { margin-top: 6px; font-size: 13px; color: #C8501A; font-weight: 600; font-style: normal; }
      /* Reality Check */
      .sb-rc { background: #F5EFE0; border: 1px solid #E8DFC8; border-left: 4px solid #B8860B; border-radius: 0 8px 8px 0; padding: 18px 22px; margin: 1.8em 0; }
      .sb-rc-label { font-size: 10px; font-family: monospace; letter-spacing: 2px; text-transform: uppercase; color: #B8860B; font-weight: 700; margin-bottom: 10px; }
      .sb-rc-key { font-size: 11px; font-weight: 700; color: #7A6A55; font-family: monospace; margin-bottom: 3px; }
      .sb-rc-val { font-size: 14px; color: #3D3020; margin-bottom: 10px; }
      .sb-rc-verdict { margin-top: 10px; padding-top: 10px; border-top: 1px solid #E8DFC8; font-size: 14px; font-weight: 600; color: #1E6B3A; }
      /* Callout */
      .sb-callout { background: #EBF2FB; border-left: 4px solid #1A3D6B; padding: 14px 18px; border-radius: 0 8px 8px 0; margin: 1.5em 0; font-size: 14px; color: #3D3020; line-height: 1.65; }
      /* Pros Cons */
      .sb-pc { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 1.5em 0; }
      .sb-pc-box { border-radius: 9px; padding: 16px 18px; }
      .sb-pros { background: #EAF5EE; border: 1px solid #A8D8BA; }
      .sb-cons { background: #FDF0E8; border: 1px solid #F0B8A0; }
      .sb-pc-title { font-family: Georgia, serif; font-size: 15px; font-weight: 700; margin-bottom: 10px; }
      .sb-pros .sb-pc-title { color: #1E6B3A; }
      .sb-cons .sb-pc-title { color: #C8501A; }
      .sb-pc-list { list-style: none; padding: 0; margin: 0; }
      .sb-pc-list li { font-size: 13px; padding: .3em 0 .3em 1.3em; position: relative; color: #3D3020; line-height: 1.5; }
      .sb-pros .sb-pc-list li::before { content: "✓"; position: absolute; left: 0; color: #1E6B3A; font-weight: 700; }
      .sb-cons .sb-pc-list li::before { content: "✗"; position: absolute; left: 0; color: #C8501A; font-weight: 700; }
      /* Compare table */
      .sb-table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 1.5em 0; border: 1px solid #E8DFC8; border-radius: 8px; overflow: hidden; }
      .sb-table th { background: #1A1208; color: #FDFAF4; padding: 10px 14px; text-align: left; font-family: monospace; font-size: 11px; letter-spacing: .5px; }
      .sb-table td { padding: 9px 14px; border-bottom: 1px solid #E8DFC8; color: #3D3020; vertical-align: top; }
      .sb-table tr:last-child td { border-bottom: none; }
      .sb-table tr:nth-child(even) td { background: #F5EFE0; }
      .sb-chk { color: #1E6B3A; font-weight: 700; }
      .sb-x { color: #C8501A; font-weight: 700; }
      /* Verdict */
      .sb-verdict { background: linear-gradient(135deg,#EAF5EE,#FFFDF8); border: 1.5px solid #A8D8BA; border-radius: 10px; padding: 22px 26px; margin: 2em 0; }
      .sb-verdict-label { font-size: 10px; font-family: monospace; letter-spacing: 2px; text-transform: uppercase; color: #1E6B3A; font-weight: 700; margin-bottom: 8px; }
      .sb-verdict-score { font-family: Georgia, serif; font-size: 36px; font-weight: 700; color: #1E6B3A; line-height: 1; margin-bottom: 6px; }
      .sb-verdict-text { font-size: 14px; color: #3D3020; line-height: 1.65; }
      /* Video embed */
      .sb-video-wrap { position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; border-radius: 8px; margin: 1.5em 0; }
      .sb-video-wrap iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0; }
      /* Amazon / CTA */
      .sb-amazon { background: #F9F9F4; border: 1px solid #E8DFC8; border-radius: 8px; padding: 18px 22px; margin: 2em 0; }
      .sb-amazon h3 { font-size: 16px; margin: 0 0 10px; color: #1A1208; }
      .sb-amazon a { display: block; padding: 9px 12px; margin: 5px 0; background: #fff; border: 1px solid #E8DFC8; border-radius: 6px; text-decoration: none; font-size: 13px; color: #1A1208; }
      .sb-amazon a:hover { border-color: #C8501A; }
      .sb-amazon .sb-disclaimer { font-size: 11px; color: #7A6A55; margin-top: 8px; }
      .sb-affiliate { background: linear-gradient(135deg,#EBF2FB,#FFFDF8); border: 1px solid #A9CCE3; border-radius: 8px; padding: 18px 22px; margin: 2em 0; }
      .sb-affiliate h3 { font-size: 16px; margin: 0 0 8px; color: #1A3D6B; }
      .sb-affiliate p { font-size: 14px; margin: 0 0 12px; color: #1A1208; }
      .sb-affiliate a.sb-btn { display: inline-block; background: #1A3D6B; color: #fff; font-size: 14px; font-weight: 700; padding: 10px 20px; border-radius: 6px; text-decoration: none; }
      .sb-store { background: linear-gradient(135deg,#FEF9E7,#FDF0E8); border: 1px solid #F0B27A; border-radius: 8px; padding: 18px 22px; margin: 2em 0; }
      .sb-store h3 { font-size: 16px; margin: 0 0 8px; color: #784212; }
      .sb-store a.sb-btn { background: #C8501A; color: #fff; display: inline-block; font-size: 14px; font-weight: 700; padding: 10px 20px; border-radius: 6px; text-decoration: none; }
      .sb-footer { border-top: 2px solid #E8DFC8; margin-top: 36px; padding-top: 18px; text-align: center; }
      .sb-footer p { font-size: 12px; color: #7A6A55; margin: 0; line-height: 1.8; }
      .sb-footer a { color: #C8501A; text-decoration: none; }
    </style>`;

  // ── HERO ──────────────────────────────────────────────────────────────────
  var readTime = Math.max(4, Math.ceil((blogContent || "").split(" ").length / 220));
  var hero = `
    <div class="sb-hero">
      <div class="sb-hero-cat">SmallBiz AI Hub · Analysis</div>
      <h1>${niche}</h1>
      <p class="sb-hero-sub">${parsed.subtitle || "Practical AI strategies for small business owners who want results, not hype."}</p>
      <div class="sb-meta">
        <span>📅 ${today}</span>
        <span>⏱ ${readTime} min read</span>
        <span>✓ Independently written</span>
      </div>
    </div>`;

  // ── BOTTOM LINE ────────────────────────────────────────────────────────────
  var bottomLine = parsed.bottomLine ? `
    <div class="sb-bottomline">
      <div class="sb-bl-label">📋 The Bottom Line — Read This First</div>
      <div class="sb-bl-text">${parsed.bottomLine}</div>
    </div>` : "";

  // ── TL;DR ──────────────────────────────────────────────────────────────────
  var tldr = parsed.tldr ? `
    <div class="sb-tldr">
      <div class="sb-tldr-head"><span style="font-size:20px">⚡</span><span class="sb-tldr-title">TL;DR — The Quick Takeaway</span></div>
      <div class="sb-tldr-grid">${parsed.tldr}</div>
      ${parsed.verdict ? '<div class="sb-tldr-verdict">' + parsed.verdict + "</div>" : ""}
      ${parsed.warning ? '<div class="sb-tldr-warn">⚠️ ' + parsed.warning + "</div>" : ""}
    </div>` : "";

  // ── VIDEO ──────────────────────────────────────────────────────────────────
  var videoSection = videoId ? `
    <h2>📺 Watch the Full Breakdown</h2>
    <div class="sb-video-wrap">
      <iframe src="https://www.youtube.com/embed/${videoId}" allowfullscreen></iframe>
    </div>
    <p style="font-size:13px;color:#7A6A55;text-align:center;margin-top:6px;">Subscribe to <strong>SmallBiz AI Hub</strong> for daily business tips</p>` : "";

  // ── MAIN CONTENT ───────────────────────────────────────────────────────────
  var mainContent = formatContentBlocks(parsed.sections);

  // ── PROS / CONS ────────────────────────────────────────────────────────────
  var proscons = (parsed.pros.length > 0 || parsed.cons.length > 0) ? `
    <div class="sb-pc">
      <div class="sb-pc-box sb-pros">
        <div class="sb-pc-title">✓ What Works</div>
        <ul class="sb-pc-list">${parsed.pros.map(function(p){ return "<li>" + p + "</li>"; }).join("")}</ul>
      </div>
      <div class="sb-pc-box sb-cons">
        <div class="sb-pc-title">✗ Watch Out For</div>
        <ul class="sb-pc-list">${parsed.cons.map(function(p){ return "<li>" + p + "</li>"; }).join("")}</ul>
      </div>
    </div>` : "";

  // ── FINAL VERDICT ──────────────────────────────────────────────────────────
  var verdictBlock = parsed.finalVerdict ? `
    <div class="sb-verdict">
      <div class="sb-verdict-label">🏆 Our Take</div>
      <div class="sb-verdict-score">${parsed.score || "★★★★☆"}</div>
      <div class="sb-verdict-text">${parsed.finalVerdict}</div>
    </div>` : "";

  // ── AMAZON BOOKS ───────────────────────────────────────────────────────────
  var amazonSection = "";
  if (amazonProducts.length > 0) {
    var items = amazonProducts.map(function(p) {
      return '<a href="' + p.url + '" target="_blank">📚 ' + p.name + ' →</a>';
    }).join("");
    amazonSection = `
      <div class="sb-amazon">
        <h3>📚 Recommended Reading</h3>
        <p style="font-size:13px;color:#7A6A55;margin:0 0 10px;">Books that go deeper on this topic:</p>
        ${items}
        <p class="sb-disclaimer">As an Amazon Associate I earn from qualifying purchases.</p>
      </div>`;
  }

  // ── ELEVENLABS AFFILIATE ────────────────────────────────────────────────────
  var affiliateSection = `
    <div class="sb-affiliate">
      <h3>🎙️ The AI Voice Tool Behind This Content</h3>
      <p>Every video on this channel uses <strong>ElevenLabs</strong> for voiceover — the most realistic AI voice available. If you create content or want to automate with AI voice, this is what I use daily.</p>
      <a href="${ELEVENLABS_LINK}" target="_blank" class="sb-btn">Try ElevenLabs Free →</a>
    </div>`;

  // ── STORE CTA ──────────────────────────────────────────────────────────────
  var storeSection = `
    <div class="sb-store">
      <h3>🛒 Free Business Toolkits & Digital Guides</h3>
      <p style="font-size:14px;color:#1A1208;margin:0 0 12px;">Ready-to-use templates and guides for small business owners. Instant download, no fluff.</p>
      <a href="${storeUrl}" target="_blank" class="sb-btn">Browse the Store →</a>
    </div>`;

  // ── PRODUCT CTA ────────────────────────────────────────────────────────────
  var productSection = productUrl ? `
    <div style="background:#1A1208;border-radius:10px;padding:22px 26px;margin:2em 0;text-align:center;">
      <p style="font-size:12px;font-family:monospace;letter-spacing:2px;color:#E8742A;margin:0 0 8px;font-weight:700;">FEATURED RESOURCE</p>
      <p style="font-size:17px;font-weight:700;color:#FDFAF4;margin:0 0 12px;line-height:1.4;">Get the full toolkit for this topic</p>
      <a href="${productUrl}" target="_blank" style="display:inline-block;background:#C8501A;color:#fff;font-size:14px;font-weight:700;padding:11px 24px;border-radius:6px;text-decoration:none;">Get Instant Access →</a>
    </div>` : "";

  // ── FOOTER ──────────────────────────────────────────────────────────────────
  var footer = `
    <div class="sb-footer">
      <p>Published by <strong>SmallBiz AI Hub</strong> · ${today}<br>
        <a href="https://www.youtube.com/@SmallBizAIHub" target="_blank">YouTube</a> ·
        <a href="${storeUrl}" target="_blank">Store</a> ·
        <a href="https://smallbizaidaily.blogspot.com" target="_blank">Blog</a>
      </p>
    </div>`;

  return css + '<div class="sb-wrap">' +
    hero + bottomLine + tldr +
    videoSection + mainContent +
    proscons + verdictBlock +
    amazonSection + affiliateSection +
    storeSection + productSection + footer +
    "</div>";
}

// ── PARSE CONTENT INTO STRUCTURED BLOCKS ────────────────────────────────────
function parseContentBlocks(raw) {
  var result = {
    subtitle:     "",
    bottomLine:   "",
    tldr:         "",
    verdict:      "",
    warning:      "",
    score:        "",
    finalVerdict: "",
    pros:         [],
    cons:         [],
    sections:     []  // array of {type, content}
  };

  if (!raw) return result;

  // Strip HTML tags for parsing
  var text = raw.replace(/<br\s*\/?>/gi, "\n").replace(/<p>/gi, "\n").replace(/<\/p>/gi, "").replace(/<[^>]+>/g, "");
  var lines = text.split("\n").map(function(l){ return l.trim(); }).filter(function(l){ return l.length > 0; });

  var inPros = false, inCons = false, currentSection = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Bottom line
    if (/bottom line|key takeaway/i.test(line) && line.length < 60) { continue; }
    if (/^the bottom line[\s:]/i.test(line)) { result.bottomLine = lines[i+1] || ""; i++; continue; }

    // TL;DR items (lines like "What It Is: ...")
    if (/^(what it is|best for|price|platform|who should|bottom line)[\s:]/i.test(line)) {
      var parts = line.split(/:\s*/);
      if (parts.length >= 2) {
        result.tldr += '<div><div class="sb-tldr-key">' + parts[0] + '</div><div class="sb-tldr-val">' + parts.slice(1).join(": ") + '</div></div>';
      }
      continue;
    }

    // Verdict / Our Take
    if (/^(our take|verdict|final thoughts?|final verdict)[\s:]/i.test(line)) {
      result.finalVerdict = lines.slice(i+1, i+4).join(" ");
      i += 3;
      continue;
    }

    // Score line  ★★★★☆ or 4.5/5 or 4/5
    if (/[★☆]|\/5/.test(line) && line.length < 30) {
      result.score = line;
      continue;
    }

    // Warning / The Catch
    if (/^⚠️|^the catch|^warning[\s:]/i.test(line)) {
      result.warning = line.replace(/^⚠️\s*|^the catch[\s:]*|^warning[\s:]*/i, "");
      continue;
    }

    // Pros section
    if (/^(pros|advantages|what works|benefits)[\s:✓]*/i.test(line) && line.length < 40) { inPros = true; inCons = false; continue; }
    if (/^(cons|disadvantages|watch out|downsides)[\s:✗]*/i.test(line) && line.length < 40) { inCons = true; inPros = false; continue; }

    // Bullet in pros/cons
    if ((inPros || inCons) && /^[-*•✓✗]|^\d+\./.test(line)) {
      var item = line.replace(/^[-*•✓✗]\s*|^\d+\.\s*/, "");
      if (inPros) result.pros.push(item);
      else result.cons.push(item);
      continue;
    } else if (inPros || inCons) {
      inPros = false; inCons = false;
    }

    // H2 heading
    if (/^#{1,2}\s/.test(line) || (line.length < 80 && /^[A-Z0-9]/.test(line) && i > 0 && lines[i-1].length === 0)) {
      var heading = line.replace(/^#+\s*/, "");
      result.sections.push({ type: "h2", content: heading });
      continue;
    }

    // H3 heading
    if (/^###\s/.test(line)) {
      result.sections.push({ type: "h3", content: line.replace(/^###\s*/, "") });
      continue;
    }

    // Reality Check block
    if (/reality check|🔍/i.test(line) && line.length < 60) {
      var rcLines = [];
      var j = i + 1;
      while (j < lines.length && j < i + 8) { rcLines.push(lines[j]); j++; }
      result.sections.push({ type: "rc", content: rcLines.join("\n") });
      i = j - 1;
      continue;
    }

    // Callout / Key Takeaway
    if (/^💡|^key takeaway|^pro tip/i.test(line)) {
      result.sections.push({ type: "callout", content: line.replace(/^💡\s*|^key takeaway[\s:]*|^pro tip[\s:]*/i, "") + (lines[i+1] ? " " + lines[i+1] : "") });
      i++;
      continue;
    }

    // Numbered tip
    if (/^\d+[\.\)]\s/.test(line)) {
      result.sections.push({ type: "tip", num: line.match(/^\d+/)[0], content: line.replace(/^\d+[\.\)]\s*/, "") });
      continue;
    }

    // Bullet
    if (/^[-*•]\s/.test(line)) {
      result.sections.push({ type: "bullet", content: line.replace(/^[-*•]\s*/, "") });
      continue;
    }

    // Regular paragraph (skip very short lines that look like labels)
    if (line.length > 20) {
      result.sections.push({ type: "p", content: line });
    }
  }

  return result;
}

// ── FORMAT SECTIONS INTO STYLED HTML ────────────────────────────────────────
function formatContentBlocks(sections) {
  var html = "";
  var tipColors = ["#C8501A", "#1A3D6B", "#1E6B3A", "#B8860B"];
  var tipCount  = 0;
  var bulletBuffer = [];

  function flushBullets() {
    if (bulletBuffer.length === 0) return "";
    var out = '<ul>' + bulletBuffer.map(function(b){ return "<li>" + b + "</li>"; }).join("") + "</ul>";
    bulletBuffer = [];
    return out;
  }

  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];

    if (s.type !== "bullet") html += flushBullets();

    if (s.type === "h2") {
      html += "<h2>" + s.content + "</h2>";
    } else if (s.type === "h3") {
      html += "<h3>" + s.content + "</h3>";
    } else if (s.type === "p") {
      html += "<p>" + s.content + "</p>";
    } else if (s.type === "tip") {
      var col = tipColors[tipCount % tipColors.length];
      tipCount++;
      html += '<div style="display:flex;align-items:flex-start;margin:10px 0;padding:12px 16px;background:#F9F9F4;border-radius:6px;border-left:3px solid ' + col + ';">'
           + '<span style="font-size:14px;font-weight:700;color:' + col + ';margin-right:10px;min-width:22px;font-family:monospace;">' + s.num + '.</span>'
           + '<p style="font-size:15px;color:#3D3020;margin:0;line-height:1.65;">' + s.content + "</p></div>";
    } else if (s.type === "bullet") {
      bulletBuffer.push(s.content);
    } else if (s.type === "callout") {
      html += '<div class="sb-callout"><strong>💡 Key Takeaway:</strong> ' + s.content + "</div>";
    } else if (s.type === "rc") {
      var rcLines = s.content.split("\n").filter(function(l){ return l.trim(); });
      var rcHTML  = '<div class="sb-rc"><div class="sb-rc-label">🔍 Reality Check</div>';
      var rcVerdict = "";
      rcLines.forEach(function(rl) {
        if (/^verdict[\s:]/i.test(rl)) {
          rcVerdict = rl.replace(/^verdict[\s:]*/i, "");
        } else if (/^(marketing|actual|claimed?|experience)[\s:]/i.test(rl)) {
          var rp = rl.split(/:\s*/);
          rcHTML += '<div class="sb-rc-key">' + rp[0] + '</div><div class="sb-rc-val">' + rp.slice(1).join(": ") + "</div>";
        } else if (rl.length > 10) {
          rcHTML += '<div class="sb-rc-val">' + rl + "</div>";
        }
      });
      if (rcVerdict) rcHTML += '<div class="sb-rc-verdict">✓ ' + rcVerdict + "</div>";
      rcHTML += "</div>";
      html += rcHTML;
    }
  }

  html += flushBullets();
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

// ── BLOG TITLE GENERATOR ─────────────────────────────────────────────────────
function generateBlogTitle(niche, blogContent, today) {
  // Pull the most interesting keyword from the blog content
  var content = (blogContent || "").replace(/<[^>]+>/g, " ").toLowerCase();

  // Title templates — rotate by day of week so every post looks different
  var dayOfWeek = new Date().getDay(); // 0-6
  var dollar = content.match(/\$[0-9,]+/) ? content.match(/\$[0-9,]+/)[0] : null;
  var hasIRS = content.includes("irs") || content.includes("tax") || content.includes("audit") || niche.toLowerCase().includes("tax") || niche.toLowerCase().includes("irs");
  var hasAI = content.includes("ai ") || content.includes("chatgpt") || content.includes("automat") || niche.toLowerCase().includes("ai");
  var hasCredit = content.includes("credit") || niche.toLowerCase().includes("credit");
  var hasInvest = content.includes("invest") || content.includes("stock") || niche.toLowerCase().includes("invest");

  // Priority: IRS titles get highest watch time
  if (hasIRS) {
    var irsTitles = [
      "WARNING: IRS Is Targeting These Small Business Deductions in 2025",
      "EXPOSED: The Tax Mistakes That Trigger IRS Audits for Small Business Owners",
      "5 IRS Red Flags Small Business Owners Must Avoid This Year",
      "Stop Filing Taxes Like This — The IRS Is Flagging These Returns",
      "NEVER Miss These Business Tax Deductions — They Cost Owners $1,000s",
      "The IRS Audit Survival Guide Every Small Business Owner Needs in 2025",
      "WARNING: These 3 Business Expenses Are Getting Owners Audited in 2025",
    ];
    return irsTitles[dayOfWeek % irsTitles.length];
  }

  // AI topics
  if (hasAI) {
    var aiTitles = [
      "EXPOSED: 5 AI Tools Replacing " + (dollar || "$500") + "/Month Software For Small Businesses",
      "Stop Paying For These Tools — Free AI Does It Better in 2025",
      "WARNING: These AI Tools Are Quietly Charging Hidden Fees Every Month",
      "5 SECRET AI Automations That Run My Business While I Sleep",
      "EXPOSED: How Big Corporations Use AI Tools They Hide From Small Business Owners",
      "I Replaced My " + (dollar || "$3,200") + "/Month Agency With AI — Real Results",
      "The FREE AI System That Saved My Business " + (dollar || "$12,000") + " This Year",
    ];
    return aiTitles[dayOfWeek % aiTitles.length];
  }

  // Credit topics
  if (hasCredit) {
    var creditTitles = [
      "EXPOSED: The Credit Score Mistakes Costing Small Business Owners Thousands",
      "Stop Doing This With Your Business Credit — Banks Are Watching",
      "WARNING: These 5 Credit Habits Are Killing Your Business Loan Chances",
      "SECRET: How to Build Business Credit From Zero in 90 Days",
      "The Business Credit Secrets Banks Hope You Never Find Out",
    ];
    return creditTitles[dayOfWeek % creditTitles.length];
  }

  // Investing topics
  if (hasInvest) {
    var investTitles = [
      "EXPOSED: The Investing Mistakes Small Business Owners Make Every Year",
      "Stop Leaving Money on the Table — The Investment Strategy Most Owners Miss",
      "WARNING: These Popular Investment Strategies Are Failing Small Business Owners",
      "SECRET: How Self-Employed People Build Wealth Without a 401k",
      "The " + (dollar || "$10,000") + " Investing Mistake 9 Out of 10 Business Owners Make",
    ];
    return investTitles[dayOfWeek % investTitles.length];
  }

  // Generic high-CTR fallbacks based on niche keyword
  var nicheShort = niche.replace(/tips?|strategies?|for small business owners?|ideas?/gi, "").trim().slice(0, 40);
  var genericTitles = [
    "EXPOSED: The Hidden Costs Behind " + nicheShort + " Most Owners Never See",
    "WARNING: The " + nicheShort + " Mistake That Cost Small Businesses " + (dollar || "$4,200") + " Last Year",
    "5 SECRETS About " + nicheShort + " That Big Companies Don't Want You to Know",
    "STOP Doing This With " + nicheShort + " — It's Quietly Hurting Your Business",
    "The " + nicheShort + " Strategy No One Talks About — Until You're Already Behind",
    "NEVER Start " + nicheShort + " Without Reading This First",
    "I Tried Every " + nicheShort + " Strategy — Only These 3 Actually Work",
  ];
  return genericTitles[dayOfWeek % genericTitles.length];
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
    // Generate a high-CTR title that matches the blog content instead of the boring niche+date formula
    var title = generateBlogTitle(niche, blogContent, today);
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
