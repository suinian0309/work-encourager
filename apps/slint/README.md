# 上班鼓励器 · 原生 Rust（Slint）版

> ⚠️ **界面观感明显弱于 Electron / Tauri 版。** 本版存在的唯一理由是运行时内存极低（私有约 4.7 MB）。如果你在意界面，请使用仓库里的另外两个版本。

使用 **Rust + Slint 软件渲染器**，不依赖 GPU、WebView2、Electron，单文件 exe 直接运行。

## 实测

| 版本 | 私有内存 | 工作集 | 磁盘 |
| --- | ---: | ---: | ---: |
| Electron | 约 127 MB | 约 311 MB | 约 102 MB |
| Tauri + WebView2 | 约 274 MB | 约 496 MB | 约 2 MB |
| **本版（Slint 软件渲染）** | **4.7 MB** | **18.9 MB** | 约 9 MB |

## 界面

设计系统在 `ui/theme.slint`：卡片、输入框、开关、分段控件、星期胶囊、按钮、进度条全部自绘，统一圆角与投影。

做不到的部分（与 Electron 的差距）：

- Slint 软件渲染器没有 `backdrop-filter`，无法做磨砂/模糊
- 阴影是单层投影，没有 CSS 那种多层柔光
- 字体渲染与 Chromium 略有差异
- 设置项比 Vue 版少：没有特殊日期、目标增删排序、主题切换
- 未实现单实例

## 浮窗

- 260×152，无边框，深绿渐变卡片
- Win32 圆角区域裁切，四角无黑边
- 按住可拖动（`WM_NCLBUTTONDOWN`）
- 显示在屏幕右下角，可在设置里调整透明度（60/80/92/100%）

## 构建

需要 Rust stable：

```bash
cargo build --release --manifest-path apps/slint/Cargo.toml
# 产物：apps/slint/target/release/work-encourager-slint.exe
```

只有 MinGW、没有 MSVC 时，设置链接器：

```bash
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
cargo build --release --target x86_64-pc-windows-gnu --manifest-path apps/slint/Cargo.toml
```

## 数据

- 默认：`%APPDATA%\WorkEncouragerNative\work-encourager-native.json`
- 可用环境变量 `WORK_ENC_DATA_DIR` 覆盖
- 字段与 Vue 版不同，不做自动迁移

## 调试

- 启动参数 `--float` 直接打开浮窗
- 环境变量 `WORK_ENC_VIEW=settings|history` 启动时直接进入对应页面（仅用于截图验证）

## 测试

```bash
cargo test --release --manifest-path apps/slint/Cargo.toml
```
