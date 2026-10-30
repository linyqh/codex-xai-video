# 安装步骤（给 Codex 执行）

本仓库是公开仓库，全程走 HTTPS，不需要 SSH key 或 GitHub 登录。不要使用 `git@github.com:` 地址，也不要运行 `ssh -T git@github.com`。

需要联网或写入 `~/.codex` 时，直接向用户申请权限。

1. 确定 codex 命令：先用 `command -v codex`，找不到就用 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`。下面用 `CODEX` 指代它。
2. 添加插件市场：

   ```bash
   CODEX plugin marketplace add https://github.com/linyqh/codex-xai-video.git
   ```

   如果提示市场 `codex-xai-video` 已存在，改为运行 `CODEX plugin marketplace upgrade codex-xai-video`。如果 upgrade 失败（例如之前用 SSH 地址添加过），先运行 `CODEX plugin marketplace remove codex-xai-video`，再重新执行上面的 add。
3. 安装插件：`CODEX plugin add xai-video@codex-xai-video`。
4. 运行 `CODEX plugin list`，确认 `xai-video@codex-xai-video` 的状态是 installed, enabled。
5. 检查 `~/.codex/xai-video.json` 是否存在（设置了 `CODEX_HOME` 时为 `$CODEX_HOME/xai-video.json`）。只看是否存在，不要读取或打印内容。不存在时，不要让用户在对话里发 API key，而是告诉用户两种配置方式：
   - 在终端执行 `export XAI_API_KEY="xai-..."`；
   - 或自己创建 `~/.codex/xai-video.json`，内容为 `{"apiKey": "xai-..."}`，然后执行 `chmod 600 ~/.codex/xai-video.json`。
6. 最后提醒用户：要新开一个 Codex 任务，才能用上 `xai_generate_video` 工具。

任何一步失败时停下，把完整报错原样告诉用户，不要尝试改用 SSH 地址。
