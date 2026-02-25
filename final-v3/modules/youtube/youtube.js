require("dotenv").config();
const https    = require("https");
const http     = require("http");
const fs       = require("fs");
const path     = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const config   = require("../../config");
const { auditLog } = require("../../security/vault");

const client   = new Anthropic({ apiKey: config.anthropic.api_key });
const OUT_DIR  = path.join(process.cwd(), "output", "youtube");
const DATA_DIR = path.join(process.cwd(), "data", "youtube");

// ── FONT SETUP ────────────────────────────────────────────────────────────────
// Sets up fontconfig so sharp/librsvg can render text on Railway
// Must run before any sharp calls

function setupFonts() {
  // Find our bundled font
  var fontCandidates = [
    path.join(process.cwd(), "assets", "DejaVuSans-Bold.ttf"),
    path.join(process.cwd(), "assets", "font.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
  ];

  var fontFile = null;
  for (var i = 0; i < fontCandidates.length; i++) {
    if (fs.existsSync(fontCandidates[i])) { fontFile = fontCandidates[i]; break; }
  }
  if (!fontFile) { console.log("     → No font file found"); return null; }

  var fontDir      = path.dirname(fontFile);
  var cacheDir     = path.join(process.cwd(), "tmp", "fontcache");
  var confFile     = path.join(process.cwd(), "tmp", "fonts.conf");

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });

  fs.writeFileSync(confFile,
    '<?xml version="1.0"?>\n' +
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n' +
    '<fontconfig>\n' +
    '  <dir>' + fontDir + '</dir>\n' +
    '  <cachedir>' + cacheDir + '</cachedir>\n' +
    '</fontconfig>\n'
  );

  // Set env vars before sharp loads librsvg
  process.env.FONTCONFIG_FILE = confFile;
  process.env.FONTCONFIG_PATH = path.dirname(confFile);
  process.env.FC_CONFIG_DIR   = path.dirname(confFile);

  console.log("     → Font: " + path.basename(fontFile));
  return fontFile;
}

// Run font setup immediately
var FONT_FILE = setupFonts();

// ── FIND FFMPEG ───────────────────────────────────────────────────────────────

function findFfmpeg() {
  try {
    var p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) { console.log("     → ffmpeg: ffmpeg-static"); return p; }
  } catch(e) {}
  try {
    var w = require("child_process").execSync("which ffmpeg", { encoding: "utf8" }).trim();
    if (w) { console.log("     → ffmpeg: system"); return w; }
  } catch(e) {}
  return null;
}

// ── SAFE XML FOR SVG ──────────────────────────────────────────────────────────

function safeXml(s, maxLen) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .slice(0, maxLen || 80);
}

// ── WORD WRAP ─────────────────────────────────────────────────────────────────

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

// ── BG COLOR MAP ──────────────────────────────────────────────────────────────

var BG_COLORS = {
  "0d1b2a": { r:13,  g:27,  b:42  },
  "0a1a2e": { r:10,  g:26,  b:46  },
  "12082a": { r:18,  g:8,   b:42  },
  "0a2018": { r:10,  g:32,  b:24  },
  "1a1208": { r:26,  g:18,  b:8   },
  "081a1a": { r:8,   g:26,  b:26  },
  "1a0818": { r:26,  g:8,   b:24  },
};

// ── BUILD SLIDE PNG ───────────────────────────────────────────────────────────

function makeSlidePng(slide, bgHex, outputPath) {
  var sharp;
  try { sharp = require("sharp"); } catch(e) { return Promise.reject(new Error("sharp not available")); }

  var W  = 1280;
  var H  = 720;
  var bg = BG_COLORS[bgHex] || { r:13, g:27, b:42 };

  // Font family - use DejaVu if we found it, otherwise generic sans-serif
  var fontFamily = FONT_FILE
    ? path.basename(FONT_FILE, ".ttf").replace(/[^a-zA-Z0-9 ]/g, " ") + ",sans-serif"
    : "Arial,Helvetica,sans-serif";

  var svg;

  if (slide.type === "title") {
    var lines  = wrapWords(slide.headline, 30);
    var startY = Math.max(200, 320 - lines.length * 40);
    var els    = lines.slice(0, 3).map(function(l, i) {
      return '<text x="640" y="' + (startY + i * 74) + '" ' +
        'font-family="' + fontFamily + '" font-size="54" font-weight="bold" ' +
        'fill="white" text-anchor="middle">' + safeXml(l, 38) + '</text>';
    }).join("");

    svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="' + W + '" height="' + H + '" fill="#' + bgHex + '"/>' +
      '<rect width="' + W + '" height="10" fill="#4488ff"/>' +
      '<rect y="' + (H - 10) + '" width="' + W + '" height="10" fill="#4488ff" opacity="0.5"/>' +
      els +
      '<text x="640" y="580" font-family="' + fontFamily + '" font-size="26" fill="#88aaff" text-anchor="middle">' +
        safeXml(slide.sub || "Watch to the end for the full breakdown", 65) +
      '</text>' +
      '</svg>';

  } else if (slide.type === "cta") {
    var ctaEls = (slide.body || []).slice(0, 2).map(function(l, i) {
      return '<text x="640" y="' + (385 + i * 56) + '" ' +
        'font-family="' + fontFamily + '" font-size="28" fill="white" text-anchor="middle">' +
        safeXml(l, 65) + '</text>';
    }).join("");

    svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="' + W + '" height="' + H + '" fill="#' + bgHex + '"/>' +
      '<rect width="' + W + '" height="10" fill="#ff8844"/>' +
      '<rect y="' + (H - 90) + '" width="' + W + '" height="90" fill="#000000" opacity="0.65"/>' +
      '<text x="640" y="275" font-family="' + fontFamily + '" font-size="50" font-weight="bold" fill="#ffaa44" text-anchor="middle">' +
        safeXml(slide.headline, 44) +
      '</text>' +
      ctaEls +
      '<text x="640" y="' + (H - 38) + '" font-family="' + fontFamily + '" font-size="28" fill="#ffaa44" text-anchor="middle">' +
        safeXml(slide.cta || "Hit Subscribe now", 55) +
      '</text>' +
      '</svg>';

  } else {
    var headLines = wrapWords(slide.headline, 44);
    var headEls   = headLines.slice(0, 2).map(function(l, i) {
      return '<text x="640" y="' + (215 + i * 56) + '" ' +
        'font-family="' + fontFamily + '" font-size="44" font-weight="bold" ' +
        'fill="white" text-anchor="middle">' + safeXml(l, 52) + '</text>';
    }).join("");

    var body    = slide.body || [];
    var bodyEls = "";
    var yPos    = 315;
    for (var bi = 0; bi < Math.min(body.length, 4); bi++) {
      var wrapped = wrapWords(body[bi], 62);
      for (var wi = 0; wi < Math.min(wrapped.length, 2); wi++) {
        bodyEls += '<text x="100" y="' + yPos + '" ' +
          'font-family="' + fontFamily + '" font-size="28" fill="#ccddff">' +
          safeXml(wrapped[wi], 68) + '</text>';
        yPos += 36;
      }
      yPos += 20;
    }

    svg = '<svg width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="' + W + '" height="' + H + '" fill="#' + bgHex + '"/>' +
      '<rect width="' + W + '" height="10" fill="#4488ff"/>' +
      '<rect x="60" y="148" width="' + (W - 120) + '" height="' + (headLines.length > 1 ? 122 : 74) + '" fill="#000000" opacity="0.4" rx="6"/>' +
      '<rect y="' + (H - 46) + '" width="' + W + '" height="46" fill="#000000" opacity="0.5"/>' +
      headEls +
      bodyEls +
      '<text x="640" y="' + (H - 16) + '" font-family="' + fontFamily + '" font-size="17" fill="#555555" text-anchor="middle">Subscribe for weekly tips</text>' +
      '</svg>';
  }

  return sharp({
    create: { width: W, height: H, channels: 3, background: bg }
  })
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .png()
  .toFile(outputPath);
}

// ── SCRIPT → SLIDES ───────────────────────────────────────────────────────────

function scriptToSlides(title, scriptText) {
  var slides = [];
  slides.push({ type: "title", headline: title, sub: "Watch to the end for the full breakdown" });

  var lines = scriptText.split("\n")
    .map(function(l) { return l.trim(); })
    .filter(function(l) { return l.length > 8; });

  var currentSection = "";
  var currentBody    = [];

  function flush() {
    if (currentSection || currentBody.length > 0) {
      slides.push({
        type:     "section",
        headline: currentSection || (currentBody[0] || "").slice(0, 65),
        body:     (currentSection ? currentBody : currentBody.slice(1)).slice(0, 3),
      });
      currentSection = "";
      currentBody    = [];
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var raw   = lines[i];
    var clean = raw.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
    var isHeader = raw.startsWith("#") ||
      /^(step|tip|point|section|part|intro|conclusion|outro|hook|number|\d+[\.\)])/i.test(clean);
    if (isHeader && slides.length > 0) { flush(); currentSection = clean.slice(0, 65); }
    else currentBody.push(clean);
    if (slides.length >= 27) break;
  }
  flush();

  var fillers = [
    { headline: "Key Takeaway",   body: ["Apply one strategy from this video today", "Small consistent steps beat big sporadic ones"] },
    { headline: "Pro Tip",        body: ["Start with free tools before upgrading", "Track your progress every single week"] },
    { headline: "Common Mistake", body: ["Most people skip this critical step", "Do not make the same mistake they do"] },
    { headline: "Action Step",    body: ["Pick ONE thing from this video", "Implement it before the week is over"] },
    { headline: "Did You Know",   body: ["The top performers all do this daily", "You now have the same knowledge they do"] },
  ];
  var fi = 0;
  while (slides.length < 28) {
    slides.push({ type: "section", headline: fillers[fi % fillers.length].headline, body: fillers[fi % fillers.length].body });
    fi++;
  }
  slides.push({ type: "cta", headline: "Like Subscribe and Share!", body: ["New videos posted every week", "Turn on notifications to never miss one"], cta: "Hit Subscribe now" });
  return slides;
}

// ── GENERATE MUSIC ────────────────────────────────────────────────────────────

function generateMusic(ffmpegPath, durationSecs, outputPath) {
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) return outputPath;
  try {
    require("child_process").execSync(
      "\"" + ffmpegPath + "\" -y -f lavfi -i \"sine=frequency=220:duration=" + (durationSecs + 5) + "\" " +
      "-filter_complex \"volume=0.06\" -c:a aac \"" + outputPath + "\"",
      { stdio: "pipe", timeout: 30000 }
    );
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      console.log("     ✓ Background music generated");
      return outputPath;
    }
  } catch(e) { console.log("     → Music error: " + e.message.slice(0, 60)); }
  return null;
}

// ── ELEVENLABS VOICEOVER ──────────────────────────────────────────────────────

function generateVoiceover(text, outputPath) {
  // Read key directly from env in case config.elevenlabs isn't wired up
  var apiKey  = process.env.ELEVENLABS_API_KEY ||
    (config.elevenlabs && config.elevenlabs.api_key) || "";
  var voiceId = (config.elevenlabs && config.elevenlabs.voice_id) || "21m00Tcm4TlvDq8ikWAM";

  if (!apiKey || apiKey.length < 10) {
    console.log("     → No ElevenLabs key (skipping voiceover)");
    return Promise.resolve(null);
  }

  console.log("     → Generating voiceover with ElevenLabs...");
  var body = JSON.stringify({
    text:       text.slice(0, 2500),
    model_id:   "eleven_monolingual_v1",
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  });

  return new Promise(function(resolve) {
    var req = https.request({
      hostname: "api.elevenlabs.io",
      path:     "/v1/text-to-speech/" + voiceId,
      method:   "POST",
      headers: {
        "xi-api-key":     apiKey,
        "Content-Type":   "application/json",
        "Accept":         "audio/mpeg",
        "Content-Length": Buffer.byteLength(body),
      },
    }, function(res) {
      if (res.statusCode !== 200) {
        console.log("     → ElevenLabs HTTP " + res.statusCode + " (check API key)");
        res.resume();
        return resolve(null);
      }
      var file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on("finish", function() { file.close(); console.log("     ✓ Voiceover generated"); resolve(outputPath); });
      file.on("error", function() { resolve(null); });
    });
    req.on("error", function(e) { console.log("     → ElevenLabs error: " + e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── BUILD FULL VIDEO ──────────────────────────────────────────────────────────

function buildVideo(title, scriptText, outputPath) {
  var ffmpegPath = findFfmpeg();
  if (!ffmpegPath) return Promise.resolve({ status: "no_ffmpeg" });
  try { require("sharp"); } catch(e) { return Promise.resolve({ status: "no_sharp" }); }

  var exec   = require("child_process").execSync;
  var tmpDir = path.join(process.cwd(), "tmp", "yt_" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  var slides  = scriptToSlides(title, scriptText);
  var bgKeys  = Object.keys(BG_COLORS);

  console.log("     → Rendering " + slides.length + " slides with sharp...");

  // Build all PNGs in parallel
  var pngTasks = slides.map(function(slide, i) {
    var pngPath = path.join(tmpDir, "slide" + String(i).padStart(3, "0") + ".png");
    return makeSlidePng(slide, bgKeys[i % bgKeys.length], pngPath)
      .then(function() { return pngPath; })
      .catch(function(e) {
        console.log("     → Slide " + i + " error: " + e.message.slice(0, 60));
        return null;
      });
  });

  return Promise.all(pngTasks).then(function(pngPaths) {
    var validPngs = pngPaths.filter(function(p) {
      return p && fs.existsSync(p) && fs.statSync(p).size > 500;
    });

    if (validPngs.length === 0) return { status: "no_pngs_built" };

    // Verify text is actually in first PNG
    var firstSize = fs.statSync(validPngs[0]).size;
    console.log("     → " + validPngs.length + "/" + slides.length + " PNGs ready (first: " + firstSize + " bytes)");

    // Single ffmpeg call - image sequence method (much faster than individual clips)
    // -framerate 1/20 means each PNG lasts 20 seconds
    var videoPath = path.join(tmpDir, "video_raw.mp4");
    var seqCmd = "\"" + ffmpegPath + "\" -y -framerate 1/20 " +
      "-pattern_type glob -i \"" + tmpDir + "/slide*.png\" " +
      "-c:v libx264 -pix_fmt yuv420p -r 24 -preset ultrafast -crf 26 " +
      "\"" + videoPath + "\"";

    try {
      exec(seqCmd, { stdio: "pipe", timeout: 300000 });
    } catch(e) {
      console.log("     → Sequence encode error: " + e.message.slice(0, 150));
      return { status: "encode_error", message: e.message.slice(0, 100) };
    }

    if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 1000) {
      return { status: "video_missing" };
    }

    var totalSecs = validPngs.length * 20;
    var musicPath = path.join(process.cwd(), "tmp", "ambient.aac");
    var music     = generateMusic(ffmpegPath, totalSecs, musicPath);
    var voicePath = path.join(tmpDir, "voice.mp3");

    return generateVoiceover(scriptText.slice(0, 2500), voicePath).then(function(voiceFile) {
      var mixCmd;

      if (voiceFile && music) {
        mixCmd = "\"" + ffmpegPath + "\" -y -i \"" + videoPath + "\" -i \"" + voiceFile + "\" -i \"" + music + "\" " +
          "-filter_complex \"[1:a]volume=1.0,apad[v];[2:a]volume=0.07[m];[v][m]amix=inputs=2:duration=first[out]\" " +
          "-map 0:v -map \"[out]\" -c:v copy -c:a aac -shortest \"" + outputPath + "\"";
        console.log("     → Mixing voice + music...");
      } else if (voiceFile) {
        mixCmd = "\"" + ffmpegPath + "\" -y -i \"" + videoPath + "\" -i \"" + voiceFile + "\" " +
          "-map 0:v -map 1:a -c:v copy -c:a aac -shortest \"" + outputPath + "\"";
        console.log("     → Adding voiceover...");
      } else if (music) {
        mixCmd = "\"" + ffmpegPath + "\" -y -i \"" + videoPath + "\" -i \"" + music + "\" " +
          "-map 0:v -map 1:a -c:v copy -c:a aac -shortest \"" + outputPath + "\"";
        console.log("     → Adding ambient music...");
      } else {
        mixCmd = "\"" + ffmpegPath + "\" -y -i \"" + videoPath + "\" -c copy \"" + outputPath + "\"";
      }

      try {
        exec(mixCmd, { stdio: "pipe", timeout: 300000 });
      } catch(e) {
        console.log("     → Audio mix failed, saving silent: " + e.message.slice(0, 60));
        try { exec("\"" + ffmpegPath + "\" -y -i \"" + videoPath + "\" -c copy \"" + outputPath + "\"", { stdio: "pipe" }); }
        catch(e2) { return { status: "final_error" }; }
      }

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 10000) {
        return { status: "output_missing" };
      }

      var sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
      var mins   = Math.round(validPngs.length * 20 / 60);
      console.log("     ✓ Video: " + sizeMb + "MB ~" + mins + "min | text=YES voice=" + (!!voiceFile) + " music=" + (!!music) + " slides=" + validPngs.length);
      return { status: "built", path: outputPath, size_mb: sizeMb, minutes: mins, slides: validPngs.length, voice: !!voiceFile, music: !!music };
    });
  });
}

// ── YOUTUBE UPLOAD ────────────────────────────────────────────────────────────

function getAccessToken() {
  var cid = config.youtube.client_id;
  var cs  = config.youtube.client_secret;
  var rt  = config.youtube.refresh_token;
  if (!cid || !cs || !rt) return Promise.reject(new Error("YouTube credentials not configured"));
  var body = "client_id=" + encodeURIComponent(cid) + "&client_secret=" + encodeURIComponent(cs) +
    "&refresh_token=" + encodeURIComponent(rt) + "&grant_type=refresh_token";
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, function(res) {
      var data = "";
      res.on("data", function(d) { data += d; });
      res.on("end", function() {
        try {
          var r = JSON.parse(data);
          if (r.access_token) { resolve(r.access_token); }
          else reject(new Error("Token error: " + JSON.stringify(r)));
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function uploadVideo(videoFilePath, scriptData) {
  if (!config.youtube.refresh_token) return Promise.resolve({ status: "no_credentials" });
  if (!fs.existsSync(videoFilePath))  return Promise.resolve({ status: "no_video_file" });
  return getAccessToken().then(function(accessToken) {
    var initBody = JSON.stringify({
      snippet: {
        title:       (scriptData.title || "AI Tools Video").slice(0, 100),
        description: scriptData.description || "Subscribe for weekly videos!",
        tags:        scriptData.tags || ["AI", "tools", "tutorial"],
        categoryId:  "27",
      },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    });
    var fileSize = fs.statSync(videoFilePath).size;
    return new Promise(function(resolve) {
      var initReq = https.request({
        hostname: "www.googleapis.com",
        path:     "/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        method:   "POST",
        headers: {
          "Authorization": "Bearer " + accessToken, "Content-Type": "application/json",
          "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": fileSize,
          "Content-Length": Buffer.byteLength(initBody),
        },
      }, function(res) {
        var uploadUrl = res.headers.location;
        if (!uploadUrl) return resolve({ status: "error", message: "No upload URL" });
        console.log("     → Uploading to YouTube...");
        var videoData = fs.readFileSync(videoFilePath);
        var urlObj    = new URL(uploadUrl);
        var upReq = https.request({
          hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: "PUT",
          headers: { "Content-Type": "video/mp4", "Content-Length": fileSize },
        }, function(upRes) {
          var body2 = "";
          upRes.on("data", function(d) { body2 += d; });
          upRes.on("end", function() {
            try {
              var r = JSON.parse(body2);
              if (r.id) {
                console.log("     ✓ Uploaded! https://youtu.be/" + r.id);
                auditLog("YOUTUBE_UPLOADED", { video_id: r.id, title: scriptData.title });
                resolve({ status: "success", video_id: r.id, url: "https://youtu.be/" + r.id });
              } else resolve({ status: "error", body: body2.slice(0, 200) });
            } catch(e) { resolve({ status: "parse_error" }); }
          });
        });
        upReq.on("error", function(e) { resolve({ status: "network_error", message: e.message }); });
        upReq.write(videoData);
        upReq.end();
      });
      initReq.on("error", function(e) { resolve({ status: "init_error", message: e.message }); });
      initReq.write(initBody);
      initReq.end();
    });
  }).catch(function(err) { return { status: "error", message: err.message }; });
}

// ── RESEARCH / SCRIPT / METADATA ─────────────────────────────────────────────

function researchTopics(niche) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 1000,
    messages: [{ role: "user", content:
      "Generate 3 YouTube video topics for a faceless channel in the \"" + niche + "\" niche.\n" +
      "Return ONLY a JSON array, no markdown:\n" +
      "[{\"title\":\"Top 10 AI Tools for Small Business in 2025\",\"hook\":\"In the next 8 minutes...\",\"why_rank\":\"High search volume\"}]"
    }],
  }).then(function(res) {
    var text  = res.content[0].text.trim().replace(/```json/g,"").replace(/```/g,"").trim();
    var start = text.indexOf("["); var end = text.lastIndexOf("]");
    if (start === -1) throw new Error("no array");
    return JSON.parse(text.slice(start, end + 1));
  }).catch(function() {
    return [{ title: "Top 10 AI Tools for " + niche + " in 2025", hook: "Watch to the end...", why_rank: "Evergreen" }];
  });
}

function generateScript(topic, niche, product_url) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 2000,
    system: "You are a YouTube scriptwriter for faceless educational channels.",
    messages: [{ role: "user", content:
      "Write a YouTube video script for: \"" + topic.title + "\"\nNiche: " + niche + "\nProduct (mention once naturally): " + (product_url || "none") + "\n\n" +
      "Structure: Start with HOOK, then use ## to mark exactly 5 section headers (e.g. ## 1. Title), each section 2-3 sentences, end with a subscribe CTA. Total ~8 minutes spoken."
    }],
  }).then(function(res) { return res.content[0].text; });
}

function generateMetadata(topic, niche) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 600,
    messages: [{ role: "user", content:
      "YouTube SEO for: \"" + topic.title + "\" (niche: " + niche + ")\nReturn ONLY JSON no markdown:\n{\"title\":\"title max 90 chars\",\"description\":\"250 words with timestamps and subscribe CTA\",\"tags\":[\"tag1\",\"tag2\"],\"category\":\"27\"}"
    }],
  }).then(function(res) {
    var text  = res.content[0].text.trim().replace(/```json/g,"").replace(/```/g,"").trim();
    var start = text.indexOf("{"); var end = text.lastIndexOf("}");
    if (start === -1) throw new Error("no json");
    return JSON.parse(text.slice(start, end + 1));
  }).catch(function() {
    return { title: topic.title, description: "Subscribe for weekly videos!", tags: [topic.title, niche, "tips"], category: "27" };
  });
}

function saveVideoPackage(topic, script, metadata) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  var slug     = topic.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  var videoDir = path.join(OUT_DIR, slug);
  fs.mkdirSync(videoDir, { recursive: true });
  fs.writeFileSync(path.join(videoDir, "script.txt"),    script);
  fs.writeFileSync(path.join(videoDir, "metadata.json"), JSON.stringify(metadata, null, 2));
  fs.writeFileSync(path.join(videoDir, "description.txt"), metadata.description || "");
  var logFile = path.join(DATA_DIR, "videos.json");
  var log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
  log.push({ date: new Date().toISOString(), slug, title: topic.title, status: "ready", dir: videoDir });
  fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
  auditLog("YOUTUBE_VIDEO_CREATED", { title: topic.title });
  return videoDir;
}

function getGrowthStatus() {
  var logFile = path.join(DATA_DIR, "videos.json");
  var videos  = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
  return {
    videos_created:  videos.length,
    videos_uploaded: videos.filter(function(v) { return v.status === "uploaded"; }).length,
  };
}

// ── MAIN RUN ──────────────────────────────────────────────────────────────────

function run(niche, product_url) {
  console.log("\n  📹 YouTube Module running...");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  var topicData, scriptText, metaData, videoDir;

  return researchTopics(niche).then(function(topics) {
    topicData = topics[0];
    console.log("     → Topic: \"" + topicData.title + "\"");
    return generateScript(topicData, niche, product_url);
  }).then(function(script) {
    scriptText = script;
    console.log("     → Script: " + script.length + " chars");
    return generateMetadata(topicData, niche);
  }).then(function(metadata) {
    metaData = metadata;
    videoDir = saveVideoPackage(topicData, scriptText, metaData);
    console.log("     ✓ Package saved");
    return buildVideo(metaData.title || topicData.title, scriptText, path.join(videoDir, "video.mp4"));
  }).then(function(videoResult) {
    if (videoResult.status !== "built") {
      console.log("     → Video status: " + videoResult.status + (videoResult.message ? " | " + videoResult.message : ""));
      return { status: "no_video", title: topicData.title, dir: videoDir };
    }
    if (!config.youtube.refresh_token) {
      return { status: "ready", title: topicData.title, dir: videoDir };
    }
    return uploadVideo(path.join(videoDir, "video.mp4"), {
      title:       metaData.title || topicData.title,
      description: metaData.description || "",
      tags:        metaData.tags || [],
    }).then(function(uploadResult) {
      if (uploadResult.status === "success") {
        var logFile = path.join(DATA_DIR, "videos.json");
        var log     = JSON.parse(fs.readFileSync(logFile, "utf8"));
        log[log.length - 1].status      = "uploaded";
        log[log.length - 1].youtube_url = uploadResult.url;
        fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
      }
      return { status: "complete", title: topicData.title, dir: videoDir, upload: uploadResult };
    });
  });
}

module.exports = { run, researchTopics, generateScript, uploadVideo, getGrowthStatus };
