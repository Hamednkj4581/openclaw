import re


ACCOUNT_SEPARATOR = re.compile(r"(?:\r?\n|;)+")
FIELD_SEPARATOR = re.compile(r"-{4,}")
EMAIL_RE = re.compile(r"^\S+@\S+\.\S+$")


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
