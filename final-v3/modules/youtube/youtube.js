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
  var logFile = path.join(DATA_DIR, "videos.json");
  // Also check a persistent seed file that survives Railway restarts
  var seedFile = path.join(process.cwd(), "data", "topic-seed.json");
  var used = [];
  if (fs.existsSync(logFile)) {
    try { used = JSON.parse(fs.readFileSync(logFile, "utf8")).map(function(v) { return (v.title || "").toLowerCase(); }); } catch(e) {}
  }
  if (fs.existsSync(seedFile)) {
    try {
      var seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
      used = used.concat(seed.used_titles || []);
    } catch(e) {}
  }
  return used;
}

function persistTopicSeed(title) {
  var seedFile = path.join(process.cwd(), "data", "topic-seed.json");
  var data = { used_titles: [] };
  if (fs.existsSync(seedFile)) {
    try { data = JSON.parse(fs.readFileSync(seedFile, "utf8")); } catch(e) {}
  }
  if (!data.used_titles) data.used_titles = [];
  var lower = title.toLowerCase();
  if (!data.used_titles.includes(lower)) {
    data.used_titles.push(lower);
    // Keep last 100 to avoid file bloat
    if (data.used_titles.length > 100) data.used_titles = data.used_titles.slice(-100);
    fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
    fs.writeFileSync(seedFile, JSON.stringify(data, null, 2));
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
  var POWER = ["STOP","NEVER","SECRET","WARNING","TRUTH","HACK","MISTAKE","MISTAKES","FREE","EXPOSED","FINALLY","QUIT","BROKE","RICH","FIRED","DONE","REAL","FAKE","LIES","DEAD"];
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
        '<filter id="shadow"><feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000" flood-opacity="0.9"/></filter>' +
        '<linearGradient id="grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#000" stop-opacity="0.3"/><stop offset="60%" stop-color="#000" stop-opacity="0.65"/><stop offset="100%" stop-color="#000" stop-opacity="0.85"/></linearGradient>' +
      '</defs>' +
      '<rect width="' + W + '" height="' + H + '" fill="url(#grad)"/>' +
      '<rect width="' + W + '" height="6" fill="#' + theme.accent + '"/>' +
      '<rect y="' + (H-6) + '" width="' + W + '" height="6" fill="#' + theme.accent + '"/>' +
      // Accent line
      '<rect x="200" y="' + (startY - 30) + '" width="880" height="4" fill="#' + theme.accent + '" opacity="0.7" rx="2"/>' +
      els +
      // Sub text
      '<rect x="160" y="' + (H-110) + '" width="960" height="60" fill="#000" opacity="0.5" rx="6"/>' +
      '<text x="640" y="' + (H-70) + '" font-family="' + fontFamily + '" font-size="26" fill="#' + theme.sub + '" text-anchor="middle">' + safeXml(slide.sub || "Watch this before your competition does", 70) + '</text>' +
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
    // Section slide — the most common type
    var headLines = wrapWords(slide.headline, 38);
    var headEls   = headLines.slice(0,2).map(function(l,i){
      return '<text x="640" y="' + (195+i*72) + '" font-family="' + fontFamily + '" font-size="54" font-weight="bold" fill="white" text-anchor="middle" filter="url(#shadow)">' + safeXml(l,50) + '</text>';
    }).join("");
    var body = slide.body||[];
    var bodyEls = "", yPos = headLines.length > 1 ? 340 : 300;
    for (var bi = 0; bi < Math.min(body.length, 4); bi++) {
      var wrapped = wrapWords(body[bi], 52);
      for (var wi = 0; wi < Math.min(wrapped.length, 2); wi++) {
        bodyEls += '<text x="110" y="' + yPos + '" font-family="' + fontFamily + '" font-size="30" fill="#eeeeee" filter="url(#shadow)">' + safeXml(wrapped[wi], 62) + '</text>';
        yPos += 44;
      }
      yPos += 14;
    }
    // Bullet dots
    var bulletSvg = "", bY = headLines.length > 1 ? 318 : 278;
    for (var bj = 0; bj < Math.min(body.length, 4); bj++) {
      bulletSvg += '<circle cx="80" cy="' + bY + '" r="8" fill="#' + theme.accent + '"/>';
      bY += 58;
    }
    // Progress bar at bottom (slide number feel)
    svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<filter id="shadow"><feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="#000" flood-opacity="0.95"/></filter>' +
        '<linearGradient id="grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#000" stop-opacity="0.25"/><stop offset="45%" stop-color="#000" stop-opacity="0.6"/><stop offset="100%" stop-color="#000" stop-opacity="0.88"/></linearGradient>' +
        '<linearGradient id="hgrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#' + theme.accent + '" stop-opacity="0.25"/><stop offset="100%" stop-color="#' + theme.accent + '" stop-opacity="0"/></linearGradient>' +
      '</defs>' +
      '<rect width="' + W + '" height="' + H + '" fill="url(#grad)"/>' +
      // Header band
      '<rect width="' + W + '" height="240" fill="url(#hgrad)"/>' +
      '<rect width="' + W + '" height="6" fill="#' + theme.accent + '"/>' +
      // Headline bg pill
      '<rect x="40" y="130" width="' + (W-80) + '" height="' + (headLines.length > 1 ? 145 : 80) + '" fill="#000" opacity="0.45" rx="8"/>' +
      '<rect x="40" y="130" width="6" height="' + (headLines.length > 1 ? 145 : 80) + '" fill="#' + theme.accent + '" rx="3"/>' +
      headEls +
      bulletSvg + bodyEls +
      // Bottom bar
      '<rect y="' + (H-50) + '" width="' + W + '" height="50" fill="#000" opacity="0.6"/>' +
      '<text x="640" y="' + (H-18) + '" font-family="' + fontFamily + '" font-size="18" fill="#' + theme.sub + '" text-anchor="middle" opacity="0.8">Subscribe for daily tips</text>' +
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

  for (var i = 0; i < lines.length && slides.length < 27; i++) {
    var raw = lines[i], clean = raw.replace(/^#+\s*/,"").replace(/\*\*/g,"").trim();
    var isHeader = raw.startsWith("#") || /^(step|tip|point|section|intro|conclusion|outro|hook|number|\d+[\.\)])/i.test(clean);
    if (isHeader && slides.length > 0) { flush(); currentSection = clean.slice(0,65); }
    else currentBody.push(clean);
  }
  flush();

  var fillers = [
    { headline: "Key Takeaway",   body: ["The top 1% know this — now you do too", "Apply this before your competition does"] },
    { headline: "Pro Tip",        body: ["This one change saved me 5 hours a week", "Most people skip this — do not be most people"] },
    { headline: "Common Mistake", body: ["97% of beginners get this wrong", "Here is exactly what to do instead"] },
    { headline: "Quick Win",      body: ["You can implement this in under 10 minutes", "The results will show up within a week"] },
    { headline: "Reality Check",  body: ["Here is what nobody tells you upfront", "The honest truth about what actually works"] },
  ];
  var fi = 0;
  while (slides.length < 28) { slides.push({ type: "section", headline: fillers[fi % fillers.length].headline, body: fillers[fi % fillers.length].body }); fi++; }
  slides.push({ type: "cta", headline: "Like and Subscribe!", body: ["New videos every single day", "Hit the bell so you never miss one"], cta: "Subscribe Now — It is Free!" });
  return slides;
}

// ── MUSIC ─────────────────────────────────────────────────────────────────────

function generateMusic(ffmpegPath, durationSecs, outputPath) {
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) return outputPath;
  try {
    require("child_process").execSync(
      "\"" + ffmpegPath + "\" -y -f lavfi -i \"sine=frequency=220:duration=" + (durationSecs+5) + "\" -filter_complex \"volume=0.05\" -c:a aac \"" + outputPath + "\"",
      { stdio: "pipe", timeout: 30000 }
    );
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) { console.log("     ✓ Background music generated"); return outputPath; }
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
  var body = JSON.stringify({ text: text, model_id: "eleven_turbo_v2_5", voice_settings: { stability: 0.5, similarity_boost: 0.75 } });
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
  var voiceId = (config.elevenlabs && config.elevenlabs.voice_id) || "21m00Tcm4TlvDq8ikWAM";
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

  var imgTasks = slides.map(function(slide, i) {
    if (!pexelsKey) return Promise.resolve(null);
    var query = (slide.headline || title).replace(/[^a-zA-Z0-9 ]/g, " ").slice(0, 40);
    var imgPath = path.join(imgDir, "bg" + i + ".jpg");
    return fetchPexelsImage(query, imgPath).catch(function(){ return null; });
  });

  var pngTasks = Promise.all(imgTasks).then(function(bgImages) {
    return Promise.all(slides.map(function(slide, i) {
      var pngPath = path.join(tmpDir, "slide" + String(i).padStart(3,"0") + ".png");
      return makeSlidePng(slide, theme, pngPath, bgImages[i])
        .then(function() { return pngPath; })
        .catch(function(e) { console.log("     → Slide " + i + " err: " + e.message.slice(0,50)); return null; });
    }));
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
function buildDescription(desc) {
  var storeUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN + "/store"
    : null;
  var storeBlock = storeUrl
    ? "\n\n🛒 GET THE TOOLKIT: " + storeUrl + "\n(Digital guides & toolkits — instant download)"
    : "";
  var affiliateBlock = "\n\n---\n🎙️ The AI voice in this video is powered by ElevenLabs.\nI use it every single day to run my content business.\nTry it free → https://try.elevenlabs.io/2pu1o9y92jl1";
  return desc + storeBlock + affiliateBlock + "\n\n---\nNew video every day. Subscribe & hit the bell 🔔";
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
    if (cleanTags.length === 0) cleanTags = ["AI tools","small business","productivity"];

    var initBody = JSON.stringify({
      snippet: { title: (scriptData.title||"AI Tools Video").slice(0,100), description: buildDescription(scriptData.description||"Subscribe for daily videos!"), tags: cleanTags, categoryId: "27" },
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
  "personal finance tips",
  "passive income strategies",
  "AI productivity tools",
  "small business automation",
  "side hustle ideas",
  "investing for beginners",
  "credit score improvement",
  "digital product business",
  "freelancing and consulting",
  "online business systems",
];

function getRotatingNiche(baseNiche, usedCount) {
  // Every 3 videos, rotate to a related angle for variety
  if (usedCount > 0 && usedCount % 3 === 0) {
    var idx = Math.floor(usedCount / 3) % NICHE_ANGLES.length;
    return NICHE_ANGLES[idx];
  }
  return baseNiche;
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
      "You are a top YouTube strategist for a small business / finance / AI tools channel with a proven audience.\n\n" +
      "Generate 8 HIGH-PERFORMING video topics for niche: \"" + activeNiche + "\"\n\n" +
      (brainContext ? brainContext + "\n" : "") +
      "ALREADY USED — DO NOT repeat or closely resemble these:\n" + avoidList + "\n\n" +
      "PROVEN WINNING FORMULAS — ranked by REAL channel data:\n" +
      "🥇 BEST (16.7% CTR proven): [Number] SECRET [Topic] [Authority] EXPOSED\n" +
      "🥇 BEST (16.7% CTR proven): [Number] [Topic] Secrets [Villain] Hopes You Never Find Out\n" +
      "🥈 STRONG: WARNING: [Number] [Tool/Strategy] [Negative Consequence] (EXPOSED)\n" +
      "🥈 STRONG: EXPOSED: The Hidden [Cost/Truth/Secret] Behind [Popular Thing]\n" +
      "🥉 GOOD: [Number] [Niche] MISTAKES That Cost Small Business Owners $[Amount]\n" +
      "🥉 GOOD: IRS [Action] These [Number] [Topic] — Don\'t Get [Consequence]\n" +
      "4. Stop [Common Advice] — Here\'s What Actually Works in [Year]\n" +
      "5. How I [Achieved Result] Without [Common Barrier]\n\n" +
      "CRITICAL RULES based on real performance data:\n" +
      "- At least 4 of your 8 topics MUST use EXPOSED or SECRET — these get 3x more clicks\n" +
      "- IRS and tax topics get the highest watch time — include at least 1 per batch\n" +
      "- Use CAPS on power words: EXPOSED, SECRET, WARNING, NEVER, STOP\n" +
      "- Include specific dollar amounts — $847, $4,200, $1,000s — vague titles get ignored\n" +
      "- Write for small business owners aged 25-50 who are worried about money and audits\n" +
      "- Titles 55-75 chars — punchy, front-load the power word\n" +
      "- Hooks must make them feel like they\'re about to miss something critical\n\n" +
      "Return ONLY a JSON array:\n" +
      "[{\"title\":\"WARNING: 5 AI Tools Quietly Draining Your Business Budget\",\"hook\":\"I found $847/month in hidden charges across tools my clients were already paying for\",\"angle\":\"warning\",\"niche\":\"" + activeNiche + "\"}]"
    }],
  }).then(function(res) {
    var text = res.content[0].text.trim().replace(/```json/g,"").replace(/```/g,"").trim();
    var start = text.indexOf("["), end = text.lastIndexOf("]");
    if (start === -1) throw new Error("no array");
    return JSON.parse(text.slice(start, end+1));
  }).catch(function() {
    var day = new Date().getDate() + (usedTopics||[]).length;
    var fallbacks = [
      { title: "I Tried Every AI Tool for 30 Days — Honest Results", hook: "Most tools are overhyped. Here are the 5 that actually changed my business", angle: "case-study" },
      { title: "The Credit Score Mistake That Cost Me 2 Years", hook: "One decision set my credit back 24 months — here is what not to do", angle: "story" },
      { title: "7 Passive Income Streams Ranked From Easiest to Hardest", hook: "I have tried all 7. Only 3 actually scale without burning you out", angle: "list" },
      { title: "Nobody Talks About This AI Productivity Strategy", hook: "Top 1% of entrepreneurs use this daily. Everyone else is still doing it manually", angle: "secrets" },
      { title: "Stop Taking This Money Advice — Do This Instead", hook: "The most popular personal finance tip is actually holding most people back", angle: "truth-bomb" },
      { title: "How I Built a $29 Digital Product in One Afternoon", hook: "No audience, no ads, no experience — just a simple system anyone can copy", angle: "how-to" },
      { title: "5 Signs Your Business Will Fail in 12 Months", hook: "I have seen hundreds of businesses. These warning signs show up every time", angle: "warning" },
      { title: "The Beginner Investing Mistakes I Made So You Don\'t Have To", hook: "I lost $4,000 in my first year investing. Here is exactly what went wrong", angle: "mistakes" },
      { title: "3 AI Automations That Run My Business While I Sleep", hook: "Set these up once and they work 24 hours a day — no monthly fees", angle: "tools" },
      { title: "What 1 Year of Daily YouTube Did to My Income", hook: "The honest numbers — what worked, what failed, and what I would do differently", angle: "case-study" },
    ];
    return [fallbacks[day % fallbacks.length]];
  });
}

function generateScript(topic, niche, product_url) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 4096,
    system: "You are a top-tier YouTube scriptwriter for a small business / AI tools / finance channel. Your scripts have driven millions of views because:\n" +
      "1. Your FIRST SENTENCE is always a bold, counterintuitive, or alarming statement — never a greeting\n" +
      "2. You write like a trusted friend who just discovered something shocking, not a lecturer\n" +
      "3. Every 90 seconds you plant a curiosity gap — tease what is coming so they cannot stop watching\n" +
      "4. You use SPECIFIC details — real dollar amounts, real timeframes, real tool names\n" +
      "5. Your pacing is conversational — short punchy sentences mixed with longer explanations\n" +
      "6. You never say Hey guys, Welcome back, Do not forget to like, or any filler phrases\n" +
      "NEVER use bullet points in spoken narration. NEVER sound like an AI wrote this.",
    messages: [{ role: "user", content:
      "Write a complete 10-12 minute YouTube script for: \"" + topic.title + "\"\n" +
      "Niche: " + niche + "\n" +
      "Angle: " + (topic.angle || "educational") + "\n" +
      "Opening hook line: \"" + (topic.hook || "What I am about to show you changes everything") + "\"\n" +
      (product_url ? "Mention this resource ONCE naturally around the 7-minute mark: " + product_url + "\n" : "") +
      "\nCRITICAL SCRIPT REQUIREMENTS:\n" +
      "- 1500-1800 words of pure SPOKEN narration\n" +
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
      (product_url ? "Natural resource mention here.\n" : "") + "\n" +
      "## POINT 4 + 5 (7:30-9:30)\n" +
      "Momentum section — faster pace, quick wins, build to the conclusion.\n\n" +
      "## CLOSE (9:30-10:30)\n" +
      "Callback to the hook, key takeaway in one sentence, subscribe CTA that feels earned not begged.\n\n" +
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
      "- Front-load the most important keyword\n" +
      "- Keep the emotional hook from the original title\n" +
      "- Never truncate mid-word\n\n" +
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
      meta.tags = [niche, "AI tools", "small business", "productivity", "2025", "2026", "tutorial", "how to", topic.angle||"tips", "make money online"];
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

    // Step 1 — Use fixed 58 seconds (ffprobe not available in static build)
    var shortDuration = 58;
    var cmd = "\"" + ffmpegPath + "\" -y" +
      " -ss 0" +
      " -t " + shortDuration +
      " -i \"" + longVideoPath + "\"" +
      " -vf \"crop=405:720:437:0,scale=1080:1920:flags=lanczos\"" +
      " -c:v libx264 -preset fast -crf 23" +
      " -c:a aac -b:a 128k" +
      " -movflags +faststart" +
      " \"" + outputPath + "\"";

    console.log("     → Building Short (first " + Math.round(shortDuration) + "s vertical crop)...");
    exec(cmd, { timeout: 120000 });

    if (require("fs").existsSync(outputPath) && require("fs").statSync(outputPath).size > 50000) {
      console.log("     ✓ Short built: " + Math.round(require("fs").statSync(outputPath).size / 1024) + "KB");
      return outputPath;
    } else {
      console.log("     → Short build failed — output too small");
      return null;
    }
  } catch(e) {
    console.log("     → Short build error: " + e.message.slice(0, 120));
    return null;
  }
}

function uploadShort(shortVideoPath, longTitle, tags, accessToken) {
  if (!shortVideoPath || !fs.existsSync(shortVideoPath)) return Promise.resolve(null);
  var shortTitle = ("#Shorts " + longTitle).slice(0, 100);
  var shortDesc  = buildDescription("Watch the full video on our channel for the complete breakdown.") + "\n\n#Shorts #" + (tags[0]||"tips").replace(/[^a-zA-Z0-9]/g,"");


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
