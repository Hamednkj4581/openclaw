"""collect_payment_summary 单元测试。"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from collect_payment_summary import (
    collect_access_tokens,
    extract_access_token,
    filter_eligible_tokens,
    pick_payment_link,
)


class CollectPaymentSummaryTests(unittest.TestCase):
    def test_extract_access_token(self) -> None:
        self.assertEqual(
            extract_access_token("a@b.com----pass----otp----TOKEN----Mon"),
            "TOKEN",
        )
        self.assertIsNone(extract_access_token("a@b.com----only"))

    def test_pick_payment_link_priority(self) -> None:
        self.assertEqual(
            pick_payment_link(
                {
                    "gcash_url": "https://gcash",
                    "provider_redirect_url": "https://provider",
                    "long_url": "https://long",
                }
            ),
            "https://gcash",
        )
        self.assertEqual(
            pick_payment_link({"provider_redirect_url": "https://provider", "long_url": "https://long"}),
            "https://provider",
        )
        self.assertEqual(pick_payment_link({"long_url": "https://long"}), "https://long")
        self.assertEqual(pick_payment_link({}), "")

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

    def test_filter_eligible_tokens(self) -> None:
        tokens = ["t0", "t1", "t2"]
        with mock.patch(
            "collect_payment_summary.http_json",
            return_value={
                "results": [
                    {"index": 0, "eligible": True, "state": "eligible"},
                    {"index": 1, "eligible": False, "state": "ineligible"},
                    {"index": 2, "eligible": True, "state": "eligible", "error": "x"},
                ]
            },
        ):
            self.assertEqual(filter_eligible_tokens(tokens), ["t0"])


if __name__ == "__main__":
    unittest.main()
