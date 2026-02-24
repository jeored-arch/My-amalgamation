require("dotenv").config();

module.exports = {
  owner: {
    name:     process.env.OWNER_NAME          || "Agent Owner",
    email:    process.env.OWNER_EMAIL         || "",
    timezone: process.env.TZ                  || "America/Chicago",
    password: process.env.DASHBOARD_PASSWORD  || "changeme",
  },
  anthropic: {
    api_key: process.env.ANTHROPIC_API_KEY || "",
    model:   "claude-opus-4-5",
  },
  elevenlabs: {
    api_key:  process.env.ELEVENLABS_API_KEY  || "",
    voice_id: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
  },
  pexels: {
    api_key: process.env.PEXELS_API_KEY || "",
  },
  resend: {
    api_key:   process.env.RESEND_API_KEY   || "",
    from:      process.env.EMAIL_FROM       || "onboarding@resend.dev",
    from_name: process.env.EMAIL_FROM_NAME  || "My Business",
  },
  gumroad: {
    api_key: process.env.GUMROAD_API_KEY || "",
  },
  telegram: {
    bot_token: process.env.TELEGRAM_BOT_TOKEN || "",
    chat_id:   process.env.TELEGRAM_CHAT_ID   || "",
  },
  treasury: {
    owner_minimum_for_unlock: 500,
    unlock_approval_hours:    48,
    tiers: [
      { min:0,     max:2999,  owner:60, agent:40, label:"Starter"  },
      { min:3000,  max:6999,  owner:65, agent:35, label:"Growing"  },
      { min:7000,  max:9999,  owner:70, agent:30, label:"Scaling"  },
      { min:10000, max:99999, owner:70, agent:30, label:"10K Club" },
    ],
  },
  youtube: {
    api_key:       process.env.YOUTUBE_API_KEY       || "",
    client_id:     process.env.YOUTUBE_CLIENT_ID     || "",
    client_secret: process.env.YOUTUBE_CLIENT_SECRET || "",
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN || "",
    target_subs:   1000,
    target_hours:  4000,
  },
  printify: {
    api_key: process.env.PRINTIFY_API_KEY || "",
    shop_id: process.env.PRINTIFY_SHOP_ID || "",
  },
};
