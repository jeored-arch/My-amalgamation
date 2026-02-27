/**
 * store.js — Autonomous Digital Product Store
 *
 * Runs inside Railway alongside the agent.
 * The agent creates products → store sells them → Stripe processes payment
 * → buyer gets PDF emailed instantly → you get paid.
 *
 * Routes:
 *   GET  /store              — storefront showing all products
 *   GET  /store/:slug        — individual product page
 *   POST /store/checkout/:slug — create Stripe payment session
 *   GET  /store/success      — post-payment success page
 *   POST /store/webhook      — Stripe webhook → email PDF to buyer
 */

"use strict";

const fs      = require("fs");
const path    = require("path");
const https   = require("https");
const http    = require("http");
const crypto  = require("crypto");

const DATA_DIR     = path.join(process.cwd(), "data");
const PRODUCTS_DIR = path.join(process.cwd(), "output", "products");
const STORE_FILE   = path.join(DATA_DIR, "store.json");

// ── STORE STATE ───────────────────────────────────────────────────────────────

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch(e) {}
  return { products: [], orders: [], total_revenue: 0 };
}

function saveStore(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  data.updated = new Date().toISOString();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

// ── ADD PRODUCT TO STORE ──────────────────────────────────────────────────────
// Called by product-engine when a new product is created

function addProduct({ name, description, price, pdfPath, type, niche }) {
  const store = loadStore();
  const slug  = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);

  // Don't add duplicates
  if (store.products.find(function(p) { return p.slug === slug; })) {
    return store.products.find(function(p) { return p.slug === slug; });
  }

  const product = {
    id:          Date.now(),
    slug,
    name,
    description: description || "",
    price,
    type:        type || "pdf_guide",
    niche:       niche || "",
    pdf_path:    pdfPath || null,
    url:         "/store/" + slug,
    created:     new Date().toISOString(),
    sales:       0,
    active:      true,
  };

  store.products.push(product);
  saveStore(store);
  console.log("     ✓ Store: product added — /store/" + slug + " at $" + price);
  return product;
}

// ── STRIPE API HELPER ─────────────────────────────────────────────────────────

function stripeRequest(method, endpoint, body) {
  const secretKey = process.env.STRIPE_SECRET_KEY || "";
  if (!secretKey) return Promise.resolve({ error: "No Stripe key" });

  const bodyStr = body ? new URLSearchParams(body).toString() : null;
  return new Promise(function(resolve) {
    const req = https.request({
      hostname: "api.stripe.com",
      path:     "/v1" + endpoint,
      method:   method,
      headers: {
        "Authorization": "Bearer " + secretKey,
        "Content-Type":  "application/x-www-form-urlencoded",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, function(res) {
      var d = "";
      res.on("data", function(c) { d += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({ error: "parse_error", raw: d.slice(0,100) }); }
      });
    });
    req.on("error", function(e) { resolve({ error: e.message }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── CREATE STRIPE CHECKOUT SESSION ────────────────────────────────────────────

async function createCheckoutSession(product, buyerEmail) {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
    : "http://localhost:" + (process.env.PORT || 3000);

  const session = await stripeRequest("POST", "/checkout/sessions", {
    "payment_method_types[]":          "card",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": product.name,
    "line_items[0][price_data][product_data][description]": product.description.slice(0,500),
    "line_items[0][price_data][unit_amount]": String(Math.round(product.price * 100)),
    "line_items[0][quantity]":         "1",
    "mode":                            "payment",
    "success_url":                     baseUrl + "/store/success?session_id={CHECKOUT_SESSION_ID}&product=" + product.slug,
    "cancel_url":                      baseUrl + "/store/" + product.slug,
    "customer_email":                  buyerEmail || "",
    "metadata[product_slug]":          product.slug,
    "metadata[product_name]":          product.name,
  });

  return session;
}

// ── SEND EMAIL WITH PDF ───────────────────────────────────────────────────────

function sendProductEmail(toEmail, productName, pdfPath, resendKey) {
  if (!resendKey) { console.log("     → No RESEND_API_KEY — skipping email"); return Promise.resolve(); }
  if (!pdfPath || !fs.existsSync(pdfPath)) { console.log("     → PDF not found: " + pdfPath); return Promise.resolve(); }

  const pdfData    = fs.readFileSync(pdfPath);
  const b64        = pdfData.toString("base64");
  const filename   = path.basename(pdfPath);

  const body = JSON.stringify({
    from:    (process.env.EMAIL_FROM_NAME || "Your Digital Store") + " <" + (process.env.EMAIL_FROM || "onboarding@resend.dev") + ">",
    to:      [toEmail],
    subject: "Your purchase: " + productName,
    html:    `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
        <h1 style="color:#0d1b2a;font-size:24px;">Thank you for your purchase! 🎉</h1>
        <p style="color:#374151;font-size:16px;">Your copy of <strong>${productName}</strong> is attached to this email.</p>
        <div style="background:#f0fdf4;border-left:4px solid #00d4aa;padding:16px 20px;margin:24px 0;border-radius:0 8px 8px 0;">
          <p style="margin:0;color:#166534;font-size:15px;">📎 <strong>${filename}</strong> is attached below.</p>
        </div>
        <p style="color:#374151;font-size:15px;">If you have any questions, just reply to this email.</p>
        <p style="color:#374151;font-size:15px;">Thank you for your support!</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0;">
        <p style="color:#9ca3af;font-size:13px;">This is an automated delivery. Your file is ready to use immediately.</p>
      </div>
    `,
    attachments: [{
      filename,
      content: b64,
    }],
  });

  return new Promise(function(resolve) {
    const req = https.request({
      hostname: "api.resend.com",
      path:     "/emails",
      method:   "POST",
      headers: {
        "Authorization": "Bearer " + resendKey,
        "Content-Type":  "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, function(res) {
      var d = "";
      res.on("data", function(c) { d += c; });
      res.on("end", function() {
        console.log("     → Email sent HTTP " + res.statusCode + " to " + toEmail);
        resolve();
      });
    });
    req.on("error", function(e) { console.log("     → Email error: " + e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── NOTIFY OWNER ──────────────────────────────────────────────────────────────

function notifyOwner(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID   || "";
  if (!token || !chatId) return Promise.resolve();

  const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" });
  return new Promise(function(resolve) {
    const req = https.request({
      hostname: "api.telegram.org",
      path:     "/bot" + token + "/sendMessage",
      method:   "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, function(res) { res.resume(); res.on("end", resolve); });
    req.on("error", resolve);
    req.write(body);
    req.end();
  });
}

// ── HTML HELPERS ──────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function storePage(products) {
  const cards = products.filter(function(p) { return p.active; }).map(function(p) {
    return `
    <div class="product-card">
      <div class="product-type">${esc(p.type.replace(/_/g," "))}</div>
      <h2>${esc(p.name)}</h2>
      <p class="desc">${esc(p.description.slice(0,150))}...</p>
      <div class="product-footer">
        <span class="price">$${p.price}</span>
        <a href="/store/${esc(p.slug)}" class="btn">View & Buy →</a>
      </div>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Digital Products Store</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1a1a2e; }
  header { background: linear-gradient(135deg, #0d1b2a, #1b4332); color: white; padding: 40px 20px; text-align: center; }
  header h1 { font-size: 32px; margin-bottom: 8px; }
  header p { opacity: 0.8; font-size: 16px; }
  .store { max-width: 1100px; margin: 40px auto; padding: 0 20px; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 24px; }
  .product-card { background: white; border-radius: 12px; padding: 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); display: flex; flex-direction: column; }
  .product-type { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #00d4aa; margin-bottom: 10px; }
  .product-card h2 { font-size: 18px; margin-bottom: 10px; line-height: 1.4; }
  .desc { font-size: 14px; color: #6b7280; line-height: 1.6; flex: 1; margin-bottom: 20px; }
  .product-footer { display: flex; align-items: center; justify-content: space-between; }
  .price { font-size: 24px; font-weight: 700; color: #0d1b2a; }
  .btn { background: #0d1b2a; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; transition: background 0.2s; }
  .btn:hover { background: #1b4332; }
  .empty { text-align: center; padding: 80px 20px; color: #6b7280; grid-column: 1/-1; }
</style>
</head>
<body>
<header>
  <h1>🛍️ Digital Products</h1>
  <p>Premium guides, toolkits & templates — instant download after purchase</p>
</header>
<div class="store">
  ${cards || '<div class="empty"><h2>Products coming soon</h2><p>Check back shortly — new products added daily.</p></div>'}
</div>
</body>
</html>`;
}

function productPage(product, stripePublicKey) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(product.name)}</title>
<script src="https://js.stripe.com/v3/"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1a1a2e; }
  .hero { background: linear-gradient(135deg, #0d1b2a, #1b4332); color: white; padding: 60px 20px; text-align: center; }
  .hero .badge { display: inline-block; background: #00d4aa; color: #0d1b2a; font-size: 12px; font-weight: 700; padding: 4px 14px; border-radius: 20px; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 1px; }
  .hero h1 { font-size: 28px; max-width: 700px; margin: 0 auto 16px; line-height: 1.3; }
  .hero .price-tag { font-size: 48px; font-weight: 700; margin-top: 20px; }
  .hero .price-tag span { font-size: 20px; opacity: 0.7; text-decoration: line-through; margin-left: 12px; }
  .content { max-width: 700px; margin: 40px auto; padding: 0 20px; }
  .desc-box { background: white; border-radius: 12px; padding: 32px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .desc-box h2 { font-size: 20px; margin-bottom: 16px; }
  .desc-box p { color: #374151; line-height: 1.7; font-size: 15px; }
  .checkout-box { background: white; border-radius: 12px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .checkout-box h2 { font-size: 20px; margin-bottom: 20px; }
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; color: #374151; }
  .form-group input { width: 100%; padding: 12px 16px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 15px; outline: none; }
  .form-group input:focus { border-color: #00d4aa; box-shadow: 0 0 0 3px rgba(0,212,170,0.1); }
  .buy-btn { width: 100%; background: linear-gradient(135deg, #0d1b2a, #1b4332); color: white; border: none; padding: 16px; border-radius: 8px; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 8px; }
  .buy-btn:hover { opacity: 0.9; }
  .buy-btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .guarantee { text-align: center; margin-top: 16px; font-size: 13px; color: #6b7280; }
  .back { display: inline-block; margin-bottom: 24px; color: #6b7280; text-decoration: none; font-size: 14px; }
  .back:hover { color: #0d1b2a; }
</style>
</head>
<body>
<div class="hero">
  <div class="badge">${esc(product.type.replace(/_/g," "))}</div>
  <h1>${esc(product.name)}</h1>
  <div class="price-tag">$${product.price}</div>
</div>
<div class="content">
  <a href="/store" class="back">← Back to store</a>
  <div class="desc-box">
    <h2>What you get</h2>
    <p>${esc(product.description)}</p>
  </div>
  <div class="checkout-box">
    <h2>💳 Complete your purchase</h2>
    <div class="form-group">
      <label>Email address (we'll send your download here)</label>
      <input type="email" id="email" placeholder="you@email.com" required>
    </div>
    <button class="buy-btn" id="buyBtn" onclick="startCheckout()">
      Buy Now — $${product.price}
    </button>
    <p class="guarantee">🔒 Secure payment via Stripe · Instant delivery · 30-day guarantee</p>
  </div>
</div>
<script>
var stripe = Stripe('${esc(stripePublicKey)}');
function startCheckout() {
  var email = document.getElementById('email').value;
  if (!email || !email.includes('@')) { alert('Please enter a valid email address'); return; }
  var btn = document.getElementById('buyBtn');
  btn.disabled = true;
  btn.textContent = 'Processing...';
  fetch('/store/checkout/${esc(product.slug)}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.url) {
      window.location.href = data.url;
    } else {
      alert('Something went wrong. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Buy Now — $${product.price}';
    }
  })
  .catch(function() {
    alert('Connection error. Please try again.');
    btn.disabled = false;
    btn.textContent = 'Buy Now — $${product.price}';
  });
}
</script>
</body>
</html>`;
}

function successPage(productName) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Purchase Successful!</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f0fdf4; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .box { background: white; border-radius: 16px; padding: 48px 40px; max-width: 480px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
  .icon { font-size: 64px; margin-bottom: 20px; }
  h1 { color: #0d1b2a; font-size: 26px; margin-bottom: 12px; }
  p { color: #374151; font-size: 16px; line-height: 1.6; margin-bottom: 8px; }
  .highlight { background: #f0fdf4; border-radius: 8px; padding: 16px; margin: 20px 0; color: #166534; font-size: 15px; }
  a { color: #0d1b2a; font-weight: 600; }
</style>
</head>
<body>
<div class="box">
  <div class="icon">🎉</div>
  <h1>Payment Successful!</h1>
  <p>Thank you for purchasing <strong>${esc(productName)}</strong>.</p>
  <div class="highlight">📧 Check your email — your download link is on its way right now.</div>
  <p>If you don't see it within 5 minutes, check your spam folder.</p>
  <p style="margin-top:20px;"><a href="/store">← Browse more products</a></p>
</div>
</body>
</html>`;
}

// ── REQUEST HANDLER ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url    = req.url.split("?")[0];
  const method = req.method;

  // GET /store — storefront
  if (method === "GET" && url === "/store") {
    const store = loadStore();
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(storePage(store.products));
    return;
  }

  // GET /store/success
  if (method === "GET" && url === "/store/success") {
    const qs      = new URLSearchParams(req.url.split("?")[1] || "");
    const slug    = qs.get("product") || "";
    const store   = loadStore();
    const product = store.products.find(function(p) { return p.slug === slug; });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(successPage(product ? product.name : "your product"));
    return;
  }

  // GET /store/:slug — product page
  if (method === "GET" && url.startsWith("/store/") && url !== "/store/") {
    const slug    = url.replace("/store/","").split("/")[0];
    const store   = loadStore();
    const product = store.products.find(function(p) { return p.slug === slug; });
    if (!product) {
      res.writeHead(302, { "Location": "/store" });
      res.end();
      return;
    }
    const pubKey = process.env.STRIPE_PUBLISHABLE_KEY || "";
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(productPage(product, pubKey));
    return;
  }

  // POST /store/checkout/:slug — create Stripe session
  if (method === "POST" && url.startsWith("/store/checkout/")) {
    const slug    = url.replace("/store/checkout/","");
    const store   = loadStore();
    const product = store.products.find(function(p) { return p.slug === slug; });

    if (!product) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Product not found" }));
      return;
    }

    let body = "";
    req.on("data", function(d) { body += d; });
    req.on("end", async function() {
      try {
        const { email } = JSON.parse(body);
        const session   = await createCheckoutSession(product, email);
        if (session.url) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ url: session.url }));
        } else {
          console.log("     → Stripe session error: " + JSON.stringify(session).slice(0,200));
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Could not create checkout session" }));
        }
      } catch(e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /store/webhook — Stripe webhook → deliver product
  if (method === "POST" && url === "/store/webhook") {
    let body = "";
    req.on("data", function(d) { body += d; });
    req.on("end", async function() {
      try {
        const event = JSON.parse(body);

        // Verify webhook signature if secret is set
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
        if (webhookSecret) {
          const sig       = req.headers["stripe-signature"] || "";
          const timestamp = sig.match(/t=(\d+)/)?.[1];
          const sigHash   = sig.match(/v1=([^,]+)/)?.[1];
          if (timestamp && sigHash) {
            const payload  = timestamp + "." + body;
            const expected = crypto.createHmac("sha256", webhookSecret).update(payload).digest("hex");
            if (expected !== sigHash) {
              res.writeHead(400); res.end("Invalid signature"); return;
            }
          }
        }

        if (event.type === "checkout.session.completed") {
          const session    = event.data.object;
          const buyerEmail = session.customer_email || session.customer_details?.email;
          const slug       = session.metadata?.product_slug;
          const store      = loadStore();
          const product    = store.products.find(function(p) { return p.slug === slug; });

          if (product && buyerEmail) {
            console.log("     → Stripe payment: " + buyerEmail + " bought " + product.name);

            // Record sale
            product.sales = (product.sales || 0) + 1;
            store.total_revenue += product.price;
            store.orders.push({
              date:    new Date().toISOString(),
              email:   buyerEmail,
              product: product.name,
              price:   product.price,
              slug,
            });
            if (store.orders.length > 500) store.orders = store.orders.slice(-500);
            saveStore(store);

            // Email PDF to buyer
            const resendKey = process.env.RESEND_API_KEY || "";
            await sendProductEmail(buyerEmail, product.name, product.pdf_path, resendKey);

            // Notify owner on Telegram
            await notifyOwner(
              "💰 *SALE!* $" + product.price + "\n" +
              "Product: " + product.name + "\n" +
              "Buyer: " + buyerEmail + "\n" +
              "Total revenue: $" + store.total_revenue.toFixed(2)
            );
          }
        }

        res.writeHead(200); res.end("ok");
      } catch(e) {
        console.log("     → Webhook error: " + e.message);
        res.writeHead(400); res.end("error");
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

// ── START STORE SERVER ────────────────────────────────────────────────────────

function startStore(existingApp) {
  // If an existing express app is passed, mount as middleware
  if (existingApp && existingApp.use) {
    existingApp.use(function(req, res, next) {
      if (req.url.startsWith("/store")) {
        handleRequest(req, res);
      } else {
        next();
      }
    });
    console.log("  ✓  Store mounted on existing server at /store");
    return;
  }

  // Standalone server on PORT+1 or 3001
  const port = (parseInt(process.env.PORT || "3000") + 1);
  http.createServer(handleRequest).listen(port, function() {
    console.log("  ✓  Store running at http://localhost:" + port + "/store");
  });
}

function getStoreStats() {
  const store = loadStore();
  const active = store.products.filter(function(p) { return p.active; });
  return {
    total_products: store.products.length,
    active_products: active.length,
    total_orders:   store.orders.length,
    total_revenue:  store.total_revenue,
    recent_orders:  store.orders.slice(-5),
  };
}

module.exports = { startStore, addProduct, getStoreStats, handleRequest };
