require("dotenv").config();
const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const config = require("../../config");
const { auditLog } = require("../../security/vault");

const client   = new Anthropic({ apiKey: config.anthropic.api_key });
const OUT_DIR  = path.join(process.cwd(), "output", "youtube");
const DATA_DIR = path.join(process.cwd(), "data", "youtube");

// ── FIND FONT ─────────────────────────────────────────────────────────────────

function findFont() {
  var candidates = [
    path.join(process.cwd(), "assets", "DejaVuSans-Bold.ttf"),
    path.join(process.cwd(), "assets", "font.ttf"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      console.log("     → Font: " + path.basename(candidates[i]));
      return candidates[i];
    }
  }
  try {
    var found = require("child_process").execSync(
      "find /usr/share/fonts -name '*.ttf' 2>/dev/null | head -1",
      { encoding: "utf8" }
    ).trim();
    if (found) { console.log("     → Font (fallback): " + found); return found; }
  } catch(e) {}
  return null;
}

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

// ── SAFE TEXT FOR FFMPEG DRAWTEXT ─────────────────────────────────────────────
// Removes/replaces ALL characters that can break ffmpeg filter strings
// Tested against: $100K, #1:, it's, [brackets], commas, equals, quotes

function safeText(str, maxLen) {
  maxLen = maxLen || 60;
  return String(str || "")
    .replace(/\\/g, "")           // backslashes
    .replace(/'/g, "")            // single quotes - breaks filter string
    .replace(/"/g, "")            // double quotes
    .replace(/\$/g, "USD")        // dollar signs -> USD (financial content)
    .replace(/:/g, " -")          // colons -> dash
    .replace(/,/g, " ")           // commas
    .replace(/=/g, " ")           // equals
    .replace(/\[/g, "(")          // square brackets
    .replace(/\]/g, ")")
    .replace(/[<>|&;`!#@*^~]/g, "") // other shell-dangerous chars
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

// ── WRAP TEXT TO MULTIPLE LINES ───────────────────────────────────────────────

function wrapText(text, maxChars) {
  text = safeText(text, 200);
  if (text.length <= maxChars) return [text];
  var words = text.split(" ");
  var lines = [];
  var cur   = "";
  for (var i = 0; i < words.length; i++) {
    var test = cur ? cur + " " + words[i] : words[i];
    if (test.length > maxChars) {
      if (cur) lines.push(cur);
      cur = words[i].slice(0, maxChars);
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ── DOWNLOAD FILE ─────────────────────────────────────────────────────────────

function downloadFile(url, destPath, hops) {
  hops = hops || 0;
  if (hops > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise(function(resolve, reject) {
    var proto = url.startsWith("https") ? https : http;
    var file  = fs.createWriteStream(destPath);
    proto.get(url, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
        file.close();
        fs.unlink(destPath, function() {});
        return downloadFile(res.headers.location, destPath, hops + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, function() {});
        return reject(new Error("HTTP " + res.statusCode));
      }
      res.pipe(file);
      file.on("finish", function() { file.close(); resolve(destPath); });
      file.on("error", function(e) { fs.unlink(destPath, function() {}); reject(e); });
    }).on("error", function(e) { fs.unlink(destPath, function() {}); reject(e); });
  });
}

// ── ELEVENLABS VOICEOVER ──────────────────────────────────────────────────────

function generateVoiceover(text, outputPath) {
  var apiKey  = (config.elevenlabs && config.elevenlabs.api_key) || process.env.ELEVENLABS_API_KEY;
  var voiceId = (config.elevenlabs && config.elevenlabs.voice_id) || "21m00Tcm4TlvDq8ikWAM";
  if (!apiKey) return Promise.resolve(null);

  var trimmed = text.slice(0, 2500);
  var body    = JSON.stringify({
    text: trimmed,
    model_id: "eleven_monolingual_v1",
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
        console.log("     → ElevenLabs: HTTP " + res.statusCode + " (skipping voiceover)");
        res.resume();
        return resolve(null);
      }
      var file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on("finish", function() {
        file.close();
        console.log("     ✓ Voiceover generated");
        resolve(outputPath);
      });
      file.on("error", function() { resolve(null); });
    });
    req.on("error", function(e) {
      console.log("     → ElevenLabs error: " + e.message);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// ── GENERATE AMBIENT MUSIC ────────────────────────────────────────────────────

function generateMusic(ffmpegPath, durationSecs, outputPath) {
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
    return outputPath;
  }
  try {
    var exec = require("child_process").execSync;
    // Four quiet sine waves layered = soft ambient chord (no external downloads)
    var cmd = "\"" + ffmpegPath + "\" -y " +
      "-f lavfi -i sine=frequency=130:duration=" + (durationSecs + 5) + " " +
      "-f lavfi -i sine=frequency=196:duration=" + (durationSecs + 5) + " " +
      "-f lavfi -i sine=frequency=261:duration=" + (durationSecs + 5) + " " +
      "-f lavfi -i sine=frequency=392:duration=" + (durationSecs + 5) + " " +
      "-filter_complex \"[0][1][2][3]amix=inputs=4:duration=longest,volume=0.07\" " +
      "-c:a aac \"" + outputPath + "\"";
    exec(cmd, { stdio: "pipe", timeout: 30000 });
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      console.log("     ✓ Ambient music generated");
      return outputPath;
    }
  } catch(e) {
    console.log("     → Music error: " + e.message.slice(0, 80));
  }
  return null;
}

// ── SCRIPT → SLIDES ───────────────────────────────────────────────────────────

function scriptToSlides(title, scriptText) {
  var slides = [];

  // Slide 0: title card
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
    var raw      = lines[i];
    var clean    = raw.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
    var isHeader = raw.startsWith("#") ||
      (clean.length < 60 && /^(step|tip|point|section|part|intro|conclusion|outro|hook|key|number|\d+[\.\)])/i.test(clean));

    if (isHeader && slides.length > 0) {
      flush();
      currentSection = clean.slice(0, 65);
    } else {
      currentBody.push(clean);
    }
    if (slides.length >= 27) break;
  }
  flush();

  // Pad to 28 slides
  var fillers = [
    { headline: "Key Takeaway",    body: ["Apply one strategy from this video today", "Small consistent steps beat big sporadic ones"] },
    { headline: "Pro Tip",         body: ["Start with free tools before upgrading", "Track your progress every single week"] },
    { headline: "Common Mistake",  body: ["Most people skip this critical step", "Do not make the same mistake they do"] },
    { headline: "Action Step",     body: ["Pick ONE thing from this video", "Implement it before the week is over"] },
    { headline: "Did You Know",    body: ["The top performers all do this daily", "You now have the same knowledge they do"] },
  ];
  var fi = 0;
  while (slides.length < 28) {
    slides.push({ type: "section", headline: fillers[fi % fillers.length].headline, body: fillers[fi % fillers.length].body });
    fi++;
  }

  // Final CTA slide
  slides.push({ type: "cta", headline: "Like Subscribe and Share!", body: ["New videos posted every week", "Turn on notifications to never miss one"], cta: "Hit Subscribe now" });

  return slides; // 29-30 slides × 20s = ~10 min
}

// ── BUILD ONE SLIDE CLIP ──────────────────────────────────────────────────────

function buildSlideClip(ffmpegPath, fontFile, slide, bgColor, outputPath) {
  var exec    = require("child_process").execSync;
  var filters = [];

  if (slide.type === "title") {
    filters.push("drawbox=x=0:y=0:w=iw:h=10:color=0x4488ff:t=fill");
    filters.push("drawbox=x=0:y=ih-10:w=iw:h=10:color=0x4488ff:t=fill");

    var titleLines = wrapText(slide.headline, 36);
    var startY = Math.max(200, 310 - titleLines.length * 36);
    for (var i = 0; i < Math.min(titleLines.length, 3); i++) {
      filters.push(
        "drawtext=fontfile=" + fontFile + ":text=" + safeText(titleLines[i], 55) +
        ":fontcolor=white:fontsize=50:x=(w-text_w)/2:y=" + (startY + i * 66)
      );
    }
    if (slide.sub) {
      filters.push(
        "drawtext=fontfile=" + fontFile + ":text=" + safeText(slide.sub, 60) +
        ":fontcolor=0x88aaff:fontsize=26:x=(w-text_w)/2:y=530"
      );
    }

  } else if (slide.type === "cta") {
    filters.push("drawbox=x=0:y=0:w=iw:h=10:color=0xff8844:t=fill");
    filters.push("drawbox=x=0:y=ih-90:w=iw:h=90:color=black@0.6:t=fill");
    filters.push(
      "drawtext=fontfile=" + fontFile + ":text=" + safeText(slide.headline, 50) +
      ":fontcolor=0xffaa44:fontsize=46:x=(w-text_w)/2:y=230"
    );
    var body = slide.body || [];
    for (var j = 0; j < Math.min(body.length, 3); j++) {
      filters.push(
        "drawtext=fontfile=" + fontFile + ":text=" + safeText(body[j], 60) +
        ":fontcolor=white:fontsize=28:x=(w-text_w)/2:y=" + (360 + j * 50)
      );
    }
    if (slide.cta) {
      filters.push(
        "drawtext=fontfile=" + fontFile + ":text=" + safeText(slide.cta, 55) +
        ":fontcolor=0xffaa44:fontsize=28:x=(w-text_w)/2:y=h-65"
      );
    }

  } else {
    // Section slide
    filters.push("drawbox=x=0:y=0:w=iw:h=10:color=0x4488ff:t=fill");
    filters.push("drawbox=x=60:y=140:w=iw-120:h=110:color=black@0.4:t=fill");

    var headLines = wrapText(slide.headline, 40);
    for (var hi = 0; hi < Math.min(headLines.length, 2); hi++) {
      filters.push(
        "drawtext=fontfile=" + fontFile + ":text=" + safeText(headLines[hi], 55) +
        ":fontcolor=white:fontsize=42:x=(w-text_w)/2:y=" + (158 + hi * 56)
      );
    }

    var bodyLines = slide.body || [];
    for (var bi = 0; bi < Math.min(bodyLines.length, 4); bi++) {
      var wrapped = wrapText(bodyLines[bi], 58);
      for (var wi = 0; wi < Math.min(wrapped.length, 2); wi++) {
        filters.push(
          "drawtext=fontfile=" + fontFile + ":text=" + safeText(wrapped[wi], 65) +
          ":fontcolor=0xccddff:fontsize=28:x=100:y=" + (300 + bi * 88 + wi * 36)
        );
      }
    }

    // Subtle bottom bar
    filters.push("drawbox=x=0:y=ih-44:w=iw:h=44:color=black@0.5:t=fill");
    filters.push(
      "drawtext=fontfile=" + fontFile + ":text=Subscribe for weekly tips" +
      ":fontcolor=0x666666:fontsize=18:x=(w-text_w)/2:y=h-30"
    );
  }

  var vf = filters.join(",");

  // Use shell=false style: write vf to a temp file to avoid any shell escaping issues
  var cmd = "\"" + ffmpegPath + "\" -y " +
    "-f lavfi -i color=c=" + bgColor + ":size=1280x720:duration=20 " +
    "-vf \"" + vf + "\" " +
    "-c:v libx264 -pix_fmt yuv420p -r 24 -t 20 " +
    "\"" + outputPath + "\"";

  exec(cmd, { stdio: "pipe", timeout: 60000 });
  return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
}

// ── BUILD FULL VIDEO ──────────────────────────────────────────────────────────

function buildVideo(title, scriptText, outputPath) {
  var ffmpegPath = findFfmpeg();
  var fontFile   = findFont();

  if (!ffmpegPath) return Promise.resolve({ status: "no_ffmpeg" });
  if (!fontFile)   return Promise.resolve({ status: "no_font" });

  var exec   = require("child_process").execSync;
  var tmpDir = path.join(process.cwd(), "tmp", "yt_" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });

  var slides   = scriptToSlides(title, scriptText);
  var bgColors = ["0d1b2a", "0a1a2e", "12082a", "0a2018", "1a1208", "081a1a", "1a0818"];
  var clipPaths = [];

  console.log("     → Building " + slides.length + " slides (~" + Math.round(slides.length * 20 / 60) + " min)...");

  for (var i = 0; i < slides.length; i++) {
    var clipPath = path.join(tmpDir, "clip" + String(i).padStart(3, "0") + ".mp4");
    var bgColor  = bgColors[i % bgColors.length];
    try {
      var ok = buildSlideClip(ffmpegPath, fontFile, slides[i], bgColor, clipPath);
      if (ok) {
        clipPaths.push(clipPath);
      } else {
        console.log("     → Slide " + i + ": output missing");
      }
    } catch(e) {
      // Log first 300 chars of actual error so we can debug
      console.log("     → Slide " + i + " failed: " + e.message.slice(0, 300));
    }
  }

  if (clipPaths.length === 0) {
    return Promise.resolve({ status: "no_clips_built" });
  }

  console.log("     → " + clipPaths.length + "/" + slides.length + " clips built, concatenating...");

  var listFile = path.join(tmpDir, "list.txt");
  fs.writeFileSync(listFile, clipPaths.map(function(f) { return "file '" + f + "'"; }).join("\n"));

  var concatPath = path.join(tmpDir, "concat.mp4");
  try {
    exec(
      "\"" + ffmpegPath + "\" -y -f concat -safe 0 -i \"" + listFile + "\" -c copy \"" + concatPath + "\"",
      { stdio: "pipe", timeout: 300000 }
    );
  } catch(e) {
    return Promise.resolve({ status: "concat_error", message: e.message.slice(0, 150) });
  }

  var totalSecs = clipPaths.length * 20;
  var musicPath = path.join(process.cwd(), "tmp", "ambient.aac");
  var music     = generateMusic(ffmpegPath, totalSecs, musicPath);
  var voicePath = path.join(tmpDir, "voice.mp3");

  return generateVoiceover(scriptText.slice(0, 2500), voicePath).then(function(voiceFile) {
    var finalPath = outputPath;
    var mixCmd;

    if (voiceFile && music) {
      // Voice full volume + music soft in background
      mixCmd = "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -i \"" + voiceFile + "\" -i \"" + music + "\" " +
        "-filter_complex \"[1:a]volume=1.0,apad[v];[2:a]volume=0.07[m];[v][m]amix=inputs=2:duration=first[out]\" " +
        "-map 0:v -map \"[out]\" -c:v copy -c:a aac -shortest \"" + finalPath + "\"";
      console.log("     → Mixing voice + music...");
    } else if (voiceFile) {
      mixCmd = "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -i \"" + voiceFile + "\" " +
        "-map 0:v -map 1:a -c:v copy -c:a aac -shortest \"" + finalPath + "\"";
      console.log("     → Adding voiceover...");
    } else if (music) {
      mixCmd = "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -i \"" + music + "\" " +
        "-map 0:v -map 1:a -c:v copy -c:a aac -shortest \"" + finalPath + "\"";
      console.log("     → Adding ambient music...");
    } else {
      mixCmd = "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -c copy \"" + finalPath + "\"";
    }

    try {
      require("child_process").execSync(mixCmd, { stdio: "pipe", timeout: 300000 });
    } catch(e) {
      console.log("     → Audio mix failed (" + e.message.slice(0, 80) + "), saving silent");
      try {
        require("child_process").execSync(
          "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -c copy \"" + finalPath + "\"",
          { stdio: "pipe" }
        );
      } catch(e2) { return { status: "final_error", message: e2.message.slice(0, 100) }; }
    }

    if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size < 10000) {
      return { status: "output_missing" };
    }

    var sizeMb = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(1);
    var mins   = Math.round(clipPaths.length * 20 / 60);
    console.log("     ✓ Video: " + sizeMb + "MB ~" + mins + "min | text=YES voice=" + (!!voiceFile) + " music=" + (!!music) + " slides=" + clipPaths.length);
    return { status: "built", path: finalPath, size_mb: sizeMb, minutes: mins, slides: clipPaths.length, voice: !!voiceFile, music: !!music };
  });
}

// ── YOUTUBE UPLOAD ────────────────────────────────────────────────────────────

function getAccessToken() {
  var cid = config.youtube.client_id;
  var cs  = config.youtube.client_secret;
  var rt  = config.youtube.refresh_token;
  if (!cid || !cs || !rt) return Promise.reject(new Error("YouTube credentials not configured"));
  var body = "client_id=" + encodeURIComponent(cid) +
    "&client_secret=" + encodeURIComponent(cs) +
    "&refresh_token=" + encodeURIComponent(rt) +
    "&grant_type=refresh_token";
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
          if (r.access_token) { console.log("     → Access token obtained"); resolve(r.access_token); }
          else reject(new Error("Token error: " + JSON.stringify(r)));
        } catch(e) { reject(new Error("Token parse error")); }
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
          "Authorization":           "Bearer " + accessToken,
          "Content-Type":            "application/json",
          "X-Upload-Content-Type":   "video/mp4",
          "X-Upload-Content-Length": fileSize,
          "Content-Length":          Buffer.byteLength(initBody),
        },
      }, function(res) {
        var uploadUrl = res.headers.location;
        if (!uploadUrl) return resolve({ status: "error", message: "No upload URL" });
        console.log("     → Uploading to YouTube...");
        var videoData = fs.readFileSync(videoFilePath);
        var urlObj    = new URL(uploadUrl);
        var upReq = https.request({
          hostname: urlObj.hostname,
          path:     urlObj.pathname + urlObj.search,
          method:   "PUT",
          headers: { "Content-Type": "video/mp4", "Content-Length": fileSize },
        }, function(upRes) {
          var body = "";
          upRes.on("data", function(d) { body += d; });
          upRes.on("end", function() {
            try {
              var r = JSON.parse(body);
              if (r.id) {
                console.log("     ✓ Uploaded! https://youtu.be/" + r.id);
                auditLog("YOUTUBE_UPLOADED", { video_id: r.id, title: scriptData.title });
                resolve({ status: "success", video_id: r.id, url: "https://youtu.be/" + r.id });
              } else {
                resolve({ status: "error", body: body.slice(0, 200) });
              }
            } catch(e) { resolve({ status: "parse_error", body: body.slice(0, 200) }); }
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
  }).catch(function(err) {
    return { status: "error", message: err.message };
  });
}

// ── RESEARCH / SCRIPT / METADATA ─────────────────────────────────────────────

function researchTopics(niche) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 1000,
    messages: [{ role: "user", content:
      "Generate 3 YouTube video topics for a faceless channel in the \"" + niche + "\" niche.\n" +
      "Return ONLY a JSON array. No markdown:\n" +
      "[{\"title\":\"Top 10 AI Tools for Small Business in 2025\",\"hook\":\"In the next 8 minutes...\",\"why_rank\":\"High search volume\",\"affiliate\":\"AI tools\"}]"
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
      "Write a YouTube video script for: \"" + topic.title + "\"\nNiche: " + niche + "\nProduct (mention once): " + (product_url || "none") + "\n\n" +
      "Use ## to mark exactly 5 section headers (e.g. ## 1. Tool Name). Each section 2-3 sentences. Start with a HOOK, end with a subscribe CTA. Total ~8 minutes spoken."
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
    return { title: topic.title, description: topic.hook + "\n\nSubscribe!", tags: [niche, "tips"], category: "27" };
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
