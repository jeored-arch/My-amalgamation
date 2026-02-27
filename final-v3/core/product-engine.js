/**
 * product-engine.js — Autonomous Product Creation & Market Intelligence
 *
 * Researches what sells, undercuts competitors, creates real products,
 * generates PDFs, and publishes to the self-hosted store — all without human input.
 *
 * Data: data/products.json
 */

"use strict";

const fs    = require("fs");
let storeModule = null;
try { storeModule = require("./store"); } catch(e) {}
const path  = require("path");
const https = require("https");

const DATA_DIR      = path.join(process.cwd(), "data");
const OUT_DIR       = path.join(process.cwd(), "output", "products");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");

// ── PERSISTENCE ───────────────────────────────────────────────────────────────

function loadProducts() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) return JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
  } catch(e) {}
  return { products: [], total_revenue: 0, best_product: null };
}

function saveProducts(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  data.updated = new Date().toISOString();
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(data, null, 2));
}

// ── CLAUDE HELPER ─────────────────────────────────────────────────────────────

function callClaude(prompt, apiKey, model, maxTokens) {
  return new Promise(function(resolve) {
    const body = JSON.stringify({
      model:      model || "claude-haiku-4-5-20251001",
      max_tokens: maxTokens || 1200,
      messages:   [{ role: "user", content: prompt }],
    });
    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, function(res) {
      var raw = "";
      res.on("data", function(d) { raw += d; });
      res.on("end", function() {
        try { resolve(JSON.parse(raw).content[0].text); } catch(e) { resolve(""); }
      });
    });
    req.on("error", function() { resolve(""); });
    req.write(body); req.end();
  });
}

function parseJSON(text) {
  try {
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    return JSON.parse(text.slice(s, e + 1));
  } catch(e) { return null; }
}

// ── STEP 1: MARKET RESEARCH ───────────────────────────────────────────────────

async function researchMarket(niche, apiKey, model) {
  console.log("     → Market research: " + niche);
  const text = await callClaude(
    "You are a digital product market expert. Analyze this niche and find the best product opportunity.\n\n" +
    "NICHE: " + niche + "\n\n" +
    "Find a product that:\n" +
    "- Solves a specific painful problem buyers have RIGHT NOW\n" +
    "- Can be underpriced vs competitors by 20-40% and still profitable\n" +
    "- Can be created with text/templates (PDF, checklist, email course, swipe file, toolkit)\n" +
    "- Has HIGH demand and LOW competition\n\n" +
    "Return ONLY valid JSON, no markdown:\n" +
    "{\"opportunity\":\"one line market gap\",\"type\":\"pdf_guide\",\"title\":\"exact title that makes people buy\",\"hook\":\"why they need it now\",\"competitor_price\":27,\"our_price\":17,\"why_they_buy\":\"specific pain point solved\",\"market_insight\":\"key buyer psychology insight\"}",
    apiKey, model, 600
  );
  return parseJSON(text) || { type: "pdf_guide", title: "The Complete " + niche + " Guide", competitor_price: 27, our_price: 17, opportunity: "High demand, underserved market" };
}

// ── STEP 2: GENERATE PRODUCT CONTENT ─────────────────────────────────────────

async function generateContent(research, niche, apiKey, model) {
  console.log("     → Writing content: " + research.type);
  const typeInstructions = {
    pdf_guide:        "Write a 7-section PDF guide. Each section: title + 300 words of real actionable content.",
    checklist_bundle: "Write 4 checklists with 10 items each. Each item: specific, actionable.",
    swipe_file:       "Write 10 copy templates with [VARIABLE] placeholders. Each: name, use case, full template.",
    email_course:     "Write a 5-day email course. Each day: subject line + 250 word email body.",
    toolkit:          "Write a 5-section toolkit with real tools, resources, and step-by-step instructions.",
    notion_template:  "Describe 4 Notion database templates with fields, views, and usage instructions.",
  };
  const instructions = typeInstructions[research.type] || typeInstructions.pdf_guide;

  const text = await callClaude(
    "Create a premium digital product. Return ONLY valid JSON.\n\n" +
    "Product: " + research.title + "\nNiche: " + niche + "\nPrice: $" + research.our_price + "\n" +
    "Why they buy: " + (research.why_they_buy || research.hook || "") + "\n\n" +
    instructions + "\n\n" +
    "Return this JSON:\n" +
    "{\"name\":\"" + research.title + "\",\"tagline\":\"subtitle\",\"description\":\"150 word sales copy\",\"sections\":[{\"title\":\"Section Title\",\"content\":\"300+ words of real content\"}],\"bullets\":[\"benefit 1\",\"benefit 2\",\"benefit 3\",\"benefit 4\",\"benefit 5\"],\"conclusion\":\"closing paragraph\",\"keywords\":[\"kw1\",\"kw2\"]}",
    apiKey, model, 3500
  );
  return parseJSON(text) || { name: research.title, tagline: "The complete guide", description: "Everything you need for " + niche, sections: [{ title: "Getting Started", content: "Step-by-step guide to mastering " + niche }], bullets: ["Actionable", "Proven", "Fast results"], conclusion: "Take action now.", keywords: [niche] };
}

// ── STEP 3: GENERATE PDF ──────────────────────────────────────────────────────

function generatePDF(content, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  function esc(s) { return String(s||"").replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)").replace(/[^\x20-\x7E]/g," "); }
  function wrap(text, max) {
    const words = String(text||"").split(" "); const lines = []; let line = "";
    for (const w of words) {
      if ((line+" "+w).trim().length > max) { if(line) lines.push(line.trim()); line = w; }
      else { line = (line+" "+w).trim(); }
    } if (line) lines.push(line.trim()); return lines;
  }

  const streams = [];

  // Cover page
  let cover = ["BT /F1 26 Tf 50 760 Td (" + esc(content.name) + ") Tj ET",
    "BT /F2 13 Tf 50 720 Td (" + esc(content.tagline) + ") Tj ET",
    "0.15 0.35 0.75 rg 50 710 495 2 re f 0 0 0 rg"];
  let y = 685;
  (content.bullets||[]).slice(0,5).forEach(function(b) {
    cover.push("BT /F2 11 Tf 60 " + y + " Td (  checkmark  " + esc(b) + ") Tj ET"); y -= 22;
  });
  cover.push("BT /F2 9 Tf 50 50 Td (For personal use only.) Tj ET");
  streams.push(cover.join("\n"));

  // Intro page from description
  if (content.description) {
    const lines = ["BT /F1 16 Tf 50 760 Td (Introduction) Tj ET", "0.15 0.35 0.75 RG 50 752 495 1 re S 0 0 0 RG"];
    let iy = 730;
    wrap(content.description, 88).forEach(function(l) { lines.push("BT /F2 11 Tf 50 " + iy + " Td (" + esc(l) + ") Tj ET"); iy -= 16; });
    streams.push(lines.join("\n"));
  }

  // Content sections
  (content.sections||[]).forEach(function(section, i) {
    const slines = ["BT /F1 16 Tf 50 760 Td (" + esc(section.title||("Section "+(i+1))) + ") Tj ET",
      "0.15 0.35 0.75 RG 50 752 495 1 re S 0 0 0 RG"];
    let sy = 730;
    const body = section.content || section.body || section.template || (section.items||[]).map(function(it,j){return (j+1)+". "+it;}).join(" ");
    wrap(body, 88).forEach(function(l) {
      if (sy < 60) return;
      slines.push("BT /F2 11 Tf 50 " + sy + " Td (" + esc(l) + ") Tj ET"); sy -= 16;
    });
    slines.push("BT /F2 8 Tf 50 40 Td (Page " + (i+3) + ") Tj ET");
    streams.push(slines.join("\n"));
  });

  // Conclusion
  if (content.conclusion) {
    const clines = ["BT /F1 16 Tf 50 760 Td (Conclusion) Tj ET", "0.15 0.35 0.75 RG 50 752 495 1 re S 0 0 0 RG"];
    let cy = 730;
    wrap(content.conclusion, 88).forEach(function(l) { clines.push("BT /F2 11 Tf 50 " + cy + " Td (" + esc(l) + ") Tj ET"); cy -= 16; });
    streams.push(clines.join("\n"));
  }

  // Build PDF
  let pdf = "%PDF-1.4\n"; const xref = {}; const objs = [];
  function obj(id, c) { xref[id] = pdf.length; pdf += id + " 0 obj\n" + c + "\nendobj\n"; }

  const pageIds = []; let nextId = 5;
  for (const stream of streams) {
    const sid = nextId++;
    objs.push([sid, "<< /Length " + Buffer.byteLength(stream, "latin1") + " >>\nstream\n" + stream + "\nendstream"]);
    const pid = nextId++;
    objs.push([pid, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents " + sid + " 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>"]);
    pageIds.push(pid);
  }

  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [" + pageIds.map(function(id){return id+" 0 R";}).join(" ") + "] /Count " + pageIds.length + " >>");
  obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  for (const [id, c] of objs) { obj(id, c); }

  const xrefPos = pdf.length;
  const maxId   = nextId - 1;
  pdf += "xref\n0 " + (maxId + 1) + "\n0000000000 65535 f \n";
  for (let i = 1; i <= maxId; i++) { pdf += String(xref[i]||0).padStart(10,"0") + " 00000 n \n"; }
  pdf += "trailer\n<< /Size " + (maxId+1) + " /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF\n";

  fs.writeFileSync(outputPath, pdf, "latin1");
  console.log("     → PDF: " + streams.length + " pages, " + Math.round(pdf.length/1024) + "KB — " + path.basename(outputPath));
  return outputPath;
}

// ── STEP 4: PUBLISH TO OUR OWN STORE ─────────────────────────────────────────
// Self-hosted store on Railway — no platform fees, full control.
// Stripe handles payments, Resend handles email delivery.

async function publishToStore(content, pdfPath, price, niche, type) {
  console.log("     → Publishing to store...");
  try {
    // Inline product creation — writes directly to store-products.json
    var DATA_DIR   = require("path").join(process.cwd(), "data");
    var STORE_FILE = require("path").join(DATA_DIR, "store-products.json");
    require("fs").mkdirSync(DATA_DIR, { recursive: true });

    var storeData = { products: [], orders: [] };
    try { storeData = JSON.parse(require("fs").readFileSync(STORE_FILE, "utf8")); } catch(e) {}

    // Skip duplicates
    var existing = storeData.products.find(function(p) { return p.name === content.name; });
    if (existing) {
      console.log("     → Store: already exists — " + (content.name||"").slice(0,50));
      var baseUrl0 = process.env.RAILWAY_PUBLIC_DOMAIN ? "https://"+process.env.RAILWAY_PUBLIC_DOMAIN : "http://localhost:"+(process.env.PORT||3000);
      return { id: existing.id, url: baseUrl0+"/store/buy/"+existing.id, name: existing.name, price: existing.price };
    }

    var productId = "prod_" + Date.now();
    var entry = {
      id:          productId,
      name:        content.name || "Digital Guide",
      description: content.description || content.tagline || "A helpful digital guide.",
      price:       price,
      file_path:   pdfPath,
      niche:       niche || "",
      type:        type || "pdf_guide",
      created:     new Date().toISOString(),
      sales:       0,
      active:      true,
    };
    storeData.products.push(entry);
    storeData.updated = new Date().toISOString();
    require("fs").writeFileSync(STORE_FILE, JSON.stringify(storeData, null, 2));

    var baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
      : "http://localhost:" + (process.env.PORT || 3000);
    var storeUrl = baseUrl + "/store/buy/" + productId;
    console.log("     ✓ Store: added [" + entry.name.slice(0,50) + "] @ $" + price);
    console.log("     ✓ Live on store: " + storeUrl);
    return { id: productId, url: storeUrl, name: entry.name, price };
  } catch(e) {
    console.log("     → Store publish error: " + e.message.slice(0,100));
    return null;
  }

}

// ── STATS & TRACKING ──────────────────────────────────────────────────────────

function recordProduct(name, type, niche, price, url, platform) {
  const data = loadProducts();
  data.products.push({ date: new Date().toISOString(), name, type, niche, price, url, platform, sales: 0, revenue: 0 });
  saveProducts(data);
}

function getStats() {
  const data = loadProducts();
  return { products_created: data.products.length, total_revenue: data.total_revenue, best_product: data.best_product };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function run(niche, apiKey, model) {
  console.log("\n  🏭 Product Engine...");
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // One product per day max
  const data      = loadProducts();
  const today     = new Date().toDateString();
  const madeToday = data.products.filter(function(p) { return new Date(p.date).toDateString() === today; });
  if (madeToday.length >= 1) {
    console.log("     → Product already made today — skipping");
    return { status: "skipped" };
  }

  try {
    // Research → Content → PDF → Publish
    const research = await researchMarket(niche, apiKey, model);
    console.log("     → Type: " + research.type + " | Price: $" + research.competitor_price + " → $" + research.our_price + " (undercut)");

    const content  = await generateContent(research, niche, apiKey, model);
    const safeName = (content.name||research.title).replace(/[^a-z0-9]+/gi,"-").toLowerCase().slice(0,40);
    const pdfPath  = path.join(OUT_DIR, safeName + ".pdf");
    generatePDF(content, pdfPath);

    // Add to our own Railway store
    let published = null;
    if (storeModule) {
      published = storeModule.addProduct({
        name:        content.name,
        description: content.description || content.tagline || research.opportunity || "",
        price:       research.our_price,
        pdfPath,
        type:        research.type,
        niche,
      });
      if (published) console.log("     ✓ Live at: /store/" + published.slug);
    }
    recordProduct(content.name, research.type, niche, research.our_price, published ? ("/store/" + published.slug) : null, "store");

    return {
      status:           "created",
      type:             research.type,
      title:            content.name,
      price:            research.our_price,
      competitor_price: research.competitor_price,
      pdf_path:         pdfPath,
      url:              published ? published.url : null,
      insight:          research.market_insight || research.opportunity,
    };
  } catch(e) {
    console.log("     → Product engine error: " + e.message.slice(0,100));
    return { status: "error", message: e.message };
  }
}

module.exports = { run, getStats, generatePDF, researchMarket };
