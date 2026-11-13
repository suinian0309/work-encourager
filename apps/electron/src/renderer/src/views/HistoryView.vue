<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { HistoryView as HistoryData } from '@shared/types'
import AppIcon from '../components/AppIcon.vue'

const props = defineProps<{ dataPath: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'toast', message: string): void }>()

const data = ref<HistoryData | null>(null)
const loading = ref(true)
const error = ref('')
let unsubscribe: (() => void) | null = null

async function load(): Promise<void> {
  try {
    data.value = await window.workEncourager.getHistory()
    error.value = ''
  } catch (err) {
    error.value = (err as Error).message || '读取历史记录失败'
  } finally {
    loading.value = false
  }
}

async function openFolder(): Promise<void> {
  try {
    await window.workEncourager.openDataFolder()
  } catch (err) {
    emit('toast', `无法打开目录：${(err as Error).message}`)
  }
}

onMounted(() => {
  void load()
  unsubscribe = window.workEncourager.onHistoryUpdated(() => {
    void load()
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>

<template>
  <div class="screen history-screen">
    <header class="screen-head">
      <button class="icon-btn" type="button" title="返回" @click="emit('close')">
        <AppIcon name="back" :size="18" />
      </button>
      <span class="screen-title">历史记录</span>
      <span class="screen-sub">{{ data?.monthLabel ?? '' }}</span>
    </header>

    <div v-if="loading" class="loading">
      <div>
        <div class="spinner"></div>
        正在读取记录…
      </div>
    </div>

    <div v-else-if="error" class="empty">
      {{ error }}
      <div style="margin-top: 10px">
        <button class="btn btn-ghost btn-sm" type="button" @click="emit('close')">返回</button>
      </div>
    </div>

    <template v-else-if="data">
      <section class="card summary-card fade-in">
        <div class="summary-label">本月合计</div>
        <div class="summary-value num">¥{{ data.monthTotalText }}</div>
        <div class="summary-meta">
          已记录 {{ data.recordCount }} 个工作日 · 全部累计 ¥{{ data.allTotalText }}
        </div>
      </section>

      <div v-if="data.rows.length === 0" class="card empty-card">
        <div class="empty-icon">
          <AppIcon name="history" :size="22" />
        </div>
        <p>还没有已结算的记录。</p>
        <p class="empty-sub">下班后会自动生成当天记录；首次安装从今天开始计算。</p>
      </div>

      <div v-else class="record-list">
        <article
          v-for="row in data.rows"
          :key="row.workDate"
          class="card record-card"
          :class="{ 'record-card--today': row.isToday }"
        >
          <div class="record-main">
            <div class="record-date">
              <span class="num">{{ row.workDate }}</span>
              <span class="record-weekday">{{ row.weekdayText }}</span>
              <span v-if="row.live" class="today-tag">进行中</span>
              <span v-else-if="row.isToday" class="today-tag">今天</span>
            </div>
            <div class="record-basis">{{ row.basisText }}</div>
            <div class="record-meta">
              <span>{{ row.wageModeText }}</span>
              <span class="dot">·</span>
              <span>计薪 {{ row.hoursText }} 小时</span>
              <span v-if="row.overtimeText" class="dot">·</span>
              <span v-if="row.overtimeText" class="overtime-tag">{{ row.overtimeText }}</span>
            </div>
          </div>
          <div class="record-income num">¥{{ row.incomeText }}</div>
        </article>
      </div>

      <footer class="history-foot">
        <button class="data-link" type="button" @click="openFolder">
          <AppIcon name="folder" :size="13" />
          本地数据：{{ props.dataPath || data.dataPath }}
        </button>
        <span>历史记录使用当日保存的工资参数，修改设置不会改变已结算收入。</span>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.history-screen {
  padding-bottom: 14px;
}

.summary-card {
  padding: 14px 16px;
  margin-bottom: 10px;
  background:
    radial-gradient(120% 120% at 100% 0%, rgba(52, 179, 136, 0.18), transparent 65%),
    var(--card);
}

.summary-label {
  font-size: 11px;
  color: var(--muted);
}

.summary-value {
  font-size: 30px;
  font-weight: 700;
  color: var(--green);
  line-height: 1.3;
}

.summary-meta {
  font-size: 10.5px;
  color: var(--muted);
  margin-top: 2px;
}

.record-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.record-card {
  border-radius: 18px;
  padding: 11px 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  box-shadow: var(--shadow-soft);
}

.record-card--today {
  border-color: rgba(52, 179, 136, 0.35);
}

.record-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.record-date {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
}

.record-weekday {
  font-size: 10.5px;
  color: var(--muted);
  font-weight: 400;
}

.today-tag {
  font-size: 9px;
  color: var(--mint-deep);
  background: rgba(52, 179, 136, 0.12);
  padding: 1px 6px;
  border-radius: 999px;
}

.record-basis {
  font-size: 10px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 190px;
}

.record-meta {
  font-size: 10px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 4px;
}

.dot {
  opacity: 0.6;
}

.overtime-tag {
  color: var(--mint-deep);
}

.record-income {
  font-size: 15px;
  font-weight: 700;
  color: var(--green);
  flex: none;
}

.empty-card {
  padding: 24px 18px;
  text-align: center;
}

.empty-icon {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  margin: 0 auto 10px;
  display: grid;
  place-items: center;
  background: var(--mint-soft);
  color: var(--green);
}

.empty-card p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text);
}

.empty-card .empty-sub {
  font-size: 11px;
  color: var(--muted);
  margin-top: 5px;
  line-height: 1.6;
}

.history-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
  padding: 0 4px;
  font-size: 10px;
  color: var(--muted);
  line-height: 1.6;
}

.data-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: transparent;
  color: var(--mint-deep);
  font-size: 10.5px;
  padding: 0;
  text-align: left;
  text-decoration: underline;
  word-break: break-all;
}
</style>
