/**
 * store.js — Self-Hosted Digital Product Store
 *
 * No Express needed — plugs into the existing raw http server.
 * Agent creates products → live in store immediately.
 * Buyer pays via Stripe → gets PDF emailed instantly via Resend.
 *
 * Routes:
 *   GET  /store              — storefront
 *   GET  /store/buy/:id      — product checkout page
 *   POST /store/checkout/:id — create Stripe payment intent
 *   GET  /store/success      — post-payment + email delivery
 *   GET  /store/download/:t  — secure file download
 *   GET  /store/admin        — admin dashboard
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const https  = require("https");
const crypto = require("crypto");
const url    = require("url");

const DATA_DIR  = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "store-products.json");

// ── PERSISTENCE ───────────────────────────────────────────────────────────────

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch(e) {}
  return { products: [], orders: [] };
}

function saveStore(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  data.updated = new Date().toISOString();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

function addProduct(product) {
  const store = loadStore();
  // Don't add duplicates
  const exists = store.products.find(function(p) { return p.name === product.name; });
  if (exists) { console.log("     → Store: product already exists — " + product.name.slice(0,50)); return exists; }
  const id    = "prod_" + Date.now();
  const entry = {
    id,
    name:        product.name || "Digital Guide",
    description: product.description || product.tagline || "",
    price:       product.price,
    file_path:   product.file_path || null,
    niche:       product.niche || "",
    type:        product.type || "pdf_guide",
    created:     new Date().toISOString(),
    sales:       0,
    active:      true,
  };
  store.products.push(entry);
  saveStore(store);
  console.log("     \u2713 Store: added \"" + entry.name.slice(0,50) + "\" @ $" + entry.price);
  return entry;
}

function getActiveProducts() {
  return loadStore().products.filter(function(p) { return p.active; });
}

function getProduct(id) {
  return loadStore().products.find(function(p) { return p.id === id; });
}

function recordOrder(productId, email, paymentIntentId) {
  const store = loadStore();
  store.orders.push({ id:"order_"+Date.now(), product_id:productId, email, payment_intent:paymentIntentId, date:new Date().toISOString() });
  const p = store.products.find(function(x){ return x.id === productId; });
  if (p) p.sales = (p.sales||0) + 1;
  if (store.orders.length > 1000) store.orders = store.orders.slice(-1000);
  saveStore(store);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function parseBody(req) {
  return new Promise(function(resolve) {
    var body = "";
    req.on("data", function(c){ body += c; });
    req.on("end", function() {
      try {
        if ((req.headers["content-type"]||"").includes("application/json")) resolve(JSON.parse(body));
        else resolve(Object.fromEntries(new URLSearchParams(body)));
      } catch(e) { resolve({}); }
    });
  });
}

function getBaseUrl() {
  return process.env.RAILWAY_PUBLIC_DOMAIN
    ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
    : "http://localhost:" + (process.env.PORT || 3000);
}

// ── STRIPE ────────────────────────────────────────────────────────────────────

function stripePost(endpoint, body) {
  var secretKey = process.env.STRIPE_SECRET_KEY || "";
  var bodyStr   = new URLSearchParams(body).toString();
  return new Promise(function(resolve) {
    var req = https.request({
      hostname: "api.stripe.com", path: "/v1" + endpoint, method: "POST",
      headers: { "Authorization":"Bearer "+secretKey, "Content-Type":"application/x-www-form-urlencoded", "Content-Length":Buffer.byteLength(bodyStr) },
    }, function(res) {
      var d=""; res.on("data",function(c){d+=c;}); res.on("end",function(){ try{resolve(JSON.parse(d));}catch(e){resolve(null);} });
    });
    req.on("error",function(){ resolve(null); }); req.write(bodyStr); req.end();
  });
}

// ── EMAIL ─────────────────────────────────────────────────────────────────────

function sendEmail(toEmail, productName, downloadUrl) {
  var resendKey = process.env.RESEND_API_KEY || "";
  if (!resendKey) return Promise.resolve();
  var fromName  = process.env.EMAIL_FROM_NAME || "Digital Store";
  var fromEmail = process.env.EMAIL_FROM || "onboarding@resend.dev";
  var body = JSON.stringify({
    from:    fromName + " <" + fromEmail + ">",
    to:      [toEmail],
    subject: "Your purchase: " + productName,
    html:    "<body style='font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px'><div style='background:linear-gradient(135deg,#0d1b2a,#1b4332);padding:40px;border-radius:12px;text-align:center;margin-bottom:30px'><h1 style='color:white;margin:0'>Thank You!</h1><p style='color:rgba(255,255,255,0.8);margin:10px 0 0'>Your purchase is ready</p></div><h2 style='color:#0d1b2a'>" + esc(productName) + "</h2><p style='color:#374151;line-height:1.6'>Your digital product is ready. Click below to download it instantly.</p><div style='text-align:center;margin:30px 0'><a href='" + downloadUrl + "' style='background:#00d4aa;color:#0d1b2a;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px'>Download Now</a></div><p style='color:#6b7280;font-size:13px'>Link expires in 24 hours.</p></body>",
  });
  return new Promise(function(resolve) {
    var req = https.request({ hostname:"api.resend.com", path:"/emails", method:"POST",
      headers:{"Authorization":"Bearer "+resendKey,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)},
    }, function(res) { res.resume(); res.on("end",function(){ console.log("     \u2192 Email sent to "+toEmail); resolve(); }); });
    req.on("error",function(){ resolve(); }); req.write(body); req.end();
  });
}

// ── DOWNLOAD TOKENS ───────────────────────────────────────────────────────────

function makeToken(productId) {
  var secret  = process.env.SESSION_SECRET || "secret";
  var expires = Date.now() + 86400000;
  var payload = productId + ":" + expires;
  var sig     = crypto.createHmac("sha256",secret).update(payload).digest("hex").slice(0,16);
  return Buffer.from(payload+":"+sig).toString("base64url");
}

function checkToken(token) {
  try {
    var secret  = process.env.SESSION_SECRET || "secret";
    var decoded = Buffer.from(token,"base64url").toString();
    var parts   = decoded.split(":");
    var sig     = parts.pop();
    var payload = parts.join(":");
    var pId     = parts[0];
    var expires = parseInt(parts[1]);
    if (Date.now() > expires) return null;
    var expected = crypto.createHmac("sha256",secret).update(payload).digest("hex").slice(0,16);
    return sig === expected ? pId : null;
  } catch(e) { return null; }
}

// ── PAGES ─────────────────────────────────────────────────────────────────────

function pageStore(products) {
  var cards = products.length === 0
    ? "<div style='text-align:center;padding:80px;color:#6b7280'><p style='font-size:18px'>New products launching soon — check back tomorrow!</p></div>"
    : products.map(function(p) {
        var icon = p.type==="email_course"?"📧":p.type==="notion"?"📋":"📄";
        return "<div style='background:white;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,0.08);display:flex;flex-direction:column'>"
          + "<div style='background:linear-gradient(135deg,#0d1b2a,#1b4332);border-radius:8px;padding:20px;margin-bottom:16px;text-align:center;font-size:36px'>" + icon + "</div>"
          + "<h3 style='margin:0 0 8px;color:#0d1b2a;font-size:15px;line-height:1.4'>" + esc(p.name) + "</h3>"
          + "<p style='color:#6b7280;font-size:13px;flex:1;margin:0 0 16px;line-height:1.5'>" + esc((p.description||"").slice(0,100)) + "...</p>"
          + "<div style='display:flex;align-items:center;justify-content:space-between'>"
          + "<span style='font-size:22px;font-weight:700;color:#0d1b2a'>$" + p.price + "</span>"
          + "<a href='/store/buy/" + p.id + "' style='background:#00d4aa;color:#0d1b2a;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px'>Buy Now</a>"
          + "</div></div>";
      }).join("");

  return "<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Digital Products Store</title>"
    + "<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb}.hero{background:linear-gradient(135deg,#0d1b2a,#1b4332);color:white;padding:60px 20px;text-align:center}.hero h1{font-size:36px;margin-bottom:12px}.hero p{font-size:18px;opacity:.8}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px;max-width:1100px;margin:40px auto;padding:0 20px}.badge{display:inline-block;background:rgba(0,212,170,.15);color:#00d4aa;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:16px}</style></head>"
    + "<body><div class='hero'><div class='badge'>\u2726 Premium Digital Products</div><h1>Level Up Your Business</h1><p>Proven guides &amp; toolkits — at prices that make sense</p></div>"
    + "<div class='grid'>" + cards + "</div>"
    + "<div style='text-align:center;padding:40px;color:#9ca3af;font-size:13px'>\uD83D\uDD12 Secure payments by Stripe &middot; Instant digital delivery</div>"
    + "</body></html>";
}

function pageBuy(product, pubKey) {
  return "<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>" + esc(product.name) + "</title>"
    + "<script src='https://js.stripe.com/v3/'></script>"
    + "<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;min-height:100vh}.container{max-width:680px;margin:0 auto;padding:40px 20px}.back{color:#6b7280;text-decoration:none;font-size:14px;display:inline-block;margin-bottom:24px}.card{background:white;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.08)}.price-badge{background:#00d4aa;color:#0d1b2a;display:inline-block;padding:8px 20px;border-radius:20px;font-weight:700;font-size:20px;margin-bottom:20px}h1{font-size:24px;margin-bottom:12px;line-height:1.3}.desc{color:#374151;line-height:1.7;margin-bottom:28px}label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px}input{width:100%;padding:12px 16px;border:1px solid #e5e7eb;border-radius:8px;font-size:15px;margin-bottom:16px;outline:none}input:focus{border-color:#00d4aa}#card-element{padding:13px 16px;border:1px solid #e5e7eb;border-radius:8px;background:white;margin-bottom:16px}#pay-btn{width:100%;background:#00d4aa;color:#0d1b2a;border:none;padding:16px;border-radius:8px;font-size:17px;font-weight:700;cursor:pointer}#pay-btn:disabled{opacity:.6;cursor:not-allowed}#error-msg{color:#ef4444;font-size:13px;margin-top:8px;min-height:20px}.secure{text-align:center;color:#9ca3af;font-size:12px;margin-top:16px}</style></head>"
    + "<body><div class='container'><a href='/store' class='back'>&larr; Back to store</a><div class='card'>"
    + "<div class='price-badge'>$" + product.price + "</div>"
    + "<h1>" + esc(product.name) + "</h1>"
    + "<p class='desc'>" + esc(product.description) + "</p>"
    + "<hr style='border:none;border-top:1px solid #f0f0f0;margin:28px 0'>"
    + "<form id='pf'><label>Email address</label><input type='email' id='em' placeholder='you@example.com' required>"
    + "<label>Card details</label><div id='card-element'></div><div id='error-msg'></div>"
    + "<button type='submit' id='pay-btn'>Pay $" + product.price + " — Get Instant Access</button></form>"
    + "<p class='secure'>\uD83D\uDD12 Secured by Stripe &middot; File delivered instantly by email</p></div></div>"
    + "<script>var stripe=Stripe('" + pubKey + "');var elements=stripe.elements();var card=elements.create('card',{style:{base:{fontSize:'16px',color:'#1a1a2e','::placeholder':{color:'#9ca3af'}}}});card.mount('#card-element');"
    + "document.getElementById('pf').addEventListener('submit',async function(e){e.preventDefault();"
    + "var btn=document.getElementById('pay-btn');var email=document.getElementById('em').value;var err=document.getElementById('error-msg');"
    + "btn.disabled=true;btn.textContent='Processing...';err.textContent='';"
    + "try{var r=await fetch('/store/checkout/" + product.id + "',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});"
    + "var d=await r.json();if(d.error){err.textContent=d.error;btn.disabled=false;btn.textContent='Pay $" + product.price + " \u2014 Get Instant Access';return;}"
    + "var result=await stripe.confirmCardPayment(d.client_secret,{payment_method:{card:card,billing_details:{email}}});"
    + "if(result.error){err.textContent=result.error.message;btn.disabled=false;btn.textContent='Pay $" + product.price + " \u2014 Get Instant Access';}"
    + "else{window.location.href='/store/success?email='+encodeURIComponent(email)+'&product=" + encodeURIComponent(product.name) + "&id=" + product.id + "&pi='+result.paymentIntent.id;}}"
    + "catch(ex){err.textContent='Something went wrong. Please try again.';btn.disabled=false;btn.textContent='Pay $" + product.price + " \u2014 Get Instant Access';}});"
    + "</script></body></html>";
}

function pageSuccess(email, productName) {
  return "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>Purchase Successful!</title>"
    + "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}.card{background:white;border-radius:16px;padding:50px 40px;max-width:500px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{font-size:64px;margin-bottom:20px}h1{color:#0d1b2a;margin-bottom:12px}p{color:#374151;line-height:1.6;margin-bottom:8px}.em{font-weight:700;color:#00d4aa}.back{display:inline-block;margin-top:24px;color:#6b7280;text-decoration:none;font-size:14px}</style></head>"
    + "<body><div class='card'><div class='icon'>\uD83C\uDF89</div><h1>You're all set!</h1>"
    + "<p>Your purchase of <strong>" + esc(productName) + "</strong> is confirmed.</p>"
    + "<p>Check <span class='em'>" + esc(email) + "</span> for your download link.</p>"
    + "<p style='color:#9ca3af;font-size:13px;margin-top:16px'>Didn't get it? Check spam or reply to the confirmation email.</p>"
    + "<a href='/store' class='back'>&larr; Browse more products</a></div></body></html>";
}

// ── REQUEST HANDLER ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  var parsed   = url.parse(req.url, true);
  var pathname = parsed.pathname || "/";
  var query    = parsed.query || {};
  var pubKey   = process.env.STRIPE_PUBLISHABLE_KEY || "";

  // GET /store
  if (req.method === "GET" && pathname === "/store") {
    res.writeHead(200, {"Content-Type":"text/html"});
    return res.end(pageStore(getActiveProducts()));
  }

  // GET /store/buy/:id
  var buyMatch = pathname.match(/^\/store\/buy\/([^/]+)$/);
  if (req.method === "GET" && buyMatch) {
    var product = getProduct(buyMatch[1]);
    if (!product) { res.writeHead(404); return res.end("Product not found"); }
    res.writeHead(200, {"Content-Type":"text/html"});
    return res.end(pageBuy(product, pubKey));
  }

  // POST /store/checkout/:id
  var checkoutMatch = pathname.match(/^\/store\/checkout\/([^/]+)$/);
  if (req.method === "POST" && checkoutMatch) {
    var body    = await parseBody(req);
    var product = getProduct(checkoutMatch[1]);
    if (!product) { res.writeHead(200,{"Content-Type":"application/json"}); return res.end(JSON.stringify({error:"Product not found"})); }

    var intent = await stripePost("/payment_intents", {
      amount:   String(Math.round(product.price * 100)),
      currency: "usd",
      "metadata[product_id]":   product.id,
      "metadata[product_name]": product.name,
      description: product.name,
    });

    if (!intent || !intent.client_secret) {
      res.writeHead(200,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({error:"Payment setup failed. Please try again."}));
    }
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({client_secret:intent.client_secret}));
  }

  // GET /store/success
  if (req.method === "GET" && pathname === "/store/success") {
    var email   = query.email || "";
    var pName   = query.product || "Your product";
    var pId     = query.id || "";
    var pi      = query.pi || "";

    if (pId && pi) recordOrder(pId, email, pi);

    // Generate download token and send email
    if (pId && email) {
      var token    = makeToken(pId);
      var dlUrl    = getBaseUrl() + "/store/download/" + token;
      await sendEmail(email, pName, dlUrl);
    }

    res.writeHead(200,{"Content-Type":"text/html"});
    return res.end(pageSuccess(email, pName));
  }

  // GET /store/download/:token
  var dlMatch = pathname.match(/^\/store\/download\/([^/]+)$/);
  if (req.method === "GET" && dlMatch) {
    var pId = checkToken(dlMatch[1]);
    if (!pId) { res.writeHead(410); return res.end("Download link expired. Please contact support."); }

    var product = getProduct(pId);
    if (!product || !product.file_path) { res.writeHead(404); return res.end("File not found."); }

    // Try PDF then HTML
    var filePath = product.file_path;
    if (!fs.existsSync(filePath)) {
      var htmlPath = filePath.replace(".pdf", ".html");
      if (fs.existsSync(htmlPath)) filePath = htmlPath;
      else { res.writeHead(404); return res.end("File not found."); }
    }

    var ext = path.extname(filePath).toLowerCase();
    var ct  = ext === ".pdf" ? "application/pdf" : "text/html";
    res.writeHead(200, {"Content-Type":ct,"Content-Disposition":"attachment; filename=\""+path.basename(filePath)+"\""});
    return res.end(fs.readFileSync(filePath));
  }

  // GET /store/admin
  if (req.method === "GET" && pathname === "/store/admin") {
    var pw = query.pw || "";
    if (pw !== (process.env.DASHBOARD_PASSWORD||"")) {
      res.writeHead(200,{"Content-Type":"text/html"});
      return res.end("<form style='padding:40px;font-family:sans-serif'><h2>Store Admin</h2><input name='pw' type='password' placeholder='Password' style='padding:8px;margin:10px 0;display:block'><button>Login</button></form>");
    }
    var store   = loadStore();
    var totalRev = store.products.reduce(function(s,p){ return s+(p.sales||0)*p.price; },0);
    var rows    = store.products.map(function(p) {
      return "<tr><td style='padding:10px;border-bottom:1px solid #f0f0f0'>"+esc(p.name.slice(0,50))+"</td><td style='padding:10px;border-bottom:1px solid #f0f0f0'>$"+p.price+"</td><td style='padding:10px;border-bottom:1px solid #f0f0f0'>"+(p.sales||0)+"</td><td style='padding:10px;border-bottom:1px solid #f0f0f0'>$"+((p.sales||0)*p.price).toFixed(2)+"</td><td style='padding:10px;border-bottom:1px solid #f0f0f0'><a href='/store/buy/"+p.id+"'>View</a></td></tr>";
    }).join("");
    res.writeHead(200,{"Content-Type":"text/html"});
    return res.end("<!DOCTYPE html><html><head><meta charset='UTF-8'><title>Store Admin</title></head><body style='font-family:sans-serif;padding:40px;max-width:900px;margin:0 auto'><h1>Store Admin</h1><div style='background:#f0fdf4;border-radius:8px;padding:20px;margin-bottom:24px'><strong>Total Revenue: $"+totalRev.toFixed(2)+"</strong> | Products: "+store.products.length+" | Orders: "+store.orders.length+"</div><table style='width:100%;border-collapse:collapse'><thead><tr style='background:#f9fafb'><th style='padding:10px;text-align:left'>Product</th><th style='padding:10px;text-align:left'>Price</th><th style='padding:10px;text-align:left'>Sales</th><th style='padding:10px;text-align:left'>Revenue</th><th style='padding:10px;text-align:left'>Link</th></tr></thead><tbody>"+rows+"</tbody></table></body></html>");
  }

  return null; // not a store route — let other handlers continue
}

function startStore() {
  // Store routes are handled by dashboard/server.js — no separate server needed
  const base = process.env.RAILWAY_PUBLIC_DOMAIN
    ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
    : "http://localhost:" + (process.env.PORT || 3000);
  console.log("  ✓  Store available at " + base + "/store");
}

function getStoreStats() {
  const data = loadStore();
  const active = data.products.filter(function(p) { return p.active; });
  return {
    total_products:  data.products.length,
    active_products: active.length,
    total_orders:    data.orders.length,
    total_revenue:   data.products.reduce(function(s,p){ return s+(p.sales||0)*p.price; }, 0),
    recent_orders:   data.orders.slice(-5),
  };
}

module.exports = { handleRequest, addProduct, getActiveProducts, getProduct, recordOrder, loadStore, startStore, getStoreStats };
