export const MAILBOX_GROUPS = ['pinnedIds', 'normalIds'];

export function visibleMailboxIds(order, group) {
  return order[group].filter(id => !(order.mainFirst && id === order.mainAccountId));
}

export function mailboxGroup(order, accountId) {
  return MAILBOX_GROUPS.find(group => order[group].includes(accountId));
}

// Drag indices describe visible cards. The fixed main mailbox retains its
// underlying group index, and unrendered cards remain in the complete order.
export function moveMailbox(order, accountId, targetGroup, targetIndex) {
  if (!MAILBOX_GROUPS.includes(targetGroup) || !mailboxGroup(order, accountId) || !Number.isInteger(targetIndex)) return order;
  if (order.mainFirst && accountId === order.mainAccountId) return order;
  const next = { ...order };
  const groups = Object.fromEntries(MAILBOX_GROUPS.map(group => [
    group, visibleMailboxIds(order, group).filter(id => id !== accountId),
  ]));
  const position = Math.max(0, Math.min(targetIndex, groups[targetGroup].length));
  groups[targetGroup].splice(position, 0, accountId);
  for (const group of MAILBOX_GROUPS) {
    const mainIndex = order[group].indexOf(order.mainAccountId);
    next[group] = groups[group];
    if (order.mainFirst && mainIndex !== -1) {
      next[group].splice(Math.min(mainIndex, next[group].length), 0, order.mainAccountId);
    }
  }
  return next;
}

export function setMailboxPinned(order, accountId, pinned) {
  const currentGroup = mailboxGroup(order, accountId);
  const targetGroup = pinned ? 'pinnedIds' : 'normalIds';
  if (typeof pinned !== 'boolean' || !currentGroup || currentGroup === targetGroup) return order;
  if (!(order.mainFirst && accountId === order.mainAccountId)) {
    return moveMailbox(order, accountId, targetGroup, 0);
  }
  // Fixing the main mailbox controls its display position, not its pin state.
  const next = { ...order };
  for (const group of MAILBOX_GROUPS) next[group] = order[group].filter(id => id !== accountId);
  next[targetGroup].unshift(accountId);
  return next;
}

const emailCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function createdAt(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const timestamp = value.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(timestamp)) return Date.parse(`${timestamp}T00:00:00Z`);
  // D1's CURRENT_TIMESTAMP has no suffix and represents UTC.
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp) ? timestamp : `${timestamp}Z`);
}

export function sortMailboxes(order, key, direction) {
  if (!['email', 'createTime'].includes(key) || !['asc', 'desc'].includes(direction) || !Array.isArray(order.accounts)) return order;
  const accounts = new Map(order.accounts.map(account => [account.accountId, account]));
  const sign = direction === 'asc' ? 1 : -1;
  const compare = (leftId, rightId) => {
    const left = accounts.get(leftId);
    const right = accounts.get(rightId);
    if (!left || !right) return Number(!left) - Number(!right) || leftId - rightId;
    const emailOrder = emailCollator.compare(left.email || '', right.email || '');
    if (key === 'email') return emailOrder * sign || leftId - rightId;
    const leftTime = createdAt(left.createTime);
    const rightTime = createdAt(right.createTime);
    const leftMissing = !Number.isFinite(leftTime);
    const rightMissing = !Number.isFinite(rightTime);
    if (leftMissing !== rightMissing) return Number(leftMissing) - Number(rightMissing);
    return (leftMissing ? 0 : (leftTime - rightTime) * sign) || emailOrder || leftId - rightId;
  };
  const next = { ...order };
  for (const group of MAILBOX_GROUPS) {
    const mainIndex = order[group].indexOf(order.mainAccountId);
    next[group] = visibleMailboxIds(order, group).sort(compare);
    if (order.mainFirst && mainIndex !== -1) next[group].splice(Math.min(mainIndex, next[group].length), 0, order.mainAccountId);
  }
  return next;
}
