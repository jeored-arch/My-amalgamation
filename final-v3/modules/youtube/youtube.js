require("dotenv").config();
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
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
    if (p) { console.log("     → ffmpeg-static found: " + p); return p; }
  } catch(e) {}
  try {
    var which = require("child_process").execSync("which ffmpeg", { encoding: "utf8" }).trim();
    if (which) { console.log("     → system ffmpeg found: " + which); return which; }
  } catch(e) {}
  return null;
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
    var options = {
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers: {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(d) { data += d; });
      res.on("end", function() {
        try {
          var r = JSON.parse(data);
          if (r.access_token) {
            console.log("     → YouTube access token obtained");
            resolve(r.access_token);
          } else {
            reject(new Error("Token error: " + JSON.stringify(r)));
          }
        } catch(e) { reject(new Error("Token parse error: " + data.slice(0, 100))); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── TOPIC RESEARCH ────────────────────────────────────────────────────────────

function researchTopics(niche) {
  return client.messages.create({
    model:      config.anthropic.model,
    max_tokens: 1000,
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
      title:     "Top 10 AI Tools for " + niche + " in 2025 (That Actually Work)",
      hook:      "In the next 8 minutes I will show you the exact AI tools helping people in " + niche + " save 10 hours every week.",
      why_rank:  "High search volume, evergreen",
      affiliate: "AI tools with affiliate programs",
    }];
  });
}

// ── SCRIPT GENERATION ─────────────────────────────────────────────────────────

function generateScript(topic, niche, product_url) {
  return client.messages.create({
    model:      config.anthropic.model,
    max_tokens: 2000,
    system:     "You are a YouTube scriptwriter for faceless educational channels.",
    messages: [{ role: "user", content:
      "Write a YouTube script for: " + topic.title + "\n" +
      "Niche: " + niche + "\n" +
      "Product URL: " + (product_url || "") + "\n\n" +
      "Requirements: 8-10 minutes spoken, strong hook, 5 main points, mention product once naturally, subscribe CTA at end."
    }],
  }).then(function(res) { return res.content[0].text; });
}

// ── VIDEO METADATA ────────────────────────────────────────────────────────────

function generateMetadata(topic, niche) {
  return client.messages.create({
    model:      config.anthropic.model,
    max_tokens: 800,
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
      title:          topic.title,
      description:    topic.hook + "\n\nSubscribe for weekly videos!\n\n#" + niche.replace(/\s+/g, "") + " #AI #Tutorial",
      tags:           [niche, "AI", "tutorial", "tips", "2025"],
      category:       "27",
      thumbnail_text: topic.title.split(" ").slice(0, 5).join(" "),
    };
  });
}

// ── SAVE VIDEO PACKAGE ────────────────────────────────────────────────────────

function saveVideoPackage(topic, script, metadata, niche) {
  fs.mkdirSync(OUT_DIR,  { recursive: true });
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

// ── BUILD MP4 VIDEO ───────────────────────────────────────────────────────────

function buildSimpleVideo(scriptData, outputPath) {
  var ffmpegPath = findFfmpeg();
  if (!ffmpegPath) {
    return Promise.resolve({ status: "ffmpeg_unavailable" });
  }

  try {
    var exec   = require("child_process").execSync;
    var title  = scriptData.title || "AI Tools Video";
    var lines  = (scriptData.script || title).split("\n")
      .filter(function(l) { return l.trim().length > 20; })
      .slice(0, 8);
    var slides = lines.length > 0 ? lines : [title];
    var tmpDir = path.join(process.cwd(), "tmp", "video");
    fs.mkdirSync(tmpDir, { recursive: true });

    var imageFiles = [];
    for (var i = 0; i < slides.length; i++) {
      var imgPath = path.join(tmpDir, "slide" + i + ".png");
      var text    = slides[i].replace(/'/g, "").replace(/"/g, "").slice(0, 60);
      try {
        exec(
          "\"" + ffmpegPath + "\" -y -f lavfi -i color=c=0d1b2a:size=1280x720:duration=8 " +
          "-vf \"drawtext=text='" + text + "':fontcolor=white:fontsize=32:x=(w-text_w)/2:y=(h-text_h)/2\" " +
          "-frames:v 1 " + imgPath,
          { stdio: "pipe" }
        );
        imageFiles.push(imgPath);
      } catch(e) { /* skip failed slide */ }
    }

    if (imageFiles.length === 0) {
      return Promise.resolve({ status: "no_slides" });
    }

    var listFile    = path.join(tmpDir, "slides.txt");
    var listContent = imageFiles.map(function(f) {
      return "file '" + f + "'\nduration 8";
    }).join("\n");
    fs.writeFileSync(listFile, listContent);

    exec(
      "\"" + ffmpegPath + "\" -y -f concat -safe 0 -i \"" + listFile + "\" -vf fps=30 -c:v libx264 -pix_fmt yuv420p \"" + outputPath + "\"",
      { stdio: "pipe" }
    );

    var stats = fs.statSync(outputPath);
    return Promise.resolve({ status: "built", path: outputPath, size_mb: (stats.size / 1024 / 1024).toFixed(1) });
  } catch(e) {
    console.log("     → Video build error: " + e.message.slice(0, 100));
    return Promise.resolve({ status: "build_error", message: e.message.slice(0, 100) });
  }
}

// ── UPLOAD TO YOUTUBE ─────────────────────────────────────────────────────────

function uploadVideo(videoFilePath, scriptData) {
  if (!config.youtube.refresh_token) {
    return Promise.resolve({ status: "no_credentials" });
  }
  if (!fs.existsSync(videoFilePath)) {
    return Promise.resolve({ status: "no_video_file" });
  }

  return getAccessToken().then(function(accessToken) {
    var metadata = {
      title:       (scriptData.title || "AI Tools Video").slice(0, 100),
      description: scriptData.description || "Subscribe for weekly AI tools videos!\n\n" + (scriptData.product_url || ""),
      tags:        scriptData.tags || ["AI", "tools", "tutorial"],
      categoryId:  "27",
    };

    var initBody = JSON.stringify({
      snippet: {
        title:       metadata.title,
        description: metadata.description,
        tags:        metadata.tags,
        categoryId:  metadata.categoryId,
      },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    });

    var fileSize = fs.statSync(videoFilePath).size;

    return new Promise(function(resolve) {
      var initOptions = {
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
      };

      var initReq = https.request(initOptions, function(res) {
        var uploadUrl = res.headers.location;
        if (!uploadUrl) {
          console.log("     → No upload URL from YouTube");
          return resolve({ status: "error", message: "No upload URL" });
        }

        console.log("     → Upload URL obtained, uploading video...");
        var videoData = fs.readFileSync(videoFilePath);
        var urlObj    = new URL(uploadUrl);

        var upOptions = {
          hostname: urlObj.hostname,
          path:     urlObj.pathname + urlObj.search,
          method:   "PUT",
          headers: {
            "Content-Type":   "video/mp4",
            "Content-Length": fileSize,
          },
        };

        var upReq = https.request(upOptions, function(upRes) {
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
            } catch(e) {
              resolve({ status: "parse_error", body: body.slice(0, 200) });
            }
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
    console.log("     → YouTube upload failed: " + err.message);
    return { status: "error", message: err.message };
  });
}

// ── GROWTH TRACKER ────────────────────────────────────────────────────────────

function getGrowthStatus() {
  var logFile = path.join(DATA_DIR, "videos.json");
  var videos  = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
  return {
    videos_created:  videos.length,
    videos_uploaded: videos.filter(function(v) { return v.status === "uploaded"; }).length,
    subs_target:     1000,
    hours_target:    4000,
    progress_note:   videos.length === 0 ? "No videos yet." : videos.length + " videos created.",
  };
}

// ── MAIN RUN FUNCTION ─────────────────────────────────────────────────────────

function run(niche, product_url) {
  console.log("\n  📹 YouTube Module running...");
  fs.mkdirSync(OUT_DIR,  { recursive: true });
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
    videoDir = saveVideoPackage(topicData, scriptText, metaData, niche);
    console.log("     ✓ Video package saved: " + path.basename(videoDir));

    var videoPath = path.join(videoDir, "video.mp4");
    return buildSimpleVideo({ title: topicData.title, script: scriptText }, videoPath);
  }).then(function(videoResult) {
    if (videoResult.status === "built") {
      console.log("     ✓ Video built: " + videoResult.size_mb + "MB");

      if (config.youtube.refresh_token) {
        console.log("     → Uploading to YouTube...");
        return uploadVideo(path.join(videoDir, "video.mp4"), {
          title:       metaData.title || topicData.title,
          description: metaData.description || "",
          tags:        metaData.tags || [],
          product_url: product_url,
        }).then(function(uploadResult) {
          if (uploadResult.status === "success") {
            console.log("     ✓ Live on YouTube: " + uploadResult.url);
            var logFile = path.join(DATA_DIR, "videos.json");
            var log = JSON.parse(fs.readFileSync(logFile, "utf8"));
            log[log.length - 1].status      = "uploaded";
            log[log.length - 1].youtube_url = uploadResult.url;
            fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
          } else {
            console.log("     → Upload status: " + uploadResult.status);
          }
          return { status: "complete", title: topicData.title, dir: videoDir, upload: uploadResult };
        });
      }
    } else {
      console.log("     → Video build status: " + videoResult.status + " (script saved)");
    }

    return { status: "ready", title: topicData.title, dir: videoDir };
  });
}

module.exports = { run: run, researchTopics: researchTopics, generateScript: generateScript, uploadVideo: uploadVideo, getGrowthStatus: getGrowthStatus };
