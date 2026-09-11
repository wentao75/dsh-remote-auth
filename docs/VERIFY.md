# 验证清单（VERIFY）

> 装到任意 `dsh web` 实例后逐条跑一遍。标 `预期` 的是正常值。

## 前提

- profile 已安装 `dsh-remote-auth`（`dsh.profile.bundles` 里有它）
- 已按需在 `cordis.patch.yml` 配好 `allowedAuthorities` / `allowedSubnets` / `pin`
- 下面用 `PIN=你的8位码`、`PORT=3080`、`LAN=192.168.x.x`、`TS=xxx.tailXXXX.ts.net`

## 1. 行已挂载

```sh
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/mobile-auth"
# 预期：401（无 PIN 时返回 PIN 表单页）或 200（未启用 PIN）
```

## 2. PIN 门禁（启用时）

```sh
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/mobile-auth?plain=1"            # 401 pin required
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/mobile-auth?plain=1&pin=Wrong"  # 401 bad pin
# 连错 5 次后正确 PIN 也应 429（锁 60s）
curl -s "http://127.0.0.1:$PORT/mobile-auth?plain=1&pin=$PIN"                                    # 200 纯文本 token URL
```

## 3. 授权链接 = 启动日志 token

拿上一步 URL 里的 token，与 `dsh web` 启动日志打印的 token 比对，应一致。

## 4. cookie 铸造与复用

```sh
TOK="http://127.0.0.1:$PORT/?token=<上面拿到的token>"
curl -s -i -c /tmp/ck.txt -o /dev/null "$TOK"        # 303 + Set-Cookie
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/ck.txt "http://127.0.0.1:$PORT/"   # 200 首页
# 重启 dsh 后再带同 cookie 访问 → 仍 200（cookie 不随重启失效）
```

## 5. 页面要素

```sh
PAGE=$(curl -s "http://127.0.0.1:$PORT/mobile-auth?pin=$PIN")
echo "$PAGE" | grep -c "在本设备打开授权链接"   # 1
echo "$PAGE" | grep -c "QR unavailable"         # 0（二维码真实生成）
echo "$PAGE" | grep -o 'width="[0-9]*px"'       # 有宽度
echo "$PAGE" | grep -c 'autofocus'              # 1（PIN 输入框聚焦）
echo "$PAGE" | grep -c "$PIN"                   # 0（页面绝不明码显示 PIN）
```

## 6. 门禁（OR 语义）

```sh
# Host 在名单内（从 Mac 自身 curl，源=回环恒放行）
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $TS:$PORT" "http://127.0.0.1:$PORT/mobile-auth?plain=1&pin=$PIN"   # 200
# 源 IP 在网段内、Host 随意（用 LAN IP 直连）
curl -s -o /dev/null -w '%{http_code}\n' "http://$LAN:$PORT/mobile-auth?plain=1&pin=$PIN"                              # 200
# 两表皆不满足 → 403（仅当能从"不在名单/网段"的来源测试时）
```

## 7. 远程全链路（每种要用的入口各一次）

```sh
for AUTH in "$LAN:$PORT" "$TS:$PORT" "Mac.local:$PORT"; do
  T=$(curl -s -H "Host: $AUTH" "http://127.0.0.1:$PORT/mobile-auth?plain=1&pin=$PIN")
  curl -s -c /tmp/ck-$AUTH.txt -o /dev/null "$T"          # 以该 authority 铸造
  curl -s -o /dev/null -w "$AUTH => %{http_code}\n" -b /tmp/ck-$AUTH.txt -H "Host: $AUTH" "http://127.0.0.1:$PORT/"
done
# 预期全部 200；换 authority 需各自授权一次（cookie 按 host:port 绑定）
```

## 8. 安全自检

- `GET /mobile-auth` 在**明文 HTTP 非回环来源**上可用 = polyfill 已由
  dsh-web-lan-access 注入（`curl -s http://127.0.0.1:$PORT/ | grep lan-access-polyfill`，
  需先带 cookie）
- 不打算公网暴露时，确认防火墙/路由器未把 3080 端口映射到公网
