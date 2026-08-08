"""向网页控制台发送进度 webhook（失败不抛出，避免阻断主流程）。"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request


def post_web_callback(payload: dict) -> None:
    task_id = (os.environ.get("WEB_TASK_ID") or "").strip()
    url = (os.environ.get("WEB_CALLBACK_URL") or "").strip()
    secret = (os.environ.get("WEBHOOK_SECRET") or "").strip()
    if not task_id or not url or not secret:
        return

    body = dict(payload)
    body["taskId"] = task_id
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "X-Webhook-Secret": secret,
            "User-Agent": "gpt-free-register-web-callback",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            response.read()
    except Exception as error:  # noqa: BLE001 — 回调失败只告警
        print(f"web callback skipped: {error}")


def extract_email(record: str) -> str:
    return record.split("----", 1)[0].strip() or "unknown"


def extract_access_token_from_session(path: str = "session.json") -> str:
    if not os.path.isfile(path):
        return ""
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        token = data.get("accessToken")
        return token.strip() if isinstance(token, str) else ""
    except Exception:  # noqa: BLE001
        return ""


def extract_access_token_from_summary(path: str = "step-summary") -> str:
    if not os.path.isfile(path):
        return ""
    try:
        with open(path, encoding="utf-8") as handle:
            line = handle.read().strip().splitlines()[-1]
        parts = [part for part in line.split("----") if part]
        # email----password----[otp----]accessToken----time
        if len(parts) >= 4:
            return parts[-2]
    except Exception:  # noqa: BLE001
        return ""
    return ""


def extract_access_token_from_file(path: str = "access-token.txt") -> str:
    if not os.path.isfile(path):
        return ""
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read().strip()
    except Exception:  # noqa: BLE001
        return ""


if __name__ == "__main__":
    event = os.environ.get("WEB_EVENT", "").strip()
    if not event:
        raise SystemExit("WEB_EVENT 不能为空")

    payload: dict = {"event": event}
    if event == "started":
        payload["total"] = int(os.environ.get("WEB_TOTAL", "0") or "0")
    elif event == "account_done":
        ok = (os.environ.get("WEB_ACCOUNT_OK") or "").lower() in ("1", "true", "yes")
        account = {
            "index": int(os.environ.get("WEB_ACCOUNT_INDEX", "0") or "0"),
            "email": os.environ.get("WEB_ACCOUNT_EMAIL") or "unknown",
            "ok": ok,
        }
        if ok:
            token = (
                os.environ.get("WEB_ACCESS_TOKEN")
                or extract_access_token_from_session()
                or extract_access_token_from_summary()
                or extract_access_token_from_file()
            )
            if token:
                account["accessToken"] = token
            else:
                account["ok"] = False
                account["error"] = "未拿到结果"
        else:
            account["error"] = (os.environ.get("WEB_ACCOUNT_ERROR") or "处理失败")[:80]
        payload["account"] = account
    elif event == "finished":
        payload["ok"] = (os.environ.get("WEB_FINISHED_OK") or "true").lower() in ("1", "true", "yes")
        # 提链已改由各账号 job 单独回传 paymentLink，finished 不再附带汇总链接
    else:
        raise SystemExit(f"未知 WEB_EVENT: {event}")

    post_web_callback(payload)
