import assert from 'node:assert/strict';
import test from 'node:test';
import { reconnectionFeeToPost } from '../src/routes/reconnectionFeeCharge.js';

const fee = (amount: string, balanceBefore: string, unpaidFeeOnLedger: string, packageFee: string | null = '1500.00') =>
  reconnectionFeeToPost({ amount, balanceBefore, unpaidFeeOnLedger, packageFee });

test('an account owing nothing gets the fee posted, so the receipt is not credit', () => {
  assert.equal(fee('1500', '0.00', '0.00'), '1500.00');
});

test('a fee already on the ledger is paid, nothing new is posted', () => {
  // Disconnected in the app: 4000 arrears + 1500 fee debit.
  assert.equal(fee('1500', '5500.00', '1500.00'), '0.00');
});

test('a legacy cut-off with arrears but no fee debit gets the fee, arrears stay owed', () => {
  assert.equal(fee('1500', '3000.00', '0.00'), '1500.00');
});

test('a fee debit already covered by other money still cannot produce credit', () => {
  // Balance 0 with the fee on the ledger: monthly money already paid it.
  assert.equal(fee('1500', '0.00', '1500.00'), '1500.00');
});

test('an existing credit is left as it was, not increased', () => {
  assert.equal(fee('1500', '-500.00', '0.00'), '1500.00');
});

test('arrears lumped into a Reconnection Fee receipt still pay the arrears', () => {
  // 5000 received as "Reconnection Fee": 1500 fee, 3500 against the 3500 owed.
  assert.equal(fee('5000', '3500.00', '0.00'), '1500.00');
});

test('a package without a fee treats the receipt itself as the fee', () => {
  assert.equal(fee('2000', '0.00', '0.00', null), '2000.00');
  assert.equal(fee('2000', '0.00', '0.00', '0.00'), '2000.00');
});

test('never posts more than the receipt', () => {
  assert.equal(fee('1000', '-9000.00', '0.00'), '1000.00');
  assert.equal(fee('0', '0.00', '0.00'), '0.00');
});
