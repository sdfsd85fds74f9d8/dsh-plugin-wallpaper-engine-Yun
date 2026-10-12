# dsh-plugin-wallpaper-engine-Yun

> **合体版 · 壁纸引擎 + 开机动画** —— 基于 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) **v1.3.1** 二次开发

🎬 打开 DSH 时，你的壁纸铺满整个窗口当作开机动画，停留片刻后以机械感离场动画无缝揭幕；进入界面后，它继续做你的动态壁纸与液态玻璃美化。

**插件作者：小云**（抖音：`xyh6bai6shi6`，二维码见插件「关于」页签）

---

## 🙏 致谢（请先读这一段）

本插件的每一块基石都来自 [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) 及其台前幕后的贡献者——**原作者 elysia395**，以及 **oneincase**（WebWallGL 渲染引擎）、**YV3507**、**yuxilao**、**Jerry** 和所有通过 issue / PR 参与改进的朋友。没有他们的辛勤工作与长期维护，就不会有这个项目的存在。

本合体版只是在他们优秀的代码之上做了少量增量（见下），若有任何可取之处，功劳属于原作者团队；若有不足，皆因小云学艺不精，还请多多包涵与指正。如果你喜欢这个插件，请务必去原版仓库点一颗 ⭐ 支持原作者。

原版完整文档见 [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md)（[English](docs/UPSTREAM-README.en.md) / [新手指南](docs/UPSTREAM-README.beginner.md)）。

## ✨ 合体版新增功能

| 功能 | 说明 |
|------|------|
| **🖼 开机画面** | 打开 DSH 时壁纸铺满全窗口当作开机动画：可跟随当前壁纸，也可**自选**壁纸库里的某一段（视频/场景壁纸直连播放）；停留设定时长后无缝揭幕 |
| **⚙️ 离场动画 ×5** | 溶解（经典）/ 光圈收束（相机快门感）/ 机械百叶 / 扫描离场 / 故障抖切（赛博机械） |
| **🎵 自选开机音乐** | 独立音轨 + 独立音量，壁纸静音策略不影响它；随离场动画**同步淡出** |
| **🚀 起播缓冲自适应** | 开机风暴期起播必丢帧（原版作者实测结论）：深色底先顶着，**实测帧节奏**、帧率一稳即提前揭幕——流畅与快速兼得 |
| **🔊 声音优先** | 开机画面期间可选静音全部壁纸声音（原型级拦截，含场景音频与 `new Audio()` 隐形音频），进入界面后恢复 |
| **🔧 全部设置就地可调** | 设置 → 壁纸引擎 → 壁纸库 → 「开机画面」区块：所有参数即时保存 |
| **🩹 切屏恢复修复** | 修复切回窗口后壁纸恢复播放失败的问题（静音续播 + 回屏救援双保险） |

所有新增设置与原版共用同一个配置文件（`~/.dsh-wallpaper-engine/config.json` 的 `boot*` 字段），原版设置项原封不动。

## 📦 安装

> ⚠️ **重要：本插件与原版 `dsh-plugin-wallpaper-engine` 不能共存**（路由与 ID 完全相同，同时启用会冲突）。请先卸载原版，再安装本合体版；你的壁纸选择、玻璃参数等所有设置都会原样保留。

```powershell
# DSH profile 目录下（默认 ~/.dsh/profiles/desktop/）
# package.json 的 dependencies 加入：
#   "dsh-plugin-wallpaper-engine-Yun": "github:sdfsd85fds74f9d8/dsh-plugin-wallpaper-engine-Yun"
# 然后：
pnpm install
# 重启 DSH
```

国内直连 GitHub 困难时，可用镜像前缀（如 `https://gh-proxy.com/` + tarball 地址）或克隆到本地以 `file:` 路径安装。

## ⚙️ 配置

- **壁纸 / 美化 / 开机画面**：全部在 设置 → 壁纸引擎 内（壁纸库页签底部「开机画面」区块）
- **开机音乐素材**：把 mp3/wav/m4a/ogg 等丢进 `~/.dsh-wallpaper-engine/boot-audio/`，设置页下拉即选
- **配置文件**：`~/.dsh-wallpaper-engine/config.json`（与原版同一文件，字段互不干扰）

## 🧩 技术要点（给后来的维护者）

- fork 基线：原版 **v1.3.1** 源码；客户端产物由 `node scripts/build-client.mjs` 重建（零依赖构建，产物与官方逐字节一致验证过）
- 开机画面通过 `webserver/index-inject` 在 `<head>` 注入面板脚本：开机时把应用外壳临时隐藏，壁纸引擎挂在 body 上的活壁纸层即成为全窗口开机画面；与 `dsh-boot-2077` 插件自动互斥
- 「开机画面」设置存于原版 settings 结构的 `boot*` 字段（schema 见 `lib/settings-schema.js`），宿主注入逻辑见 `lib/index.js` 的 boot inject，面板脚本见 `lib/boot-panel.js`
- 切屏恢复的静音续播/回屏救援见 `src/client.js`（`wePlayMutedResume` / `installVisibilityRescue`）

## 📄 许可

MIT（与原版相同）。见 [LICENSE](LICENSE)——该 LICENSE 保留原作者 elysia395 的署名。本衍生作品同样以 MIT 发布，任何再分发请保留双方署名与本声明。

## 📮 联系

- **本合体版作者**：小云 —— 抖音 `xyh6bai6shi6`（「关于」页签有二维码）
- **原版项目**：[github.com/elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) —— 问题反馈、功能建议请优先去原版仓库（通用问题那边都能答）；仅与开机画面相关的问题欢迎来找小云
