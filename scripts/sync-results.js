// scripts/sync-results.js
// Chạy bởi GitHub Actions theo lịch (xem .github/workflows/sync-results.yml).
// Lấy kết quả các trận đã đấu xong từ API-Football, rồi ghi vào Firebase Realtime Database
// để app tự động hiển thị — không ai phải bấm "Nhập kết quả" tay nữa.

const fs = require("fs");
const path = require("path");

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const DB_PATH = "worldcup2026";
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN"]);

if (!FIREBASE_DB_URL) { console.error("Thiếu biến môi trường FIREBASE_DB_URL"); process.exit(1); }
if (!API_FOOTBALL_KEY) { console.error("Thiếu biến môi trường API_FOOTBALL_KEY"); process.exit(1); }

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
  const res = await fetch("https://v3.football.api-sports.io/fixtures?league=1&season=2026", {
    headers: { "x-apisports-key": API_FOOTBALL_KEY },
  });
  if (!res.ok) throw new Error(`API-Football trả lỗi: HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Football báo lỗi: ${JSON.stringify(data.errors)}`);
  }
  return data.response || [];
}

async function main() {
  console.log(`Đang lấy danh sách trận từ API-Football...`);
  const fixtures = await fetchFixtures();
  console.log(`Nhận được ${fixtures.length} trận từ API (mong đợi 104).`);

  // Sắp xếp theo thời gian thi đấu để khớp vị trí với matches.json (cũng đã theo thứ tự thời gian)
  fixtures.sort((a, b) => a.fixture.timestamp - b.fixture.timestamp);

  const existingResults = (await fbGet("results")) || {};
  let updated = 0;
  const n = Math.min(MATCHES.length, fixtures.length);

  for (let i = 0; i < n; i++) {
    const ours = MATCHES[i];
    const fx = fixtures[i];
    const status = fx.fixture.status.short;

    if (!FINISHED_STATUSES.has(status)) continue;
    if (existingResults[ours.id]) continue; // đã có kết quả (tự động hoặc người nhập tay) thì không ghi đè

    const homeGoals = fx.goals.home;
    const awayGoals = fx.goals.away;
    if (homeGoals === null || awayGoals === null) continue;

    let outcome;
    if (homeGoals === awayGoals) outcome = "draw";
    else if (homeGoals > awayGoals) outcome = "team1";
    else outcome = "team2";

    existingResults[ours.id] = outcome;
    updated++;
    console.log(
      `Trận #${ours.id} [${ours.team1} vs ${ours.team2}] <-> API [${fx.teams.home.name} ${homeGoals}-${awayGoals} ${fx.teams.away.name}] => ${outcome}`
    );
  }

  if (updated > 0) {
    await fbSet("results", existingResults);
    console.log(`✅ Đã cập nhật ${updated} kết quả mới vào Firebase.`);
  } else {
    console.log("Không có kết quả mới nào để cập nhật ở lần chạy này.");
  }
}

main().catch((err) => {
  console.error("Lỗi:", err.message);
  process.exit(1);
});
