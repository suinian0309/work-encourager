<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SaveSettingsResult, Settings } from '@shared/types'
import { defaultSettings, WEEKDAY_SHORT } from '@shared/defaults'
import { firstIssueMap, validateSettings } from '@shared/validation'
import { buildShiftShape } from '@shared/schedule'
import { formatMoney, formatPerSecond, resolveWage } from '@shared/wage'
import { minutesToHHMM, parseHHMM, toDateKey } from '@shared/date'
import AppIcon from '../components/AppIcon.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import SaveScopeDialog from '../components/SaveScopeDialog.vue'

const props = defineProps<{
  initial: Settings
  pendingFrom: string | null
  dataPath: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', result: SaveSettingsResult): void
  (e: 'toast', message: string): void
}>()

function clone(input: Settings): Settings {
  return JSON.parse(JSON.stringify(input)) as Settings
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

const draft = ref<Settings>(clone(props.initial))
const errors = ref<Record<string, string>>({})
const saving = ref(false)
const scopeDialog = ref(false)
const scopeMode = ref<'shift' | 'settled'>('shift')
const scopeInfo = ref({ workedHours: '0.00', earnedText: '0.00' })
const confirmDefaults = ref(false)
const todayKey = toDateKey(new Date())

const isMonthly = computed(() => draft.value.wageMode === 'monthly')
const isDaily = computed(() => draft.value.wageMode === 'daily')
const isHourly = computed(() => draft.value.wageMode === 'hourly')

const preview = computed(() => {
  try {
    const shift = buildShiftShape(draft.value, todayKey)
    if (!shift || shift.paidSeconds <= 0) return null
    const wage = resolveWage(draft.value, shift)
    return {
      daily: formatMoney(wage.dailyWage, 2),
      hourly: formatMoney(wage.hourlyWage, 2),
      hourlyValue: wage.hourlyWage,
      perSecond: formatPerSecond(wage.perSecond),
      plannedHours: (shift.paidSeconds / 3600).toFixed(2),
      days: wage.monthlyDays
    }
  } catch {
    return null
  }
})

const overtimePreview = computed(() => {
  const base =
    draft.value.overtimeRateMode === 'custom'
      ? draft.value.overtimeHourlyRate
      : (preview.value?.hourlyValue ?? 0)
  const hourly = base * draft.value.overtimeMultiplier
  return {
    base: formatMoney(base, 2),
    hourly: formatMoney(hourly, 2),
    perSecond: formatPerSecond(hourly / 3600)
  }
})

function err(field: string): string {
  return errors.value[field] ?? ''
}

function toggleWeekday(day: number): void {
  const list = draft.value.weekdays
  const index = list.indexOf(day)
  if (index >= 0) list.splice(index, 1)
  else list.push(day)
  list.sort((a, b) => a - b)
}

function addBreak(): void {
  const last = draft.value.breaks[draft.value.breaks.length - 1]
  const start = last?.end ?? '12:00'
  const startMinutes = parseHHMM(start) ?? 12 * 60
  draft.value.breaks.push({
    id: uid('break'),
    start,
    end: minutesToHHMM(startMinutes + 60),
    paid: false
  })
}

function removeBreak(index: number): void {
  draft.value.breaks.splice(index, 1)
}

function addSpecialDay(): void {
  const base = new Date()
  base.setDate(base.getDate() + 1)
  draft.value.specialDays.push({
    id: uid('day'),
    date: toDateKey(base),
    type: 'off'
  })
}

function removeSpecialDay(index: number): void {
  draft.value.specialDays.splice(index, 1)
}

function addTarget(): void {
  draft.value.targets.push({ id: uid('target'), name: '', price: 10 })
}

function removeTarget(index: number): void {
  draft.value.targets.splice(index, 1)
}

function moveTarget(index: number, delta: number): void {
  const next = index + delta
  if (next < 0 || next >= draft.value.targets.length) return
  const list = draft.value.targets
  const [item] = list.splice(index, 1)
  list.splice(next, 0, item)
}

function restoreDefaults(): void {
  draft.value = defaultSettings()
  errors.value = {}
  confirmDefaults.value = false
  emit('toast', '已填入默认设置，点击保存后生效')
}

async function save(): Promise<void> {
  const issues = validateSettings(draft.value)
  errors.value = firstIssueMap(issues)
  if (issues.length > 0) {
    emit('toast', issues[0].message)
    return
  }

  try {
    const state = await window.workEncourager.getState()
    const todayKey = toDateKey(new Date())
    const inShift =
      state.status === 'working' ||
      state.status === 'on-break' ||
      state.status === 'overtime' ||
      (state.status === 'paused' && state.isWorkday && state.shiftDate === todayKey)

    let settledToday = false
    if (!inShift && state.status === 'after-work') {
      const history = await window.workEncourager.getHistory()
      settledToday = history.rows.some((row) => row.isToday && !row.live)
    }

    if (inShift || settledToday) {
      scopeMode.value = inShift ? 'shift' : 'settled'
      scopeInfo.value = {
        workedHours: state.workedHoursText,
        earnedText: state.earnTodayText
      }
      scopeDialog.value = true
      return
    }
    await commitSave(false)
  } catch (error) {
    emit('toast', `读取当前状态失败：${(error as Error).message}`)
  }
}

async function commitSave(applyToCurrentShift: boolean): Promise<void> {
  scopeDialog.value = false
  saving.value = true
  try {
    const result = await window.workEncourager.saveSettings({
      settings: clone(draft.value),
      applyToCurrentShift
    })
    if (!result.ok) {
      errors.value = firstIssueMap(result.issues)
      emit('toast', result.issues[0]?.message ?? '设置未保存，请检查输入')
      return
    }
    emit('saved', result)
  } catch (error) {
    emit('toast', `保存失败：${(error as Error).message}`)
  } finally {
    saving.value = false
  }
}

async function openDataFolder(): Promise<void> {
  try {
    await window.workEncourager.openDataFolder()
  } catch (error) {
    emit('toast', `无法打开目录：${(error as Error).message}`)
  }
}

watch(
  draft,
  () => {
    if (Object.keys(errors.value).length === 0) return
    errors.value = firstIssueMap(validateSettings(draft.value))
  },
  { deep: true }
)
</script>

<template>
  <div class="screen settings-screen">
    <header class="screen-head" data-tauri-drag-region>
      <button class="icon-btn" type="button" title="返回" @click="emit('close')">
        <AppIcon name="back" :size="18" />
      </button>
      <span class="screen-title">设置</span>
      <span class="screen-sub">修改后点击保存生效</span>
    </header>

    <div v-if="pendingFrom" class="notice notice--soft">
      已有一版设置计划于 <b>{{ pendingFrom }}</b> 生效；本次保存会覆盖该日期及之后的设置。
    </div>

    <section class="card settings-card fade-in">
      <div class="section-head">
        <span class="section-title">工资设置</span>
        <span class="mini-note">金额仅保存在本机</span>
      </div>
      <div class="form-stack">
        <div class="segmented" role="tablist">
          <button
            type="button"
            class="segmented-btn"
            :class="{ 'segmented-btn--active': isDaily }"
            @click="draft.wageMode = 'daily'"
          >
            按日薪
          </button>
          <button
            type="button"
            class="segmented-btn"
            :class="{ 'segmented-btn--active': isMonthly }"
            @click="draft.wageMode = 'monthly'"
          >
            按月薪
          </button>
          <button
            type="button"
            class="segmented-btn"
            :class="{ 'segmented-btn--active': isHourly }"
            @click="draft.wageMode = 'hourly'"
          >
            按时薪
          </button>
        </div>

        <div v-if="isDaily" class="field">
          <label class="field-label" for="dailyWage">每日工资（元）</label>
          <input
            id="dailyWage"
            v-model.number="draft.dailyWage"
            class="input"
            :class="{ 'input--error': err('dailyWage') }"
            type="number"
            min="0.01"
            step="0.01"
          />
          <span v-if="err('dailyWage')" class="field-error">{{ err('dailyWage') }}</span>
        </div>

        <div v-if="isMonthly" class="field">
          <label class="field-label" for="monthlyWage">月工资（元）</label>
          <input
            id="monthlyWage"
            v-model.number="draft.monthlyWage"
            class="input"
            :class="{ 'input--error': err('monthlyWage') }"
            type="number"
            min="0.01"
            step="1"
          />
          <span v-if="err('monthlyWage')" class="field-error">{{ err('monthlyWage') }}</span>
        </div>

        <div v-if="isHourly" class="field">
          <label class="field-label" for="hourlyWage">每小时工资（元）</label>
          <input
            id="hourlyWage"
            v-model.number="draft.hourlyWage"
            class="input"
            :class="{ 'input--error': err('hourlyWage') }"
            type="number"
            min="0.01"
            step="1"
          />
          <span v-if="err('hourlyWage')" class="field-error">{{ err('hourlyWage') }}</span>
        </div>

        <template v-if="isMonthly">
          <div class="field">
            <span class="field-label">月薪折算方式</span>
            <div class="segmented segmented--small">
              <button
                type="button"
                class="segmented-btn"
                :class="{ 'segmented-btn--active': draft.monthlyBasis === 'actual' }"
                @click="draft.monthlyBasis = 'actual'"
              >
                按实际工作日
              </button>
              <button
                type="button"
                class="segmented-btn"
                :class="{ 'segmented-btn--active': draft.monthlyBasis === 'fixed' }"
                @click="draft.monthlyBasis = 'fixed'"
              >
                固定计薪天数
              </button>
            </div>
            <div v-if="draft.monthlyBasis === 'fixed'" class="inline-field">
              <input
                v-model.number="draft.fixedDays"
                class="input"
                :class="{ 'input--error': err('fixedDays') }"
                type="number"
                min="1"
                max="31"
                step="0.25"
              />
              <span class="unit">天</span>
            </div>
            <span v-if="err('fixedDays')" class="field-error">{{ err('fixedDays') }}</span>
            <span class="field-hint">
              按实际工作日时，会用当月排班（含特殊日期）自动计算计薪天数。
            </span>
          </div>
        </template>

        <div class="wage-preview">
          <div class="preview-title">当前折算结果</div>
          <div class="preview-grid">
            <div>
              <span>每日工资</span>
              <b class="num">¥{{ preview?.daily ?? '—' }}</b>
            </div>
            <div>
              <span>每小时工资</span>
              <b class="num">¥{{ preview?.hourly ?? '—' }}</b>
            </div>
            <div>
              <span>每秒工资</span>
              <b class="num">¥{{ preview?.perSecond ?? '—' }}</b>
            </div>
          </div>
          <p v-if="preview" class="preview-hint">
            按今日班次有效计薪 {{ preview.plannedHours }} 小时估算<span v-if="preview.days"
              >，本月计薪 {{ preview.days }} 天</span
            >。展示时才四舍五入，计算过程保留完整精度。
          </p>
          <p v-else class="preview-hint">当前时间设置无效，无法折算。</p>
        </div>
      </div>
    </section>

    <section class="card settings-card fade-in">
      <div class="section-head">
        <span class="section-title">工作时间</span>
        <span class="mini-note">跨午夜班次归属于上班当天</span>
      </div>
      <div class="form-stack">
        <div class="grid-2">
          <div class="field">
            <label class="field-label" for="workStart">上班时间</label>
            <input
              id="workStart"
              v-model="draft.workStart"
              class="input input--time"
              :class="{ 'input--error': err('workStart') }"
              type="time"
              step="60"
            />
            <span v-if="err('workStart')" class="field-error">{{ err('workStart') }}</span>
          </div>
          <div class="field">
            <label class="field-label" for="workEnd">下班时间</label>
            <input
              id="workEnd"
              v-model="draft.workEnd"
              class="input input--time"
              :class="{ 'input--error': err('workEnd') }"
              type="time"
              step="60"
            />
            <span v-if="err('workEnd')" class="field-error">{{ err('workEnd') }}</span>
          </div>
        </div>

        <div class="field">
          <span class="field-label">每周工作日</span>
          <div class="weekday-row">
            <button
              v-for="(label, index) in WEEKDAY_SHORT"
              :key="label"
              type="button"
              class="chip"
              :class="{ 'chip--active': draft.weekdays.includes(index + 1) }"
              @click="toggleWeekday(index + 1)"
            >
              {{ label }}
            </button>
          </div>
          <span v-if="err('weekdays')" class="field-error">{{ err('weekdays') }}</span>
        </div>

        <div class="field">
          <div class="field-label">
            <span>休息时间</span>
            <button
              type="button"
              class="switch"
              :class="{ 'switch--on': draft.breaksEnabled }"
              :aria-checked="draft.breaksEnabled"
              @click="draft.breaksEnabled = !draft.breaksEnabled"
            ></button>
          </div>
          <template v-if="draft.breaksEnabled">
            <div v-for="(item, index) in draft.breaks" :key="item.id" class="break-card">
              <div class="break-times">
                <input v-model="item.start" class="input input--time" type="time" step="60" />
                <span class="break-sep">至</span>
                <input v-model="item.end" class="input input--time" type="time" step="60" />
                <button
                  type="button"
                  class="icon-btn icon-btn--danger break-del"
                  title="删除这段休息"
                  @click="removeBreak(index)"
                >
                  <AppIcon name="trash" :size="14" />
                </button>
              </div>
              <div class="break-meta">
                <label class="check-label">
                  <input v-model="item.paid" type="checkbox" />
                  休息也计薪
                </label>
                <span v-if="err(`breaks.${index}.start`)" class="field-error">
                  {{ err(`breaks.${index}.start`) }}
                </span>
                <span v-else-if="err(`breaks.${index}.end`)" class="field-error">
                  {{ err(`breaks.${index}.end`) }}
                </span>
              </div>
            </div>
            <button type="button" class="add-link" @click="addBreak">
              <AppIcon name="plus" :size="14" />
              添加一段休息
            </button>
            <span v-if="err('breaks')" class="field-error">{{ err('breaks') }}</span>
            <span class="field-hint">
              默认午休 12:00—13:00 不计薪；休息时段必须落在班次内且不能重叠。
            </span>
          </template>
        </div>

        <div class="field">
          <span class="field-label">特殊日期（覆盖每周排班）</span>
          <div v-for="(item, index) in draft.specialDays" :key="item.id" class="special-item">
            <div class="special-row">
              <input v-model="item.date" class="input" type="date" />
              <select v-model="item.type" class="select special-type">
                <option value="off">休息</option>
                <option value="work">上班</option>
              </select>
              <button
                type="button"
                class="icon-btn icon-btn--danger"
                title="删除"
                @click="removeSpecialDay(index)"
              >
                <AppIcon name="trash" :size="14" />
              </button>
            </div>
            <span v-if="err(`specialDays.${index}.date`)" class="field-error">
              {{ err(`specialDays.${index}.date`) }}
            </span>
          </div>
          <button type="button" class="add-link" @click="addSpecialDay">
            <AppIcon name="plus" :size="14" />
            添加特殊日期
          </button>
        </div>
      </div>
    </section>

    <section class="card settings-card fade-in">
      <div class="section-head">
        <span class="section-title">加班</span>
        <span class="mini-note">{{ draft.overtimeEnabled ? '下班后自动计薪' : '未启用' }}</span>
      </div>
      <div class="form-stack">
        <div class="switch-row">
          <div class="switch-row-text">
            <span class="switch-row-title">启用加班计薪</span>
            <span class="switch-row-desc">下班后按加班时薪 × 倍数继续累计，达到每日上限自动停止</span>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ 'switch--on': draft.overtimeEnabled }"
            :aria-checked="draft.overtimeEnabled"
            @click="draft.overtimeEnabled = !draft.overtimeEnabled"
          ></button>
        </div>

        <template v-if="draft.overtimeEnabled">
          <div class="field">
            <span class="field-label">加班时薪</span>
            <div class="segmented segmented--small">
              <button
                type="button"
                class="segmented-btn"
                :class="{ 'segmented-btn--active': draft.overtimeRateMode === 'auto' }"
                @click="draft.overtimeRateMode = 'auto'"
              >
                自动按正常时薪
              </button>
              <button
                type="button"
                class="segmented-btn"
                :class="{ 'segmented-btn--active': draft.overtimeRateMode === 'custom' }"
                @click="draft.overtimeRateMode = 'custom'"
              >
                自定义时薪
              </button>
            </div>
          </div>

          <div v-if="draft.overtimeRateMode === 'custom'" class="field">
            <label class="field-label" for="overtimeHourlyRate">自定义加班时薪（元/小时）</label>
            <input
              id="overtimeHourlyRate"
              v-model.number="draft.overtimeHourlyRate"
              class="input"
              :class="{ 'input--error': err('overtimeHourlyRate') }"
              type="number"
              min="0.01"
              step="0.5"
            />
            <span v-if="err('overtimeHourlyRate')" class="field-error">
              {{ err('overtimeHourlyRate') }}
            </span>
          </div>

          <div class="grid-2">
            <div class="field">
              <label class="field-label" for="overtimeMultiplier">加班倍数</label>
              <input
                id="overtimeMultiplier"
                v-model.number="draft.overtimeMultiplier"
                class="input"
                :class="{ 'input--error': err('overtimeMultiplier') }"
                type="number"
                min="0.1"
                max="10"
                step="0.1"
              />
              <span v-if="err('overtimeMultiplier')" class="field-error">
                {{ err('overtimeMultiplier') }}
              </span>
            </div>
            <div class="field">
              <label class="field-label" for="overtimeMaxHours">每日上限（小时）</label>
              <input
                id="overtimeMaxHours"
                v-model.number="draft.overtimeMaxHours"
                class="input"
                :class="{ 'input--error': err('overtimeMaxHours') }"
                type="number"
                min="0.5"
                max="12"
                step="0.5"
              />
              <span v-if="err('overtimeMaxHours')" class="field-error">
                {{ err('overtimeMaxHours') }}
              </span>
            </div>
          </div>

          <div class="wage-preview">
            <div class="preview-title">加班折算预览</div>
            <div class="preview-grid">
              <div>
                <span>加班基数</span>
                <b class="num">¥{{ overtimePreview.base }}/时</b>
              </div>
              <div>
                <span>折算后时薪</span>
                <b class="num">¥{{ overtimePreview.hourly }}/时</b>
              </div>
              <div>
                <span>每秒收入</span>
                <b class="num">¥{{ overtimePreview.perSecond }}</b>
              </div>
            </div>
            <p class="preview-hint">
              加班从下班时间开始自动累计，只统计计时器开启期间；不需要加班时请在下班时关闭计时器，达到每日上限后也会自动停止。
            </p>
          </div>
        </template>
      </div>
    </section>

    <section class="card settings-card fade-in">
      <div class="section-head">
        <span class="section-title">鼓励目标</span>
        <span class="mini-note">按当前收入生成文案</span>
      </div>
      <div class="form-stack">
        <div v-for="(target, index) in draft.targets" :key="target.id" class="target-row">
          <input
            v-model="target.name"
            class="input target-name"
            :class="{ 'input--error': err(`targets.${index}.name`) }"
            type="text"
            maxlength="20"
            placeholder="目标名称"
          />
          <input
            v-model.number="target.price"
            class="input target-price"
            :class="{ 'input--error': err(`targets.${index}.price`) }"
            type="number"
            min="0.01"
            step="0.5"
          />
          <div class="target-actions">
            <button
              type="button"
              class="icon-btn"
              title="上移"
              :disabled="index === 0"
              @click="moveTarget(index, -1)"
            >
              <AppIcon name="up" :size="13" />
            </button>
            <button
              type="button"
              class="icon-btn"
              title="下移"
              :disabled="index === draft.targets.length - 1"
              @click="moveTarget(index, 1)"
            >
              <AppIcon name="down" :size="13" />
            </button>
            <button
              type="button"
              class="icon-btn icon-btn--danger"
              title="删除"
              @click="removeTarget(index)"
            >
              <AppIcon name="trash" :size="13" />
            </button>
          </div>
          <span v-if="err(`targets.${index}.name`)" class="field-error target-error">
            {{ err(`targets.${index}.name`) }}
          </span>
          <span v-else-if="err(`targets.${index}.price`)" class="field-error target-error">
            {{ err(`targets.${index}.price`) }}
          </span>
        </div>
        <button type="button" class="add-link" @click="addTarget">
          <AppIcon name="plus" :size="14" />
          添加目标
        </button>
        <span class="field-hint">第一个目标用于计算“再过多久就能赚回来”的文案。</span>
      </div>
    </section>

    <section class="card settings-card fade-in">
      <div class="section-head">
        <span class="section-title">外观与行为</span>
      </div>
      <div class="form-stack">
        <div class="field">
          <span class="field-label">主题</span>
          <div class="segmented segmented--small">
            <button
              type="button"
              class="segmented-btn"
              :class="{ 'segmented-btn--active': draft.theme === 'system' }"
              @click="draft.theme = 'system'"
            >
              跟随系统
            </button>
            <button
              type="button"
              class="segmented-btn"
              :class="{ 'segmented-btn--active': draft.theme === 'light' }"
              @click="draft.theme = 'light'"
            >
              浅色
            </button>
            <button
              type="button"
              class="segmented-btn"
              :class="{ 'segmented-btn--active': draft.theme === 'dark' }"
              @click="draft.theme = 'dark'"
            >
              深色
            </button>
          </div>
        </div>

        <div class="switch-row">
          <div class="switch-row-text">
            <span class="switch-row-title">窗口置顶</span>
            <span class="switch-row-desc">让鼓励器一直留在其他窗口上方</span>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ 'switch--on': draft.alwaysOnTop }"
            @click="draft.alwaysOnTop = !draft.alwaysOnTop"
          ></button>
        </div>

        <div class="switch-row">
          <div class="switch-row-text">
            <span class="switch-row-title">最小化到系统托盘</span>
            <span class="switch-row-desc">点击最小化时隐藏窗口，继续后台计时</span>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ 'switch--on': draft.minimizeToTray }"
            @click="draft.minimizeToTray = !draft.minimizeToTray"
          ></button>
        </div>

        <div class="switch-row">
          <div class="switch-row-text">
            <span class="switch-row-title">关闭窗口时</span>
            <span class="switch-row-desc">隐藏后仍会在后台结算今天的收入</span>
          </div>
          <select v-model="draft.closeAction" class="select close-select">
            <option value="tray">隐藏到托盘</option>
            <option value="quit">退出程序</option>
          </select>
        </div>

        <div class="switch-row">
          <div class="switch-row-text">
            <span class="switch-row-title">下班提醒</span>
            <span class="switch-row-desc">每个班次最多提醒一次</span>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ 'switch--on': draft.reminderEnabled }"
            @click="draft.reminderEnabled = !draft.reminderEnabled"
          ></button>
        </div>

        <div v-if="draft.reminderEnabled" class="inline-field">
          <span class="inline-label">提前</span>
          <input
            v-model.number="draft.reminderMinutes"
            class="input input--short"
            :class="{ 'input--error': err('reminderMinutes') }"
            type="number"
            min="0"
            max="720"
            step="1"
          />
          <span class="unit">分钟提醒</span>
        </div>
        <span v-if="err('reminderMinutes')" class="field-error">{{ err('reminderMinutes') }}</span>

        <div class="switch-row">
          <div class="switch-row-text">
            <span class="switch-row-title">隐私模式</span>
            <span class="switch-row-desc">隐藏金额，保留进度和倒计时</span>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ 'switch--on': draft.privacyMode }"
            @click="draft.privacyMode = !draft.privacyMode"
          ></button>
        </div>

        <div class="field">
          <span class="field-label">金额小数位数</span>
          <select v-model.number="draft.decimals" class="select">
            <option :value="2">2 位</option>
            <option :value="3">3 位</option>
            <option :value="4">4 位（默认）</option>
            <option :value="5">5 位</option>
            <option :value="6">6 位</option>
          </select>
        </div>

        <div class="data-row">
          <div class="data-copy">
            <span class="switch-row-title">本地数据</span>
            <span class="data-path" :title="dataPath">{{ dataPath }}</span>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" @click="openDataFolder">
            <AppIcon name="folder" :size="13" />
            打开目录
          </button>
        </div>
      </div>
    </section>

    <div class="settings-foot">
      <div class="foot-actions">
        <button type="button" class="btn btn-ghost" @click="confirmDefaults = true">恢复默认</button>
        <button type="button" class="btn btn-ghost" @click="emit('close')">取消</button>
        <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>

    <SaveScopeDialog
      :open="scopeDialog"
      :mode="scopeMode"
      :worked-hours="scopeInfo.workedHours"
      :earned-text="scopeInfo.earnedText"
      @next="commitSave(false)"
      @current="commitSave(true)"
      @cancel="scopeDialog = false"
    />

    <ConfirmDialog
      :open="confirmDefaults"
      title="恢复默认设置？"
      message="会把表单填回默认值（日薪 120 元、周一至周五 09:00—17:00、午休不计薪）。仍需点击“保存”才会真正生效。"
      confirm-text="恢复默认"
      @confirm="restoreDefaults"
      @cancel="confirmDefaults = false"
    />
  </div>
</template>

<style scoped>
.settings-screen {
  padding-bottom: 8px;
}

.notice {
  border-radius: 14px;
  padding: 9px 12px;
  font-size: 11.5px;
  line-height: 1.6;
  margin-bottom: 9px;
}

.notice--soft {
  background: rgba(52, 179, 136, 0.1);
  color: var(--green);
  border: 1px solid rgba(52, 179, 136, 0.18);
}

.settings-card {
  margin-bottom: 10px;
}

.section-title {
  font-size: 12.5px;
}

.mini-note {
  font-size: 10px;
  color: var(--muted);
}

.segmented {
  display: flex;
  background: var(--track);
  border-radius: 12px;
  padding: 3px;
  gap: 2px;
}

.segmented-btn {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  height: 30px;
  border-radius: 9px;
  transition: all 0.16s ease;
}

.segmented-btn--active {
  background: var(--card-solid);
  color: var(--green);
  font-weight: 700;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.segmented--small .segmented-btn {
  font-size: 11.5px;
}

.inline-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.input--short {
  width: 74px;
}

.unit {
  font-size: 11.5px;
  color: var(--muted);
}

.inline-label {
  font-size: 11.5px;
  color: var(--muted);
}

.wage-preview {
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(52, 179, 136, 0.1), rgba(255, 255, 255, 0.5));
  border: 1px solid rgba(52, 179, 136, 0.14);
  padding: 10px 12px;
}

[data-theme='dark'] .wage-preview {
  background: linear-gradient(135deg, rgba(52, 179, 136, 0.16), rgba(255, 255, 255, 0.02));
}

.preview-title {
  font-size: 10.5px;
  color: var(--muted);
  margin-bottom: 6px;
}

.preview-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.preview-grid div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.preview-grid span {
  font-size: 10px;
  color: var(--muted);
}

.preview-grid b {
  font-size: 13px;
  color: var(--green);
  font-weight: 700;
  overflow-wrap: anywhere;
}

.preview-hint {
  margin: 7px 0 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--muted);
}

.weekday-row {
  display: flex;
  gap: 5px;
}

.weekday-row .chip {
  flex: 1;
  min-width: 0;
  padding: 0;
}

.break-card {
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.35);
}

[data-theme='dark'] .break-card {
  background: rgba(255, 255, 255, 0.03);
}

.break-times {
  display: flex;
  align-items: center;
  gap: 6px;
}

.break-times .input {
  height: 34px;
  font-size: 12px;
}

.break-sep {
  font-size: 11px;
  color: var(--muted);
  flex: none;
}

.break-del {
  width: 26px;
  height: 26px;
  flex: none;
}

.break-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  gap: 6px;
}

.check-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--muted);
}

.check-label input {
  accent-color: var(--mint);
}

.add-link {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--mint-deep);
  font-size: 11.5px;
  padding: 2px 0;
}

.add-link:hover {
  text-decoration: underline;
}

.special-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.special-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.special-row .input {
  height: 34px;
  font-size: 12px;
}

.special-type {
  width: 86px;
  height: 34px;
  font-size: 12px;
  flex: none;
}

.target-row {
  display: grid;
  grid-template-columns: 1fr 74px auto;
  gap: 6px;
  align-items: center;
}

.target-row .input {
  height: 38px;
}

.target-price {
  text-align: right;
}

.target-actions {
  display: flex;
  gap: 1px;
}

.target-actions .icon-btn {
  width: 24px;
  height: 26px;
}

.target-actions .icon-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.target-error {
  grid-column: 1 / -1;
}

.close-select {
  width: 112px;
  height: 34px;
  font-size: 12px;
  flex: none;
}

.data-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.data-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.data-path {
  font-size: 10px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 210px;
}
</style>
