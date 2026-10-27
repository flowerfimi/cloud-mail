<template>
  <el-dialog :model-value="!!email" :title="t('subdomain.created')" width="min(440px, calc(100vw - 32px))"
             append-to-body @update:model-value="!$event && (email = '')">
    <div class="created-email">
      <el-input :model-value="email" :aria-label="t('emailAccount')" readonly @focus="$event.target.select()"/>
      <el-button type="primary" @click="copy">{{ t('subdomain.copy') }}</el-button>
    </div>
  </el-dialog>
</template>

<script setup>
import {useI18n} from 'vue-i18n';
const email = defineModel({type: String, default: ''});
const {t} = useI18n();
async function copy() {
  try {
    await navigator.clipboard.writeText(email.value);
    ElMessage({message: t('copySuccessMsg'), type: 'success', plain: true});
  } catch {
    ElMessage({message: t('copyFailMsg'), type: 'error', plain: true});
  }
}
</script>

<style scoped>
.created-email { display: flex; align-items: center; gap: 10px; }
.created-email .el-input { min-width: 0; }
</style>
