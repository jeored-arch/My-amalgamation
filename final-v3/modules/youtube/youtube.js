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

// ── DOWNLOAD FILE (with redirect support) ────────────────────────────────────

function downloadFile(url, destPath, redirectCount) {
  redirectCount = redirectCount || 0;
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise(function(resolve, reject) {
    var proto = url.startsWith("https") ? https : http;
    var file  = fs.createWriteStream(destPath);
    proto.get(url, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
        file.close();
        fs.unlink(destPath, function() {});
        return downloadFile(res.headers.location, destPath, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error("HTTP " + res.statusCode));
      }
      res.pipe(file);
      file.on("finish", function() { file.close(); resolve(destPath); });
      file.on("error", reject);
    }).on("error", function(e) {
      fs.unlink(destPath, function() {});
      reject(e);
    });
  });
}

// ── GET FRESH ACCESS TOKEN ────────────────────────────────────────────────────

function getAccessToken() {
  var clientId     = config.youtube.client_id;
  var clientSecret = config.youtube.client_secret;
  var refreshToken = config.youtube.refresh_token;
  if (!clientId || !clientSecret || !refreshToken) {
    return Promise.reject(new Error("YouTube credentials not configured"));
  }
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
  var searchQuery = encodeURIComponent(query.slice(0, 40));
  return new Promise(function(resolve) {
    https.get({
      hostname: "api.pexels.com",
      path:     "/videos/search?query=" + searchQuery + "&orientation=landscape&size=medium&per_page=6",
      headers:  { "Authorization": apiKey },
    }, function(res) {
      var data = "";
      res.on("data", function(d) { data += d; });
      res.on("end", function() {
        try {
          var r = JSON.parse(data);
          var videos = (r.videos || []).filter(function(v) {
            return v.duration >= 4 && v.duration <= 30;
          });
          resolve(videos);
        } catch(e) { resolve([]); }
      });
    }).on("error", function() { resolve([]); });
  });
}

function getBestVideoUrl(video) {
  var files = (video.video_files || []).filter(function(f) { return f.file_type === "video/mp4"; });
  var hd    = files.filter(function(f) { return f.width >= 1280 && f.quality === "hd"; });
  if (hd.length > 0) return hd[0].link;
  var sd = files.filter(function(f) { return f.width >= 640; });
  if (sd.length > 0) return sd[0].link;
  if (files.length > 0) return files[0].link;
  return null;
}

// ── DOWNLOAD ROYALTY-FREE MUSIC ───────────────────────────────────────────────
// Uses a public domain / CC0 music track from the web

function downloadMusic(tmpDir) {
  // Free motivational background music (CC0 / public domain)
  var musicUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";
  var musicPath = path.join(tmpDir, "background.mp3");
  if (fs.existsSync(musicPath)) return Promise.resolve(musicPath);
  console.log("     → Downloading background music...");
  return downloadFile(musicUrl, musicPath).then(function() {
    return musicPath;
  }).catch(function() {
    return null; // music is optional — video works without it
  });
}

// ── BUILD VIDEO WITH PEXELS + TEXT + MUSIC ───────────────────────────────────

function buildPexelsVideo(niche, title, outputPath) {
  var ffmpegPath = findFfmpeg();
  if (!ffmpegPath) return Promise.resolve({ status: "ffmpeg_unavailable" });

  var tmpDir = path.join(process.cwd(), "tmp", "video");
  fs.mkdirSync(tmpDir, { recursive: true });

  // Generate search terms from niche
  var words      = niche.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ");
  var searchTerm = words.slice(0, 3).join(" ");
  var fallbacks  = ["business technology", "people working", "office success"];

  console.log("     → Searching Pexels: \"" + searchTerm + "\"");

  var musicPath = null;

  return downloadMusic(tmpDir).then(function(mp3) {
    musicPath = mp3;
    return searchPexelsVideos(searchTerm);
  }).then(function(videos) {
    if (videos.length === 0) return searchPexelsVideos(fallbacks[0]);
    return videos;
  }).then(function(videos) {
    if (videos.length === 0) return searchPexelsVideos(fallbacks[1]);
    return videos;
  }).then(function(videos) {
    if (videos.length === 0) {
      console.log("     → No Pexels videos, using color slides");
      return buildColorSlides(ffmpegPath, tmpDir, title, outputPath, musicPath);
    }

    console.log("     → Downloading " + Math.min(videos.length, 4) + " clips...");
    var clips    = videos.slice(0, 4);
    var promises = clips.map(function(video, i) {
      var url      = getBestVideoUrl(video);
      var clipPath = path.join(tmpDir, "clip" + i + ".mp4");
      if (!url) return Promise.resolve(null);
      return downloadFile(url, clipPath)
        .then(function() { return clipPath; })
        .catch(function() { return null; });
    });

    return Promise.all(promises).then(function(clipPaths) {
      var valid = clipPaths.filter(function(p) { return p && fs.existsSync(p); });
      if (valid.length === 0) {
        console.log("     → Clip downloads failed, using color slides");
        return buildColorSlides(ffmpegPath, tmpDir, title, outputPath, musicPath);
      }

      console.log("     → Building video with " + valid.length + " clips...");
      return combineClipsWithTextAndMusic(ffmpegPath, valid, title, outputPath, musicPath);
    });
  }).catch(function(e) {
    console.log("     → Build error: " + e.message.slice(0, 100));
    return buildColorSlides(ffmpegPath, tmpDir, title, outputPath, musicPath);
  });
}

// ── COMBINE CLIPS + TEXT OVERLAY + MUSIC ─────────────────────────────────────

function combineClipsWithTextAndMusic(ffmpegPath, clipPaths, title, outputPath, musicPath) {
  try {
    var exec = require("child_process").execSync;

    // Step 1: Normalize each clip to 1280x720 mp4
    var normalizedPaths = [];
    for (var i = 0; i < clipPaths.length; i++) {
      var normPath = clipPaths[i].replace(".mp4", "_norm.mp4");
      try {
        exec(
          "\"" + ffmpegPath + "\" -y -i \"" + clipPaths[i] + "\" " +
          "-vf \"scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1\" " +
          "-c:v libx264 -pix_fmt yuv420p -r 30 -an -t 10 \"" + normPath + "\"",
          { stdio: "pipe", timeout: 60000 }
        );
        if (fs.existsSync(normPath)) normalizedPaths.push(normPath);
      } catch(e) { /* skip this clip */ }
    }

    if (normalizedPaths.length === 0) {
      return Promise.resolve({ status: "normalize_failed" });
    }

    // Step 2: Concat normalized clips
    var tmpDir   = path.dirname(clipPaths[0]);
    var listFile = path.join(tmpDir, "concat.txt");
    fs.writeFileSync(listFile, normalizedPaths.map(function(f) { return "file '" + f + "'"; }).join("\n"));

    var concatPath = path.join(tmpDir, "concat.mp4");
    exec(
      "\"" + ffmpegPath + "\" -y -f concat -safe 0 -i \"" + listFile + "\" -c copy \"" + concatPath + "\"",
      { stdio: "pipe", timeout: 60000 }
    );

    // Step 3: Add text overlay (title at bottom, semi-transparent bar)
    var safeTitle  = title.replace(/'/g, "").replace(/"/g, "").replace(/:/g, " ").slice(0, 55);
    var withTextPath = path.join(tmpDir, "with_text.mp4");

    // Check if drawtext works on this ffmpeg build
    var drawtextWorks = false;
    try {
      exec("\"" + ffmpegPath + "\" -y -f lavfi -i color=black:size=100x100:duration=1 -vf drawtext=text='test':fontsize=12 -frames:v 1 " + path.join(tmpDir, "test.png"), { stdio: "pipe" });
      drawtextWorks = true;
    } catch(e) { /* drawtext not available */ }

    if (drawtextWorks) {
      try {
        exec(
          "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" " +
          "-vf \"drawbox=y=ih-80:color=black@0.6:width=iw:height=80:t=fill," +
          "drawtext=text='" + safeTitle + "':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=h-60\" " +
          "-c:v libx264 -pix_fmt yuv420p -an \"" + withTextPath + "\"",
          { stdio: "pipe", timeout: 60000 }
        );
      } catch(e) {
        withTextPath = concatPath; // fall back to no text
      }
    } else {
      withTextPath = concatPath;
    }

    // Step 4: Add music if available
    var finalPath = outputPath;
    if (musicPath && fs.existsSync(musicPath)) {
      try {
        exec(
          "\"" + ffmpegPath + "\" -y -i \"" + withTextPath + "\" -i \"" + musicPath + "\" " +
          "-filter_complex \"[1:a]volume=0.15,aloop=loop=-1:size=2e+09[music];[music]atrim=0=" + (normalizedPaths.length * 10) + "[trimmed]\" " +
          "-map 0:v -map \"[trimmed]\" -c:v copy -c:a aac -shortest \"" + finalPath + "\"",
          { stdio: "pipe", timeout: 120000 }
        );
        console.log("     → Music added to video");
      } catch(e) {
        // Music failed — just copy video without audio
        exec("\"" + ffmpegPath + "\" -y -i \"" + withTextPath + "\" -c copy \"" + finalPath + "\"", { stdio: "pipe" });
      }
    } else {
      exec("\"" + ffmpegPath + "\" -y -i \"" + withTextPath + "\" -c copy \"" + finalPath + "\"", { stdio: "pipe" });
    }

    if (!fs.existsSync(finalPath)) return Promise.resolve({ status: "output_missing" });
    var stats = fs.statSync(finalPath);
    return Promise.resolve({ status: "built", path: finalPath, size_mb: (stats.size / 1024 / 1024).toFixed(1), source: "pexels" });

  } catch(e) {
    console.log("     → Combine error: " + e.message.slice(0, 150));
    return Promise.resolve({ status: "build_error", message: e.message.slice(0, 100) });
  }
}

// ── FALLBACK: COLOR SLIDES WITH TEXT ─────────────────────────────────────────

function buildColorSlides(ffmpegPath, tmpDir, title, outputPath, musicPath) {
  try {
    var exec   = require("child_process").execSync;
    var colors = ["0d1b2a", "1a2a3a", "0a2a1a", "2a1a0a", "1a0a2a", "0a1a2a"];
    var images = [];
    for (var i = 0; i < colors.length; i++) {
      var imgPath = path.join(tmpDir, "cslide" + i + ".png");
      try {
        exec("\"" + ffmpegPath + "\" -y -f lavfi -i color=c=" + colors[i] + ":size=1280x720:duration=1 -frames:v 1 " + imgPath, { stdio: "pipe" });
        images.push(imgPath);
      } catch(e) {}
    }
    if (images.length === 0) return Promise.resolve({ status: "no_slides" });
    var listFile = path.join(tmpDir, "cslides.txt");
    fs.writeFileSync(listFile, images.map(function(f) { return "file '" + f + "'\nduration 8"; }).join("\n"));
    var concatPath = path.join(tmpDir, "cconcat.mp4");
    exec("\"" + ffmpegPath + "\" -y -f concat -safe 0 -i \"" + listFile + "\" -vf fps=30 -c:v libx264 -pix_fmt yuv420p -an \"" + concatPath + "\"", { stdio: "pipe" });

    // Add music if available
    if (musicPath && fs.existsSync(musicPath)) {
      try {
        exec(
          "\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -i \"" + musicPath + "\" " +
          "-filter_complex \"[1:a]volume=0.15[music]\" -map 0:v -map \"[music]\" -c:v copy -c:a aac -shortest \"" + outputPath + "\"",
          { stdio: "pipe" }
        );
      } catch(e) {
        exec("\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -c copy \"" + outputPath + "\"", { stdio: "pipe" });
      }
    } else {
      exec("\"" + ffmpegPath + "\" -y -i \"" + concatPath + "\" -c copy \"" + outputPath + "\"", { stdio: "pipe" });
    }

    var stats = fs.statSync(outputPath);
    return Promise.resolve({ status: "built", path: outputPath, size_mb: (stats.size / 1024 / 1024).toFixed(1), source: "color_slides" });
  } catch(e) {
    return Promise.resolve({ status: "build_error", message: e.message.slice(0, 100) });
  }
}

// ── TOPIC RESEARCH ────────────────────────────────────────────────────────────

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
    if (start === -1 || end === -1) throw new Error("No JSON array found");
    return JSON.parse(clean.slice(start, end + 1));
  }).catch(function() {
    return [{
      title:    "Top 10 AI Tools for " + niche + " in 2025 (That Actually Work)",
      hook:     "In the next 8 minutes I will show you the exact AI tools helping people in " + niche + " save 10 hours every week.",
      why_rank: "High search volume, evergreen", affiliate: "AI tools with affiliate programs",
    }];
  });
}

function generateScript(topic, niche, product_url) {
  return client.messages.create({
    model: config.anthropic.model, max_tokens: 2000,
    system: "You are a YouTube scriptwriter for faceless educational channels.",
    messages: [{ role: "user", content:
      "Write a YouTube script for: " + topic.title + "\nNiche: " + niche + "\nProduct URL: " + (product_url || "") + "\n\n" +
      "Requirements: 8-10 minutes spoken, strong hook, 5 main points, mention product once naturally, subscribe CTA at end."
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
    var text  = res.content[0].text.trim();
    var clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
    var start = clean.indexOf("{");
    var end   = clean.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON found");
    return JSON.parse(clean.slice(start, end + 1));
  }).catch(function() {
    return {
      title: topic.title,
      description: topic.hook + "\n\nSubscribe for weekly videos!\n\n#" + niche.replace(/\s+/g, "") + " #AI #Tutorial",
      tags: [niche, "AI", "tutorial", "tips", "2025"], category: "27",
      thumbnail_text: topic.title.split(" ").slice(0, 5).join(" "),
    };
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
        if (!uploadUrl) { console.log("     → No upload URL"); return resolve({ status: "error", message: "No upload URL" }); }
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
                console.log("     → Upload response: " + body.slice(0, 200));
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
    console.log("     ✓ Video package saved: " + path.basename(videoDir));
    var videoPath = path.join(videoDir, "video.mp4");
    return buildPexelsVideo(niche, metaData.title || topicData.title, videoPath);
  }).then(function(videoResult) {
    if (videoResult.status === "built") {
      console.log("     ✓ Video built: " + videoResult.size_mb + "MB (" + (videoResult.source || "pexels") + ")");
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
      console.log("     → Video status: " + videoResult.status);
    }
    return { status: "ready", title: topicData.title, dir: videoDir };
  });
}

module.exports = { run: run, researchTopics: researchTopics, generateScript: generateScript, uploadVideo: uploadVideo, getGrowthStatus: getGrowthStatus };
