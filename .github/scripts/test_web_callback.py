import unittest

from web_callback import (
    extract_access_token_from_file,
    extract_access_token_from_session,
    extract_access_token_from_summary,
    extract_email,
)


class WebCallbackTests(unittest.TestCase):
    def test_extract_email(self) -> None:
        self.assertEqual(extract_email("a@b.com----x----y"), "a@b.com")

    def test_extract_token_from_summary(self) -> None:
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "step-summary"
            path.write_text(
                "a@b.com----pass----otp----ACCESS_TOKEN_VALUE----Mon Jan 1\n",
                encoding="utf-8",
            )
            self.assertEqual(extract_access_token_from_summary(str(path)), "ACCESS_TOKEN_VALUE")

    def test_extract_token_from_session(self) -> None:
        import json
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.json"
            path.write_text(json.dumps({"accessToken": "SESSION_TOKEN"}), encoding="utf-8")
            self.assertEqual(extract_access_token_from_session(str(path)), "SESSION_TOKEN")

    def test_extract_token_from_file(self) -> None:
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "access-token.txt"
            path.write_text("FILE_TOKEN\n", encoding="utf-8")
            self.assertEqual(extract_access_token_from_file(str(path)), "FILE_TOKEN")


if __name__ == "__main__":
    unittest.main()
