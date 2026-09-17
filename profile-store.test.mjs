import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WEEK_MS, createProfileStore, normalizeName, previousWeekStart, weekStart } from "./profile-store.mjs";

const BASE = Date.UTC(2026, 8, 11, 12, 0, 0);

function mutableClock(start = BASE) {
  const state = { now: start };
  const fn = () => state.now;
  fn.advance = (ms) => { state.now += ms; };
  fn.set = (timestamp) => { state.now = timestamp; };
  return fn;
}

function makeStore(t, clock = mutableClock()) {
  const store = createProfileStore({ now: clock });
  t.after(() => store.close());
  return { store, clock };
}

test("week bounds are UTC Monday midnight and recovery works across restarts", () => {
  assert.equal(weekStart(Date.UTC(2026, 8, 13, 23, 59)), Date.UTC(2026, 8, 7));
  assert.equal(weekStart(Date.UTC(2026, 8, 14, 0, 0, 0)), Date.UTC(2026, 8, 14));
  assert.equal(previousWeekStart(Date.UTC(2026, 8, 14)), Date.UTC(2026, 8, 7));
  const monday = new Date(weekStart());
  assert.equal(monday.getUTCDay(), 1);
  assert.equal(monday.getUTCHours() + monday.getUTCMinutes() + monday.getUTCSeconds(), 0);
  const dir = mkdtempSync(join(tmpdir(), "warlock-store-"));
  const path = join(dir, "nested", "profiles.sqlite");
  const first = createProfileStore({ dataPath: path, now: mutableClock() });
  const { token } = first.createProfile("Persist");
  first.close();
  const second = createProfileStore({ dataPath: path, now: mutableClock() });
  const profileId = second.resolveToken(token);
  assert.ok(profileId);
  assert.equal(second.getProfile(profileId).name, "Persist");
  second.close();
  rmSync(dir, { recursive: true, force: true });
});

test("profiles persist, tokens hash to SHA-256, and invalid names are rejected", () => {
  const clock = mutableClock();
  const store = createProfileStore({ now: clock });
  t_after: {
    break t_after;
  }
  const { token, profile } = store.createProfile("  Ada   Solo  ");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(profile.name, "Ada Solo");
  assert.equal(profile.skin, "default");
  assert.deepEqual(profile.rewards, ["default"]);
  assert.equal(store.resolveToken(token), profile.profileId);
  assert.equal(store.resolveToken("not-a-real-token-at-all-aaaaaaaaaaaaa"), null);
  assert.equal(store.resolveToken(`${token}x`), null);
  assert.equal(store.resolveToken(null), null);
  assert.equal(normalizeName(""), null);
  assert.equal(normalizeName("x".repeat(33)), null);
  assert.equal(normalizeName("a\u0000b"), null);
  assert.equal(normalizeName("a\u200bb"), null);
  assert.equal(normalizeName("\u202eegnatro\u00adpmoc"), null);
  assert.equal(store.setName(profile.profileId, "Zed"), true);
  assert.equal(store.getProfile(profile.profileId).name, "Zed");
  assert.equal(store.setName(profile.profileId, ""), false);
  assert.equal(store.setName("missing", "Nobody"), false);
  store.close();
});

test("weekly leaderboard ranks by points, wins, games, and earliest profile", (t) => {
  const { store } = makeStore(t);
  const alice = store.createProfile("Alice").profile.profileId;
  const bob = store.createProfile("Bob").profile.profileId;
  const carol = store.createProfile("Carol").profile.profileId;
  const dave = store.createProfile("Dave").profile.profileId;
  let sequence = 0;
  const play = (winner, loser) => {
    store.recordMatch({ matchId: `m-${sequence++}`, winnerProfileId: winner, participants: [winner, loser], duration: 45 });
  };
  play(bob, alice);
  play(bob, carol);
  play(alice, carol);
  play(alice, dave);
  const board = store.getLeaderboard(BASE + 86400000);
  assert.deepEqual(board.top20.map((entry) => entry.name), ["Alice", "Bob", "Carol", "Dave"]);
  assert.deepEqual(board.top20.map((entry) => entry.points), [7, 6, 2, 1]);
  assert.deepEqual(board.top20.map((entry) => entry.wins), [2, 2, 0, 0]);
  assert.deepEqual(board.top20.map((entry) => entry.rank), [1, 2, 3, 4]);
  const empty = createProfileStore({ now: () => BASE + 2 * WEEK_MS });
  const emptyBoard = empty.getLeaderboard(BASE + 2 * WEEK_MS);
  assert.deepEqual(emptyBoard.top20, []);
  assert.deepEqual(emptyBoard.lastWeek.top3, []);
  empty.close();
});

test("previous-week top3 claim once; rewards never resurrect in later weeks", (t) => {
  const { store, clock } = makeStore(t);
  const alice = store.createProfile("Alice").profile.profileId;
  const bob = store.createProfile("Bob").profile.profileId;
  let sequence = 0;
  store.recordMatch({ matchId: `m-${sequence++}`, winnerProfileId: alice, participants: [alice, bob], duration: 45 });
  store.recordMatch({ matchId: `m-${sequence++}`, winnerProfileId: bob, participants: [alice, bob], duration: 45 });
  clock.set(BASE + WEEK_MS + 1000);
  assert.equal(store.claimReward(alice, "ember").ok, true);
  assert.deepEqual(store.getProfile(alice).rewards, ["default", "ember"]);
  assert.equal(store.claimReward(alice, "void").reason, "already-claimed");
  assert.equal(store.claimReward("missing", "ember").reason, "unknown-profile");
  assert.equal(store.claimReward(alice, "shield").reason, "invalid-skin");
  assert.equal(store.claimReward(alice, "default").reason, "invalid-skin");
  clock.set(BASE + 2 * WEEK_MS + 1000);
  const profile = store.getProfile(alice);
  assert.equal(profile.rewardRank, null);
  assert.equal(profile.nameColor, null);
  assert.equal(store.claimReward(alice, "void").reason, "not-eligible");
  assert.equal(store.claimReward(alice, "ember").reason, "not-eligible");
});

test("glow and rank come from the immediate previous week only", (t) => {
  const { store, clock } = makeStore(t);
  const alice = store.createProfile("Alice").profile.profileId;
  const bob = store.createProfile("Bob").profile.profileId;
  store.recordMatch({ matchId: "m-1", winnerProfileId: alice, participants: [alice, bob], duration: 45 });
  clock.set(BASE + WEEK_MS + 1000);
  const entry = store.top(previousWeekStart(BASE + WEEK_MS + 1000), 3)[0];
  assert.equal(entry.profileId, alice);
  assert.equal(entry.rewardRank, 1);
  assert.ok(entry.nameColor);
  assert.equal(store.getProfile(alice).nameColor, entry.nameColor);
});

test("anti-farm: one award per opponent pair per UTC day and 20 scored games cap", (t) => {
  const { store } = makeStore(t);
  const alice = store.createProfile("Alice").profile.profileId;
  const bob = store.createProfile("Bob").profile.profileId;
  for (let index = 0; index < 3; index++) {
    const result = store.recordMatch({ matchId: `d-${index}`, winnerProfileId: alice, participants: [alice, bob], duration: 45 });
    assert.equal(result.scored, index === 0);
  }
  assert.equal(store.getLeaderboard(BASE + 86400000).top20.find((entry) => entry.profileId === alice).points, 3);
  const opponents = [];
  for (let index = 0; index < 21; index++) opponents.push(store.createProfile(`Foe ${index}`).profile.profileId);
  for (const opponent of opponents) {
    store.recordMatch({ matchId: `cap-${opponent}`, winnerProfileId: alice, participants: [alice, opponent], duration: 45 });
  }
  const ranked = store.getLeaderboard(BASE + 86400000).top20.find((entry) => entry.profileId === alice);
  assert.equal(ranked.games, 20);
  assert.equal(ranked.points, 3 * 20);
  assert.equal(ranked.wins, 20);
});

test("short matches, disconnected results, and duplicate matchIds are never scored", (t) => {
  const { store } = makeStore(t);
  const alice = store.createProfile("Alice").profile.profileId;
  const bob = store.createProfile("Bob").profile.profileId;
  assert.equal(store.recordMatch({ matchId: "short", winnerProfileId: alice, participants: [alice, bob], duration: 29.9 }).scored, false);
  assert.equal(store.recordMatch({ matchId: "long", winnerProfileId: alice, participants: [alice, bob], duration: 30 }).scored, true);
  assert.equal(store.recordMatch({ matchId: "long", winnerProfileId: bob, participants: [alice, bob], duration: 45 }).reason, "duplicate");
  assert.equal(store.recordMatch({ matchId: "gone", winnerProfileId: alice, participants: [alice, bob], duration: 45, disconnected: true }).scored, false);
  assert.equal(store.recordMatch({ matchId: "solo", winnerProfileId: alice, participants: [alice], duration: 45 }).scored, false);
  assert.equal(store.recordMatch({ matchId: "fake-winner", winnerProfileId: "missing", participants: [alice, bob], duration: 45 }).scored, false);
  assert.equal(store.recordMatch({ matchId: "ghost", winnerProfileId: alice, participants: ["ghost-a", "ghost-b"], duration: 45 }).scored, false);
  const board = store.getLeaderboard(BASE + 86400000).top20;
  assert.deepEqual(board.map((entry) => [entry.name, entry.points]), [["Alice", 3], ["Bob", 1]]);
});

test("equip requires entitlement and idempotent claims grant one entitlement", (t) => {
  const { store, clock } = makeStore(t);
  const alice = store.createProfile("Alice").profile.profileId;
  const bob = store.createProfile("Bob").profile.profileId;
  store.recordMatch({ matchId: "m-1", winnerProfileId: alice, participants: [alice, bob], duration: 45 });
  assert.equal(store.equip(alice, "void").reason, "not-owned");
  assert.equal(store.equip("missing", "default").reason, "unknown-profile");
  assert.equal(store.equip(alice, "shield").reason, "invalid-skin");
  clock.set(BASE + WEEK_MS + 1000);
  store.claimReward(alice, "ember");
  store.claimReward(alice, "ember");
  const equipped = store.equip(alice, "ember");
  assert.equal(equipped.ok, true);
  assert.equal(equipped.profile.skin, "ember");
  assert.deepEqual(equipped.profile.rewards, ["default", "ember"]);
  assert.equal(store.equip(bob, "void").reason, "not-owned");
  assert.equal(store.equip(alice, "default").ok, true);
});
