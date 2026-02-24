/**
 * notifications/notify.js
 * ════════════════════════
 * Handles all owner notifications:
 * - Telegram: instant ping on every sale
 * - Email: daily revenue report via Resend
 * - Security alerts: any suspicious activity
 */

const https  = require("https");
const config = require("../config");
const { auditLog } = require("../security/vault");

// ── TELEGRAM ──────────────────────────────────────────────────────────────────

function telegramRequest(method, body) {
  return new Promise((resolve, reject) => {
    const token = config.notifications.telegram_bot_token;
    if (!token) return resolve({ ok: false, reason: "no_token" });

    const data = JSON.stringify(body);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${token}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({ ok: false }); } });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendTelegram(message, parseMode = "HTML") {
  const chatId = config.owner.telegram_id;
  if (!chatId) return;

  try {
    const result = await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: message,
      parse_mode: parseMode,
    });
    if (result.ok) {
      auditLog("TELEGRAM_SENT", { preview: message.slice(0, 50) });
    } else {
      auditLog("TELEGRAM_FAILED", { error: result.description }, "warn");
    }
    return result;
  } catch (err) {
    auditLog("TELEGRAM_ERROR", { error: err.message }, "warn");
  }
}

// ── SALE NOTIFICATION ─────────────────────────────────────────────────────────

async function notifySale(sale) {
  const msg = `
💰 <b>NEW SALE!</b>

<b>Product:</b> ${sale.product_name || "Digital Product"}
<b>Amount:</b> $${parseFloat(sale.price || 0).toFixed(2)}
<b>Buyer:</b> ${sale.email ? sale.email.replace(/@.*/, "@***") : "anonymous"}
<b>Time:</b> ${new Date().toLocaleTimeString("en-US", { timeZone: config.owner.timezone })}

<i>Money will be deposited to your bank account on your Gumroad payout schedule.</i>
`.trim();

  await sendTelegram(msg);
  auditLog("SALE_NOTIFICATION_SENT", { amount: sale.price }, "financial");
}

// ── SECURITY ALERT ────────────────────────────────────────────────────────────

async function notifySecurityAlert(alert) {
  const msg = `
🚨 <b>SECURITY ALERT</b>

<b>Action:</b> ${alert.action}
<b>Time:</b> ${new Date(alert.ts).toLocaleString("en-US", { timeZone: config.owner.timezone })}
<b>Details:</b> ${JSON.stringify(alert.details).slice(0, 200)}

<i>Review your audit log at: output/data/logs/audit.jsonl</i>
`.trim();

  await sendTelegram(msg);
}

// ── EMAIL VIA RESEND ──────────────────────────────────────────────────────────

function resendRequest(body) {
  return new Promise((resolve, reject) => {
    const key = config.resend.api_key;
    if (!key) return resolve({ error: "no_resend_key" });

    const data = JSON.stringify(body);
    const options = {
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({ error: "parse_fail" }); } });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendDailyReport(reportData) {
  const {
    day = 1,
    date = new Date().toLocaleDateString(),
    revenue_today = 0,
    revenue_total = 0,
    emails_sent = 0,
    content_published = 0,
    sales_count = 0,
    phase = "launch",
    actions = [],
    alerts = [],
    next_steps = [],
  } = reportData;

  const alertSection = alerts.length > 0
    ? `<tr><td colspan="2" style="padding:16px;background:#fff3cd;border-radius:8px;color:#856404;"><strong>⚠️ Security Alerts (${alerts.length}):</strong><br>${alerts.map(a => `• ${a.action}`).join("<br>")}</td></tr>`
    : "";

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:'Courier New',monospace;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;padding:32px 16px;">
  <tr><td>
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:32px;">

      <!-- Header -->
      <div style="border-bottom:1px solid #333;padding-bottom:20px;margin-bottom:24px;">
        <div style="color:#555;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">AUTONOMOUS AGENT — DAY ${day}</div>
        <div style="color:#fff;font-size:22px;font-weight:bold;">Daily Revenue Report</div>
        <div style="color:#555;font-size:13px;margin-top:4px;">${date} · Phase: ${phase.toUpperCase()}</div>
      </div>

      <!-- Revenue Stats -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          <td width="50%" style="padding:0 8px 0 0;">
            <div style="background:#0d2b0d;border:1px solid #1a4a1a;border-radius:8px;padding:20px;text-align:center;">
              <div style="color:#555;font-size:10px;letter-spacing:1px;margin-bottom:6px;">TODAY'S REVENUE</div>
              <div style="color:#4ade80;font-size:28px;font-weight:bold;">$${revenue_today.toFixed(2)}</div>
            </div>
          </td>
          <td width="50%" style="padding:0 0 0 8px;">
            <div style="background:#0d0d2b;border:1px solid #1a1a4a;border-radius:8px;padding:20px;text-align:center;">
              <div style="color:#555;font-size:10px;letter-spacing:1px;margin-bottom:6px;">TOTAL REVENUE</div>
              <div style="color:#60a5fa;font-size:28px;font-weight:bold;">$${revenue_total.toFixed(2)}</div>
            </div>
          </td>
        </tr>
      </table>

      <!-- Stats Row -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr>
          ${[
            ["SALES", sales_count, "#fbbf24"],
            ["EMAILS SENT", emails_sent, "#a78bfa"],
            ["CONTENT PIECES", content_published, "#34d399"],
          ].map(([label, val, color]) => `
          <td width="33%" style="padding:0 4px;text-align:center;">
            <div style="background:#1f1f1f;border:1px solid #333;border-radius:8px;padding:14px 8px;">
              <div style="color:#555;font-size:9px;letter-spacing:1px;margin-bottom:6px;">${label}</div>
              <div style="color:${color};font-size:20px;font-weight:bold;">${val}</div>
            </div>
          </td>`).join("")}
        </tr>
      </table>

      <!-- Progress Bar -->
      <div style="margin-bottom:24px;">
        <div style="color:#555;font-size:10px;letter-spacing:1px;margin-bottom:8px;">PROGRESS TO $2,000/MONTH GOAL</div>
        <div style="background:#2a2a2a;border-radius:4px;height:8px;overflow:hidden;">
          <div style="background:linear-gradient(90deg,#4ade80,#60a5fa);height:8px;width:${Math.min(100, (revenue_total / 2000) * 100).toFixed(1)}%;border-radius:4px;"></div>
        </div>
        <div style="color:#555;font-size:11px;margin-top:6px;">${((revenue_total / 2000) * 100).toFixed(1)}% of goal</div>
      </div>

      <!-- Security Alerts -->
      ${alertSection}

      <!-- Actions Taken -->
      <div style="margin-bottom:24px;">
        <div style="color:#555;font-size:10px;letter-spacing:1px;margin-bottom:12px;">AGENT ACTIONS TODAY</div>
        ${actions.map(a => `<div style="color:#ccc;font-size:13px;padding:6px 0;border-bottom:1px solid #222;">✓ ${a}</div>`).join("") || '<div style="color:#555;font-size:13px;">No actions logged.</div>'}
      </div>

      <!-- Next Steps -->
      <div style="margin-bottom:24px;">
        <div style="color:#555;font-size:10px;letter-spacing:1px;margin-bottom:12px;">TOMORROW'S PRIORITIES</div>
        ${next_steps.map((s, i) => `<div style="color:#ccc;font-size:13px;padding:6px 0;border-bottom:1px solid #222;">${i+1}. ${s}</div>`).join("")}
      </div>

      <!-- Footer -->
      <div style="border-top:1px solid #333;padding-top:16px;color:#555;font-size:11px;text-align:center;">
        Your money is secured in Gumroad and paid out to your verified bank account.<br>
        The agent cannot move funds — only you can initiate payouts.<br><br>
        <a href="http://localhost:${require('../config').security.dashboard_port}" style="color:#60a5fa;">View Dashboard</a> · 
        <a href="mailto:${require('../config').owner.email}" style="color:#60a5fa;">Contact</a>
      </div>

    </div>
  </td></tr>
</table>
</body>
</html>`;

  const result = await resendRequest({
    from: `${config.resend.from_name} <${config.resend.from_email}>`,
    to:   [config.owner.email],
    subject: `💰 Day ${day}: $${revenue_today.toFixed(2)} earned · $${revenue_total.toFixed(2)} total`,
    html,
  });

  if (result.id) {
    auditLog("DAILY_REPORT_SENT", { to: config.owner.email, day });
  } else {
    auditLog("DAILY_REPORT_FAILED", { error: result.message }, "warn");
  }

  return result;
}

// ── STARTUP NOTIFICATION ──────────────────────────────────────────────────────

async function notifyAgentStarted(day) {
  await sendTelegram(`
🤖 <b>Agent Started</b> — Day ${day}

Running daily business operations...
You'll get a full report at the end.

<i>If you didn't trigger this, check your audit log immediately.</i>
  `.trim());
}

module.exports = {
  sendTelegram,
  notifySale,
  notifySecurityAlert,
  sendDailyReport,
  notifyAgentStarted,
};
