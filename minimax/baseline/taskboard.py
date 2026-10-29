"""A minimal existing task board. The requested normalization is not implemented."""


def select_tasks(records, status=None):
    """Return matching tasks in original order without modifying the records."""
    return [
        record.copy()
        for record in records
        if status is None or record["status"] == status
    ]
