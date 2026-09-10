# Android 真机修复与验证

## v2.9.22 初次验证的证据及边界

设备为 Android 16，小米浏览器 20.26.1040901，Chromium 135.0.7049.79；通过 USB ADB 与浏览器真实 CDP 端点连接。不是桌面设备视口模拟，也不是独立 Google Chrome App 的实测认证。

1. v2.9.21 的 `.rpig-fab` 已存在，display 为 flex、visibility 为 visible，但 top=-126px、bottom=-82px，完全位于屏幕上方。祖先 html 的高度为 0，transform 是单位矩阵，perspective 为 1000px。fixed 元素的 bottom 定位相对于该包含块，不能靠 display/z-index 修好。
2. 改用可视视口坐标并校正包含块偏移后，FAB top=562.923px、bottom=606.923px，可视视口高 688.923px，elementFromPoint 命中 FAB。用户确认界面恢复。修改版整体重新加载检查中 FAB 数量为 1、设置面板存在、没有本插件初始化异常。
3. 用户图片服务 `/v1/models` 的真实 OPTIONS=204、GET=200。只能证明当时该路由及其预检成功，不能证明 edits/generations 成功，也不能把之前的 Failed to fetch 判为 CORS。
4. 当前手机剧情 LLM 配置为复用酒馆 LLM。文本请求与插件直连图片请求是不同执行路径。
5. 手机控制台另有 `mobile` 扩展重复声明、forumUIReady 未定义，以及 tts 的 SpeechSynthesisUtterance 未定义；这些不属于本插件。不能据此宣称本插件的网络故障原因已确定。

初次验证时没有获得原生产 edits/generations 或 LLM 的失败请求，也没有宣称生产图片生成已验证成功。需要用原接口实际生成一次验证。

## 改动

- 悬浮工作台使用 visualViewport 坐标，并在 resize、orientationchange、pageshow 和可视视口滚动/变化时约束在屏幕内；不修改酒馆或其他扩展的 html/body 样式。
- 悬浮球与设置面板初始化错误显示给用户，并在 Console 保留异常堆栈。
- 参考图读取/转换/下载失败立即停止；edits 错误不再改为调用 generations。
- 仅在响应明确提到 input_fidelity 且 HTTP 400/422 时，去掉该可选字段重试 edits；仍保留原响应原因。
- IndexedDB 的读取错误、事务中止、保存错误、打开阻塞分别报告，修复原保存回调缺少 reject 的问题。真正没有记录时仍返回空列表，界面注明这是当前浏览器的状态。
- 参考图包包含图片字节，不依赖另一设备的服务器路径，不包含 API 配置；导入追加到当前选中角色。包上限 30MB，每角色上限 50 张。IndexedDB 本身仍不跨设备自动同步。
- 旧版 WebView 缺少 AbortSignal.timeout/any 时使用兼容实现，超时与用户取消分开处理。

## 错误含义

| 错误码 | 含义与处理 |
| --- | --- |
| NETWORK_FAILED | fetch 未提供可读 HTTP 响应。Console/Network 检查 CORS、DNS、TLS、混合内容、连接状态。单凭 Failed to fetch 无法区分。 |
| REQUEST_TIMEOUT | 请求超时。 |
| EDITS_NOT_FOUND | HTTP 404：先查 API 根地址、路由和模型，不能只凭 404 认定模型不支持 edits。 |
| EDITS_UNSUPPORTED | HTTP 405/501：服务不接受该方法或未实现该接口，保留响应正文。 |
| EDITS_HTTP / EDITS_EMPTY_RESPONSE | edits 返回其他错误，或成功响应缺少图片。保留 HTTP 状态、脱敏正文，停止生成。 |
| REFERENCE_MISSING / REFERENCE_INVALID | 参考图记录缺失或图片数据无效。重新上传或导入完整图片。 |
| REFERENCE_STORAGE_READ_FAILED / WRITE_FAILED | IndexedDB 读写故障，不能当作空图库。 |
| REFERENCE_DOWNLOAD_FAILED / REFERENCE_AVATAR_FAILED | 指定参考图/角色卡原图无法读取，停止生成。 |
| TEMP_IMAGE_DOWNLOAD_FAILED | 生成接口已返回链接，但下载成图失败。单独检查 CDN 的 CORS、有效期或 HTTP 状态。 |

若生产接口的 Console 明确提示 CORS，需在 API 服务端允许实际酒馆 Origin、Authorization/Content-Type 和对应方法，或使用自己控制的同源服务端转发。前端 `no-cors` 无法读取 API 响应，不是修复方法。不要把用户密钥交给公共代理。

## 本地测试

```sh
npm ci
npm test
npm run check
```

v2.9.22 的 48 项测试包括真实调用函数的错误分支测试和 fake-indexeddb 事务故障测试，原 CSS 检查仅作为补充。

## 可重复的 Android CDP 测试

需要 Node.js 22+（脚本使用内置 WebSocket），手机实际打开酒馆，USB 调试已授权。安装插件不需要 Node.js 测试依赖。

1. `adb devices -l` 确认真实手机为 device。
2. 从 `adb shell cat /proc/net/unix` 找到浏览器的 devtools socket；小米浏览器本次为 `browser_webview_devtools_remote_<pid>`，标准 Chrome 常为 `chrome_devtools_remote`。不要写死旧 PID。
3. `adb forward tcp:9223 localabstract:<实际 socket 名>`。`http://127.0.0.1:9223/json/list` 中应有标题为 SillyTavern 的页面；只保留一个待测酒馆页以避免歧义。
4. 开一个电脑终端执行 `npm run test:android:server`，并执行 `adb reverse tcp:18765 tcp:18765`。
5. 酒馆应以 `http://127.0.0.1:8000` 打开（测试服务仅允许该 Origin）；其他地址请同时调整测试服务允许的 Origin。
6. 在另一个终端执行 `npm run test:android`，可通过 `RPIG_CDP_URL` 改 CDP 地址，`RPIG_ANDROID_REPORT` 改报告路径。默认写入 android-test-results.json。

脚本通过 CDP 将当前仓库模块加载到真实手机页面，使用本地受控 HTTP 服务测试 multipart、404/405/500、CORS 预检拒绝、图片 410 及实际 IndexedDB。只使用 fixture 密钥，不调用生产模型。参考图数据库名称替换为独立测试数据库并在结束后删除，用户参考图库保持原样。FAB 定位会在当前页生效；该测试不替代安装后的整体插件启动检查。

11 项真机测试通过，其中两条受控 CORS 请求的 CDP 失败原因均为 `PreflightMissingAllowOriginHeader`。该结果验证错误分支，不用于反推原生产故障。

## 安装后仍需验证

- 在手机扩展管理中更新仓库版本并刷新，确认版本 v2.9.23；调试会话的临时注入不会替代安装更新。
- 横竖屏、地址栏伸缩、键盘打开/关闭、拖拽悬浮球及面板滚动。
- 原生产 LLM、带角色参考图 edits、无参考图 generations，以及输出临时 URL 下载并保存的完整流程。
- PC 导出参考图包，在手机同一角色导入后生成一次；不同浏览器/不同服务器不应依赖相同 IndexedDB 或绝对本地路径。
- 如需要 Google Chrome App 与其他 WebView 的认证，分别在相应真实 App 中复验；不能把小米浏览器内核版本当作全部浏览器兼容证明。

## v2.9.23：图库、重试与模型协议补充验证

- 用户后续截图显示 `/images/edits` HTTP 500，正文为 `not supported model for image generation, only imagen models are supported`。这是 NewAPI Gemini 图片转换器的明确错误，不能归类为 CORS 或参考图丢失。对应源码：https://github.com/QuantumNous/new-api/blob/main/relay/channel/gemini/adaptor.go 。
- 真机 `/v1/models` 返回 200，所选 Gemini 图片模型声明 `supported_endpoint_types: ["openai"]`。插件据此选择 Chat 图片协议并携带全部参考图；声明 Gemini 则使用原生协议。未知声明保留原 Images 路径，仅针对明确的协议不匹配错误进行一次原生尝试；普通 HTTP 错误不盲目切换。
- 该服务的实际 Chat 生图 POST 与原生 generateContent POST 都返回 HTTP 404 / openai_error，OPTIONS 为 204。没有生产出图成功记录。仍需检查服务端渠道、模型映射和同一密钥的 PC 当前表现，不能声称前端修复已解决上游故障。
- 用户第二张截图对应的真实图库有 3 张图，3 张均已加载，但 overlay 高度仅 40px，grid 高度仅 8px；根元素高度为 0 且有 transform/perspective。修复为实际可视视口尺寸，并阻止关闭按钮被压缩换行、网格卡片被压扁。
- 在同一真实 Android 浏览器运行当前图库函数和样式，18 张测试图全部加载，图库可滚动、大图可打开关闭。完整 v2.9.23 页面加载后 FAB 数量为 1、设置面板存在、无插件初始化异常，图库高度 688.923px、网格 594.308px。整页刷新后酒馆未恢复原聊天，因此该次启动检查不能声称原角色 3 张图已复验成功。
- 文字分析完成后图片或参考图失败，在当前页面保留分析和确认后的提示词。再次生成会重新读取参考图、使用最新图片配置，不重复调用文字模型。消息、聊天、角色、镜头或风格变化会使缓存失效。取消、成功或刷新清除缓存；升级前的失败无法追溯恢复。
- 本地共 74 项行为测试，新增实际生成任务的缓存/失效/取消测试和 Gemini 原生、Chat、Images 协议及错误分支测试。错误提示解析服务端 JSON，避免重复 HTML 转义。

真机图库测试命令：`npm run test:android:gallery`（先按上文建立 CDP forward，无需 fixture HTTP 服务）。使用当前图库函数与 18 张内存图片，不写用户图库；会关闭当前图库并打开测试图库，结束后关闭。报告写入 `android-gallery-results.json`。这验证真实浏览器布局与交互，不替代用户原图片和安装后的验证。

仍需实机复验：正式更新后回到原角色查看 3 张图片；横竖屏和浏览器工具栏展开/收起；修复上游后带参考图成功生成、失败重试不重复分析及临时图片保存。独立 Chrome App/其他 WebView 尚未认证。

## v2.9.25 设置按钮真机修复

真实手机上酒馆 `.menu_button { width: min-content }` 将中文导入/导出按钮压到 26.846px 宽、210–231px 高。仅在 #rpig_container 覆盖按钮宽度后，两者均为 340.981px × 28.154px，生成参考图按钮为 315.135px × 36.154px。

打开插件设置的参考图卡片，运行 `npm run test:android:settings`。脚本检查真实 DOM 中 4 个按钮的宽度、高度和父容器溢出，等待 CSS 过渡结束后测量，测试后移除临时样式，不上传文件、不调用模型。

## v2.9.26 图片导入

两个上传/导入入口现在共用图片和 JSON 包读取流程，图片原始字节保存在浏览器参考图库中。`npm run test:android:import` 在实际 Android 页面运行当前导入事件处理器，使用不含 MIME 的内存 PNG 文件，保存适配器为隔离内存，检查图片字节、标签、预览解码及输入框清理；不写用户参考图库。真机通过；系统相册/文件管理器选择和正式安装后的用户原图导入仍需用户操作验证。
