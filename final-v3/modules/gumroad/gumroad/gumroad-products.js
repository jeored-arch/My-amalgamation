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
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  }
  return { products: [], sales_count: 0, current_niche: null };
}

function saveState(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...s, updated: new Date().toISOString() }, null, 2));
}

async function writeProductContent(nicheName, productType, price) {
  console.log(`     → Writing product content...`);
  const types = {
    checklist_bundle: "a checklist and worksheet bundle",
    pdf_guide:        "a comprehensive PDF guide",
    template_pack:    "a ready-to-use template pack",
    toolkit:          "a complete toolkit and system",
  };
  const res = await client.messages.create({
    model: config.anthropic.model, max_tokens: 3000,
    system: "You are an expert digital product creator. Write products that genuinely help people and convert browsers into buyers. Real useful content — no filler.",
    messages: [{ role: "user", content:
      `Create a complete digital product for the niche: "${nicheName}"
Product type: ${types[productType]}
Price: $${price}

Return ONLY valid JSON:
{
  "name": "Product name — compelling, specific, benefit-driven, under 60 chars",
  "tagline": "One sentence that sells it in under 15 words",
  "description": "400-word Gumroad description. Lead with the problem, then solution, then bullet points of what's included, then a closing line.",
  "bullets": ["5 specific bullet points of what they get"],
  "pdf_sections": [
    { "heading": "Section heading", "content": "300 words of genuinely useful content" }
  ],
  "thank_you_message": "50 words shown after purchase — warm and helpful",
  "keywords": ["8 SEO keywords for Gumroad search"]
}`
    }]
  });
  const clean = res.content[0].text.replace(/```json\n?/g,"").replace(/```/g,"").trim();
  return JSON.parse(clean);
}

function generatePDF(content, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const sections = content.pdf_sections.map((s, i) => `
    <div class="section">
      <h2>${i+1}. ${s.heading}</h2>
      <p>${s.content.replace(/\n/g,"</p><p>")}</p>
    </div>`).join("");
  const bullets = content.bullets.map(b => `<li>${b}</li>`).join("");
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${content.name}</title>
<style>
  body{font-family:Georgia,serif;max-width:700px;margin:0 auto;padding:40px 20px;color:#1a1a2e;line-height:1.8}
  h1{font-size:28px;color:#0d1b2a;border-bottom:3px solid #00d4aa;padding-bottom:12px}
  .tagline{font-size:16px;color:#555;font-style:italic;margin-bottom:32px}
  h2{font-size:20px;color:#0d1b2a;margin-top:36px}
  p{margin:12px 0}ul{margin:16px 0;padding-left:24px}li{margin:8px 0}
  .cover{text-align:center;padding:60px 0;border-bottom:1px solid #eee;margin-bottom:40px}
  .section{margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid #f0f0f0}
  .included{background:#f8f9fa;border-left:4px solid #00d4aa;padding:20px 24px;margin:24px 0;border-radius:0 8px 8px 0}
  .footer{margin-top:48px;text-align:center;font-size:13px;color:#999}
</style></head><body>
  <div class="cover"><h1>${content.name}</h1><p class="tagline">${content.tagline}</p></div>
  <div class="included"><strong>What's Inside:</strong><ul>${bullets}</ul></div>
  ${sections}
  <div class="footer">${content.thank_you_message}</div>
</body></html>`;
  fs.writeFileSync(outputPath, html);
  return outputPath;
}

async function createGumroadListing(content, price) {
  if (!config.gumroad?.api_key) {
    console.log("     → No Gumroad API key — product saved locally");
    return { status: "manual", url: null };
  }
  const postData = new URLSearchParams({
    name:           content.name,
    description:    content.description,
    price:          Math.round(price * 100),
    published:      "true",
    tags:           content.keywords.slice(0,5).join(","),
    custom_receipt: content.thank_you_message,
  }).toString();

  return new Promise((resolve) => {
    const options = {
      hostname: "api.gumroad.com", path: "/v2/products", method: "POST",
      headers: {
        "Authorization": `Bearer ${config.gumroad.api_key}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const r = JSON.parse(data);
          if (r.success) {
            resolve({ status:"published", product_id:r.product.id, url:r.product.short_url||r.product.url, name:r.product.name, price });
          } else {
            resolve({ status:"api_error", error:r.message, url:null });
          }
        } catch { resolve({ status:"parse_error", url:null }); }
      });
    });
    req.on("error", () => resolve({ status:"network_error", url:null }));
    req.write(postData); req.end();
  });
}

async function updateGumroadPrice(productId, newPrice) {
  if (!config.gumroad?.api_key || !productId) return;
  const postData = new URLSearchParams({ price: Math.round(newPrice * 100) }).toString();
  return new Promise((resolve) => {
    const options = {
      hostname: "api.gumroad.com", path: `/v2/products/${productId}`, method: "PUT",
      headers: {
        "Authorization": `Bearer ${config.gumroad.api_key}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.write(postData); req.end();
  });
}

async function run(nicheName) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const state = loadState();

  // Already have a live product for this niche
  const existing = state.products.find(p => p.niche === nicheName && p.status === "published");
  if (existing) {
    const { price: newPrice, stage } = calculatePrice(nicheName, state.sales_count);
    if (newPrice > existing.price && existing.product_id) {
      console.log(`     → Price update: $${existing.price} → $${newPrice} (${stage})`);
      await updateGumroadPrice(existing.product_id, newPrice);
      existing.price = newPrice;
      saveState(state);
      await notify.sendTelegram(`📈 <b>Price Updated</b>\n"${existing.name}"\n$${existing.price} → $${newPrice}\n${state.sales_count} sales reached ${stage} tier`);
    }
    return existing;
  }

  // Create new product
  console.log(`\n  🛍️  Creating Gumroad product for "${nicheName}"...`);
  const { price, product_type, product_label, reasoning } = calculatePrice(nicheName, state.sales_count);
  console.log(`     → Price: $${price} — ${reasoning}`);

  const content = await writeProductContent(nicheName, product_type, price);
  console.log(`     → "${content.name}"`);

  const pdfPath = path.join(OUT_DIR, `${nicheName.replace(/\s+/g,"-").toLowerCase()}.html`);
  generatePDF(content, pdfPath);

  const listing = await createGumroadListing(content, price);
  console.log(`     → ${listing.status} ${listing.url || "(saved locally)"}`);

  const product = {
    niche: nicheName, name: content.name, price,
    product_type, status: listing.status,
    product_id: listing.product_id || null,
    url: listing.url || null,
    pdf_path: pdfPath,
    created: new Date().toISOString(),
  };
  state.products.push(product);
  state.current_niche = nicheName;
  saveState(state);

  await notify.sendTelegram(`
🛍️ <b>Gumroad Product Created!</b>

"<b>${content.name}</b>"
Price: $${price}
Type: ${product_label}
${listing.url ? `✅ Live: ${listing.url}` : "⚠️ Check output/products/ — upload manually to Gumroad"}

Price raises automatically as sales come in.
Your affiliate links are embedded in all content.
  `.trim());

  auditLog("GUMROAD_PRODUCT_CREATED", { name:content.name, price, niche:nicheName, status:listing.status });
  return product;
}

function getProductUrl(nicheName) {
  const state = loadState();
  return state.products.find(p => p.niche === nicheName && p.url)?.url || null;
}

function getStats() {
  const state = loadState();
  return {
    products_created: state.products.length,
    current_product:  state.products.find(p => p.niche === state.current_niche),
    total_sales:      state.sales_count,
  };
}

module.exports = { run, getProductUrl, getStats, updateGumroadPrice };
