# R4 审查依据与基线复现（历史记录）

R4 Final 当前结论请先看 [FINAL_REVIEW.md](FINAL_REVIEW.md) 与 [VERIFICATION.md](VERIFICATION.md)。以下为原 R4 的报告依据与当时复现结果，不是本轮重测。

日期：2026-10-16。附件作为审查材料；只修订设计和独立原型。报告中“开始最小 host 实现”的建议留作后续路线，不构成本轮修改产品代码的授权。

## 本轮输入与保留基线

- [R3 收尾复审原文](source/R3_收尾复审与接线验收建议.md)。
- [用户重新上传的三条原始反例](source/R3_新增聚合状态反例.json)。最初临时路径失效，后续重传后已纳入原件及 SHA-256，见 [来源记录](source/new-counterexamples-provenance.json)。
- R3 目录与 ZIP 原样保留；复制前 manifest 38 项全部匹配。旧证据见 [R3 验证报告](source/r3-verification.md)。R4 不把 R3 通过记录改称本轮重测。
- 生产基线 HEAD 为 dfd7caa63ae19bd40651e00127a71efe57b71b4e；本轮不涉及远端分支验证。

## 独立复现

原始三条 error / blocked / denied + pending 反例分别送入 R3 的 JSON Schema 与其语义函数，均被接受，见 [原件复现记录](source/r3-original-counterexamples-reproduction.json)。这说明设计校验缺口，不能推断尚未接线的产品发生过错误收费或错误终态。重传前的三条手工重建仅保留为调查记录，不替代原始附件。

浏览器重放 R3：准备未发送演示任务 → 重启前取消 → 普通生成确认，任务仍停在 queued、模拟提交 0 且无继续入口。另发送精确用途修改语句，在等待时展开参考区并聚焦用途 select；回复结束后区块收起，焦点落到 BODY。对照记录与 R4 回归统一保存在 browser-evidence.json。

## 本轮采用方式

保留 36 工具、23 组发现目录、预设机制、布局和 D01–D19。工具摘要改由 registry 生成并检查漂移；语义校验穷尽 executionStatus。原始消息、回合有效输入、执行快照三阶段文字统一。U05、T28、T08–T13 和 T15 修订为明确时点、持久证据与计数口径。独立 HTML 只做已定位的交互修补。

本轮静态合同、原型交互分别报告。真实 host/fake provider、模型行为、远端服务、磁盘崩溃恢复及 Windows 原生验收均未执行，所有产品 T/U 验收继续 pending。

