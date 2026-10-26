import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailboxGroup, moveMailbox, setMailboxPinned, sortMailboxes, visibleMailboxIds } from '../src/utils/mailbox-order.js';

test('cross-group drag preserves a hidden fixed main mailbox and every unrendered mailbox', () => {
  const order = {
    mainAccountId: 2, mainFirst: true,
    pinnedIds: [1, 2, 3], normalIds: Array.from({ length: 61 }, (_, index) => index + 4),
  };
  const moved = moveMailbox(order, 3, 'normalIds', 30);
  assert.deepEqual(moved.pinnedIds, [1, 2]);
  assert.equal(moved.normalIds[30], 3);
  assert.equal(moved.normalIds.at(-1), 64);
  assert.equal(new Set([...moved.pinnedIds, ...moved.normalIds]).size, 64);
  assert.deepEqual(order.pinnedIds, [1, 2, 3]);
});

test('group moves keep a fixed main mailbox at its underlying index', () => {
  const order = { mainAccountId: 2, mainFirst: true, pinnedIds: [], normalIds: [1, 2, 3, 4] };
  const moved = moveMailbox(order, 4, 'normalIds', 0);
  assert.deepEqual(moved.normalIds, [4, 2, 1, 3]);
  assert.deepEqual(visibleMailboxIds(moved, 'normalIds'), [4, 1, 3]);
  assert.equal(moveMailbox(order, 2, 'pinnedIds', 0), order);
});

test('an unfixed main mailbox can move between empty and populated groups', () => {
  const order = { mainAccountId: 2, mainFirst: false, pinnedIds: [], normalIds: [1, 2, 3] };
  const pinned = moveMailbox(order, 2, 'pinnedIds', 0);
  assert.deepEqual(pinned.pinnedIds, [2]);
  assert.deepEqual(pinned.normalIds, [1, 3]);
  assert.equal(mailboxGroup(pinned, 2), 'pinnedIds');
  const unpinned = moveMailbox(pinned, 2, 'normalIds', 0);
  assert.deepEqual(unpinned.normalIds, [2, 1, 3]);
});

test('moving down uses the final visible index and clamps the last position', () => {
  const order = { mainAccountId: 1, mainFirst: false, pinnedIds: [1, 2, 3], normalIds: [] };
  assert.deepEqual(moveMailbox(order, 1, 'pinnedIds', 1).pinnedIds, [2, 1, 3]);
  assert.deepEqual(moveMailbox(order, 1, 'pinnedIds', 99).pinnedIds, [2, 3, 1]);
});

test('a fixed main mailbox can be pinned and unpinned without changing its fixed preference', () => {
  const order = { mainAccountId: 2, mainFirst: true, version: 4, pinnedIds: [4], normalIds: [1, 2, 3] };
  const before = structuredClone(order);
  const pinned = setMailboxPinned(order, 2, true);
  assert.deepEqual(pinned.pinnedIds, [2, 4]);
  assert.deepEqual(pinned.normalIds, [1, 3]);
  assert.equal(pinned.mainFirst, true);
  assert.equal(pinned.version, 4);
  assert.deepEqual(visibleMailboxIds(pinned, 'pinnedIds'), [4]);
  const unpinned = setMailboxPinned(pinned, 2, false);
  assert.deepEqual(unpinned.pinnedIds, [4]);
  assert.deepEqual(unpinned.normalIds, [2, 1, 3]);
  assert.equal(unpinned.mainFirst, true);
  assert.deepEqual(order, before);
});

test('pinning another mailbox keeps the fixed main slot and ignores redundant or invalid requests', () => {
  const order = { mainAccountId: 2, mainFirst: true, pinnedIds: [4, 2, 5], normalIds: [1, 3] };
  const pinned = setMailboxPinned(order, 3, true);
  assert.deepEqual(pinned.pinnedIds, [3, 2, 4, 5]);
  assert.deepEqual(pinned.normalIds, [1]);
  assert.equal(setMailboxPinned(pinned, 3, true), pinned);
  assert.equal(setMailboxPinned(order, 99, true), order);
  assert.equal(setMailboxPinned(order, 3, 'true'), order);
});

function sampleOrder() {
  return {
    mainAccountId: 1, mainFirst: false, version: 7,
    pinnedIds: [3, 2, 1], normalIds: [6, 5, 4],
    accounts: [
      { accountId: 1, email: 'box10@example.com', createTime: '2026-10-27 01:00:00' },
      { accountId: 2, email: 'Box2@example.com', createTime: '2026-10-27T02:00:00Z' },
      { accountId: 3, email: 'box1@example.com', createTime: '2026-10-27T09:00:00+08:00' },
      { accountId: 4, email: 'Alpha@example.com', createTime: null },
      { accountId: 5, email: 'alpha@example.com', createTime: 'not-a-date' },
      { accountId: 6, email: 'beta@example.com', createTime: '2026-10-26' },
    ],
  };
}

test('email sorting uses natural numeric order, ignores case and keeps pin groups separate', () => {
  const order = sampleOrder();
  const before = structuredClone(order);
  const ascending = sortMailboxes(order, 'email', 'asc');
  assert.deepEqual(ascending.pinnedIds, [3, 2, 1]);
  assert.deepEqual(ascending.normalIds, [4, 5, 6]);
  const descending = sortMailboxes(order, 'email', 'desc');
  assert.deepEqual(descending.pinnedIds, [1, 2, 3]);
  assert.deepEqual(descending.normalIds, [6, 4, 5]);
  assert.equal(descending.mainFirst, false);
  assert.equal(descending.version, 7);
  assert.deepEqual(order, before);
});

test('creation sorting interprets D1 timestamps as UTC and resolves ties by email then ID', () => {
  const order = sampleOrder();
  const before = structuredClone(order);
  const ascending = sortMailboxes(order, 'createTime', 'asc');
  assert.deepEqual(ascending.pinnedIds, [3, 1, 2]);
  assert.deepEqual(ascending.normalIds, [6, 4, 5]);
  const descending = sortMailboxes(order, 'createTime', 'desc');
  assert.deepEqual(descending.pinnedIds, [2, 3, 1]);
  assert.deepEqual(descending.normalIds, [6, 4, 5]);
  assert.deepEqual(order, before);
});

test('sorting keeps a fixed main mailbox at its original group index', () => {
  const order = { ...sampleOrder(), mainFirst: true, pinnedIds: [2, 1, 3] };
  const ascending = sortMailboxes(order, 'email', 'asc');
  assert.deepEqual(ascending.pinnedIds, [3, 1, 2]);
  assert.deepEqual(visibleMailboxIds(ascending, 'pinnedIds'), [3, 2]);
  assert.deepEqual(sortMailboxes(ascending, 'createTime', 'desc').pinnedIds, [2, 1, 3]);
});

test('sorting uses the full list beyond thirty visible items without losing mailboxes', () => {
  const accounts = Array.from({ length: 65 }, (_, index) => ({ accountId: index + 1, email: `box${index + 1}@example.com` }));
  const order = {
    accounts, mainAccountId: 64, mainFirst: true, version: 9,
    pinnedIds: [65], normalIds: accounts.slice(0, 64).map(account => account.accountId).reverse(),
  };
  const sorted = sortMailboxes(order, 'email', 'asc');
  assert.deepEqual(sorted.pinnedIds, [65]);
  assert.deepEqual(sorted.normalIds, [64, ...Array.from({ length: 63 }, (_, index) => index + 1)]);
  assert.equal(new Set([...sorted.pinnedIds, ...sorted.normalIds]).size, 65);
  assert.equal(sorted.version, 9);
  assert.equal(order.normalIds[1], 63);
});

test('sorting ignores unsupported settings and missing account metadata', () => {
  const order = sampleOrder();
  assert.equal(sortMailboxes(order, 'name', 'asc'), order);
  assert.equal(sortMailboxes(order, 'email', 'reverse'), order);
  assert.equal(sortMailboxes({ ...order, accounts: undefined }, 'email', 'asc').accounts, undefined);
});
