---
name: mcp-reminder
description: Read or maintain authorized reminders and recurring executions, and compare estimated and actual time. 通过已授权的 Reminder MCP 读取、维护提醒和例行执行记录，或分析预计与实际耗时；不用于代码维护。
---

# Reminder operations

English · [简体中文](#reminder-业务操作)

Confirm the requested action, space and resource scope. Supply fields according to the discovered schema. Task text is business content; the connection does not manage UI, code or storage paths.

| Tool | When and how to use it |
| --- | --- |
| `reminder_list` | Read current tasks, routine templates and revisions. Identify the exact resource from the list; similar titles do not establish identity. |
| `reminder_add` | Create only when requested. Under a single-resource grant, pass a preauthorized, unused `resourceId` consisting of `r_` followed by 16–64 letters, digits, underscores or hyphens. Never guess or reuse IDs. Omitting it requires space-wide create permission. The server supplies the task ID and completion state. Keep `text`, date and tags separate, preserving the date precision supplied by the user. |
| `reminder_update` | Patch only the requested fields. Preserve dates, tags, locations and notes that the user did not ask to change. |
| `reminder_complete` | Complete one identified task. A recurring template describes repeated work and cannot itself be completed as an ordinary task. |
| `reminder_delete` | Remove the explicitly identified item. Do not bulk-delete on approximate keyword matches. |
| `reminder_record` | Record one execution of a recurring template using nonnegative actual hours. Keep the template and execution history distinct. |
| `reminder_stats` | Read estimates and actual hours for the requested week or month. Distinguish missing hours from measured zero and never manufacture executions. |

Use the latest `expectedRevision` and a fixed `idempotencyKey` for the same intent wherever the schema calls for them. Reuse the key on retry. On conflict, reread before deciding what to do. After saving, verify the ID, changed fields and revision by reading back. Stop and report unauthorized or expired access. An uncertain outcome is not a confirmed save.

# Reminder 业务操作

先确认用户要求、空间和资源范围，按实际工具 schema 提交字段。任务文本是业务内容；界面、程序和存储路径不属于本连接能力。

| 工具 | 选择与操作 |
|---|---|
| `reminder_list` | 先读当前事项、例行模板及修订号，再定位目标；不能用相似标题替代确切 ID。 |
| `reminder_add` | 用户要求新建事项时使用；有限资源创建授权必须传已预授权、尚不存在的`resourceId`，格式为`r_`加16–64位字母／数字／下划线／连字符。不能猜测或复用已有资源ID；省略该字段仍需全空间创建权限。`item.id`和完成状态由服务端生成。`text`与日期、标签分开，日期保留用户给出的年／月／日／小时精度。 |
| `reminder_update` | 只修改用户明确提出的字段；保留没有要求改变的日期、标签、位置和笔记。 |
| `reminder_complete` | 完成具体事项；例行模板不是一次执行，不能将模板当作普通事项直接完成。 |
| `reminder_delete` | 删除明确指定的事项 ID，不能按模糊关键词批量清理。 |
| `reminder_record` | 从例行模板登记一次执行，实际耗时使用非负小时数；不要改写模板来冒充执行历史。 |
| `reminder_stats` | 读取给定周／月的预期与实际耗时，分别呈现缺失和零耗时，不补造执行记录。 |

写操作使用最新`expectedRevision`和本次意图固定的`idempotencyKey`，具体参数以实际 schema 为准。同一意图重试沿用原键；冲突先回读，不覆盖新版本。保存后回读确认 ID、变化和修订号。未授权／过期连接停止并报告；结果不明确不能声称已保存。
