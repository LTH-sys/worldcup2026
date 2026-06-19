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
  console.log(`Nhận được ${fixtures.length} trận từ API (mong đợi tối đa 104, có thể ít hơn nếu vòng loại trực tiếp chưa được thêm).`);

  // Sắp xếp theo thời gian thi đấu để khớp vị trí với matches.json (cũng đã theo thứ tự thời gian)
  fixtures.sort((a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());

  const existingResults = (await fbGet("results")) || {};
  const existingScores = (await fbGet("scores")) || {};
  let updated = 0;
  const n = Math.min(MATCHES.length, fixtures.length);

  for (let i = 0; i < n; i++) {
    const ours = MATCHES[i];
    const fx = fixtures[i];

    if (!FINISHED_STATUSES.has(fx.status)) continue;

    const winner = fx.score && fx.score.winner;
    if (!winner) continue;

    const ft = fx.score && fx.score.fullTime ? fx.score.fullTime : {};
    const hasScore = ft.home !== null && ft.home !== undefined && ft.away !== null && ft.away !== undefined;

    // Ghi kết quả thắng/thua nếu chưa có
    if (!existingResults[ours.id]) {
      let outcome;
      if (winner === "HOME_TEAM") outcome = "team1";
      else if (winner === "AWAY_TEAM") outcome = "team2";
      else outcome = "draw";
      existingResults[ours.id] = outcome;
      updated++;
    }

    // Ghi tỷ số nếu chưa có (kể cả khi kết quả đã có từ trước)
    if (hasScore && !existingScores[ours.id]) {
      existingScores[ours.id] = `${ft.home} - ${ft.away}`;
      updated++;
    }

    if (!existingResults[ours.id] || !existingScores[ours.id]) continue;
    console.log(
      `Trận #${ours.id} [${ours.team1} vs ${ours.team2}] <-> API [${fx.homeTeam.name} ${ft.home}-${ft.away} ${fx.awayTeam.name}] => ${existingResults[ours.id]}, tỷ số: ${existingScores[ours.id]}`
    );
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
