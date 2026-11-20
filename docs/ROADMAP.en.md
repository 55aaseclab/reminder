# Reminder roadmap

[简体中文](ROADMAP.md)

The current release includes standalone web and CLI access, recurring-work reporting and a resource-scoped managed adapter. Future updates should preserve import compatibility, concurrency checks, revocation and localized browsing.

## Praxis provider / 工作台供数

Publish the app-owned card and data-source contract. Verify synthetic authorized records, native links, stable revisions, empty/error separation and metadata resolution. Keep storage keys, business records and video provisioning outside this module.

发布由应用维护的卡片与数据源合同，使用合成授权记录验证原生入口、稳定版本、空态与错误区分及元数据解析。供数模块不接触密钥、真实业务记录或视频引擎安装。

## App-owned Praxis integration

This app owns its reviewed `praxis-integration.mjs`: native entry policy, typed business operations and MCP guidance where supported. Praxis loads that declaration from the installed source and retains authorization, signing, policy leases and audit. Installation does not grant access or start a backend. Existing native interfaces, data ownership and recovery boundaries remain in force.
