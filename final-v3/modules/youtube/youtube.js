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
  if (!fs.existsSync(logFile)) return [];
  try { return JSON.parse(fs.readFileSync(logFile, "utf8")).map(function(v) { return (v.title || "").toLowerCase(); }); }
  catch(e) { return []; }
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
  var words = title.replace(/[^a-zA-Z0-9 ]/g,"").split(" ");
  var line1 = words.slice(0,3).join(" ").toUpperCase();
  var line2 = words.slice(3,6).join(" ").toUpperCase();
  var badge = title.match(/\d+/);
  var badgeNum = badge ? badge[0] : null;

  var svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="' + W + '" height="' + H + '" fill="#' + theme.bg + '"/>' +
    '<rect width="' + W + '" height="' + H + '" fill="#' + theme.accent + '" opacity="0.06"/>' +
    '<rect width="18" height="' + H + '" fill="#' + theme.accent + '"/>' +
    '<rect y="' + (H-120) + '" width="' + W + '" height="120" fill="#000000" opacity="0.72"/>' +
    (badgeNum ? '<circle cx="' + (W-110) + '" cy="110" r="90" fill="#' + theme.accent + '" opacity="0.95"/><text x="' + (W-110) + '" y="132" font-family="Arial,sans-serif" font-size="80" font-weight="bold" fill="white" text-anchor="middle">' + safeXml(badgeNum,3) + '</text>' : '') +
    '<text x="50" y="310" font-family="Arial,Helvetica,sans-serif" font-size="' + (line1.length > 10 ? "90" : "115") + '" font-weight="bold" fill="white" letter-spacing="1">' + safeXml(line1,14) + '</text>' +
    (line2 ? '<text x="50" y="' + (line2.length > 10 ? "418" : "438") + '" font-family="Arial,Helvetica,sans-serif" font-size="' + (line2.length > 10 ? "82" : "105") + '" font-weight="bold" fill="#' + theme.accent + '" letter-spacing="1">' + safeXml(line2,14) + '</text>' : '') +
    '<text x="50" y="' + (H-45) + '" font-family="Arial,Helvetica,sans-serif" font-size="26" fill="#cccccc">' + safeXml(title,72) + '</text>' +
    '<circle cx="' + (W-28) + '" cy="' + (H-28) + '" r="8" fill="#' + theme.accent + '" opacity="0.6"/>' +
    '<circle cx="' + (W-52) + '" cy="' + (H-28) + '" r="5" fill="#' + theme.accent + '" opacity="0.35"/>' +
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

    // Send FULL script to ElevenLabs — chunked automatically for paid plans
    // At ~15 chars/sec speech rate, 7000 chars = ~7.5 min, matching the ~10 min video
    console.log("     → Voiceover: " + scriptText.length + " chars (~" + Math.round(scriptText.length/15) + "s speech)");
    return generateVoiceover(scriptText, voicePath).then(function(voiceFile) {
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
  return desc + storeBlock + "\n\n---\nNew video every day. Subscribe & hit the bell 🔔";
}

function uploadVideo(videoFilePath, scriptData, thumbnailPath) {
  if (!config.youtube.refresh_token) return Promise.resolve({ status: "no_credentials" });
  if (!fs.existsSync(videoFilePath)) return Promise.resolve({ status: "no_video_file" });
  return getAccessToken().then(function(accessToken) {
    var initBody = JSON.stringify({
      snippet: { title: (scriptData.title||"AI Tools Video").slice(0,100), description: buildDescription(scriptData.description||"Subscribe for daily videos!"), tags: scriptData.tags||["AI","tools","tutorial"], categoryId: "27" },
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

function researchTopics(niche, usedTopics) {
  var avoidList = (usedTopics||[]).slice(-20).join(", ") || "none yet";
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 1200,
    messages: [{ role: "user", content:
      "Generate 5 UNIQUE YouTube video topics for a faceless channel in the \"" + niche + "\" niche.\n\n" +
      "ALREADY USED — do NOT repeat or closely resemble these:\n" + avoidList + "\n\n" +
      "Requirements:\n" +
      "- Use power words: Secret, Warning, Mistake, Exposed, Finally, Hack, Truth, Stop, Never\n" +
      "- Include specific numbers: 5 Ways, 7 Mistakes, 3 Secrets\n" +
      "- Each topic must have a DIFFERENT angle: mistakes, tools, case study, warning, how-to, truth\n" +
      "- Titles must create strong curiosity to make people click\n\n" +
      "Return ONLY a JSON array, no markdown:\n" +
      "[{\"title\":\"7 AI Tool Mistakes Killing Your Productivity (Fix These Now)\",\"hook\":\"Most small business owners waste 3 hours daily on tasks AI does in seconds\",\"angle\":\"mistakes\"}]"
    }],
  }).then(function(res) {
    var text = res.content[0].text.trim().replace(/```json/g,"").replace(/```/g,"").trim();
    var start = text.indexOf("["), end = text.lastIndexOf("]");
    if (start === -1) throw new Error("no array");
    return JSON.parse(text.slice(start, end+1));
  }).catch(function() {
    var day = new Date().getDate() + (usedTopics||[]).length;
    var fallbacks = [
      { title: "7 AI Tools That Replace Expensive Employees in 2025", hook: "Why pay $50k when AI does it for $20 a month", angle: "tools" },
      { title: "The 3 Biggest Mistakes New Entrepreneurs Make With AI", hook: "I made all 3 and it cost me 6 months", angle: "mistakes" },
      { title: "5 Ways AI Is Quietly Replacing Small Business Owners", hook: "This is happening right now — adapt or fall behind", angle: "warning" },
      { title: "How I Automated My Entire Business in 30 Days With AI", hook: "This system runs my business while I sleep", angle: "case-study" },
      { title: "The Truth About AI Business Tools Nobody Tells You", hook: "After testing 47 tools here is what actually works", angle: "truth" },
      { title: "Stop Wasting Money on These 5 Business Tools (Use AI Instead)", hook: "I canceled $800 in subscriptions using free AI", angle: "savings" },
      { title: "3 Secrets Top Entrepreneurs Use to Work 4 Hours a Day", hook: "This is not passive income hype — it actually works", angle: "secrets" },
    ];
    return [fallbacks[day % fallbacks.length]];
  });
}

function generateScript(topic, niche, product_url) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 4000,
    system: "You are an expert YouTube scriptwriter. Your scripts get 70%+ retention because of powerful hooks, curiosity gaps, and clear value delivery. ALWAYS write full spoken narration — never use bullet points in the script body.",
    messages: [{ role: "user", content:
      "Write a FULL 10-minute YouTube narration script for: \"" + topic.title + "\"\n" +
      "Niche: " + niche + "\n" +
      "Opening hook: \"" + (topic.hook || "What I am about to show you changes everything") + "\"\n" +
      "Product to mention once naturally mid-video: " + (product_url || "none") + "\n\n" +
      "CRITICAL REQUIREMENTS:\n" +
      "- Target: 1400-1600 words of SPOKEN narration (10 min at 150 words/min)\n" +
      "- Write every word as it will be SPOKEN aloud — no bullet points, no headers visible to viewer\n" +
      "- Use ## only as section markers for the editor\n" +
      "- Each section must have 2-4 full paragraphs of spoken content\n" +
      "- Be conversational, specific, and story-driven\n\n" +
      "STRUCTURE — use ## for each section header:\n" +
      "## HOOK (0:00-0:45) — 2 paragraphs, pattern interrupt opening\n" +
      "## INTRO (0:45-2:00) — 2 paragraphs, set up the problem\n" +
      "## 1. [First Point] (2:00-3:30) — 3 paragraphs with example\n" +
      "## 2. [Second Point] (3:30-5:00) — 3 paragraphs with example\n" +
      "## 3. [Third Point] (5:00-6:30) — 3 paragraphs with example\n" +
      "## 4. [Fourth Point] (6:30-7:30) — 2 paragraphs\n" +
      "## 5. [Fifth Point] (7:30-8:30) — 2 paragraphs\n" +
      "## KEY TAKEAWAY (8:30-9:30) — 2 paragraphs summarizing\n" +
      "## CTA (9:30-10:00) — subscribe + product mention if applicable\n\n" +
      "Write the complete script now. Do not summarize or cut short."
    }],
  }).then(function(res){ return res.content[0].text; });
}

function generateMetadata(topic, niche) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 800,
    messages: [{ role: "user", content:
      "YouTube SEO for: \"" + topic.title + "\" (niche: " + niche + ")\nReturn ONLY JSON:\n" +
      "{\"title\":\"max 90 chars with power words\",\"description\":\"200+ words: hook first, then what video covers, timestamps, subscribe CTA\",\"tags\":[\"15 specific tags\"],\"category\":\"27\"}"
    }],
  }).then(function(res) {
    var text = res.content[0].text.trim().replace(/```json/g,"").replace(/```/g,"").trim();
    var start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start === -1) throw new Error("no json");
    return JSON.parse(text.slice(start, end+1));
  }).catch(function(){
    return { title: topic.title, description: "New video every day on " + niche + ".\n\n" + (topic.hook||"") + "\n\nSubscribe and hit the bell!", tags: [niche,"AI tools","small business","productivity","2025","tutorial","tips"], category: "27" };
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
  // Clip first 55s + crop to 9:16 vertical (1080x1920) from center of 1280x720
  // YouTube auto-detects Shorts from aspect ratio + duration under 60s
  try {
    require("child_process").execSync(
      "\"" + ffmpegPath + "\" -y " +
      "-i \"" + longVideoPath + "\" " +
      "-t 55 " +
      "-vf \"scale=1080:608,pad=1080:1920:0:656:black\" " +
      "-c:v libx264 -pix_fmt yuv420p -preset ultrafast -crf 28 " +
      "-c:a aac -b:a 96k " +
      "\"" + outputPath + "\"",
      { stdio: "pipe", timeout: 180000 }
    );
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
      var sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
      console.log("     ✓ Short created: " + sizeMb + "MB (55s vertical)");
      return outputPath;
    }
  } catch(e) {
    console.log("     → Short build err: " + e.message.slice(0, 300));
  }
  return null;
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
      }
      // ── UPLOAD SHORT ──────────────────────────────────────────────────
      var ffmpegPath2 = findFfmpeg();
      // Use the actual final output path from buildVideo result
      var longVidPath = videoResult.path || path.join(videoDir, "video.mp4");
      var shortPath   = path.join(videoDir, "short.mp4");
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
      return shortUpload.then(function(shortResult) {
        return { status: "complete", title: topicData.title, dir: videoDir, upload: uploadResult, short: shortResult };
      });
    });
  });
}

module.exports = { run, researchTopics, generateScript, uploadVideo, getGrowthStatus };
