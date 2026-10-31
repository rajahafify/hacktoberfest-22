"""Run with: python3 -m unittest discover -s tests -t ."""

import glob
import os
import unittest

from passport import credential
from passport.backends import MockBackend
from passport.normalize import entity_key, parse_number
from passport.pipeline import analyze

SAMPLES = os.path.join(os.path.dirname(__file__), "..", "samples")


def load_samples():
    docs = []
    for path in sorted(glob.glob(os.path.join(SAMPLES, "*.txt"))):
        with open(path, encoding="utf-8") as f:
            docs.append({"name": os.path.basename(path), "text": f.read()})
    return docs


class ParseNumberTests(unittest.TestCase):
    def test_locale_separators(self):
        self.assertEqual(parse_number("1,200,000.00"), 1200000.0)
        self.assertEqual(parse_number("10.050.000.000"), 10050000000.0)
        self.assertEqual(parse_number("95,00"), 95.0)
        self.assertEqual(parse_number("(640,000)"), -640000.0)


class EntityKeyTests(unittest.TestCase):
    def test_suffixes_match_across_registries(self):
        self.assertEqual(entity_key("Kopi Ledger Pte. Ltd."), entity_key("KOPI LEDGER PTE LTD"))


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.report = analyze(load_samples(), MockBackend())

    def test_ubo_resolves_through_holding_company(self):
        subject = self.report["graph"]["subject"]
        ubo = {u["name"]: u for u in self.report["graph"]["ubo"][subject]}
        self.assertAlmostEqual(ubo["AISHA BINTI RAHMAN"]["percent"], 40.0)
        self.assertTrue(ubo["AISHA BINTI RAHMAN"]["is_ubo"])
        self.assertFalse(any(f["title"].startswith("Undisclosed beneficial owners") for f in self.report["findings"]))

    def test_undisclosed_offshore_owner_is_flagged_without_bvi_extract(self):
        docs = [d for d in load_samples() if "09_bvi" not in d["name"]]
        findings = analyze(docs, MockBackend())["findings"]
        self.assertTrue(any(f["title"].startswith("Undisclosed beneficial owners") for f in findings))

    def test_score_within_bounds(self):
        total = self.report["score"]["total"]
        self.assertTrue(0 <= total <= 1000)
        self.assertEqual(sum(p["max"] for p in self.report["score"]["pillars"]), 1000)

    def test_mock_extraction_is_stable(self):
        again = analyze(load_samples(), MockBackend())
        self.assertEqual(self.report["score"]["total"], again["score"]["total"])


class CredentialTests(unittest.TestCase):
    def test_issue_then_verify(self):
        report = analyze(load_samples(), MockBackend())
        vc = report["credential"]
        self.assertTrue(credential.verify(vc)["valid"])

    def test_tampered_score_fails(self):
        vc = analyze(load_samples(), MockBackend())["credential"]
        vc["credentialSubject"]["readinessScore"]["value"] = 990
        self.assertFalse(credential.verify(vc)["valid"])


if __name__ == "__main__":
    unittest.main()
