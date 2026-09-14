# 测试夹具

`dash-video-2frag.mp4` / `dash-audio-2frag.mp4` 是 B 站网页版真实 DASH 轨道的前两个分片，用于验证
`src/mp4-merge.js` 的重封装结果，而不是自造字节。

- 来源：公开视频 `BV1rp4y1e745`（cid `244954665`）的 `x/player/playurl` 响应，匿名会话、`fnval=4048`。
- 视频轨：`avc1.64001F` 854×426，timescale 16000，每个 `moof` 150 帧；截取到第二个分片结束（94574 字节）。
- 音频轨：`mp4a.40.2` 192K，timescale 48000，每个 `moof` 234 个采样；截取到第二个分片结束（180467 字节）。
- 轨道本身是 fragmented MP4：`ftyp + free + moov(mvex/mehd/trex/trep/trak) + sidx + moof+mdat ...`。
- 夹具只包含公开视频的极少字节，仅用于离线回归测试；签名 URL 已过期，测试不联网。

## progressive-avc-aac.mp4

用于验证「从单文件 MP4 无损提取音轨」（`src/mp4-merge.js` 的 `createAudioOnlyMp4`）。

- 来源：公开视频 `BV1wSYM6mEkb`（cid `41765178223`）的 `x/player/playurl` 响应，匿名会话、`fnval=1`、`qn=16`。
- 完整字节：402 602 字节，19 秒 360P，单条视频轨（`avc1`）+ 单条音频轨（`mp4a.40.2`，实测约 64 kbps / 152 048 音频字节）。
- 布局：`ftyp + moov(2 条 trak，含完整 stbl) + free + mdat`，moov 在文件头，音视频分块按 chunk 交错。
- 夹具为公开视频的极小片段，只用于离线回归测试；签名 URL 已过期，测试不联网。
