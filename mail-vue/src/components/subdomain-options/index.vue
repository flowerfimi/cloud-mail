<template>
  <div class="subdomain-options">
    <div v-if="controlsFirst" class="subdomain-controls">
      <el-radio-group v-model="mode" :disabled="disabled" :aria-label="t('subdomain.mode')" size="small">
        <el-radio-button value="normal">{{ t('subdomain.normal') }}</el-radio-button>
        <el-radio-button value="random">{{ t('subdomain.random') }}</el-radio-button>
        <el-radio-button value="manual">{{ t('subdomain.manual') }}</el-radio-button>
      </el-radio-group>
    </div>
    <div class="mailbox-address" :class="{'is-disabled': disabled}" @keydown.enter.prevent="$emit('submit')">
      <div class="address-field prefix-field">
        <div class="field-heading">
          <span>{{ showDomain ? t('subdomain.prefix') : t('emailAccount') }}</span>
          <button type="button" class="address-action" :disabled="disabled || generatingPrefix"
                  :title="t('subdomain.randomPrefix')" :aria-label="t('subdomain.randomPrefix')" :aria-busy="generatingPrefix"
                  @keydown.enter.stop @click="generatePrefix">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5"/>
              <path d="M20 3.5v5h-5Z" fill="currentColor" stroke="none"/>
            </svg>
          </button>
        </div>
        <input ref="emailInput" v-model="localPart" class="mailbox-local" :disabled="disabled || generatingPrefix" :aria-busy="generatingPrefix"
               :placeholder="t('emailAccount')" :aria-label="t('emailAccount')" autocomplete="off" spellcheck="false"/>
      </div>
      <template v-if="showDomain">
        <span class="address-separator">@</span>
        <template v-if="mode !== 'normal'">
          <div class="address-field">
            <div class="field-heading">
              <span>{{ t('subdomain.label') }}</span>
              <button v-if="mode === 'random'" type="button" class="address-action" :disabled="disabled || generating"
                      :title="t('subdomain.refresh')" :aria-label="t('subdomain.refresh')" :aria-busy="generating"
                      @keydown.enter.stop @click="generate">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5"/>
                  <path d="M20 3.5v5h-5Z" fill="currentColor" stroke="none"/>
                </svg>
              </button>
            </div>
            <input ref="subdomainInput" v-model="label" class="mailbox-subdomain" :disabled="disabled || generating" :aria-busy="generating"
                   :placeholder="generating ? '…' : 'mail'" :aria-label="t('subdomain.label')" maxlength="63"
                   autocomplete="off" spellcheck="false" autocapitalize="none" @blur="checkOnBlur"/>
          </div>
          <span class="address-separator">.</span>
        </template>
        <div class="address-field root-field">
          <div class="field-heading"><span>{{ t('subdomain.root') }}</span></div>
          <el-select v-if="canSelectDomain" v-model="suffix" class="mailbox-root-select" :disabled="disabled"
                     :aria-label="t('subdomain.root')">
            <el-option v-for="domain in domains" :key="domain" :value="domain" :label="domain.replace(/^@/, '')"/>
          </el-select>
          <input v-else v-model="root" class="mailbox-root-input" :disabled="disabled"
                 :placeholder="t('subdomain.root')" :aria-label="t('subdomain.root')" autocomplete="off" spellcheck="false"/>
        </div>
      </template>
    </div>
    <div v-if="!controlsFirst" class="subdomain-controls">
      <el-radio-group v-model="mode" :disabled="disabled" :aria-label="t('subdomain.mode')" size="small">
        <el-radio-button value="normal">{{ t('subdomain.normal') }}</el-radio-button>
        <el-radio-button value="random">{{ t('subdomain.random') }}</el-radio-button>
        <el-radio-button value="manual">{{ t('subdomain.manual') }}</el-radio-button>
      </el-radio-group>
    </div>
    <span v-if="mode !== 'normal' && !generating && checked && !validSubdomain(label)" class="error" role="alert">{{ t('subdomain.invalid') }}</span>
  </div>
</template>

<script setup>
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {useI18n} from 'vue-i18n';
import {normalizeSubdomain, subdomainRequest, validSubdomain} from '@/utils/mailbox-domain.js';
import {randomSubdomain} from '@/request/login.js';

const props = defineProps({disabled: Boolean, hideDomains: Boolean, controlsFirst: Boolean, domains: {type: Array, default: () => []}});
defineEmits(['submit']);
const email = defineModel('email', {type: String, default: ''});
const suffix = defineModel('suffix', {type: String, default: ''});
const mode = defineModel('mode', {type: String, default: 'normal'});
const subdomain = defineModel('subdomain', {type: String, default: ''});
const {t} = useI18n();
const checked = ref(false);
const generating = ref(false);
const generatingPrefix = ref(false);
const emailInput = ref(null);
const subdomainInput = ref(null);
const hasDomain = computed(() => email.value.includes('@'));
const canSelectDomain = computed(() => !props.hideDomains && props.domains.length > 0 && !hasDomain.value);
const showDomain = computed(() => mode.value !== 'normal' || canSelectDomain.value);
const root = computed({
  get: () => hasDomain.value ? email.value.split('@')[1] : (props.hideDomains ? '' : suffix.value.replace(/^@/, '')),
  set: value => { email.value = email.value.split('@')[0] + '@' + value; },
});
const localPart = computed({
  get: () => mode.value !== 'normal' ? email.value.split('@')[0] : email.value,
  set: value => {
    email.value = mode.value !== 'normal' && hasDomain.value && !value.includes('@') ? value + '@' + root.value : value;
  },
});
const label = computed({
  get: () => subdomain.value,
  set: value => { subdomain.value = normalizeSubdomain(value); },
});
let generation = 0;
watch(mode, async value => {
  const current = ++generation;
  checked.value = false;
  generating.value = false;
  subdomain.value = '';
  if (value === 'random') return generate();
  await nextTick();
  if (value === 'manual' && current === generation) subdomainInput.value?.focus();
});
async function generate() {
  if (props.disabled || generating.value || mode.value !== 'random') return;
  const current = ++generation;
  checked.value = false;
  generating.value = true;
  try {
    const result = await randomSubdomain();
    if (current === generation) subdomain.value = result.subdomain;
  } catch {
    // The request interceptor displays the error; the field remains editable.
  } finally {
    if (current === generation) generating.value = false;
  }
}
let prefixGeneration = 0;
async function generatePrefix() {
  if (props.disabled || generatingPrefix.value) return;
  const current = ++prefixGeneration;
  generatingPrefix.value = true;
  try {
    const result = await randomSubdomain();
    if (current === prefixGeneration) {
      email.value = result.subdomain + (hasDomain.value ? '@' + root.value : '');
    }
  } catch {
    // Keep the previous prefix when generation fails.
  } finally {
    if (current === prefixGeneration) generatingPrefix.value = false;
  }
}
onBeforeUnmount(() => { generation++; prefixGeneration++; });
function checkOnBlur(event) {
  if (generating.value || event.relatedTarget?.closest('.subdomain-controls, .address-action')) return;
  // Empty fields are checked on submit, so leaving a fresh manual field stays quiet.
  if (subdomain.value) checked.value = true;
}
function validate() {
  checked.value = true;
  return !generating.value && !generatingPrefix.value && (mode.value === 'normal' || validSubdomain(subdomain.value));
}
defineExpose({validate, focus: () => emailInput.value?.focus(), fields: () => subdomainRequest(mode.value, subdomain.value)});
</script>

<style scoped>
.subdomain-options { display: grid; gap: 10px; min-width: 0; }
.subdomain-controls :deep(.el-radio-group) { display: inline-flex; gap: 4px; padding: 0; background: transparent; }
.subdomain-controls :deep(.el-radio-button__inner) { padding: 7px 10px; border: 0 !important; outline: 0; border-radius: 4px !important; box-shadow: none !important; background: transparent; color: var(--el-text-color-secondary); }
.subdomain-controls :deep(.el-radio-button.is-active .el-radio-button__inner) { color: var(--el-color-white); background: var(--el-color-primary); }
.subdomain-controls :deep(.el-radio-button__original-radio:focus-visible + .el-radio-button__inner) { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
.mailbox-address { display: flex; align-items: end; gap: 5px; min-width: 0; color: var(--el-text-color-regular); font-size: 14px; }
.address-field { display: grid; gap: 5px; flex: 1 1 0; min-width: 0; }
.root-field { flex: 0 0 112px; }
.field-heading { display: flex; align-items: center; gap: 2px; height: 24px; color: var(--el-text-color-secondary); font-size: 12px; }
.address-action { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 24px; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; color: var(--el-text-color-regular); background: transparent; cursor: pointer; }
.address-action svg { display: block; flex: none; }
.address-action:hover:not(:disabled), .address-action:focus-visible { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.address-action:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
.address-action:disabled { color: var(--el-disabled-text-color); cursor: default; }
.address-separator { flex: 0 0 auto; line-height: 36px; color: var(--el-text-color-placeholder); }
.address-field > input { box-sizing: border-box; min-width: 0; width: 100%; height: 36px; padding: 0 8px; border: 1px solid var(--el-border-color); outline: 0; border-radius: 5px; background: var(--el-bg-color); color: inherit; font: inherit; }
.address-field > input:hover:not(:disabled) { border-color: var(--el-border-color-hover); }
.address-field > input:focus { border-color: var(--el-color-primary); box-shadow: 0 0 0 2px var(--el-color-primary-light-9); }
.address-field > input:disabled { background: var(--el-disabled-bg-color); }
.address-field > input::placeholder { color: var(--el-text-color-placeholder); }
.mailbox-root-select { width: 100%; }
.mailbox-root-select :deep(.el-select__wrapper) { padding: 0 8px; min-height: 36px; border-radius: 5px; background: var(--el-bg-color); }
.mailbox-root-select :deep(.el-select__suffix) { margin-left: 2px; }
.error { color: var(--el-color-danger); font-size: 12px; line-height: 1.5; }
</style>
