require("dotenv").config();
const fs        = require("fs");
const path      = require("path");
const https     = require("https");
const Anthropic = require("@anthropic-ai/sdk");
const config    = require("../../config");
const { calculatePrice } = require("../../core/pricing");
const { auditLog } = require("../../security/vault");
const notify    = require("../../notifications/notify");

const client     = new Anthropic({ apiKey: config.anthropic.api_key });
const DATA_DIR   = path.join(process.cwd(), "data");
const OUT_DIR    = path.join(process.cwd(), "output", "products");
const STATE_FILE = path.join(DATA_DIR, "gumroad-state.json");

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch(e) {}
  }
  return { products: [], sales_count: 0, current_niche: null };
}

function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(Object.assign({}, s, { updated: new Date().toISOString() }), null, 2));
}

function writeProductContent(nicheName, productType, price) {
  console.log("     → Writing product content...");
  return client.messages.create({
    model:      config.anthropic.model,
    max_tokens: 800,
    system:     "You create digital products. Return ONLY a valid JSON object. No markdown, no code blocks, no explanation. Just the raw JSON.",
    messages: [{ role: "user", content:
      "Niche: " + nicheName + ". Price: $" + price + ".\n" +
      "Return this exact JSON with short values:\n" +
      "{\"name\":\"short product name\",\"tagline\":\"short tagline\",\"description\":\"short 100 word description\",\"bullets\":[\"point 1\",\"point 2\",\"point 3\"],\"thank_you\":\"thank you message\",\"keywords\":[\"kw1\",\"kw2\",\"kw3\"]}"
    }],
  }).then(function(res) {
    var text = res.content[0].text.trim();
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
    var start = text.indexOf("{");
    var end   = text.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return {
        name:        nicheName + " Starter Guide",
        tagline:     "Everything you need to get started",
        description: "A comprehensive guide covering " + nicheName + ". Perfect for beginners looking to level up.",
        bullets:     ["Step by step instructions", "Proven strategies", "Easy to follow format"],
        thank_you:   "Thank you for your purchase!",
        keywords:    [nicheName, "guide", "toolkit"],
      };
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch(e) {
      return {
        name:        nicheName + " Starter Guide",
        tagline:     "Everything you need to get started",
        description: "A comprehensive guide for " + nicheName + ".",
        bullets:     ["Step by step instructions", "Proven strategies", "Easy to follow format"],
        thank_you:   "Thank you for your purchase!",
        keywords:    [nicheName, "guide", "toolkit"],
      };
    }
  });
}

function generatePDF(content, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  var bullets = (content.bullets || []).map(function(b) { return "<li>" + b + "</li>"; }).join("");
  var html = "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>" + (content.name||"Guide") + "</title>" +
    "<style>body{font-family:Georgia,serif;max-width:700px;margin:0 auto;padding:40px 20px;color:#1a1a2e;line-height:1.8}" +
    "h1{font-size:28px;color:#0d1b2a;border-bottom:3px solid #00d4aa;padding-bottom:12px}" +
    "p{margin:12px 0}ul{margin:16px 0;padding-left:24px}li{margin:8px 0}" +
    ".cover{text-align:center;padding:40px 0;border-bottom:1px solid #eee;margin-bottom:32px}" +
    ".tagline{font-size:16px;color:#555;font-style:italic}" +
    ".included{background:#f8f9fa;border-left:4px solid #00d4aa;padding:16px 20px;margin:24px 0}" +
    ".footer{margin-top:40px;text-align:center;font-size:13px;color:#999}</style></head><body>" +
    "<div class='cover'><h1>" + (content.name||"Guide") + "</h1><p class='tagline'>" + (content.tagline||"") + "</p></div>" +
    "<div class='included'><strong>What's Inside:</strong><ul>" + bullets + "</ul></div>" +
    "<p>" + (content.description||"") + "</p>" +
    "<div class='footer'>" + (content.thank_you||"Thank you for your purchase!") + "</div>" +
    "</body></html>";
  fs.writeFileSync(outputPath, html);
  return outputPath;
}

function createGumroadListing(content, price) {
  if (!config.gumroad || !config.gumroad.api_key) {
    console.log("     → No Gumroad key - saved locally");
    return Promise.resolve({ status: "manual", url: null });
  }

  var name        = (content.name || "Digital Guide").slice(0, 80).trim();
  var description = (content.description || "A helpful digital guide.").slice(0, 500).trim();
  var receipt     = (content.thank_you || "Thank you for your purchase!").slice(0, 150).trim();

  // Send as JSON with Bearer token in Authorization header
  var body = JSON.stringify({
    name:           name,
    description:    description,
    price:          Math.round(price * 100),
    published:      true,
    custom_receipt: receipt,
  });

  console.log("     → Creating Gumroad listing: " + name + " at $" + price);

  return new Promise(function(resolve) {
    var options = {
      hostname: "api.gumroad.com",
      path:     "/v2/products",
      method:   "POST",
      headers: {
        "Authorization": "Bearer " + config.gumroad.api_key,
        "Content-Type":  "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        console.log("     → Gumroad status: " + res.statusCode);
        console.log("     → Gumroad response: " + data.slice(0, 300));
        try {
          var r = JSON.parse(data);
          if (r.success) {
            resolve({ status:"published", product_id:r.product.id, url:r.product.short_url||r.product.url, price:price });
          } else {
            console.log("     → Gumroad error: " + (r.message || JSON.stringify(r)));
            resolve({ status:"api_error", error:r.message, url:null });
          }
        } catch(e) {
          console.log("     → Could not parse response");
          resolve({ status:"parse_error", url:null });
        }
      });
    });
    req.on("error", function(e) {
      console.log("     → Network error: " + e.message);
      resolve({ status:"network_error", url:null });
    });
    req.write(body);
    req.end();
  });
}

function updateGumroadPrice(productId, newPrice) {
  if (!config.gumroad || !config.gumroad.api_key || !productId) return Promise.resolve();
  var body = JSON.stringify({ price: Math.round(newPrice * 100) });
  return new Promise(function(resolve) {
    var opts = {
      hostname: "api.gumroad.com",
      path:     "/v2/products/" + productId,
      method:   "PUT",
      headers: {
        "Authorization": "Bearer " + config.gumroad.api_key,
        "Content-Type":  "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    var req = https.request(opts, function(res) {
      var d = ""; res.on("data", function(c) { d += c; });
      res.on("end", function() { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on("error", function() { resolve(null); });
    req.write(body); req.end();
  });
}

function run(nicheName) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  var state = loadState();

  var existing = null;
  for (var i = 0; i < state.products.length; i++) {
    if (state.products[i].niche === nicheName && state.products[i].status === "published") {
      existing = state.products[i]; break;
    }
  }

  if (existing) {
    var pd = calculatePrice(nicheName, state.sales_count);
    if (pd.price > existing.price && existing.product_id) {
      console.log("     → Price update: $" + existing.price + " to $" + pd.price);
      return updateGumroadPrice(existing.product_id, pd.price).then(function() {
        existing.price = pd.price;
        saveState(state);
        return notify.sendTelegram("Price Updated: $" + existing.price + " to $" + pd.price);
      }).then(function() { return existing; });
    }
    return Promise.resolve(existing);
  }

  console.log("\n  Creating Gumroad product for " + nicheName + "...");
  var pi = calculatePrice(nicheName, state.sales_count);
  console.log("     → Price: $" + pi.price + " — " + pi.reasoning);

  return writeProductContent(nicheName, pi.product_type, pi.price).then(function(content) {
    console.log("     → Product: " + content.name);
    var safeName = nicheName.replace(/\s+/g, "-").toLowerCase().slice(0, 40);
    var pdfPath  = path.join(OUT_DIR, safeName + ".html");
    generatePDF(content, pdfPath);

    return createGumroadListing(content, pi.price).then(function(listing) {
      var product = {
        niche: nicheName, name: content.name, price: pi.price,
        product_type: pi.product_type, status: listing.status,
        product_id: listing.product_id || null, url: listing.url || null,
        pdf_path: pdfPath, created: new Date().toISOString(),
      };
      state.products.push(product);
      state.current_niche = nicheName;
      saveState(state);

      var msg = listing.url
        ? "Gumroad Product Live!\n\n" + content.name + "\nPrice: $" + pi.price + "\nLink: " + listing.url
        : "Product saved locally.\nName: " + content.name + "\nPrice: $" + pi.price + "\nStatus: " + listing.status;

      return notify.sendTelegram(msg).then(function() { return product; });
    });
  }).catch(function(err) {
    console.log("     → Product error: " + err.message);
    return { niche: nicheName, name: nicheName + " Guide", price: pi.price, status: "error", url: null };
  });
}

function getProductUrl(nicheName) {
  var state = loadState();
  for (var i = 0; i < state.products.length; i++) {
    if (state.products[i].niche === nicheName && state.products[i].url) return state.products[i].url;
  }
  return null;
}

function getStats() {
  var state = loadState();
  var current = null;
  for (var i = 0; i < state.products.length; i++) {
    if (state.products[i].niche === state.current_niche) { current = state.products[i]; break; }
  }
  return { products_created: state.products.length, current_product: current, total_sales: state.sales_count };
}

module.exports = { run:run, getProductUrl:getProductUrl, getStats:getStats, updateGumroadPrice:updateGumroadPrice };
