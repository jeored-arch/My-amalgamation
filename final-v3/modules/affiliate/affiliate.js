require("dotenv").config();

const ASSOCIATE_ID = process.env.AMAZON_ASSOCIATE_ID || "jeored12-20";

// Evergreen Amazon products that fit ANY small business / AI / productivity niche
// Links auto-include your associate ID
function amazonLink(asin) {
  return "https://www.amazon.com/dp/" + asin + "?tag=" + ASSOCIATE_ID;
}

const AMAZON_PRODUCTS = [
  { name: "The $100 Startup",                asin: "0307951529", category: "business",      commission: "~4%", niches: ["business","startup","entrepreneur","passive income","side hustle"] },
  { name: "Atomic Habits",                   asin: "0735211299", category: "productivity",  commission: "~4%", niches: ["productivity","business","motivation","self improvement","habits"] },
  { name: "AI Superpowers (Kai-Fu Lee)",     asin: "132854639X", category: "ai",            commission: "~4%", niches: ["ai","automation","technology","business","future"] },
  { name: "Building a StoryBrand",           asin: "0718033329", category: "marketing",     commission: "~4%", niches: ["marketing","business","content","branding","sales"] },
  { name: "Profit First",                    asin: "073521414X", category: "finance",       commission: "~4%", niches: ["finance","business","money","accounting","small business"] },
  { name: "Logitech MX Keys (Keyboard)",     asin: "B07S92QBCJ", category: "productivity",  commission: "~3%", niches: ["productivity","remote work","office","work from home","tech"] },
  { name: "Blue Yeti USB Microphone",        asin: "B00N1YPXW2", category: "content",       commission: "~3%", niches: ["content","youtube","podcasting","creator","video","voice"] },
  { name: "Elgato Key Light",                asin: "B07L755X9G", category: "content",       commission: "~3%", niches: ["content","youtube","video","creator","streaming","lighting"] },
  { name: "Show Your Work (Austin Kleon)",   asin: "076117897X", category: "marketing",     commission: "~4%", niches: ["content","marketing","creator","social media","personal brand"] },
  { name: "The Lean Startup",                asin: "0307887898", category: "business",      commission: "~4%", niches: ["startup","business","entrepreneur","product","side hustle"] },
];

const OTHER_PROGRAMS = [
  { name: "ElevenLabs",  url: "https://try.elevenlabs.io/2pu1o9y92jl1", commission: "recurring",      niches: ["ai","voice","content","youtube","video","automation","business","creator","side hustle"] },
  { name: "Canva",       env_key: "AFFILIATE_CANVA",     commission: "$36 per signup",  niches: ["design","canva","social media","content","creative","etsy","business"] },
  { name: "TubeBuddy",   env_key: "AFFILIATE_TUBEBUDDY", commission: "30% recurring",   niches: ["youtube","content","video","creator","side hustle","passive income"] },
  { name: "Systeme.io",  env_key: "AFFILIATE_SYSTEME",   commission: "40% recurring",   niches: ["business","entrepreneur","funnel","ecommerce","passive income","side hustle"] },
];

function getAmazonLinks(nicheName, count) {
  count = count || 3;
  var lower = (nicheName || "").toLowerCase();
  return AMAZON_PRODUCTS
    .map(function(p) {
      return Object.assign({}, p, {
        url: amazonLink(p.asin),
        relevance: p.niches.filter(function(n) { return lower.includes(n); }).length
      });
    })
    .sort(function(a, b) { return b.relevance - a.relevance; })
    .slice(0, count);
}

function getOtherLinks() {
  return OTHER_PROGRAMS.map(function(p) {
    return Object.assign({}, p, { url: p.url || process.env[p.env_key] });
  }).filter(function(p) { return p.url && p.url.length > 5; });
}

function getLinksForNiche(nicheName, count) {
  count = count || 3;
  var lower = (nicheName || "").toLowerCase();
  return getOtherLinks()
    .map(function(l) { return Object.assign({}, l, { relevance: l.niches.filter(function(n) { return lower.includes(n); }).length }); })
    .sort(function(a, b) { return b.relevance - a.relevance; })
    .slice(0, count);
}

function getActiveProduct(nicheName) {
  var links = getLinksForNiche(nicheName, 1);
  if (!links.length) return Promise.resolve(null);
  return Promise.resolve({ name: links[0].name, url: links[0].url, price: links[0].commission });
}

function formatForYouTube(nicheName) {
  var other   = getLinksForNiche(nicheName, 2);
  var amazon  = getAmazonLinks(nicheName, 2);
  var all     = other.concat(amazon);
  if (!all.length) return "";
  return "\n\n🔗 TOOLS & RESOURCES I RECOMMEND:\n" + all.map(function(l) { return "▶ " + l.name + " → " + l.url; }).join("\n");
}

function formatForBlog(nicheName) {
  var other  = getLinksForNiche(nicheName, 2);
  var amazon = getAmazonLinks(nicheName, 3);
  var html   = "";

  if (other.length) {
    html += "\n\n## 🔧 Tools I Use Every Day\n" +
      other.map(function(l) { return "- **[" + l.name + "](" + l.url + ")** — " + l.commission; }).join("\n");
  }

  if (amazon.length) {
    html += "\n\n## 📚 Recommended Reading & Gear\n" +
      amazon.map(function(l) { return "- **[" + l.name + "](" + l.url + ")** — " + l.commission + " commission"; }).join("\n");
  }

  return html;
}

function formatForEmail(nicheName) {
  var amazon = getAmazonLinks(nicheName, 2);
  if (!amazon.length) return "";
  return "\n\nRecommended resources:\n" + amazon.map(function(l) { return "• " + l.name + ": " + l.url; }).join("\n");
}

function getSummary() {
  var other = getOtherLinks();
  return {
    active_programs: other.length + AMAZON_PRODUCTS.length,
    amazon_products: AMAZON_PRODUCTS.length,
    other_programs:  other.map(function(l) { return { name: l.name, commission: l.commission }; }),
    estimated_monthly: "Varies by traffic — Amazon 3-4% per sale, ElevenLabs recurring",
  };
}

module.exports = { getActiveProduct, getLinksForNiche, getAmazonLinks, formatForYouTube, formatForBlog, formatForEmail, getSummary };
