# dsh-remote-auth

> DSH 远程授权页：**点一下链接或扫一下二维码**，设备即可获得当前 `dsh web`
> 进程的浏览器会话——再也不用翻 `~/.dsh/logs/` 找 token。
>
> One click or one QR scan mints the current process's browser-session URL for
> DeepSeek Harness (`dsh web`). No more digging the launch token out of server logs.

[![license](https://img.shields.io/npm/l/dsh-remote-auth)](#license)
[![npm version](https://img.shields.io/npm/v/dsh-remote-auth)](https://www.npmjs.com/package/dsh-remote-auth)
[![npm downloads](https://img.shields.io/npm/dm/dsh-remote-auth)](https://www.npmjs.com/package/dsh-remote-auth)

## 为什么需要它

`dsh web` 用"每次进程启动随机生成"的 launch token 授权浏览器：
访问 `/?token=...` 后换取 30 天签名 cookie。本机浏览器启动时自动打开没问题，
但 **iPad / iPhone / 其他电脑**（经 Tailscale 或家庭 Wi-Fi）要访问时，只能去
服务器日志里翻带 token 的 URL——麻烦且易错。

本插件在 webserver 上挂一个公开路由 `GET /mobile-auth`：设备打开后输入 PIN
（可选），页面给出**当前进程、且与访问所用 authority 一致**的授权链接 +
二维码；点击/扫码即铸造 cookie。cookie 由持久化签名密钥签发（
`~/.dsh/.credentials.yaml`），**重启 dsh 不会踢掉已授权设备**，每 30 天
刷新一次即可。

## 安装

```sh
dsh plugin --profile web add dsh-remote-auth -w
# 重启 dsh web 生效（GUI 会短暂断连后自动恢复）：
launchctl kickstart -k gui/501/com.dsh.web        # macOS launchd
# 或直接：dsh --profile web
```

安装后从任意授权设备打开：

- 局域网：`http://<Mac-name>.local:3080/mobile-auth`
- Tailscale：`http://<host>.tailXXXX.ts.net:3080/mobile-auth`
- 本机：`http://127.0.0.1:3080/mobile-auth`（回环访问额外显示当前 PIN）

输入 PIN（若启用）→ 点"在本设备打开授权链接"（或让另一台设备扫二维码）。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖行配置：

```yaml
- id: dsh-remote-auth
  config:
    # Host 头白名单：裸主机名（任意端口）或精确 host:port。回环恒放行。
    allowedAuthorities:
      - myhost
      - myhost.tailXXXX.ts.net
    # 源 IP 网段白名单（CIDR）。回环恒放行。
    allowedSubnets:
      - 100.64.0.0/10      # Tailscale
      - 192.168.0.0/16     # 家庭内网
    # 8 位字母数字 PIN；"" = 关闭 PIN 门禁（不推荐公网使用）。
    pin: ""
    # 当服务位于 TLS 反向代理之后时设为 "https"。
    originProtocol: "http"
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `allowedAuthorities` | `[]` | Host 头名单（bare host 匹配任意端口） |
| `allowedSubnets` | `[]` | 源 IP CIDR 名单 |
| `pin` | `""` | PIN 门禁；连错 5 次锁 60 秒（按源 IP） |
| `lockAfterFails` | `5` | 锁定阈值 |
| `lockSeconds` | `60` | 锁定秒数 |
| `originProtocol` | `"http"` | 反代启用 TLS 后改为 `"https"` |

### 访问门禁（安全模型）

**OR 语义**：`Host ∈ allowedAuthorities` **或** 源 IP ∈ `allowedSubnets`
即放行；回环恒放行；两表皆空 = 仅回环（fail closed）。因此：

- 想按"名字"访问 → 写 `allowedAuthorities`（ts.net 域名 / mDNS 名）；
- 想按"网段"放行（裸 IP 访问、整段 Tailscale/内网）→ 写 `allowedSubnets`。

`/mobile-auth` 是 webserver 公开路由（不在 `/api` cookie 门禁之下），它自己
的围栏 + PIN 就是防线。页面给出的授权 URL 由官方扩展点
`ctx.connection.authenticatedUrl(请求origin)` 生成——与设备当前使用的
authority 一致，cookie 才能正确落到该 authority（cookie 按 host:port 绑定，
LAN IP 与 ts.net 域名是两张独立 cookie，需各自授权一次）。

## 兼容性

- 依赖内核扩展点：`ctx.webServer.register`（`dsh-host-webserver`）与
  `ctx.connection.authenticatedUrl`（`dsh-client-connection`）。
- 已在 `dsh 0.1.2-rc.1` 验证；新内核升级后请运行 `docs/VERIFY.md` 清单。
- 明文 HTTP 环境（局域网/Tailscale IP）需要 `crypto.randomUUID` polyfill——
  配合 [dsh-web-lan-access](https://www.npmjs.com/package/dsh-web-lan-access)
  可自动注入（本插件不重复实现）。

## 开发

```sh
npm run check    # 语法自检
```

第三方代码：`lib/qrcode.cjs` 为 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(MIT, Kazuhiko Arase) 的 vendored 单文件。**勿改成 `.js`**——本包
`"type": "module"`，`.js` 会被按 ESM 加载导致 UMD 导出成空对象、二维码空白。

## License

MIT © 2026 dsh-remote-auth contributors（`lib/qrcode.cjs` 保留原作者版权头）
