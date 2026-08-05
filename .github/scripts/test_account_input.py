import unittest

from account_input import parse_accounts


class ParseAccountsTest(unittest.TestCase):
    outlook = "outlook@example.com----password----client-id----refresh-token"
    icloud = "icloud@example.com----api-key"

    def test_parses_lf_separated_accounts(self) -> None:
        self.assertEqual(len(parse_accounts(f"{self.outlook}\n{self.icloud}")), 2)

    def test_parses_crlf_and_ignores_blank_records(self) -> None:
        self.assertEqual(len(parse_accounts(f"\r\n{self.outlook}\r\n\r\n{self.icloud}\r\n")), 2)

    def test_parses_semicolon_separated_accounts_from_single_line_input(self) -> None:
        accounts = parse_accounts(f"{self.outlook}; {self.icloud}")
        self.assertEqual(accounts[0][0], "outlook@example.com")
        self.assertEqual(accounts[1], ["icloud@example.com", "api-key"])

    def test_preserves_duplicate_accounts(self) -> None:
        self.assertEqual(len(parse_accounts(f"{self.icloud};{self.icloud}")), 2)

    def test_rejects_an_invalid_nonempty_record(self) -> None:
        with self.assertRaisesRegex(ValueError, "第 2 个账号格式错误"):
            parse_accounts(f"{self.icloud};invalid")

    def test_rejects_empty_input(self) -> None:
        with self.assertRaisesRegex(ValueError, "不能为空"):
            parse_accounts("\n; ;\r\n")


if __name__ == "__main__":
    unittest.main()