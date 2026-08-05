import re


ACCOUNT_SEPARATOR = re.compile(r"(?:\r?\n|;)+")
FIELD_SEPARATOR = re.compile(r"-{4,}")


def parse_accounts(value: str) -> list[list[str]]:
    """Parse newline- or semicolon-separated workflow account records."""
    records = [record.strip() for record in ACCOUNT_SEPARATOR.split(value) if record.strip()]
    if not records:
        raise ValueError("accounts 输入不能为空")

    accounts: list[list[str]] = []
    for index, record in enumerate(records, 1):
        fields = [field.strip() for field in FIELD_SEPARATOR.split(record)]
        if len(fields) not in (2, 4) or any(not field for field in fields):
            raise ValueError(
                f"第 {index} 个账号格式错误，必须是 iCloud（API Key/网页取件链接）"
                "2 字段或 Outlook 4 字段格式；多个账号请用分号分隔"
            )
        accounts.append(fields)

    return accounts