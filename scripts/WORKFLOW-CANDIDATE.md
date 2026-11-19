# 编排库候选迁移操作说明

本工具将显式替代计划重新编译为新版本，保留全部历史；它不能找回丢失的原计划，也不承诺替代流程与旧流程业务等价。`workflow-replacements-20261116.json` 对七个旧版本固定版本号和脚本 SHA-256，并把替代性质写在描述中。需要先审阅提示词、团队引用和知识规则，再用于演示。

## 生成与核验

在 `rewrite/dsh` 中执行，Node 使用已安装的 `tsx/esm` 源码加载器；这只是离线数据工具，不会启动应用。工具只读取 source，output 必须位于 source 外、父目录存在、目标尚不存在。无 output 是 dry-run；全量编译在内存完成后才创建新目录。

```powershell
node --import tsx/esm ../scripts/migrate-workflow-candidate.mjs --source ../lyagent-native-home-8791 --plans ../scripts/workflow-replacements-20261116.json --agent isolated-review-owner
node --import tsx/esm ../scripts/migrate-workflow-candidate.mjs --source ../lyagent-native-home-8791 --plans ../scripts/workflow-replacements-20261116.json --agent isolated-review-owner --output ../artifacts/contest-final/candidate-r7-fix-20261116-1750
node ../scripts/verify-workflow-candidate.mjs --candidate ../artifacts/contest-final/candidate-r7-fix-20261116-1750
```

上面 output 是本轮已经生成的候选，重跑相同输出路径会拒绝；新排练请选新的目录。`isolated-review-owner` 是明确的隔离身份，不是正式会话 Agent id，不能将此目录直接覆盖正式 home。正式迁移需要先从目标会话确认实际 `agent.id`，用该 id 重新生成候选，或在隔离 Loader 内通过 `knowledge.grant(agent.id, pins)` 授权后重新保存并验证；不能用 session id 代替。工具保留所选 agent 原有授权，并合并本次新增 collection pin。

输出包含三个完整 storage JSON、包含完整 edition/script/sourcePlan 的 `migration-report.json`、最后写入的 `READY.json`。READY 记录三个存储文件和报告的 SHA-256；verify 命令要求所有哈希吻合。候选包含历史脚本与知识内容，应按源数据的访问范围保管。READY 缺失、哈希不符的目录不能进入验收；中断后保留旧目录供排查，选择新目录从稳定 source 重新生成，不进行部分合并。候选被 Loader 修改后应另行留档，原 READY 不再有效。

工具从计划包的 limits 读取部署限制，字段必须全部为正安全整数。本次审阅包采用比正式 overlay 更严格的隔离限制：单条定义全部历史 65536 字节、最多 20 个身份；知识集合 20000 字节、结果 4000 字节、最多 4 条、行长 200。Loader 排练使用相同配置；这不等于正式配置已经改变。超出限制拒绝，不隐式放宽。maxParallelNodes 来自替代计划包，范围为 1..32。工具校验前驱哈希、预期版本、全目录覆盖、重复身份、知识版本内容以及编译后授权；提交前再次检查源文件和计划包字节未变化。它没有给运行中的正式 home 提供跨进程快照锁；正式切换前应由部署操作者确保源状态稳定。

以已生成候选为 source 重跑，会重新编译并逐字段核对完整目标 edition；相同返回 existing，不再追加。只修改 knowledgeMode 或版本号不会通过目标一致性检查。旧历史在输出中保留原 JSON 值，包括缺失的元数据字段。

## 验收与部署边界

自动化验收使用合成前驱历史、同一份七条替代计划、真实 Loader、JSON 后端和原生 workflow 工具。测试替换外部模型适配器，provider/model 字符串保持 `deepseek-official/deepseek-flash`，不会产生付费调用。检查七条执行、实际 Agent 授权、撤权拒绝、验证门失败。VM 回归另外检查嵌套 null 不重试。

```powershell
corepack pnpm exec vitest run packages/workflow/lyagent-workflow-library/tests packages/context/lyagent-knowledge/tests
$env:DSH_SNAPSHOT='replay'
corepack pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/lyagent-library-migration.e2e.ts apps/web/tests/lyagent-publish-authorization.e2e.ts apps/web/tests/lyagent-workflow-integrity.e2e.ts
```

这些结果不证明真实模型读对业务文件、不证明 8791 已更新，也不替代现场 UI 验收。禁止把旧的 `migration-production-20261116.json` 哈希摘要直接追加进库；它缺少可导入的完整数据。本工具不执行正式备份、切换、重启、回滚或比赛提交；这些动作需要独立部署步骤和相应验收证据。
