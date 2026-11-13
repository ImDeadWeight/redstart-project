import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, mean } from './math.mjs'

test('adds positive numbers', () => {
  assert.equal(add(2, 3), 5)
})

test('adds negative numbers', () => {
  assert.equal(add(-2, -3), -5)
})

test('mean of a list', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5)
})

test('mean of an empty list is 0', () => {
  assert.equal(mean([]), 0)
})
