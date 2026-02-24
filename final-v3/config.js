/**
 * config.js — MASTER CONFIGURATION
 * All values come from your .env file. Never hardcode secrets here.
 */
module.exports = {
  owner: {
    name:               process.env.OWNER_NAME            || "Business Owner",
    email:              process.env.OWNER_EMAIL           || "",
    telegram_id:        process.env.TELEGRAM_CHAT_ID      || "",
    dashboard_password: process.env.DASHBOARD_PASSWORD    || "changeme",
    timezone:           process.env.TZ                    || "America/Chicago",
  },
  anthropic: {
    api_key:   process.env.ANTHROPIC_API_KEY || "",
    model:     "claude-sonnet-4-6",
    max_tokens: 4000,
  },
  gumroad: {
    api_key:  process.env.GUMROAD_API_KEY || "",
  },
  resend: {
    api_key:     process.env.RESEND_API_KEY    || "",
    from_email:  process.env.EMAIL_FROM        || "",
    from_name:   process.env.EMAIL_FROM_NAME   || "Your Business",
    daily_limit: 200,
  },
  notifications: {
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || "",
  },
  youtube: {
    // Set these after connecting YouTube API (free)
    // Get credentials: console.developers.google.com
    credentials: {
      client_id:     process.env.YOUTUBE_CLIENT_ID     || "",
      client_secret: process.env.YOUTUBE_CLIENT_SECRET || "",
      access_token:  process.env.YOUTUBE_ACCESS_TOKEN  || "",
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN || "",
    },
    channel_name:    process.env.YOUTUBE_CHANNEL_NAME || "",
    upload_daily:    true,
    target_subs:     1000,   // monetization threshold
    target_hours:    4000,
  },
  printify: {
    api_key:  process.env.PRINTIFY_API_KEY || "",   // from printify.com/app/account
    shop_id:  process.env.PRINTIFY_SHOP_ID || "",   // from printify shop settings
  },
  etsy: {
    api_key:   process.env.ETSY_API_KEY   || "",
    shop_id:   process.env.ETSY_SHOP_ID   || "",
  },
  security: {
    session_secret:  process.env.SESSION_SECRET || "change-this",
    dashboard_port:  3000,
    allowed_ips:     [],
    log_all_actions: true,
  },
  // Treasury rules — these are your financial preferences
  treasury: {
    owner_bank_minimum_for_unlock: 500,   // $500 in your bank before ANY paid unlock
    unlock_approval_hours:         48,    // hours before auto-unlock
    tiers: [
      { min: 0,     max: 2999,    owner: 60, agent: 40 },
      { min: 3000,  max: 6999,    owner: 65, agent: 35 },
      { min: 7000,  max: 9999,    owner: 70, agent: 30 },
      { min: 10000, max: Infinity, owner: 70, agent: 30 },
    ],
  },
};
