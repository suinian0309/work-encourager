# 署名与来源

## 摸鱼小宠物（鲸鱼娘）

`assets/whale/` 下的分层贴图与动画数据，以及 `apps/*/src/*/whale/` 下的运行时（`rig.js`、`body.js`、`figure.js`），来自：

- 项目：[Coopanion](https://github.com/Pal-AI-Lab/Coopanion)
- 版本：v0.2.21（commit `338854e`）
- 路径：`packages/cortico-world-desktop-pet/web/whale/`、`.../web/kit/`
- 许可：GNU AGPL-3.0-or-later

改动说明：运行时三个模块做了少量适配（`figure.js` 的内部 `import` 改为同目录相对路径，去掉与 Coopanion 宿主相关的可选参数），贴图与 `model.json` 原样使用，未重新绘制。

## 第三方依赖

| 依赖 | 许可 | 用途 |
| --- | --- | --- |
| Electron | MIT | 桌面外壳（Electron 版） |
| Tauri | Apache-2.0 / MIT | 桌面外壳（Tauri 版） |
| Vue | MIT | 渲染层 |
| decimal.js | MIT | 金额计算 |
| electron-store | MIT | 配置持久化 |
| Slint | GPL-3.0 / 商业双许可 | 原生 Rust 版界面 |

## 免责

本项目与 DeepSeek、Coopanion 的维护者没有隶属关系，也未获其背书。工资与工时数据只存在本机，不上传。
