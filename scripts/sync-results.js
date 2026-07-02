// scripts/sync-results.js
const fs = require("fs");
const path = require("path");

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const DB_PATH = "worldcup2026";
const FINISHED_STATUSES = new Set(["FINISHED", "AWARDED"]);
const KNOCKOUT_STAGES = new Set(["LAST_32","LAST_16","QUARTER_FINALS","SEMI_FINALS","THIRD_PLACE","FINAL"]);

if (!FIREBASE_DB_URL) { console.error("Thiếu FIREBASE_DB_URL"); process.exit(1); }
if (!FOOTBALL_DATA_TOKEN) { console.error("Thiếu FOOTBALL_DATA_TOKEN"); process.exit(1); }

const MATCHES = JSON.parse(fs.readFileSync(path.join(__dirname, "matches.json"), "utf-8"));

// Chuẩn hóa: lowercase, bỏ dấu, bỏ ký tự đặc biệt, chuẩn hóa khoảng trắng
const normalize = (s) => (s || "").toLowerCase()
  .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g,"a").replace(/[èéẹẻẽêềếệểễ]/g,"e")
  .replace(/[ìíịỉĩ]/g,"i").replace(/[òóọỏõôồốộổỗơờớợởỡ]/g,"o")
  .replace(/[ùúụủũưừứựửữ]/g,"u").replace(/đ/g,"d")
  .replace(/[üúû]/g,"u").replace(/[éê]/g,"e").replace(/[áâã]/g,"a")
  .replace(/[óô]/g,"o").replace(/í/g,"i").replace(/ç/g,"c")
  .replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();

// Bảng ánh xạ VN -> tên chuẩn hóa để so sánh
const VN_MAP = {
  "Thổ Nhĩ Kỳ":"turkiye","Bờ Biển Ngà":"ivory coast","Nam Phi":"south africa",
  "Hàn Quốc":"south korea","Séc":"czechia","Bosnia & Herzegovina":"bosnia and herzegovina",
  "Hà Lan":"netherlands","Nhật Bản":"japan","Thụy Sĩ":"switzerland","Thụy Điển":"sweden",
  "Tây Ban Nha":"spain","Ả Rập Saudi":"saudi arabia","Na Uy":"norway","Pháp":"france",
  "Đức":"germany","Bỉ":"belgium","Anh":"england","Áo":"austria",
  "CHDC Congo":"dr congo","Mỹ":"usa","Curaçao":"curacao","Cabo Verde":"cabo verde",
  "New Zealand":"new zealand","Thành":"thanh",
};
// Ánh xạ ngược: EN norm -> VN
const EN_TO_VN = {
  "turkiye":"Thổ Nhĩ Kỳ","ivory coast":"Bờ Biển Ngà","south africa":"Nam Phi",
  "south korea":"Hàn Quốc","czechia":"Séc","czech republic":"Séc",
  "bosnia and herzegovina":"Bosnia & Herzegovina","bosnia herzegovina":"Bosnia & Herzegovina",
  "netherlands":"Hà Lan","japan":"Nhật Bản","switzerland":"Thụy Sĩ","sweden":"Thụy Điển",
  "spain":"Tây Ban Nha","saudi arabia":"Ả Rập Saudi","norway":"Na Uy","france":"Pháp",
  "germany":"Đức","belgium":"Bỉ","england":"Anh","austria":"Áo",
  "dr congo":"CHDC Congo","democratic republic of the congo":"CHDC Congo","congo dr":"CHDC Congo",
  "usa":"Mỹ","united states":"Mỹ","curacao":"Curaçao","curaçao":"Curaçao",
  "cabo verde":"Cabo Verde","cape verde":"Cabo Verde","new zealand":"New Zealand",
  "turkey":"Thổ Nhĩ Kỳ","cote divoire":"Bờ Biển Ngà","ivory coast":"Bờ Biển Ngà",
  "korea republic":"Hàn Quốc","canada":"Canada","australia":"Australia",
  "qatar":"Qatar","iran":"Iran","egypt":"Egypt","ghana":"Ghana","panama":"Panama",
  "croatia":"Croatia","scotland":"Scotland","morocco":"Morocco","haiti":"Haiti",
  "iraq":"Iraq","senegal":"Senegal","ecuador":"Ecuador","tunisia":"Tunisia",
  "uruguay":"Uruguay","paraguay":"Paraguay","jordan":"Jordan","algeria":"Algeria",
  "portugal":"Portugal","uzbekistan":"Uzbekistan","colombia":"Colombia","mexico":"Mexico",
  "argentina":"Argentina","brazil":"Brazil",
  // Extra aliases from API variations
  "united states":"Mỹ","türkiye":"Thổ Nhĩ Kỳ",
  "bosnia-herzegovina":"Bosnia & Herzegovina","bosnia herzegovina":"Bosnia & Herzegovina",
  "cape verde islands":"Cabo Verde","cape verde":"Cabo Verde",
  "congo dr":"CHDC Congo","dr congo":"CHDC Congo","congo, dr":"CHDC Congo",
  "democratic republic of the congo":"CHDC Congo",
};

function vnNorm(vn){ return VN_MAP[vn] || normalize(vn); }
function apiToVN(en){ return EN_TO_VN[normalize(en)] || en; }

function isPlaceholder(name){
  return /Nhất|Nhì|Hạng|Thắng|Thua|bảng|trận|xuất sắc/i.test(name);
}

const API_ALIASES = {
  "turkey":"turkiye",
  "united states":"usa",
  "bosnia herzegovina":"bosnia and herzegovina",
  "cape verde islands":"cabo verde",
  "congo dr":"dr congo",
  "democratic republic of the congo":"dr congo",
  "korea republic":"south korea",
};

function teamsMatch(apiName, vnName){
  let a = normalize(apiName);
  a = API_ALIASES[a] || a;
  const v = vnNorm(vnName);
  return a === v || a.includes(v) || v.includes(a) ||
         a.replace(/\s/g,"").includes(v.replace(/\s/g,"")) ||
         v.replace(/\s/g,"").includes(a.replace(/\s/g,""));
}

function findOurMatch(apiHome, apiAway){
  return MATCHES.find(m => !isPlaceholder(m.team1) &&
    teamsMatch(apiHome, m.team1) && teamsMatch(apiAway, m.team2));
}

function findKnockoutByTime(apiDateStr){
  const vnDate = new Date(new Date(apiDateStr).getTime() + 7*60*60*1000);
  const dateStr = vnDate.toISOString().slice(0,10);
  const timeStr = vnDate.toISOString().slice(11,16);
  return MATCHES.find(m =>
    m.date===dateStr && m.time===timeStr &&
    m.stage!=="Vòng bảng" && isPlaceholder(m.team1));
}

function dbUrl(key){ return `${FIREBASE_DB_URL.replace(/\/$/,"")}/${DB_PATH}/${key}.json`; }
async function fbGet(key){
  // Dùng orderBy để ngăn Firebase tự convert object có key số thành array
  const res = await fetch(dbUrl(key)+"?print=pretty");
  if(!res.ok) throw new Error(`Firebase GET ${key}: HTTP ${res.status}`);
  const data = await res.json();
  // Nếu Firebase trả về array (do key là số liên tục), convert lại thành object
  if(Array.isArray(data)){
    const obj={};
    data.forEach((v,i)=>{ if(v!=null) obj[i]=v; });
    return obj;
  }
  return data;
}
async function fbSet(key,value){
  const res = await fetch(dbUrl(key),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)});
  if(!res.ok) throw new Error(`Firebase PUT ${key}: HTTP ${res.status}`);
}
async function fetchFixtures(){
  const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches?season=2026",
    {headers:{"X-Auth-Token":FOOTBALL_DATA_TOKEN}});
  if(!res.ok){ const b=await res.text().catch(()=>""); throw new Error(`API: HTTP ${res.status} ${b}`); }
  const data=await res.json();
  if(data.errorCode) throw new Error(`API: ${data.message||JSON.stringify(data)}`);
  return data.matches||[];
}

async function main(){
  console.log("Lấy dữ liệu từ football-data.org...");
  const fixtures=await fetchFixtures();
  console.log(`${fixtures.length} trận.`);

  const [res2,sc2,kt2]=await Promise.all([
    fbGet("results").catch(()=>({})),
    fbGet("scores").catch(()=>({})),
    fbGet("knockoutTeams").catch(()=>({})),
  ]);

  let rUpd=0,tUpd=0;

  for(const fx of fixtures){
    const apiHome=fx.homeTeam?.name||"";
    const apiAway=fx.awayTeam?.name||"";
    if(!apiHome||!apiAway) continue;
    const isKnockout=KNOCKOUT_STAGES.has(fx.stage);

    // Cập nhật tên đội knockout
    if(isKnockout && !apiHome.includes("TBD") && !apiAway.includes("TBD")){
      let ours=findOurMatch(apiHome,apiAway);
      if(!ours) ours=findKnockoutByTime(fx.utcDate);
      if(ours && isPlaceholder(ours.team1)){
        const vnH=apiToVN(apiHome), vnA=apiToVN(apiAway);
        const key=String(ours.id);
        if(!kt2[key]||kt2[key].team1!==vnH||kt2[key].team2!==vnA){
          kt2[key]={team1:vnH,team2:vnA}; tUpd++;
          console.log(`🔄 M${ours.id}: ${vnH} vs ${vnA}`);
        }
      }
    }

    // Cập nhật kết quả + tỷ số
    if(!FINISHED_STATUSES.has(fx.status)) continue;
    const winner=fx.score?.winner;
    if(!winner) continue;
    const ft=fx.score?.fullTime||{};
    const hasScore=ft.home!=null&&ft.away!=null;

    let ours=findOurMatch(apiHome,apiAway);
    if(!ours&&isKnockout) ours=findKnockoutByTime(fx.utcDate);
    if(!ours){ console.log(`Không match: ${apiHome} vs ${apiAway}`); continue; }

    let upd=false;
    const matchKey=String(ours.id);
    if(!res2[matchKey]){ res2[matchKey]=winner==="HOME_TEAM"?"team1":winner==="AWAY_TEAM"?"team2":"draw"; upd=true; }
    if(hasScore&&!sc2[matchKey]){ sc2[matchKey]=`${ft.home} - ${ft.away}`; upd=true; }
    if(upd) rUpd++;
    console.log(`✓ #${ours.id} ${ours.team1} vs ${ours.team2}: ${sc2[matchKey]||"?"} (${res2[matchKey]||"?"})`);
  }

  const w=[];
  if(rUpd>0){ w.push(fbSet("results",res2),fbSet("scores",sc2)); console.log(`✅ ${rUpd} kết quả.`); }
  if(tUpd>0){ w.push(fbSet("knockoutTeams",kt2)); console.log(`✅ ${tUpd} tên đội.`); }
  if(w.length>0) await Promise.all(w);
  if(rUpd===0&&tUpd===0) console.log("Không có gì mới.");
}

main().catch(e=>{ console.error("Lỗi:",e.message); process.exit(1); });
