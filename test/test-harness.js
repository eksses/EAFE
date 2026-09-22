'use strict';

const { suite, pass, fail } = global.__harness;

const pending = [];

function test(name, fn) {
  const p = Promise.resolve()
    .then(() => fn())
    .then(() => pass(name))
    .catch(err => fail(name, err));
  pending.push(p);
  return p;
}

function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}

function assertClose(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${msg || 'not close'}: expected ${expected} ±${tol}, got ${actual}`);
  }
}

module.exports = { test, assert, assertClose, suite, pending };
