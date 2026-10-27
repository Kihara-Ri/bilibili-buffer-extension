#!/bin/sh
# 只在本服务证书续期后重载，避免干预其他证书的部署策略。
if [ "${RENEWED_LINEAGE:-}" = "/etc/letsencrypt/live/bilibili.kihara.cn" ]; then
    /usr/sbin/nginx -t && /usr/bin/systemctl reload nginx
fi
