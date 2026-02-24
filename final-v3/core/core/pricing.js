const NICHE_PRICING = {
  high: {
    keywords: ["finance","investing","real estate","business","entrepreneur","marketing","sales","ecommerce","amazon"],
  },
  medium: {
    keywords: ["ai","productivity","notion","automation","chatgpt","solopreneur","freelance","side hustle","passive income"],
  },
  standard: {
    keywords: ["canva","design","creative","instagram","social media","youtube","content","blogging","etsy"],
  },
};

const PRODUCT_TYPES = {
  checklist_bundle: { launch:7,  growth:9,  standard:17, premium:27, label:"Checklist & Worksheet Bundle" },
  pdf_guide:        { launch:9,  growth:17, standard:27, premium:37, label:"PDF Guide"                    },
  template_pack:    { launch:17, growth:27, standard:37, premium:47, label:"Template Pack"                },
  toolkit:          { launch:27, growth:37, standard:47, premium:67, label:"Complete Toolkit"             },
};

function getNicheLevel(niche) {
  const lower = niche.toLowerCase();
  for (const [level, data] of Object.entries(NICHE_PRICING)) {
    if (data.keywords.some(k => lower.includes(k))) return level;
  }
  return "medium";
}

function getProductType(niche, salesCount) {
  const lower = niche.toLowerCase();
  if (lower.includes("notion") || lower.includes("template") || lower.includes("canva")) return "template_pack";
  if (lower.includes("business") || lower.includes("entrepreneur") || lower.includes("marketing")) return "toolkit";
  if (salesCount < 6) return "checklist_bundle";
  return "pdf_guide";
}

function getStage(salesCount) {
  if (salesCount < 6)  return "launch";
  if (salesCount < 21) return "growth";
  if (salesCount < 51) return "standard";
  return "premium";
}

function snap(price) {
  const points = [7,9,17,19,27,29,37,39,47,49,67,69,97];
  return points.reduce((a, b) => Math.abs(b - price) < Math.abs(a - price) ? b : a);
}

function calculatePrice(nicheName, salesCount = 0) {
  const level      = getNicheLevel(nicheName);
  const type       = getProductType(nicheName, salesCount);
  const stage      = getStage(salesCount);
  const base       = PRODUCT_TYPES[type][stage];
  const multiplier = level === "high" ? 1.2 : level === "standard" ? 0.85 : 1.0;
  const price      = snap(base * multiplier);
  const nextStage  = stage === "launch" ? "growth" : stage === "growth" ? "standard" : "premium";
  const nextPrice  = snap(PRODUCT_TYPES[type][nextStage] * multiplier);
  return {
    price, next_price: nextPrice,
    product_type: type,
    product_label: PRODUCT_TYPES[type].label,
    stage, niche_level: level,
    reasoning: `${level} niche + ${stage} stage (${salesCount} sales) = $${price} for fastest conversion`,
  };
}

module.exports = { calculatePrice, getProductType, getNicheLevel };
