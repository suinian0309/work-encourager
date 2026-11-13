<script setup lang="ts">
import AppIcon from './AppIcon.vue'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    message: string
    confirmText?: string
    cancelText?: string
    danger?: boolean
  }>(),
  { confirmText: '确认', cancelText: '取消', danger: false }
)

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade">
      <div v-if="open" class="modal-mask" @click.self="emit('cancel')">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div class="modal-icon" :class="{ 'modal-icon--danger': danger }">
              <AppIcon :name="danger ? 'history' : 'spark'" :size="18" />
            </div>
            <div class="modal-title">{{ title }}</div>
          </div>
          <p class="modal-message">{{ message }}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" type="button" @click="emit('cancel')">
              {{ cancelText }}
            </button>
            <button
              class="btn"
              :class="danger ? 'btn-danger' : 'btn-primary'"
              type="button"
              @click="emit('confirm')"
            >
              {{ confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
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

.modal-icon--danger {
  background: rgba(194, 92, 85, 0.12);
  color: var(--danger);
}

.modal-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--ink);
}

.modal-message {
  margin: 0 0 18px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text);
  white-space: pre-line;
}

.modal-actions {
  display: flex;
  gap: 8px;
}

.modal-actions .btn {
  flex: 1;
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
