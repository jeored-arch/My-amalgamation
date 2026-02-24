const https  = require("https");
const config = require("../config");
const { auditLog } = require("../security/vault");

function telegramRequest(method, body) {
  return new Promise(function(resolve) {
    var token = config.telegram.bot_token;
    if (!token) return resolve({ ok: false, reason: "no_token" });

    var data = JSON.stringify(body);
    var options = {
      hostname: "api.telegram.org",
      path:     "/bot" + token + "/" + method,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    var req = https.request(options, function(res) {
      var raw = "";
      res.on("data", function(d) { raw += d; });
      res.on("end", function() {
        try { resolve(JSON.parse(raw)); } catch(e) { resolve({ ok: false }); }
      });
    });
    req.on("error", function() { resolve({ ok: false }); });
    req.write(data);
    req.end();
  });
}

function sendTelegram(message) {
  var chatId = config.telegram.chat_id;
  if (!chatId) return Promise.resolve();

  return telegramRequest("sendMessage", {
    chat_id:    chatId,
    text:       message,
    parse_mode: "HTML",
  }).then(function(result) {
    if (!result.ok) {
      console.log("Telegram send failed: " + JSON.stringify(result));
    }
    return result;
  }).catch(function(err) {
    console.log("Telegram error: " + err.message);
  });
}

function notifySale(sale) {
  var msg = "NEW SALE!\n\n" +
    "Product: " + (sale.product_name || "Digital Product") + "\n" +
    "Amount: $" + parseFloat(sale.price || 0).toFixed(2) + "\n" +
    "Time: " + new Date().toLocaleTimeString("en-US", { timeZone: config.owner.timezone });
  return sendTelegram(msg);
}

function notifySecurityAlert(alert) {
  var msg = "SECURITY ALERT\n\n" +
    "Action: " + alert.action + "\n" +
    "Time: " + new Date(alert.ts).toLocaleString("en-US", { timeZone: config.owner.timezone });
  return sendTelegram(msg);
}

function notifyAgentStarted(day) {
  return sendTelegram(
    "Agent Started - Day " + day + "\n\nRunning daily business operations...\nFull report coming at the end."
  );
}

function sendDailyReport(reportData) {
  var day              = reportData.day || 1;
  var date             = reportData.date || new Date().toLocaleDateString();
  var revenue_today    = reportData.revenue_today || 0;
  var revenue_total    = reportData.revenue_total || 0;
  var emails_sent      = reportData.emails_sent || 0;
  var content_published = reportData.content_published || 0;
  var sales_count      = reportData.sales_count || 0;
  var actions          = reportData.actions || [];
  var next_steps       = reportData.next_steps || [];

  var msg = "DAY " + day + " REPORT - " + date + "\n\n" +
    "Today: $" + revenue_today.toFixed(2) + "\n" +
    "Total: $" + revenue_total.toFixed(2) + "\n" +
    "Sales: " + sales_count + "\n" +
    "Emails sent: " + emails_sent + "\n" +
    "Content pieces: " + content_published + "\n\n" +
    "ACTIONS TODAY:\n" +
    actions.map(function(a) { return "• " + a; }).join("\n") + "\n\n" +
    "TOMORROW:\n" +
    next_steps.map(function(s) { return "• " + s; }).join("\n") + "\n\n" +
    "Agent goes back to sleep. See you at 8am tomorrow.";

  auditLog("DAILY_REPORT_SENT", { day: day });
  return sendTelegram(msg);
}

module.exports = {
  sendTelegram:        sendTelegram,
  notifySale:          notifySale,
  notifySecurityAlert: notifySecurityAlert,
  sendDailyReport:     sendDailyReport,
  notifyAgentStarted:  notifyAgentStarted,
};
