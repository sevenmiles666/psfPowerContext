"""Fetch pinned public MiniLM ONNX files; no inference runs in this script."""

import concurrent.futures
import hashlib
import json
import os
import urllib.request
from pathlib import Path

REVISION = "751bff37182d3f1213fa05d7196b954e230abad9"
MODEL = "Xenova/all-MiniLM-L6-v2"
FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "onnx/model.onnx",
    "onnx/model_fp16.onnx",
    "onnx/model_quantized.onnx",
]
ROOT = Path(__file__).parent / "public/models/minilm"


def download(name):
    target = ROOT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    manifest = Path(__file__).parent / "evidence/model-files.json"
    expected = (
        next(
            (
                item
                for item in json.loads(manifest.read_text())["files"]
                if item["file"] == name
            ),
            None,
        )
        if manifest.exists()
        else None
    )
    if (
        expected
        and target.exists()
        and hashlib.sha256(target.read_bytes()).hexdigest() == expected["sha256"]
    ):
        print(json.dumps({"file": name, "cached_and_verified": True}), flush=True)
        return expected
    url = f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}"
    proxy = os.environ.get("MODEL_DOWNLOAD_PROXY")
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        if proxy
        else urllib.request.ProxyHandler()
    )
    temporary = target.with_suffix(target.suffix + ".part")
    with opener.open(url, timeout=120) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    record = {
        "file": name,
        "bytes": temporary.stat().st_size,
        "sha256": hashlib.sha256(temporary.read_bytes()).hexdigest(),
    }
    if expected and record != expected:
        temporary.unlink(missing_ok=True)
        raise ValueError(f"Pinned model checksum mismatch: {name}")
    temporary.replace(target)
    print(json.dumps(record), flush=True)
    return record


if __name__ == "__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records = list(pool.map(download, FILES))
    provenance = {
        "model": MODEL,
        "revision": REVISION,
        "files": records,
        "license": "Apache-2.0",
        "inference": "browser only",
    }
    evidence = Path(__file__).parent / "evidence"
    evidence.mkdir(exist_ok=True)
    (evidence / "model-files.json").write_text(json.dumps(provenance, indent=2) + "\n")
