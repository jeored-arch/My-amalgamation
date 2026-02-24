require("dotenv").config();

module.exports = {
  owner: {
    name:               process.env.OWNER_NAME             || "Agent Owner",
    email:              process.env.OWNER_EMAIL            || "",
    timezone:           process.env.TZ                     || "America/New_York",
    password:           process.env.DASHBOARD_PASSWORD     || "changeme",
    dashboard_password: process.env.DASHBOARD_PASSWORD     || "changeme",
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
    chat_id:   process.en
