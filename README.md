# 上班鼓励器

把上班的每一秒，都换成看得见的收获。

一个 Windows 桌面小工具：实时显示今天已经赚了多少钱、距离下班还有多久、今日工时进度和本月累计；支持加班计薪、透明桌面浮窗、托盘常驻、本地历史记录。完全离线，不上传工资与工作数据。

本仓库包含 **两个桌面外壳**，共用同一套计算引擎：

| 应用 | 技术栈 | 安装包 | 私有内存（实测） |
| --- | --- | ---: | ---: |
| [`apps/electron`](apps/electron) | Electron + Vue 3 | 约 102 MB | 约 127 MB |
| [`apps/tauri`](apps/tauri) | Tauri 2 + Rust + WebView2 | 约 2 MB | 约 274 MB |

> 体积优先选 Tauri，内存优先选 Electron。两者数字、状态、历史完全一致，因为计算逻辑只有一份。

安装包不提交到仓库，由 GitHub Actions 在打 tag 时构建并挂到 **Release**（Electron 安装包 102 MB，超过 GitHub 单文件 100 MB 限制，无法直接入库）。

## 目录结构

```text
work-encourager/
├─ packages/shared/        # 唯一一份核心逻辑（约 13 个模块）
│  ├─ engine.ts            # 状态与金额计算的唯一入口
│  ├─ schedule.ts          # 班次、休息窗口、工作日
│  ├─ wage.ts              # Decimal 工资折算
│  ├─ validation.ts        # 设置校验
│  ├─ settlement.ts        # 日结与补算
│  ├─ reminders.ts         # 下班提醒判定
│  ├─ encouragement.ts     # 鼓励文案
│  ├─ intervals.ts         # 区间求交/合并/扣除
│  └─ date / types / defaults / effective / api
├─ apps/electron/          # Electron 主进程 + Vue 渲染层
├─ apps/tauri/             # Tauri Rust 外壳 + Vue 渲染层
└─ .github/workflows/release.yml
```

两个 app 都通过 `@shared/*` 别名指向 `packages/shared`，**修改计算规则只需要改一处**。

## 功能

- 主界面：日期/星期/时间、状态、上下班倒计时、今日已赚、元/秒、鼓励文案、进度条、本月累计、历史入口
- 工资：日薪 / 月薪（按实际工作日或固定天数）/ 时薪，实时展示日/时/秒折算
- 工作时间：上下班、多段休息（逐段计薪开关）、每周工作日、特殊日期、跨午夜班次
- 加班：启用开关、按正常时薪或自定义时薪、倍数、每日上限
- 浮窗：260×152 透明/主题卡片，只显示状态、今日已赚、倒计时、进度；打开后主窗口隐藏、不占任务栏
- 设置保存：班次中/已结算时会询问「从下一班次生效」或「立即重算今天」
- 托盘、单实例、下班提醒、隐私模式、金额小数位
- 本地 JSON 持久化，历史记录冻结当日计算参数

## 开发

需要 Node.js 22+ 与 pnpm 11：

```bash
pnpm install
pnpm test              # 两个 app 各 39 项单元测试
pnpm typecheck         # 类型检查

pnpm dev:electron      # Electron 开发模式
pnpm dev:tauri         # Tauri 开发模式（需要 Rust 工具链）
```

### 单独构建安装包

Electron：

```bash
pnpm --filter @we/electron package:win
# 产物：apps/electron/release/*.msi、*.zip
```

Tauri（需要 Rust stable；Windows 上推荐 MSVC 工具链）：

```bash
pnpm --filter @we/tauri build
# 产物：apps/tauri/src-tauri/target/release/bundle/msi/*.msi
```

> 没有 MSVC、只有 MinGW 的环境（例如离线机器）可用 GNU 工具链：
> ```bash
> pnpm --filter @we/tauri build:gnu
> ```
> 需要自行配置 `x86_64-w64-mingw32-gcc` 作为链接器。

## 发布流程

1. 打 tag 并推送：

```bash
git tag v1.0.0
git push origin v1.0.0
```

2. GitHub Actions 会自动：
   - 在 `windows-latest` 上安装依赖、跑单元测试
   - 构建 Electron 与 Tauri 安装包
   - 把 MSI/ZIP 上传到该 tag 对应的 Release

也可以在 Actions 页面手动 `Run workflow`，只产出 Artifact 不发布。

## 数据与隐私

- Electron：`%APPDATA%\work-encourager\work-encourager.json`
- Tauri：`%APPDATA%\com.workencourager.desktop\work-encourager.json`
- 两版数据结构一致，迁移时复制该 JSON 即可（旧记录缺少的加班字段会自动补 0）
- 无账号、无网络请求、无遥测

## 已知限制

1. Tauri 安装包小，但依赖系统 WebView2，进程内存高于 Electron。
2. Tauri 需要 WebView2 Runtime；缺失时 MSI 的 bootstrapper 会联网下载。
3. 安装包未代码签名，Windows SmartScreen 可能提示「未知发布者」。
4. 时薪模式不推断加班；加班是独立开关，仅统计配置班次之后的时间。
5. 下班提醒依赖 Windows 通知权限；系统关闭通知时不会弹出，但提醒状态仍会持久化以防重复。

## 许可

MIT
