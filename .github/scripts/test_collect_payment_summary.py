"""collect_payment_summary 单元测试（提链已迁至 Node 单账号流程）。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from collect_payment_summary import collect_access_tokens, extract_access_token


class CollectPaymentSummaryTests(unittest.TestCase):
    def test_extract_access_token(self) -> None:
        self.assertEqual(
            extract_access_token("a@b.com----pass----otp----TOKEN----Mon"),
            "TOKEN",
        )
        self.assertIsNone(extract_access_token("a@b.com----only"))

    def test_collect_access_tokens_from_summary_and_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            account = root / "step-summary-0"
            account.mkdir()
            (account / "step-summary").write_text(
                "a@b.com----pass----otp----TOKEN_A----Mon\n",
                encoding="utf-8",
            )
            login = root / "access-token-1"
            login.mkdir()
            (login / "access-token.txt").write_text("TOKEN_B\n", encoding="utf-8")
            tokens = collect_access_tokens(root, ["a@b.com----pass----otp----TOKEN_A----Mon"])
            self.assertEqual(tokens, ["TOKEN_A", "TOKEN_B"])


if __name__ == "__main__":
    unittest.main()
