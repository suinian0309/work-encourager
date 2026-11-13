import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, webContents } from 'electron'

type Check = { name: string; pass: boolean; detail?: string }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface SmokeOptions {
  phase: number
  dir: string
  quit: () => void
}

/**
 * 开发期冒烟脚本（仅未打包版本可用）：
 * 通过真实窗口点击按钮、读取 DOM 与 IPC 数据，验证主界面、设置保存、暂停与重启持久化。
 * 用法：设置 WORK_ENC_SMOKE_PHASE=1/2 与 WORK_ENC_SMOKE_DIR，运行 electron .
 */
export async function runDevSmoke(window: BrowserWindow, options: SmokeOptions): Promise<void> {
  const checks: Check[] = []
  const record = (name: string, pass: boolean, detail = ''): void => {
    checks.push({ name, pass, detail })
    console.log(`SMOKE_${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
  }
  const evaluate = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true) as Promise<T>
  const clickByText = async (text: string): Promise<boolean> =>
    evaluate<boolean>(`(() => {
      const target = [...document.querySelectorAll('button')].find((btn) => btn.textContent.trim() === ${JSON.stringify(text)})
      if (!target) return false
      target.click()
      return true
    })()`)

  try {
    await sleep(1200)

    if (options.phase === 1) {
      const boot = await evaluate<{ settings: { dailyWage: number; weekdays: number[]; breaks: Array<{ start: string; paid: boolean }> } }>(
        'window.workEncourager.bootstrap()'
      )
      record('启动读取默认日薪 120', boot.settings.dailyWage === 120)
      record('默认周一至周五上班', JSON.stringify(boot.settings.weekdays) === '[1,2,3,4,5]')
      record('默认午休不计薪', boot.settings.breaks[0]?.start === '12:00' && !boot.settings.breaks[0]?.paid)

      const metrics = await evaluate<{ scroll: number; client: number }>(`(() => {
        const screen = document.querySelector('.screen')
        return { scroll: screen.scrollHeight, client: screen.clientHeight }
      })()`)
      record('主界面在 720 高度内可完整展示', metrics.scroll <= metrics.client + 40, JSON.stringify(metrics))

      writeFileSync(join(options.dir, 'main.png'), (await window.webContents.capturePage()).toPNG())

      const before = await evaluate<{ earnTodayValue: number; earnTodayText: string; status: string }>(
        'window.workEncourager.getState()'
      )
      record('初始状态为计薪中', ['working', 'on-break'].includes(before.status), before.status)

      record('关闭计时器按钮可点击', await clickByText('关闭计时器'))
      await sleep(900)
      const paused = await evaluate<{ status: string; rateText: string; earnTodayValue: number }>(
        'window.workEncourager.getState()'
      )
      record('关闭后状态为计时已关闭', paused.status === 'paused', paused.status)
      record('关闭后速度为 0', paused.rateText === '0.000000', paused.rateText)
      record(
        '关闭后收入保留',
        Math.abs(paused.earnTodayValue - before.earnTodayValue) < 0.05,
        `${before.earnTodayValue} → ${paused.earnTodayValue}`
      )

      record('开启计时器按钮可点击', await clickByText('开启计时器'))
      await sleep(800)
      const resumed = await evaluate<{ rateText: string; status: string }>('window.workEncourager.getState()')
      record('重新开启后恢复计薪状态', resumed.status !== 'paused', `${resumed.status} / ${resumed.rateText}`)

      record('重置计时按钮可点击', await clickByText('重置计时'))
      await sleep(300)
      const hasModal = await evaluate<boolean>('!!document.querySelector(".modal")')
      record('重置前弹出确认框', hasModal)
      await evaluate<boolean>(`(() => {
        const btn = document.querySelector('.modal button.btn-danger')
        if (!btn) return false
        btn.click()
        return true
      })()`)
      await sleep(700)
      const reset = await evaluate<{ earnTodayValue: number; progressPercent: number; timerOn: boolean }>(
        'window.workEncourager.getState()'
      )
      record('重置后收入归零', reset.earnTodayValue < 0.1, String(reset.earnTodayValue))
      record('重置后进度同步', reset.progressPercent < 1, String(reset.progressPercent))
      record('重置保留开启状态', reset.timerOn === true)

      await evaluate<boolean>('(() => { const b = document.querySelector(\'button[title="设置"]\'); if (!b) return false; b.click(); return true })()')
      await sleep(500)
      record('设置页可打开', await evaluate<boolean>('!!document.querySelector(".settings-screen")'))
      record(
        '设置页包含工资/时间/加班/目标/外观五组',
        (await evaluate<number>('document.querySelectorAll(".section-title").length')) === 5
      )

      const setInput = async (selector: string, value: string): Promise<void> => {
        await evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)})
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          setter.call(el, ${JSON.stringify(value)})
          el.dispatchEvent(new Event('input', { bubbles: true }))
        })()`)
      }

      await setInput('#workEnd', '09:00')
      await clickByText('保存')
      await sleep(400)
      record('时间相同的无效设置被拦截', await evaluate<boolean>('!!document.querySelector(".field-error")'))
      record('无效输入不关闭设置页', await evaluate<boolean>('!!document.querySelector(".settings-screen")'))

      await setInput('#workEnd', '17:00')
      await setInput('#dailyWage', '240')
      await clickByText('保存')
      await sleep(500)
      record('班次中保存会询问生效范围', await evaluate<boolean>('!!document.querySelector(".scope-modal")'))
      record('底栏不再有应用到当前班次复选框', await evaluate<boolean>('!document.querySelector(".apply-row")'))
      writeFileSync(join(options.dir, 'save-scope.png'), (await window.webContents.capturePage()).toPNG())
      const applyCurrentClicked = await evaluate<boolean>(`(() => {
        const btn = [...document.querySelectorAll('.scope-option')].find((b) => b.textContent.includes('立即应用到当前班次'))
        if (!btn) return false
        btn.click()
        return true
      })()`)
      record('可选择立即应用到当前班次', applyCurrentClicked)
      await sleep(900)
      const afterSave = await evaluate<{ rateText: string; perSecondText: string; earnTodayValue: number }>(
        'window.workEncourager.getState()'
      )
      record('保存后回到主界面', await evaluate<boolean>('!!document.querySelector(".main-screen")'))
      record(
        '日薪 240 折算每秒 0.009524',
        afterSave.perSecondText === '0.009524',
        `${afterSave.perSecondText} / rate ${afterSave.rateText}`
      )
      record('应用到当前班次后重新累计', afterSave.earnTodayValue < 0.2, String(afterSave.earnTodayValue))

      const persisted = await evaluate<{ settings: { dailyWage: number } }>('window.workEncourager.bootstrap()')
      record('新设置写入本地', persisted.settings.dailyWage === 240)

      await evaluate<boolean>('(() => { const b = document.querySelector(\'button[title="设置"]\'); if (!b) return false; b.click(); return true })()')
      await sleep(400)
      await evaluate<boolean>(`(() => {
        const screen = document.querySelector('.settings-screen')
        screen.scrollTop = screen.scrollHeight
        return true
      })()`)
      await sleep(400)
      writeFileSync(join(options.dir, 'settings-bottom.png'), (await window.webContents.capturePage()).toPNG())
      const footerMetrics = await evaluate<string>(`(() => {
        const foot = document.querySelector('.settings-foot')
        const rows = [...document.querySelectorAll('.switch-row')]
        const last = rows[rows.length - 1]
        const f = foot.getBoundingClientRect()
        const l = last.getBoundingClientRect()
        return JSON.stringify({ footerTop: Math.round(f.top), footerHeight: Math.round(f.height), lastRowBottom: Math.round(l.bottom), overlap: Math.round(l.bottom - f.top) })
      })()`)
      console.log('FOOTER_METRICS', footerMetrics)
      window.setContentSize(380, 2000)
      await sleep(600)
      writeFileSync(join(options.dir, 'settings.png'), (await window.webContents.capturePage()).toPNG())
      const settingsMetrics = await evaluate<{ scroll: number; client: number }>(`(() => {
        const screen = document.querySelector('.settings-screen')
        return { scroll: screen.scrollHeight, client: screen.clientHeight }
      })()`)
      record('设置页可见区域覆盖全部表单', settingsMetrics.scroll <= settingsMetrics.client + 40, JSON.stringify(settingsMetrics))
      await clickByText('取消')
      await sleep(300)
      window.setContentSize(380, 720)
      await evaluate<boolean>(`(() => {
        const link = document.querySelector('.month-link')
        if (!link) return false
        link.click()
        return true
      })()`)
      await sleep(500)
      writeFileSync(join(options.dir, 'history.png'), (await window.webContents.capturePage()).toPNG())

      await evaluate<boolean>('(() => { const b = document.querySelector(\'button[title="返回"]\'); if (!b) return false; b.click(); return true })()')
      await sleep(300)

      record('浮窗 API 可调用', await evaluate<boolean>('window.workEncourager.showFloat()'))
      await sleep(900)
      const floatContents = webContents.getAllWebContents().find((item) => item.getURL().includes('float.html'))
      record('浮窗已创建', !!floatContents)
      if (floatContents) {
        const floatWin = BrowserWindow.fromWebContents(floatContents)
        const bounds = floatWin?.getBounds()
        record('浮窗为置顶窗口', floatWin?.isAlwaysOnTop() === true)
        record('浮窗尺寸为 260×152', bounds?.width === 260 && bounds?.height === 152, JSON.stringify(bounds))
        record('打开浮窗后主窗口隐藏', await evaluate<boolean>('document.hidden'))
        writeFileSync(join(options.dir, 'float.png'), (await floatContents.capturePage()).toPNG())
      }
      await evaluate<boolean>('window.workEncourager.expandFloat()')
      await sleep(700)
      record('从浮窗返回主窗口', await evaluate<boolean>('!document.hidden'))

      const beforePause = await evaluate<{ earnTodayValue: number }>('window.workEncourager.getState()')
      await clickByText('关闭计时器')
      await sleep(500)
      writeFileSync(
        join(options.dir, 'phase1.json'),
        JSON.stringify(
          { checks, earnAtPause: beforePause.earnTodayValue, finishedAt: new Date().toISOString() },
          null,
          2
        )
      )
    } else {
      const boot = await evaluate<{
        settings: { dailyWage: number }
        state: { timerOn: boolean; status: string; earnTodayValue: number }
      }>('window.workEncourager.bootstrap()')
      record('重启后保留日薪 240', boot.settings.dailyWage === 240, String(boot.settings.dailyWage))
      record('重启后计时器仍关闭', boot.state.timerOn === false)
      record('重启后状态仍为计时已关闭', boot.state.status === 'paused', boot.state.status)

      const phase1 = JSON.parse(
        (await import('node:fs')).readFileSync(join(options.dir, 'phase1.json'), 'utf8')
      ) as { earnAtPause: number }
      record(
        '重启后收入未补算（与关闭时一致）',
        Math.abs(boot.state.earnTodayValue - phase1.earnAtPause) < 0.2,
        `${phase1.earnAtPause} → ${boot.state.earnTodayValue}`
      )

      record('重启后可开启计时', await clickByText('开启计时器'))
      await sleep(800)
      const resumed = await evaluate<{ rateText: string; perSecondText: string; status: string }>(
        'window.workEncourager.getState()'
      )
      record(
        '重启后继续累计',
        resumed.perSecondText !== '0.000000' && resumed.status !== 'paused',
        `${resumed.status} / ${resumed.perSecondText}`
      )
      writeFileSync(join(options.dir, 'phase2.json'), JSON.stringify({ checks }, null, 2))
    }
  } catch (error) {
    record('冒烟脚本运行完成', false, String(error))
    console.error('SMOKE_ERROR', error)
  }

  const failed = checks.filter((item) => !item.pass)
  console.log(`SMOKE_SUMMARY phase=${options.phase} pass=${checks.length - failed.length} fail=${failed.length}`)
  await sleep(300)
  options.quit()
}
