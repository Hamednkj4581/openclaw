"""汇总注册/登录结果，打包 session/cookie（提链已改到各账号 job 内完成）。"""

from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path


def extract_access_token(line: str) -> str | None:
    """从结果行提取 access token（倒数字段第二项）。"""
    parts = [part for part in line.split("----") if part != ""]
    if len(parts) < 3:
        return None
    token = parts[-2].strip()
    return token or None


def collect_result_lines(summaries_dir: Path) -> list[str]:
    results: list[str] = []
    for path in sorted(summaries_dir.rglob("step-summary")):
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            text = line.strip()
            if text:
                results.append(text)
    return results


def collect_access_tokens(summaries_dir: Path, result_lines: list[str]) -> list[str]:
    """从注册结果行与登录产物 access-token.txt 收集 token。"""
    tokens: list[str] = []
    seen: set[str] = set()

    def add(token: str | None) -> None:
        value = (token or "").strip()
        if not value or value in seen:
            return
        seen.add(value)
        tokens.append(value)

    for line in result_lines:
        add(extract_access_token(line))

    for path in sorted(summaries_dir.rglob("access-token.txt")):
        if path.is_file():
            add(path.read_text(encoding="utf-8").strip())

    return tokens


def read_session_email(session_path: Path) -> str | None:
    try:
        payload = json.loads(session_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    user = payload.get("user")
    if not isinstance(user, dict):
        return None
    email = user.get("email")
    return email.strip() if isinstance(email, str) and email.strip() else None


def safe_zip_folder_name(name: str) -> str:
    cleaned = "".join("_" if ch in '<>:"/\\|?*' or ord(ch) < 32 else ch for ch in name.strip())
    return cleaned or "unknown"


def pack_sessions_and_cookies(summaries_dir: Path, zip_path: Path) -> int:
    """把各账号的 session.json 与邮箱命名 cookie 打进同一个 zip。"""
    if not summaries_dir.is_dir():
        return 0

    entries = 0
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for account_dir in sorted(path for path in summaries_dir.iterdir() if path.is_dir()):
            session_path = account_dir / "session.json"
            cookie_paths = sorted(
                path for path in account_dir.rglob("*.json")
                if path.is_file() and path.name != "session.json"
            )
            if not session_path.is_file() and not cookie_paths:
                continue

            folder = safe_zip_folder_name(read_session_email(session_path) or account_dir.name)
            if session_path.is_file():
                archive.write(session_path, f"{folder}/session.json")
                entries += 1
            for cookie_path in cookie_paths:
                archive.write(cookie_path, f"{folder}/{cookie_path.name}")
                entries += 1
    if entries == 0 and zip_path.exists():
        zip_path.unlink()
    return entries


def write_text(path: Path, lines: list[str]) -> None:
    path.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")


def main() -> None:
    summaries_dir = Path(os.environ.get("SUMMARIES_DIR", "summaries"))
    require_results = (os.environ.get("REQUIRE_RESULTS") or "1").strip() not in ("0", "false", "no")

    results = collect_result_lines(summaries_dir) if summaries_dir.is_dir() else []
    tokens = collect_access_tokens(summaries_dir, results) if summaries_dir.is_dir() else []

    web_summary = Path("web-summary.txt")
    all_tokens = Path("all-access-tokens.txt")
    sessions_zip = Path("sessions-and-cookies.zip")

    write_text(web_summary, results)
    write_text(all_tokens, tokens)

    packed = pack_sessions_and_cookies(summaries_dir, sessions_zip) if summaries_dir.is_dir() else 0
    print(f"已打包 session/cookie 条目: {packed}")

    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as summary:
            if results:
                summary.write("\n".join(results) + "\n")
            summary.write(f"注册/结果行: {len(results)}\n")
            summary.write(f"access token: {len(tokens)}\n")
            summary.write(f"session/cookie zip 条目: {packed}\n")
            summary.write("支付提链: 已改由各账号 job 单独完成\n")

    if require_results and not results and not tokens:
        raise SystemExit("全部账号注册失败，无成功结果，工作流标记为失败")


if __name__ == "__main__":
    main()
