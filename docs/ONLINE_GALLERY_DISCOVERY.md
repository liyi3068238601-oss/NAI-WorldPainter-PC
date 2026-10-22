# 在线图库排序与来源扩展

日期：2026-10-22

## 基线与范围

已刷新远端引用，基于本地最新开发分支 `feat/agent-r4-refactor` 的 `f576689` 创建 `feat/online-gallery-discovery`。该基线包含尚未推送的三个开发提交；没有退回远端较旧的提交。原有未跟踪文档与验收材料未纳入本次改动。

本轮按用户批准的顺序完成现有来源排序、TAGs Gallery 更新和 Civitai 接入。Yande.re、Konachan 留待后续。

## 完成的功能

| 来源 | 排序 | 时间 / 模型选项 |
| --- | --- | --- |
| Danbooru / Safebooru | 默认、最新、最早、评分、收藏数、随机 | 最近 24 小时、7 天、30 天、365 天及全部 |
| Gelbooru | 默认、最新、最早、评分、随机 | 不显示尚未验证支持的时间与收藏排序 |
| QuickTag | 默认、名称升序、名称降序、随机 | 对完整候选集合排序后分页；随机顺序在一次浏览中保持稳定 |
| TAGs Gallery | 评分、投稿数、名称、收藏数 | V4.5 / V5；保留现有分类导航 |
| Civitai | 互动最多、收藏数、评论数、最新、最早、随机 | 热度统计范围：全部、日、周、月、年；支持作者用户名查询 |

AITag 和画师排名原有排序继续使用各自入口。

- Booru 排序直接发给上游，不对当前一页伪装全站排序。“默认”保留手写搜索语法，选择明确排序时以选项为准。Danbooru 时间筛选使用 `age:<Nd`，避免日期取整偏差。
- 随机请求绕过数据缓存。Booru 随机模式提供重新打乱；QuickTag 与 Civitai 保留各自有效的翻页机制。
- TAGs 适配官网新版每页 60 项，正确合并客户端每页 12 / 24 / 48 / 60 项的跨页结果。V5 收藏使用独立 ID，旧 ID 仍代表 V4.5。详情选择对应模型的图片和提示词，排除推荐图片，不借用另一模型的专用提示词。
- Civitai 使用公开 Images API，沿用现有代理、图片缓存、收藏与下载流程。只接收图片；默认安全过滤；请求与本地解析均检查安全等级。
- Civitai 使用不透明游标翻页，支持上一页、失败重试和空页继续。更改筛选会重置游标，不提供不受支持的任意页码跳转。
- Civitai 查询框明确标为作者用户名。公开 API 不保证每张图带有生成信息；缺失提示词时显示说明并隐藏应用按钮。有提示词时可沿用现有“应用到创作”功能，仅复用正负提示词，不自动套用其他模型的生成参数。
- 真实接口验证发现详情响应可能使用 `meta.meta` 包装生成信息，已兼容列表与详情的两种格式。修复后真实带提示词详情验证通过；报告只记录字段是否存在及长度。
- 新控件包含现有五种界面语言的文本。

## 验证

| 验证 | 结果 | 边界 |
| --- | --- | --- |
| `npm run typecheck` | 通过 | TypeScript 静态检查 |
| `npx vitest run --reporter=dot` | 509 个文件通过、1 个跳过；4620 项通过、2 项跳过 | 当前完整自动化回归 |
| `npm run build` | 通过 | Vite 提示现有大 chunk；未制作安装包 |
| 原生 Electron UI | 17 / 17 通过 | 实际构建后的桌面渲染器，合成图库 IPC，外部网络被阻断 |
| 公开接口检查 | 全部成功 | TAGs 两种模型跨页、详情；Civitai 首页、游标翻页、真实提示词详情、收藏排序；Danbooru / Safebooru 评分和时间筛选，以及 Danbooru 最新排序语法 |
| `git diff --check` | 通过 | 改动范围与空白检查 |

原生 UI 覆盖筛选重置、V5 选择、游标失败重试、空页继续、返回上一页、随机排序和提示词应用到创作。截图使用合成图片与合成提示词，不代表真实上游图片加载验收。

证据：[原生 UI 报告](evidence/gallery-discovery-20261022/native-ui-report.json)、[公开接口报告](evidence/gallery-discovery-20261022/live-report.json)。截图位于同一目录，分别为 `01-danbooru-sort.png`、`02-tags-v5.png`、`03-civitai-random.png`、`04-applied-prompt.png`。

复现（在 `desktop` 目录）：

```powershell
npm run typecheck
npx vitest run --reporter=dot
npm run build
node scripts/check-gallery-discovery.cjs
node scripts/check-gallery-discovery-live.cjs
```

UI 脚本优先使用 `GALLERY_PLAYWRIGHT_PATH` 指定的 Playwright Core，未指定时只读复用同工作区 `dot-uiux/desktop/.tmp/uiux-tools/node_modules/playwright-core`。它使用独立临时用户目录；公开接口脚本使用限时匿名 GET，不读取用户凭据，不下载图片，不保存真实提示词或游标。

## 验证限制

- 未运行真实图片下载和缓存的完整在线 UI 链路；本轮公开验证只读取 JSON / HTML 元数据。
- Gelbooru 已验证参数构造、缓存行为和 UI 能力选项，未使用真实账号凭据请求该服务。
- Civitai 图片是否公开提示词取决于上传数据；不同模型的提示词不保证在 NovelAI 上复现原图。
- 未执行付费生图、正式发布、安装包制作或主分支合并。

## 上游依据

实现参考接口文档与公开响应，没有导入第三方实现代码、图片或提示词库。

- [Danbooru 搜索语法](https://safebooru.donmai.us/wiki_pages/help:cheatsheet)：评分、收藏、随机与相对时间。
- [Gelbooru 搜索文档](https://gelbooru.com/index.php?page=wiki&s=view&id=26263)：其自身的排序语法。
- [TAGs V4.5](https://tags.gallery/v4-5)、[TAGs V5](https://tags.gallery/v5)：当前页面结构、排序参数、模型图片和每页数量，检查日期为 2026-10-22。
- [Civitai Images API](https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/images.md)：排序、热度周期、安全等级、元数据与游标规则，检查日期为 2026-10-22。
