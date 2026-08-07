"""汇总注册结果，打包 session/cookie，并按需检查 gcash zero trial。"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ZERO_TRIAL_URL = "https://ai.pupux.xyz/api/session/check-zero-trial"
# gcash 提链固定参数
GCASH_PAYLOAD = {
    "link_type": "gcash",
    "billing_country": "PH",
    "options": {"currency": "PHP"},
    "use_plus_free_promo": True,
}


def extract_access_token(line: str) -> str | None:
    """从结果行提取 access token（倒数字段第二项）。"""
    parts = [part for part in line.split("----") if part != ""]
    if len(parts) < 3:
        return None
    token = parts[-2].strip()
    return token or None


def check_zero_trial(access_token: str) -> bool:
    """调用 check-zero-trial，返回是否具备 zero trial 资格。"""
    body = json.dumps({**GCASH_PAYLOAD, "access_token": access_token}).encode("utf-8")
    request = urllib.request.Request(
        ZERO_TRIAL_URL,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://ai.pupux.xyz",
            "Referer": "https://ai.pupux.xyz/",
            "User-Agent": (
                "Mozilla/5.0 (Linux; Android 15; Pixel 9) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/150.0.0.0 Mobile Safari/537.36"
            ),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError) as error:
        print(f"::warning::check-zero-trial 请求失败: {error}")
        return False

    if not isinstance(payload, dict):
        return False
    return bool(payload.get("zero_trial_supported"))


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
            # cookie 在 cookies/ 子目录（也兼容账号目录根下的邮箱.json）
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


def main() -> None:
    summaries_dir = Path(os.environ.get("SUMMARIES_DIR", "summaries"))
    payment_link_type = (os.environ.get("PAYMENT_LINK_TYPE") or "未选择").strip()
    results = collect_result_lines(summaries_dir)

    web_summary = Path("web-summary.txt")
    all_tokens = Path("all-access-tokens.txt")
    zero_tokens = Path("zero-trial-tokens.txt")
    sessions_zip = Path("sessions-and-cookies.zip")

    web_summary.write_text(("\n".join(results) + "\n") if results else "", encoding="utf-8")

    tokens: list[str] = []
    for line in results:
        token = extract_access_token(line)
        if token:
            tokens.append(token)
    all_tokens.write_text(("\n".join(tokens) + "\n") if tokens else "", encoding="utf-8")

    packed = pack_sessions_and_cookies(summaries_dir, sessions_zip)
    print(f"已打包 session/cookie 条目: {packed}")

    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as summary:
            if results:
                summary.write("\n".join(results) + "\n")
            summary.write(f"\n支付提链: {payment_link_type}\n")
            summary.write(f"注册成功: {len(results)}\n")
            summary.write(f"access token: {len(tokens)}\n")
            summary.write(f"session/cookie zip 条目: {packed}\n")

    if payment_link_type != "gcash":
        print(f"支付提链未选择 gcash（当前={payment_link_type}），跳过 zero trial 检查")
        return

    eligible: list[str] = []
    for index, token in enumerate(tokens, 1):
        print(f"检查 zero trial ({index}/{len(tokens)}) ...")
        if check_zero_trial(token):
            eligible.append(token)
            print(f"账号 {index}: zero_trial_supported")
        else:
            print(f"账号 {index}: 无资格或检查失败")

    zero_tokens.write_text(("\n".join(eligible) + "\n") if eligible else "", encoding="utf-8")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as summary:
            summary.write(f"zero trial 资格: {len(eligible)}\n")
    print(f"zero trial 资格账号数: {len(eligible)}")


if __name__ == "__main__":
    main()
