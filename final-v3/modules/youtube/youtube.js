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

// Font file bundled in repo at assets/DejaVuSans-Bold.ttf
// Falls back to any .ttf found on the system
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
  // Last resort: scan common dirs
  try {
    var exec = require("child_process").execSync;
    var found = exec("find /usr/share/fonts -name '*.ttf' 2>/dev/null | head -1", { encoding: "utf8" }).trim();
    if (found) return found;
  } catch(e) {}
  return null;
}

function findFfmpeg() {
  try {
    var p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) { console.log("     → ffmpeg: ffmpeg-static"); return p; }
  } catch(e) {}
  try {
    var w = require("child_process").execSync("which ffmpeg", { encoding: "utf8" }).trim();
    if (w) { console.log("     → ffmpeg: " + w); return w; }
  } catch(e) {}
  return null;
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

  // Trim to ~2000 chars so it stays under ElevenLabs limits per request
  var trimmed = text.slice(0, 2000);
  var body    = JSON.stringify({ text: trimmed, model_id: "eleven_monolingual_v1", voice_settings: { stability: 0.5, similarity_boost: 0.75 } });

  return new Promise(function(resolve) {
    var req = https.request({
      hostname: "api.elevenlabs.io",
      path:     "/v1/text-to-speech/" + voiceId,
      method:   "POST",
      headers: {
        "xi-api-key":   apiKey,
        "Content-Type": "application/json",
        "Accept":       "audio/mpeg",
        "Content-Length": Buffer.byteLength(body),
      },
    }, function(res) {
      if (res.statusCode !== 200) {
        console.log("     → ElevenLabs status: " + res.statusCode + " (skipping voiceover)");
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
    req.on("error", function() { resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── GENERATE AMBIENT MUSIC WITH FFMPEG ───────────────────────────────────────
// Uses ffmpeg's built-in audio filters — no downloads, no external URLs
// Creates a soft ambient pad sound by layering sine waves at low volume

function generateMusic(ffmpegPath, durationSecs, outputPath) {
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 50000) {
    return outputPath; // reuse cached
  }
  try {
    var exec = require("child_process").execSync;
    // Layer 4 quiet sine waves at pleasant frequencies = ambient pad effect
    var filter = [
      "sine=frequency=130:duration=" + durationSecs,
      "sine=frequency=196:duration=" + durationSecs,
      "sine=frequency=261:duration=" + durationSecs,
      "sine=frequency=392:duration=" + durationSecs,
    ].map(function(s, i) { return "[a" + i + "]"; });

    var cmd = "\"" + ffmpegPath + "\" -y " +
      "-f lavfi -i sine=frequency=130:duration=" + durationSecs + " " +
      "-f lavfi -i sine=frequency=196:duration=" + durationSecs + " " +
      "-f lavfi -i sine=frequency=261:duration=" + durationSecs + " " +
      "-f lavfi -i sine=frequency=392:duration=" + durationSecs + " " +
      "-filter_complex \"[0][1][2][3]amix=inputs=4:duration=longest,volume=0.08\" " +
      "-c:a aac \"" + outputPath + "\"";

    exec(cmd, { stdio: "pipe", timeout: 30000 });

    if (fs.existsSync(outputPath)) {
      console.log("     ✓ Ambient music generated (" + durationSecs + "s)");
      return outputPath;
    }
  } catch(e) {
    console.log("     → Music gen error: " + e.message.slice(0, 80));
  }
  return null;
}

// ── SCRIPT → SLIDE DATA ───────────────────────────────────────────────────────

function scriptToSlides(title, scriptText) {
  var slides = [];

  // Slide 0: Title card
  slides.push({
    type:     "title",
    headline: title,
    sub:      "Watch to the end for the full breakdown",
    cta:      null,
  });

  // Split script into lines, filter blanks
  var lines = scriptText
    .split("\n")
    .map(function(l) { return l.trim(); })
    .filter(function(l) { return l.length > 8; });

  // Detect section headers (lines starting with ## or ALL CAPS short lines)
  var currentSection = "";
  var currentBody    = [];

  function flush() {
    if (currentSection || currentBody.length > 0) {
      slides.push({
        type:     "section",
        headline: currentSection || currentBody[0] || "",
        body:     currentSection ? currentBody.slice(0, 3) : currentBody.slice(1, 4),
        cta:      null,
      });
      currentSection = "";
      currentBody    = [];
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^#+\s*/, "").replace(/\*\*/g, "");
    var isHeader = lines[i].startsWith("#") ||
      (line.length < 60 && line === line.toUpperCase() && line.length > 5) ||
      /^(step|tip|point|section|part|intro|conclusion|outro|hook|key|main|number|\d+[\.\)])/i.test(line);

    if (isHeader && slides.length > 0) {
      flush();
      currentSection = line.slice(0, 65);
    } else {
      currentBody.push(line.slice(0, 80));
    }

    if (slides.length >= 28) break; // cap at 28 content slides
  }
  flush();

  // Pad if under 28 slides
  var padMessages = [
    { headline: "Key Takeaway", body: ["Apply what you learned today", "Small steps lead to big results"] },
    { headline: "Pro Tip", body: ["Consistency beats perfection", "Start with one tool, master it"] },
    { headline: "Next Steps", body: ["Pick one strategy from this video", "Implement it this week"] },
    { headline: "Did You Know?", body: ["Most people quit before seeing results", "You're already ahead by watching this"] },
    { headline: "Quick Recap", body: ["We covered the top strategies", "Rewatch anytime you need a refresher"] },
  ];
  var pi = 0;
  while (slides.length < 28) {
    var pad = padMessages[pi % padMessages.length];
    slides.push({ type: "section", headline: pad.headline, body: pad.body, cta: null });
    pi++;
  }

  // Final slide: CTA
  slides.push({
    type:     "cta",
    headline: "Like, Comment & Subscribe!",
    body:     ["New videos every week", "Turn on notifications so you never miss one"],
    cta:      "Hit the Subscribe button now 👇",
  });

  return slides; // 30 slides total × 20s = 10 min
}

// ── ESCAPE TEXT FOR FFMPEG DRAWTEXT ──────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")   // replace apostrophe with right single quote (safe)
    .replace(/:/g, "\\:")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,")
    .replace(/=/g, "\\=")
    .replace(/\n/g, " ")
    .slice(0, 72);
}

// ── BUILD ONE SLIDE VIDEO ─────────────────────────────────────────────────────

function buildSlideClip(ffmpegPath, fontFile, slide, bgColor, outputPath) {
  var exec    = require("child_process").execSync;
  var filters = [];

  if (slide.type === "title") {
    // Gradient-style background with top accent bar
    filters.push("drawbox=x=0:y=0:w=iw:h=8:color=#4488ff@1.0:t=fill");
    filters.push("drawbox=x=0:y=ih-8:w=iw:h=8:color=#4488ff@0.5:t=fill");
    // Big centered title
    var titleLines = wrapText(slide.headline, 38);
    var startY = Math.max(220, 300 - titleLines.length * 35);
    for (var i = 0; i < titleLines.length; i++) {
      filters.push("drawtext=fontfile='" + fontFile + "':text='" + esc(titleLines[i]) + "':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=" + (startY + i * 68));
    }
    // Subtitle
    if (slide.sub) {
      filters.push("drawtext=fontfile='" + fontFile + "':text='" + esc(slide.sub) + "':fontcolor=#88aaff:fontsize=28:x=(w-text_w)/2:y=520");
    }
  } else if (slide.type === "cta") {
    filters.push("drawbox=x=0:y=0:w=iw:h=8:color=#ff8844@1.0:t=fill");
    filters.push("drawbox=x=0:y=ih-120:w=iw:h=120:color=black@0.6:t=fill");
    filters.push("drawtext=fontfile='" + fontFile + "':text='" + esc(slide.headline) + "':fontcolor=#ffaa44:fontsize=48:x=(w-text_w)/2:y=240");
    var bodyLines = slide.body || [];
    for (var j = 0; j < Math.min(bodyLines.length, 3); j++) {
      filters.push("drawtext=fontfile='" + fontFile + "':text='" + esc(bodyLines[j]) + "':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=" + (360 + j * 48));
    }
    if (slide.cta) {
      filters.push("drawtext=fontfile='" + fontFile + "':text='" + esc(slide.cta) + "':fontcolor=#ffaa44:fontsize=30:x=(w-text_w)/2:y=h-85");
    }
  } else {
    // Section slide
    filters.push("drawbox=x=0:y=0:w=iw:h=8:color=#4488ff@0.8:t=fill");
    // Semi-transparent box behind headline
    filters.push("drawbox=x=80:y=150:w=iw-160:h=100:color=black@0.35:t=fill");
    var headLines = wrapText(slide.headline, 42);
    var headY = 170;
    for (var hi = 0; hi < Math.min(headLines.length, 2); hi++) {
      filters.push("drawtext=fontfile='" + fontFile + "':text='" + esc(headLines[hi]) + "':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=" + (headY + hi * 58));
    }
    // Body lines
    var body = slide.body || [];
    for (var bi = 0; bi < Math.min(body.length, 4); bi++) {
      var wrapped = wrapText(body[bi], 62);
      for (var wi = 0; wi < Math.min(wrapped.length, 2); wi++) {
        filters.push("drawtext=fontfile='" + fontFile + "':text='" + esc(wrapped[wi]) + "':fontcolor=#ccddff:fontsize=28:x=120:y=" + (310 + bi * 90 + wi * 36));
      }
    }
    // Bottom bar
    filters.push("drawbox=x=0:y=ih-50:w=iw:h=50:color=black@0.5:t=fill");
    filters.push("drawtext=fontfile='" + fontFile + "':text='Like & Subscribe for weekly AI tips':fontcolor=#888888:fontsize=20:x=(w-text_w)/2:y=h-35");
  }

  var vf  = filters.join(",");
  var cmd = "\"" + ffmpegPath + "\" -y " +
    "-f lavfi -i color=c=" + bgColor + ":size=1280x720:duration=20 " +
    "-vf \"" + vf + "\" " +
    "-c:v libx264 -pix_fmt yuv420p -r 24 -t 20 " +
    "\"" + outputPath + "\"";

  exec(cmd, { stdio: "pipe", timeout: 30000 });
  return fs.existsSync(outputPath);
}

function wrapText(text, maxChars) {
  text = String(text || "");
  if (text.length <= maxChars) return [text];
  var words  = text.split(" ");
  var lines  = [];
  var cur    = "";
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

  console.log("     → Building " + slides.length + " slides (~" + Math.round(slides.length * 20 / 60) + " min)...");

  var clipPaths = [];

  for (var i = 0; i < slides.length; i++) {
    var clipPath = path.join(tmpDir, "clip" + String(i).padStart(3, "0") + ".mp4");
    var bgColor  = bgColors[i % bgColors.length];
    try {
      var ok = buildSlideClip(ffmpegPath, fontFile, slides[i], bgColor, clipPath);
      if (ok) {
        clipPaths.push(clipPath);
      } else {
        console.log("     → Slide " + i + " missing output, skipping");
      }
    } catch(e) {
      console.log("     → Slide " + i + " error: " + e.message.slice(0, 60));
    }
  }

  if (clipPaths.length === 0) {
    return Promise.resolve({ status: "no_clips_built" });
  }

  console.log("     → " + clipPaths.length + " clips built, concatenating...");

  // Write concat list
  var listFile = path.join(tmpDir, "list.txt");
  fs.writeFileSync(listFile, clipPaths.map(function(f) { return "file '" + f.replace(/'/g, "'\\''") + "'"; }).join("\n"));

  var concatPath = path.join(tmpDir, "concat.mp4");
  try {
    exec("\"" + ffmpegPath + "\" -y -f concat -safe 0 -i \"" + listFile + "\" -c copy \"" + concatPath + "\"",
      { stdio: "pipe", timeout: 180000 });
  } catch(e) {
    return Promise.resolve({ status: "concat_error", message: e.message.slice(0, 100) });
  }

  var totalDuration = clipPaths.length * 20;

  // Generate ambient background music
  var musicPath = path.join(process.cwd(), "tmp", "ambient.aac");
  var music     = generateMusic(ffmpegPath, totalDuration + 5, musicPath);

  // Check for ElevenLabs voiceover
  var voiceText = scriptText.slice(0, 2500);
  var voicePath = path.join(tmpDir, "voice.mp3");

  return generateVoiceover(voiceText, voicePath).then(function(voiceFile) {
    var finalPath = outputPath;
    var audioCmd  = null;

    if (voiceFile && music) {
      // Voice + music mix: voice at 100%, music at 8% background
      audioCmd = "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -i \"" + voiceFile + "\" -i \"" + music + "\" " +
        "-filter_complex \"[1:a]volume=1.0,apad[voice];[2:a]volume=0.08[bg];[voice][bg]amix=inputs=2:duration=first[audio]\" " +
        "-map 0:v -map \"[audio]\" -c:v copy -c:a aac -shortest \"" + finalPath + "\"";
      console.log("     → Mixing voice + ambient music...");
    } else if (voiceFile) {
      // Voice only
      audioCmd = "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -i \"" + voiceFile + "\" " +
        "-c:v copy -c:a aac -map 0:v -map 1:a -shortest \"" + finalPath + "\"";
      console.log("     → Adding voiceover...");
    } else if (music) {
      // Music only
      audioCmd = "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -i \"" + music + "\" " +
        "-filter_complex \"[1:a]volume=0.10,aloop=loop=-1:size=2e+09,atrim=duration=" + totalDuration + "[bg]\" " +
        "-map 0:v -map \"[bg]\" -c:v copy -c:a aac -shortest \"" + finalPath + "\"";
      console.log("     → Adding ambient music...");
    } else {
      // Silent — just copy
      audioCmd = "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -c copy \"" + finalPath + "\"";
    }

    try {
      exec(audioCmd, { stdio: "pipe", timeout: 180000 });
    } catch(e) {
      console.log("     → Audio mix error: " + e.message.slice(0, 80) + " — saving silent video");
      try {
        exec("\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -c copy \"" + finalPath + "\"", { stdio: "pipe" });
      } catch(e2) { return { status: "final_copy_error" }; }
    }

    if (!fs.existsSync(finalPath)) return { status: "output_missing" };

    var stats    = fs.statSync(finalPath);
    var sizeMb   = (stats.size / 1024 / 1024).toFixed(1);
    var mins     = Math.round(clipPaths.length * 20 / 60);
    var hasVoice = !!voiceFile;
    var hasMusic = !!music;

    console.log("     ✓ Video: " + sizeMb + "MB, ~" + mins + " min | voice=" + hasVoice + " music=" + hasMusic + " text=true slides=" + clipPaths.length);

    return { status: "built", path: finalPath, size_mb: sizeMb, minutes: mins, slides: clipPaths.length, voice: hasVoice, music: hasMusic };
  });
}

// ── YOUTUBE UPLOAD ────────────────────────────────────────────────────────────

function getAccessToken() {
  var clientId     = config.youtube.client_id;
  var clientSecret = config.youtube.client_secret;
  var refreshToken = config.youtube.refresh_token;
  if (!clientId || !clientSecret || !refreshToken) return Promise.reject(new Error("YouTube credentials not configured"));
  var body = "client_id=" + encodeURIComponent(clientId) +
    "&client_secret=" + encodeURIComponent(clientSecret) +
    "&refresh_token=" + encodeURIComponent(refreshToken) +
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
          "Authorization": "Bearer " + accessToken,
          "Content-Type":  "application/json",
          "X-Upload-Content-Type":   "video/mp4",
          "X-Upload-Content-Length": fileSize,
          "Content-Length": Buffer.byteLength(initBody),
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
              var result = JSON.parse(body);
              if (result.id) {
                console.log("     ✓ Uploaded! https://youtu.be/" + result.id);
                auditLog("YOUTUBE_UPLOADED", { video_id: result.id, title: scriptData.title });
                resolve({ status: "success", video_id: result.id, url: "https://youtu.be/" + result.id });
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

// ── TOPIC / SCRIPT / METADATA ─────────────────────────────────────────────────

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
    return [{ title: "Top 10 AI Tools for " + niche + " in 2025", hook: "Watch to the end...", why_rank: "Evergreen", affiliate: "AI tools" }];
  });
}

function generateScript(topic, niche, product_url) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 2000,
    system: "You are a YouTube scriptwriter for faceless educational channels. Write scripts that are optimized to be turned into slide-based videos.",
    messages: [{ role: "user", content:
      "Write a YouTube video script for: \"" + topic.title + "\"\nNiche: " + niche + "\nProduct (mention once naturally): " + (product_url || "none") + "\n\n" +
      "Structure: HOOK (30 seconds), then 5 numbered sections each starting with ## (e.g. ## 1. Tool Name), each section 2-3 sentences, then CONCLUSION with CTA to subscribe.\n" +
      "Total: 8-10 minutes of spoken content. Use ## to mark each section header clearly."
    }],
  }).then(function(res) { return res.content[0].text; });
}

function generateMetadata(topic, niche) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 600,
    messages: [{ role: "user", content:
      "YouTube SEO metadata for: \"" + topic.title + "\" (niche: " + niche + ")\nReturn ONLY JSON, no markdown:\n" +
      "{\"title\":\"SEO title max 90 chars\",\"description\":\"250 word description with timestamps and subscribe CTA\",\"tags\":[\"tag1\",\"tag2\"],\"category\":\"27\"}"
    }],
  }).then(function(res) {
    var text  = res.content[0].text.trim().replace(/```json/g,"").replace(/```/g,"").trim();
    var start = text.indexOf("{"); var end = text.lastIndexOf("}");
    if (start === -1) throw new Error("no json");
    return JSON.parse(text.slice(start, end + 1));
  }).catch(function() {
    return { title: topic.title, description: topic.hook + "\n\nSubscribe for weekly videos!", tags: [niche, "AI", "tips"], category: "27" };
  });
}

function saveVideoPackage(topic, script, metadata) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  var slug     = topic.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
  var videoDir = path.join(OUT_DIR, slug);
  fs.mkdirSync(videoDir, { recursive: true });
  fs.writeFileSync(path.join(videoDir, "script.txt"),      script);
  fs.writeFileSync(path.join(videoDir, "metadata.json"),   JSON.stringify(metadata, null, 2));
  fs.writeFileSync(path.join(videoDir, "description.txt"), metadata.description || "");
  var logFile = path.join(DATA_DIR, "videos.json");
  var log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
  log.push({ date: new Date().toISOString(), slug: slug, title: topic.title, status: "ready", dir: videoDir });
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
    console.log("     → Script written (" + script.length + " chars)");
    return generateMetadata(topicData, niche);
  }).then(function(metadata) {
    metaData = metadata;
    videoDir = saveVideoPackage(topicData, scriptText, metaData);
    console.log("     ✓ Package saved");
    var videoPath = path.join(videoDir, "video.mp4");
    return buildVideo(metaData.title || topicData.title, scriptText, videoPath);
  }).then(function(videoResult) {
    if (videoResult.status !== "built") {
      console.log("     → Video build status: " + videoResult.status);
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
        console.log("     ✓ Live: " + uploadResult.url);
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
