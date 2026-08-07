#!/usr/bin/env python3
"""构建并部署 Cloudflare Pages，同步 WEB_CALLBACK_URL / WEBHOOK_SECRET 等。"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = WEB_DIR.parent
WRANGLER_TOML = WEB_DIR / "wrangler.toml"
PROJECT_NAME = "gpt-web-console"
GITHUB_REPO_DEFAULT = "Hamednkj4581/openclaw"


def read_secret_file(name: str) -> str:
    path = REPO_ROOT / name
    if not path.is_file():
        raise SystemExit(f"缺少凭据文件：{path.name}（请放在仓库根目录且保持未跟踪）")
    value = path.read_text(encoding="utf-8").strip()
    if not value:
        raise SystemExit(f"{path.name} 为空")
    return value


def load_toml_text() -> str:
    return WRANGLER_TOML.read_text(encoding="utf-8")


def read_toml_value(key: str) -> str | None:
    text = load_toml_text()
    match = re.search(rf'^{re.escape(key)}\s*=\s*"([^"]*)"', text, re.MULTILINE)
    return match.group(1) if match else None


def write_toml_value(key: str, value: str) -> None:
    text = load_toml_text()
    pattern = rf'^({re.escape(key)}\s*=\s*")[^"]*(")'
    if re.search(pattern, text, re.MULTILINE):
        text = re.sub(pattern, rf"\g<1>{value}\g<2>", text, count=1, flags=re.MULTILINE)
    else:
        # account_id 写在 name 之后
        text = re.sub(
            r'^(name\s*=\s*"[^"]*"\s*)$',
            rf'\1\n{key} = "{value}"',
            text,
            count=1,
            flags=re.MULTILINE,
        )
    WRANGLER_TOML.write_text(text, encoding="utf-8")


def replace_kv_ids(namespace_id: str) -> None:
    text = load_toml_text()
    text = re.sub(r'(^id\s*=\s*")[^"]*(")', rf"\g<1>{namespace_id}\g<2>", text, count=1, flags=re.MULTILINE)
    text = re.sub(
        r'(^preview_id\s*=\s*")[^"]*(")',
        rf"\g<1>{namespace_id}\g<2>",
        text,
        count=1,
        flags=re.MULTILINE,
    )
    WRANGLER_TOML.write_text(text, encoding="utf-8")


def cf_request(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "gpt-web-console-deploy",
        },
    )
    try:
        with urllib.request.urlopen(req) as response:
            raw = response.read().decode("utf-8")
            return response.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"message": raw}
        return error.code, payload


def gh_request(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, dict | None]:
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
            "User-Agent": "gpt-web-console-deploy",
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


def encrypt_secret(public_key_b64: str, secret_value: str) -> str:
    try:
        from nacl import encoding, public  # type: ignore
    except ImportError as error:
        raise SystemExit("缺少 PyNaCl，请先执行：pip install pynacl") from error

    public_key_obj = public.PublicKey(public_key_b64.encode("utf-8"), encoding.Base64Encoder())
    sealed_box = public.SealedBox(public_key_obj)
    encrypted = sealed_box.encrypt(secret_value.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")


def upsert_github_secret(repo: str, token: str, name: str, value: str) -> None:
    status, payload = gh_request("GET", f"https://api.github.com/repos/{repo}/actions/secrets/public-key", token)
    if status != 200 or not payload or "key" not in payload or "key_id" not in payload:
        raise SystemExit(f"读取仓库公钥失败（HTTP {status}）")
    encrypted_value = encrypt_secret(payload["key"], value)
    status, payload = gh_request(
        "PUT",
        f"https://api.github.com/repos/{repo}/actions/secrets/{name}",
        token,
        {"encrypted_value": encrypted_value, "key_id": payload["key_id"]},
    )
    if status not in (201, 204):
        raise SystemExit(f"更新 GitHub Secret {name} 失败（HTTP {status}）")


def github_secret_exists(repo: str, token: str, name: str) -> bool:
    status, _ = gh_request("GET", f"https://api.github.com/repos/{repo}/actions/secrets/{name}", token)
    return status == 200


def ensure_kv(account_id: str, cf_token: str) -> str:
    current = read_toml_value("id")
    if current and current != "00000000000000000000000000000000":
        return current

    status, payload = cf_request(
        "POST",
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}/storage/kv/namespaces",
        cf_token,
        {"title": f"{PROJECT_NAME}-tasks"},
    )
    if status not in (200, 201) or not payload.get("success"):
        raise SystemExit(f"创建 KV 失败（HTTP {status}）")
    namespace_id = payload["result"]["id"]
    replace_kv_ids(namespace_id)
    print(f"已创建 KV 并写入 wrangler.toml：{namespace_id}")
    return namespace_id


def ensure_pages_project(account_id: str, cf_token: str) -> None:
    status, payload = cf_request(
        "GET",
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{PROJECT_NAME}",
        cf_token,
    )
    if status == 200 and payload.get("success"):
        return
    status, payload = cf_request(
        "POST",
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects",
        cf_token,
        {
            "name": PROJECT_NAME,
            "production_branch": "main",
            "deployment_configs": {
                "production": {
                    "env_vars": {
                        "GITHUB_OWNER": {"value": read_toml_value("GITHUB_OWNER") or "Hamednkj4581"},
                        "GITHUB_REPO": {"value": read_toml_value("GITHUB_REPO") or "openclaw"},
                        "GITHUB_REF": {"value": "main"},
                    },
                    "kv_namespaces": {
                        "TASKS": {"namespace_id": read_toml_value("id")},
                    },
                }
            },
        },
    )
    if status not in (200, 201) or not payload.get("success"):
        # 项目可能已存在但 GET 路径不同；继续交给 wrangler
        print("创建 Pages 项目未确认成功，将继续尝试 wrangler deploy")


def run_captured(
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
) -> tuple[int, str]:
    """运行子进程并用 UTF-8 解码输出，避免 Windows GBK 解码失败。"""
    proc = subprocess.run(
        args,
        cwd=str(cwd),
        input=None if input_text is None else input_text.encode("utf-8"),
        capture_output=True,
        env=env,
        shell=os.name == "nt",
    )
    output = b"".join(filter(None, [proc.stdout, proc.stderr])).decode("utf-8", errors="replace")
    return proc.returncode, output


def put_pages_secret(name: str, value: str, cf_token: str, account_id: str) -> None:
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = cf_token
    env["CLOUDFLARE_ACCOUNT_ID"] = account_id
    code, output = run_captured(
        ["npx", "wrangler", "pages", "secret", "put", name, "--project-name", PROJECT_NAME],
        cwd=WEB_DIR,
        env=env,
        input_text=value + "\n",
    )
    if code != 0:
        raise SystemExit(f"写入 Pages secret {name} 失败：{output.strip()}")


def run_build() -> None:
    npm = "npm.cmd" if os.name == "nt" else "npm"
    install = subprocess.run([npm, "ci"], cwd=str(WEB_DIR), shell=os.name == "nt")
    if install.returncode != 0:
        install = subprocess.run([npm, "install"], cwd=str(WEB_DIR), shell=os.name == "nt")
        if install.returncode != 0:
            raise SystemExit("npm install 失败")
    build = subprocess.run([npm, "run", "build"], cwd=str(WEB_DIR), shell=os.name == "nt")
    if build.returncode != 0:
        raise SystemExit("前端构建失败")


def run_deploy(cf_token: str, account_id: str) -> str:
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = cf_token
    env["CLOUDFLARE_ACCOUNT_ID"] = account_id
    # 让 Node/wrangler 尽量输出 UTF-8，避免控制台乱码
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env["FORCE_COLOR"] = "0"
    code, output = run_captured(
        ["npx", "wrangler", "pages", "deploy", "dist", "--project-name", PROJECT_NAME, "--branch", "main"],
        cwd=WEB_DIR,
        env=env,
    )
    if code != 0:
        raise SystemExit(f"wrangler pages deploy 失败：\n{output}")

    stable = f"https://{PROJECT_NAME}.pages.dev"
    if stable in output or re.search(rf"https://{re.escape(PROJECT_NAME)}\.pages\.dev", output):
        return stable
    match = re.search(r"https://[a-zA-Z0-9.-]+\.pages\.dev", output)
    if match:
        return match.group(0).rstrip("/")
    return stable


def resolve_account_id(cf_token: str) -> str:
    account_file = REPO_ROOT / "CLOUDFLARE_ACCOUNT_ID"
    account_id = (
        os.environ.get("CLOUDFLARE_ACCOUNT_ID")
        or (account_file.read_text(encoding="utf-8").strip() if account_file.is_file() else "")
    )
    if account_id and not account_id.startswith("your_"):
        return account_id

    status, payload = cf_request("GET", "https://api.cloudflare.com/client/v4/accounts", cf_token)
    if status != 200 or not payload.get("success") or not payload.get("result"):
        raise SystemExit("无法自动获取 Cloudflare account_id，请在根目录创建 CLOUDFLARE_ACCOUNT_ID 文件")
    accounts = payload["result"]
    if len(accounts) != 1:
        names = ", ".join(f"{a.get('name')}={a.get('id')}" for a in accounts[:5])
        raise SystemExit(f"检测到多个 Cloudflare 账号，请在根目录 CLOUDFLARE_ACCOUNT_ID 指定（{names}）")
    account_id = accounts[0]["id"]
    # Pages 的 wrangler.toml 不支持 account_id，写入未跟踪本地文件
    account_file.write_text(account_id + "\n", encoding="utf-8")
    print("已写入根目录 CLOUDFLARE_ACCOUNT_ID（请保持未跟踪）")
    return account_id


def main() -> None:
    cf_token = read_secret_file("CLOUDFLARE_API_TOKEN")
    gh_token = read_secret_file("PAT")
    repo = os.environ.get("GITHUB_REPOSITORY") or GITHUB_REPO_DEFAULT

    account_id = resolve_account_id(cf_token)
    ensure_kv(account_id, cf_token)
    ensure_pages_project(account_id, cf_token)

    run_build()
    origin = run_deploy(cf_token, account_id)
    callback_url = f"{origin}/api/webhook"

    upsert_github_secret(repo, gh_token, "WEB_CALLBACK_URL", callback_url)
    print("已更新 GitHub Secret：WEB_CALLBACK_URL")

    secret_file = REPO_ROOT / "WEBHOOK_SECRET"
    if secret_file.is_file() and secret_file.read_text(encoding="utf-8").strip():
        webhook_secret = secret_file.read_text(encoding="utf-8").strip()
        print("使用本地 WEBHOOK_SECRET 文件同步到 GitHub 与 Pages")
    elif github_secret_exists(repo, gh_token, "WEBHOOK_SECRET"):
        webhook_secret = None
        print("GitHub WEBHOOK_SECRET 已存在且本地无副本，保持不轮换")
        print("若 Pages 侧缺失，请在根目录创建 WEBHOOK_SECRET 文件后重新部署以对齐")
    else:
        webhook_secret = secrets.token_urlsafe(32)
        secret_file.write_text(webhook_secret + "\n", encoding="utf-8")
        print("已生成本地 WEBHOOK_SECRET 文件（请保持未跟踪）")

    if webhook_secret:
        upsert_github_secret(repo, gh_token, "WEBHOOK_SECRET", webhook_secret)
        put_pages_secret("WEBHOOK_SECRET", webhook_secret, cf_token, account_id)
        print("已同步 WEBHOOK_SECRET（GitHub + Pages）")

    put_pages_secret("GITHUB_PAT", gh_token, cf_token, account_id)
    print("已同步 Pages secret：GITHUB_PAT")

    print(f"部署完成：{origin}")
    print(f"回调地址已维护：WEB_CALLBACK_URL -> {callback_url}")


if __name__ == "__main__":
    main()
