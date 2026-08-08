import re
from dataclasses import dataclass


ACCOUNT_SEPARATOR = re.compile(r"(?:\r?\n|;)+")
FIELD_SEPARATOR = re.compile(r"-{4,}")
EMAIL_RE = re.compile(r"^\S+@\S+\.\S+$")
_BASE32_RE = re.compile(r"^[A-Z2-7=]+$", re.IGNORECASE)


def _is_base32(value: str) -> bool:
    compact = value.replace(" ", "")
    if len(compact) < 10:
        return False
    return bool(_BASE32_RE.match(compact))


def split_record_fields(record: str) -> list[str]:
    return [field.strip() for field in FIELD_SEPARATOR.split(record) if field.strip()]


def is_login_totp_record(fields: list[str]) -> bool:
    """登录/绑定手机专有：email----password----2fa（第三段 Base32；其后可跟注册结果尾字段）。"""
    return len(fields) >= 3 and _is_base32(fields[2])


def parse_accounts(value: str) -> list[list[str]]:
    """Parse newline- or semicolon-separated workflow account records.

    Supported per record:
    - 1 field: registration email only (read mail via forwarding mailbox)
    - 2 fields: iCloud / web-mail pickup
    - 4 fields: Outlook OAuth mailbox
    """
    records = [record.strip() for record in ACCOUNT_SEPARATOR.split(value) if record.strip()]
    if not records:
        raise ValueError("accounts 输入不能为空")

    accounts: list[list[str]] = []
    for index, record in enumerate(records, 1):
        fields = [field.strip() for field in FIELD_SEPARATOR.split(record)]
        if len(fields) == 1 and EMAIL_RE.match(fields[0]):
            accounts.append(fields)
            continue
        if len(fields) not in (2, 4) or any(not field for field in fields):
            raise ValueError(
                f"第 {index} 个账号格式错误，必须是单邮箱、iCloud（API Key/网页取件链接）"
                "2 字段或 Outlook 4 字段格式；多个账号请用分号分隔"
            )
        if len(fields) in (2, 4) and not EMAIL_RE.match(fields[0]):
            raise ValueError(f"第 {index} 个账号邮箱格式错误")
        accounts.append(fields)

    return accounts


def parse_email_list(value: str) -> list[str]:
    """Parse newline- or semicolon-separated bare email addresses."""
    records = [record.strip() for record in ACCOUNT_SEPARATOR.split(value or "") if record.strip()]
    emails: list[str] = []
    for index, record in enumerate(records, 1):
        if FIELD_SEPARATOR.search(record) or not EMAIL_RE.match(record):
            raise ValueError(f"第 {index} 个转发邮箱格式错误，每行只能是一个邮箱地址")
        emails.append(record)
    return emails


def parse_outlook_mailboxes(value: str) -> dict[str, list[str]]:
    """Parse Outlook mailbox credential lines into email(lower) -> 4 fields."""
    records = [record.strip() for record in ACCOUNT_SEPARATOR.split(value or "") if record.strip()]
    if not records:
        raise ValueError("FORWARD_MAILBOXES 不能为空")

    mailboxes: dict[str, list[str]] = {}
    for index, record in enumerate(records, 1):
        fields = [field.strip() for field in FIELD_SEPARATOR.split(record)]
        if len(fields) != 4 or any(not field for field in fields) or not EMAIL_RE.match(fields[0]):
            raise ValueError(
                f"FORWARD_MAILBOXES 第 {index} 行格式错误，"
                "必须是 邮箱----密码----client_id----refresh_token"
            )
        mailboxes[fields[0].lower()] = fields
    return mailboxes


def resolve_forward_mailbox(forwarding_emails: list[str], mailboxes_text: str) -> list[str]:
    """Resolve the single configured forwarding mailbox credentials."""
    if len(forwarding_emails) != 1:
        raise ValueError("单邮箱账号目前仅支持配置一个转发邮箱")
    target = forwarding_emails[0]
    mailboxes = parse_outlook_mailboxes(mailboxes_text)
    fields = mailboxes.get(target.lower())
    if not fields:
        raise ValueError(f"FORWARD_MAILBOXES 中找不到转发邮箱配置：{target}")
    return fields


@dataclass
class LoginAccountRecord:
    email: str
    chatgpt_password: str = ""
    otp_secret: str | None = None
    register_fields: list[str] | None = None

    @property
    def has_inline_mail(self) -> bool:
        return bool(self.register_fields and len(self.register_fields) in (2, 4))


def parse_login_accounts(value: str) -> list[LoginAccountRecord]:
    """登录/绑定手机：复用 parse_accounts 的取件格式，额外支持 email----password----2fa。"""
    records = [record.strip() for record in ACCOUNT_SEPARATOR.split(value) if record.strip()]
    if not records:
        raise ValueError("accounts 输入不能为空")

    accounts: list[LoginAccountRecord] = []
    for index, record in enumerate(records, 1):
        fields = split_record_fields(record)
        if is_login_totp_record(fields):
            email, password, otp = fields[0], fields[1], fields[2].replace(" ", "")
            if not EMAIL_RE.match(email):
                raise ValueError(f"第 {index} 个登录邮箱格式错误")
            if not password:
                raise ValueError(f"第 {index} 个登录密码为空")
            accounts.append(
                LoginAccountRecord(email=email, chatgpt_password=password, otp_secret=otp)
            )
            continue

        register_rows = parse_accounts(record)
        if len(register_rows) != 1:
            raise ValueError(f"第 {index} 个账号格式错误")
        reg_fields = register_rows[0]
        accounts.append(
            LoginAccountRecord(email=reg_fields[0], register_fields=reg_fields)
        )
    return accounts


def split_account_records(value: str) -> list[str]:
    return [record.strip() for record in ACCOUNT_SEPARATOR.split(value) if record.strip()]


def apply_account_mail_env(
    env_file,
    fields: list[str],
    forwarding_emails: list[str],
    mailboxes_text: str,
) -> dict[str, str]:
    """写入注册/登录共用的取件环境变量（与 chatgpt-task 注册分支一致）。"""
    if len(fields) == 1:
        mailbox = resolve_forward_mailbox(forwarding_emails, mailboxes_text)
        values = {
            "EMAIL": fields[0],
            "MAILBOX_EMAIL": mailbox[0],
            "EMAIL_PASSWORD": mailbox[1],
            "CLIENT_ID": mailbox[2],
            "REFRESH_TOKEN": mailbox[3],
        }
    elif len(fields) == 2:
        values = {"EMAIL": fields[0], "ICLOUD_API_KEY": fields[1]}
    else:
        values = {
            "EMAIL": fields[0],
            "EMAIL_PASSWORD": fields[1],
            "CLIENT_ID": fields[2],
            "REFRESH_TOKEN": fields[3],
        }
    for name, value in values.items():
        print(f"::add-mask::{value}")
        env_file.write(f"{name}<<__ACCOUNT_VALUE__\n{value}\n__ACCOUNT_VALUE__\n")
    return values


def apply_login_account_env(
    env_file,
    raw_line: str,
    record: LoginAccountRecord,
    forwarding_emails: list[str],
    mailboxes_text: str,
) -> None:
    """写入登录/绑定手机 job 环境变量。"""
    env_file.write(f"CHATGPT_LOGIN<<__LOGIN_VALUE__\n{raw_line}\n__LOGIN_VALUE__\n")
    env_file.write(f"ACCOUNT_EMAIL<<__EMAIL_VALUE__\n{record.email}\n__EMAIL_VALUE__\n")
    env_file.write(f"EMAIL<<__EMAIL_VALUE__\n{record.email}\n__EMAIL_VALUE__\n")

    if record.register_fields:
        if len(record.register_fields) == 1:
            if not forwarding_emails:
                raise ValueError("存在单邮箱账号时必须配置 forwarding_emails")
            apply_account_mail_env(env_file, record.register_fields, forwarding_emails, mailboxes_text)
        else:
            apply_account_mail_env(env_file, record.register_fields, forwarding_emails, mailboxes_text)
