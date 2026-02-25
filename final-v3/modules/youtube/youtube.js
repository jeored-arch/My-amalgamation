require("dotenv").config();
const https    = require("https");
const http     = require("http");
const fs       = require("fs");
const path     = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const config  = require("../../config");
const { auditLog } = require("../../security/vault");

const client   = new Anthropic({ apiKey: config.anthropic.api_key });
const OUT_DIR  = path.join(process.cwd(), "output", "youtube");
const DATA_DIR = path.join(process.cwd(), "data", "youtube");

// ── FIND FFMPEG ───────────────────────────────────────────────────────────────

function findFfmpeg() {
  try {
    var p = require("ffmpeg-static");
    if (p) { console.log("     → ffmpeg found"); return p; }
  } catch(e) {}
  try {
    var w = require("child_process").execSync("which ffmpeg", { encoding: "utf8" }).trim();
    if (w) return w;
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
      if (res.statusCode !== 200) { file.close(); return reject(new Error("HTTP " + res.statusCode)); }
      res.pipe(file);
      file.on("finish", function() { file.close(); resolve(destPath); });
      file.on("error", reject);
    }).on("error", function(e) { fs.unlink(destPath, function() {}); reject(e); });
  });
}

// ── GET FRESH ACCESS TOKEN ────────────────────────────────────────────────────

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

// ── PEXELS VIDEO SEARCH ───────────────────────────────────────────────────────

function searchPexelsVideos(query) {
  var apiKey = (config.pexels && config.pexels.api_key) || process.env.PEXELS_API_KEY;
  if (!apiKey) return Promise.resolve([]);
  return new Promise(function(resolve) {
    https.get({
      hostname: "api.pexels.com",
      path:     "/videos/search?query=" + encodeURIComponent(query) + "&orientation=landscape&size=medium&per_page=5",
      headers:  { "Authorization": apiKey },
    }, function(res) {
      var data = "";
      res.on("data", function(d) { data += d; });
      res.on("end", function() {
        try {
          var r = JSON.parse(data);
          resolve((r.videos || []).filter(function(v) { return v.duration >= 4 && v.duration <= 30; }));
        } catch(e) { resolve([]); }
      });
    }).on("error", function() { resolve([]); });
  });
}

function getBestVideoUrl(video) {
  var files = (video.video_files || []).filter(function(f) { return f.file_type === "video/mp4"; });
  var hd    = files.filter(function(f) { return f.width >= 1280; });
  if (hd.length > 0) return hd[0].link;
  if (files.length > 0) return files[0].link;
  return null;
}

// ── GENERATE SVG SLIDES (text baked in, no font dependency) ──────────────────

function scriptToSlides(title, scriptText) {
  // Break script into chunks — each chunk = one slide (20 seconds)
  var lines = scriptText.split("\n").map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 10; });

  // Group into ~30 slides of ~3 lines each
  var slides = [];
  var chunkSize = 3;

  // Always add title as first slide
  slides.push({ title: title, lines: [] });

  for (var i = 0; i < lines.length && slides.length < 30; i += chunkSize) {
    var chunk = lines.slice(i, i + chunkSize);
    var headline = chunk[0].replace(/[#*]/g, "").slice(0, 60);
    var body     = chunk.slice(1).map(function(l) { return l.replace(/[#*]/g, "").slice(0, 70); });
    slides.push({ title: headline, lines: body });
  }

  // Pad to at least 30 slides for ~10 min video
  var filler = [
    "Key Insight", "Pro Tip", "Remember This", "Action Step",
    "Quick Summary", "Next Steps", "Final Thoughts", "Subscribe for More"
  ];
  while (slides.length < 30) {
    slides.push({ title: filler[slides.length % filler.length], lines: [] });
  }

  return slides;
}

function makeSvg(slide, bgColor) {
  bgColor = bgColor || "0d1b2a";
  var titleLines = wrapText(slide.title || "", 38);
  var titleY     = 300 - (titleLines.length - 1) * 28;

  var titleSvg = titleLines.map(function(line, i) {
    return '<text x="640" y="' + (titleY + i * 56) + '" font-family="sans-serif" font-size="48" font-weight="bold" fill="white" text-anchor="middle">' + escXml(line) + '</text>';
  }).join("\n");

  var bodySvg = (slide.lines || []).map(function(line, i) {
    return '<text x="640" y="' + (420 + i * 44) + '" font-family="sans-serif" font-size="32" fill="#ccddff" text-anchor="middle">' + escXml(line.slice(0, 70)) + '</text>';
  }).join("\n");

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">\n' +
    '<rect width="1280" height="720" fill="#' + bgColor + '"/>\n' +
    '<rect x="0" y="0" width="1280" height="8" fill="#4488ff"/>\n' +
    titleSvg + "\n" + bodySvg + "\n" +
    '</svg>';
}

function wrapText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  var words = text.split(" ");
  var lines = [];
  var cur   = "";
  for (var i = 0; i < words.length; i++) {
    if ((cur + " " + words[i]).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = words[i];
    } else {
      cur = (cur + " " + words[i]).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function escXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ── BUILD VIDEO ───────────────────────────────────────────────────────────────

function buildVideo(title, scriptText, outputPath) {
  var ffmpegPath = findFfmpeg();
  if (!ffmpegPath) return Promise.resolve({ status: "ffmpeg_unavailable" });

  var tmpDir = path.join(process.cwd(), "tmp", "video_" + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  var slides  = scriptToSlides(title, scriptText);
  var bgColors = ["0d1b2a", "0a1a2a", "1a0d2a", "0a2a1a", "1a1a0a", "0d2a0d"];
  var exec    = require("child_process").execSync;
  var videoFiles = [];

  console.log("     → Building " + slides.length + " slides (~" + Math.round(slides.length * 20 / 60) + " min video)...");

  for (var i = 0; i < slides.length; i++) {
    var svgPath  = path.join(tmpDir, "slide" + i + ".svg");
    var pngPath  = path.join(tmpDir, "slide" + i + ".png");
    var clipPath = path.join(tmpDir, "clip" + i + ".mp4");
    var bgColor  = bgColors[i % bgColors.length];

    // Write SVG
    fs.writeFileSync(svgPath, makeSvg(slides[i], bgColor));

    // Convert SVG to PNG using ffmpeg
    try {
      exec("\"" + ffmpegPath + "\" -y -i \"" + svgPath + "\" \"" + pngPath + "\"", { stdio: "pipe" });
    } catch(e) {
      // If SVG fails, create plain color PNG
      try {
        exec("\"" + ffmpegPath + "\" -y -f lavfi -i color=c=" + bgColor + ":size=1280x720:duration=1 -frames:v 1 \"" + pngPath + "\"", { stdio: "pipe" });
      } catch(e2) { continue; }
    }

    if (!fs.existsSync(pngPath)) continue;

    // PNG → 20-second video clip
    try {
      exec(
        "\"" + ffmpegPath + "\" -y -loop 1 -i \"" + pngPath + "\" -t 20 -vf fps=10 -c:v libx264 -pix_fmt yuv420p -tune stillimage \"" + clipPath + "\"",
        { stdio: "pipe", timeout: 30000 }
      );
      if (fs.existsSync(clipPath)) videoFiles.push(clipPath);
    } catch(e) { /* skip */ }
  }

  if (videoFiles.length === 0) return Promise.resolve({ status: "no_clips" });

  console.log("     → Concatenating " + videoFiles.length + " clips...");

  // Write concat list
  var listFile = path.join(tmpDir, "list.txt");
  fs.writeFileSync(listFile, videoFiles.map(function(f) { return "file '" + f + "'"; }).join("\n"));

  var concatPath = path.join(tmpDir, "concat.mp4");
  try {
    exec("\"" + ffmpegPath + "\" -y -f concat -safe 0 -i \"" + listFile + "\" -c copy \"" + concatPath + "\"", { stdio: "pipe", timeout: 120000 });
  } catch(e) {
    return Promise.resolve({ status: "concat_error", message: e.message.slice(0, 100) });
  }

  // Add background music
  return downloadMusic(tmpDir).then(function(musicPath) {
    var finalPath = outputPath;
    if (musicPath && fs.existsSync(musicPath)) {
      try {
        exec(
          "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -i \"" + musicPath + "\" " +
          "-filter_complex \"[1:a]volume=0.12,aloop=loop=-1:size=2e+09[m];[m]atrim=0=" + (videoFiles.length * 20) + "[music]\" " +
          "-map 0:v -map \"[music]\" -c:v copy -c:a aac -shortest \"" + finalPath + "\"",
          { stdio: "pipe", timeout: 120000 }
        );
        console.log("     → Background music added");
      } catch(e) {
        fs.copyFileSync(concatPath, finalPath);
      }
    } else {
      fs.copyFileSync(concatPath, finalPath);
    }

    if (!fs.existsSync(finalPath)) return { status: "output_missing" };
    var stats = fs.statSync(finalPath);
    var mins  = Math.round(videoFiles.length * 20 / 60);
    console.log("     ✓ Video: " + (stats.size / 1024 / 1024).toFixed(1) + "MB, ~" + mins + " minutes");
    return { status: "built", path: finalPath, size_mb: (stats.size / 1024 / 1024).toFixed(1), minutes: mins };
  });
}

// ── DOWNLOAD BACKGROUND MUSIC ─────────────────────────────────────────────────

function downloadMusic(tmpDir) {
  var musicPath = path.join(process.cwd(), "tmp", "music.mp3");
  if (fs.existsSync(musicPath) && fs.statSync(musicPath).size > 100000) return Promise.resolve(musicPath);
  var musicUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";
  console.log("     → Downloading background music...");
  return downloadFile(musicUrl, musicPath).then(function() { return musicPath; }).catch(function() { return null; });
}

// ── TOPIC / SCRIPT / METADATA ─────────────────────────────────────────────────

function researchTopics(niche) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 1000,
    messages: [{ role: "user", content:
      "Generate 3 YouTube video topics for a faceless channel in the \"" + niche + "\" niche.\n" +
      "Return ONLY a JSON array. No markdown. Example:\n" +
      "[{\"title\":\"Top 10 AI Tools for Small Business in 2025\",\"hook\":\"In the next 8 minutes I will show you...\",\"why_rank\":\"High search volume\",\"affiliate\":\"AI tools with 20-40% commissions\"}]"
    }],
  }).then(function(res) {
    var text  = res.content[0].text.trim();
    var clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
    var start = clean.indexOf("[");
    var end   = clean.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("No JSON array");
    return JSON.parse(clean.slice(start, end + 1));
  }).catch(function() {
    return [{ title: "Top 10 AI Tools for " + niche + " in 2025", hook: "In the next 8 minutes...", why_rank: "Evergreen", affiliate: "AI tools" }];
  });
}

function generateScript(topic, niche, product_url) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 2000,
    system: "You are a YouTube scriptwriter for faceless educational channels.",
    messages: [{ role: "user", content:
      "Write a detailed YouTube script for: " + topic.title + "\nNiche: " + niche + "\nProduct URL: " + (product_url || "") + "\n\n" +
      "Requirements: 8-10 minutes spoken content, strong hook opening, 5 clearly labeled main points (use ## for section headers), mention product once naturally, subscribe CTA at end. Use plain text, no markdown except ## headers."
    }],
  }).then(function(res) { return res.content[0].text; });
}

function generateMetadata(topic, niche) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 800,
    messages: [{ role: "user", content:
      "Generate YouTube metadata for: " + topic.title + " (niche: " + niche + ")\n" +
      "Return ONLY JSON. No markdown:\n" +
      "{\"title\":\"SEO title under 100 chars\",\"description\":\"300 word description with timestamps and subscribe CTA\",\"tags\":[\"tag1\",\"tag2\",\"tag3\"],\"category\":\"27\",\"thumbnail_text\":\"6 word thumbnail text\"}"
    }],
  }).then(function(res) {
    var text  = res.content[0].text.trim().replace(/```json/g, "").replace(/```/g, "").trim();
    var start = text.indexOf("{"); var end = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON");
    return JSON.parse(text.slice(start, end + 1));
  }).catch(function() {
    return { title: topic.title, description: topic.hook + "\n\nSubscribe!", tags: [niche, "AI", "tutorial"], category: "27" };
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

// ── UPLOAD ────────────────────────────────────────────────────────────────────

function uploadVideo(videoFilePath, scriptData) {
  if (!config.youtube.refresh_token) return Promise.resolve({ status: "no_credentials" });
  if (!fs.existsSync(videoFilePath))  return Promise.resolve({ status: "no_video_file" });
  return getAccessToken().then(function(accessToken) {
    var metadata = {
      title:       (scriptData.title || "AI Tools Video").slice(0, 100),
      description: scriptData.description || "Subscribe for weekly videos!\n\n" + (scriptData.product_url || ""),
      tags:        scriptData.tags || ["AI", "tools", "tutorial"],
      categoryId:  "27",
    };
    var initBody = JSON.stringify({
      snippet: { title: metadata.title, description: metadata.description, tags: metadata.tags, categoryId: metadata.categoryId },
      status:  { privacyStatus: "public", selfDeclaredMadeForKids: false },
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
          var body = "";
          upRes.on("data", function(d) { body += d; });
          upRes.on("end", function() {
            try {
              var result = JSON.parse(body);
              if (result.id) {
                console.log("     ✓ Uploaded! https://youtu.be/" + result.id);
                auditLog("YOUTUBE_UPLOADED", { video_id: result.id, title: metadata.title });
                resolve({ status: "success", video_id: result.id, url: "https://youtu.be/" + result.id });
              } else {
                console.log("     → Upload error: " + body.slice(0, 200));
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
    console.log("     → Upload failed: " + err.message);
    return { status: "error", message: err.message };
  });
}

function getGrowthStatus() {
  var logFile = path.join(DATA_DIR, "videos.json");
  var videos  = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
  return {
    videos_created:  videos.length,
    videos_uploaded: videos.filter(function(v) { return v.status === "uploaded"; }).length,
    subs_target: 1000, hours_target: 4000,
    progress_note: videos.length === 0 ? "No videos yet." : videos.length + " videos created.",
  };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

function run(niche, product_url) {
  console.log("\n  📹 YouTube Module running...");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  var topicData, scriptText, metaData, videoDir;

  return researchTopics(niche).then(function(topics) {
    topicData = topics[0];
    console.log("     → Writing script: \"" + topicData.title + "\"");
    return generateScript(topicData, niche, product_url);
  }).then(function(script) {
    scriptText = script;
    console.log("     → Generating SEO metadata...");
    return generateMetadata(topicData, niche);
  }).then(function(metadata) {
    metaData = metadata;
    videoDir = saveVideoPackage(topicData, scriptText, metaData);
    console.log("     ✓ Script saved: " + path.basename(videoDir));
    var videoPath = path.join(videoDir, "video.mp4");
    return buildVideo(metaData.title || topicData.title, scriptText, videoPath);
  }).then(function(videoResult) {
    if (videoResult.status === "built") {
      if (config.youtube.refresh_token) {
        return uploadVideo(path.join(videoDir, "video.mp4"), {
          title: metaData.title || topicData.title, description: metaData.description || "",
          tags: metaData.tags || [], product_url: product_url,
        }).then(function(uploadResult) {
          if (uploadResult.status === "success") {
            console.log("     ✓ Live on YouTube: " + uploadResult.url);
            var logFile = path.join(DATA_DIR, "videos.json");
            var log = JSON.parse(fs.readFileSync(logFile, "utf8"));
            log[log.length - 1].status = "uploaded";
            log[log.length - 1].youtube_url = uploadResult.url;
            fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
          } else {
            console.log("     → Upload status: " + uploadResult.status);
          }
          return { status: "complete", title: topicData.title, dir: videoDir, upload: uploadResult };
        });
      }
    } else {
      console.log("     → Video status: " + videoResult.status + (videoResult.message ? " - " + videoResult.message : ""));
    }
    return { status: "ready", title: topicData.title, dir: videoDir };
  });
}

module.exports = { run: run, researchTopics: researchTopics, generateScript: generateScript, uploadVideo: uploadVideo, getGrowthStatus: getGrowthStatus };
