require("dotenv").config();
const fs    = require("fs");
const path  = require("path");
const https = require("https");
const http  = require("http");
const { execSync } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");
const config    = require("../../config");
const { auditLog } = require("../../security/vault");

const client  = new Anthropic({ apiKey: config.anthropic.api_key });
const OUT_DIR = path.join(process.cwd(), "output", "videos");
const TMP_DIR = path.join(process.cwd(), "output", "tmp");

function ensureDir(d) { fs.mkdirSync(d, { recursive:true }); }

function dl(url, dest) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dest));
    const proto = url.startsWith("https") ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, res => {
      if ([301,302].includes(res.statusCode)) {
        file.close();
        return dl(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(dest); });
    }).on("error", err => { fs.unlink(dest, ()=>{}); reject(err); });
  });
}

function hasFFmpeg() {
  try { execSync("ffmpeg -version", { stdio:"pipe" }); return true; }
  catch { return false; }
}

async function generateVoice(script, tmpDir) {
  if (!config.elevenlabs?.api_key) return null;
  const clean = script
    .replace(/\[PAUSE\]/gi," ... ").replace(/\[B-ROLL[^\]]*\]/gi,"")
    .replace(/\[.*?\]/g,"").replace(/#{1,6}\s/g,"").slice(0,4500).trim();
  const voiceFile = path.join(tmpDir, "voice.mp3");
  const voiceId   = config.elevenlabs.voice_id || "21m00Tcm4TlvDq8ikWAM";
  const body      = JSON.stringify({ text:clean, model_id:"eleven_monolingual_v1", voice_settings:{ stability:0.72, similarity_boost:0.85 } });
  return new Promise((resolve) => {
    const opts = {
      hostname:"api.elevenlabs.io", path:`/v1/text-to-speech/${voiceId}`, method:"POST",
      headers:{ "Accept":"audio/mpeg","Content-Type":"application/json","xi-api-key":config.elevenlabs.api_key,"Content-Length":Buffer.byteLength(body) },
    };
    const req = https.request(opts, res => {
      if (res.statusCode !== 200) return resolve(null);
      const file = fs.createWriteStream(voiceFile);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(voiceFile); });
    });
    req.on("error", () => resolve(null));
    req.write(body); req.end();
  });
}

async function getStockFootage(keywords, count, tmpDir) {
  if (!config.pexels?.api_key) return [];
  const query = keywords.slice(0,3).join(" ");
  return new Promise((resolve) => {
    const opts = {
      hostname:"api.pexels.com",
      path:`/videos/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`,
      headers:{ Authorization: config.pexels.api_key },
    };
    https.get(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", async () => {
        try {
          const clips  = [];
          const videos = JSON.parse(data).videos?.slice(0, count) || [];
          for (let i = 0; i < videos.length; i++) {
            const file = videos[i].video_files?.find(f => f.quality === "sd" || f.quality === "hd");
            if (!file) continue;
            try {
              const dest = path.join(tmpDir, `clip_${i}.mp4`);
              await dl(file.link, dest);
              clips.push(dest);
            } catch {}
          }
          resolve(clips);
        } catch { resolve([]); }
      });
    }).on("error", () => resolve([]));
  });
}

async function extractKeyPoints(script, title) {
  const res = await client.messages.create({
    model: config.anthropic.model, max_tokens:400,
    messages:[{ role:"user", content:`Extract 5 key points from this YouTube script as short text overlays — max 8 words each.\nTitle: "${title}"\nScript: "${script.slice(0,800)}"\nReturn ONLY a JSON array of 5 strings.` }]
  });
  try {
    const clean = res.content[0].text.replace(/```json\n?/g,"").replace(/```/g,"").trim();
    return JSON.parse(clean);
  } catch {
    return ["Key point 1","Key point 2","Key point 3","Key point 4","Key point 5"];
  }
}

async function assembleVideo(voiceFile, clips, keyPoints, title, outputFile, tmpDir) {
  if (!hasFFmpeg()) return null;
  ensureDir(path.dirname(outputFile));

  let duration = 300;
  if (voiceFile) {
    try {
      const probe = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${voiceFile}"`, { encoding:"utf8", stdio:["pipe","pipe","pipe"] });
      duration = parseFloat(probe.trim()) || 300;
    } catch {}
  }

  let cmd;
  const safeTitle = title.replace(/'/g,"").slice(0,45);

  if (clips.length > 0 && voiceFile) {
    const clipList = path.join(tmpDir, "clips.txt");
    const lines    = [];
    let covered    = 0;
    while (covered < duration) {
      for (const clip of clips) {
        if (covered >= duration) break;
        lines.push(`file '${clip}'`);
        covered += 8;
      }
    }
    fs.writeFileSync(clipList, lines.join("\n"));
    const overlays = keyPoints.slice(0,5).map((p,i) => {
      const safe = p.replace(/'/g,"").slice(0,35);
      const start = i * (duration/5) + 5;
      const end   = (i+1) * (duration/5);
      return `drawtext=text='${safe}':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.6:boxborderw=8:enable='between(t,${start},${end})'`;
    }).join(",");
    cmd = `ffmpeg -y -f concat -safe 0 -i "${clipList}" -i "${voiceFile}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,drawtext=text='${safeTitle}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=h-100:box=1:boxcolor=black@0.5:boxborderw=10:enable='between(t,0,4)',${overlays}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -t ${duration} -shortest "${outputFile}"`;
  } else if (voiceFile) {
    cmd = `ffmpeg -y -f lavfi -i "color=c=0x0d1117:s=1920x1080:r=30" -i "${voiceFile}" -vf "drawtext=text='${safeTitle}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -t ${duration} -shortest "${outputFile}"`;
  } else {
    const slideDur = Math.floor(duration / 6);
    const slides   = keyPoints.slice(0,5).map((p,i) => {
      const safe  = p.replace(/'/g,"").slice(0,40);
      const start = (i+1) * slideDur;
      const end   = (i+2) * slideDur;
      return `drawtext=text='${safe}':fontsize=42:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${start},${end})'`;
    }).join(",");
    cmd = `ffmpeg -y -f lavfi -i "color=c=0x0d1117:s=1920x1080:r=24" -vf "drawtext=text='${safeTitle}':fontsize=52:fontcolor=0x00d4aa:x=(w-text_w)/2:y=200:enable='between(t,0,${slideDur})',${slides}" -c:v libx264 -preset fast -crf 23 -an -t ${duration} "${outputFile}"`;
  }

  try {
    execSync(cmd, { stdio:"pipe", timeout: 10*60*1000 });
    return outputFile;
  } catch (err) {
    console.log(`     → FFmpeg error: ${err.message?.slice(0,100)}`);
    return null;
  }
}

async function buildVideo(scriptData) {
  const { title, script, keywords=[], slug } = scriptData;
  const videoId  = slug || title.toLowerCase().replace(/\s+/g,"-").slice(0,30);
  const tmpDir   = path.join(TMP_DIR, videoId);
  const outFile  = path.join(OUT_DIR, `${videoId}.mp4`);

  ensureDir(tmpDir); ensureDir(OUT_DIR);

  if (fs.existsSync(outFile)) {
    console.log(`     → Video exists: ${path.basename(outFile)}`);
    return { path:outFile, title, status:"existing" };
  }

  console.log(`\n  🎬 Building video: "${title}"`);

  const [voiceFile, clips, keyPoints] = await Promise.all([
    generateVoice(script, tmpDir),
    getStockFootage(keywords.slice(0,3), 5, tmpDir),
    extractKeyPoints(script, title),
  ]);

  console.log(`     → Voice:${voiceFile?"✓":"✗(text)"} Clips:${clips.length} Points:${keyPoints.length}`);

  const videoFile = await assembleVideo(voiceFile, clips, keyPoints, title, outFile, tmpDir);
  try { fs.rmSync(tmpDir, { recursive:true, force:true }); } catch {}

  if (videoFile) {
    const sizeMB = (fs.statSync(videoFile).size/1024/1024).toFixed(1);
    console.log(`     → Ready: ${path.basename(videoFile)} (${sizeMB}MB)`);
    auditLog("VIDEO_BUILT", { title, size_mb:sizeMB, has_voice:!!voiceFile, clips:clips.length });
    return { path:videoFile, title, status:"built", size_mb:sizeMB };
  }

  return { path:null, title, status:"script_only" };
}

function getStats() {
  ensureDir(OUT_DIR);
  const videos = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).filter(f => f.endsWith(".mp4")) : [];
  return { videos_built:videos.length, output_dir:OUT_DIR };
}

module.exports = { buildVideo, getStats };
