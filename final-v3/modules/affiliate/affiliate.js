require("dotenv").config();

const PROGRAMS = [
  { name:"ElevenLabs",  env_key:"AFFILIATE_ELEVENLABS", commission:"recurring",           url_override:"https://try.elevenlabs.io/2pu1o9y92jl1", niches:["ai","voice","content","youtube","video","automation","business","creator","side hustle"] },
  { name:"Canva",       env_key:"AFFILIATE_CANVA",      commission:"$36 per signup",      niches:["design","canva","social media","content","creative","etsy","business"] },
  { name:"ConvertKit",  env_key:"AFFILIATE_CONVERTKIT", commission:"30% recurring",       niches:["email","marketing","business","creator","blogger","side hustle","passive income"] },
  { name:"Notion",      env_key:"AFFILIATE_NOTION",     commission:"$5 per signup",       niches:["notion","productivity","ai","business","solopreneur","freelance","automation"] },
  { name:"Jasper AI",   env_key:"AFFILIATE_JASPER",     commission:"30% recurring",       niches:["ai","content","marketing","writing","business","automation","chatgpt"] },
  { name:"Beehiiv",     env_key:"AFFILIATE_BEEHIIV",    commission:"50% for 12 months",   niches:["email","newsletter","creator","passive income","side hustle","marketing"] },
  { name:"Systeme.io",  env_key:"AFFILIATE_SYSTEME",    commission:"40% recurring",       niches:["business","entrepreneur","funnel","ecommerce","passive income","side hustle"] },
  { name:"TubeBuddy",   env_key:"AFFILIATE_TUBEBUDDY",  commission:"30% recurring",       niches:["youtube","content","video","creator","side hustle","passive income"] },
];

function getLinks() {
  return PROGRAMS.map(p => ({
    ...p,
    url: p.url_override || process.env[p.env_key]
  })).filter(p => p.url && p.url.trim().length > 5);
}

function getLinksForNiche(nicheName, count) {
  count = count || 3;
  var lower = (nicheName || "").toLowerCase();
  return getLinks()
    .map(function(l) { return Object.assign({}, l, { relevance: l.niches.filter(function(n) { return lower.includes(n); }).length }); })
    .sort(function(a, b) { return b.relevance - a.relevance; })
    .slice(0, count);
}

// Called by agent.js — returns the top affiliate product for the current niche
function getActiveProduct(nicheName) {
  var links = getLinksForNiche(nicheName, 1);
  if (!links.length) return Promise.resolve(null);
  var top = links[0];
  return Promise.resolve({
    name:  top.name,
    url:   top.url,
    price: top.commission,
  });
}

function formatForYouTube(nicheName) {
  var links = getLinksForNiche(nicheName, 3);
  if (!links.length) return "";
  return "\n\n🔗 TOOLS I RECOMMEND:\n" + links.map(function(l) { return "▶ " + l.name + " → " + l.url; }).join("\n");
}

function formatForEmail(nicheName) {
  var links = getLinksForNiche(nicheName, 2);
  if (!links.length) return "";
  return "\n\nTools that can help:\n" + links.map(function(l) { return "• " + l.name + ": " + l.url; }).join("\n");
}

function formatForBlog(nicheName) {
  var links = getLinksForNiche(nicheName, 3);
  if (!links.length) return "";
  return "\n\n## Recommended Tools\n" + links.map(function(l) { return "- **[" + l.name + "](" + l.url + ")** — " + l.commission; }).join("\n");
}

function getSummary() {
  var links = getLinks();
  return {
    active_programs: links.length,
    programs: links.map(function(l) { return { name: l.name, commission: l.commission }; }),
    estimated_monthly: links.length > 0 ? "$" + (links.length * 15) + "-" + (links.length * 80) + "/mo from clicks" : "No links set yet",
  };
}

module.exports = { getLinks, getLinksForNiche, getActiveProduct, formatForYouTube, formatForEmail, formatForBlog, getSummary };
