import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, differences, importPreservation } from '../audit-state.mjs';

test('state comparison detects changed ratings, contracts, picks, missing players and non-finite values', () => {
  const state = canonical({ players: [{ pid: 2, tid: 0, ratings: { ovr: 60 }, contract: { amount: 15000 }, min: 29.738009776551312 }], picks: [{ dpid: 1, tid: 0 }] });
  assert.deepEqual(differences(state, structuredClone(state)), []);
  for (const mutate of [
    copy => { copy.players[0].ratings.ovr++; },
    copy => { copy.players[0].contract.amount++; },
    copy => { copy.picks[0].tid++; },
    copy => { copy.players.pop(); },
    copy => { copy.players[0].min += 1e-8; },
    copy => { copy.players[0].min = Infinity; },
  ]) {
    const copy = structuredClone(state); mutate(copy);
    assert.ok(differences(state, canonical(copy)).length > 0);
  }
  const rounded = structuredClone(state);
  rounded.players[0].min = 29.73800977655131;
  assert.deepEqual(differences(state, rounded), []);
  assert.deepEqual(differences({ minAvailable: 96 }, { minAvailable: 96.00000000000003 }), []);
  assert.equal(differences({ pid: 1 }, { pid: 2 }).length, 1);
  assert.equal(differences({ x: 1, y: 2 }, { x: 2, y: 3 }, 1).length, 1);
});

test('import preservation catches lost source data while allowing native-added fields', () => {
  const player = { pid: 3, tid: 1, born: { year: 1980 }, contract: { amount: 1000, exp: 2009 }, injury: { type: 'Healthy', gamesRemaining: 0 }, ratings: [{ hgt: 70 }] };
  const raw = { players: [player] };
  const imported = { ...structuredClone(player), born: { year: 1980, loc: 'USA' }, ratings: { hgt: 70, ovr: 50 } };
  const state = { stores: { players: [imported] } };
  assert.equal(importPreservation(raw, state).passed, true);
  raw.gameAttributes = { minContract: 300 };
  player.contract.amount = 1003;
  assert.equal(importPreservation(raw, state).passed, true);
  assert.equal(importPreservation(raw, state).nativeAdjustmentCount, 1);
  imported.ratings.hgt = 69;
  imported.contract.amount = 2000;
  const failed = importPreservation(raw, state);
  assert.equal(failed.passed, false);
  assert.equal(failed.failureCount, 2);
  state.stores.players = [];
  assert.equal(importPreservation(raw, state).failures[0].field, 'missing player');
});
