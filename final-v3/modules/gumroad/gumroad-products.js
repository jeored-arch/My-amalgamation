require("dotenv").config();
const fs       = require("fs");
const path     = require("path");
const https    = require("https");
const Anthropic = require("@anthropic-ai/sdk");
const config   = require("../../config");
const { calculatePrice } = require("../../core/pricing");
const { auditLog } = require("../../security/vault");
const notify   = require("../../notifications/notify");

const client   = new Anthropic({ apiKey: config.anthropic.api_key });
const DATA_DIR = path.join(process.cwd(), "data");
const OUT_DIR  = path.join(process.cwd(), "output", "products");
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
  console.log("Writing product content...");
  var types = {
    checklist_bundle: "a checklist and worksheet bundle",
    pdf_guide:        "a comprehensive PDF guide",
    template_pack:    "a ready-to-use template pack",
    toolkit:          "a complete toolkit and system",
  };
  return client.messages.create({
    model: config.anthropic.model,
    max_tokens: 3000,
    system: "You are an expert digital product creator. Write products that genuinely help people and convert browsers into buyers. Real useful content, no filler.",
    messages: [{ role: "user", content:
      "Create a complete digital product for the niche: " + nicheName + "\n" +
      "Product type: " + types[productType] + "\n" +
      "Price: $" + price + "\n\n" +
      "Return ONLY valid JSON with these fields:\n" +
      "{\n" +
      '  "name": "Product name under 60 chars",\n' +
      '  "tagline": "One sentence under 15 words",\n' +
      '  "description": "400 word Gumroad description",\n' +
      '  "bullets": ["5 bullet points of what they get"],\n' +
      '  "pdf_sections": [{ "heading": "Section heading", "content": "300 words of useful content" }],\n' +
      '  "thank_you_message": "50 words shown after purchase",\n' +
      '  "keywords": ["8 SEO keywords"]\n' +
      "}"
    }]
  }).then(function(res) {
    var clean = res.content[0].text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(clean);
  });
}

function generatePDF(content, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  var sections = content.pdf_sections.map(function(s, i) {
    return "<div class='section'><h2>" + (i+1) + ". " + s.heading + "</h2><p>" + s.content.replace(/\n/g, "</p><p>") + "</p></div>";
  }).join("");
  var bullets = content.bullets.map(function(b) { return "<li>" + b + "</li>"; }).join("");
  var html = "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>" + content.name + "</title>" +
    "<style>body{font-family:Georgia,serif;max-width:700px;margin:0 auto;padding:40px 20px;color:#1a1a2e;line-height:1.8}" +
    "h1{font-size:28px;color:#0d1b2a;border-bottom:3px solid #00d4aa;padding-bottom:12px}" +
    ".tagline{font-size:16px;color:#555;font-style:italic;margin-bottom:32px}" +
    "h2{font-size:20px;color:#0d1b2a;margin-top:36px}" +
    "p{margin:12px 0}ul{margin:16px 0;padding-left:24px}li{margin:8px 0}" +
    ".cover{text-align:center;padding:60px 0;border-bottom:1px solid #eee;margin-bottom:40px}" +
    ".section{margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid #f0f0f0}" +
    ".included{background:#f8f9fa;border-left:4px solid #00d4aa;padding:20px 24px;margin:24px 0}" +
    ".footer{margin-top:48px;text-align:center;font-size:13px;color:#999}</style></head><body>" +
    "<div class='cover'><h1>" + content.name + "</h1><p class='tagline'>" + content.tagline + "</p></div>" +
    "<div class='included'><strong>What's Inside:</strong><ul>" + bullets + "</ul></div>" +
    sections +
    "<div class='footer'>" + content.thank_you_message + "</div>" +
    "</body></html>";
  fs.writeFileSync(outputPath, html);
  return outputPath;
}

function createGumroadListing(content, price) {
  if (!config.gumroad || !config.gumroad.api_key) {
    console.log("No Gumroad API key - product saved locally");
    return Promise.resolve({ status: "manual", url: null });
  }
  var postData = new URLSearchParams({
    name:           content.name,
    description:    content.description,
    price:          Math.round(price * 100),
    published:      "true",
    tags:           content.keywords.slice(0, 5).join(","),
    custom_receipt: content.thank_you_message,
  }).toString();

  return new Promise(function(resolve) {
    var options = {
      hostname: "api.gumroad.com",
      path:     "/v2/products",
      method:   "POST",
      headers: {
        "Authorization":  "Bearer " + config.gumroad.api_key,
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    };
    var req = https.request(options, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try {
          var r = JSON.parse(data);
          if (r.success) {
            resolve({ status: "published", product_id: r.product.id, url: r.product.short_url || r.product.url, name: r.product.name, price: price });
          } else {
            resolve({ status: "api_error", error: r.message, url: null });
          }
        } catch(e) { resolve({ status: "parse_error", url: null }); }
      });
    });
    req.on("error", function() { resolve({ status: "network_error", url: null }); });
    req.write(postData);
    req.end();
  });
}

function updateGumroadPrice(productId, newPrice) {
  if (!config.gumroad || !config.gumroad.api_key || !productId) { return Promise.resolve(); }
  var postData = new URLSearchParams({ price: Math.round(newPrice * 100) }).toString();
  return new Promise(function(resolve) {
    var options = {
      hostname: "api.gumroad.com",
      path:     "/v2/products/" + productId,
      method:   "PUT",
      headers: {
        "Authorization":  "Bearer " + config.gumroad.api_key,
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    };
    var req = https.request(options, function(res) {
      var d = "";
      res.on("data", function(c) { d += c; });
      res.on("end", function() { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on("error", function() { resolve(null); });
    req.write(postData);
    req.end();
  });
}

function run(nicheName) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  var state = loadState();

  var existing = null;
  for (var i = 0; i < state.products.length; i++) {
    if (state.products[i].niche === nicheName && state.products[i].status === "published") {
      existing = state.products[i];
      break;
    }
  }

  if (existing) {
    var priceData = calculatePrice(nicheName, state.sales_count);
    if (priceData.price > existing.price && existing.product_id) {
      console.log("Price update: $" + existing.price + " to $" + priceData.price);
      return updateGumroadPrice(existing.product_id, priceData.price).then(function() {
        existing.price = priceData.price;
        saveState(state);
        return notify.sendTelegram("Price Updated\n" + existing.name + "\n$" + existing.price + " to $" + priceData.price);
      }).then(function() { return existing; });
    }
    return Promise.resolve(existing);
  }

  console.log("Creating Gumroad product for " + nicheName + "...");
  var priceInfo = calculatePrice(nicheName, state.sales_count);
  console.log("Price: $" + priceInfo.price + " - " + priceInfo.reasoning);

  return writeProductContent(nicheName, priceInfo.product_type, priceInfo.price).then(function(content) {
    console.log("Product: " + content.name);
    var pdfPath = path.join(OUT_DIR, nicheName.replace(/\s+/g, "-").toLowerCase() + ".html");
    generatePDF(content, pdfPath);
    return createGumroadListing(content, priceInfo.price).then(function(listing) {
      console.log("Listing: " + listing.status + " " + (listing.url || "saved locally"));
      var product = {
        niche:      nicheName,
        name:       content.name,
        price:      priceInfo.price,
        product_type: priceInfo.product_type,
        status:     listing.status,
        product_id: listing.product_id || null,
        url:        listing.url || null,
        pdf_path:   pdfPath,
        created:    new Date().toISOString(),
      };
      state.products.push(product);
      state.current_niche = nicheName;
      saveState(state);
      return notify.sendTelegram(
        "Gumroad Product Created!\n\n" +
        content.name + "\n" +
        "Price: $" + priceInfo.price + "\n" +
        (listing.url ? "Live: " + listing.url : "Check output/products/ folder")
      ).then(function() { return product; });
    });
  });
}

function getProductUrl(nicheName) {
  var state = loadState();
  for (var i = 0; i < state.products.length; i++) {
    if (state.products[i].niche === nicheName && state.products[i].url) {
      return state.products[i].url;
    }
  }
  return null;
}

function getStats() {
  var state = loadState();
  var current = null;
  for (var i = 0; i < state.products.length; i++) {
    if (state.products[i].niche === state.current_niche) {
      current = state.products[i];
      break;
    }
  }
  return {
    products_created: state.products.length,
    current_product:  current,
    total_sales:      state.sales_count,
  };
}

module.exports = { run: run, getProductUrl: getProductUrl, getStats: getStats, updateGumroadPrice: updateGumroadPrice };
