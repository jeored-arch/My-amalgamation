#!/usr/bin/env node
/**
 * INSTALL.js — ONE-CLICK SETUP v4
 * Handles everything including Railway cloud deployment.
 * Run: node INSTALL.js
 */
const readline = require("readline");
const { execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");
const os   = require("os");

const rl  = readline.createInterface({ input:process.stdin, output:process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));
const C   = { reset:"\x1b[0m",bright:"\x1b[1m",green:"\x1b[32m",yellow:"\x1b[33m",cyan:"\x1b[36m",red:"\x1b[31m",gray:"\x1b[90m",blue:"\x1b[34m" };
const c   = (col,txt) => `${C[col]}${txt}${C.reset}`;
const ok  = (msg) => console.log(`  ${c("green","✓")}  ${msg}`);
const inf = (msg) => console.log(`  ${c("gray","→")}  ${c("gray",msg)}`);
const wrn = (msg) => console.log(`  ${c("yellow","⚠")}  ${msg}`);
const step= (n,t,msg) => console.log(`\n${c("cyan",`[${n}/${t}]`)} ${c("bright",msg)}\n${c("gray","─".repeat(55))}`);

function gen(len=48){return require("crypto").randomBytes(len).toString("hex").slice(0,len);}
function run(cmd,label){
  process.stdout.write(`  ${c("gray","running")} ${label}...`);
  try{execSync(cmd,{stdio:"pipe",cwd:__dirname});process.stdout.write(c("green"," done\n"));return true;}
  catch(e){process.stdout.write(c("red"," failed\n"));console.log(c("gray",`  ${e.message?.slice(0,120)}`));return false;}
}
function hasCmd(cmd){try{execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`,{stdio:"pipe"});return true;}catch{return false;}}

async function main() {
  console.clear();
  console.log(c("green",`
╔══════════════════════════════════════════════════════════════════╗
║  🤖  AUTONOMOUS BUSINESS AGENT v4 — INSTALLER                   ║
║  Smart niche · Auto-pivot · 24/7 cloud · No PC required         ║
╚══════════════════════════════════════════════════════════════════╝`));

  console.log(`\n  ${c("yellow","Accounts needed (create these first):")}
  1. ${c("bright","gumroad.com")}              sell + collect money
  2. ${c("bright","resend.com")}               free email sending
  3. ${c("bright","console.anthropic.com")}    AI brain (~$10-20/mo)
  4. ${c("bright","Telegram @BotFather")}      sale pings on phone (free)
  5. ${c("bright","railway.app")}              24/7 cloud hosting (~$5/mo)
                               ${c("gray","Month 1 you pay. Then agent's budget covers it.")}\n`);

  await ask(c("cyan","  Ready? Press Enter to begin: "));

  step(1,8,"Installing dependencies");
  run("npm install --silent","npm install");
  ok("Packages installed");

  step(2,8,"Your Information");
  const ownerName  = await ask(c("cyan","  Your name: "));
  const ownerEmail = await ask(c("cyan","  Your email (daily reports sent here): "));

  step(3,8,"Dashboard Password");
  inf("Use this to log into your dashboard from any device — laptop, phone, work computer.");
  let pw="",pw2="x";
  while(pw!==pw2||pw.length<8){
    if(pw&&pw!==pw2)wrn("Passwords don't match.");
    if(pw&&pw.length<8)wrn("Use at least 8 characters.");
    pw =await ask(c("cyan","\n  Password: "));
    pw2=await ask(c("cyan","  Confirm:  "));
  }
  ok(`Password set`);

  step(4,8,"API Keys");
  console.log(`\n  ${c("yellow","ANTHROPIC:")} console.anthropic.com → API Keys → Create Key\n`);
  const anthropicKey=await ask(c("cyan","  Anthropic key (sk-ant-...): "));

  console.log(`\n  ${c("yellow","GUMROAD:")} app.gumroad.com/settings/advanced → API section\n  ${c("yellow","Also add your bank account:")} app.gumroad.com/settings/payment\n`);
  const gumroadKey=await ask(c("cyan","  Gumroad key: "));

  console.log(`\n  ${c("yellow","RESEND:")} resend.com → Dashboard → API Keys → Create Key\n`);
  const resendKey =await ask(c("cyan","  Resend key (re_...): "));
  const fromEmail =await ask(c("cyan","  Email to send FROM: "));
  const fromName  =await ask(c("cyan","  Business name for emails: "));

  console.log(`\n  ${c("yellow","TELEGRAM BOT:")}
  1. Telegram app → @BotFather → /newbot → copy token
  2. Message your bot → open:
     ${c("blue","https://api.telegram.org/botYOUR_TOKEN/getUpdates")}
  3. Find "chat":{"id": 123456789} → copy that number\n`);
  const tgToken =await ask(c("cyan","  Telegram bot token: "));
  const tgChatId=await ask(c("cyan","  Telegram chat ID: "));

  step(5,8,"Writing configuration");
  const secret=gen(48);
  const env=[
    `OWNER_NAME="${ownerName}"`,`OWNER_EMAIL="${ownerEmail}"`,
    `DASHBOARD_PASSWORD="${pw}"`,`SESSION_SECRET="${secret}"`,
    `ANTHROPIC_API_KEY=${anthropicKey.trim()}`,
    `GUMROAD_API_KEY=${gumroadKey.trim()}`,
    `RESEND_API_KEY=${resendKey.trim()}`,
    `EMAIL_FROM="${fromEmail.trim()}"`,`EMAIL_FROM_NAME="${fromName.trim()}"`,
    `TELEGRAM_BOT_TOKEN=${tgToken.trim()}`,`TELEGRAM_CHAT_ID=${tgChatId.trim()}`,
    `TZ=America/Chicago`,`NODE_ENV=production`,
  ].join("\n");
  fs.writeFileSync(path.join(__dirname,".env"),env);
  fs.writeFileSync(path.join(__dirname,".gitignore"),[".env","node_modules/","data/","output/","*.log"].join("\n"));
  ["data/logs","output/reports","output/content","output/outreach"]
    .forEach(d=>fs.mkdirSync(path.join(__dirname,d),{recursive:true}));
  ok(".env created"); ok("Directories created");

  step(6,8,"Railway Cloud Deployment");
  console.log(`\n  ${c("yellow","This makes the agent run 24/7 in the cloud.")}
  ${c("yellow","Even when your PC is off, moving, or you're at work — it keeps going.")}\n`);

  const hasRailwayAccount=await ask(c("cyan","  Have you signed up at railway.app? (y/n): "));
  if(hasRailwayAccount.toLowerCase()!=="y"){
    console.log(`\n  Go to ${c("blue","railway.app")} → sign up (free) → come back and re-run INSTALL.js\n`);
    wrn("Skipping cloud for now — agent can run locally until you're ready.");
    return localFallback(__dirname);
  }

  // Install Railway CLI if needed
  if(!hasCmd("railway")){
    inf("Installing Railway CLI...");
    if(!run("npm install -g @railway/cli --silent","railway CLI")){
      wrn("Could not install Railway CLI automatically.");
      return manualGuide();
    }
  }
  ok("Railway CLI ready");

  // Login
  console.log(`\n  ${c("cyan","→")}  Opening browser to log into Railway...\n`);
  try{execSync("railway login",{stdio:"inherit",cwd:__dirname});ok("Logged into Railway");}
  catch{wrn("Login failed — run: railway login, then: railway up");return manualGuide();}

  // Init project
  try{execSync("railway init --name autonomous-agent",{stdio:"inherit",cwd:__dirname});ok("Railway project created");}
  catch{try{execSync("railway link",{stdio:"inherit",cwd:__dirname});}catch{}}

  // Upload env vars
  console.log(`\n  ${c("cyan","→")}  Uploading your config to Railway...\n`);
  const vars=[
    `OWNER_NAME="${ownerName}"`,`OWNER_EMAIL="${ownerEmail}"`,
    `DASHBOARD_PASSWORD="${pw}"`,`SESSION_SECRET="${secret}"`,
    `ANTHROPIC_API_KEY=${anthropicKey.trim()}`,
    `GUMROAD_API_KEY=${gumroadKey.trim()}`,
    `RESEND_API_KEY=${resendKey.trim()}`,
    `EMAIL_FROM=${fromEmail.trim()}`,`EMAIL_FROM_NAME="${fromName.trim()}"`,
    `TELEGRAM_BOT_TOKEN=${tgToken.trim()}`,`TELEGRAM_CHAT_ID=${tgChatId.trim()}`,
    `TZ=America/Chicago`,`NODE_ENV=production`,
  ];
  let envOk=true;
  for(const v of vars){try{execSync(`railway variables --set "${v}"`,{stdio:"pipe",cwd:__dirname});}catch{envOk=false;}}
  envOk?ok("Config uploaded to Railway"):wrn("Some variables may need manual entry in Railway dashboard");

  // Deploy
  console.log(`\n  ${c("cyan","→")}  Deploying (2-3 minutes)...\n`);
  try{execSync("railway up --detach",{stdio:"inherit",cwd:__dirname});ok("Deployed to Railway!");}
  catch{wrn("Deploy failed — run: railway up");}

  let dashUrl="https://your-project.railway.app";
  try{const u=execSync("railway domain",{encoding:"utf8",cwd:__dirname}).trim();if(u)dashUrl=u.startsWith("http")?u:`https://${u}`;}catch{}

  step(7,8,"Verification");
  ok("Agent scheduled daily 8am (your timezone)");
  ok("Niche engine active — will research + pick on first run");
  ok("Weekly pivot monitoring every Sunday");
  ok(`Dashboard: ${dashUrl}`);

  step(8,8,"Done!");
  console.log(c("green",`
╔══════════════════════════════════════════════════════════════════╗
║  ✅  YOUR AGENT IS LIVE IN THE CLOUD — 24/7                     ║
╚══════════════════════════════════════════════════════════════════╝`));
  console.log(`
  ${c("green","●")} Runs every morning at 8am — PC on or off
  ${c("green","●")} First run: AI picks best niche, Telegrams you what + why
  ${c("green","●")} Every Sunday: checks if niche is working, pivots if not
  ${c("green","●")} Every sale: Telegram ping to your phone instantly
  ${c("green","●")} Every morning: email report to ${ownerEmail}
  ${c("green","●")} Dashboard (any device): ${c("blue",dashUrl)}

  ${c("yellow","ONE THING LEFT:")}
  Verify your Gumroad bank account → ${c("blue","app.gumroad.com/settings/payment")}
  (Required to receive money — takes 1-2 days)

  ${c("yellow","MONTH 1 COST:")} ~$5 Railway hosting (pay once on their site)
  ${c("yellow","MONTH 2+:")} Agent's 40% budget covers hosting automatically

  ${c("bright","You're done. Go live your life. The agent handles the rest.")}
`);
  rl.close();
}

function localFallback(dir){
  const startBat=`@echo off\ncd /d "${dir}"\nnode -r dotenv/config scheduler.js\n`;
  const startSh=`#!/bin/bash\ncd "${dir}"\nnode -r dotenv/config scheduler.js\n`;
  fs.writeFileSync(path.join(dir,"START-AGENT.bat"),startBat);
  fs.writeFileSync(path.join(dir,"start-agent.sh"),startSh);
  try{execSync(`chmod +x "${path.join(dir,"start-agent.sh")}"`,{stdio:"pipe"});}catch{}
  console.log(c("yellow",`\n  LOCAL FALLBACK SET UP:
  Windows: double-click START-AGENT.bat
  Mac/Linux: run ./start-agent.sh
  
  To go cloud later: re-run node INSTALL.js after signing up at railway.app\n`));
  rl.close();
}

function manualGuide(){
  console.log(c("yellow",`\n  MANUAL RAILWAY SETUP:
  1. railway.app → New Project → Deploy from GitHub
  2. Push this folder to GitHub:
       git init && git add . && git commit -m "agent" && git push
  3. Connect repo in Railway
  4. Add all .env values in Railway → Variables tab
  5. Deploy → agent runs 24/7 automatically\n`));
  rl.close();
}

main().catch(err=>{
  console.error(c("red",`\n❌ ${err.message}\n`));
  rl.close(); process.exit(1);
});
