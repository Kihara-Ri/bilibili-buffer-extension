# 内容 API · v1 · Claude Code 接入说明

启动方式见 [README.md](README.md)。基础地址 `http://localhost:8765`，除媒体流外均为 JSON，请求 POST 即使无参数也发送 `{}`。根路径和 `/health` 返回服务信息，不返回网页。

## 已实现接口

| 方法 | 路径 | 请求 / 含义 |
| --- | --- | --- |
| GET | `/health` | 健康状态、独立服务版本 |
| POST | `/v1/videos/resolve` | `{"url":"https://www.bilibili.com/video/BV1TUno6bEwA/?p=1"}` 或 BV 号；解析全部分 P，选中指定 P，不改变稍后再看 |
| GET | `/v1/content/{id}` | 内容事实、sources、evidence、revision、fingerprint |
| POST | `/v1/content/{id}/subtitles` | `{}`；为此分 P 获取字幕，需后台登录 |
| GET | `/v1/login/status` | 实时登录检查，`auth_required` / `connected` |
| POST | `/v1/login/qr` | `{}`；创建本浏览器的 QR 登录尝试 |
| GET | `/v1/login/qr/{attempt_id}` | 轮询该浏览器的登录尝试 |
| POST | `/v1/login/logout` | `{}`；清除本机登录态与全部旧播放计划，不撤销 B 站其他设备登录 |
| POST | `/v1/watchlater/sync` | `{"page_size":20,"max_pages":20}`；需后台登录，完整分页成功才替换本机队列 |
| GET | `/v1/queue` | 已同步的稍后再看分 P 数组；首次为空数组 |
| GET | `/v1/queue/{id}` | 单个队列项 |
| GET | `/v1/account-status` | 本地账号及上次同步快照；不是实时登录状态 |
| POST | `/v1/subtitles/collect` | `{"limit":5,"force":false}`；队列批量字幕，返回 `{"results":[...]}` |
| POST | `/v1/playback` | `{"work_id":"BV1TUno6bEwA","quality":32}`；创建短期播放计划 |
| GET / HEAD | `/v1/media/{token}` | MP4 流；支持单一 `Range: bytes=...` 和 206，HEAD 无响应体 |
| POST | `/v1/rules` | `{"scope":"work","target":"BV1TUno6bEwA","blocked":true}`；scope 也可为 creator |
| POST | `/v1/captures` | 离线导入规范化完整列表或字幕，供受信任采集程序；格式由 library.import_capture 校验 |

## 前端最小接入流程

1. POST videos/resolve，保存 `selected_id` 和 `parts`。结果包含 bvid、title、creator_id/name；每个 part 包含 id、cid、page、part_title、duration_seconds、revision。
2. GET content/{id} 获取事实；若需文字，先登录、POST content/{id}/subtitles，再重新读取 content。`evidence` 中 kind=transcript；coverage=full 为聚合时间戳文本，coverage=excerpt 为单段文本与起止时间，可供 Claude 后续处理。
3. 若需要看视频，POST playback，将返回的相对 `url` 按 API 基础地址解析后交给前端播放器。切换分 P 必须使用对应的 work_id；单 P 通常是 BV 号，多 P 是 `BV...:pN`。路径参数用 encodeURIComponent。
4. 同步稍后再看需登录后主动 POST watchlater/sync，随后 GET queue。同步不调用播放、点赞或观看进度上报。

播放计划还返回 id、bvid、cid、format、content_type、quality、requested_quality、access、duration_seconds、expires_at。quality 表示上游实际质量，不能拿请求值标清晰度；access 为 anonymous/account。计划最多保留 10 分钟，且不能超过上游签名有效期，重启即失效。收到 410 时重新 POST playback，由前端恢复自己的进度。只支持单段 MP4；DASH、多段 MP4 返回 422，不冒充兼容。

字幕返回状态 ready/no_subtitle/subtitle_locked；队列尚未采集为 not_fetched。没有字幕时当前版本不执行 ASR。AI 字幕标记 machine_generated=true，普通上传字幕为 null，不能推断其人工生成。revision/fingerprint 表示实际内容事实版本，便于前端或摘要缓存失效。

## QR、Cookie 与本地跨域

前端自行把 start 返回的 `url` 编码为二维码。start 返回 attempt_id、url、expires_at（Unix 秒）、poll_after_seconds、status。至少按 poll_after_seconds（目前 2 秒）间隔轮询；状态为 waiting_scan、waiting_confirmation、connected、expired。180 秒过期后新建尝试。

所有前端 fetch 使用 `credentials: "include"`；服务以 HttpOnly 的 bd_client Cookie 绑定本浏览器的登录尝试。B 站 Cookie 只保存于服务的私有文件，响应不会返回 Cookie 或 refresh_token。登录 URL 本身含临时凭证，前端也不要写日志。

开发时 `--allow-origin http://localhost:5173` 精确放行 Origin；API 和前端都用 localhost（或都用 127.0.0.1），避免 SameSite Cookie 因混用主机名而丢失。禁止通配 CORS。服务仍只绑定回环地址。现已在 rasp5remote 通过 Nginx 部署到 `https://bilibili.kihara.cn`，使用正式 TLS 和独立站点认证，详见 [部署说明](deploy/README.md)。生产启动显式传入 `--allow-origin https://bilibili.kihara.cn`，登录尝试 Cookie 带 Secure。

## 错误与边界

错误统一为 `{"error":{"code":"auth_required","message":"...","retryable":false}}`。常见 HTTP：400 参数错误、401 未登录、403 屏蔽或源拒绝、404 内容/尝试不存在、409 内容身份变化或登录态写入失败、410 播放计划失效、416 Range 错误、422 媒体不支持、429 风控/轮询过快、502 上游或网络异常。不得将异常显示为空列表或“没有字幕”；按 code 提示并允许用户明确重试。

本服务不包含历史、收藏夹、关注列表、推送、推荐、AI 摘要、UI 或控件；也不读取扩展现有缓存。扩展与此服务暂为同仓独立运行，扩展安装不会自动启动 Python。真实 QR 确认登录及 iPhone 播放仍需端到端验收；单元测试或公共视频流验证不代表这两项已通过。


## 请求与响应通用约定

接口版本在路径 /v1，服务版本由 /health 返回。成功响应直接返回对象或数组，没有统一 data 包装；除 OPTIONS=204、媒体 Range=206，其余成功=200。所有 POST 只接受 application/json 对象，不能省略空 body；HTTP 请求体 1 字节至 2 MiB，拒绝 chunked body。无统一请求幂等键或任务 ID。

公开 API 同样受网站认证保护，/health 也不例外。Nginx 未认证的 401 是 Basic 挑战（可能是 HTML），不满足后端 JSON 错误结构；前端应先区分 HTTP 状态/Content-Type。后台 /v1/login/status 未登录则正常返回 200+auth_required；需要账号的采集操作才返回 401。只有一个共享账号槽位；注销后仍可读取上次采集的本地队列。

路径参数需要 URL 编码。GET / 等同 /health；HEAD 的无 body 行为适用于 GET 路由，媒体是重点支持场景。媒体 URL 不接受任意上游 URL。无分页查询参数的 /v1/queue 返回本地完整分 P 数组，不要在客户端加 cursor 假装服务已分页。

## 参数范围与默认值

| 接口/字段 | 约束 |
| --- | --- |
| resolve.url | BV 号或 HTTPS www.bilibili.com/video/BV...，可用 ?p=正整数；不支持 av/b23/任意重定向；不存在的 P 不写入部分内容 |
| watchlater.page_size | 整数 1..100，默认 20 |
| watchlater.max_pages | 整数 1..50，默认 20；预算耗尽/不完整报错并保留原队列 |
| subtitles.limit | 整数 1..10，默认 5；是本轮实际尝试条数上限 |
| subtitles.force | boolean，默认 false；默认跳过 ready/no_subtitle/subtitle_locked，true 重新请求 |
| playback.quality | 整数 16/32/64/80，默认 32；实际 quality 可能更低 |
| rules.scope/target/blocked | work 或 creator / 非空字符串 / boolean；仅服务本地规则，不隐藏原始成员关系 |
| QR 尝试 | 180 秒；同一尝试至少 2 秒轮询；最多 8 个活跃尝试、最多 128 个保留记录 |
| 媒体计划 | 最多 128 个内存计划、最长约 600 秒；提前失效/进程重启需重新创建；Range 仅一个范围 |

这些是当前实现限制，不是服务 SLA。上游 transport 内 0.7 秒间隔不等于多请求全局限流；尚无持久化任务队列，批量操作会同步等待。429 不自动高频重试，retryable=false 不代表永远不能人工重试。

## 返回对象与字段

完整可解析的虚构示例见 [api-examples.json](api-examples.json)，不是用户账号快照。

| 返回对象 | 字段与含义 |
| --- | --- |
| Health | service、status=ok、version |
| Account | id 为 UID 字符串，name 为昵称；不返回 Cookie 或账号权益详情 |
| LoginStatus | status=auth_required 或 connected；connected 携带 account |
| AccountSnapshot | account 和 last_sync，可为 null；account 另带 observed_at；快照不是实时凭据状态 |
| SyncResult | status=complete、collected、total、checked_at（UTC ISO）、account_id；失败同步记录可能有 reason，HTTP 错误本身用 error 包装 |
| QueueItem（可用） | id、title、bvid、cid、page、part_title、duration_seconds、creator_id/name、available、subtitle_status、rules_blocked、revision、fingerprint |
| QueueItem（缺失） | id、title、status=unavailable/pending_metadata、bvid、cid；不要假设 duration/page/creator 必定存在 |
| Content | id/title/creator_id/creator_name/duration_seconds/available/family_id/tags/sources/evidence/revision/fingerprint；statistics 可选 |
| Source | kind=video/watch_later、locator（来源标识，不是可下载 URL）、bvid/cid/page/part_title/added_at；added_at 可为 null |
| Evidence | id、kind、coverage、locator、text；字幕有 start/end（秒）、language、machine_generated（true 或 null）；当前生成的是 transcript，不是声画审阅 |
| SubtitleResult | work_id、cid、status、segments、language、content_hash；非 ready 时 segments 通常为 0/language 为 null；正文在 GET content.evidence，不放此返回中 |
| BatchSubtitles | results 数组，元素可为完整 SubtitleResult 或 work_id/cid/status 的失败项；HTTP 200 不等于每项成功，可能因 auth_required/rate_limited 提前停止 |
| Rule | scope、target、blocked；设置 false 为解除屏蔽，不修改站内关注关系 |
| QrStart | attempt_id、url、expires_at（Unix 秒）、poll_after_seconds、status=waiting_scan |
| QrPoll | attempt_id、status；connected 时附 account，轮询不再返回 start 的 url/过期时间 |

Content 的 revision 为正整数；fingerprint 为规范 JSON 的 SHA-256。evidence 的 id 是该内容版本内引用键。字幕超过 100000 字符可能只有 excerpt，没有 full 聚合轨；full coverage 表示取得的整条字幕轨，不保证每秒有文字或覆盖所有声音。缺失字段必须按缺失处理，不能由标题推断正文。

## 离线采集导入 /v1/captures

这是受信任采集程序的接口，仍需网站认证。它不接受任意原始响应或凭据，不是登录接口。

```json
{"type":"watchlater","account":{"id":"42","name":"示例账号"},"total":0,"items":[]}
```

watchlater 顶层白名单：type/account/items/total/observed_at；total 必须等于 items 长度，表示完整列表，明确提交空列表会清空当前成员。observed_at 可提供但当前实现用服务实际接收时间。item 只保留 aid/bvid/title/state/duration/cid/owner/add_at/pages，owner 保留 mid/name，pages 保留 page/cid/part/duration。返回 SyncResult。缺 pages 不伪造分 P；条目仍以 pending_metadata 保留。

```json
{"type":"subtitle","work_id":"BV1TUno6bEwA","cid":1230,"revision":1,"status":"ready","language":"ai-zh","body":[{"from":0,"to":12.5,"content":"这是示例字幕。"}]}
```

subtitle 顶层白名单：type/work_id/cid/status/language/language_name/body/revision。work_id 必须已有，cid 必须匹配当前分 P；revision 可选，提供时必须等于当前内容版本。status 可为 ready/no_subtitle/subtitle_locked，默认 ready；ready 的 body 不能为空，分段必须按起点排序并在本 P 时长内（上游舍入允许末尾至多超出 2 秒，入库会裁至时长）。language_name 可接收但不作为返回字段持久化。成功返回 SubtitleResult。

## 错误语义补充

以 code 为准，message 用于人读，不当稳定枚举。普通参数、CID/导入 revision 不匹配、字幕路径的本地屏蔽当前为 invalid_request/400；播放路径屏蔽为 blocked/403。找不到内容为 not_found/404；QR owner 不匹配为 attempt_not_found/404。poll_too_soon/too_many_attempts/rate_limited 为 429；playback_expired 为 410；unsupported_media/missing_media_identity 为 422；media_changed/credential_error 为 409；invalid_range 为 416。上游 invalid_response/incomplete/invalid_subtitle/api_error/network_error 等未单独映射者为 502。未预期异常为 internal_error/500。

retryable 当前只对 network_error/playback_expired/upstream_error 为 true；不是所有 5xx 都可无条件重试。连接已开始发送媒体后失败会关闭流，无法再返回 JSON，前端需处理播放错误。当前无 Retry-After 保证。不要为了统一前端自行把 400/404/502 改写成空内容。

## 命令行与配置

从仓库运行 `python3 server/content/run.py [--db PATH] <command>`；--db 位于子命令之前。默认 DB 在 server/content/data/content.sqlite3，默认 session 在 server/content/data/credentials/bilibili.json。安装的 bilibili-content CLI 默认数据位置是调用目录 data/，与 run.py 不同。

| 子命令 | 参数与结果 |
| --- | --- |
| serve | --port 8765、可重复 --allow-origin、--session-file；仅回环监听，不自动扫码 |
| login | --session-file；交互 getpass 输入 Cookie，不回显，校验后保存；建议优先 QR，不把 Cookie 写命令参数 |
| account-status | --session-file；实时认证 |
| sync-watchlater | --session-file、--page-size 20、--max-pages 20 |
| subtitles | --session-file、--limit 5、--force |
| queue | 返回本地队列 |
| content WORK_ID | 返回已采集内容 |
| capture FILE | 导入完整规范 JSON；CLI 文件上限 8 MiB，与 HTTP 的 2 MiB 不同 |

CLI 输出 JSON；成功一般退出 0，错误及未完成同步退出 2。没有计划任务、自动轮询或推送进程。启动不会强制重新扫码，私有登录文件失效才需重新授权。


## 前端调用片段

```js
const base = 'https://bilibili.kihara.cn'; // 生产推荐同源，网站认证由浏览器处理
async function api(path, body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = response.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) {
    throw new Error(`网站认证或网关响应：HTTP ${response.status}`);
  }
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error?.message || '请求失败'), {
    status: response.status, code: value.error?.code, retryable: value.error?.retryable,
  });
  return value;
}
const resolved = await api('/v1/videos/resolve', {url: 'BV1TUno6bEwA'});
const plan = await api('/v1/playback', {work_id: resolved.selected_id, quality: 32});
const mediaURL = new URL(plan.url, base).href; // 交给前端播放器；不要把 token 写进日志
```

QR 字段示例（纯占位，无真实授权能力）：

```json
{"attempt_id":"SYNTHETIC-ATTEMPT","url":"https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=SYNTHETIC-ONLY","expires_at":1793059380,"poll_after_seconds":2,"status":"waiting_scan"}
```

轮询完成形状：`{"attempt_id":"SYNTHETIC-ATTEMPT","status":"connected","account":{"id":"42","name":"示例账号"}}`。错误示例：`{"error":{"code":"playback_expired","message":"播放计划已失效","retryable":true}}`，HTTP 410；message 文本不作为协议常量。

文档维护时运行：

```sh
python3 server/content/scripts/export-api-examples.py
python3 server/content/scripts/export-api-examples.py --check
npm run test:content
```

示例导出器仅调用真实领域逻辑和 tests 中的虚构上游，不打开端口、不访问网络、不加载生产凭据。它可校验示例是否漂移，但不代替 HTTP、真实账号、媒体或设备验收。
