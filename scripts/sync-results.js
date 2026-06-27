// scripts/sync-results.js
// Chạy bởi GitHub Actions mỗi 15 phút.
// 1. Cập nhật kết quả + tỷ số các trận đã đấu xong vào Firebase
// 2. Tự động cập nhật tên đội cho vòng loại trực tiếp khi API có thông tin

const fs = require("fs");
const path = require("path");

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const DB_PATH = "worldcup2026";
const FINISHED_STATUSES = new Set(["FINISHED", "AWARDED"]);
const KNOCKOUT_STAGES = new Set(["LAST_32","LAST_16","QUARTER_FINALS","SEMI_FINALS","THIRD_PLACE","FINAL"]);

if (!FIREBASE_DB_URL) { console.error("Thiếu biến môi trường FIREBASE_DB_URL"); process.exit(1); }
if (!FOOTBALL_DATA_TOKEN) { console.error("Thiếu biến môi trường FOOTBALL_DATA_TOKEN"); process.exit(1); }

const MATCHES = JSON.parse(fs.readFileSync(path.join(__dirname, "matches.json"), "utf-8"));

// Bảng dịch tên API -> VN (ngược lại từ VN_TO_EN)
const EN_TO_VN = {
  "turkiye":"Thổ Nhĩ Kỳ","turkey":"Thổ Nhĩ Kỳ",
  "ivory coast":"Bờ Biển Ngà","cote d'ivoire":"Bờ Biển Ngà","côte d'ivoire":"Bờ Biển Ngà",
  "south africa":"Nam Phi","south korea":"Hàn Quốc","czechia":"Séc","czech republic":"Séc",
  "bosnia and herzegovina":"Bosnia & Herzegovina","bosnia":"Bosnia & Herzegovina",
  "netherlands":"Hà Lan","japan":"Nhật Bản","switzerland":"Thụy Sĩ","sweden":"Thụy Điển",
  "spain":"Tây Ban Nha","saudi arabia":"Ả Rập Saudi","norway":"Na Uy","france":"Pháp",
  "argentina":"Argentina","brazil":"Brazil","germany":"Đức","belgium":"Bỉ",
  "england":"Anh","austria":"Áo","algeria":"Algeria","jordan":"Jordan","portugal":"Portugal",
  "dr congo":"CHDC Congo","congo dr":"CHDC Congo","congo, dr":"CHDC Congo",
  "uzbekistan":"Uzbekistan","colombia":"Colombia","mexico":"Mexico",
  "usa":"Mỹ","united states":"Mỹ","canada":"Canada","australia":"Australia",
  "qatar":"Qatar","iran":"Iran","egypt":"Egypt","ghana":"Ghana",
  "panama":"Panama","croatia":"Croatia","scotland":"Scotland","morocco":"Morocco",
  "haiti":"Haiti","iraq":"Iraq","senegal":"Senegal","ecuador":"Ecuador",
  "curacao":"Curaçao","curaçao":"Curaçao","tunisia":"Tunisia","uruguay":"Uruguay",
  "cabo verde":"Cabo Verde","cape verde":"Cabo Verde","new zealand":"New Zealand",
  "paraguay":"Paraguay","korea republic":"Hàn Quốc",
};

const VN_TO_EN = Object.fromEntries(Object.entries(EN_TO_VN).map(([k,v])=>[v,k]));

function dbUrl(key) {
  return `${FIREBASE_DB_URL.replace(/\/$/, "")}/${DB_PATH}/${key}.json`;
}
async function fbGet(key) {
  const res = await fetch(dbUrl(key));
  if (!res.ok) throw new Error(`Firebase GET ${key} thất bại: HTTP ${res.status}`);
  return await res.json();
}
async function fbSet(key, value) {
  const res = await fetch(dbUrl(key), {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`Firebase PUT ${key} thất bại: HTTP ${res.status}`);
}

async function fetchFixtures() {
  const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches?season=2026", {
    headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN },
  });
  if (!res.ok) { const b = await res.text().catch(()=>""); throw new Error(`football-data.org lỗi: HTTP ${res.status} ${b}`); }
  const data = await res.json();
  if (data.errorCode) throw new Error(`football-data.org lỗi: ${data.message || JSON.stringify(data)}`);
  return data.matches || [];
}

const normalize = (s) => (s || "").toLowerCase()
  .replace(/ü/g,"u").replace(/ú/g,"u").replace(/û/g,"u")
  .replace(/é/g,"e").replace(/ê/g,"e")
  .replace(/á/g,"a").replace(/â/g,"a").replace(/ã/g,"a")
  .replace(/ó/g,"o").replace(/ô/g,"o")
  .replace(/í/g,"i").replace(/ç/g,"c")
  .replace(/türkiye/g,"turkiye")
  .replace(/[^a-z0-9 ]/g,"").trim();

const vnNorm = (vn) => normalize(VN_TO_EN[vn] || vn);

// Chuyển tên API sang tên VN
function apiNameToVN(apiName) {
  const norm = normalize(apiName);
  // Tìm trực tiếp
  if (EN_TO_VN[norm]) return EN_TO_VN[norm];
  // Tìm gần đúng
  for (const [en, vn] of Object.entries(EN_TO_VN)) {
    if (norm.includes(en) || en.includes(norm)) return vn;
  }
  // Fallback: viết hoa chữ đầu mỗi từ
  return apiName.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
}

// Kiểm tra tên có phải placeholder không
function isPlaceholder(name) {
  return /Nhất|Nhì|Hạng|Thắng|Thua|bảng|trận|xuất sắc/i.test(name);
}

// Tìm trận trong app khớp với fixture từ API (theo tên đội)
function findOurMatch(apiHome, apiAway) {
  const ah = normalize(apiHome), aa = normalize(apiAway);
  return MATCHES.find(m => {
    const t1 = vnNorm(m.team1), t2 = vnNorm(m.team2);
    return (t1 === ah || ah.includes(t1) || t1.includes(ah)) &&
           (t2 === aa || aa.includes(t2) || t2.includes(aa));
  });
}

// Tìm trận knockout trong app theo thời gian (cho các trận chưa có tên đội)
function findKnockoutByTime(apiDateStr) {
  const apiDate = new Date(apiDateStr);
  // Chuyển UTC sang VN (+7)
  const vnDate = new Date(apiDate.getTime() + 7*60*60*1000);
  const dateStr = vnDate.toISOString().slice(0,10);
  const timeStr = vnDate.toISOString().slice(11,16);
  return MATCHES.find(m =>
    m.date === dateStr &&
    m.time === timeStr &&
    m.stage !== 'Vòng bảng' &&
    isPlaceholder(m.team1)
  );
}

async function main() {
  console.log(`Đang lấy danh sách trận từ football-data.org...`);
  const fixtures = await fetchFixtures();
  console.log(`Nhận được ${fixtures.length} trận từ API.`);

  const [existingResults, existingScores, existingTeams] = await Promise.all([
    fbGet("results").catch(()=>({})),
    fbGet("scores").catch(()=>({})),
    fbGet("knockoutTeams").catch(()=>({})),
  ]);

  let resultsUpdated = 0, teamsUpdated = 0;

  for (const fx of fixtures) {
    const apiHome = fx.homeTeam?.name || "";
    const apiAway = fx.awayTeam?.name || "";
    const isKnockout = KNOCKOUT_STAGES.has(fx.stage);

    // --- Cập nhật tên đội cho vòng knockout ---
    if (isKnockout && apiHome && apiAway &&
        !apiHome.includes("TBD") && !apiAway.includes("TBD") &&
        apiHome !== "" && apiAway !== "") {

      // Tìm trận trong app theo tên (nếu đã có tên thật)
      let ours = findOurMatch(apiHome, apiAway);

      // Nếu không tìm được theo tên, thử theo thời gian (trận còn placeholder)
      if (!ours) {
        ours = findKnockoutByTime(fx.utcDate);
      }

      if (ours && isPlaceholder(ours.team1)) {
        const vnHome = apiNameToVN(apiHome);
        const vnAway = apiNameToVN(apiAway);
        const key = String(ours.id);
        const stored = existingTeams[key];
        if (!stored || stored.team1 !== vnHome || stored.team2 !== vnAway) {
          existingTeams[key] = { team1: vnHome, team2: vnAway };
          teamsUpdated++;
          console.log(`🔄 Trận #${ours.id} [${ours.date} ${ours.time}]: ${vnHome} vs ${vnAway}`);
        }
      }
    }

    // --- Cập nhật kết quả + tỷ số ---
    if (!FINISHED_STATUSES.has(fx.status)) continue;
    const winner = fx.score?.winner;
    if (!winner) continue;
    const ft = fx.score?.fullTime || {};
    const hasScore = ft.home != null && ft.away != null;

    const ours = findOurMatch(apiHome, apiAway);
    if (!ours) { console.log(`Không match: ${apiHome} vs ${apiAway}`); continue; }

    if (!existingResults[ours.id]) {
      existingResults[ours.id] = winner === "HOME_TEAM" ? "team1" : winner === "AWAY_TEAM" ? "team2" : "draw";
      resultsUpdated++;
    }
    if (hasScore && !existingScores[ours.id]) {
      existingScores[ours.id] = `${ft.home} - ${ft.away}`;
      resultsUpdated++;
    }
    if (existingResults[ours.id] && existingScores[ours.id]) {
      console.log(`✓ #${ours.id} ${ours.team1} vs ${ours.team2}: ${existingScores[ours.id]} (${existingResults[ours.id]})`);
    }
  }

  const writes = [];
  if (resultsUpdated > 0) {
    writes.push(fbSet("results", existingResults), fbSet("scores", existingScores));
    console.log(`✅ Cập nhật ${resultsUpdated} kết quả/tỷ số.`);
  }
  if (teamsUpdated > 0) {
    writes.push(fbSet("knockoutTeams", existingTeams));
    console.log(`✅ Cập nhật ${teamsUpdated} tên đội knockout.`);
  }
  if (writes.length > 0) await Promise.all(writes);
  if (resultsUpdated === 0 && teamsUpdated === 0) console.log("Không có gì mới.");
}

main().catch((err) => { console.error("Lỗi:", err.message); process.exit(1); });
