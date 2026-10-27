"""Run the local browser entrance and PowerContext gateway as a single worker."""

import os
from pathlib import Path

import uvicorn

root = Path(__file__).parent
os.chdir(root)
for line in (root / ".env").read_text().splitlines():
    if line and not line.startswith("#"):
        key, value = line.split("=", 1)
        os.environ.setdefault(key, value)

from backend import create_app  # noqa: E402

uvicorn.run(
    create_app(),
    host=os.environ.get("STORE_BIND_HOST", "127.0.0.1"),
    port=8010,
    workers=1,
)
