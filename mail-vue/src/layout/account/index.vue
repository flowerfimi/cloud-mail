<template>
  <div class="account-box">
    <div class="head-opt">
      <button v-perm="'account:add'" class="icon-button" type="button" :disabled="orderBusy" :aria-label="$t('addAccount')" :title="$t('addAccount')" @click="add">
        <Icon icon="ion:add-outline" width="23" height="23"/>
      </button>
      <button class="icon-button" type="button" :disabled="orderBusy" :aria-label="$t('mailboxOrder.refresh')" :title="$t('mailboxOrder.refresh')" @click="refresh">
        <Icon icon="ion:reload" width="18" height="18"/>
      </button>
      <el-dropdown trigger="click" :disabled="orderBusy || !canOrder" @command="sortBy">
        <button class="icon-button sort-button" type="button" :disabled="orderBusy || !canOrder" :aria-label="$t('mailboxOrder.sort')">
          <Icon :icon="mailboxIcons.sort" width="17" height="17"/>
          <span>{{ $t('mailboxOrder.sort') }}</span>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="email:asc">{{ $t('mailboxOrder.nameAscending') }}</el-dropdown-item>
            <el-dropdown-item command="email:desc">{{ $t('mailboxOrder.nameDescending') }}</el-dropdown-item>
            <el-dropdown-item command="createTime:desc" divided>{{ $t('mailboxOrder.newestFirst') }}</el-dropdown-item>
            <el-dropdown-item command="createTime:asc">{{ $t('mailboxOrder.oldestFirst') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <label class="main-first-control">
        <span>{{ $t('mailboxOrder.mainFirst') }}</span>
        <el-switch size="small" :model-value="order.mainFirst" :disabled="orderBusy || !canOrder" :aria-label="$t('mailboxOrder.mainFirst')" @change="setMainFirst"/>
      </label>
    </div>
    <div class="order-status" role="status" aria-live="polite" v-if="saving">{{ $t('mailboxOrder.saving') }}</div>
    <el-scrollbar class="scrollbar" ref="scrollbarRef">
      <el-skeleton class="account-skeleton" v-if="loading" :rows="5" animated/>
      <div class="order-load-error" v-else-if="loadFailed && !accounts.length">
        <p>{{ $t('mailboxOrder.loadFailed') }}</p>
        <el-button @click="refresh">{{ $t('mailboxOrder.refresh') }}</el-button>
      </div>
      <template v-else>
        <section class="account-section" v-for="section in sections" :key="section.key" :data-section="section.key">
          <div class="group-heading" v-if="!section.fixed">
            <span>{{ $t(section.label) }}</span><span class="group-count">{{ section.total }}</span>
          </div>
          <div :ref="el => setGroupElement(section.key, el)" class="group-list" :class="{'is-empty': !section.items.length, 'is-fixed': section.fixed}" :data-group="section.key">
            <el-card class="item mailbox-item" :class="itemBg(item.accountId)" v-for="item in section.items" :key="item.accountId" :data-account-id="item.accountId" @click="changeAccount(item)">
              <div class="account-title">
                <div class="account" :title="item.email">{{ item.email }}</div>
                <button v-if="!section.fixed && canOrder" type="button" class="mailbox-drag-handle" :disabled="orderBusy" :aria-label="$t('mailboxOrder.drag', {email: item.email})" :title="$t('mailboxOrder.drag', {email: item.email})" @click.stop>
                  <Icon :icon="mailboxIcons.dragDots" width="18" height="18"/>
                </button>
              </div>
              <div class="mailbox-badges" v-if="item.accountId === order.mainAccountId || isPinned(item)">
                <span class="mailbox-badge main-badge" v-if="item.accountId === order.mainAccountId">{{ $t('mailboxOrder.main') }}</span>
                <span class="mailbox-badge pinned-badge" v-if="isPinned(item)"><Icon :icon="mailboxIcons.pin" width="12" height="12"/>{{ $t('mailboxOrder.pinned') }}</span>
              </div>
              <div class="opt">
                <div class="send-email" @click.stop>
                  <Icon @click="setAllReceive(item)" v-if="!item.allReceive" icon="eva:email-fill" width="22" height="22" color="#fccb1a"/>
                  <Icon @click="setAllReceive(item)" v-else icon="flat-color-icons:folder" width="22" height="22" color="#23c4f1"/>
                </div>
                <div class="settings" @click.stop>
                  <Icon icon="fluent-color:clipboard-24" width="22" height="22" @click.stop="copyAccount(item.email)"/>
                  <Icon v-if="showNullSetting(item)" icon="fluent:settings-24-filled" width="21" height="21" color="#909399"/>
                  <el-dropdown v-else trigger="click" :disabled="orderBusy">
                    <button class="icon-button mailbox-menu" type="button" :disabled="orderBusy" :aria-label="$t('mailboxOrder.actions', {email: item.email})"><Icon icon="fluent:settings-24-filled" width="21" height="21" color="#909399"/></button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item v-if="hasPerm('email:send')" @click="openSetName(item)">{{ $t('rename') }}</el-dropdown-item>
                        <el-dropdown-item v-if="canOrder" @click="togglePinned(item)">{{ $t(isPinned(item) ? 'mailboxOrder.unpin' : 'pin') }}</el-dropdown-item>
                        <el-dropdown-item v-if="canMove(item)" :disabled="!canMoveDirection(item, -1)" @click="moveBy(item, -1)">{{ $t('mailboxOrder.moveUp') }}</el-dropdown-item>
                        <el-dropdown-item v-if="canMove(item)" :disabled="!canMoveDirection(item, 1)" @click="moveBy(item, 1)">{{ $t('mailboxOrder.moveDown') }}</el-dropdown-item>
                        <el-dropdown-item v-if="item.accountId !== order.mainAccountId && hasPerm('account:delete')" @click="remove(item)">{{ $t('delete') }}</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </div>
            </el-card>
            <div class="group-empty" v-if="!section.fixed && !section.items.length">{{ $t('mailboxOrder.dropHere') }}</div>
          </div>
          <button v-if="!section.fixed && section.items.length < section.total" type="button" class="load-more" @click="showMore(section.key)">{{ $t('mailboxOrder.loadMore', {count: section.total - section.items.length}) }}</button>
        </section>
      </template>
    </el-scrollbar>
    <el-dialog v-model="showAdd" :title="$t('addAccount')">
      <div class="container">
        <el-input v-model="addForm.email" ref="addRef" type="text" :placeholder="$t('emailAccount')" autocomplete="off" @keyup.enter="submit">
          <template #append>
            <div @click.stop="openSelect">
              <el-select
                  ref="mySelect"
                  v-model="addForm.suffix"
                  :placeholder="$t('select')"
                  class="select"
              >
                <el-option
                    v-for="item in domainList"
                    :key="item"
                    :label="item"
                    :value="item"
                />
              </el-select>
              <div>
                <span>{{ addForm.suffix }}</span>
                <Icon class="setting-icon" icon="mingcute:down-small-fill" width="20" height="20"/>
              </div>
            </div>
          </template>
        </el-input>
        <el-button class="btn" type="primary" @click="submit" :loading="addLoading"
        >{{ $t('add') }}
        </el-button>
      </div>
      <div
          ref="turnstileContainer"
          :key="turnstileContainerKey"
          class="add-email-turnstile"
          :class="verifyShow ? 'turnstile-show' : 'turnstile-hide'"
          :data-sitekey="settingStore.settings.siteKey"
          data-callback="onTurnstileSuccess"
          data-error-callback="onTurnstileError"
      >
        <span style="font-size: 12px;color: #F56C6C" v-if="botJsError">{{ $t('verifyModuleFailed', {action: $t('add')}) }}</span>
      </div>
    </el-dialog>
    <el-dialog v-model="setNameShow" :title="$t('changeUserName')">
      <div class="container">
        <el-input v-model="accountName" type="text" :placeholder="$t('username')" autocomplete="off" @keyup.enter="setName">
        </el-input>
        <el-button class="btn" type="primary" @click="setName" :loading="setNameLoading"
        >{{ $t('save') }}
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>
<script setup>
import {Icon} from "@iconify/vue";
import {computed, nextTick, reactive, ref, watch} from "vue";
import {
  accountAdd,
  accountDelete,
  accountSetName,
  accountSetAllReceive
} from "@/request/account.js";
import {useMailboxOrder} from './use-mailbox-order.js';
import mailboxIcons from '@/utils/mailbox-icons.js';
import {isEmail} from "@/utils/verify-utils.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {useUserStore} from "@/store/user.js";
import {hasPerm} from "@/perm/perm.js"
import {useI18n} from "vue-i18n";
import {AccountAllReceiveEnum} from "@/enums/account-enum.js";
import {reloadTurnstileScript} from "@/utils/turnstile-script.js";

const {t} = useI18n();
const userStore = useUserStore();
const accountStore = useAccountStore();
const settingStore = useSettingStore();
const emailStore = useEmailStore();
const showAdd = ref(false)
const addLoading = ref(false);
const domainList = computed(() => settingStore.domainList)
const {
  accounts, order, loading, saving, loadFailed, sections, canOrder, orderBusy, membershipBusy,
  scrollbarRef, isPinned, canMove, canMoveDirection, setMainFirst, togglePinned, sortBy, moveBy,
  showMore, setGroupElement, refresh, changeAccount, getAccountList, forgetAccount
} = useMailboxOrder(addLoading)
const verifyShow = ref(false)
const setNameShow = ref(false)
const setNameLoading = ref(false)
const accountName = ref(null)
const addRef = ref({})
let account = null
let turnstileId = null
const botJsError = ref(false)
let verifyToken = ''
let verifyErrorCount = 0
let turnstileRecoveryAttempted = false
const turnstileContainer = ref(null)
const turnstileContainerKey = ref(0)
const addForm = reactive({
  email: '',
  suffix: settingStore.domainList[0]
})
const mySelect = ref()

watch(() => settingStore.domainList, (list) => {
  if (!addForm.suffix && list.length > 0) {
    addForm.suffix = list[0]
  }
}, {immediate: true})


const openSelect = () => {
  mySelect.value.toggleMenu()
}

async function recoverTurnstile() {
  if (turnstileRecoveryAttempted) return
  turnstileRecoveryAttempted = true
  botJsError.value = false
  verifyToken = ''
  turnstileId = null
  turnstileContainerKey.value++
  try {
    const api = await reloadTurnstileScript()
    await nextTick()
    if (!showAdd.value || !turnstileContainer.value) return
    turnstileId = api.render(turnstileContainer.value)
  } catch (error) {
    botJsError.value = true
    console.warn('Turnstile recovery failed', error)
  } finally {
    turnstileRecoveryAttempted = false
  }
}

window.onTurnstileError = (e) => {
  if (verifyErrorCount >= 4) {
    return
  }
  verifyErrorCount++
  console.warn('人机验加载失败', e)
  setTimeout(() => {
    nextTick(() => {
      if (!turnstileId) {
        turnstileId = window.turnstile.render('.add-email-turnstile')
      } else {
        window.turnstile.reset(turnstileId);
      }
    })
  }, 1500)
};

window.onTurnstileSuccess = (token) => {
  verifyToken = token;
};

function setName() {

  if (setNameLoading.value) return

  let name = accountName.value

  if (name === account.name) {
    setNameShow.value = false
    return
  }

  if (!name) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return;
  }

  setNameLoading.value = true
  accountSetName(account.accountId, name).then(() => {
    account.name = name
    setNameShow.value = false

    if (account.accountId === userStore.user.account.accountId) {
      userStore.user.name = name
    }

    ElMessage({
      message: t('saveSuccessMsg'),
      type: "success",
      plain: true
    })
  }).finally(() => {
    setNameLoading.value = false
  })
}

function openSetName(accountItem) {
  accountName.value = accountItem.name
  account = accountItem
  setNameShow.value = true
}

function setAllReceive(account) {
  if (orderBusy.value) return
  let allReceiveAccount = accounts.find(account => account.allReceive === AccountAllReceiveEnum.ENABLED);
  if (allReceiveAccount && allReceiveAccount.accountId !== account.accountId) allReceiveAccount.allReceive = AccountAllReceiveEnum.DISABLED;
  account.allReceive = account.allReceive === AccountAllReceiveEnum.DISABLED ? AccountAllReceiveEnum.ENABLED : AccountAllReceiveEnum.DISABLED;
  accountSetAllReceive(account.accountId).catch(() => {
    account.allReceive = account.allReceive === AccountAllReceiveEnum.DISABLED ? AccountAllReceiveEnum.ENABLED : AccountAllReceiveEnum.DISABLED;
    if (allReceiveAccount) allReceiveAccount.allReceive = AccountAllReceiveEnum.ENABLED;
  }).then(() => {
    if (account.allReceive === AccountAllReceiveEnum.ENABLED) {
      ElMessage({
        message: t('setSuccess'),
        type: 'success',
        plain: true,
      })
    }
    changeAccount(account);
    emailStore.emailScroll?.refreshList();
    emailStore.sendScroll?.refreshList();
  })
}


function showNullSetting(item) {
  return !hasPerm('email:send') && !canOrder.value && !(item.accountId !== order.mainAccountId && hasPerm('account:delete'))
}

function itemBg(accountId) {
  return accountStore.currentAccountId === accountId ? 'item-choose' : ''
}



function remove(account) {
  if (orderBusy.value) return
  ElMessageBox.confirm(t('delConfirm', {msg: account.email}), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(async () => {
    if (orderBusy.value) return
    membershipBusy.value = true
    try {
      await accountDelete(account.accountId)
      forgetAccount(account.accountId)
      await getAccountList()
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    } finally {
      membershipBusy.value = false
    }
  }).catch(() => {});
}

function add() {
  if (orderBusy.value) return
  addForm.suffix = addForm.suffix || settingStore.domainList[0]
  showAdd.value = true
  setTimeout(() => {
    addRef.value.focus()
  }, 100)
}

async function copyAccount(account) {
  try {
    await navigator.clipboard.writeText(account);
    ElMessage({
      message: t('copySuccessMsg'),
      type: 'success',
      plain: true,
    })
  } catch (err) {
    console.error(`${t('copyFailMsg')}:`, err);
    ElMessage({
      message: t('copyFailMsg'),
      type: 'error',
      plain: true,
    })
  }
}

function submit() {

  if (addLoading.value) return

  if (!addForm.email) {
    ElMessage({
      message: t('emptyEmailMsg'),
      type: "error",
      plain: true
    })
    return
  }

  if (addForm.email.length < settingStore.settings.minEmailPrefix) {
    ElMessage({
      message: t('minEmailPrefix', {msg: settingStore.settings.minEmailPrefix}),
      type: 'error',
      plain: true,
    })
    return
  }

  if (!isEmail(addForm.email + addForm.suffix)) {
    ElMessage({
      message: t('notEmailMsg'),
      type: "error",
      plain: true
    })
    return
  }

  if (!verifyToken && (settingStore.settings.addEmailVerify === 0 || (settingStore.settings.addEmailVerify === 2 && settingStore.settings.addVerifyOpen))) {
    if (turnstileRecoveryAttempted) return
    if (!verifyShow.value) {
      verifyShow.value = true
      nextTick(() => {
        if (!turnstileId) {
          try {
            turnstileId = window.turnstile.render('.add-email-turnstile')
          } catch (e) {
            botJsError.value = true
            console.log('人机验证js加载失败')
            recoverTurnstile()
          }
        } else {
          window.turnstile.reset('.add-email-turnstile')
        }
      })
    } else if (botJsError.value) {
      recoverTurnstile()
    } else {
      ElMessage({
        message: t('botVerifyMsg'),
        type: "error",
        plain: true
      })
    }
    return;
  }

  addLoading.value = true
  accountAdd(addForm.email + addForm.suffix, verifyToken).then(async account => {
    addForm.email = ''
    verifyToken = ''
    settingStore.settings.addVerifyOpen = account.addVerifyOpen
    ElMessage({
      message: t('addSuccessMsg'),
      type: "success",
      plain: true
    })
    verifyShow.value = false
    showAdd.value = false
    userStore.refreshUserInfo()
    await getAccountList()
    addLoading.value = false
  }).catch(res => {
    if (res.code === 400) {
      verifyToken = ''
      if (turnstileId) {
        window.turnstile.reset(turnstileId)
      } else {
        nextTick(() => {
          turnstileId = window.turnstile.render('.add-email-turnstile')
        })
      }
      verifyShow.value = true
    }
    addLoading.value = false
  })
}
</script>
<style>
path[fill="#ffdda1"] {
  fill: #ffdd7d;
}
</style>
<style scoped lang="scss">
.account-box {

  border-right: 1px solid var(--el-border-color) !important;
  background-color: var(--el-bg-color);
  height: 100%;
  overflow: hidden;

  .head-opt {
    display: flex;
    align-items: center;
    height: 38px;
    box-shadow: var(--header-actions-border);
    padding-left: 10px;
    padding-right: 10px;

    .icon {
      cursor: pointer;
    }

    .refresh {
      margin-left: 10px;
    }

    .add {
      margin-left: 2px;
    }

    .head-opt:not(.add) .refresh {
      margin-left: 5px;
    }
  }

  .scrollbar {
    width: 100%;
    height: calc(100% - 38px);
    overflow: auto;
    @media (max-width: 767px) {
      height: calc(100% - 98px);
    }

    .empty {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
    }

    .noLoading {
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 10px 0;
      color: var(--secondary-text-color);
    }
  }

  .btn {
    width: 100%;
    margin-top: 15px;
  }

  .item {
    background-color: var(--el-bg-color);
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 11px;
    margin-left: 10px;
    margin-right: 10px;
    cursor: pointer;

    .account {
      font-weight: 400;
      font-size: 15px;
      margin-bottom: 20px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .opt {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: #888;

      .settings {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .send-email {
        display: flex;
        align-items: center;
      }
    }

    :deep(.el-card__body) {
      padding: 0;
    }
  }

  .item:first-child {
    margin-top: 10px;
  }

  .item-choose {
    background: var(--choose-account-background);
  }
}


.setting-icon {
  position: relative;
  top: 6px;
}

:deep(.el-input-group__append) {
  padding: 0 !important;
  padding-left: 8px !important;
  background: var(--el-bg-color);
}

:deep(.el-dialog) {
  width: 400px !important;
  @media (max-width: 440px) {
    width: calc(100% - 40px) !important;
    margin-right: 20px !important;
    margin-left: 20px !important;
  }
}

.select {
  position: absolute;
  right: 30px;
  width: 100px;
  opacity: 0;
  pointer-events: none;
}

:deep(.el-pagination .el-select) {
  width: 100px;
  background: var(--el-bg-color);
}

.add-email-turnstile {
  margin-top: 15px;
}

.turnstile-show {
  opacity: 1;
}

.turnstile-hide {
  opacity: 0;
  pointer-events: none;
  position: fixed;
}

</style>
<style scoped lang="scss" src="./mailbox-order.scss"></style>
