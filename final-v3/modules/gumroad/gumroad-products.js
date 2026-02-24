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
  var types = {
    checklist_bundle: "checklist bundle",
    pdf_guide:        "PDF guide",
    template_pack:    "template pack",
    toolkit:          "toolkit",
  };
  return client.messages.create({
    model:      config.anthropic.model,
    max_tokens: 1200,
    system:     "You create digital products. Return ONLY valid compact JSON. No markdown. No code blocks. No extra text.",
    messages: [{ role: "user", content:
      "Create a digital product.\n" +
      "Niche: " + nicheName + "\n" +
      "Type: " + types[productType] + "\n" +
      "Price: $" + price + "\n\n" +
      "Return this JSON only (keep each field SHORT):\n" +
      "{\"name\":\"product name under 50 chars\",\"tagline\":\"one sentence under 12 words\",\"description\":\"150 word description\",\"bullets\":[\"benefit 1\",\"benefit 2\",\"benefit 3\",\"benefit 4\",\"benefit 5\"],\"section1_heading\":\"heading\",\"section1_content\":\"100 words\",\"section2_heading\":\"heading\",\"section2_content\":\"100 words\",\"section3_heading\":\"heading\",\"section3_content\":\"100 words\",\"thank_you\":\"30 word thank you\",\"keywords\":[\"kw1\",\"kw2\",\"kw3\",\"kw4\",\"kw5\"]}"
    }],
  }).then(function(res) {
    var text  = res.content[0].text.trim();
    // Strip any accidental markdown
    text = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    // Find the JSON object
    var start = text.indexOf("{");
    var end   = text.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON found in response");
    return JSON.parse(text.slice(start, end + 1));
  });
}

function generatePDF(content, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  var bullets = (content.bullets || []).map(function(b) { return "<li>" + b + "</li>"; }).join("");
  var sections = [1,2,3].map(function(n) {
    var h = content["section" + n + "_heading"] || "";
    var c = content["section" + n + "_content"] || "";
    return h ? "<div class='section'><h2>" + n + ". " + h + "</h2><p>" + c + "</p></div>" : "";
  }).join("");

  var html = "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>" + (content.name||"Guide") + "</title>" +
    "<style>body{font-family:Georgia,serif;max-width:700px;margin:0 auto;padding:40px 20px;color:#1a1a2e;line-height:1.8}" +
    "h1{font-size:28px;color:#0d1b2a;border-bottom:3px solid #00d4aa;padding-bottom:12px}" +
    "h2{font-size:20px;color:#0d1b2a;margin-top:36px}p{margin:12px 0}" +
    "ul{margin:16px 0;padding-left:24px}li{margin:8px 0}" +
    ".cover{text-align:center;padding:40px 0;border-bottom:1px solid #eee;margin-bottom:32px}" +
    ".tagline{font-size:16px;color:#555;font-style:italic}" +
    ".included{background:#f8f9fa;border-left:4px solid #00d4aa;padding:16px 20px;margin:24px 0}" +
    ".section{margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid #f0f0f0}" +
    ".footer{margin-top:40px;text-align:center;font-size:13px;color:#999}</style></head><body>" +
    "<div class='cover'><h1>" + (content.name||"Guide") + "</h1><p class='tagline'>" + (content.tagline||"") + "</p></div>" +
    "<div class='included'><strong>What's Inside:</strong><ul>" + bullets + "</ul></div>" +
    sections +
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
  var desc = (content.description || content.tagline || content.name || "").slice(0, 500);
  var postData = new URLSearchParams({
    name:           (content.name || "Digital Guide").slice(0, 100),
    description:    desc,
    price:          Math.round(price * 100),
    published:      "true",
    tags:           (content.keywords || []).slice(0, 5).join(","),
    custom_receipt: (content.thank_you || "Thank you!").slice(0, 200),
  }).toString();

  return new Promise(function(resolve) {
    var options = {
      hostname: "api.gumroad.com", path: "/v2/products", method: "POST",
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
            resolve({ status:"published", product_id:r.product.id, url:r.product.short_url||r.product.url, price:price });
          } else {
            resolve({ status:"api_error", error:r.message, url:null });
          }
        } catch(e) { resolve({ status:"parse_error", url:null }); }
      });
    });
    req.on("error", function() { resolve({ status:"network_error", url:null }); });
    req.write(postData); req.end();
  });
}

function updateGumroadPrice(productId, newPrice) {
  if (!config.gumroad || !config.gumroad.api_key || !productId) return Promise.resolve();
  var postData = new URLSearchParams({ price: Math.round(newPrice * 100) }).toString();
  return new Promise(function(resolve) {
    var opts = {
      hostname: "api.gumroad.com", path: "/v2/products/" + productId, method: "PUT",
      headers: {
        "Authorization":  "Bearer " + config.gumroad.api_key,
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    };
    var req = https.request(opts, function(res) {
      var d = ""; res.on("data", function(c) { d += c; });
      res.on("end", function() { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on("error", function() { resolve(null); });
    req.write(postData); req.end();
  });
}

function run(nicheName) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  var state = loadState();

  // Check for existing product
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
        return notify.sendTelegram("Price Updated\n" + existing.name + "\n$" + existing.price + " to $" + pd.price);
      }).then(function() { return existing; });
    }
    return Promise.resolve(existing);
  }

  // Create new product
  console.log("\n  Creating Gumroad product for " + nicheName + "...");
  var pi = calculatePrice(nicheName, state.sales_count);
  console.log("     → Price: $" + pi.price + " — " + pi.reasoning);

  return writeProductContent(nicheName, pi.product_type, pi.price).then(function(content) {
    console.log("     → Product: " + content.name);
    var pdfPath = path.join(OUT_DIR, nicheName.replace(/\s+/g,"-").toLowerCase().slice(0,40) + ".html");
    generatePDF(content, pdfPath);

    return createGumroadListing(content, pi.price).then(function(listing) {
      console.log("     → " + listing.status + " " + (listing.url || "saved locally"));
      var product = {
        niche: nicheName, name: content.name, price: pi.price,
        product_type: pi.product_type, status: listing.status,
        product_id: listing.product_id || null, url: listing.url || null,
        pdf_path: pdfPath, created: new Date().toISOString(),
      };
      state.products.push(product);
      state.current_niche = nicheName;
      saveState(state);

      return notify.sendTelegram(
        "Gumroad Product Created!\n\n" +
        (content.name || nicheName) + "\nPrice: $" + pi.price + "\n" +
        (listing.url ? "Live: " + listing.url : "Saved locally — upload manually to Gumroad")
      ).then(function() { return product; });
    });
  }).catch(function(err) {
    console.log("     → Product creation failed: " + err.message + " — will retry tomorrow");
    return { niche: nicheName, name: nicheName, price: pi.price, status: "pending", url: null };
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
