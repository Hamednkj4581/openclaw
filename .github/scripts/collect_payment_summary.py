"""汇总注册/登录结果，打包 session/cookie，并按需对接 oai9 GCash 提链。"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

OAI9_BASE = "https://long.oai9.com"
PROMO_CHECK_URL = f"{OAI9_BASE}/api/promo-coupon/check"
GCASH_TASKS_URL = f"{OAI9_BASE}/api/gcash-link/tasks"
CARD_QUERY_URL = f"{OAI9_BASE}/api/card"

# 轮询：每 5 秒，最多约 10 分钟
POLL_INTERVAL_SEC = 5
POLL_MAX_ATTEMPTS = 120


def extract_access_token(line: str) -> str | None:
    """从结果行提取 access token（倒数字段第二项）。"""
    parts = [part for part in line.split("----") if part != ""]
    if len(parts) < 3:
        return None
    token = parts[-2].strip()
    return token or None


def pick_payment_link(task: dict[str, Any]) -> str:
    """按文档优先级选取 GCash 结果链接。"""
    for key in ("gcash_url", "provider_redirect_url", "long_url"):
        value = task.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def http_json(url: str, *, method: str = "GET", payload: dict[str, Any] | None = None, timeout: int = 60) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json", "User-Agent": "gpt-free-register-oai9"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            body = {}
        detail = body.get("detail") if isinstance(body, dict) else None
        if isinstance(detail, str) and detail.strip():
            raise RuntimeError(detail.strip()) from error
        if isinstance(detail, dict) and detail.get("error"):
            raise RuntimeError(str(detail["error"])) from error
        if isinstance(body, dict) and body.get("error"):
            raise RuntimeError(str(body["error"])) from error
        raise RuntimeError(f"HTTP {error.code}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError(str(error)) from error

    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError as error:
        raise RuntimeError("响应不是 JSON") from error
    if not isinstance(parsed, dict):
        raise RuntimeError("响应格式无效")
    return parsed


def query_card(card: str) -> dict[str, Any]:
    return http_json(CARD_QUERY_URL, method="POST", payload={"card": card})


def filter_eligible_tokens(tokens: list[str]) -> list[str]:
    """调用 promo-coupon/check，仅保留 state=eligible 且 eligible=true 的 token。"""
    if not tokens:
        return []
    payload = http_json(PROMO_CHECK_URL, method="POST", payload={"accessTokens": tokens})
    results = payload.get("results")
    if not isinstance(results, list):
        raise RuntimeError("资格预检响应缺少 results")

    eligible: list[str] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        if item.get("error"):
            continue
        if item.get("state") != "eligible" or not item.get("eligible"):
            continue
        index = item.get("index")
        if not isinstance(index, int) or index < 0 or index >= len(tokens):
            continue
        eligible.append(tokens[index])
    # 去重并保持顺序
    seen: set[str] = set()
    ordered: list[str] = []
    for token in eligible:
        if token in seen:
            continue
        seen.add(token)
        ordered.append(token)
    return ordered


def submit_gcash_tasks(card: str, tokens: list[str]) -> list[str]:
    """批量提交 GCash 提链任务，返回需轮询的 job_id 列表。"""
    payload = http_json(
        GCASH_TASKS_URL,
        method="POST",
        payload={
            "card": card,
            "accessTokens": tokens,
            "plan_type": "plus",
            "promo_code": "",
        },
    )
    job_ids: list[str] = []
    for key in ("tasks", "active_duplicates"):
        rows = payload.get(key)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            job_id = row.get("job_id")
            if isinstance(job_id, str) and job_id.strip():
                job_ids.append(job_id.strip())
    # 去重保序
    seen: set[str] = set()
    unique: list[str] = []
    for job_id in job_ids:
        if job_id in seen:
            continue
        seen.add(job_id)
        unique.append(job_id)
    return unique


def fetch_task_statuses(job_ids: list[str]) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for index in range(0, len(job_ids), 50):
        batch = job_ids[index : index + 50]
        query = urllib.parse.urlencode({"job_ids": ",".join(batch)})
        payload = http_json(f"{GCASH_TASKS_URL}/statuses?{query}")
        rows = payload.get("tasks")
        if isinstance(rows, list):
            tasks.extend(row for row in rows if isinstance(row, dict))
    return tasks


def poll_gcash_links(job_ids: list[str]) -> tuple[list[str], str]:
    """轮询至全部终态，返回链接列表与摘要文案。"""
    if not job_ids:
        return [], "无提链任务"

    pending = set(job_ids)
    links_by_job: dict[str, str] = {}
    failed = 0

    for attempt in range(1, POLL_MAX_ATTEMPTS + 1):
        rows = fetch_task_statuses(sorted(pending))
        for row in rows:
            job_id = str(row.get("job_id") or "").strip()
            if not job_id or job_id not in pending:
                continue
            status = str(row.get("status") or "").strip().lower()
            if status in ("queued", "extracting", ""):
                continue
            pending.discard(job_id)
            if status == "done":
                link = pick_payment_link(row)
                if link:
                    links_by_job[job_id] = link
                else:
                    failed += 1
                    print(f"::warning::任务 {job_id} 成功但无链接字段")
            elif status in ("failed", "canceled"):
                failed += 1
                error = row.get("error")
                print(f"::warning::任务 {job_id} {status}: {error or '无详情'}")
            else:
                # 未知终态按失败计，避免死循环
                failed += 1
                print(f"::warning::任务 {job_id} 未知状态: {status or '?'}")

        print(f"提链轮询 {attempt}/{POLL_MAX_ATTEMPTS}: 剩余 {len(pending)}，已得链接 {len(links_by_job)}")
        if not pending:
            break
        time.sleep(POLL_INTERVAL_SEC)

    if pending:
        print(f"::warning::提链轮询超时，未完成任务数: {len(pending)}")
        failed += len(pending)

    # 按原始 job 顺序输出并去重
    seen: set[str] = set()
    unique_links: list[str] = []
    for job_id in job_ids:
        link = links_by_job.get(job_id)
        if not link or link in seen:
            continue
        seen.add(link)
        unique_links.append(link)

    message = f"提链完成 {len(unique_links)} 条"
    if failed:
        message += f"，失败/超时 {failed} 条"
    return unique_links, message


def extract_gcash_payment_links(card: str, tokens: list[str]) -> tuple[list[str], str]:
    """预检资格并提交 GCash 提链，返回链接与说明。"""
    card = card.strip()
    if not card:
        return [], "已选择 gcash 但未提供卡密"
    if not tokens:
        return [], "无 access token，跳过提链"

    try:
        card_info = query_card(card)
    except RuntimeError as error:
        return [], f"卡密查询失败: {error}"
    if not card_info.get("ok") or not card_info.get("exists"):
        error = card_info.get("error")
        return [], f"卡密不可用: {error or 'unknown'}"

    try:
        eligible = filter_eligible_tokens(tokens)
    except RuntimeError as error:
        return [], f"资格预检失败: {error}"
    print(f"资格预检: {len(eligible)}/{len(tokens)} 可用")
    if not eligible:
        return [], "无零元试用资格账号"

    try:
        job_ids = submit_gcash_tasks(card, eligible)
    except RuntimeError as error:
        return [], f"提交提链失败: {error}"
    print(f"已提交/跟踪任务数: {len(job_ids)}")
    if not job_ids:
        return [], "未创建提链任务"

    return poll_gcash_links(job_ids)


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


def write_text(path: Path, lines: list[str]) -> None:
    path.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")


def main() -> None:
    summaries_dir = Path(os.environ.get("SUMMARIES_DIR", "summaries"))
    payment_link_type = (os.environ.get("PAYMENT_LINK_TYPE") or "未选择").strip()
    payment_card = (os.environ.get("PAYMENT_CARD") or "").strip()
    require_results = (os.environ.get("REQUIRE_RESULTS") or "1").strip() not in ("0", "false", "no")

    results = collect_result_lines(summaries_dir) if summaries_dir.is_dir() else []
    tokens = collect_access_tokens(summaries_dir, results) if summaries_dir.is_dir() else []

    web_summary = Path("web-summary.txt")
    all_tokens = Path("all-access-tokens.txt")
    payment_links_path = Path("payment-links.txt")
    payment_message_path = Path("payment-message.txt")
    sessions_zip = Path("sessions-and-cookies.zip")

    write_text(web_summary, results)
    write_text(all_tokens, tokens)

    packed = pack_sessions_and_cookies(summaries_dir, sessions_zip) if summaries_dir.is_dir() else 0
    print(f"已打包 session/cookie 条目: {packed}")

    payment_links: list[str] = []
    payment_message = "未选择支付提链"

    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as summary:
            if results:
                summary.write("\n".join(results) + "\n")
            summary.write(f"\n支付提链: {payment_link_type}\n")
            summary.write(f"注册/结果行: {len(results)}\n")
            summary.write(f"access token: {len(tokens)}\n")
            summary.write(f"session/cookie zip 条目: {packed}\n")

    if require_results and not results and not tokens:
        write_text(payment_links_path, [])
        payment_message_path.write_text("全部账号失败，无成功结果\n", encoding="utf-8")
        raise SystemExit("全部账号注册失败，无成功结果，工作流标记为失败")

    if payment_link_type != "gcash":
        print(f"支付提链未选择 gcash（当前={payment_link_type}），跳过 oai9 提链")
        write_text(payment_links_path, [])
        payment_message_path.write_text(f"{payment_message}\n", encoding="utf-8")
        return

    if payment_card:
        print(f"::add-mask::{payment_card}")

    payment_links, payment_message = extract_gcash_payment_links(payment_card, tokens)
    write_text(payment_links_path, payment_links)
    payment_message_path.write_text(payment_message + "\n", encoding="utf-8")
    print(payment_message)

    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as summary:
            summary.write(f"支付链接: {len(payment_links)}\n")
            summary.write(f"提链说明: {payment_message}\n")


if __name__ == "__main__":
    main()
