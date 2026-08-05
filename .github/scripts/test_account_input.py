import unittest

from account_input import (
    parse_accounts,
    parse_email_list,
    parse_outlook_mailboxes,
    resolve_forward_mailbox,
)


class ParseAccountsTest(unittest.TestCase):
    outlook = "outlook@example.com----password----client-id----refresh-token"
    icloud = "icloud@example.com----api-key"
    single = "alias@example.com"

    def test_parses_lf_separated_accounts(self) -> None:
        self.assertEqual(len(parse_accounts(f"{self.outlook}\n{self.icloud}")), 2)

    def test_parses_crlf_and_ignores_blank_records(self) -> None:
        self.assertEqual(len(parse_accounts(f"\r\n{self.outlook}\r\n\r\n{self.icloud}\r\n")), 2)

    def test_parses_semicolon_separated_accounts_from_single_line_input(self) -> None:
        accounts = parse_accounts(f"{self.outlook}; {self.icloud}")
        self.assertEqual(accounts[0][0], "outlook@example.com")
        self.assertEqual(accounts[1], ["icloud@example.com", "api-key"])

    def test_parses_single_email_accounts(self) -> None:
        accounts = parse_accounts(f"{self.single}\n{self.outlook}")
        self.assertEqual(accounts[0], ["alias@example.com"])
        self.assertEqual(len(accounts[1]), 4)

    def test_preserves_duplicate_accounts(self) -> None:
        self.assertEqual(len(parse_accounts(f"{self.icloud};{self.icloud}")), 2)

    def test_rejects_an_invalid_nonempty_record(self) -> None:
        with self.assertRaisesRegex(ValueError, "第 2 个账号格式错误"):
            parse_accounts(f"{self.icloud};invalid")

    def test_rejects_empty_input(self) -> None:
        with self.assertRaisesRegex(ValueError, "不能为空"):
            parse_accounts("\n; ;\r\n")


class ForwardMailboxTest(unittest.TestCase):
    mailbox = (
        "TimmothyBegan9059@hotmail.com----password----"
        "client-id----refresh-token"
    )

    def test_parses_forwarding_email_list(self) -> None:
        self.assertEqual(
            parse_email_list("TimmothyBegan9059@hotmail.com"),
            ["TimmothyBegan9059@hotmail.com"],
        )

    def test_resolves_single_forward_mailbox(self) -> None:
        fields = resolve_forward_mailbox(["TimmothyBegan9059@hotmail.com"], self.mailbox)
        self.assertEqual(fields[0], "TimmothyBegan9059@hotmail.com")
        self.assertEqual(fields[2], "client-id")

    def test_rejects_missing_forward_mailbox_config(self) -> None:
        with self.assertRaisesRegex(ValueError, "找不到转发邮箱配置"):
            resolve_forward_mailbox(["missing@hotmail.com"], self.mailbox)

    def test_rejects_multiple_forwarding_emails_for_now(self) -> None:
        with self.assertRaisesRegex(ValueError, "仅支持配置一个转发邮箱"):
            resolve_forward_mailbox(
                ["a@hotmail.com", "b@hotmail.com"],
                self.mailbox,
            )

    def test_parse_outlook_mailboxes_indexes_by_email(self) -> None:
        mailboxes = parse_outlook_mailboxes(self.mailbox)
        self.assertIn("timmothybegan9059@hotmail.com", mailboxes)


if __name__ == "__main__":
    unittest.main()
