# Task board specification · revision 2

STATUS-001: `select_tasks(records, status=None)` must compare a supplied status
after stripping surrounding whitespace and applying Unicode case folding.
The status stored on each record must be normalized for comparison in the same way.
The returned records retain their original values and input order.

STATUS-002: `status=None` returns all records. An empty or unknown status matches
no records. Existing exact status filtering continues to work.

STATUS-003: `select_tasks` returns copies of matching dictionaries and never
mutates the caller's list or records.

Relevant implementation: `taskboard.py::select_tasks`.
Compatibility tests: `test_taskboard.py`. Target behavior: `test_target.py`.

Revision history: revision 1 compared status strings literally; revision 2 adds
whitespace handling and Unicode case folding. The baseline intentionally still
implements revision 1 so the same target tests demonstrate a real behavior failure.
