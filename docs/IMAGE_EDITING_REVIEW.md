# 图生图裁切与局部重绘工作区

日期：2026-10-12。范围：手机端普通图生图与局部重绘的桌面交互、像素处理、来源关系和结果回填。绘世三栏布局、深色暖金与浅色蓝保持一致。

## 图生图

在生成设置的「参考」页选择图生图，导入原图或使用当前图库图片，进入裁切窗口。支持纵向 832×1216、方形 1024×1024、横向 1216×832 和当前自定义输出尺寸；可移动裁切框、拖动八个控制点、移动或缩放图片、居中及重置。

确认后另存裁切 PNG，保留原始受管图片与源像素裁切范围；重新裁切始终读取原图。替换和移除只改变草稿引用。取消裁切保留已有参考；改变输出分辨率后，提交前重新确认裁切。结果是独立图库记录，完整参数回填会恢复裁切来源和参考图。

## 局部重绘

选择局部重绘后，中央画布显示完整工作区：导入或选用原图、整体平移、移动原图、移动及缩放输出框、圆形或 8px 方格画笔、擦除、蒙版或图像笔迹、笔刷大小及颜色、撤销重做、清空和蒙版显隐。区域可移出原图边界做扩图；全图模式使用原图边界。绘制时保留输出区域边框，选择工具提供八个拖动控制点。放大、缩小、适应画布与滚轮缩放均保持源图坐标不变。

提示词、负向提示词、强度、忽略原图、色彩校正、输出分辨率和批量张数沿用右侧生成设置。工作区提供蒙版扩展 0–32px、边缘羽化 0–32px 与预览透明度。像素 2x/3x 放大采用最近邻，生成新的受管图片，不覆盖原图。

生成前冻结原图、笔迹、选区、蒙版及请求参数。画笔大小与所有坐标以源图像素保存，每条笔迹保留自身的大小和操作；后续改笔刷不会改变旧笔迹。图像笔迹先合入请求底图，蒙版笔迹按顺序画／擦。原图外及透明区域自动进入重绘蒙版。

手机端规则是先画／擦，再扩展最终蒙版，最后按 8×8 latent 单元聚合为黑白二值、单通道 PNG；白色表示重绘。停止笔迹后，界面预览使用实际请求蒙版，包含扩展、8px 对齐及原图外区域。预览透明度仅影响显示。

## 结果图层、合成与回填

每条成功响应保留服务原图、基于冻结请求蒙版生成的透明结果层、原图坐标和参数。工作区结果层支持显隐和移除；保存合成将当前可见图层及图像笔迹保存为新的图库原图。掩码及选区外的源图像素保持，扩图结果记录负坐标原点及新画布边界。

选择结果后可回填为新的重绘原图，也可在图库图片详情选择「用作图生图参考」或「继续局部重绘」。完整参数回填恢复生成时的编辑快照。草稿、撤销／重做、原图引用、裁切范围和结果层通过现有 SQLite 工作区保存；结果图片均在受管图片仓库中。

取消后不加入该请求的候选或图库记录；关窗等待编辑准备与生成任务收尾，再保存工作区。文件原子发布与 SQLite 索引间仍有已记录的中断窗口，可能留下未索引内容地址文件，详见 [图片存储](IMAGE_STORAGE.md)。

## 行为来源与实现

- 只读手机端当前裁切组件、创作页、局部重绘页、领域模型和栅格器，文件哈希见 [来源快照](evidence/editing/source-manifest.json)。PC 实现独立编写，没有复制许可尚未确认的手机业务源码。
- NovelAI Local Web 参考选框、扩图、蒙版和结果处理交互；保留绘世主题，没有引入其 AGPL 代码或紫色品牌样式。
- 手机当前可达页使用可见结果图层与合成保存；`InpaintCandidate` 的 kept/primary 实体没有可达调用。本轮以图层与明确回填为交付行为，不以静态实体证明手机有候选管理流程。
- 矩形输出框用于限定生成区域；领域栅格器支持矩形蒙版笔迹，但手机当前页没有矩形笔迹创建入口。分块高清图生图属于 MP-GEN-13 后续独立验收项。
- 坐标和 RGBA 处理核对了 Flutter [Canvas.drawImageRect](https://api.flutter.dev/flutter/dart-ui/Canvas/drawImageRect.html)、[ImageByteFormat](https://api.flutter.dev/flutter/dart-ui/ImageByteFormat.html) 和 [PixelFormat](https://api.flutter.dev/flutter/dart-ui/PixelFormat.html)。内部算法使用 straight RGBA，交给原生图像描述器前转换为 premultiplied alpha，避免羽化边缘异常变亮。

## 验证

最终记录见 [validation.json](evidence/editing/validation.json)，包含构建产物 SHA-256 与五份手机源文件未改变的校验。

| 检查 | 结果与证据 |
| --- | --- |
| 自动化 | [76 项测试通过](evidence/editing/tests.txt)：裁切实际像素、蒙版绘制/擦除/8px 对齐、透明区与扩图、羽化合成、2x/3x 最近邻、SQLite 编辑快照重开、取消及旧源图迟到响应隔离、鼠标/触摸选框、灰度预览位置 |
| 静态分析 | [Dart analyze 无问题](evidence/editing/analyze.txt) |
| Windows | [Release 构建成功](evidence/editing/windows-build.txt)；最终可执行文件两次独立进程完成 [SQLite、中文路径及 PNG SHA-256 重开探针](evidence/editing/windows-probe.txt) |
| Web | [Release 构建成功](evidence/editing/web-build.txt)。存在既有 Cupertino 字体族声明警告；实际 Material 图标已显示 |
| 浏览器 | 全程内置浏览器；裁切→图生图→蒙版画/擦→撤销/重做→调整区域→重绘→合成保存→应用结果→图库完整回填→重载恢复。深浅主题、640×480 窗口及设置抽屉可用，控制台无 warning/error |

实际画面：[裁切](evidence/editing/crop-dark.jpg)、[绘制与擦除](evidence/editing/mask-paint-erase.png)、[区域调整](evidence/editing/region-dark.png)、[生成合成](evidence/editing/generated-region.png)、[浅色主题](evidence/editing/workspace-light.png)、[窄窗口](evidence/editing/workspace-compact.png)、[最终构建重开](evidence/editing/workspace-reopened.png)。本机服务捕获的 [实际请求蒙版](evidence/editing/final-request-mask.png) 为 1024×1024 的灰度 PNG，擦除区保持黑色。

实际运行发现并修复了三个问题：连续笔迹连接轮廓与圆形印章绕序相反导致节点空洞；本机 Flutter Web 的 `ImageDescriptor.raw` 将显式 `rowBytes` 当作像素步长，导致预览纵向压缩，紧密 RGBA 改用默认步长；旧请求结束时必须检查冻结的源图及工作区身份，避免把结果图层放进新的原图工作区。相应回归检查已加入。

接口验证只使用本机模拟服务和标注为 SOURCE FIXTURE / LOCAL MOCK 的合成图片；真实官方与网关账号兼容性仍需单独授权联调。结束时已删除本次合成测试凭据、恢复默认地址与官方接入、停止 mock，并保留内置浏览器预览。

Windows 原生文件对话框已编译，交互验证按用户要求使用内置浏览器。未提供安装签名、自动更新或大图／大图库性能结论；完整手机功能矩阵继续推进。
