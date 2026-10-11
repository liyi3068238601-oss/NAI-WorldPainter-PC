# 参考 UI 演示工具

`run_reference_demo.py` 使用相邻 `novelai_local_web` 的 app factory 注入测试上游，不修改其源码。只能使用公开的 `ui-demo-only`，不要输入真实凭据。生成返回几何 PNG，非真实 AI 结果；其他上游操作会报演示不支持。

依赖安装在本仓库 `.venv`，数据、日志和 PID 放在 `.tmp/reference-ui-demo/`，均不进入 Git。前端需先在参考仓库 `next_nai_web` 执行 `npm ci --no-audit --no-fund` 和 `npm run build`。不使用会打开外部浏览器的上游启动脚本。

```powershell
# 在 E:\NAI-WorldPainter\PC端 执行，终端前台方式，Ctrl+C 停止
.\.venv\Scripts\python.exe tools\research\run_reference_demo.py
```

浏览器地址：`http://127.0.0.1:5071/login`。若已有后台实例，不要重复启动占用同一端口。

本次后台监听由虚拟环境 Python 子进程持有；PID 文件记下的是启动进程。停止时先用 `Get-NetTCPConnection -LocalPort 5071 -State Listen` 找到监听 PID，再用 `Get-CimInstance Win32_Process -Filter "ProcessId = <PID>"` 核对 CommandLine 包含本工具及 PC 仓库路径，最后 `Stop-Process -Id <PID>`。不要按所有 python 进程批量结束，也不要盲信旧 PID 文件。

本工具只服务研究，不是 PC 客户端实现。体验范围与测试限制见 `docs/REFERENCE_UI_REVIEW.md`。
