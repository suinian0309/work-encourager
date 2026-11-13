<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  open: boolean
  mode: 'shift' | 'settled'
  workedHours: string
  earnedText: string
}>()

const emit = defineEmits<{
  (e: 'next'): void
  (e: 'current'): void
  (e: 'cancel'): void
}>()

const isShift = computed(() => props.mode === 'shift')

const message = computed(() =>
  isShift.value
    ? `当前正处于班次中，已工作 ${props.workedHours} 小时、已赚 ¥${props.earnedText}。新设置从什么时候生效？`
    : `今天的班次已结束并结算为 ¥${props.earnedText}。新设置从什么时候生效？`
)

const primaryTitle = computed(() => (isShift.value ? '从下一班次生效' : '从明天开始生效'))
const primaryDesc = computed(() =>
  isShift.value ? '今天已赚不变，历史记录保持原值（推荐）' : '今天的日结记录保持原值（推荐）'
)
const secondaryTitle = computed(() => (isShift.value ? '立即应用到当前班次' : '重新计算今天'))
const secondaryDesc = computed(() =>
  isShift.value
    ? '会重新计算今日已赚，历史日结记录不受影响'
    : '会更新今天已生成的日结记录，之前的日期不受影响'
)
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="open" class="modal-mask" @click.self="emit('cancel')">
        <div class="modal scope-modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div class="modal-icon">
              <AppIcon name="clock" :size="18" />
            </div>
            <div class="modal-title">保存设置</div>
          </div>
          <p class="modal-message">{{ message }}</p>

          <div class="scope-options">
            <button type="button" class="scope-option" @click="emit('next')">
              <span class="scope-option-title">{{ primaryTitle }}</span>
              <span class="scope-option-desc">{{ primaryDesc }}</span>
            </button>
            <button type="button" class="scope-option scope-option--warn" @click="emit('current')">
              <span class="scope-option-title">{{ secondaryTitle }}</span>
              <span class="scope-option-desc">{{ secondaryDesc }}</span>
            </button>
          </div>

          <div class="modal-actions modal-actions--single">
            <button class="btn btn-ghost" type="button" @click="emit('cancel')">取消</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.scope-modal {
  max-width: 330px;
}

.modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.modal-icon {
  width: 34px;
  height: 34px;
  border-radius: 11px;
  background: var(--mint-soft);
  color: var(--green);
  display: grid;
  place-items: center;
}

.modal-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
}

.modal-message {
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text);
}

.scope-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.scope-option {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid rgba(52, 179, 136, 0.28);
  background: rgba(52, 179, 136, 0.08);
  transition: background 0.16s ease, border-color 0.16s ease, transform 0.16s ease;
}

.scope-option:hover {
  background: rgba(52, 179, 136, 0.16);
  border-color: rgba(52, 179, 136, 0.45);
}

.scope-option:active {
  transform: scale(0.99);
}

.scope-option--warn {
  border-color: rgba(224, 122, 95, 0.32);
  background: rgba(224, 122, 95, 0.08);
}

.scope-option--warn:hover {
  background: rgba(224, 122, 95, 0.16);
  border-color: rgba(224, 122, 95, 0.5);
}

.scope-option-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--ink);
}

.scope-option-desc {
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--muted);
}

.modal-actions--single {
  justify-content: flex-end;
}

.modal-actions--single .btn {
  flex: 0 0 96px;
}

.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.16s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
</style>
