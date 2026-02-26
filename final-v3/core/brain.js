/**
 * brain.js — Autonomous Business Intelligence
 * 
 * The agent's memory, learning, and strategy system.
 * Grows smarter every single day by tracking what works and what doesn't.
 * 
 * Data stored in data/brain.json — persists across Railway restarts.
 */

const fs   = require("fs");
const path = require("path");

const BRAIN_FILE = path.join(process.cwd(), "data", "brain.json");

// ── DEFAULT BRAIN STATE ───────────────────────────────────────────────────────

function defaultBrain() {
  return {
    version: 1,
    created: new Date().toISOString(),
    last_updated: new Date().toISOString(),

    // Business performance tracking
    performance: {
      total_videos: 0,
      total_views: 0,
      total_sales: 0,
      total_revenue: 0,
      best_video: null,         // { title, views, url, angle, niche }
      best_niche: null,
      best_angle: null,
    },

    // Per-video records for learning
    videos: [],
    // Each: { date, title, niche, angle, theme, url, views: 0, sales_attributed: 0 }

    // Angle performance (mistakes/secrets/tools/warning/how-to)
    angle_stats: {
      mistakes: { videos: 0, total_views: 0, avg_views: 0 },
      secrets:  { videos: 0, total_views: 0, avg_views: 0 },
      tools:    { videos: 0, total_views: 0, avg_views: 0 },
      warning:  { videos: 0, total_views: 0, avg_views: 0 },
      "how-to": { videos: 0, total_views: 0, avg_views: 0 },
      truth:    { videos: 0, total_views: 0, avg_views: 0 },
      general:  { videos: 0, total_views: 0, avg_views: 0 },
    },

    // Niche performance
    niche_stats: {},
    // Each: { videos: 0, total_views: 0, avg_views: 0, sales: 0 }

    // Strategy decisions
    strategy: {
      current_focus_angle: null,     // angle to double down on
      avoid_angles: [],              // angles that flopped
      pivot_history: [],             // niche switches with reasons
      last_strategy_update: null,
      days_since_sale: 0,
      consecutive_low_views: 0,      // triggers niche pivot
    },

    // Knowledge bank — what the agent has learned
    knowledge: {
      top_performing_hooks: [],      // hooks that got high views
      failed_topics: [],             // titles that flopped (< 50 views after 7 days)
      seasonal_notes: [],            // e.g. "tax topics spike in March"
      competitor_gaps: [],           // underserved topics discovered
    },

    // Daily logs
    daily_logs: [],
    // Each: { date, day_number, niche, video_title, angle, sales, notes }
  };
}

// ── LOAD / SAVE ───────────────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(BRAIN_FILE)) {
      const data = JSON.parse(fs.readFileSync(BRAIN_FILE, "utf8"));
      // Merge with defaults to handle new fields added in updates
      return deepMerge(defaultBrain(), data);
    }
  } catch(e) {
    console.log("     → Brain load error: " + e.message.slice(0,60) + " — starting fresh");
  }
  return defaultBrain();
}

function save(brain) {
  try {
    fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
    brain.last_updated = new Date().toISOString();
    fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
  } catch(e) {
    console.log("     → Brain save error: " + e.message.slice(0,60));
  }
}

function deepMerge(target, source) {
  const out = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// ── RECORD VIDEO ─────────────────────────────────────────────────────────────

function recordVideo({ title, niche, angle, theme, url }) {
  const brain = load();

  const entry = {
    date:             new Date().toISOString(),
    title,
    niche,
    angle:            angle || "general",
    theme,
    url:              url || null,
    views:            0,
    views_checked_at: null,
    sales_attributed: 0,
  };

  brain.videos.push(entry);
  brain.performance.total_videos++;

  // Update angle stats
  if (!brain.angle_stats[entry.angle]) {
    brain.angle_stats[entry.angle] = { videos: 0, total_views: 0, avg_views: 0 };
  }
  brain.angle_stats[entry.angle].videos++;

  // Update niche stats
  if (!brain.niche_stats[niche]) {
    brain.niche_stats[niche] = { videos: 0, total_views: 0, avg_views: 0, sales: 0 };
  }
  brain.niche_stats[niche].videos++;

  save(brain);
  return entry;
}

// ── RECORD SALE ───────────────────────────────────────────────────────────────

function recordSale(amount, niche) {
  const brain = load();
  brain.performance.total_sales++;
  brain.performance.total_revenue += amount;
  brain.strategy.days_since_sale = 0;

  if (niche && brain.niche_stats[niche]) {
    brain.niche_stats[niche].sales++;
    brain.performance.best_niche = niche;
  }

  save(brain);
}

// ── LOG DAILY ACTIVITY ────────────────────────────────────────────────────────

function logDay({ day_number, niche, video_title, angle, sales, revenue, notes }) {
  const brain = load();

  brain.daily_logs.push({
    date: new Date().toISOString(),
    day_number,
    niche,
    video_title,
    angle,
    sales:   sales   || 0,
    revenue: revenue || 0,
    notes:   notes   || "",
  });

  // Track days since sale
  if (sales > 0) {
    brain.strategy.days_since_sale = 0;
  } else {
    brain.strategy.days_since_sale++;
  }

  // Keep last 90 days only
  if (brain.daily_logs.length > 90) {
    brain.daily_logs = brain.daily_logs.slice(-90);
  }

  save(brain);
}

// ── ANALYZE AND UPDATE STRATEGY ───────────────────────────────────────────────
// Called every 7 days — looks at performance and decides what to change

function analyzeAndUpdateStrategy() {
  const brain = load();
  const decisions = [];

  // Need at least 3 videos to analyze
  if (brain.performance.total_videos < 3) {
    return { decisions: ["Not enough data yet — need 3+ videos"], brain };
  }

  // ── Find best performing angle ──────────────────────────────────────────
  let bestAngle = null;
  let bestAngleAvg = 0;
  let worstAngle = null;
  let worstAngleAvg = Infinity;

  for (const [angle, stats] of Object.entries(brain.angle_stats)) {
    if (stats.videos >= 2) {
      const avg = stats.total_views / stats.videos;
      if (avg > bestAngleAvg) { bestAngleAvg = avg; bestAngle = angle; }
      if (avg < worstAngleAvg) { worstAngleAvg = avg; worstAngle = angle; }
    }
  }

  if (bestAngle && bestAngleAvg > 0) {
    brain.strategy.current_focus_angle = bestAngle;
    brain.performance.best_angle = bestAngle;
    decisions.push(`Best angle: "${bestAngle}" (avg ${Math.round(bestAngleAvg)} views) — doubling down`);
  }

  if (worstAngle && worstAngleAvg < 30 && worstAngle !== bestAngle) {
    if (!brain.strategy.avoid_angles.includes(worstAngle)) {
      brain.strategy.avoid_angles.push(worstAngle);
      decisions.push(`Avoiding "${worstAngle}" angle — avg only ${Math.round(worstAngleAvg)} views`);
    }
  }

  // ── Check if niche pivot needed ─────────────────────────────────────────
  const recentLogs = brain.daily_logs.slice(-14);
  const recentViews = brain.videos.slice(-7).reduce((sum, v) => sum + (v.views || 0), 0);
  const avgRecentViews = brain.videos.length > 0 ? recentViews / Math.min(7, brain.videos.length) : 0;

  if (avgRecentViews < 20 && brain.performance.total_videos >= 7) {
    brain.strategy.consecutive_low_views++;
    decisions.push(`Warning: avg ${Math.round(avgRecentViews)} views/video over last 7 — low traction`);
    if (brain.strategy.consecutive_low_views >= 2) {
      decisions.push("PIVOT RECOMMENDED: 14 days of low views — niche may need to change");
    }
  } else {
    brain.strategy.consecutive_low_views = 0;
  }

  // ── Best video tracking ─────────────────────────────────────────────────
  const topVideo = brain.videos.reduce((best, v) => (!best || v.views > best.views) ? v : best, null);
  if (topVideo) {
    brain.performance.best_video = topVideo;
    if (topVideo.views > 100) {
      decisions.push(`Top video: "${topVideo.title.slice(0,50)}" — ${topVideo.views} views`);
    }
  }

  brain.strategy.last_strategy_update = new Date().toISOString();
  save(brain);

  return { decisions, brain };
}

// ── GET STRATEGY BRIEF FOR AI ──────────────────────────────────────────────
// Returns a short prompt addition telling the AI what's working

function getStrategyBrief() {
  const brain = load();

  if (brain.performance.total_videos < 3) {
    return ""; // Not enough data — let AI choose freely
  }

  let brief = "\n\nBUSINESS INTELLIGENCE (use this to make better decisions):\n";

  if (brain.strategy.current_focus_angle) {
    brief += `- Best performing angle: "${brain.strategy.current_focus_angle}" — use this angle today\n`;
  }

  if (brain.strategy.avoid_angles.length > 0) {
    brief += `- Avoid these underperforming angles: ${brain.strategy.avoid_angles.join(", ")}\n`;
  }

  if (brain.performance.best_video) {
    brief += `- Best video so far: "${brain.performance.best_video.title.slice(0,60)}" (${brain.performance.best_video.views} views)\n`;
  }

  if (brain.strategy.days_since_sale > 7) {
    brief += `- No sales in ${brain.strategy.days_since_sale} days — prioritize high-converting topics today\n`;
  }

  if (brain.knowledge.failed_topics.length > 0) {
    brief += `- Avoid these failed topics: ${brain.knowledge.failed_topics.slice(-5).join(", ")}\n`;
  }

  return brief;
}

// ── GET MORNING BRIEF ────────────────────────────────────────────────────────
// Returns formatted text for Telegram morning message

function getMorningBrief(dayNumber, niche) {
  const brain = load();
  const stats = brain.performance;

  let msg = `🧠 Day ${dayNumber} Strategy Brief\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📺 Niche: ${niche}\n`;
  msg += `🎬 Videos made: ${stats.total_videos}\n`;
  msg += `💰 Total revenue: $${stats.total_revenue.toFixed(2)}\n`;
  msg += `📊 Total sales: ${stats.total_sales}\n`;

  if (stats.best_video && stats.best_video.views > 0) {
    msg += `\n⭐ Best video: ${stats.best_video.views} views\n"${stats.best_video.title?.slice(0,45)}..."\n`;
  }

  if (brain.strategy.current_focus_angle) {
    msg += `\n🎯 Today's angle: ${brain.strategy.current_focus_angle.toUpperCase()}\n`;
    msg += `(Best performing — ${brain.angle_stats[brain.strategy.current_focus_angle]?.avg_views || 0} avg views)\n`;
  }

  if (brain.strategy.days_since_sale > 3) {
    msg += `\n⚠️ ${brain.strategy.days_since_sale} days since last sale — focusing on conversion today\n`;
  }

  const recentLogs = brain.daily_logs.slice(-3);
  if (recentLogs.length > 0) {
    msg += `\n📈 Last 3 days:\n`;
    for (const log of recentLogs) {
      msg += `  Day ${log.day_number}: ${log.sales} sale(s) — "${log.video_title?.slice(0,35)}"\n`;
    }
  }

  return msg;
}

// ── GET FULL REPORT ───────────────────────────────────────────────────────────

function getReport() {
  const brain = load();
  return {
    total_videos:  brain.performance.total_videos,
    total_revenue: brain.performance.total_revenue,
    total_sales:   brain.performance.total_sales,
    best_angle:    brain.performance.best_angle,
    best_video:    brain.performance.best_video,
    days_since_sale: brain.strategy.days_since_sale,
    focus_angle:   brain.strategy.current_focus_angle,
    avoid_angles:  brain.strategy.avoid_angles,
    pivot_needed:  brain.strategy.consecutive_low_views >= 2,
  };
}

// ── UPDATE VIDEO VIEWS ─────────────────────────────────────────────────────
// Called periodically to check YouTube analytics and update view counts

function updateVideoViews(videoId, views) {
  const brain = load();
  const video = brain.videos.find(function(v) {
    return v.url && v.url.includes(videoId);
  });
  if (!video) return;

  video.views = views;
  video.views_checked_at = new Date().toISOString();

  // Update angle averages
  const angle = video.angle || "general";
  if (brain.angle_stats[angle]) {
    const angleVids = brain.videos.filter(function(v) { return v.angle === angle; });
    brain.angle_stats[angle].total_views = angleVids.reduce(function(s, v) { return s + (v.views || 0); }, 0);
    brain.angle_stats[angle].avg_views   = Math.round(brain.angle_stats[angle].total_views / angleVids.length);
  }

  // Update niche averages
  const nicheVids = brain.videos.filter(function(v) { return v.niche === video.niche; });
  if (brain.niche_stats[video.niche]) {
    brain.niche_stats[video.niche].total_views = nicheVids.reduce(function(s, v) { return s + (v.views || 0); }, 0);
    brain.niche_stats[video.niche].avg_views   = Math.round(brain.niche_stats[video.niche].total_views / nicheVids.length);
  }

  // Mark as failed topic if < 50 views after 7 days
  const ageMs  = Date.now() - new Date(video.date).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > 7 && views < 50) {
    if (!brain.knowledge.failed_topics.includes(video.title)) {
      brain.knowledge.failed_topics.push(video.title);
      if (brain.knowledge.failed_topics.length > 20) {
        brain.knowledge.failed_topics = brain.knowledge.failed_topics.slice(-20);
      }
    }
  }

  // Track best video
  const best = brain.videos.reduce(function(b, v) { return (!b || v.views > b.views) ? v : b; }, null);
  brain.performance.best_video  = best;
  brain.performance.total_views = brain.videos.reduce(function(s, v) { return s + (v.views || 0); }, 0);

  save(brain);
}

module.exports = {
  load,
  save,
  recordVideo,
  recordSale,
  logDay,
  analyzeAndUpdateStrategy,
  getStrategyBrief,
  getMorningBrief,
  getReport,
  updateVideoViews,
};
