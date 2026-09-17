import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const WEEK_MS = 7 * 86400000;
export const SKINS = Object.freeze(["default", "ember", "void", "storm"]);
export const REWARD_SKINS = Object.freeze(["ember", "void", "storm"]);
export const SKIN_COLORS = Object.freeze({ default: null, ember: "#ff8a3d", void: "#a05cff", storm: "#4dc9ff" });
export const BOARD_META = Object.freeze({
  community: true, private: true, verified: false, ranked: false,
  note: "Community/private unverified board; bearer recovery proves token possession, not identity. No ranked guarantees or Sybil/collusion protection. Rewards are cosmetic only; no combat advantage.",
});

export function weekStart(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return midnight - ((date.getUTCDay() + 6) % 7) * 86400000;
}

export function previousWeekStart(timestamp = Date.now()) {
  return weekStart(timestamp) - WEEK_MS;
}

export function normalizeName(name) {
  if (typeof name !== "string" || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  const normalized = name.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 32 || /[\p{Cc}\p{Cf}]/u.test(normalized)) return null;
  return normalized;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createProfileStore({ dataPath = ":memory:", now = () => Date.now(), minMatchSeconds = 30, scoredGamesPerWeek = 20 } = {}) {
  dataPath ??= ":memory:";
  if (dataPath !== ":memory:") mkdirSync(dirname(dataPath), { recursive: true });
  const db = new DatabaseSync(dataPath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
  if (dataPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      equipped_skin TEXT NOT NULL DEFAULT 'default',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entitlements (
      profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
      skin TEXT NOT NULL,
      PRIMARY KEY (profile_id, skin)
    );
    CREATE TABLE IF NOT EXISTS reward_claims (
      profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
      week_start INTEGER NOT NULL,
      skin TEXT NOT NULL,
      rank INTEGER NOT NULL,
      PRIMARY KEY (profile_id, week_start)
    );
    CREATE TABLE IF NOT EXISTS matches (
      match_id TEXT PRIMARY KEY,
      week_start INTEGER NOT NULL,
      played_at INTEGER NOT NULL,
      winner_id TEXT,
      duration REAL NOT NULL,
      scored INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS awards (
      match_id TEXT NOT NULL REFERENCES matches(match_id),
      profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
      points INTEGER NOT NULL,
      is_winner INTEGER NOT NULL,
      PRIMARY KEY (match_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS pairs (
      day INTEGER NOT NULL,
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      PRIMARY KEY (day, a, b)
    );
    CREATE INDEX IF NOT EXISTS awards_profile ON awards (profile_id);
    CREATE INDEX IF NOT EXISTS matches_week ON matches (week_start);
  `);
  const statements = {
    profile: db.prepare("SELECT profile_id, name, equipped_skin FROM profiles WHERE profile_id = ?"),
    profileByToken: db.prepare("SELECT profile_id FROM profiles WHERE token_hash = ?"),
    insertProfile: db.prepare("INSERT INTO profiles (profile_id, token_hash, name, created_at) VALUES (?, ?, ?, ?)"),
    setName: db.prepare("UPDATE profiles SET name = ? WHERE profile_id = ?"),
    setSkin: db.prepare("UPDATE profiles SET equipped_skin = ? WHERE profile_id = ?"),
    entitlement: db.prepare("SELECT skin FROM entitlements WHERE profile_id = ? AND skin = ?"),
    entitlements: db.prepare("SELECT skin FROM entitlements WHERE profile_id = ? ORDER BY skin"),
    insertEntitlement: db.prepare("INSERT OR IGNORE INTO entitlements (profile_id, skin) VALUES (?, ?)"),
    claim: db.prepare("SELECT skin, rank FROM reward_claims WHERE profile_id = ? AND week_start = ?"),
    insertClaim: db.prepare("INSERT INTO reward_claims (profile_id, week_start, skin, rank) VALUES (?, ?, ?, ?)"),
    match: db.prepare("SELECT scored FROM matches WHERE match_id = ?"),
    insertMatch: db.prepare("INSERT INTO matches (match_id, week_start, played_at, winner_id, duration, scored) VALUES (?, ?, ?, ?, ?, ?)"),
    insertAward: db.prepare("INSERT INTO awards (match_id, profile_id, points, is_winner) VALUES (?, ?, ?, ?)"),
    pair: db.prepare("SELECT a FROM pairs WHERE day = ? AND a = ? AND b = ?"),
    insertPair: db.prepare("INSERT INTO pairs (day, a, b) VALUES (?, ?, ?)"),
    games: db.prepare(`
      SELECT COUNT(*) AS count FROM awards a JOIN matches m ON m.match_id = a.match_id
      WHERE a.profile_id = ? AND m.week_start = ?
    `),
    top: db.prepare(`
      SELECT a.profile_id, SUM(a.points) AS points, SUM(a.is_winner) AS wins, COUNT(*) AS games
      FROM awards a JOIN profiles p ON p.profile_id = a.profile_id
      JOIN matches m ON m.match_id = a.match_id
      WHERE m.week_start = ? GROUP BY a.profile_id
      ORDER BY points DESC, wins DESC, games ASC, p.created_at ASC, a.profile_id ASC LIMIT ?
    `),
  };

  function transaction(action) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function getProfile(profileId, timestamp = now()) {
    const row = statements.profile.get(profileId);
    if (!row) return null;
    const previous = previousWeekStart(timestamp);
    const rank = statements.top.all(previous, 3).findIndex((entry) => entry.profile_id === profileId) + 1;
    const claim = statements.claim.get(profileId, previous);
    return {
      profileId: row.profile_id, name: row.name, skin: row.equipped_skin,
      nameColor: rank ? SKIN_COLORS[claim?.skin ?? REWARD_SKINS[rank - 1]] : null,
      rewardRank: rank || null,
      rewards: ["default", ...statements.entitlements.all(profileId).map((entry) => entry.skin)],
    };
  }

  function createProfile(name = "Wizard") {
    const resolved = normalizeName(name);
    if (!resolved) throw new TypeError("Invalid name");
    const token = randomBytes(32).toString("base64url");
    const profileId = randomUUID();
    statements.insertProfile.run(profileId, hashToken(token), resolved, now());
    return { token, profile: getProfile(profileId) };
  }

  function resolveToken(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    return statements.profileByToken.get(hashToken(token))?.profile_id ?? null;
  }

  function setName(profileId, name) {
    const resolved = normalizeName(name);
    return Boolean(resolved && statements.setName.run(resolved, profileId).changes);
  }

  function equip(profileId, skin) {
    if (!statements.profile.get(profileId)) return { ok: false, reason: "unknown-profile" };
    if (!SKINS.includes(skin)) return { ok: false, reason: "invalid-skin" };
    if (skin !== "default" && !statements.entitlement.get(profileId, skin)) return { ok: false, reason: "not-owned" };
    statements.setSkin.run(skin, profileId);
    return { ok: true, profile: getProfile(profileId) };
  }

  function top(targetWeekStart, limit = 20, timestamp = now()) {
    return statements.top.all(targetWeekStart, limit).map((row, index) => ({
      ...getProfile(row.profile_id, timestamp), points: row.points, wins: row.wins, games: row.games, rank: index + 1,
    }));
  }

  function getLeaderboard(timestamp = now()) {
    const current = weekStart(timestamp);
    const previous = current - WEEK_MS;
    return {
      weekStart: current, weekEnd: current + WEEK_MS, top20: top(current, 20, timestamp),
      lastWeek: { weekStart: previous, weekEnd: current, top3: top(previous, 3, timestamp) },
      meta: BOARD_META,
    };
  }

  function claimReward(profileId, skin) {
    return transaction(() => {
      if (!REWARD_SKINS.includes(skin)) return { ok: false, reason: "invalid-skin" };
      if (!statements.profile.get(profileId)) return { ok: false, reason: "unknown-profile" };
      const timestamp = now();
      const targetWeek = previousWeekStart(timestamp);
      const rank = statements.top.all(targetWeek, 3).findIndex((row) => row.profile_id === profileId) + 1;
      if (!rank) return { ok: false, reason: "not-eligible" };
      const existing = statements.claim.get(profileId, targetWeek);
      if (existing && existing.skin !== skin) return { ok: false, reason: "already-claimed" };
      if (!existing) {
        statements.insertClaim.run(profileId, targetWeek, skin, rank);
        statements.insertEntitlement.run(profileId, skin);
      }
      return { ok: true, profile: getProfile(profileId, timestamp) };
    });
  }

  function recordMatch({ matchId, winnerProfileId, participants, duration, disconnected = false }) {
    if (typeof matchId !== "string" || !matchId || matchId.length > 128) return { scored: false, reason: "invalid-match" };
    return transaction(() => {
      if (statements.match.get(matchId)) return { scored: false, reason: "duplicate" };
      const timestamp = now();
      const week = weekStart(timestamp);
      const day = Math.floor(timestamp / 86400000);
      const ids = [...new Set((Array.isArray(participants) ? participants : []).filter((id) => typeof id === "string" && statements.profile.get(id)))];
      const winnerValid = ids.includes(winnerProfileId);
      const validDuration = Number.isFinite(duration) && duration >= minMatchSeconds;
      const opponents = ids.filter((id) => id !== winnerProfileId);
      const pairKeys = opponents.map((id) => [day, ...[id, winnerProfileId].sort()]);
      const scored = Boolean(!disconnected && winnerValid && ids.length >= 2 && validDuration &&
        ids.every((id) => statements.games.get(id, week).count < scoredGamesPerWeek) &&
        pairKeys.every((keys) => !statements.pair.get(...keys)));
      statements.insertMatch.run(matchId, week, timestamp, winnerValid ? winnerProfileId : null, Number.isFinite(duration) ? duration : 0, Number(scored));
      const awarded = [];
      if (scored) {
        for (const id of ids) {
          const points = id === winnerProfileId ? 3 : 1;
          statements.insertAward.run(matchId, id, points, Number(id === winnerProfileId));
          awarded.push({ profileId: id, points });
        }
        for (const keys of pairKeys) statements.insertPair.run(...keys);
      }
      return { scored, awarded };
    });
  }

  let closed = false;
  function close() {
    if (!closed) { db.close(); closed = true; }
  }

  return { createProfile, resolveToken, getProfile, setName, equip, claimReward, top, getLeaderboard, recordMatch, close };
}
