import email
import html
import imaplib
import re
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

import requests


TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
IMAP_HOST = "outlook.live.com"
MAILBOXES = ("INBOX", "Junk")
MAX_EMAILS_PER_MAILBOX = 30
SHANGHAI_TIMEZONE = ZoneInfo("Asia/Shanghai")
MAIL_PREVIEW_DIR = Path("mail_previews")


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def get_text(self):
        return " ".join(self.parts)


def parse_account(account_info):
    """解析 email----password----client_id----refresh_token 格式的账号。"""
    parts = re.split(r"-{4,}", account_info.strip(), maxsplit=3)
    if len(parts) != 4 or any(not part.strip() for part in parts):
        raise ValueError(
            "账号格式错误，应为：邮箱----邮箱密码----client_id----refresh_token"
        )

    email_user, email_password, client_id, refresh_token = (
        part.strip() for part in parts
    )
    if "@" not in email_user:
        raise ValueError("邮箱地址格式错误。")

    # OAuth2 登录不需要邮箱密码，但仍解析该字段以兼容统一账号格式。
    return email_user, email_password, client_id, refresh_token


def get_access_token(client_id, refresh_token):
    try:
        response = requests.post(
            TOKEN_URL,
            data={
                "client_id": client_id,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
            timeout=30,
        )
        result = response.json()
    except requests.RequestException as exc:
        raise RuntimeError(f"获取访问令牌失败：{exc}") from exc
    except ValueError as exc:
        raise RuntimeError("Microsoft 返回了无法解析的响应。") from exc

    if response.ok and result.get("access_token"):
        return result["access_token"]

    error = result.get("error_description") or result.get("error") or "未知错误"
    raise RuntimeError(f"邮箱状态异常：{error}")


def generate_auth_string(email_user, access_token):
    return f"user={email_user}\1auth=Bearer {access_token}\1\1"


def decode_mime_header(value):
    if not value:
        return ""
    return str(make_header(decode_header(value)))


def decode_part(part):
    payload = part.get_payload(decode=True)
    if payload is None:
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def html_to_text(value):
    parser = _TextExtractor()
    parser.feed(value)
    return parser.get_text()


def get_message_parts(message):
    plain_parts = []
    html_parts = []

    for part in message.walk() if message.is_multipart() else (message,):
        if part.get_content_disposition() == "attachment":
            continue
        content_type = part.get_content_type()
        if content_type == "text/plain":
            plain_parts.append(decode_part(part))
        elif content_type == "text/html":
            html_parts.append(decode_part(part))

    return plain_parts, html_parts


def get_message_text(message):
    plain_parts, html_parts = get_message_parts(message)
    return "\n".join(plain_parts + [html_to_text(part) for part in html_parts])


def get_message_html(message):
    """提取邮件 HTML；若无 HTML 则把纯文本包成可预览片段。"""
    plain_parts, html_parts = get_message_parts(message)
    if html_parts:
        return "\n".join(html_parts)
    if not plain_parts:
        return None
    body = html.escape("\n".join(plain_parts))
    return f"<pre>{body}</pre>"


def build_preview_meta_html(message, mailbox):
    """生成预览页顶部的发件/收件/来源等元信息。"""
    fields = [
        ("发件人", decode_mime_header(message.get("From"))),
        ("收件人", decode_mime_header(message.get("To"))),
        ("回复至", decode_mime_header(message.get("Reply-To"))),
        ("主题", decode_mime_header(message.get("Subject"))),
        ("时间", format_mail_time(message.get("Date"))),
        ("邮箱位置", mailbox),
    ]
    rows = []
    for label, value in fields:
        if not value:
            continue
        rows.append(
            f"<div><strong>{html.escape(label)}：</strong>"
            f"{html.escape(value)}</div>"
        )
    return (
        '<div style="margin:0 0 16px;padding:12px 16px;border-bottom:1px solid #ddd;'
        'font:14px/1.6 sans-serif;background:#f7f7f7;color:#222;">'
        f"{''.join(rows)}</div>"
    )


def build_mail_preview_html(body_html, message, mailbox):
    """把元信息注入邮件 HTML，方便浏览器直接预览来源。"""
    meta_html = build_preview_meta_html(message, mailbox)
    match = re.search(r"(<body[^>]*>)", body_html, flags=re.IGNORECASE)
    if match:
        idx = match.end()
        return body_html[:idx] + meta_html + body_html[idx:]
    return (
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
        "<title>mail preview</title></head>"
        f"<body>{meta_html}{body_html}</body></html>"
    )


def save_mail_preview_html(date_header, html_content):
    """按邮件时间将 HTML 保存到 mail_previews，同秒冲突时追加序号。"""
    MAIL_PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    mail_time = parse_mail_datetime(date_header)
    if mail_time is None:
        stem = "unknown_time"
    else:
        stem = mail_time.astimezone(SHANGHAI_TIMEZONE).strftime("%Y-%m-%d_%H-%M-%S")

    path = MAIL_PREVIEW_DIR / f"{stem}.html"
    suffix = 2
    while path.exists():
        path = MAIL_PREVIEW_DIR / f"{stem}_{suffix}.html"
        suffix += 1

    path.write_text(html_content, encoding="utf-8")
    return path


def extract_verification_code(subject, body):
    combined = f"{subject}\n{body}"
    contextual_patterns = (
        r"(?:ChatGPT|OpenAI|验证码|verification\s+code|security\s+code|code)"
        r"[^0-9]{0,100}([0-9]{6})(?![0-9])",
        r"(?<![0-9])([0-9]{6})(?![0-9])"
        r"[^\n]{0,100}(?:ChatGPT|OpenAI|验证码|verification\s+code|code)",
    )
    for pattern in contextual_patterns:
        match = re.search(pattern, combined, flags=re.IGNORECASE)
        if match:
            return match.group(1)

    fallback = re.search(r"(?<![0-9])([0-9]{6})(?![0-9])", combined)
    return fallback.group(1) if fallback else None


def parse_mail_datetime(date_header):
    if not date_header:
        return None
    try:
        mail_time = parsedate_to_datetime(date_header)
    except (TypeError, ValueError, OverflowError):
        return None

    if mail_time.tzinfo is None:
        mail_time = mail_time.replace(tzinfo=SHANGHAI_TIMEZONE)
    return mail_time


def format_mail_time(date_header):
    mail_time = parse_mail_datetime(date_header)
    if mail_time is None:
        return "未知时间"
    shanghai_time = mail_time.astimezone(SHANGHAI_TIMEZONE)
    return shanghai_time.strftime("%Y-%m-%d %H:%M:%S (Asia/Shanghai)")


def get_chatgpt_verifications(email_user, access_token):
    results = []
    seen_messages = set()
    mail = imaplib.IMAP4_SSL(IMAP_HOST)

    try:
        mail.authenticate(
            "XOAUTH2", lambda _: generate_auth_string(email_user, access_token)
        )

        for mailbox in MAILBOXES:
            status, _ = mail.select(mailbox, readonly=True)
            if status != "OK":
                continue

            status, data = mail.search(None, "ALL")
            if status != "OK" or not data or not data[0]:
                continue

            mail_ids = data[0].split()[-MAX_EMAILS_PER_MAILBOX:]
            for mail_id in reversed(mail_ids):
                status, message_data = mail.fetch(mail_id, "(RFC822)")
                if status != "OK" or not message_data:
                    continue

                raw_email = next(
                    (
                        item[1]
                        for item in message_data
                        if isinstance(item, tuple) and isinstance(item[1], bytes)
                    ),
                    None,
                )
                if raw_email is None:
                    continue

                message = email.message_from_bytes(raw_email)
                message_id = message.get("Message-ID") or f"{mailbox}:{mail_id!r}"
                if message_id in seen_messages:
                    continue
                seen_messages.add(message_id)

                subject = decode_mime_header(message.get("Subject"))
                sender = decode_mime_header(message.get("From"))
                if not re.search(r"(?:openai|chatgpt)", f"{subject} {sender}", re.I):
                    continue

                code = extract_verification_code(subject, get_message_text(message))
                if code:
                    date_header = message.get("Date")
                    parsed_date = parse_mail_datetime(date_header)
                    preview_path = None
                    html_content = get_message_html(message)
                    if html_content:
                        preview_html = build_mail_preview_html(
                            html_content, message, mailbox
                        )
                        preview_path = save_mail_preview_html(
                            date_header, preview_html
                        )
                    results.append(
                        {
                            "code": code,
                            "mail_time": format_mail_time(date_header),
                            "date": parsed_date,
                            "preview_path": preview_path,
                        }
                    )
    finally:
        try:
            mail.logout()
        except imaplib.IMAP4.error:
            pass

    results.sort(
        key=lambda item: item["date"].timestamp() if item["date"] else 0,
        reverse=True,
    )
    return results


def main():
    print("请输入账号信息，格式：邮箱----邮箱密码----client_id----refresh_token")
    account_info = input("账号信息：").strip()

    try:
        email_user, _email_password, client_id, refresh_token = parse_account(
            account_info
        )
        access_token = get_access_token(client_id, refresh_token)
        verifications = get_chatgpt_verifications(email_user, access_token)
    except (ValueError, RuntimeError, imaplib.IMAP4.error, OSError) as exc:
        print(f"获取失败：{exc}")
        return

    if not verifications:
        print("未在最近的收件箱或垃圾邮件中找到 ChatGPT 验证码邮件。")
        return

    for item in verifications:
        preview = item.get("preview_path")
        preview_text = f"  预览：{preview}" if preview else ""
        print(f"验证码：{item['code']}  邮件时间：{item['mail_time']}{preview_text}")


if __name__ == "__main__":
    main()