"""Upsert FORWARD_MAILBOXES secret from local forward_mailboxes.txt."""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


SECRET_NAME = "FORWARD_MAILBOXES"
DEFAULT_FILE = "forward_mailboxes.txt"


def request_json(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, dict | None]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "gpt-free-register-sync-forward-mailboxes",
        },
    )
    try:
        with urllib.request.urlopen(req) as response:
            raw = response.read().decode("utf-8")
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = {"message": raw}
        return error.code, payload


def public_key(repo: str, token: str) -> tuple[str, str]:
    status, payload = request_json("GET", f"https://api.github.com/repos/{repo}/actions/secrets/public-key", token)
    if status != 200 or not payload or "key" not in payload or "key_id" not in payload:
        raise SystemExit(f"读取仓库公钥失败（HTTP {status}）：{payload}")
    return payload["key"], payload["key_id"]


def encrypt_secret(public_key_b64: str, secret_value: str) -> str:
    try:
        from nacl import encoding, public  # type: ignore
    except ImportError as error:
        raise SystemExit("缺少 PyNaCl，请先执行：pip install pynacl") from error

    public_key_obj = public.PublicKey(public_key_b64.encode("utf-8"), encoding.Base64Encoder())
    sealed_box = public.SealedBox(public_key_obj)
    encrypted = sealed_box.encrypt(secret_value.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")


def upsert_secret(repo: str, token: str, name: str, value: str) -> None:
    key, key_id = public_key(repo, token)
    encrypted_value = encrypt_secret(key, value)
    status, payload = request_json(
        "PUT",
        f"https://api.github.com/repos/{repo}/actions/secrets/{name}",
        token,
        {"encrypted_value": encrypted_value, "key_id": key_id},
    )
    if status not in (201, 204):
        raise SystemExit(f"更新 Secret {name} 失败（HTTP {status}）：{payload}")


def main() -> None:
    parser = argparse.ArgumentParser(description="同步 forward_mailboxes.txt 到 GitHub Secret FORWARD_MAILBOXES")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", "Hamednkj4581/openclaw"))
    parser.add_argument("--file", default=DEFAULT_FILE)
    parser.add_argument("--token", default=os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"))
    args = parser.parse_args()

    if not args.token:
        raise SystemExit("缺少 GH_TOKEN / GITHUB_TOKEN")

    path = Path(args.file)
    if not path.is_file():
        raise SystemExit(f"找不到转发邮箱凭据文件：{path}")

    value = path.read_text(encoding="utf-8").strip()
    if not value:
        raise SystemExit(f"{path} 为空")

    # 延迟导入，仅在同步路径校验格式
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from account_input import parse_outlook_mailboxes

    mailboxes = parse_outlook_mailboxes(value)
    upsert_secret(args.repo, args.token, SECRET_NAME, value)
    print(f"已同步 Secret {SECRET_NAME}（{len(mailboxes)} 个转发邮箱）")


if __name__ == "__main__":
    main()
