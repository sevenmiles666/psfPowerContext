import unittest

from taskboard import select_tasks


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.records = [
            {"id": 1, "status": "pending"},
            {"id": 2, "status": "done"},
            {"id": 3, "status": "done"},
        ]

    def test_none_returns_all(self):
        self.assertEqual(select_tasks(self.records), self.records)

    def test_exact_filter_and_order(self):
        self.assertEqual([x["id"] for x in select_tasks(self.records, "done")], [2, 3])

    def test_empty_and_unknown(self):
        self.assertEqual(select_tasks(self.records, ""), [])
        self.assertEqual(select_tasks(self.records, "missing"), [])

    def test_returns_copies(self):
        result = select_tasks(self.records, "done")
        result[0]["status"] = "changed"
        self.assertEqual(self.records[1]["status"], "done")


if __name__ == "__main__":
    unittest.main()
