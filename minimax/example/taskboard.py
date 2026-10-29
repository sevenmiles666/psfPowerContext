"""A minimal task board with normalized status filtering."""


def _normalize_status(status):
    """Normalize a status for whitespace-insensitive, case-folded comparison."""
    return status.strip().casefold()


def select_tasks(records, status=None):
    """Return matching task copies in original order without modifying the records."""
    if status is None:
        return [record.copy() for record in records]

    normalized_status = _normalize_status(status)
    if not normalized_status:
        return []

    return [
        record.copy()
        for record in records
        if _normalize_status(record["status"]) == normalized_status
    ]
