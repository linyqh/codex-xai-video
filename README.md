# codex-xai-video

[Codex](https://developers.openai.com/codex) 插件：给 Codex 增加一个 `xai_generate_video` 工具，用 xAI Grok Imagine 根据文字或图片生成短视频并保存成 MP4。

由 [omp-xai-video](https://github.com/linyqh/omp-xai-video) 移植而来，xAI 调用逻辑（提交、轮询、下载、防重复扣费）完全一致；区别只在宿主接入方式：这里是一个零依赖的本地 stdio MCP 服务，通过 Codex 插件市场安装。

## 功能

- **文生视频 / 图生视频**：只给 `prompt` 是文生视频；再给 `image` 就把这张图当作第一帧做动画。
- **可指向自己的服务地址**：在 `~/.codex/xai-video.json` 配置 `baseUrl`，视频请求就发到你的中转或代理服务。
- **防止重复扣费**：xAI 接受任务之后，无论轮询失败、任务失败、下载失败、写文件失败还是你手动取消，都只报告任务 ID（有视频地址时一并给出），绝不自动重新提交。
- **轮询容错**：网络错误、408/429/5xx、响应体损坏都算临时故障，连续 6 次才放弃；遇到 401 会重新取 key 后继续查询同一个任务。
- **进度回报**：Codex 中可以看到 `xAI job … submitted` / `pending (35s)` 之类的进度。

## 前置条件

- Codex CLI 或 ChatGPT 桌面版里的 Codex（已在 codex-cli 0.165 验证）
- Node.js 20+：优先使用 Codex 自带的 Node，找不到时用 `PATH` 里的 `node`
- 一份 xAI API key，或者你自己的 xAI 兼容视频服务

插件已附带打包好的 `plugins/xai-video/dist/server.mjs`，安装时不需要 `npm install`。

## 一键安装

```bash
codex plugin marketplace add git@github.com:linyqh/codex-xai-video.git && codex plugin add xai-video@codex-xai-video
```

装完后新开一个 Codex 会话即可使用（已在运行的会话不会加载新插件）。然后按下文「配置凭据」设置 xAI key。

- 这是私有仓库，安装走 SSH，需要本机 `ssh -T git@github.com` 能通过。不要把 GitHub token 拼进安装地址，Codex 会把地址原样写进 `~/.codex/config.toml`。
- 只装了 ChatGPT 桌面版、终端里没有 `codex` 命令时，用桌面版自带的 CLI：

  ```bash
  CODEX=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
  "$CODEX" plugin marketplace add git@github.com:linyqh/codex-xai-video.git && "$CODEX" plugin add xai-video@codex-xai-video
  ```

### 让 ChatGPT 桌面版帮你装

在 ChatGPT 桌面版里打开 Codex，新建一个任务，把下面整段发给它。它运行命令时会请求权限（要联网、要写 `~/.codex`），批准即可：

````text
请帮我安装 Codex 插件 xai-video，仓库是 git@github.com:linyqh/codex-xai-video.git。按顺序执行，需要联网或写入 ~/.codex 时直接向我申请权限：

1. 确定 codex 命令：先用 `command -v codex`，找不到就用 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex。下面用 CODEX 指代它。
2. 运行 `ssh -T git@github.com`。输出里有 "successfully authenticated" 就继续（这条命令即使成功也会返回退出码 1）；否则停下，告诉我需要先配置 GitHub 的 SSH key。
3. 运行 `CODEX plugin marketplace add git@github.com:linyqh/codex-xai-video.git`。如果提示这个市场已经存在，改为运行 `CODEX plugin marketplace upgrade codex-xai-video`。
4. 运行 `CODEX plugin add xai-video@codex-xai-video`。
5. 运行 `CODEX plugin list`，确认 xai-video@codex-xai-video 的状态是 installed, enabled。
6. 检查 ~/.codex/xai-video.json 是否存在，只看是否存在，不要读取或打印它的内容。不存在的话，不要让我在对话里发 API key，而是告诉我两种配置方式：在终端执行 export XAI_API_KEY="xai-..."，或者自己创建 ~/.codex/xai-video.json，内容为 {"apiKey": "xai-..."}，然后执行 chmod 600 ~/.codex/xai-video.json。
7. 最后提醒我：要新开一个 Codex 任务，才能用上 xai_generate_video 工具。
````

常用管理命令：

| 用途 | 命令 |
|---|---|
| 安装指定版本 | `codex plugin marketplace add git@github.com:linyqh/codex-xai-video.git --ref v0.1.0`，再 `codex plugin add xai-video@codex-xai-video` |
| 更新 | `codex plugin marketplace upgrade codex-xai-video && codex plugin add xai-video@codex-xai-video` |
| 查看状态 | `codex plugin list` |
| 卸载 | `codex plugin remove xai-video@codex-xai-video && codex plugin marketplace remove codex-xai-video` |

## 配置凭据

插件按下面的顺序查找凭据，用找到的第一个：

1. `~/.codex/xai-video.json`（设置了 `CODEX_HOME` 时为 `$CODEX_HOME/xai-video.json`）里的 `apiKey`
2. 环境变量 `XAI_API_KEY`，请求官方地址 `https://api.x.ai/v1`

都没有时工具直接返回错误，不会发出任何请求。

### 方式一：环境变量

```bash
export XAI_API_KEY="xai-..."
```

Codex 只会把白名单里的环境变量传给 MCP 服务，本插件已声明 `XAI_API_KEY`。注意从程序坞启动的桌面版 Codex 不一定能读到 `~/.zshrc` 里的变量；这种情况请用方式二。

### 方式二：配置文件（可自定义地址）

`~/.codex/xai-video.json`：

```json
{
  "baseUrl": "https://relay.example.com/v1",
  "apiKey": "xai-xxxxxxxx"
}
```

| 字段 | 说明 |
|---|---|
| `baseUrl` | 可省略，省略时用 `https://api.x.ai/v1` |
| `apiKey` | 直接写 key；以 `!` 开头时执行这条命令并取其输出作为 key，例如 `"!op read op://dev/xai/key"`。遇到 401 时会重新执行命令取新 key |

- 文件里没有 `apiKey` 时会被跳过，改用 `XAI_API_KEY` 请求官方地址。结果里会写明用的是哪个来源，比如 `xai-video/grok-imagine-video` 或 `xai/grok-imagine-video`。
- 每次调用工具都会重新读取这个文件，修改后不需要重启 Codex。
- 建议 `chmod 600 ~/.codex/xai-video.json`。

### 自定义服务需要实现的接口

| 请求 | 用途 | 关键字段 |
|---|---|---|
| `POST {baseUrl}/videos/generations` | 提交任务 | 请求体：`model`、`prompt`、`duration`、`aspect_ratio`、`resolution`、`image.url`；响应：`request_id` |
| `GET {baseUrl}/videos/{request_id}` | 查询进度 | `status` 取值 `pending` / `done` / `failed` / `expired`；完成时 `video.url`；可选 `usage.cost_in_usd_ticks`（单位 1e-10 美元） |
| `GET {video.url}` | 下载视频 | 视频文件本身 |

所有请求都带 `Authorization: Bearer <key>`。`video.url` 可以是相对路径（如 `files/abc.mp4`），这时会带着 key 到你服务的同一域名下下载；如果是其他域名的完整地址（比如 xAI 的 CDN 预签名链接），下载时不带 key。

## 使用

在 Codex 会话里直接描述你要的视频：

```
生成一段 5 秒的视频：一只橘猫在窗台上伸懒腰，镜头缓慢推近，720p，16:9，保存到 videos/cat.mp4
```

```
把 ./assets/logo.png 做成一段 3 秒的动画：logo 从中心淡入并轻微旋转
```

非交互方式：

```bash
codex exec "用 xai_generate_video 生成一段 2 秒 480p 的视频：红色小球在木地板上弹跳"
```

工具参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | 是 | 画面内容、动作、镜头运动 |
| `image` | 否 | 第一帧图片：https 地址、data URL，或本地 PNG / JPEG / WebP 的绝对路径（本地文件会转成 data URL 上传） |
| `duration` | 否 | 时长，整数秒，1–15；不填用服务端默认值 |
| `aspect_ratio` | 否 | `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`3:2`、`2:3` |
| `resolution` | 否 | `480p`、`720p`、`1080p` |
| `model` | 否 | 默认 `grok-imagine-video` |
| `output_path` | 是 | MP4 保存位置，必须是绝对路径或以 `~/` 开头，会自动创建父目录 |

在 xAI 上，1080p 只支持图生视频，并且只能用 `grok-imagine-video-1.5`。如果没有指定 `model`：传了图片时会自动切换到这个模型；没传图片时直接拒绝，不提交任务。

Codex 从插件目录启动 MCP 服务，并且不会把会话的工作目录告诉服务，所以本地路径必须是绝对路径。你照常说"保存到 videos/cat.mp4"即可，Codex 会自己换算成绝对路径；传相对路径时工具会直接拒绝，不提交任务。

MCP 服务不在 Codex 的沙箱里运行，所以即使会话是只读沙箱，视频也能写入。

每次调用都会产生费用，Codex 默认会在调用前请求你批准；`codex exec` 这类无法弹出确认的非交互模式下，需要用 `--dangerously-bypass-approvals-and-sandbox` 等方式放行，否则调用会被拒绝。

## 计费与失败处理

| 情况 | 是否扣费 | 插件的处理 |
|---|---|---|
| 参数不合法、图片读不了、`output_path` 是目录、没有凭据 | 不扣费 | 提交前就拒绝 |
| xAI 拒绝提交（如 400、key 无效） | 不扣费 | 返回 xAI 给出的原因 |
| 已经提交后出错（轮询失败、任务失败、超过 20 分钟、下载或写文件失败、你取消了） | 可能已扣费 | 返回任务 ID 和视频地址（有的话），不重新提交 |

工具超时设为 30 分钟（`tool_timeout_sec: 1800`），大于插件自身 20 分钟的轮询上限，避免 Codex 先超时而丢掉任务 ID。

## 开发

需要 [Bun](https://bun.sh)。

```bash
bun install          # 安装开发依赖（类型定义、TypeScript）
bun test             # 单元测试：用模拟的 xAI 接口验证扣费安全和凭据解析
bun run check        # 类型检查
bun run build        # 打包到 plugins/xai-video/dist/server.mjs（改完源码必须重新打包并提交）
```

本地调试：`codex plugin marketplace add .` 后 `codex plugin add xai-video@codex-xai-video`；改代码后重新 build 并再次 `codex plugin add` 刷新缓存。

目录结构：

```
.agents/plugins/marketplace.json     # 插件市场清单
plugins/xai-video/
  .codex-plugin/plugin.json          # 插件清单
  .mcp.json                          # MCP 服务声明（环境变量白名单、超时）
  scripts/launch-mcp                 # 查找 Node 并启动服务
  dist/server.mjs                    # 打包产物（提交到仓库）
src/
  server.ts                          # stdio MCP 协议：initialize / tools/list / tools/call / 取消 / 进度
  tool.ts                            # 工具定义、参数校验、图片与输出路径处理
  credentials.ts                     # 凭据解析
  xai.ts                             # xAI 视频接口：提交、轮询、下载，以及失败处理
test/
```

发布新版本：同步修改 `package.json`、`plugins/xai-video/.codex-plugin/plugin.json` 和 `src/server.ts` 里的版本号，`bun run build`，提交后打上 `vX.Y.Z` 标签并推送。
