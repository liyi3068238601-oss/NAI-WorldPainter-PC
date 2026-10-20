# 全量测试失败归类

读取 `tests-full.txt`，按用例去重。重复 FAIL 为重试，不能计379个独立失败。

结果：402文件通过、47失败、1跳过；3995测试通过、126失败、2跳过。126唯一用例失败之外，另有1套件载入失败。

| 分类 | 唯一测试失败 | 结论 |
|---|---:|---|
| 明确本地网络权限 | 48 | 含 EACCES 127.0.0.1，含包装成fetch/断言的错误 |
| 明确文件权限 | 28 | symlink/junction/hardlink EPERM |
| 缺失固定夹具 | 2 | 另1缺证书的套件无法载入 |
| 通用连接错误 | 23 | 仅Connection error，不能证明都是权限根因 |
| DNS/代理路由 | 2 | .invalid域名进入直连，ENOTFOUND |
| 尚未定因 | 22 | 14断言、7TypeError、1超时 |
| Electron异常退出 | 1 | 2147483651，无探针成功报告 |

代表位置（均为tests-full.txt行号）：

- L272 agent-api-real、L454 detective-generation-bridge、L1885 native-submit-guard：loopback EACCES。
- L325 agent-comic-project：原子交付hardlink EPERM；L364 agent-workspace-migration、L1396 harness-plugin-transaction：目录链接EPERM。
- L83 preflight-network.test.ts:9 缺 shared/issue-network-fixtures/public-test-cert.pem，整套件未载入；L95 builtin-fonts.test.ts:30 缺 mobile/lib/models/builtin_ui_fonts.dart；L258 version-consistency.test.ts 缺 mobile/lib/models/nai_models.dart。三文件在基线未跟踪，不能推断版权原因。
- L124 system-prompt-contract断言；L139起七项未捕获请求messages的TypeError；L2004 openai-image-edit请求数期望1实际0；L2662 pi-agent-turn期望2实际0。可能有网络连带影响，但证据不足，保持未定因。
- L2102 openai-images取消用例30秒超时；L105 inpaint-pointer-browser探针异常退出，不能视为13项蒙版探针通过。
- L1093/L1174 download-request代理测试的metadata.invalid/model.invalid解析失败。proxy.ts:127-135本地探测失败后回退直连，与沙箱限制相符，但仅为推断。

尚未定因22项分布：system-prompt-contract8、nai-accounts-login1、native-partial-save1、openai-image-edit-workbench1、openai-image-edit2、openai-images6、pi-agent-provider2、pi-agent-turn1。

本阶段不修复或通过排除测试来掩盖失败。定向116通过是另一组结果，不能替代全量。GUI截图也不证明这些失败已解决。
