"""Fetch a public model at an immutable revision, with no account credential."""

import hashlib
from pathlib import Path

from huggingface_hub import snapshot_download

destination = Path(__file__).parent / "runtime/Qwen3-1.7B-4bit"
snapshot_download(
    "mlx-community/Qwen3-1.7B-4bit",
    revision="3b1b1768f8f8cf8351c712464f906e86c2b8269e",
    local_dir=str(destination),
    token=False,
    allow_patterns=["*.json", "*.safetensors", "*.txt"],
)
weight = destination / "model.safetensors"
with weight.open("rb") as stream:
    actual = hashlib.file_digest(stream, "sha256").hexdigest()
if actual != "0e86d9677e519323849eac1bc272caae88567a481ff188c431f70be543d9995f":
    raise SystemExit("Model checksum mismatch")
print("Model downloaded and SHA-256 verified")
