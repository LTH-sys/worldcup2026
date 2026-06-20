// scripts/sync-results.js
// Chạy bởi GitHub Actions theo lịch (xem .github/workflows/sync-results.yml).
// Lấy kết quả các trận đã đấu xong từ football-data.org (gói free, World Cup luôn miễn phí),
// rồi tự ghi vào Firebase Realtime Database để app tự động hiển thị.

const fs = require("fs");
const path = require("path");

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const DB_PATH = "worldcup2026";
const FINISHED_STATUSES = new Set(["FINISHED", "AWARDED"]);

if (!FIREBASE_DB_URL) { console.error("Thiếu biến môi trường FIREBASE_DB_URL"); process.exit(1); }
if (!FOOTBALL_DATA_TOKEN) { console.error("Thiếu biến môi trường FOOTBALL_DATA_TOKEN"); process.exit(1); }

const MATCHES = JSON.parse(fs.readFileSync(path.join(__dirname, "matches.json"), "utf-8"));

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
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`Firebase PUT ${key} thất bại: HTTP ${res.status}`);
}

async function fetchFixtures() {
  const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches?season=2026", {
    headers: { "X-Auth-Token": FOOTBALL_DATA_TOKEN },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`football-data.org trả lỗi: HTTP ${res.status} ${body}`);
  }
  const data = await res.json();
  if (data.errorCode) {
    throw new Error(`football-data.org báo lỗi: ${data.message || JSON.stringify(data)}`);
  }
  return data.matches || [];
}

async function main() {
  console.log(`Đang lấy danh sách trận từ football-data.org...`);
  const fixtures = await fetchFixtures();
  console.log(`Nhận được ${fixtures.length} trận từ API.`);

  const existingResults = (await fbGet("results")) || {};
  const existingScores = (await fbGet("scores")) || {};
  let updated = 0;

  for (const fx of fixtures) {
    if (!FINISHED_STATUSES.has(fx.status)) continue;

    const winner = fx.score && fx.score.winner;
    if (!winner) continue;

    const ft = fx.score && fx.score.fullTime ? fx.score.fullTime : {};
    const hasScore = ft.home !== null && ft.home !== undefined && ft.away !== null && ft.away !== undefined;

    // Bảng dịch tên đội VN sang tên API tiếng Anh
    const VN_TO_EN = {
      "Thổ Nhĩ Kỳ":"turkiye","Bờ Biển Ngà":"ivory coast","Nam Phi":"south africa",
      "Hàn Quốc":"south korea","Séc":"czechia","Bosnia & Herzegovina":"bosnia",
      "Hà Lan":"netherlands","Nhật Bản":"japan","Thụy Sĩ":"switzerland",
      "Thụy Điển":"sweden","Tây Ban Nha":"spain","Ả Rập Saudi":"saudi arabia",
      "Na Uy":"norway","Pháp":"france","Argentina":"argentina","Brazil":"brazil",
      "Đức":"germany","Bỉ":"belgium","Anh":"england","Áo":"austria",
      "Algeria":"algeria","Jordan":"jordan","Portugal":"portugal",
      "CHDC Congo":"dr congo","Uzbekistan":"uzbekistan","Colombia":"colombia",
      "Mexico":"mexico","Mỹ":"usa","Canada":"canada","Australia":"australia",
      "Qatar":"qatar","Iran":"iran","Egypt":"egypt","Ghana":"ghana",
      "Panama":"panama","Croatia":"croatia","Scotland":"scotland",
      "Morocco":"morocco","Haiti":"haiti","Iraq":"iraq","Senegal":"senegal",
      "Ecuador":"ecuador","Curaçao":"curacao","Tunisia":"tunisia",
      "Uruguay":"uruguay","Cabo Verde":"cabo verde","New Zealand":"new zealand",
      "Paraguay":"paraguay",
    };

    const normalize = (s) => (s || "").toLowerCase()
      .replace(/ü/g,"u").replace(/ú/g,"u").replace(/û/g,"u")
      .replace(/é/g,"e").replace(/ê/g,"e")
      .replace(/á/g,"a").replace(/â/g,"a").replace(/ã/g,"a")
      .replace(/ó/g,"o").replace(/ô/g,"o")
      .replace(/í/g,"i").replace(/ç/g,"c")
      .replace(/türkiye/g,"turkiye")
      .replace(/[^a-z0-9 ]/g,"").trim();

    const vnNorm = (vn) => normalize(VN_TO_EN[vn] || vn);

    const apiHome = normalize(fx.homeTeam.name);
    const apiAway = normalize(fx.awayTeam.name);

    // Tìm trận khớp theo tên đội
    const ours = MATCHES.find(m => {
      const t1 = vnNorm(m.team1);
      const t2 = vnNorm(m.team2);
      return (t1 === apiHome || apiHome.includes(t1) || t1.includes(apiHome)) &&
             (t2 === apiAway || apiAway.includes(t2) || t2.includes(apiAway));
    });

    if (!ours) {
      console.log(`Không tìm thấy trận: ${fx.homeTeam.name} vs ${fx.awayTeam.name}`);
      continue;
    }

    if (!existingResults[ours.id]) {
      let outcome;
      if (winner === "HOME_TEAM") outcome = "team1";
      else if (winner === "AWAY_TEAM") outcome = "team2";
      else outcome = "draw";
      existingResults[ours.id] = outcome;
      updated++;
    }

    if (hasScore && !existingScores[ours.id]) {
      existingScores[ours.id] = `${ft.home} - ${ft.away}`;
      updated++;
    }

    if (existingResults[ours.id] && existingScores[ours.id]) {
      console.log(
        `Trận #${ours.id} [${ours.team1} vs ${ours.team2}] <-> API [${fx.homeTeam.name} ${ft.home}-${ft.away} ${fx.awayTeam.name}] => ${existingResults[ours.id]}, tỷ số: ${existingScores[ours.id]}`
      );
    }
  }

  if (updated > 0) {
    await Promise.all([fbSet("results", existingResults), fbSet("scores", existingScores)]);
    console.log(`✅ Đã cập nhật ${updated} kết quả + tỷ số mới vào Firebase.`);
  } else {
    console.log("Không có kết quả mới nào để cập nhật ở lần chạy này.");
  }
}

main().catch((err) => {
  console.error("Lỗi:", err.message);
  process.exit(1);
});
