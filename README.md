# LyAgent Demo 安装与运行说明

第五届"未来杯"创新大赛 · 赛题一
项目：LyAgent 多智能体编排与验证工作台　|　队伍：神神秘秘队（武昌首义学院）

本说明面向评审专家：按步骤操作即可在本机运行完整 Demo。**这是一个本地 Web 应用**，启动后在浏览器里访问本地地址即可使用；安装依赖与调用模型需要联网，模型请自备 DeepSeek API Key。

---

## 一、环境要求

| 项 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（x64）；macOS / Linux 命令相同 |
| Node.js | **≥ 24.9**（自带 `corepack`） |
| 磁盘 | 解压约 600 MB，安装依赖后约 1.5 GB |
| 内存 | 8 GB 以上 |
| 浏览器 | Chrome / Edge 最新版 |
| 网络 | 仅首次安装依赖与模型调用需要 |

---

## 二、安装与启动（两种方式，任选其一）

> **构建前提**：解压后的源码目录没有 `.git`，构建元数据需要 commit。`start-demo.ps1` 会自动初始化仓库并提交一次快照；手动方式（方式 B）请先执行一次 `git init` 并提交，否则 `build:artifacts` 会报 `git rev-parse HEAD` 失败。

### 方式 A：一键脚本（推荐）

1. 解压交付包 `lyagent-native-*.zip`，得到 `dsh/` 目录；
2. 把 `05-附件-Demo启动脚本与演示数据-v2.zip` 解压到 **`dsh/` 的上一级**，得到 `start-demo.ps1` 和 `seed/`（`seed/演示材料/` 是演示工作区的材料原件）；
3. 在该目录打开 PowerShell，执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-demo.ps1
```

脚本会依次：铺设演示数据 → 把演示材料铺到本目录 `demo-workspace/` 并把工作区指向它 → 安装依赖（首次约 3–6 分钟）→ 构建（首次约 2–4 分钟）→ 启动服务。

### 方式 B：手动命令（必须带覆盖层，否则只是原生 DSH 界面）

```sh
cd lyagent-native-*/dsh          # 解压出来的当前版目录（名字带时间戳，用通配进去即可）

# 1. 安装依赖
corepack pnpm install --frozen-lockfile

# 2. 构建（Windows PowerShell）
$env:DSH_CLIENT_TITLE='LyAgent'; $env:DSH_CLIENT_COMPETITION='true'; corepack pnpm run build:artifacts
#    macOS / Linux：
#    DSH_CLIENT_TITLE=LyAgent DSH_CLIENT_COMPETITION=true corepack pnpm run build:artifacts

# 3. 指定演示数据目录并启动（四个覆盖层缺一不可）
$env:DSH_HOME = (Join-Path (Get-Location) '..\demo-home')
$env:DSH_CLIENT_TITLE = 'LyAgent'
$env:DSH_CLIENT_COMPETITION = 'true'
node apps/cli/lib/bin.js --profile web `
  --patch lyagent.overlay.yml `
  --patch lyagent-orchestration.overlay.yml `
  --patch lyagent-knowledge.overlay.yml `
  --patch lyagent-tasks.overlay.yml `
  --port 8791
```

---

## 三、打开界面

启动成功后窗口会打印一行带 token 的地址：

```
dsh web: http://127.0.0.1:8791/?token=xxxxxxxx
```

**把整行复制到浏览器**（浏览器通常会自动打开）。注意：

- 必须带 `?token=...`，直接访问 `127.0.0.1:8791` 会提示 `authentication required`，这是安全设计；
- token 每次启动都会变化，以最新打印的为准；
- 停止服务：在该窗口按 `Ctrl+C`。

正常进入后应看到：左侧会话列表与工作区「cs1-预算演示」，中间对话区，右上角有「对话 / 轨迹 / 编队」三个页签。

**首次启动会弹出「配置模型开始使用」对话框**，这是正常现象：

- 只想浏览界面与流程库：点 **「稍后配置」** 即可关闭；
- 要真正运行流程：点 **「配置模型」**，填入 DeepSeek API Key（见第四节）。

---

## 四、模型配置（评委用自己的 Key）

本项目不绑定模型厂商，任何 **OpenAI 兼容** 的接口都能接。

1. 左下角「设置」→「模型」→「自定义 API」；
2. 填四项：**路由 id**（自定义，例如 `qwen`）、**协议**（OpenAI 兼容）、**baseURL**、**模型 id**（例如 `qwen-max`）、**API Key**；
3. 保存后回到对话页，在模型下拉里选刚加的模型。

### 用非 DeepSeek 模型时（默认已经不需要额外操作）

演示角色的 `provider`/`model` 已置空，含义是**继承你在界面里所选的那个模型**：配置好任意供应商与模型后，流程直接可用，不需要改代码、不需要敲命令。

只有想把流程**固定**到某个路由/模型时才用得到下面这个可选脚本（普通演示请忽略）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .
epoint-demo.ps1 -Provider <路由id> -Model <模型id>
```

（脚本只改流程与角色里的 `provider`/`model` 字段，知识正文不动、摘要随脚本重算；上次的 pin 记在 `demo-home/storages/.repoint-state.json`，可反复切换。）

**未配置模型时**：界面可浏览、可看流程库，但发送按钮是禁用的（提示"请选择模型"），命令发不出去。

**实测记录（智谱 GLM-4.6）**：按上面的方式接入自定义供应商并把流程指向 `glm` / `glm-4.6` 后，`demo-knowledge 3` 与 `demo-selfloop3 1` 均返回 `completed`，模型能逐字引用规则原文并判定资产编号。两点注意：

1. 自定义供应商**不要**在默认模型里设 `reasoningEffort`（GLM 不支持，会报 `UNSUPPORTED_REASONING_EFFORT`）；
2. 换模型后必须先用 `repoint-demo.ps1` 改写流程，否则会报 `pi-ai provider "glm" has no configured model "…"`。

---

## 五、五分钟演示动线（零命令，点按钮即可）

演示数据里已经预置好角色、团队、流程与知识集合，**不需要输入任何命令，也不需要开终端**。

> 先看工作区里的 **`00-演示任务说明.md`**：里面写了这次要做的事、三份材料、规则与验收标准（合计 494 元、押金不计入），以及预期结果的对照表。演示库只保留 4 条场景流程（报账主线 / 报账返工 / 知识库判定 / 会议纪要转行动项），平台自测用的探针流程不在演示库里。

### 主线任务：社团迎新活动预算表（约 2–4 分钟）

1. 左侧工作区选 **「cs1-预算演示」**，新建一个会话；
2. 打开右侧「编排」→「流程」页签，选中 **`cs1-budget`**（描述：三份材料并行读 → 汇总预算表 → 校验合计与出处 → 报账说明落盘）；
3. 点 **「运行所选版本」**。面板会先替本会话授予该流程挂载的知识集合 `cs1-rules`，然后开始跑；
4. 看三处：
   - 会话头部「**编队**」页签：三个读料员同层提交，前两个先跑、第三个排队（运行时子代理槽位上限 2）→ 汇总员（产出预算表 + 报账说明）→ 校验；
   - 右侧「编排」→「流程」页签：`cs1-budget` 的节点结构与挂载的知识集合；
   - 会话里的 `saved_workflow` 结果卡：各节点返回值与最终预算表；
5. 结果：预算表 6 列（项目 / 类别 / 单价 / 数量 / 小计 / 出处材料），**合计 494 元**（低于规定上限 500 元）。内容出现在会话的 `saved_workflow` 结果卡里，并由系统自动留档到工作区 `demo-workspace/workflows/cs1-budget-*.json`（**只有成功的运行才写留档**；失败的运行不写文件，回执里返回 `record: { skipped: "the run failed" }`）；委派角色只有只读工具，所以不写工作区文件，这是设计如此。

**494 元不是写死的答案，是校验节点检查的对象**：材料里的可退押金 100 元不计入活动开支，汇总员若算成 594 元，校验节点会判不合格、把原因回填给汇总员重做一次，第二版才对——这一来一回演示的就是「结果验证 + 自我循环」。

### 分项能力怎么看

| 能力 | 怎么看 |
| --- | --- |
| 知识库定义与集成 | `cs1-rules` 的「单次活动预算上限 500 元」在编译期被内联进汇总员提示词，不是代码里的常量 |
| Agent 团队定义 | 「编排」→「角色 / 团队」：`cs1-reader` / `cs1-writer` / `cs1-brief` 三个角色与 `cs1-team` 编排 |
| 工作流编排 | 「编排」→「流程」：`cs1-budget` 的 DAG（三读并行 → 汇总 → 校验 → 落盘） |
| 动态调度 | 三个读料节点同层提交，有界池上限设为 2（与运行时子代理槽位一致）：两个并行、第三个等空位；编队页签能看到排队与开跑 |
| 自我循环 | 校验失败 → 返工指定节点重做，最多 2 轮 |
| 结果验证与反馈 | 校验节点断言「必含 `合计`/`494`/`未超` 三个短语，且**合计行本身**要匹配 `合计.*494`（错误合计另有数字时不通过）、原文字符数 ≥420」；不合格原因回灌给被返工的节点。断言是文本级、不做算术校验 |

### 可选：现场看一次真实的返工

流程 `cs1-budget-rework`（同一套角色/团队/知识，独立一行）把验收门里的最小长度改成 1200 个字符（按**原文**字符数计，不是 JSON 长度）：按简洁口径写通常只有约 600 字，**大概率被拦下**，失败原因回填给汇总员，它补足细节后重交才通过。注意这只是演示用的门槛，**不保证首轮一定被拦**——首版写得够长就会直接通过。想看「验证 → 失败 → 返工 → 通过」这条回路时跑它；不想讲就忽略，主线 `cs1-budget` 不受影响。

### 其他预置流程（开发者自测用，需命令）

`demo-knowledge` / `demo-selfloop3` / `demo-schedule` / `demo-verify` / `demo-team` 仍在库里，命令行形式 `/saved-workflow run <流程名> <版本号>` —— 第二个参数是**版本号**，不是并发数。

运行留档位置：`demo-workspace/workflows/*.json`（每次运行一份，失败的运行会明确标注）。

---

## 六、常见问题

| 现象 | 处理 |
| --- | --- |
| `authentication required` | 地址缺 `?token=`，用窗口打印的完整地址 |
| 端口被占用 | 换端口：`--port 8792`，或先关掉占用进程 |
| Node 版本报错 | 升级到 Node ≥ 24.9，`node -v` 确认 |
| 页面一直"正在装载编排器…" | 构建未完成：删掉 `dsh/node_modules` 与 `dsh/packages/*/*/lib` 后重跑 |
| 运行流程提示"知识访问被撤销" | 打开或运行流程都会为当前会话补授它声明的知识集合（撤权只中止进行中的运行）；若仍提示，通常是该会话被 `/knowledge revoke` 清过授权，再点一次运行即可 |
| 想从空库开始 | 删除 `demo-home/` 目录后重新启动 |

---

## 七、目录说明

| 路径 | 内容 |
| --- | --- |
| `dsh/` | 项目源码与构建脚本 |
| `demo-home/storages/` | 演示用流程库、知识库、团队库与工作区（由启动脚本铺设） |
| `demo-workspace/` | 演示工作区：三份材料 + 每次运行的留档 `workflows/` |
| `seed/演示材料/` | 演示材料原件（启动脚本会复制到 `demo-workspace/`） |
| `demo-home/workflows/` | 每次运行的留档 JSON |
| `seed/storages/` | 演示数据原始副本（重新铺设时使用） |
