import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationPrice, changeApplicationBoxCount } from '../../client/src/lib/applicationPricing.js';

test('one box uses the selected package prices', () => {
  assert.deepEqual(applicationPrice('2500', '4500', 0), { monthlyFee: '2500.00', installationFee: '4500.00' });
});
test('four cable boxes cost 12000 installation and add 3000 monthly', () => {
  assert.deepEqual(applicationPrice('2500', '4500', 3), { monthlyFee: '5500.00', installationFee: '12000.00' });
});
test('bundle keeps its base installation and monthly prices', () => {
  assert.deepEqual(applicationPrice('4500', '11000', 3), { monthlyFee: '7500.00', installationFee: '18500.00' });
});
test('changing counts updates the total once and preserves a custom base rate', () => {
  const fourBoxes = changeApplicationBoxCount('2750', 0, 3);
  assert.equal(fourBoxes, '5750.00');
  assert.equal(changeApplicationBoxCount(fourBoxes, 3, 3), '5750.00');
  assert.equal(changeApplicationBoxCount(fourBoxes, 3, 0), '2750.00');
});

test('two cable boxes cost 7000 installation and 3500 monthly', () => {
  assert.deepEqual(applicationPrice('2500', '4500', 1), { monthlyFee: '3500.00', installationFee: '7000.00' });
  assert.equal(changeApplicationBoxCount('2500', 0, 1), '3500.00');
  assert.equal(changeApplicationBoxCount('3500', 1, 2), '4500.00');
});
