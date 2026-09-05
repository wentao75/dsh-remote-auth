# 发布与收录清单（PUBLISH checklist）

> 目标：把 `dsh-remote-auth` 发布为**社区正式插件**——可 `dsh plugin add`，
> 可被 dshmarket / awesome-dsh-plugin / dsh-find-plugin 发现。
> （"DeepSeek 官方 @deepseek-ai scope"需组织渠道，个人走社区路径。）

## A. 发布前（代码与包）

- [ ] `package.json`：`name` 唯一（npm 404 已验证 `dsh-remote-auth`）、
      `private: false`、`repository`/`homepage`/`bugs` 填真实地址
- [ ] LICENSE 版权行改成你的名字（现为 contributors 占位）
- [ ] README 截图/录屏（授权页、扫码流程）
- [ ] `npm run check` 通过（`node --check lib/*.js|.cjs`）
- [ ] `npm pack --dry-run` 确认发布内容只含 `lib/`、`cordis.patch.yml`、
      `README.md`、`LICENSE`、`package.json`（files 白名单已配）
- [ ] 第三方许可合规：`lib/qrcode.cjs` 为 MIT（文件头保留）——README 已注明

## B. 发布（npm）

- [ ] `npm login`
- [ ] 版本语义：首个 0.1.0；破坏性/兼容性变化遵循 semver
- [ ] `npm publish`（prepublish 钩子先跑 check）
- [ ] 发布后 `npm view dsh-remote-auth` 核对

## C. 从 registry 自测（关键，别只测本地 file:）

- [ ] 新开/测试 profile 安装：`dsh plugin --profile web add dsh-remote-auth -w`
      （注意：先移除本地同名 `file:` 依赖，避免包管理器冲突）
- [ ] 重启后跑 `docs/VERIFY.md` 全套
- [ ] 确认 `dsh.profile.bundles` 自动追加、`/mobile-auth` 行为与本地一致
- [ ] 卸载干净：`dsh plugin --profile web remove dsh-remote-auth -w`

## D. GitHub 仓库（公开）

- [ ] 代码已提交、默认分支为 `main`
- [ ] Topics（仓库设置里添加，聚合器按此抓取）：
      `dsh-plugin`、`deepseek-harness`、`dsh`、`mobile`、`remote-access`
- [ ] README 带安装命令与截图；有 Issues 模板更好
- [ ] Release 打 tag（v0.1.0），附 changelog 与 tarball 校验

## E. 市场收录

- [ ] awesome-dsh-plugin：仓库若在 GitHub topic `dsh-plugin` 下会被聚合；
      未自动收录时向
      [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
      提收录 PR（附分类建议：`remote` / `ui`）
- [ ] dshmarket（GUI 内市场）：其快照来自 awesome-dsh-plugin registry，
      收录后下个快照周期可见
- [ ] dsh-find-plugin / @1e0zj/dsh-plugin-mall（实时 GitHub topic 搜索）：
      只要 topic 正确即可搜到，无需额外操作
- [ ] npm keywords 已含 `dsh-plugin` + `deepseek-harness`（npm/市场搜索用）

## F. 维护（发布后）

- [ ] 每个 dsh 内核大版本升级后，跑一遍 `docs/VERIFY.md` 并在 README
      "兼容性"标注验证过的版本
- [ ] 保持零运行时依赖（vendored qrcode）；引入依赖需过 supply-chain 校验
- [ ] 响应 issue；破坏性改动升大版本
