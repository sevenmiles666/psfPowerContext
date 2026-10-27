"""Generate local-only credentials; print no secrets."""

import os
import secrets
from pathlib import Path

root = Path(__file__).parent
path = root / ".env"
if path.exists():
    raise SystemExit(".env 已存在，保留现有配置")
values = {
    name: secrets.token_hex(32)
    for name in [
        "DIFY_SECRET_KEY",
        "DB_PASSWORD",
        "REDIS_PASSWORD",
        "SANDBOX_API_KEY",
        "STORE_TOKEN",
        "LOCAL_ADMIN_PASSWORD",
    ]
}
values.update(
    {
        "STORE_URL": "http://host.docker.internal:8010",
        "LOCAL_ADMIN_EMAIL": "captain@local.test",
    }
)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write("".join(f"{key}={value}\n" for key, value in values.items()))
print("已生成仅本地保存的 .env；请勿提交该文件")
