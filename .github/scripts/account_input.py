import re
from dataclasses import dataclass


ACCOUNT_SEPARATOR = re.compile(r"(?:\r?\n|;)+")
FIELD_SEPARATOR = re.compile(r"-{4,}")
EMAIL_RE = re.compile(r"^\S+@\S+\.\S+$")
_BASE32_RE = re.compile(r"^[A-Z2-7=]+$", re.IGNORECASE)
_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def _is_base32(value: str) -> bool:
    compact = value.replace(" ", "")
    if len(compact) < 10:
        return False
    return bool(_BASE32_RE.match(compact))


def _is_url(value: str) -> bool:
    return bool(_URL_RE.match(value.strip()))


@dataclass
class LoginAccountRecord:
    email: str
    password: str
    otp_secret: str | None = None
    icloud_api_key: str | None = None
    webmail_url: str | None = None
    client_id: str | None = None
    refresh_token: str | None = None

    @property
    def has_inline_mail(self) -> bool:
        return bool(
            self.icloud_api_key
            or self.webmail_url
            or (self.client_id and self.refresh_token)
        )


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


def _parse_login_fields(fields: list[str], index: int) -> LoginAccountRecord:
    email, password = fields[0], fields[1]
    if not EMAIL_RE.match(email):
        raise ValueError(f"第 {index} 个登录邮箱格式错误")
    if not password:
        raise ValueError(f"第 {index} 个登录密码为空")

    if len(fields) >= 5:
        third = fields[2].replace(" ", "")
        if _is_base32(third):
            return LoginAccountRecord(email=email, password=password, otp_secret=third)
        otp = fields[4].replace(" ", "")
        if not _is_base32(otp):
            raise ValueError(f"第 {index} 个账号第五段应为 Base32 2FA 密钥")
        return LoginAccountRecord(
            email=email,
            password=password,
            otp_secret=otp,
            client_id=fields[2],
            refresh_token=fields[3],
        )

    if len(fields) == 4:
        third, fourth = fields[2], fields[3]
        if _is_base32(third):
            return LoginAccountRecord(email=email, password=password, otp_secret=third.replace(" ", ""))
        if _is_base32(fourth):
            pickup = third
            if _is_url(pickup):
                return LoginAccountRecord(
                    email=email,
                    password=password,
                    otp_secret=fourth.replace(" ", ""),
                    webmail_url=pickup,
                )
            return LoginAccountRecord(
                email=email,
                password=password,
                otp_secret=fourth.replace(" ", ""),
                icloud_api_key=pickup,
            )
        return LoginAccountRecord(
            email=email,
            password=password,
            client_id=third,
            refresh_token=fourth,
        )

    third = fields[2]
    if _is_base32(third):
        return LoginAccountRecord(email=email, password=password, otp_secret=third.replace(" ", ""))
    if _is_url(third):
        return LoginAccountRecord(email=email, password=password, webmail_url=third)
    return LoginAccountRecord(email=email, password=password, icloud_api_key=third)


def parse_login_accounts(value: str) -> list[LoginAccountRecord]:
    """解析登录/绑定手机账号。

    与注册相同的取件格式（单邮箱 / 两字段 / Outlook 四字段），
    并额外支持 email----password----2fa 及取件 + 2FA 组合。
    """
    records = [record.strip() for record in ACCOUNT_SEPARATOR.split(value) if record.strip()]
    if not records:
        raise ValueError("accounts 输入不能为空")

    accounts: list[LoginAccountRecord] = []
    for index, record in enumerate(records, 1):
        fields = [field.strip() for field in FIELD_SEPARATOR.split(record) if field.strip()]

        if len(fields) == 1:
            if not EMAIL_RE.match(fields[0]):
                raise ValueError(f"第 {index} 个邮箱格式错误")
            accounts.append(LoginAccountRecord(email=fields[0], password=""))
            continue

        if len(fields) == 2:
            if not EMAIL_RE.match(fields[0]):
                raise ValueError(f"第 {index} 个邮箱格式错误")
            if not fields[1]:
                raise ValueError(f"第 {index} 个取件字段为空")
            pickup = fields[1]
            if _is_url(pickup):
                accounts.append(
                    LoginAccountRecord(email=fields[0], password="", webmail_url=pickup)
                )
            else:
                accounts.append(
                    LoginAccountRecord(email=fields[0], password="", icloud_api_key=pickup)
                )
            continue

        if len(fields) == 4:
            third, fourth = fields[2], fields[3]
            if not _is_base32(third) and not _is_base32(fourth):
                if not EMAIL_RE.match(fields[0]):
                    raise ValueError(f"第 {index} 个邮箱格式错误")
                if any(not field for field in fields):
                    raise ValueError(f"第 {index} 个 Outlook 取件四字段不完整")
                accounts.append(
                    LoginAccountRecord(
                        email=fields[0],
                        password=fields[1],
                        client_id=third,
                        refresh_token=fourth,
                    )
                )
                continue

        if len(fields) < 3:
            raise ValueError(
                f"第 {index} 个账号格式错误；"
                "支持单邮箱、两字段取件、Outlook 四字段，或 email----password----2fa"
            )
        accounts.append(_parse_login_fields(fields, index))
    return accounts


def split_account_records(value: str) -> list[str]:
    return [record.strip() for record in ACCOUNT_SEPARATOR.split(value) if record.strip()]


def apply_login_account_env(
    env_file,
    raw_line: str,
    record: LoginAccountRecord,
    forwarding_emails: list[str],
    mailboxes_text: str,
) -> None:
    """写入登录/绑定手机 job 所需环境变量（含取件凭据）。"""
    env_file.write(f"CHATGPT_LOGIN<<__LOGIN_VALUE__\n{raw_line}\n__LOGIN_VALUE__\n")
    env_file.write(f"ACCOUNT_EMAIL<<__EMAIL_VALUE__\n{record.email}\n__EMAIL_VALUE__\n")
    env_file.write(f"EMAIL<<__EMAIL_VALUE__\n{record.email}\n__EMAIL_VALUE__\n")

    if record.webmail_url:
        print(f"::add-mask::{record.webmail_url}")
        env_file.write(
            f"ICLOUD_API_KEY<<__ACCOUNT_VALUE__\n{record.webmail_url}\n__ACCOUNT_VALUE__\n"
        )
    elif record.icloud_api_key:
        print(f"::add-mask::{record.icloud_api_key}")
        env_file.write(
            f"ICLOUD_API_KEY<<__ACCOUNT_VALUE__\n{record.icloud_api_key}\n__ACCOUNT_VALUE__\n"
        )
    elif record.client_id and record.refresh_token:
        print(f"::add-mask::{record.client_id}")
        print(f"::add-mask::{record.refresh_token}")
        if record.password:
            print(f"::add-mask::{record.password}")
            env_file.write(
                f"EMAIL_PASSWORD<<__ACCOUNT_VALUE__\n{record.password}\n__ACCOUNT_VALUE__\n"
            )
        env_file.write(f"CLIENT_ID<<__ACCOUNT_VALUE__\n{record.client_id}\n__ACCOUNT_VALUE__\n")
        env_file.write(
            f"REFRESH_TOKEN<<__ACCOUNT_VALUE__\n{record.refresh_token}\n__ACCOUNT_VALUE__\n"
        )
    elif forwarding_emails:
        mailbox = resolve_forward_mailbox(forwarding_emails, mailboxes_text)
        for name, value in {
            "MAILBOX_EMAIL": mailbox[0],
            "EMAIL_PASSWORD": mailbox[1],
            "CLIENT_ID": mailbox[2],
            "REFRESH_TOKEN": mailbox[3],
        }.items():
            print(f"::add-mask::{value}")
            env_file.write(f"{name}<<__ACCOUNT_VALUE__\n{value}\n__ACCOUNT_VALUE__\n")
