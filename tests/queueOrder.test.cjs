const assert = require('node:assert/strict');
const test = require('node:test');
const { upcomingFrom, moveUpcoming } = require('../queueOrder.ts');

test('queue view includes wrapped tracks after the current track in playback order', () => {
  assert.deepEqual(upcomingFrom(['A', 'B', 'C', 'D'], 1), ['C', 'D', 'A']);
  assert.deepEqual(upcomingFrom(['A', 'B', 'C'], 0), ['B', 'C']);
  assert.deepEqual(upcomingFrom(['A'], 0), []);
  assert.deepEqual(upcomingFrom(['A', 'B'], -1), []);
});

test('moving an upcoming track preserves the others and the input', () => {
  const upcoming = ['B', 'C', 'D'];
  assert.deepEqual(moveUpcoming(upcoming, 2, 0), ['D', 'B', 'C']);
  assert.deepEqual(moveUpcoming(upcoming, 0, 2), ['C', 'D', 'B']);
  assert.deepEqual(upcoming, ['B', 'C', 'D']);
  assert.deepEqual(moveUpcoming(upcoming, 1, 1), upcoming);
  assert.deepEqual(moveUpcoming(upcoming, 1, 5), upcoming);
});
