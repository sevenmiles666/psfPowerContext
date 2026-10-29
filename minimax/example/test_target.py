import unittest

from taskboard import select_tasks


class NewBehaviorTests(unittest.TestCase):
    def test_query_case_and_whitespace(self):
        records = [{"id": 1, "status": "pending"}, {"id": 2, "status": "done"}]
        self.assertEqual(select_tasks(records, " DONE "), [{"id": 2, "status": "done"}])

    def test_stored_case_and_whitespace(self):
        records = [{"id": 1, "status": " DONE "}, {"id": 2, "status": "pending"}]
        self.assertEqual(select_tasks(records, "done"), [{"id": 1, "status": " DONE "}])

    def test_unicode_casefold(self):
        records = [{"id": 1, "status": "Straße"}, {"id": 2, "status": "other"}]
        self.assertEqual(
            select_tasks(records, " STRASSE "), [{"id": 1, "status": "Straße"}]
        )


if __name__ == "__main__":
    unittest.main()
