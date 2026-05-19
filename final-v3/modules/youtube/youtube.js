require("dotenv").config();
const https     = require("https");
const fs        = require("fs");
const path      = require("path");
const Anthropic  = require("@anthropic-ai/sdk");
const config    = require("../../config");
const { auditLog } = require("../../security/vault");

const client   = new Anthropic({ apiKey: config.anthropic.api_key });
const OUT_DIR  = path.join(process.cwd(), "output", "youtube");
const DATA_DIR = path.join(process.cwd(), "data", "youtube");

// ── FONT SETUP ────────────────────────────────────────────────────────────────

function setupFonts() {
  var candidates = [
    path.join(process.cwd(), "assets", "DejaVuSans-Bold.ttf"),
    path.join(process.cwd(), "assets", "font.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ];
  var fontFile = null;
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) { fontFile = candidates[i]; break; }
  }
  if (!fontFile) return null;
  var cacheDir = path.join(process.cwd(), "tmp", "fontcache");
  var confFile = path.join(process.cwd(), "tmp", "fonts.conf");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(confFile,
    '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n' +
    '<fontconfig>\n  <dir>' + path.dirname(fontFile) + '</dir>\n' +
    '  <cachedir>' + cacheDir + '</cachedir>\n</fontconfig>\n'
  );
  process.env.FONTCONFIG_FILE = confFile;
  process.env.FONTCONFIG_PATH = path.dirname(confFile);
  console.log("     → Font: " + path.basename(fontFile));
  return fontFile;
}

var FONT_FILE = setupFonts();

// ── FIND FFMPEG ───────────────────────────────────────────────────────────────

function findFfmpeg() {
  try { var p = require("ffmpeg-static"); if (p && fs.existsSync(p)) { console.log("     → ffmpeg: ffmpeg-static"); return p; } } catch(e) {}
  try { var w = require("child_process").execSync("which ffmpeg", { encoding: "utf8" }).trim(); if (w) { console.log("     → ffmpeg: system"); return w; } } catch(e) {}
  return null;
}

// ── TOPIC TRACKING ────────────────────────────────────────────────────────────

function getUsedTopics() {
  var used = [];

  // ── PRIMARY: Read from Railway env var (survives restarts & deploys) ──
  // In Railway dashboard: add USED_TOPICS env var, leave blank initially.
  // The system updates it automatically after each video.
  var envTopics = process.env.USED_TOPICS || "";
  if (envTopics.trim()) {
    try {
      var parsed = JSON.parse(envTopics);
      if (Array.isArray(parsed)) used = parsed;
    } catch(e) {
      // Fallback: comma-separated string
      used = envTopics.split("|||").map(function(t){ return t.trim(); }).filter(Boolean);
    }
  }

  // ── SECONDARY: Local videos.json (works when filesystem persists) ──
  var logFile = path.join(DATA_DIR, "videos.json");
  if (fs.existsSync(logFile)) {
    try {
      var local = JSON.parse(fs.readFileSync(logFile, "utf8")).map(function(v){ return (v.title||"").toLowerCase(); });
      local.forEach(function(t){ if (!used.includes(t)) used.push(t); });
    } catch(e) {}
  }

  // ── TERTIARY: topic-seed.json ──
  var seedFile = path.join(process.cwd(), "data", "topic-seed.json");
  if (fs.existsSync(seedFile)) {
    try {
      var seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
      (seed.used_titles||[]).forEach(function(t){ if (!used.includes(t)) used.push(t); });
    } catch(e) {}
  }

  return used;
}

function persistTopicSeed(title) {
  var lower = title.toLowerCase();

  // ── 1. Update local topic-seed.json ──
  var seedFile = path.join(process.cwd(), "data", "topic-seed.json");
  var data = { used_titles: [] };
  if (fs.existsSync(seedFile)) {
    try { data = JSON.parse(fs.readFileSync(seedFile, "utf8")); } catch(e) {}
  }
  if (!data.used_titles) data.used_titles = [];
  if (!data.used_titles.includes(lower)) {
    data.used_titles.push(lower);
    if (data.used_titles.length > 100) data.used_titles = data.used_titles.slice(-100);
    try { fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true }); fs.writeFileSync(seedFile, JSON.stringify(data, null, 2)); } catch(e) {}
  }

  // ── 2. Update Railway env var via API so it survives restarts ──
  // Requires: RAILWAY_API_TOKEN and RAILWAY_SERVICE_ID in your Railway env vars
  // Get token: railway.app → Account Settings → Tokens
  // Get service ID: railway.app → your project → Settings → copy Service ID
  var railwayToken = process.env.RAILWAY_API_TOKEN;
  var serviceId    = process.env.RAILWAY_SERVICE_ID;
  if (railwayToken && serviceId) {
    var allUsed = getUsedTopics();
    if (!allUsed.includes(lower)) allUsed.push(lower);
    if (allUsed.length > 60) allUsed = allUsed.slice(-60);
    var newVal = JSON.stringify(allUsed);
    var mutation = JSON.stringify({
      query: "mutation { variableUpsert(input: { serviceId: \"" + serviceId + "\", name: \"USED_TOPICS\", value: " + JSON.stringify(newVal) + " }) }"
    });
    try {
      var https2 = require("https");
      var req = https2.request({
        hostname: "backboard.railway.app",
        path: "/graphql/v2",
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + railwayToken, "Content-Length": Buffer.byteLength(mutation) }
      }, function(res){ res.resume(); });
      req.on("error", function(){});
      req.write(mutation);
      req.end();
      console.log("     → USED_TOPICS env var updated (" + allUsed.length + " topics saved to Railway)");
    } catch(e) { console.log("     → Could not update Railway env var: " + e.message.slice(0,80)); }
  } else {
    console.log("     → RAILWAY_API_TOKEN or RAILWAY_SERVICE_ID not set — topic memory only saved locally");
  }
}

// ── SVG HELPERS ───────────────────────────────────────────────────────────────

function safeXml(s, maxLen) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;").slice(0, maxLen || 80);
}

function wrapWords(text, maxChars) {
  text = String(text || "").trim();
  if (text.length <= maxChars) return [text];
  var words = text.split(" "), lines = [], cur = "";
  for (var i = 0; i < words.length; i++) {
    var test = cur ? cur + " " + words[i] : words[i];
    if (test.length > maxChars) { if (cur) lines.push(cur); cur = words[i].slice(0, maxChars); }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ── COLOR THEMES ──────────────────────────────────────────────────────────────

var THEMES = [
  { bg: "0d1b2a", accent: "4488ff", text: "white", sub: "88aaff", name: "deep-blue"   },
  { bg: "1a0a00", accent: "ff6600", text: "white", sub: "ffaa44", name: "orange-fire" },
  { bg: "0a1a0a", accent: "44cc44", text: "white", sub: "88ee88", name: "green-money" },
  { bg: "1a001a", accent: "cc44ff", text: "white", sub: "ee88ff", name: "purple-pro"  },
  { bg: "00101a", accent: "00ccff", text: "white", sub: "88eeff", name: "cyan-tech"   },
  { bg: "1a1a00", accent: "ffcc00", text: "white", sub: "ffee88", name: "gold-wealth" },
  { bg: "0a000a", accent: "ff4444", text: "white", sub: "ff8888", name: "red-urgent"  },
];

function getTheme(dayOffset) { return THEMES[dayOffset % THEMES.length]; }

function hexToRgb(hex) {
  return { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16) };
}

// ── THUMBNAIL GENERATOR ───────────────────────────────────────────────────────

function makeThumbnail(title, theme, outputPath) {
  var sharp;
  try { sharp = require("sharp"); } catch(e) { return Promise.resolve(null); }
  var W = 1280, H = 720;
  var bg = hexToRgb(theme.bg);

  // Extract number badge (e.g. "7" from "7 Mistakes")
  var numMatch = title.match(/\b(\d+)\b/);
  var badgeNum = numMatch ? numMatch[1] : null;

  // Stop words to skip in big headline display
  var stopRx = /^(the|and|for|with|that|this|are|was|you|your|how|why|what|when|from|have|will|they|about|these|those|into|also|than|then|more|most|just|been|some|over|such|after|before|every|each|both|while|its|not|but|can|all|get|do|of|in|on|to|a|an|i|so|my)$/i;

  // Prioritize power words for the thumbnail — these drive clicks
  // Power words for dark history / mystery documentary channel
  var POWER = ["REAL","UNTOLD","DARK","TRUTH","HIDDEN","MYSTERY","SECRET","VANISHED","DISAPPEARED","FORGOTTEN","DISTURBING","UNCOVERED","REVEALED","CLASSIFIED","SEALED","EVIDENCE","STRANGE","DISTURBING","UNSOLVED","UNEXPLAINED","TERRIFYING","SILENCED","BURIED","SHOCKING","DISCOVERED","LOST","FORBIDDEN"];
  var allWords = title.replace(/[^a-zA-Z0-9 ]/g," ").trim().split(/\s+/);

  // Pick the best 4-6 words: power words first, then meaningful non-stop words
  var powerFound = allWords.filter(function(w){ return POWER.includes(w.toUpperCase()); });
  var meaningfulWords = allWords.filter(function(w){
    return w.length > 3 && !stopRx.test(w) && !POWER.includes(w.toUpperCase()) && !/^\d+$/.test(w);
  });
  var displayWords = powerFound.concat(meaningfulWords).slice(0, 6);

  // Split into 2-3 short lines — max 10 chars per line for readability
  function buildLines(words) {
    var lines = [], cur = "";
    for (var i = 0; i < words.length; i++) {
      var w = words[i].toUpperCase();
      var test = cur ? cur + " " + w : w;
      if (test.length > 11 && cur) { lines.push(cur); cur = w; }
      else cur = test;
      if (lines.length >= 2 && cur) { lines.push(cur); break; }
    }
    if (cur && lines.length < 3) lines.push(cur);
    return lines.slice(0, 3);
  }
  var headLines = buildLines(displayWords);
  var line1 = headLines[0] || "";
  var line2 = headLines[1] || "";
  var line3 = headLines[2] || "";

  // Font size scales down for longer lines
  function fontSize(line, base) { return line.length > 9 ? Math.round(base * 0.72) : line.length > 6 ? Math.round(base * 0.88) : base; }

  // Subtitle — full title, truncated cleanly at word boundary
  var subtitle = title;
  if (subtitle.length > 62) {
    subtitle = subtitle.slice(0, 59);
    var lastSpace = subtitle.lastIndexOf(" ");
    if (lastSpace > 40) subtitle = subtitle.slice(0, lastSpace);
    subtitle += "...";
  }

  var svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' +
    '<defs>' +
      '<filter id="textglow"><feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="#' + theme.accent + '" flood-opacity="0.6"/></filter>' +
      '<filter id="shadow"><feDropShadow dx="3" dy="3" stdDeviation="4" flood-color="#000" flood-opacity="0.9"/></filter>' +
      '<linearGradient id="bggrad" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0%" stop-color="#' + theme.bg + '"/>' +
        '<stop offset="100%" stop-color="#0a0a0a"/>' +
      '</linearGradient>' +
      '<linearGradient id="stripe" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#' + theme.accent + '" stop-opacity="1"/>' +
        '<stop offset="100%" stop-color="#' + theme.accent + '" stop-opacity="0.3"/>' +
      '</linearGradient>' +
    '</defs>' +
    // Background
    '<rect width="' + W + '" height="' + H + '" fill="url(#bggrad)"/>' +
    // Diagonal accent shape
    '<polygon points="0,0 480,0 380,' + H + ' 0,' + H + '" fill="#' + theme.accent + '" opacity="0.08"/>' +
    // Left accent bar
    '<rect width="12" height="' + H + '" fill="url(#stripe)"/>' +
    // Number badge (if exists) — big and bold
    (badgeNum ? (
      '<circle cx="1140" cy="130" r="110" fill="#' + theme.accent + '" opacity="0.15"/>' +
      '<circle cx="1140" cy="130" r="95" fill="#' + theme.accent + '" opacity="0.25"/>' +
      '<text x="1140" y="160" font-family="Arial,sans-serif" font-size="' + (badgeNum.length > 1 ? "100" : "120") + '" font-weight="bold" fill="white" text-anchor="middle" filter="url(#textglow)">' + safeXml(badgeNum,3) + '</text>'
    ) : "") +
    // Main headline — dynamic font size based on word length
    '<text x="60" y="220" font-family="Arial Black,Arial,sans-serif" font-size="' + fontSize(line1,140) + '" font-weight="bold" fill="white" filter="url(#shadow)" letter-spacing="-1">' + safeXml(line1, 12) + '</text>' +
    (line2 ? '<text x="60" y="' + (220 + fontSize(line1,140) + 10) + '" font-family="Arial Black,Arial,sans-serif" font-size="' + fontSize(line2,132) + '" font-weight="bold" fill="#' + theme.accent + '" filter="url(#textglow)" letter-spacing="-1">' + safeXml(line2, 12) + '</text>' : "") +
    (line3 ? '<text x="60" y="' + (220 + fontSize(line1,140) + 10 + fontSize(line2,132) + 14) + '" font-family="Arial Black,Arial,sans-serif" font-size="' + fontSize(line3,118) + '" font-weight="bold" fill="white" filter="url(#shadow)" letter-spacing="-1">' + safeXml(line3, 12) + '</text>' : "") +
    // Bottom subtitle bar
    '<rect x="0" y="' + (H-90) + '" width="' + W + '" height="90" fill="#000" opacity="0.78"/>' +
    '<rect x="0" y="' + (H-90) + '" width="6" height="90" fill="#' + theme.accent + '"/>' +
    '<text x="30" y="' + (H-30) + '" font-family="Arial,Helvetica,sans-serif" font-size="28" fill="#' + theme.sub + '" font-weight="bold">' + safeXml(subtitle, 80) + '</text>' +
    '</svg>';

  return sharp({ create: { width: W, height: H, channels: 3, background: bg } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 95 })
    .toFile(outputPath)
    .then(function() { return outputPath; })
    .catch(function() { return null; });
}

// ── SLIDE BUILDER ─────────────────────────────────────────────────────────────

// ── PEXELS IMAGE FETCH ───────────────────────────────────────────────────────

// Fetch from Wikimedia Commons (FREE public domain historical images — better for history channel)
function fetchWikimediaImage(query, outputPath) {
  return new Promise(function(resolve) {
    var searchQuery = encodeURIComponent(query + " historical");
    var searchUrl = "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" +
      searchQuery + "&srnamespace=6&format=json&srlimit=5";
    https.get(searchUrl, { headers: { "User-Agent": "UntoldArchive/1.0" } }, function(res) {
      var data = "";
      res.on("data", function(d) { data += d; });
      res.on("end", function() {
        try {
          var results = JSON.parse(data);
          var pages = (results.query && results.query.search) || [];
          if (!pages.length) return resolve(null);
          // Pick a result and fetch its image URL
          var title = pages[0].title.replace("File:", "");
          var imgUrl = "https://en.wikipedia.org/w/api.php?action=query&titles=File:" +
            encodeURIComponent(title) + "&prop=imageinfo&iiprop=url&format=json";
          https.get(imgUrl, { headers: { "User-Agent": "UntoldArchive/1.0" } }, function(res2) {
            var d2 = "";
            res2.on("data", function(chunk) { d2 += chunk; });
            res2.on("end", function() {
              try {
                var info = JSON.parse(d2);
                var pages2 = info.query && info.query.pages;
                var page = pages2 && Object.values(pages2)[0];
                var imgSrc = page && page.imageinfo && page.imageinfo[0] && page.imageinfo[0].url;
                if (!imgSrc || !imgSrc.match(/\.(jpg|jpeg|png)/i)) return resolve(null);
                // Download the image
                https.get(imgSrc, { headers: { "User-Agent": "UntoldArchive/1.0" } }, function(imgRes) {
                  if (imgRes.statusCode !== 200) return resolve(null);
                  var chunks = [];
                  imgRes.on("data", function(c) { chunks.push(c); });
                  imgRes.on("end", function() {
                    try {
                      require("fs").writeFileSync(outputPath, Buffer.concat(chunks));
                      if (require("fs").statSync(outputPath).size > 10000) {
                        resolve(outputPath);
                      } else { resolve(null); }
                    } catch(e) { resolve(null); }
                  });
                }).on("error", function() { resolve(null); });
              } catch(e) { resolve(null); }
            });
          }).on("error", function() { resolve(null); });
        } catch(e) { resolve(null); }
      });
    }).on("error", function() { resolve(null); });
  });
}

function fetchPexelsImage(query, outputPath) {
  var apiKey = process.env.PEXELS_API_KEY || config.pexels_api_key || "";
  if (!apiKey) return Promise.resolve(null);
  return new Promise(function(resolve) {
    var q = encodeURIComponent((query || "business").slice(0, 50));
    var opts = {
      hostname: "api.pexels.com",
      path: "/v1/search?query=" + q + "&per_page=5&orientation=landscape",
      headers: { "Authorization": apiKey }
    };
    var req = https.request(opts, function(res) {
      var d = "";
      res.on("data", function(c){ d += c; });
      res.on("end", function() {
        try {
          var data = JSON.parse(d);
          var photos = (data.photos || []);
          if (!photos.length) return resolve(null);
          // Pick a random one from top 5 for variety
          var photo = photos[Math.floor(Math.random() * Math.min(photos.length, 5))];
          var imgUrl = photo.src && (photo.src.large || photo.src.medium);
          if (!imgUrl) return resolve(null);
          var imgParsed = require("url").parse(imgUrl);
          var imgReq = https.request({ hostname: imgParsed.hostname, path: imgParsed.path, headers: { "Authorization": apiKey } }, function(imgRes) {
            if (imgRes.statusCode === 301 || imgRes.statusCode === 302) {
              // Follow redirect
              var redir = require("url").parse(imgRes.headers.location);
              var rreq = https.request({ hostname: redir.hostname, path: redir.path + (redir.search||"") }, function(rres) {
                var chunks = [];
                rres.on("data", function(c){ chunks.push(c); });
                rres.on("end", function() {
                  var buf = Buffer.concat(chunks);
                  if (buf.length < 5000) return resolve(null);
                  require("fs").writeFileSync(outputPath, buf);
                  resolve(outputPath);
                });
              });
              rreq.on("error", function(){ resolve(null); });
              rreq.end();
              return;
            }
            var chunks = [];
            imgRes.on("data", function(c){ chunks.push(c); });
            imgRes.on("end", function() {
              var buf = Buffer.concat(chunks);
              if (buf.length < 5000) return resolve(null);
              require("fs").writeFileSync(outputPath, buf);
              resolve(outputPath);
            });
          });
          imgReq.on("error", function(){ resolve(null); });
          imgReq.end();
        } catch(e) { resolve(null); }
      });
    });
    req.on("error", function(){ resolve(null); });
    req.end();
  });
}

// ── PEXELS VIDEO FETCH ───────────────────────────────────────────────────────

function fetchPexelsVideo(query, outputPath) {
  var apiKey = process.env.PEXELS_API_KEY || config.pexels_api_key || "";
  if (!apiKey) return Promise.resolve(null);
  return new Promise(function(resolve) {
    var q = encodeURIComponent((query || "business").slice(0, 50));
    var opts = {
      hostname: "api.pexels.com",
      path: "/videos/search?query=" + q + "&per_page=5&orientation=landscape&size=medium",
      headers: { "Authorization": apiKey }
    };
    var req = https.request(opts, function(res) {
      var d = "";
      res.on("data", function(c){ d += c; });
      res.on("end", function() {
        try {
          var data = JSON.parse(d);
          var videos = (data.videos || []);
          if (!videos.length) return resolve(null);
          // Pick random from top 5
          var video = videos[Math.floor(Math.random() * Math.min(videos.length, 5))];
          // Get the medium quality file (not too large)
          var files = video.video_files || [];
          var file = files.find(function(f){ return f.quality === "hd" && f.width <= 1280; }) ||
                     files.find(function(f){ return f.quality === "sd"; }) ||
                     files[0];
          if (!file || !file.link) return resolve(null);

          var vidUrl = require("url").parse(file.link);
          var vidReq = https.request({
            hostname: vidUrl.hostname,
            path: vidUrl.path,
            headers: { "Authorization": apiKey }
          }, function(vidRes) {
            // Follow redirects
            if (vidRes.statusCode === 301 || vidRes.statusCode === 302) {
              var redir = require("url").parse(vidRes.headers.location);
              var rreq = https.request({ hostname: redir.hostname, path: redir.path + (redir.search||"") }, function(rres) {
                var chunks = [];
                rres.on("data", function(c){ chunks.push(c); });
                rres.on("end", function() {
                  var buf = Buffer.concat(chunks);
                  if (buf.length < 50000) return resolve(null);
                  fs.writeFileSync(outputPath, buf);
                  resolve(outputPath);
                });
              });
              rreq.on("error", function(){ resolve(null); });
              rreq.end();
              return;
            }
            var chunks = [];
            vidRes.on("data", function(c){ chunks.push(c); });
            vidRes.on("end", function() {
              var buf = Buffer.concat(chunks);
              if (buf.length < 50000) return resolve(null);
              fs.writeFileSync(outputPath, buf);
              resolve(outputPath);
            });
          });
          vidReq.on("error", function(){ resolve(null); });
          vidReq.end();
        } catch(e) { resolve(null); }
      });
    });
    req.on("error", function(){ resolve(null); });
    req.end();
  });
}

// ── SLIDE RENDERER ────────────────────────────────────────────────────────────

function makeSlidePng(slide, theme, outputPath, bgImagePath) {
  var sharp;
  try { sharp = require("sharp"); } catch(e) { return Promise.reject(new Error("sharp not available")); }
  var W = 1280, H = 720;
  var bg = hexToRgb(theme.bg);
  var fontFamily = FONT_FILE ? path.basename(FONT_FILE, ".ttf").replace(/[^a-zA-Z0-9 ]/g," ") + ",sans-serif" : "Arial,Helvetica,sans-serif";
  var svg;

  if (slide.type === "title") {
    var lines  = wrapWords(slide.headline, 30);
    var startY = Math.max(220, 340 - lines.length * 50);
    var els    = lines.slice(0,3).map(function(l,i){
      return '<text x="640" y="' + (startY+i*90) + '" font-family="' + fontFamily + '" font-size="72" font-weight="bold" fill="white" text-anchor="middle" filter="url(#shadow)">' + safeXml(l,36) + '</text>';
    }).join("");
    svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<filter id="shadow"><feDropShadow dx="0" dy="3" stdDeviation="8" flood-color="#000" flood-opacity="0.95"/></filter>' +
        '<filter id="glow"><feDropShadow dx="0" dy="0" stdDeviation="10" flood-color="#' + theme.accent + '" flood-opacity="0.5"/><feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000" flood-opacity="0.9"/></filter>' +
        '<linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#000" stop-opacity="0.2"/>' +
          '<stop offset="50%" stop-color="#000" stop-opacity="0.55"/>' +
          '<stop offset="100%" stop-color="#000" stop-opacity="0.88"/>' +
        '</linearGradient>' +
        '<linearGradient id="accentbar" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%" stop-color="#' + theme.accent + '"/>' +
          '<stop offset="100%" stop-color="#' + theme.accent + '" stop-opacity="0.3"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<rect width="' + W + '" height="' + H + '" fill="url(#grad)"/>' +
      // Top and bottom accent bars
      '<rect width="' + W + '" height="6" fill="url(#accentbar)"/>' +
      '<rect y="' + (H-6) + '" width="' + W + '" height="6" fill="url(#accentbar)"/>' +
      // Channel tag top left
      '<rect x="30" y="20" width="220" height="36" fill="#' + theme.accent + '" opacity="0.9" rx="4"/>' +
      '<text x="140" y="44" font-family="' + fontFamily + '" font-size="18" font-weight="bold" fill="white" text-anchor="middle">Untold Archive</text>' +
      // Accent divider line above title
      '<rect x="100" y="' + (startY - 40) + '" width="' + (W - 200) + '" height="3" fill="#' + theme.accent + '" opacity="0.8" rx="2"/>' +
      els +
      // Accent divider line below title
      '<rect x="100" y="' + (startY + (lines.length * 90) - 10) + '" width="' + (W - 200) + '" height="3" fill="#' + theme.accent + '" opacity="0.5" rx="2"/>' +
      // Sub text with darker backing
      '<rect x="120" y="' + (H-120) + '" width="' + (W - 240) + '" height="70" fill="#000" opacity="0.6" rx="8"/>' +
      '<text x="640" y="' + (H-75) + '" font-family="' + fontFamily + '" font-size="28" fill="#' + theme.sub + '" text-anchor="middle" filter="url(#shadow)">' + safeXml(slide.sub || "Watch this before your competition does", 70) + '</text>' +
      '</svg>';

  } else if (slide.type === "cta") {
    var ctaEls = (slide.body||[]).slice(0,2).map(function(l,i){
      return '<text x="640" y="' + (430+i*60) + '" font-family="' + fontFamily + '" font-size="32" fill="white" text-anchor="middle" filter="url(#shadow)">' + safeXml(l,60) + '</text>';
    }).join("");
    svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<filter id="shadow"><feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000" flood-opacity="0.9"/></filter>' +
        '<linearGradient id="grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#000" stop-opacity="0.4"/><stop offset="100%" stop-color="#000" stop-opacity="0.85"/></linearGradient>' +
      '</defs>' +
      '<rect width="' + W + '" height="' + H + '" fill="url(#grad)"/>' +
      '<rect width="' + W + '" height="6" fill="#' + theme.accent + '"/>' +
      // Bell icon area
      '<circle cx="640" cy="200" r="60" fill="#' + theme.accent + '" opacity="0.2"/>' +
      '<text x="640" y="216" font-family="' + fontFamily + '" font-size="60" text-anchor="middle">🔔</text>' +
      '<text x="640" y="330" font-family="' + fontFamily + '" font-size="58" font-weight="bold" fill="#' + theme.accent + '" text-anchor="middle" filter="url(#shadow)">' + safeXml(slide.headline, 42) + '</text>' +
      ctaEls +
      // CTA button
      '<rect x="340" y="' + (H-120) + '" width="600" height="70" fill="#' + theme.accent + '" rx="35"/>' +
      '<text x="640" y="' + (H-75) + '" font-family="' + fontFamily + '" font-size="30" font-weight="bold" fill="white" text-anchor="middle">' + safeXml(slide.cta || "Subscribe Now — It is Free!", 50) + '</text>' +
      '</svg>';

  } else {
    // Section slide — redesigned for maximum visual impact
    var headLines = wrapWords(slide.headline || "", 32);
    var body = slide.body || [];
    if (!headLines || headLines.length === 0) headLines = ["..."];

    // Headline elements — larger, bolder, left-aligned for modern look
    var headEls = headLines.slice(0,2).map(function(l, i) {
      var isFirst = i === 0;
      return '<text x="60" y="' + (160 + i * 75) + '" font-family="' + fontFamily + '" font-size="' + (isFirst ? 62 : 56) + '" font-weight="bold" fill="white" filter="url(#glow)">' + safeXml(l, 45) + '</text>';
    }).join("");

    // Body items as modern cards with accent left border
    var bodyEls = "";
    var cardY = headLines.length > 1 ? 310 : 260;
    for (var bi = 0; bi < Math.min(body.length, 3); bi++) {
      var cardH = 62;
      var bodyText = safeXml(body[bi], 58);
      // Card background
      bodyEls += '<rect x="60" y="' + cardY + '" width="' + (W - 120) + '" height="' + cardH + '" fill="#000" opacity="0.55" rx="6"/>';
      // Accent left bar
      bodyEls += '<rect x="60" y="' + cardY + '" width="5" height="' + cardH + '" fill="#' + theme.accent + '" rx="3"/>';
      // Number badge
      bodyEls += '<rect x="72" y="' + (cardY + 14) + '" width="32" height="32" fill="#' + theme.accent + '" opacity="0.9" rx="4"/>';
      bodyEls += '<text x="88" y="' + (cardY + 35) + '" font-family="' + fontFamily + '" font-size="18" font-weight="bold" fill="white" text-anchor="middle">' + (bi + 1) + '</text>';
      // Body text
      bodyEls += '<text x="118" y="' + (cardY + 38) + '" font-family="' + fontFamily + '" font-size="26" fill="white" filter="url(#shadow)">' + bodyText + '</text>';
      cardY += cardH + 12;
    }

    // Channel watermark bottom right
    var watermark = '<text x="' + (W - 20) + '" y="' + (H - 15) + '" font-family="' + fontFamily + '" font-size="16" fill="white" text-anchor="end" opacity="0.5">Untold Archive</text>';

    svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        // Lighter overlay so background video shows through more
        '<filter id="shadow"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.9"/></filter>' +
        '<filter id="glow"><feDropShadow dx="0" dy="0" stdDeviation="6" flood-color="#' + theme.accent + '" flood-opacity="0.4"/><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.9"/></filter>' +
        // Lighter gradient — lets background video breathe
        '<linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#000" stop-opacity="0.15"/>' +
          '<stop offset="35%" stop-color="#000" stop-opacity="0.45"/>' +
          '<stop offset="100%" stop-color="#000" stop-opacity="0.80"/>' +
        '</linearGradient>' +
        // Accent sweep top-left
        '<linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%" stop-color="#' + theme.accent + '" stop-opacity="0.35"/>' +
          '<stop offset="60%" stop-color="#' + theme.accent + '" stop-opacity="0"/>' +
        '</linearGradient>' +
      '</defs>' +
      // Main dark overlay — lighter than before
      '<rect width="' + W + '" height="' + H + '" fill="url(#grad)"/>' +
      // Accent sweep top band
      '<rect width="' + W + '" height="200" fill="url(#sweep)"/>' +
      // Top accent line — thicker and more visible
      '<rect width="' + W + '" height="5" fill="#' + theme.accent + '"/>' +
      // Left side accent bar
      '<rect width="5" height="' + H + '" fill="#' + theme.accent + '" opacity="0.6"/>' +
      // Headline area with subtle backing
      '<rect x="50" y="90" width="' + (W - 100) + '" height="' + (headLines.length > 1 ? 165 : 95) + '" fill="#000" opacity="0.35" rx="10"/>' +
      headEls +
      bodyEls +
      watermark +
      // Bottom accent strip
      '<rect y="' + (H - 4) + '" width="' + W + '" height="4" fill="#' + theme.accent + '" opacity="0.8"/>' +
      '</svg>';
  }

  // Composite: background image (if available) + dark overlay SVG
  var layers = [];
  if (bgImagePath && require("fs").existsSync(bgImagePath)) {
    layers.push({ input: bgImagePath, top: 0, left: 0 });
  }
  layers.push({ input: Buffer.from(svg), top: 0, left: 0 });

  var base = bgImagePath && require("fs").existsSync(bgImagePath)
    ? sharp(bgImagePath).resize(W, H, { fit: "cover", position: "centre" })
    : sharp({ create: { width: W, height: H, channels: 3, background: bg } });

  return base
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outputPath);
}

// ── SCRIPT → SLIDES ───────────────────────────────────────────────────────────

function scriptToSlides(title, scriptText) {
  var slides = [{ type: "title", headline: title, sub: "Watch this before your competition does" }];
  var lines = scriptText.split("\n").map(function(l){ return l.trim(); }).filter(function(l){ return l.length > 8; });
  var currentSection = "", currentBody = [];

  function flush() {
    if (currentSection || currentBody.length > 0) {
      slides.push({ type: "section", headline: currentSection || (currentBody[0]||"").slice(0,65), body: (currentSection ? currentBody : currentBody.slice(1)).slice(0,3) });
      currentSection = ""; currentBody = [];
    }
  }

  for (var i = 0; i < lines.length && slides.length < 37; i++) {
    var raw = lines[i], clean = raw.replace(/^#+\s*/,"").replace(/\*\*/g,"").trim();
    var isHeader = raw.startsWith("#") || /^(step|tip|point|section|intro|conclusion|outro|hook|number|\d+[\.\)])/i.test(clean);
    if (isHeader && slides.length > 0) { flush(); currentSection = clean.slice(0,65); }
    else currentBody.push(clean);
  }
  flush();

  var fillers = [
    { headline: "The Bottom Line",    body: ["Most people stop before they see results", "The ones who win just stayed consistent longer"] },
    { headline: "What Most Miss",     body: ["Everyone focuses on the wrong metric", "Shift your focus here and everything changes"] },
    { headline: "Action Step",        body: ["Do this one thing today — not tomorrow", "Five minutes now saves five hours later"] },
    { headline: "The Real Numbers",   body: ["Stop guessing and start tracking", "Data beats opinions every single time"] },
    { headline: "Insider Move",       body: ["This is what the top earners do differently", "It looks simple but most people overcomplicate it"] },
    { headline: "Watch Out For This", body: ["This mistake costs people thousands every year", "Now you know what to avoid"] },
    { headline: "Your Next Step",     body: ["Take one action before you close this video", "Small moves compound into massive results"] },
  ];
  var fi = 0;
  while (slides.length < 38) { slides.push({ type: "section", headline: fillers[fi % fillers.length].headline, body: fillers[fi % fillers.length].body }); fi++; }
  slides.push({ type: "cta", headline: "Like and Subscribe!", body: ["New videos every single day", "Hit the bell so you never miss one"], cta: "Subscribe Now — It is Free!" });
  return slides;
}

// ── MUSIC ─────────────────────────────────────────────────────────────────────

function generateMusic(ffmpegPath, durationSecs, outputPath) {
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) return outputPath;
  try {
    // Use spawn instead of execSync to avoid ETIMEDOUT on long durations
    var result = require("child_process").spawnSync(
      ffmpegPath,
      ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=" + (durationSecs+5),
       "-filter_complex", "volume=0.05", "-c:a", "aac", outputPath],
      { stdio: "pipe", timeout: 60000 }
    );
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      console.log("     ✓ Background music generated");
      return outputPath;
    }
  } catch(e) { console.log("     → Music error: " + e.message.slice(0,60)); }
  return null;
}

// ── ELEVENLABS VOICEOVER ──────────────────────────────────────────────────────

// Split text into chunks under 4800 chars at sentence boundaries
function splitIntoChunks(text, maxChars) {
  if (text.length <= maxChars) return [text];
  var chunks = [];
  var sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  var current = "";
  for (var i = 0; i < sentences.length; i++) {
    if ((current + sentences[i]).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = sentences[i];
    } else {
      current += sentences[i];
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// Call ElevenLabs for a single chunk
function elevenLabsChunk(text, apiKey, voiceId) {
  var body = JSON.stringify({ text: text, model_id: "eleven_turbo_v2_5", voice_settings: { stability: 0.35, similarity_boost: 0.85, style: 0.40, use_speaker_boost: true } });
  return new Promise(function(resolve) {
    var req = https.request({
      hostname: "api.elevenlabs.io", path: "/v1/text-to-speech/" + voiceId, method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", "Accept": "audio/mpeg", "Content-Length": Buffer.byteLength(body) },
    }, function(res) {
      if (res.statusCode !== 200) {
        var errBody = "";
        res.on("data", function(d) { errBody += d; });
        res.on("end", function() {
          console.log("     → ElevenLabs HTTP " + res.statusCode + " | " + errBody.slice(0, 120));
          resolve(null);
        });
        return;
      }
      var chunks = [];
      res.on("data", function(d) { chunks.push(d); });
      res.on("end", function() { resolve(Buffer.concat(chunks)); });
    });
    req.on("error", function(e) { console.log("     → ElevenLabs error: " + e.message); resolve(null); });
    req.write(body); req.end();
  });
}

function generateVoiceover(text, outputPath) {
  var apiKey  = process.env.ELEVENLABS_API_KEY || (config.elevenlabs && config.elevenlabs.api_key) || "";
  // Smart voice selector for dark history / mystery documentary channel
  // Priority: David Castlemore (proven mystery/thriller) → Frederick Surrey (British documentary)
  // → Your cloned voice (earns 22% affiliate commission) → Daniel (broadcaster fallback)
  // Set ELEVENLABS_CLONE_ID in Railway env vars to activate your clone as fallback
  var VOICE_PRIORITY = [
    process.env.ELEVENLABS_VOICE_DAVID || "nPczCjzI2devNBz1zQrb",  // David Castlemore — mystery/thriller
    process.env.ELEVENLABS_VOICE_FREDERICK || "t0jbNlBVZ17f02VDIeMI", // Frederick Surrey — British documentary
    process.env.ELEVENLABS_CLONE_ID || null,                          // Your clone (earns you commission)
    "onwK4e9ZLuTAKqWW03F9",                                           // Daniel — Steady Broadcaster fallback
  ].filter(Boolean)[0];
  var voiceId = (config.elevenlabs && config.elevenlabs.voice_id) || VOICE_PRIORITY || "onwK4e9ZLuTAKqWW03F9";
  apiKey = apiKey.trim();
  if (!apiKey || apiKey.length < 10) { console.log("     → No ElevenLabs key"); return Promise.resolve(null); }
  console.log("     → ElevenLabs key: " + apiKey.slice(0,8) + "... (" + apiKey.length + " chars)");

  // Split full script into chunks — paid plan allows 5000 chars per call
  var chunks = splitIntoChunks(text, 4800);
  console.log("     → Voiceover: " + text.length + " chars split into " + chunks.length + " chunk(s)");

  // Process all chunks sequentially, then concatenate audio buffers
  var promise = Promise.resolve([]);
  chunks.forEach(function(chunk, i) {
    promise = promise.then(function(buffers) {
      console.log("     → Chunk " + (i+1) + "/" + chunks.length + " (" + chunk.length + " chars)...");
      return elevenLabsChunk(chunk, apiKey, voiceId).then(function(buf) {
        if (buf) buffers.push(buf);
        return buffers;
      });
    });
  });

  return promise.then(function(buffers) {
    if (buffers.length === 0) { console.log("     → No audio generated"); return null; }
    var combined = Buffer.concat(buffers);
    fs.writeFileSync(outputPath, combined);
    var durationEst = Math.round(combined.length / 16000); // rough estimate
    console.log("     ✓ Voiceover generated (" + (combined.length/1024).toFixed(0) + "KB, ~" + durationEst + "s)");
    return outputPath;
  });

  // Legacy single-call path kept below for reference — no longer used
  var body = JSON.stringify({ text: text.slice(0,4800), model_id: "eleven_turbo_v2_5", voice_settings: { stability: 0.5, similarity_boost: 0.75 } });
  return new Promise(function(resolve) {
    var req = https.request({
      hostname: "api.elevenlabs.io", path: "/v1/text-to-speech/" + voiceId, method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", "Accept": "audio/mpeg", "Content-Length": Buffer.byteLength(body) },
    }, function(res) {
      if (res.statusCode !== 200) {
        var errBody = "";
        res.on("data", function(d) { errBody += d; });
        res.on("end", function() {
          console.log("     → ElevenLabs HTTP " + res.statusCode + " | " + errBody.slice(0, 120));
          resolve(null);
        });
        return;
      }
      var file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on("finish", function() { file.close(); console.log("     ✓ Voiceover generated"); resolve(outputPath); });
      file.on("error", function() { resolve(null); });
    });
    req.on("error", function(e) { console.log("     → ElevenLabs error: " + e.message); resolve(null); });
    req.write(body); req.end();
  });
}

// ── BUILD VIDEO ───────────────────────────────────────────────────────────────

function buildVideo(title, scriptText, outputPath, theme) {
  var ffmpegPath = findFfmpeg();
  if (!ffmpegPath) return Promise.resolve({ status: "no_ffmpeg" });
  try { require("sharp"); } catch(e) { return Promise.resolve({ status: "no_sharp" }); }

  var exec   = require("child_process").execSync;
  var tmpDir = path.join(process.cwd(), "tmp", "yt_" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  var slides = scriptToSlides(title, scriptText);
  console.log("     → Rendering " + slides.length + " slides (" + theme.name + " theme)...");

  // Fetch one Pexels image per slide topic (in parallel, best-effort)
  var pexelsKey = process.env.PEXELS_API_KEY || (config.pexels_api_key || "");
  var imgDir = path.join(tmpDir, "imgs");
  fs.mkdirSync(imgDir, { recursive: true });

  // Build smarter search queries based on slide content
  function buildImageQuery(slide, videoTitle) {
    var headline = (slide.headline || videoTitle || "").toLowerCase();
    var queryMap = [
      { keywords: ["war","battle","military","soldier","wwii","world war"], query: "world war historical black white photograph" },
      { keywords: ["mystery","vanish","disappear","missing","unsolved","lost"], query: "dark mysterious abandoned place fog atmospheric" },
      { keywords: ["space","nasa","planet","galaxy","universe","star","cosmos"], query: "nasa space galaxy nebula stunning photograph" },
      { keywords: ["psychology","brain","mind","behavior","human","thought"], query: "human mind brain psychology science illustration" },
      { keywords: ["history","historical","ancient","century","era","old","past"], query: "historical vintage photograph archive sepia" },
      { keywords: ["crime","murder","death","investigation","detective"], query: "crime scene investigation detective noir vintage" },
      { keywords: ["government","classified","secret","document","cia","fbi"], query: "classified government documents secret files" },
      { keywords: ["radiation","nuclear","experiment","science","lab","chemical"], query: "vintage science laboratory experiment dangerous" },
      { keywords: ["city","town","abandoned","ruin","ghost","empty","desolate"], query: "abandoned ghost town ruins atmospheric dark" },
      { keywords: ["person","man","woman","figure","shadow","silhouette"], query: "mysterious silhouette person dramatic lighting" },
      { keywords: ["ocean","sea","ship","wreck","deep","water","submarine"], query: "ocean deep dark mysterious shipwreck dramatic" },
      { keywords: ["forest","woods","wilderness","dark","nature","trees"], query: "dark atmospheric forest fog mystery night" },
    ]
    for (var i = 0; i < queryMap.length; i++) {
      for (var j = 0; j < queryMap[i].keywords.length; j++) {
        if (headline.includes(queryMap[i].keywords[j])) return queryMap[i].query;
      }
    }
    return headline.replace(/[^a-zA-Z0-9 ]/g, " ").slice(0, 40) || "business professional office";
  }

  // Fetch Pexels VIDEO clips per slide — falls back to image if video unavailable
  // Videos make backgrounds dynamic and dramatically improve visual quality
  var vidDir = path.join(tmpDir, "vids");
  fs.mkdirSync(vidDir, { recursive: true });

  var imgTasks = slides.map(function(slide, i) {
    if (!pexelsKey) return Promise.resolve({ video: null, image: null });
    var query = buildImageQuery(slide, title);
    var vidPath = path.join(vidDir, "bg" + i + ".mp4");
    var imgPath = path.join(imgDir, "bg" + i + ".jpg");
    // Try video first, fall back to image
    return fetchPexelsVideo(query, vidPath).then(function(vp) {
      if (vp) return { video: vp, image: null };
      // Video failed — use image fallback
      return fetchPexelsImage(query, imgPath).then(function(ip) {
        return { video: null, image: ip };
      });
    }).catch(function() {
      return { video: null, image: null };
    });
  });

  var pngTasks = Promise.all(imgTasks).then(function(bgAssets) {
    // Extract a still frame from video clips to use as slide background
    var framePromises = bgAssets.map(function(asset, i) {
      if (asset && asset.video && fs.existsSync(asset.video)) {
        // Extract frame at 1 second from video clip
        var framePath = path.join(imgDir, "frame" + i + ".jpg");
        try {
          var ffmpegPath = findFfmpeg();
          if (ffmpegPath) {
            require("child_process").execSync(
              "\"" + ffmpegPath + "\" -y -ss 1 -i \"" + asset.video + "\" -vframes 1 -q:v 2 \"" + framePath + "\"",
              { stdio: "pipe", timeout: 15000 }
            );
            if (fs.existsSync(framePath) && fs.statSync(framePath).size > 5000) {
              return Promise.resolve(framePath);
            }
          }
        } catch(e) {}
      }
      // Use image if video failed or unavailable
      return Promise.resolve(asset && asset.image ? asset.image : null);
    });

    return Promise.all(framePromises).then(function(bgImages) {
      return Promise.all(slides.map(function(slide, i) {
        var bgImg = bgImages[i] || null;
        var pngPath = path.join(tmpDir, "slide" + String(i).padStart(3,"0") + ".png");
        return makeSlidePng(slide, theme, pngPath, bgImg)
          .then(function() { return pngPath; })
          .catch(function(e) { console.log("     → Slide " + i + " err: " + e.message.slice(0,50)); return null; });
      }));
    });
  });

  return pngTasks.then(function(pngPaths) {
    var validPngs = pngPaths.filter(function(p){ return p && fs.existsSync(p) && fs.statSync(p).size > 500; });
    if (validPngs.length === 0) return { status: "no_pngs_built" };
    console.log("     → " + validPngs.length + "/" + slides.length + " PNGs ready (first: " + fs.statSync(validPngs[0]).size + " bytes)");

    var videoPath = path.join(tmpDir, "video_raw.mp4");
    try {
      exec("\"" + ffmpegPath + "\" -y -framerate 1/20 -pattern_type glob -i \"" + tmpDir + "/slide*.png\" -c:v libx264 -pix_fmt yuv420p -r 24 -preset ultrafast -crf 26 \"" + videoPath + "\"",
        { stdio: "pipe", timeout: 300000 });
    } catch(e) { return { status: "encode_error", message: e.message.slice(0,100) }; }
    if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 1000) return { status: "video_missing" };

    var totalSecs = validPngs.length * 20;
    var musicPath = path.join(process.cwd(), "tmp", "ambient.aac");
    var music     = generateMusic(ffmpegPath, totalSecs, musicPath);
    var voicePath = path.join(tmpDir, "voice.mp3");

    // Clean script before sending to ElevenLabs
    // Remove ## section markers, timestamps, and any non-spoken text
    var cleanScript = scriptText
      .replace(/##[^\n]*/g, "")
      .replace(/\([0-9]:[^)]*\)/g, "")
      .replace(/\*+([^*]+)\*+/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    console.log("     → Voiceover: " + cleanScript.length + " chars (~" + Math.round(cleanScript.length/15) + "s speech)");
    return generateVoiceover(cleanScript, voicePath).then(function(voiceFile) {
      var mixed = false;

      // ── AUDIO STRATEGY ─────────────────────────────────────────────────
      // Goal: voice + music covering the ENTIRE video length, no cutoffs.
      // - Voice is padded with silence at end if shorter than video (apad)
      // - Music loops to fill full video duration
      // - Both trimmed to exact video length with -t flag
      // - Fallback chain: voice+music → voice only → music only → silent

      var videoLen = totalSecs; // exact video duration in seconds
      console.log("     → Video length: " + videoLen + "s | mixing audio to match...");

      // Try voice + music — both stretched to cover full video
      if (voiceFile && music) {
        console.log("     → Mixing voice + music (full duration)...");
        try {
          // [1:a] = voice: pad with silence to video length
          // [2:a] = music: loop and trim to video length  
          // amix duration=longest so music fills any gap after voice ends
          exec("\"" + ffmpegPath + "\" -y " +
            "-i \"" + videoPath + "\" " +
            "-i \"" + voiceFile + "\" " +
            "-stream_loop -1 -i \"" + music + "\" " +
            "-filter_complex " +
            "\"[1:a]apad=whole_dur=" + videoLen + "[vpad];" +
            "[2:a]atrim=0:" + videoLen + ",volume=0.08[mloop];" +
            "[vpad]volume=1.6[vvol];" +
            "[vvol][mloop]amix=inputs=2:duration=longest[out]\" " +
            "-map 0:v -map \"[out]\" " +
            "-c:v copy -c:a aac -b:a 128k -t " + videoLen + " \"" + outputPath + "\"",
            { stdio: "pipe", timeout: 300000 });
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
            mixed = true;
            console.log("     ✓ Voice + music mixed (" + videoLen + "s)");
          }
        } catch(e) { console.log("     → Voice+music mix err: " + e.message.slice(0,120)); }
      }

      // Voice only — padded to full video length
      if (!mixed && voiceFile) {
        console.log("     → Adding voiceover (full duration)...");
        try {
          exec("\"" + ffmpegPath + "\" -y " +
            "-i \"" + videoPath + "\" " +
            "-i \"" + voiceFile + "\" " +
            "-filter_complex \"[1:a]apad=whole_dur=" + videoLen + ",volume=1.6[out]\" " +
            "-map 0:v -map \"[out]\" " +
            "-c:v copy -c:a aac -b:a 128k -t " + videoLen + " \"" + outputPath + "\"",
            { stdio: "pipe", timeout: 300000 });
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
            mixed = true;
            console.log("     ✓ Voice only mixed (" + videoLen + "s)");
          }
        } catch(e) { console.log("     → Voice-only err: " + e.message.slice(0,120)); }
      }

      // Music only — looped to full video length
      if (!mixed && music) {
        console.log("     → Adding music only (full duration)...");
        try {
          exec("\"" + ffmpegPath + "\" -y " +
            "-stream_loop -1 -i \"" + videoPath + "\" " +
            "-stream_loop -1 -i \"" + music + "\" " +
            "-filter_complex \"[1:a]atrim=0:" + videoLen + ",volume=0.3[out]\" " +
            "-map 0:v -map \"[out]\" " +
            "-c:v copy -c:a aac -t " + videoLen + " \"" + outputPath + "\"",
            { stdio: "pipe", timeout: 300000 });
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
            mixed = true;
            console.log("     ✓ Music only mixed (" + videoLen + "s)");
          }
        } catch(e) { console.log("     → Music-only err: " + e.message.slice(0,120)); }
      }

      // Silent fallback
      if (!mixed) {
        console.log("     → Saving silent video");
        try { exec("\"" + ffmpegPath + "\" -y -i \"" + videoPath + "\" -c copy \"" + outputPath + "\"", { stdio: "pipe" }); }
        catch(e2) { return { status: "final_error" }; }
      }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10000) return { status: "output_missing" };
      var sizeMb = (fs.statSync(outputPath).size/1024/1024).toFixed(1);
      var mins   = Math.round(validPngs.length * 20 / 60);
      console.log("     ✓ Video: " + sizeMb + "MB ~" + mins + "min | voice=" + (!!voiceFile) + " music=" + (!!music) + " slides=" + validPngs.length + " theme=" + theme.name);
      return { status: "built", path: outputPath, size_mb: sizeMb, minutes: mins, slides: validPngs.length, voice: !!voiceFile, music: !!music };
    });
  });
}

// ── YOUTUBE UPLOAD ────────────────────────────────────────────────────────────

function getAccessToken() {
  var cid = config.youtube.client_id, cs = config.youtube.client_secret, rt = config.youtube.refresh_token;
  if (!cid || !cs || !rt) return Promise.reject(new Error("YouTube credentials not configured"));
  var body = "client_id=" + encodeURIComponent(cid) + "&client_secret=" + encodeURIComponent(cs) + "&refresh_token=" + encodeURIComponent(rt) + "&grant_type=refresh_token";
  return new Promise(function(resolve, reject) {
    var req = https.request({ hostname: "oauth2.googleapis.com", path: "/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } },
      function(res) {
        var data = "";
        res.on("data", function(d){ data += d; });
        res.on("end", function(){
          try {
            var r = JSON.parse(data);
            if (r.access_token) {
              console.log("     → Access token obtained");
              resolve(r.access_token);
            } else {
              console.log("     → OAuth token error: " + JSON.stringify(r).slice(0,200));
              if (r.error === "invalid_grant") {
                console.log("     → TOKEN EXPIRED: Go to developers.google.com/oauthplayground and get a new refresh token. Update YOUTUBE_REFRESH_TOKEN in Railway.");
              }
              reject(new Error("Token: " + JSON.stringify(r)));
            }
          } catch(e){ reject(e); }
        });
      });
    req.on("error", reject); req.write(body); req.end();
  });
}

function uploadThumbnail(videoId, thumbnailPath, accessToken) {
  if (!thumbnailPath || !fs.existsSync(thumbnailPath)) return Promise.resolve(null);
  var imgData = fs.readFileSync(thumbnailPath);
  return new Promise(function(resolve) {
    var req = https.request({
      hostname: "www.googleapis.com", path: "/upload/youtube/v3/thumbnails/set?videoId=" + videoId, method: "POST",
      headers: { "Authorization": "Bearer " + accessToken, "Content-Type": "image/jpeg", "Content-Length": imgData.length },
    }, function(res) {
      var body = ""; res.on("data", function(d){ body += d; });
      res.on("end", function(){
        if (res.statusCode === 200 || res.statusCode === 204) {
          console.log("     ✓ Custom thumbnail uploaded");
          resolve(true);
        } else {
          console.log("     → Thumbnail HTTP " + res.statusCode + " | " + body.slice(0,120));
          resolve(false);
        }
      });
    });
    req.on("error", function(){ resolve(false); });
    req.write(imgData); req.end();
  });
}

// ── INJECT STORE LINK INTO DESCRIPTION ───────────────────────────────────────
// Amazon products matched to niche for YouTube descriptions
var YT_AMAZON_PRODUCTS = [
  { name: "Atomic Habits",               asin: "0735211299", niches: ["productivity","business","habits","motivation","gen z","first job","remote","gig"] },
  { name: "I Will Teach You to Be Rich", asin: "0761147489", niches: ["finance","money","budget","gig economy","personal finance","gen z","first job"] },
  { name: "The Intelligent Investor",    asin: "0060555661", niches: ["investing","finance","stock","wealth","money","market"] },
  { name: "Profit First",                asin: "073521414X", niches: ["finance","business","money","history and mystery","accounting"] },
  { name: "The $100 Startup",            asin: "0307951529", niches: ["startup","business","entrepreneur","side hustle","passive income"] },
  { name: "AI Superpowers",              asin: "132854639X", niches: ["ai","automation","technology","tools","chatgpt"] },
  { name: "Taxes Made Simple",           asin: "0981454224", niches: ["tax","irs","deduction","audit","gig economy","freelance","history and mystery"] },
  { name: "Rich Dad Poor Dad",           asin: "1612680194", niches: ["investing","wealth","passive income","finance","money"] },
  { name: "The Total Money Makeover",    asin: "159555078X", niches: ["finance","debt","budget","money","personal finance","gig","tax"] },
  { name: "The Gig Economy",             asin: "0814438709", niches: ["gig economy","freelance","uber","side hustle","remote","independent"] },
];

var YT_ASSOCIATE_ID = process.env.AMAZON_ASSOCIATE_ID || "jeored12-20";

function getYTAmazonLinks(niche, count) {
  count = count || 2;
  var lower = (niche || "").toLowerCase();
  return YT_AMAZON_PRODUCTS
    .map(function(p) { return Object.assign({}, p, { score: p.niches.filter(function(n){ return lower.includes(n); }).length, url: "https://www.amazon.com/dp/" + p.asin + "?tag=" + YT_ASSOCIATE_ID }); })
    .sort(function(a,b){ return b.score - a.score; })
    .slice(0, count);
}

function buildDescription(desc, niche) {
  var storeUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN + "/store"
    : null;
  var storeBlock = storeUrl
    ? "\n\n🛒 GET THE TOOLKIT: " + storeUrl + "\n(Digital guides & toolkits — instant download)"
    : "";
  var affiliateBlock = "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "🎙️ TOOLS I USE TO RUN THIS CHANNEL:\n" +
    "✅ ElevenLabs AI Voice (the voice you just heard)\n" +
    "   Try it FREE → https://try.elevenlabs.io/2pu1o9y92jl1\n" +
    "   (Seriously the best AI voice tool available right now)";

  // Add Amazon book recommendations matched to niche
  var amazonBlock = "";
  try {
    var books = getYTAmazonLinks(niche || "", 2);
    if (books.length > 0) {
      amazonBlock = "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "📚 BOOKS MENTIONED IN THIS VIDEO:\n" +
        books.map(function(b){ return "✅ " + b.name + "\n   → " + b.url; }).join("\n\n") +
        "\n\n(Affiliate links — I earn a small commission at no cost to you)";
    }
  } catch(e) {}

  return desc + storeBlock + amazonBlock + affiliateBlock + "\n\n---\nNew video every day. Subscribe & hit the bell 🔔";
}

function uploadVideo(videoFilePath, scriptData, thumbnailPath) {
  if (!config.youtube.refresh_token) return Promise.resolve({ status: "no_credentials" });
  if (!fs.existsSync(videoFilePath)) return Promise.resolve({ status: "no_video_file" });
  return getAccessToken().then(function(accessToken) {
    // Sanitize tags — YouTube rejects uploads if any tag has bad chars or is too long
    var rawTags = scriptData.tags || ["AI","tools","tutorial"];
    var cleanTags = rawTags
      .map(function(t){ return String(t).replace(/[<>]/g,"").replace(/,/g,"").trim().slice(0,30); })
      .filter(function(t){ return t.length > 0 && t.length <= 30; })
      .slice(0, 15);
    if (cleanTags.length === 0) cleanTags = ["AI tools","history and mystery","productivity"];

    var initBody = JSON.stringify({
      snippet: { title: (scriptData.title||"AI Tools Video").slice(0,100), description: buildDescription(scriptData.description||"Subscribe for daily videos!", scriptData.niche||""), tags: cleanTags, categoryId: "27" },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    });
    var fileSize = fs.statSync(videoFilePath).size;
    return new Promise(function(resolve) {
      var initReq = https.request({
        hostname: "www.googleapis.com", path: "/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", method: "POST",
        headers: { "Authorization": "Bearer " + accessToken, "Content-Type": "application/json", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": fileSize, "Content-Length": Buffer.byteLength(initBody) },
      }, function(res) {
        var uploadUrl = res.headers.location;
        if (!uploadUrl) {
          // Read error body to understand why YouTube rejected the init request
          var errBody = "";
          res.on("data", function(d){ errBody += d; });
          res.on("end", function(){
            console.log("     → YouTube init HTTP " + res.statusCode + " | " + errBody.slice(0,200));
            resolve({ status: "error", message: "No upload URL (HTTP " + res.statusCode + ")" });
          });
          return;
        }
        console.log("     → Uploading to YouTube...");
        var videoData = fs.readFileSync(videoFilePath);
        var urlObj = new URL(uploadUrl);
        var upReq = https.request({
          hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: "PUT",
          headers: { "Content-Type": "video/mp4", "Content-Length": fileSize },
        }, function(upRes) {
          var body2 = ""; upRes.on("data", function(d){ body2 += d; });
          upRes.on("end", function(){
            try {
              var r = JSON.parse(body2);
              if (r.id) {
                console.log("     ✓ Uploaded! https://youtu.be/" + r.id);
                auditLog("YOUTUBE_UPLOADED", { video_id: r.id, title: scriptData.title });
                uploadThumbnail(r.id, thumbnailPath, accessToken).then(function(){
                  resolve({ status: "success", video_id: r.id, url: "https://youtu.be/" + r.id });
                });
              } else resolve({ status: "error", body: body2.slice(0,200) });
            } catch(e){ resolve({ status: "parse_error" }); }
          });
        });
        upReq.on("error", function(e){ resolve({ status: "network_error", message: e.message }); });
        upReq.write(videoData); upReq.end();
      });
      initReq.on("error", function(e){ resolve({ status: "init_error", message: e.message }); });
      initReq.write(initBody); initReq.end();
    });
  }).catch(function(err){ return { status: "error", message: err.message }; });
}

// ── AI RESEARCH ───────────────────────────────────────────────────────────────

// Rotating niche expansions — keeps content fresh across related topics
var NICHE_ANGLES = [
  "dark untold history forgotten by textbooks",
  "cold war secrets and classified experiments",
  "psychology behind why people do what they do",
  "unsolved mysteries and unexplained disappearances",
  "space discoveries that changed everything",
  "historical figures nobody talks about",
  "government cover-ups and classified documents",
  "disasters and catastrophes that changed history",
  "ancient civilizations and lost knowledge",
  "serial killers and criminal psychology",
  "cold cases and true crime mysteries",
  "soviet union secret experiments and programs",
  "world war secrets never taught in school",
  "mysterious deaths of famous people",
  "underground societies and secret organizations",
  "paranormal events with scientific explanations",
  "medical experiments that changed history",
  "nuclear accidents and cover-ups",
  "strange phenomena scientists cannot explain",
  "historical hoaxes that fooled the world",
  "lost civilizations and archaeological mysteries",
  "mind control experiments exposed",
  "royal family dark secrets throughout history",
  "corporate cover-ups that hurt millions",
  "space anomalies and unexplained discoveries",
  "psychological manipulation tactics exposed",
  "historical disasters governments tried to hide",
  "famous missing persons cases never solved",
  "dark origins of everyday things",
  "Cold War near-misses that almost ended the world",
];

function getRotatingNiche(baseNiche, usedCount) {
  // Rotate niche every single video to guarantee different topics every day
  // Uses day of year + usedCount so even if usedCount resets, day-of-year keeps rotation going
  var dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  var idx = (dayOfYear + usedCount) % NICHE_ANGLES.length;
  var rotated = NICHE_ANGLES[idx];
  console.log("     → Niche rotation: \"" + rotated + "\" (day " + dayOfYear + ", idx " + idx + ")");
  return rotated;
}

function researchTopics(niche, usedTopics) {
  var avoidList = (usedTopics||[]).slice(-30).join(", ") || "none yet";
  var activeNiche = getRotatingNiche(niche, (usedTopics||[]).length);

  // Load brain data to inform topic selection with real channel performance
  var brainContext = "";
  try {
    var brainFile = path.join(process.cwd(), "data", "brain.json");
    if (fs.existsSync(brainFile)) {
      var brain = JSON.parse(fs.readFileSync(brainFile, "utf8"));
      var bestAngle = brain.strategy && brain.strategy.current_focus_angle ? brain.strategy.current_focus_angle : null;
      var topVideos = (brain.videos || []).sort(function(a,b){ return (b.views||0)-(a.views||0); }).slice(0,3);
      if (bestAngle) brainContext += "\nBEST PERFORMING ANGLE on this channel: " + bestAngle + " — use this angle for at least 2 topics\n";
      if (topVideos.length > 0) {
        brainContext += "TOP PERFORMING VIDEOS (model these):\n";
        topVideos.forEach(function(v){ if(v.title) brainContext += "- " + v.title + " (" + (v.views||0) + " views)\n"; });
      }
    }
  } catch(e) {}

  return client.messages.create({
    model: config.anthropic.model, max_tokens: 1500,
    messages: [{ role: "user", content:
      "You are a world-class YouTube strategist for a dark history, mystery, and psychology documentary channel.\\n\\n" +
      "Your ONLY job is generating titles that make someone stop scrolling and click IMMEDIATELY.\\n\\n" +
      "Generate 8 HIGH-PERFORMING video topics for niche: \\\"" + activeNiche + "\\\"\\n\\n" +
      (brainContext ? brainContext + "\\n" : "") +
      "ALREADY USED — DO NOT repeat or closely resemble these:\\n" + avoidList + "\\n\\n" +
      "PROVEN TITLE FORMULAS FOR DARK HISTORY CHANNELS:\\n\\n" +
      "FORMULA 1 — MrBallen style (highest retention):\\n" +
      "The [Person/Place] That [Shocking Fact] — And Nobody Was Allowed To Talk About It\\n" +
      "Examples: The Man Who Saved The World — And Was Punished For It\\n" +
      "         The City That Vanished Overnight — Nobody Was Allowed To Talk About It\\n\\n" +
      "FORMULA 2 — Evidence style:\\n" +
      "What Really Happened To [Famous Mystery] — The Evidence Changes Everything\\n" +
      "Examples: What Really Happened To The Romanovs — The Evidence Changes Everything\\n\\n" +
      "FORMULA 3 — Dark truth style:\\n" +
      "The Untold Story of [Famous Person/Place] — What History Books Leave Out\\n" +
      "Examples: The Untold Story of Nikola Tesla — What They Never Teach In School\\n\\n" +
      "FORMULA 4 — Psychology style:\\n" +
      "[Number] Psychology Facts That Will Change How You See [Common Thing]\\n" +
      "Examples: 5 Psychology Facts That Explain Why You Cannot Stop Scrolling\\n\\n" +
      "FORMULA 5 — Mystery style:\\n" +
      "The [Object/Place/Event] That Scientists Cannot Explain\\n" +
      "Examples: The Deepest Hole Ever Dug — What They Found Terrified Scientists\\n\\n" +
      "RULES:\\n" +
      "1. Every title must create a CURIOSITY GAP — the viewer must feel they NEED the answer\\n" +
      "2. Use these power words: UNTOLD, DARK, REAL, TRUTH, HIDDEN, VANISHED, CLASSIFIED, FORGOTTEN\\n" +
      "3. Include SPECIFIC REAL details — real dates, real names, real places whenever possible\\n" +
      "4. Title length: 55-80 characters\\n" +
      "5. NEVER use: How to, Tips for, Guide to, Tutorial\\n" +
      "6. Every hook must START WITH THE END — the most shocking moment of the story first\\n" +
      "7. Avoid living celebrities, trademarked brands, politically divisive topics\\n\\n" +
      "Return ONLY a valid JSON array, no markdown:\\n" +
      "[{\\\"title\\\":\\\"The Man Who Saved The World — And Was Punished For It\\\",\\\"hook\\\":\\\"On September 26 1983 one man decided not to follow orders. That decision prevented nuclear war. The Soviet Union gave him a reprimand.\\\",\\\"angle\\\":\\\"dark_history\\\",\\\"niche\\\":\"" + activeNiche + "\"}]"    }],
  }).then(function(res) {
    var text = res.content[0].text.trim().replace(/```json/g,"").replace(/```/g,"").trim();
    var start = text.indexOf("["), end = text.lastIndexOf("]");
    if (start === -1) throw new Error("no array");
    return JSON.parse(text.slice(start, end+1));
  }).catch(function() {
    var day = new Date().getDate() + (usedTopics||[]).length;
    var fallbacks = [
      { title: "WARNING: IRS Is Flagging These 5 AI Tool Deductions in 2025", hook: "My client got an IRS notice last month. She wrote off $3,400 in AI tools the wrong way. Here is exactly what not to do.", angle: "warning" },
      { title: "EXPOSED: The $847/Month Hidden Fees Inside \"Free\" Business Tools", hook: "I audited 12 small business tool stacks last quarter. Every single one had charges the owner had completely forgotten about.", angle: "exposed" },
      { title: "5 SECRET AI Tools Big Corporations Hide From Small Business Owners", hook: "These tools cost enterprises $50,000 a year. You can access the same capabilities for under $30 a month. Here is how.", angle: "secrets" },
      { title: "STOP Paying Your Accountant $500/Month — AI Does This For $0", hook: "I replaced a $6,000 per year bookkeeping bill with three AI tools that now run automatically every single day.", angle: "stop" },
      { title: "WARNING: QuickBooks Is Making These Silent Changes to Your Bill in 2025", hook: "Three of my clients opened their statements last week and found charges they had never agreed to. Here is what to look for.", angle: "warning" },
      { title: "EXPOSED: Why 94% of Small Businesses Fail Their First IRS Audit", hook: "I have seen the inside of enough IRS audit letters to know exactly what triggers them. Number three on this list surprises everyone.", angle: "exposed" },
      { title: "I Replaced My $3,200/Month Marketing Agency With AI — Real Numbers", hook: "Month one after firing the agency: $0 spent, 40% more leads. Month six: I can not believe I waited this long.", angle: "case-study" },
      { title: "NEVER Start a Business Until You Know These 7 IRS Rules", hook: "The IRS has seven specific triggers for small business audits. Most new business owners violate at least three of them in year one.", angle: "warning" },
      { title: "SECRET: How I Built a $500/Day Business With $0 Startup Cost Using AI", hook: "No office, no employees, no inventory. Just three AI tools running 24 hours a day generating income while I sleep.", angle: "secrets" },
      { title: "STOP Filing Taxes Like This — The IRS Is Quietly Flagging These Returns", hook: "A tax attorney told me something last week that most small business owners will never hear from their accountants.", angle: "warning" },
      { title: "The $4,200 Business Mistake 9 Out of 10 Small Business Owners Make", hook: "It is not a flashy mistake. It is the boring one that silently drains thousands from your business every single year.", angle: "mistakes" },
      { title: "7 FREE AI Tools Replacing $2,000/Month Software For Small Businesses", hook: "I built a complete business tech stack for $0 per month. Every single tool on this list has a free tier that actually works.", angle: "tools" },
      { title: "EXPOSED: Shopify Is Taking More Money Than You Think — Check Your Statement", hook: "Most Shopify store owners focus on transaction fees. They completely miss the three other ways Shopify is quietly taking money.", angle: "exposed" },
      { title: "WARNING: Your Business Bank Account Is Not FDIC Insured — Here Is Why", hook: "If you use a fintech business account, your money may not be protected the way you think it is. This is not hypothetical.", angle: "warning" },
      { title: "The Man Who Accidentally Discovered Radiation — And Paid With His Life", hook: "Her fingers were glowing in the dark. Not metaphorically. Literally glowing. And she had no idea why — until it was too late.", angle: "dark_history" },
      { title: "The City That Vanished Overnight — And Nobody Was Allowed To Talk About It", hook: "In 1908, an entire town of 1,500 people ceased to exist in under four hours. The government sealed the records for sixty years.", angle: "mystery" },
      { title: "The Psychology Behind Why You Cannot Stop Scrolling — It Was Designed This Way", hook: "There is a room in Menlo Park where engineers spent years figuring out how to make you feel empty so you would keep scrolling. This is what they built.", angle: "psychology" },
      { title: "What Really Happened to the Romanovs — The Evidence Changes Everything", hook: "For seventy years, the world believed they knew exactly what happened in that basement in 1918. They were wrong about almost everything.", angle: "dark_history" },
      { title: "The Deepest Hole Ever Dug — And What They Found That Terrified Scientists", hook: "In 1970, Soviet scientists began drilling into the earth. Twelve miles down, they found something that rewrote everything we thought we knew about our planet.", angle: "science_mystery" },
    ];
    return [fallbacks[day % fallbacks.length]];
  });
}

function generateScript(topic, niche, product_url) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 4096,
    system: "You are a world-class documentary narrator and historian — the voice behind channels like Forgotten History and Untold Archive. Every script you write gets millions of views because:\n" +
      "1. You START WITH THE END — your very first sentence reveals the most shocking moment of the entire story. MrBallen's rule: if you want a story to land, start with the end.\n" +
      "2. You write in PRESENT TENSE for historical events — not \'In 1943, a man died\' but \'It is 1943. A man is dying.\' This makes history feel immediate.\n" +
      "3. Every 90 seconds you plant a CURIOSITY GAP — something the viewer needs to know that you reveal later.\n" +
      "4. You use SPECIFIC REAL details — real dates, real names, real places, real numbers. Vague history loses viewers.\n" +
      "5. Your pacing creates SUSPENSE — short punchy sentences for shocking revelations, longer flowing sentences for building atmosphere.\n" +
      "6. You NEVER say: Hey guys, Welcome back, In this video, Today we are going to, Make sure to subscribe, Let me know in the comments.\n" +
      "7. You build DREAD slowly — the viewer should feel unease building throughout the video.\n" +
      "8. Mid-video you drop a subscribe line naturally: \'If stories like this fascinate you, subscribe — I upload one every single week.\'\n" +
      "9. You end with a LINGERING QUESTION — something that stays with the viewer after the video ends.\n" +
      "10. You NEVER sensationalize — the facts are disturbing enough. Your tone is calm, measured, authoritative. Like a respected historian who has seen too much.\n" +
      "NEVER use bullet points in spoken narration. NEVER sound like AI wrote this. NEVER be vague when a specific number works.",
    messages: [{ role: "user", content:
      "Write a complete 10-12 minute YouTube script for: \"" + topic.title + "\"\n" +
      "Niche: " + niche + "\n" +
      "Angle: " + (topic.angle || "educational") + "\n" +
      "Opening hook line: \"" + (topic.hook || "What I am about to show you changes everything") + "\"\n" +
      (product_url ? "Mention this resource ONCE naturally around the 7-minute mark: " + product_url + "\n" : "") +
      "\nCRITICAL SCRIPT REQUIREMENTS:\n" +
      "- 2000-2400 words of pure SPOKEN narration\n" +
      "- First 30 seconds must be a PATTERN INTERRUPT — say something surprising, bold, or counterintuitive\n" +
      "- Use ## only as invisible section markers — viewers never see these\n" +
      "- Write like you are talking to ONE person — use \'you\' constantly\n" +
      "- Include at least 2 OPEN LOOPS: tease something coming up to keep them watching\n" +
      "- Use specific numbers, dollar amounts, timeframes — vague claims lose viewers\n" +
      "- Every section needs a mini-story or real example\n" +
      "- Transitions must flow naturally — no \'moving on\' or \'next point\'\n\n" +
      "STRUCTURE:\n" +
      "## HOOK (0:00-0:30)\n" +
      "Start MID-STORY or with a bold statement. No \'Hey guys welcome back\'. Drop them straight into the most interesting moment.\n\n" +
      "## OPEN LOOP 1 + INTRO (0:30-1:30)\n" +
      "Establish credibility, tease 2-3 things they will learn, create anticipation.\n\n" +
      "## POINT 1 (1:30-3:30)\n" +
      "Deep dive with story, specific example, and takeaway. Include a mini open loop.\n\n" +
      "## POINT 2 (3:30-5:30)\n" +
      "Build on point 1. Real numbers and outcomes. Keep energy up.\n\n" +
      "## POINT 3 (5:30-7:30)\n" +
      "Most valuable insight. This is where viewers decide to subscribe.\n" +
      "End this section with a NATURAL subscribe CTA — something like: If you want more of this, hit subscribe. I drop one of these every single day.\n" +
      (product_url ? "Natural resource mention here.\n" : "") + "\n" +
      "## POINT 4 (7:30-8:30)\n" +
      "Strong actionable section — give them something they can do TODAY. Real specific steps.\n\n" +
      "## POINT 5 (8:30-10:00)\n" +
      "The section most videos skip — go deeper on the biggest mistake or the most counterintuitive truth.\n\n" +
      "## POINT 6 + MOMENTUM (10:00-11:30)\n" +
      "Faster pace, quick wins, callback to earlier open loops, build to the conclusion.\n\n" +
      "## CLOSE (11:30-12:40)\n" +
      "Callback to the hook, key takeaway in one sentence.\n" +
      "Mention the books or resources in the description — say something like: I linked the books that helped me most in the description below, grab whichever one fits where you are right now.\n" +
      "End with a subscribe CTA that feels earned not begged — something like: If this was useful, subscribe. New video every single day at 8am.\n\n" +
      "Write the COMPLETE script now. Every word spoken. Nothing summarized."
    }],
  }).then(function(res){ return res.content[0].text; });
}

function generateMetadata(topic, niche) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 1400,
    messages: [{ role: "user", content:
      "You are a YouTube SEO expert. Create fully optimized metadata for this video.\n\n" +
      "Video title: \"" + topic.title + "\"\n" +
      "Niche: " + niche + "\n" +
      "Angle: " + (topic.angle || "educational") + "\n\n" +
      "TITLE RULES:\n" +
      "- 60-80 characters (YouTube shows ~60 in search)\n" +
      "- Front-load the POWER WORD: WARNING, EXPOSED, SECRET, STOP, NEVER — this determines click rate\n" +
      "- Keep the emotional hook AND the villain or fear element from the original title\n" +
      "- Include a specific dollar amount if the topic allows it\n" +
      "- Include 2025 or 2026 if the topic is evergreen — recency signals boost algorithm ranking\n" +
      "- Never truncate mid-word\n" +
      "- NEVER start with: How to, Tips for, Guide to, Introduction to, Ways to — these kill CTR\n\n" +
      "DESCRIPTION RULES:\n" +
      "- First 2 lines (157 chars) are what shows in search — make them count\n" +
      "- Line 1: bold hook that matches the thumbnail promise\n" +
      "- Line 2: exactly what they will learn\n" +
      "- Then: 3-5 sentence summary of video content\n" +
      "- Then: timestamps section (use realistic times like 0:00, 1:30, 3:00, etc.)\n" +
      "- Then: 3-4 relevant hashtags\n" +
      "- End with: subscribe CTA\n" +
      "- Total: 300-500 words\n\n" +
      "TAGS RULES:\n" +
      "- 20 tags total\n" +
      "- Mix: 5 broad tags, 10 specific long-tail tags, 5 trending related tags\n" +
      "- Include exact match of video title as first tag\n" +
      "- Include niche keyword variations\n" +
      "- Include year (2025, 2026) in at least 2 tags\n" +
      "- No spaces within individual tags — use hyphens if needed\n\n" +
      "Return ONLY valid JSON, no markdown:\n" +
      "{\"title\":\"optimized title here\",\"description\":\"full description here\",\"tags\":[\"tag1\",\"tag2\"],\"category\":\"27\"}"
    }],
  }).then(function(res) {
    var text = res.content[0].text.trim().replace(/```json/g,"").replace(/```/g,"").trim();
    var start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start === -1) throw new Error("no json");
    var meta = JSON.parse(text.slice(start, end+1));
    // Safety checks
    if (!meta.title || meta.title.length < 10) meta.title = topic.title;
    if (meta.title.length > 100) meta.title = meta.title.slice(0, 97) + "...";
    if (!meta.description || meta.description.length < 50) {
      meta.description = topic.hook + "\n\nIn this video: " + topic.title + "\n\nSubscribe for daily videos on " + niche + ".";
    }
    if (!meta.tags || meta.tags.length < 5) {
      meta.tags = [niche, "AI tools", "history and mystery", "productivity", "2025", "2026", "tutorial", "how to", topic.angle||"tips", "make money online"];
    }
    meta.category = "27";
    return meta;
  }).catch(function(){
    return {
      title: topic.title.slice(0, 90),
      description: (topic.hook || "Watch this before your competition does.") + "\n\nIn this video I cover:\n- " + topic.title + "\n\nTimestamps:\n0:00 Introduction\n1:30 The Problem\n3:00 Solution 1\n5:00 Solution 2\n7:30 Key Takeaway\n9:00 Final Thoughts\n\n#" + niche.replace(/\s+/g,"") + " #SmallBusiness #AITools\n\nSubscribe for daily tips on " + niche + ".",
      tags: [topic.title.slice(0,30), niche.slice(0,30), "AI tools for business", "small business tips", "productivity hacks", "make money online", "passive income 2025", "AI automation", "business tips 2026", "how to use AI", "entrepreneur tips", "side hustle", "digital products", "online business", "work from home"],
      category: "27"
    };
  });
}

function saveVideoPackage(topic, script, metadata) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  var slug     = topic.title.toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,30);
  var videoDir = path.join(OUT_DIR, slug);
  fs.mkdirSync(videoDir, { recursive: true });
  fs.writeFileSync(path.join(videoDir,"script.txt"), script);
  fs.writeFileSync(path.join(videoDir,"metadata.json"), JSON.stringify(metadata,null,2));
  fs.writeFileSync(path.join(videoDir,"description.txt"), metadata.description||"");
  var logFile = path.join(DATA_DIR, "videos.json");
  var log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile,"utf8")) : [];
  log.push({ date: new Date().toISOString(), slug, title: topic.title, status: "ready", dir: videoDir });
  fs.writeFileSync(logFile, JSON.stringify(log,null,2));
  auditLog("YOUTUBE_VIDEO_CREATED", { title: topic.title });
  return videoDir;
}

function getGrowthStatus() {
  var logFile = path.join(DATA_DIR, "videos.json");
  var videos  = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile,"utf8")) : [];
  return { videos_created: videos.length, videos_uploaded: videos.filter(function(v){ return v.status==="uploaded"; }).length };
}

// ── YOUTUBE SHORTS ───────────────────────────────────────────────────────────

function buildShort(longVideoPath, ffmpegPath, outputPath) {
  try {
    var exec = require("child_process").execSync;
    var fs2  = require("fs");
    var path2 = require("path");

    // Strategy: skip the first 2 seconds (usually a dark title card)
    // and take 55 seconds starting at 2s — this gets to the action faster
    // Then apply vertical crop + speed boost on the first 5 seconds
    // to hook viewers before they can swipe

    var shortDuration = 55;
    var startOffset   = 2; // skip opening title card — gets to content faster

    // Step 1 — Extract the core 55 seconds starting at 2s
    var rawPath = outputPath.replace(".mp4", "_raw.mp4");
    var extractCmd = "\"" + ffmpegPath + "\" -y" +
      " -ss " + startOffset +
      " -t " + shortDuration +
      " -i \"" + longVideoPath + "\"" +
      " -c copy" +
      " \"" + rawPath + "\"";

    exec(extractCmd, { timeout: 60000 });

    if (!fs2.existsSync(rawPath) || fs2.statSync(rawPath).size < 10000) {
      // Fallback — use from start if extract failed
      rawPath = longVideoPath;
    }

    // Step 2 — Clean simple crop to 9:16 vertical — fast and reliable
    var cmd = "\"" + ffmpegPath + "\" -y" +
      " -i \"" + rawPath + "\"" +
      " -vf \"crop=405:720:437:0,scale=1080:1920:flags=lanczos\"" +
      " -c:v libx264 -preset fast -crf 22" +
      " -c:a aac -b:a 128k" +
      " -t " + shortDuration +
      " -movflags +faststart" +
      " \"" + outputPath + "\"";

    console.log("     → Building Short (55s from 2s mark, vertical crop)...");
    exec(cmd, { timeout: 120000 });

    // Clean up raw extract
    try { if (rawPath !== longVideoPath) fs2.unlinkSync(rawPath); } catch(e) {}

    if (fs2.existsSync(outputPath) && fs2.statSync(outputPath).size > 50000) {
      console.log("     ✓ Short built: " + Math.round(fs2.statSync(outputPath).size / 1024) + "KB");
      return outputPath;
    }

    if (fs2.existsSync(outputPath) && fs2.statSync(outputPath).size > 50000) {
      console.log("     ✓ Short built (simple): " + Math.round(fs2.statSync(outputPath).size / 1024) + "KB");
      return outputPath;
    }

    console.log("     → Short build failed — output too small");
    return null;
  } catch(e) {
    console.log("     → Short build error: " + e.message.slice(0, 120));
    // Last resort fallback — simple crop from start
    try {
      var exec2 = require("child_process").execSync;
      var fallbackCmd = "\"" + ffmpegPath + "\" -y -ss 0 -t 55 -i \"" + longVideoPath + "\" -vf \"crop=405:720:437:0,scale=1080:1920\" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k \"" + outputPath + "\"";
      exec2(fallbackCmd, { timeout: 120000 });
      if (require("fs").existsSync(outputPath) && require("fs").statSync(outputPath).size > 50000) {
        console.log("     ✓ Short built (fallback)");
        return outputPath;
      }
    } catch(e2) {}
    return null;
  }
}

function uploadShort(shortVideoPath, longTitle, tags, accessToken) {
  if (!shortVideoPath || !fs.existsSync(shortVideoPath)) return Promise.resolve(null);
  var shortTitle = ("#Shorts " + longTitle).slice(0, 100);
  var shortDesc  = buildDescription("Watch the full video on our channel for the complete breakdown.", "") + "\n\n#Shorts #" + (tags[0]||"tips").replace(/[^a-zA-Z0-9]/g,"");


  var initBody = JSON.stringify({
    snippet: { title: shortTitle, description: shortDesc, tags: (tags||[]).concat(["Shorts","short","youtube shorts"]).slice(0,15), categoryId: "27" },
    status:  { privacyStatus: "public", selfDeclaredMadeForKids: false },
  });
  var fileSize = fs.statSync(shortVideoPath).size;
  return new Promise(function(resolve) {
    var initReq = https.request({
      hostname: "www.googleapis.com",
      path: "/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": fileSize,
        "Content-Length": Buffer.byteLength(initBody),
      },
    }, function(res) {
      var uploadUrl = res.headers.location;
      if (!uploadUrl) { resolve(null); return; }
      var fileData = fs.readFileSync(shortVideoPath);
      var uploadReq = https.request(uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": fileSize } },
        function(upRes) {
          var d = "";
          upRes.on("data", function(c){ d += c; });
          upRes.on("end", function() {
            try {
              var r = JSON.parse(d);
              if (r.id) {
                console.log("     ✓ Short uploaded! https://youtube.com/shorts/" + r.id);
                resolve({ id: r.id, url: "https://youtube.com/shorts/" + r.id });
              } else {
                console.log("     → Short upload response: " + d.slice(0, 100));
                resolve(null);
              }
            } catch(e) { resolve(null); }
          });
        }
      );
      uploadReq.on("error", function(){ resolve(null); });
      uploadReq.write(fileData);
      uploadReq.end();
    });
    initReq.on("error", function(){ resolve(null); });
    initReq.write(initBody);
    initReq.end();
  });
}

// ── MAIN RUN ──────────────────────────────────────────────────────────────────

function run(niche, product_url) {
  console.log("\n  📹 YouTube Module running...");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  var usedTopics = getUsedTopics();
  var dayNum     = usedTopics.length;
  var theme      = getTheme(dayNum);
  var topicData, scriptText, metaData, videoDir;

  return researchTopics(niche, usedTopics).then(function(topics) {
    // Pick first topic not similar to already-used ones
    topicData = topics[0];
    for (var i = 0; i < topics.length; i++) {
      var t = topics[i].title.toLowerCase();
      var isDupe = usedTopics.some(function(u){
        return u.split(" ").filter(function(w){ return w.length > 4 && t.includes(w); }).length > 3;
      });
      if (!isDupe) { topicData = topics[i]; break; }
    }
    console.log("     → Topic: \"" + topicData.title + "\"");
    console.log("     → Angle: " + (topicData.angle||"general") + " | Theme: " + theme.name);
    // Persist IMMEDIATELY so even if video fails, this topic won't repeat tomorrow
    persistTopicSeed(topicData.title);
    return generateScript(topicData, niche, product_url);
  }).then(function(script) {
    scriptText = script;
    console.log("     → Script: " + script.length + " chars");
    return generateMetadata(topicData, niche);
  }).then(function(metadata) {
    metaData = metadata;
    videoDir = saveVideoPackage(topicData, scriptText, metaData);
    console.log("     ✓ Package saved");
    var thumbPath = path.join(videoDir, "thumbnail.jpg");
    return makeThumbnail(metaData.title || topicData.title, theme, thumbPath).then(function(tp) {
      if (tp) console.log("     ✓ Thumbnail generated");
      return buildVideo(metaData.title || topicData.title, scriptText, path.join(videoDir,"video.mp4"), theme);
    });
  }).then(function(videoResult) {
    if (videoResult.status !== "built") {
      console.log("     → Video status: " + videoResult.status + (videoResult.message ? " | " + videoResult.message : ""));
      return { status: "no_video", title: topicData.title, dir: videoDir };
    }
    if (!config.youtube.refresh_token) return { status: "ready", title: topicData.title, dir: videoDir };
    var thumbPath = path.join(videoDir, "thumbnail.jpg");
    return uploadVideo(path.join(videoDir,"video.mp4"), {
      title:       metaData.title || topicData.title,
      description: metaData.description || "",
      tags:        metaData.tags || [],
      niche:       niche || "",
    }, thumbPath).then(function(uploadResult) {
      if (uploadResult.status === "success") {
        var logFile = path.join(DATA_DIR,"videos.json");
        var log     = JSON.parse(fs.readFileSync(logFile,"utf8"));
        log[log.length-1].status      = "uploaded";
        log[log.length-1].youtube_url = uploadResult.url;
        fs.writeFileSync(logFile, JSON.stringify(log,null,2));
        // Upload clean captions
        try {
          var srtContent = generateSRT(scriptText);
          getAccessToken().then(function(tok){
            uploadCaptions(uploadResult.video_id, srtContent, tok).catch(function(){});
          }).catch(function(){});
        } catch(capErr) { console.log("     → Caption err: " + capErr.message.slice(0,80)); }
      }
      // ── UPLOAD SHORT ──────────────────────────────────────────────────
      var ffmpegPath2 = findFfmpeg();
      // Use the actual final output path from buildVideo result
      var longVidPath = videoResult.path || path.join(videoDir, "video.mp4");
      var shortPath   = path.join(process.cwd(), "tmp", "short_" + Date.now() + ".mp4");
      fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });
      var videoExists = fs.existsSync(longVidPath) && fs.statSync(longVidPath).size > 100000;
      console.log("     → Building Short from: " + longVidPath + " (exists: " + videoExists + ")");
      var shortFile   = (ffmpegPath2 && videoExists) ? buildShort(longVidPath, ffmpegPath2, shortPath) : null;
      if (!shortFile && ffmpegPath2) console.log("     → Short skipped: " + (videoExists ? "ffmpeg failed" : "video not found"));
      var shortUpload = Promise.resolve(null);
      if (shortFile && uploadResult.status === "success") {
        shortUpload = getAccessToken().then(function(tok) {
          return uploadShort(shortFile, metaData.title || topicData.title, metaData.tags || [], tok);
        }).catch(function(e) {
          console.log("     → Short upload err: " + e.message.slice(0,80));
          return null;
        });
      }
      // Persist topic to survive Railway restarts
      persistTopicSeed(topicData.title);
      return shortUpload.then(function(shortResult) {
        return { status: "complete", title: topicData.title, dir: videoDir, upload: uploadResult, short: shortResult, angle: topicData.angle, theme: theme.name };
      });
    });
  });
}

// ── CAPTION GENERATOR ────────────────────────────────────────────────────────

function generateSRT(scriptText) {
  // Clean script same way as voiceover
  var clean = scriptText
    .replace(/##[^\n]*/g, "")
    .replace(/\([0-9]:[^)]*\)/g, "")
    .replace(/\*+([^*]+)\*+/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Split into words
  var words = clean.replace(/\n/g, " ").split(/\s+/).filter(function(w){ return w.length > 0; });
  var WPM = 150; // words per minute
  var secsPerWord = 60 / WPM;
  var WORDS_PER_CAPTION = 7; // max words per caption line

  var srt = "";
  var index = 1;
  var timeOffset = 0;

  for (var i = 0; i < words.length; i += WORDS_PER_CAPTION) {
    var chunk = words.slice(i, i + WORDS_PER_CAPTION);
    var startSecs = timeOffset;
    var endSecs   = timeOffset + (chunk.length * secsPerWord);

    function toSRTTime(s) {
      var h  = Math.floor(s / 3600);
      var m  = Math.floor((s % 3600) / 60);
      var sc = Math.floor(s % 60);
      var ms = Math.floor((s % 1) * 1000);
      return String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + ":" + String(sc).padStart(2,"0") + "," + String(ms).padStart(3,"0");
    }

    // Capitalize emphasis words in captions
    var emphasisWords = ["stop","never","secret","warning","truth","hack","mistake","mistakes","free","exposed","finally","now","important","critical","key"];
    var captionLine = chunk.map(function(w){
      var clean2 = w.replace(/[^a-zA-Z]/g,"").toLowerCase();
      return emphasisWords.includes(clean2) ? w.toUpperCase() : w;
    }).join(" ");

    srt += index + "\n";
    srt += toSRTTime(startSecs) + " --> " + toSRTTime(endSecs) + "\n";
    srt += captionLine + "\n\n";

    index++;
    timeOffset = endSecs;
  }

  return srt;
}

function uploadCaptions(videoId, srtContent, accessToken) {
  if (!videoId || !srtContent || !accessToken) return Promise.resolve(null);
  var body = Buffer.from(srtContent, "utf8");
  return new Promise(function(resolve) {
    var req = https.request({
      hostname: "www.googleapis.com",
      path: "/upload/youtube/v3/captions?uploadType=resumable&part=snippet&sync=true",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + accessToken,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "text/plain",
        "X-Upload-Content-Length": body.length,
        "Content-Length": Buffer.byteLength(JSON.stringify({
          snippet: { videoId: videoId, language: "en", name: "English", isDraft: false }
        }))
      }
    }, function(res) {
      var uploadUrl = res.headers.location;
      if (!uploadUrl) {
        var e = ""; res.on("data", function(d){ e+=d; });
        res.on("end", function(){ console.log("     → Caption init HTTP " + res.statusCode + " | " + e.slice(0,100)); resolve(null); });
        return;
      }
      var upReq = https.request(uploadUrl, { method: "PUT", headers: { "Content-Type": "text/plain", "Content-Length": body.length } }, function(upRes) {
        var d = ""; upRes.on("data", function(c){ d+=c; });
        upRes.on("end", function(){
          if (upRes.statusCode === 200 || upRes.statusCode === 201) {
            console.log("     ✓ Captions uploaded");
            resolve(true);
          } else {
            console.log("     → Caption upload HTTP " + upRes.statusCode + " | " + d.slice(0,100));
            resolve(null);
          }
        });
      });
      upReq.on("error", function(){ resolve(null); });
      upReq.write(body);
      upReq.end();
    });
    req.on("error", function(){ resolve(null); });
    req.write(JSON.stringify({ snippet: { videoId: videoId, language: "en", name: "English", isDraft: false } }));
    req.end();
  });
}

module.exports = { run, researchTopics, generateScript, uploadVideo, getGrowthStatus };
