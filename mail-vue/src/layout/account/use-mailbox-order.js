import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import Sortable from 'sortablejs';
import { useI18n } from 'vue-i18n';
import { useAccountStore } from '@/store/account.js';
import { hasPerm } from '@/perm/perm.js';
import { accountOrder, accountSaveOrder } from '@/request/account.js';
import { MAILBOX_GROUPS, mailboxGroup, moveMailbox, setMailboxPinned, sortMailboxes, visibleMailboxIds } from '@/utils/mailbox-order.js';

export function useMailboxOrder(addLoading) {
  const accountStore = useAccountStore()
  const {t} = useI18n()
  const scrollbarRef = ref({})
  const accounts = reactive([])
  const loading = ref(true)
  const refreshing = ref(false)
  const saving = ref(false)
  const membershipBusy = ref(false)
  const loadFailed = ref(false)
  const order = reactive({mainAccountId: null, mainFirst: true, version: 0, pinnedIds: [], normalIds: []})
  const visibleLimits = reactive({pinnedIds: 30, normalIds: 30})
  const canOrder = computed(() => hasPerm('account:query'))
  const orderBusy = computed(() => loading.value || refreshing.value || saving.value || membershipBusy.value || addLoading.value)
  const accountMap = computed(() => new Map(accounts.map(item => [item.accountId, item])))
  const sections = computed(() => {
    const items = []
    const main = accountMap.value.get(order.mainAccountId)
    if (order.mainFirst && main) items.push({key: 'main', fixed: true, items: [main], total: 1})
    for (const key of MAILBOX_GROUPS) {
      const ids = visibleMailboxIds(order, key)
      items.push({key, fixed: false, label: key === 'pinnedIds' ? 'mailboxOrder.pinned' : 'mailboxOrder.other',
        total: ids.length, items: ids.slice(0, visibleLimits[key]).map(id => accountMap.value.get(id)).filter(Boolean)})
    }
    return items
  })
  const groupElements = new Map()
  const sortables = new Map()
  let dragOrigin = null
  let suppressClickUntil = 0
  let disposed = false
  onMounted(() => {
    if (canOrder.value) getAccountList()
    else loading.value = false
  })

  onBeforeUnmount(() => {
    disposed = true
    for (const sortable of sortables.values()) sortable.destroy()
    sortables.clear()
  })

  watch(orderBusy, busy => {
    for (const sortable of sortables.values()) sortable.option('disabled', busy)
  })

  watch(() => accountStore.changeUserAccountName, () => {
    const main = accountMap.value.get(order.mainAccountId)
    if (main) main.name = accountStore.changeUserAccountName
  })

  function captureOrder() {
    return {accounts: accounts.map(item => ({...item})), mainAccountId: order.mainAccountId,
      mainFirst: order.mainFirst, version: order.version, pinnedIds: [...order.pinnedIds], normalIds: [...order.normalIds]}
  }

  function applyOrder(snapshot) {
    accounts.splice(0, accounts.length, ...snapshot.accounts)
    order.mainAccountId = snapshot.mainAccountId
    order.mainFirst = snapshot.mainFirst
    order.version = snapshot.version
    order.pinnedIds = [...snapshot.pinnedIds]
    order.normalIds = [...snapshot.normalIds]
    const selected = accounts.find(item => item.accountId === accountStore.currentAccountId)
      || accounts.find(item => item.accountId === order.mainAccountId) || accounts[0]
    accountStore.currentAccountId = selected?.accountId || 0
    accountStore.currentAccount = selected || {}
  }

  function ensureVisible(accountId) {
    const group = mailboxGroup(order, accountId)
    if (!group) return
    const index = visibleMailboxIds(order, group).indexOf(accountId)
    if (index >= visibleLimits[group]) visibleLimits[group] = Math.ceil((index + 1) / 30) * 30
  }

  function isPinned(item) {
    return order.pinnedIds.includes(item.accountId)
  }

  function canMove(item) {
    return canOrder.value && !(order.mainFirst && item.accountId === order.mainAccountId)
  }

  function canMoveDirection(item, delta) {
    const group = mailboxGroup(order, item.accountId)
    if (!group || !canMove(item) || orderBusy.value) return false
    const ids = visibleMailboxIds(order, group)
    const target = ids.indexOf(item.accountId) + delta
    return target >= 0 && target < ids.length
  }

  async function persistOrder(next, revealId) {
    if (orderBusy.value || dragOrigin || !canOrder.value) return
    const previous = captureOrder()
    if (next.mainFirst === previous.mainFirst && JSON.stringify(next.pinnedIds) === JSON.stringify(previous.pinnedIds)
      && JSON.stringify(next.normalIds) === JSON.stringify(previous.normalIds)) return
    const scrollTop = scrollbarRef.value?.wrapRef?.scrollTop || 0
    saving.value = true
    applyOrder({...previous, ...next})
    if (revealId) ensureVisible(revealId)
    try {
      const snapshot = await accountSaveOrder({mainFirst: order.mainFirst, version: previous.version,
        pinnedIds: [...order.pinnedIds], normalIds: [...order.normalIds]})
      if (!disposed) applyOrder(snapshot)
    } catch (error) {
      if (disposed) return
      applyOrder(previous)
      const conflict = error.code === 409 || error.response?.status === 409 || error.response?.data?.code === 409
      ElMessage({message: t(conflict ? 'mailboxOrder.conflict' : 'mailboxOrder.saveFailed'), type: 'warning', plain: true})
      try {
        const snapshot = await accountOrder()
        if (!disposed) applyOrder(snapshot)
      } catch {
        // The previous display remains usable while the network is unavailable.
      }
    } finally {
      if (!disposed) {
        saving.value = false
        await nextTick()
        scrollbarRef.value?.setScrollTop(scrollTop)
      }
    }
  }

  function setMainFirst(value) {
    persistOrder({...captureOrder(), mainFirst: value}, value ? null : order.mainAccountId)
  }

  function togglePinned(item) {
    if (!canOrder.value) return
    persistOrder(setMailboxPinned(captureOrder(), item.accountId, !isPinned(item)), item.accountId)
  }

  function sortBy(command) {
    if (orderBusy.value || !canOrder.value) return
    const [key, direction] = command.split(':')
    persistOrder(sortMailboxes(captureOrder(), key, direction), accountStore.currentAccountId)
  }

  function moveBy(item, delta) {
    if (!canMoveDirection(item, delta)) return
    const group = mailboxGroup(order, item.accountId)
    const index = visibleMailboxIds(order, group).indexOf(item.accountId)
    persistOrder(moveMailbox(captureOrder(), item.accountId, group, index + delta), item.accountId)
  }

  function showMore(group) {
    visibleLimits[group] += 30
  }

  function setGroupElement(group, element) {
    if (!MAILBOX_GROUPS.includes(group) || groupElements.get(group) === element) return
    sortables.get(group)?.destroy()
    sortables.delete(group)
    groupElements.set(group, element)
    if (element) nextTick(() => setupSortable(group, element))
  }

  function setupSortable(group, element) {
    if (disposed || !canOrder.value || groupElements.get(group) !== element || sortables.has(group)) return
    const sortable = Sortable.create(element, {
      group: 'mailbox-order', draggable: '.mailbox-item', handle: '.mailbox-drag-handle',
      dataIdAttr: 'data-account-id', animation: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)', disabled: orderBusy.value,
      delay: 120, delayOnTouchOnly: true, touchStartThreshold: 4,
      forceFallback: true, fallbackOnBody: false, fallbackTolerance: 4,
      ghostClass: 'mailbox-ghost', chosenClass: 'mailbox-chosen', fallbackClass: 'mailbox-drag-preview',
      scrollSensitivity: 60, scrollSpeed: 10,
      onStart(event) {
        dragOrigin = {parent: event.from, nextSibling: event.item.nextSibling}
      },
      onEnd(event) {
        const origin = dragOrigin
        dragOrigin = null
        suppressClickUntil = Date.now() + 200
        // Sortable moves real DOM nodes. Restore the old DOM before Vue applies
        // the new arrays, so cross-list moves cannot leave orphaned cards.
        if (origin) origin.parent.insertBefore(event.item, origin.nextSibling?.parentNode === origin.parent ? origin.nextSibling : null)
        const targetGroup = event.to.dataset.group
        const accountId = Number(event.item.dataset.accountId)
        if (!MAILBOX_GROUPS.includes(targetGroup)) return
        persistOrder(moveMailbox(captureOrder(), accountId, targetGroup, event.newDraggableIndex), accountId)
      },
    })
    sortables.set(group, sortable)
  }

  function refresh() {
    if (orderBusy.value || dragOrigin) return
    getAccountList()
  }

  function changeAccount(account) {
    if (dragOrigin || Date.now() < suppressClickUntil) return
    accountStore.currentAccountId = account.accountId
    accountStore.currentAccount = account
  }

  async function getAccountList() {
    if (refreshing.value || disposed) return
    const scrollTop = scrollbarRef.value?.wrapRef?.scrollTop || 0
    refreshing.value = true
    loadFailed.value = false
    try {
      const snapshot = await accountOrder()
      if (disposed) return
      applyOrder(snapshot)
      ensureVisible(accountStore.currentAccountId)
    } catch {
      if (!disposed) loadFailed.value = true
    } finally {
      if (!disposed) {
        loading.value = false
        refreshing.value = false
        await nextTick()
        scrollbarRef.value?.setScrollTop(scrollTop)
      }
    }
  }


  function forgetAccount(accountId) {
    const snapshot = captureOrder()
    snapshot.accounts = snapshot.accounts.filter(item => item.accountId !== accountId)
    for (const group of MAILBOX_GROUPS) snapshot[group] = snapshot[group].filter(id => id !== accountId)
    applyOrder(snapshot)
  }

  return {accounts, order, loading, saving, loadFailed, sections, canOrder, orderBusy, membershipBusy,
      scrollbarRef, isPinned, canMove, canMoveDirection, setMainFirst, togglePinned, sortBy, moveBy,
      showMore, setGroupElement, refresh, changeAccount, getAccountList, forgetAccount}
}
