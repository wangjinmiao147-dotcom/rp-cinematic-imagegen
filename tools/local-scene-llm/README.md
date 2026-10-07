# 可选本地剧情 LLM 服务 · v2.9.57

基础扩展可直接使用主文字接口，本服务不是必装项。它提供只监听本机的 OpenAI 兼容文字接口，用 Ollama 补一个失败阶段，不生成图片。

## 已验证范围

Windows、Node.js 24、Ollama、NVIDIA RTX 3060 Laptop 6 GB 显存、16 GB 系统内存；9B Q4_K_M 通过部分 GPU 层和 CPU 配合运行，不是全量驻留 6 GB 显卡。其他系统、显卡及模型未验证。示例参数不是所有硬件的资源保证，启动需要可用的 `nvidia-smi`。

## 安装与模型

本包没有权重、私人配置、日志、缓存或 `node_modules`。先安装 Node.js 18+ 和 Ollama，确保 `node.exe`、`ollama.exe` 在 PATH。进入本目录运行：

基础扩展ZIP里的本地服务目录仅提供说明。以下步骤请在独立本地服务ZIP的解压目录或完整Git仓库中执行。

```powershell
npm ci
Copy-Item -LiteralPath local-scene-config.example.json -Destination local-scene-config.json
```

已有本机配置时不要执行覆盖命令。`local-scene-config.json` 被 Git 与发布清单排除；不存在时读取公开 `.example.json`。

依赖 `pinyin-pro` 3.29.4 用于无歧义中文姓名还原，其 MIT 许可证在 `licenses/`。模型出处和 Apache-2.0 许可证见 [第三方说明](THIRD_PARTY_NOTICES.md)。

验证使用 [mradermacher 的 GGUF](https://huggingface.co/mradermacher/Huihui-Qwen3.5-9B-abliterated-GGUF)，源自 [huihui-ai 派生模型](https://huggingface.co/huihui-ai/Huihui-Qwen3.5-9B-abliterated) 和 [Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B)。本包不自动下载模型。阅读来源模型卡和许可证。

| 文件 | 大小 / 校验 |
|---|---|
| `Huihui-Qwen3.5-9B-abliterated.Q4_K_M.gguf` | 5,627,045,248 字节 |
| SHA256 | `ea1858ef4dc4b648b8dbb44612962a0333e945060dd0545ac0f28d7c4416e4b3` |

已有权重时直接复用。在权重所在目录放入本包 `Modelfile`，其 `FROM ./...` 指向同目录权重；核对后创建标签：

```powershell
Get-FileHash -LiteralPath '.\Huihui-Qwen3.5-9B-abliterated.Q4_K_M.gguf' -Algorithm SHA256
ollama create rp-scene-qwen35-9b -f .\Modelfile
ollama list
```

`rp-scene-qwen35-9b` 是自己创建的本地别名，不是可假定能 `ollama pull` 的公开名称。代理每次传入运行参数；Modelfile 同样使用 21 GPU 层、6 线程、3072 输出 token 示例。改标签时同步修改代理和扩展的回退模型名。

## 启动与扩展配置

双击 `启动本地剧情LLM.cmd`，或运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-local-scene-llm.ps1
```

启动器先检查既有 Ollama，再确认模型存在，最后启动代理，不替换已有服务或自动下载模型。同端口代理配置不一致时会提示，不强停原进程。脚本使用相对路径和引用参数以支持中文、空格。

可选参数：`-NodePath`、`-OllamaPath`、`-ModelsPath`、`-ConfigPath`、`-LogDirectory`。对应环境变量为 `RP_SCENE_NODE`、`RP_SCENE_OLLAMA`、`RP_SCENE_MODELS`、`RP_SCENE_CONFIG`、`RP_SCENE_LOG_DIR`。未指定模型目录时保留既有 `OLLAMA_MODELS` 或 Ollama 默认目录；只有需要启动新 Ollama 时才应用模型目录。不要把本机值提交到仓库。

也可直接 `node local-scene-llm.mjs --config .\local-scene-config.json`。加 `--check-config` 只校验配置，不启动服务。

1. 确认 `http://127.0.0.1:11436/health` 返回 `ready`。
2. 扩展剧情 LLM 设置开启回退，地址 `http://127.0.0.1:11436/v1`，模型 `rp-scene-qwen35-9b`。
3. 主接口等待默认 60 秒，本地默认 180 秒；代理 `maxStageSeconds` 单独控制计算上限，插件不会自动修改它。

主接口始终优先，只补失败阶段，下一阶段重新优先主接口；取消会中止当前 HTTP 请求。本地结果也要校验，不合格不继续生图。云端密钥不发送给本地代理；代理只记录运行时间、token 和资源指标，不记录剧情或思考正文。

## 网络与资源

代理固定监听 `127.0.0.1`，Ollama 地址仅接受 HTTP 本机回环地址。默认来源为 `http://localhost:8000` 和 `http://127.0.0.1:8000`；酒馆端口不同需改 `allowedOrigins` 并重启代理。来源必须是完整 origin，不支持通配符。

手机的 `127.0.0.1` 指手机自身，本包不是手机远程接入方案。默认不开放公网监听；其他网络方案未在此版验证。

公开示例：21 GPU 层、6 线程、batch 32、16K 上下文、最多 3072 输出 token、temperature 0.3、`think: false`。开始前等待 GPU 空闲及 72℃以下，完成后等到 75℃以下；85℃、已用显存 5120 MiB、系统可用内存低于 1.5 GiB 时停止。CPU 温度未监测，其他程序影响余量。

`keep_alive: 0` 在返回前卸载模型，为后续图片任务留资源。超时、长度截断、无效结构、资源监测异常或姓名歧义会明确失败；不保证所有机器都能完成复杂场景。

## 测试与边界

在完整源码仓库执行 `npm ci --prefix tools/local-scene-llm`，再从根目录执行 `npm run test:local`。独立运行包不附带开发测试。测试覆盖阶段识别、姓名、JSON、取消与 CORS；模拟测试不等于所有剧情或硬件实测。

第三阶段适配器只替换指定编辑阶段的输出协议，其他阶段保持原协议。`abliterated` 是来源模型名称，不保证任何输入都成功、理解或输出准确；生成前仍需检查预览。
