# R4 实际验证记录

日期：2026-10-16。范围仅为本目录设计合同、离线校验及独立 HTML。产品源码、真实 host、fake provider 接线、实际模型与图片服务均未修改或运行。

## 结果与证据层级

| 检查层 | 本轮实际执行 | 结论 |
| --- | --- | --- |
| 合同与样例 | 36 工具的 72 份 input/result schema；219 个结构样例；39 个语义样例；11 种 executionStatus 各有 schema 合法的正例与命中该状态分支的反例 | 通过；不是全行为覆盖率 |
| 原始新增反例 | 对重新上传的三份原对象分别跑 R3 和 R4 | R3 结构/语义均接受；R4 结构仍接受、语义明确拒绝，原因均为在途优先；不能写成 JSON Schema 单独已拒绝 |
| 旧反例 | R2→R3 的 8 项对照在 R4 重跑 | 与预期一致 |
| 摘要同步 | 从 registry 重建五类摘要，检查 36 工具；内存中分别改职责、枚举、必填字段 | 无漂移；三种变更均可检测 |
| HTML 静态 | Node 解析 1 个内嵌脚本，HTML 检查 42 个静态 ID | 可解析、无重复 ID、无外部 script/link/img 资源依赖 |
| 浏览器原型 | 本地浏览器 16 项重点回归；保留 36 条原始观察 | 通过；观察数量不等于通过数量 |
| 视觉检查 | 桌面、800×900 窄窗/抽屉、横图/竖图/多图、取消/恢复 | 查看实际截图；通知位于输入上方，图像完整适应，首尾焦点有效 |
| 产品与真实服务 | 未执行 | 全部 T01–T29/U01–U07 产品验收仍 pending |

命令日志：[schema-validation.log](schema-validation.log)。原件结果：[R3](source/r3-original-counterexamples-reproduction.json) / [R4](source/r4-original-counterexamples-result.json)。摘要变异：[summary-drift-validation.json](source/summary-drift-validation.json)。浏览器原始证据与最终断言：[browser-evidence.json](browser-evidence.json)。静态记录：[html-static-validation.json](source/html-static-validation.json)。

## 浏览器重点路径

1. 单演示任务取消后普通生成能开始并完成；两个演示任务取消一个后，另一项和普通任务仍为零提交；取消最后持有者后普通项提交一次。
2. unknown gate 保留，失败 gate 也不能通过新建演示任务绕过。
3. 重启演示恢复为零提交、等待继续；手动继续后模拟提交次数变为 1。
4. 已返回 1 张后请求取消并选确认取消，显示部分完成且保留该图。
5. 聊天用途回执期间，参考 details 保持打开；原 select 焦点保留。参与复选框被改为禁用后，焦点回到同一参考的用途 select；滚动位置前后为 172。
6. 图片结果异步到达后，参考区仍展开、焦点与滚动保留，聊天里出现 2 张图。
7. viewer 从第 2 张翻到第 3 张后焦点落上一张；从第 2 张翻到第 1 张后落下一张；均未落到 disabled 控件。键盘切范围后焦点仍在范围 select。
8. “仅讨论，然后生成”成功修改用途后打开预览，参考列表为空，没有自动执行。
9. 800×900：左右抽屉入口各一个，没有页面横向溢出；通知 bottom=685.6，输入 top=727.2，不遮发送区。
10. 发送用途修改后继续输入下一条草稿，修订后的 HTML 成功应用用途，草稿文字及 composer 焦点保留；对照改变真正参考用途则返回冲突、保留并发修改。

原始日志保留 R3 缺陷复现，以及 R4 中间版本的纯草稿误冲突，最后两条 final 回归证明已修复；不能把所有原始观察统称通过。图像、回复、种子和提交次数都是本地模拟。下载按钮已触发，但本轮没有核对下载文件字节，不作为原图下载验收。

## 截图

- [桌面概览](screenshots/main-1440.png)、[1280 概览](screenshots/main-1280.png)。
- [继续队列](screenshots/restart-resume.png)、[部分结果取消](screenshots/partial-cancel.png)。
- [用途与焦点](screenshots/reference-purpose-focus.png)、[继续输入的草稿](screenshots/composer-draft-preserved.png)。
- [800 窄窗](screenshots/narrow-800.png)、[800 参考抽屉](screenshots/narrow-800-reference-drawer.png)。
- [竖图查看](screenshots/viewer-portrait.png)、[横图查看](screenshots/viewer-landscape.png)。

布局概念图沿用已确认的 R2 图，不将它冒充 R4 浏览器截图。横竖作品为原型原创 SVG 示意，无真实生成质量结论。

## 复跑方式

在本目录使用已安装的 Python 3.10+ 与 jsonschema 4.x：

```powershell
python -B sync_tool_summaries.py --check
python -B validate_registry.py
```

修改 registry 后需要同步文字时运行 `python -B sync_tool_summaries.py --write`，随后再检查。默认 check 不写文档；生成器只更新五类派生摘要行，保留人工语义解释。

打开 prototype-v3.2-r4.html 或通过静态文件服务浏览；从“原型演示”菜单复跑上述路径。所有测试仅在本地，sessionStorage 仅说明当前标签页重载演示，不能证明磁盘事务、进程崩溃恢复或远端幂等。

## 范围与保留

R3 manifest 38 项再次核对未变。生产 HEAD 仍为 dfd7caa63ae19bd40651e00127a71efe57b71b4e；最终检查 tracked diff 为空，仅新增版本化设计产物。没有提交、推送或合并产品变更。

离线结果字段不能证明 dispatcher claim、授权拒绝来源、取消意图存储、网络发送事务实际发生过；这些必须在未来真实 host + fake provider 阶段分别验收。没有真实供应商、扣费、Windows 原生焦点/DPI 或完整辅助技术验收。
