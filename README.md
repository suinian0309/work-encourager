# 上班鼓励器

> 把上班的每一秒，都换成看得见的收获。

一个安静的 Windows 桌面小工具：实时显示**今天已经赚了多少钱**、**距离下班还有多久**、**今日工时进度**和**本月累计**，并用鼓励文案把枯燥的工时变成看得见的收获。

完全离线，无需登录，不上传任何工资与工作数据。

![platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D6?style=flat-square)
![electron](https://img.shields.io/badge/Electron-37-47848F?style=flat-square&logo=electron&logoColor=white)
![tauri](https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white)
![vue](https://img.shields.io/badge/Vue-3-42B883?style=flat-square&logo=vue.js&logoColor=white)
![typescript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)
![rust](https://img.shields.io/badge/Rust-1.99-000000?style=flat-square&logo=rust&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-2E8B57?style=flat-square)

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/electron-main.png" width="330" alt="Electron 版主界面" /><br />
      <sub><b>Electron 版</b> · 功能完整，界面最接近设计稿</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/tauri-main.png" width="330" alt="Tauri 版主界面" /><br />
      <sub><b>Tauri 版</b> · 安装包约 2 MB，同一套界面</sub>
    </td>
  </tr>
</table>

## 它能做什么

- **今日已赚实时滚动**：金额由时间戳、班次、休息区间、暂停记录推导，不是按刷新次数累加
- **下班倒计时**：真实墙上时间，跨午夜班次显示「次日」
- **工时进度**：只统计有效计薪时长，休息与手动暂停都不计入
- **加班计薪**：下班后自动累计，可自定义加班时薪与倍数，支持每日上限
- **桌面浮窗**：260×152 的透明小卡片，只留状态、金额、倒计时和进度；主窗口隐藏、不占任务栏
- **鼓励文案**：根据当前收入和消费目标生成，「再过 12 分钟，一杯奶茶就赚回来了」
- **本月累计与历史**：按工作日归档，历史记录冻结当日工资参数，改设置不影响过去
- **托盘常驻**：显示主窗口、开关计时器、打开浮窗、退出

## 三个版本

同一套业务规则，三种桌面外壳：

| | Electron 版 | Tauri 版 | 原生 Rust（Slint）版 |
| --- | --- | --- | --- |
| 技术栈 | Electron + Vue 3 | Tauri 2 + Rust + WebView2 | Rust + Slint 软件渲染 |
| 安装包 | 约 102 MB | 约 2 MB | 约 9 MB（单文件 exe） |
| 运行内存（私有） | 约 127 MB | 约 274 MB | **约 4.7 MB** |
| 依赖 | 自带 Chromium | 系统 WebView2 | 无 |
| 界面观感 | ★★★★☆ | ★★★★☆ | **★★☆☆☆** |
| 适合 | 追求稳定、功能完整、低内存 | 追求安装包小、快速分发 | 只追求极致低内存 |

> **关于原生 Rust（Slint）版**：它的界面是用 Slint 软件渲染器自绘的，没有 CSS、没有磨砂模糊，视觉明显不如前两个版本，功能也相对精简（无单实例、设置项较少）。**建议优先选择 Electron 或 Tauri 版**；除非你明确需要「内存占用极低」且不在意界面，否则不必选它。

## 下载

前往 [Releases](https://github.com/suinian0309/work-encourager/releases) 下载最新版本：

| 文件 | 说明 |
| --- | --- |
| `WorkEncourager-Electron-Setup-<version>.msi` | Electron 版安装包（约 102 MB） |
| `WorkEncourager-Electron-<version>.zip` | Electron 版免安装压缩包 |
| `WorkEncourager-Tauri-Setup-<version>.msi` | Tauri 版安装包（约 2 MB） |
| `WorkEncourager-Slint-<version>.exe` | 原生 Rust 版单文件程序（约 9 MB，界面较朴素） |

系统要求：Windows 10 / 11（x64）。Tauri 版需要 WebView2 Runtime，Windows 11 与较新的 Windows 10 已预装。

## 从源码运行

需要 Node.js 22+ 与 pnpm 11：

```bash
pnpm install

pnpm dev:electron   # Electron 开发模式
pnpm dev:tauri      # Tauri 开发模式（需要 Rust 工具链）
```

单元测试与类型检查：

```bash
pnpm test
pnpm typecheck
```

## 构建安装包

Electron：

```bash
pnpm --filter @we/electron package:win
# 产物：apps/electron/release/*.msi、*.zip
```

Tauri（需要 Rust stable，Windows 上推荐 MSVC 工具链）：

```bash
pnpm --filter @we/tauri build
# 产物：apps/tauri/src-tauri/target/release/bundle/msi/*.msi
```

只有 MinGW 没有 MSVC 的环境可以用：

```bash
pnpm --filter @we/tauri build:gnu
```

原生 Rust（Slint）：

```bash
cargo build --release --manifest-path apps/slint/Cargo.toml
# 产物：apps/slint/target/release/work-encourager-slint.exe
```

## 工资是怎么算的

```text
有效计薪时长 = 班次总时长 − 不计薪休息时长

日薪模式：每秒工资 = 日薪 ÷ 当日有效计薪秒数
月薪模式：日薪 = 月薪 ÷ 计薪天数；每秒工资 = 日薪 ÷ 当日有效计薪秒数
时薪模式：每秒工资 = 时薪 ÷ 3600

今日已赚 = 累计有效计薪秒数 × 每秒工资 + 累计加班秒数 × 加班每秒工资
```

几条关键规则：

- 金额用 Decimal 计算，展示时才四舍五入（今日 4 位，本月 2 位）
- 暂停区间与休息区间先求交集再扣除，午休不会被重复扣
- 日薪/月薪的正常班次收入封顶当日日薪；加班收入单独累计
- 重置只影响当前班次，历史日结记录不变

## 运行状态

计时器开关优先于一切，其次才是日期与班次：

| 状态 | 判定条件 | 赚钱速度 |
| --- | --- | --- |
| 计时已关闭 | 手动关闭计时器 | 0 |
| 今日休息 | 非工作日，且没有进行中的夜班 | 0 |
| 未上班 | 今天要上班，但还没到上班时间 | 0 |
| 休息中 | 处于不计薪休息区间 | 0 |
| 上班中 | 班次内且不在休息 | 每秒工资 |
| 加班中 | 已下班但仍在加班区间 | 加班每秒工资 |
| 已下班 | 超过下班时间或达到加班上限 | 0 |

倒计时使用真实墙上时间（包含尚未经过的休息），进度只统计有效计薪时长，两者不会混在一起。

**暂停与重置**：关闭计时器会记录一段暂停区间，重新开启后只累计之后的时间，不会补算关闭期间；重置会让当前班次从此刻重新开始，进度与月累计同步变化，但不改动工资与排班。

## 项目结构

```text
work-encourager/
├─ packages/shared/         # 唯一一份核心逻辑
│  ├─ engine.ts             # 状态与金额计算的唯一入口
│  ├─ schedule.ts           # 班次、休息窗口、工作日
│  ├─ wage.ts               # Decimal 工资折算
│  ├─ validation.ts         # 设置校验
│  ├─ settlement.ts         # 日结与补算
│  ├─ reminders.ts          # 下班提醒判定
│  ├─ intervals.ts          # 区间求交 / 合并 / 扣除
│  ├─ encouragement.ts      # 鼓励文案
│  └─ date · types · defaults · effective · api
├─ apps/electron/           # Electron 主进程 + Vue 渲染层
├─ apps/tauri/              # Tauri Rust 外壳 + Vue 渲染层
├─ apps/slint/              # 原生 Rust + Slint（独立引擎，低内存实验版）
└─ .github/workflows/       # 自动构建与发布
```

两个 Vue 应用都通过 `@shared/*` 别名引用核心模块，**修改计算规则只需要改一处**；`apps/slint` 用 Rust 重写了同一套规则（`src/engine.rs`），与 TypeScript 版行为对齐，但属于独立实现，改动时需要同步。

| 模块 | 职责 |
| --- | --- |
| `engine.ts` | 给定时间与设置，算出状态、金额、进度、倒计时 |
| `schedule.ts` | 班次展开、休息窗口、特殊日期、跨午夜 |
| `wage.ts` | 日/月/时薪折算，保留完整精度 |
| `validation.ts` | 工资、时间、休息、目标等字段校验 |
| `settlement.ts` | 已结束班次写入日结，支持补算 |
| `intervals.ts` | 时间区间运算，暂停与休息取交集 |

## 数据与隐私

- 数据以单个 JSON 保存在本机：
  - Electron：`%APPDATA%\work-encourager\work-encourager.json`
  - Tauri：`%APPDATA%\com.workencourager.desktop\work-encourager.json`
- 两个版本结构一致，复制该文件即可迁移
- 无账号、无网络请求、无遥测；隐私模式隐藏金额但保留进度
- 数据读取失败时给出明确提示，不会静默清空

## 常见问题

**为什么两个版本内存差这么多？**
Tauri 复用系统 WebView2，而 WebView2 本身就是多进程 Chromium；Electron 自带一份 Chromium。安装包大小和内存占用是两条不同的取舍。

**关闭窗口后还在计时吗？**
在。默认关闭窗口是隐藏到托盘，计时与结算继续，重新打开会按真实时间重算。

**改了工资，今天的金额会变吗？**
保存时会问你从下一班次生效还是立即重算今天。选择立即重算会覆盖今天的日结记录，之前的日期不受影响。

**支持周末或临时加班吗？**
可以。把某天设为「特殊上班日」，或开启加班计薪让下班后继续累计。

## 路线图

- [ ] 数据导入 / 导出
- [ ] 更多统计视图（周、季度）
- [ ] 开机自启
- [ ] 代码签名与自动更新

## 贡献

欢迎提 Issue 和 PR。提交前请确保 `pnpm test` 与 `pnpm typecheck` 通过；涉及计算规则的改动请补充对应单元测试。

## 许可

[MIT](LICENSE)
