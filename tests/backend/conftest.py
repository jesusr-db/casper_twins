"""
Shared pytest fixtures for backend tests.

CRITICAL: We must patch `backend.db.init_pool` and `backend.db.close_pool`
at module-import time so that `from backend.main import app` does not trigger
a real Databricks authentication flow. See CLAUDE.md.
"""
from unittest.mock import AsyncMock, patch

import pytest

# Patch pool lifecycle before backend.main is imported anywhere.
_pool_patches = [
    patch("backend.db.init_pool", new=AsyncMock(return_value=None)),
    patch("backend.db.close_pool", new=AsyncMock(return_value=None)),
]
for p in _pool_patches:
    p.start()


@pytest.fixture
def mock_pool():
    """An AsyncMock that stands in for the asyncpg.Pool.

    Individual tests wire up `pool.fetch`, `pool.fetchrow`, `pool.fetchval`
    with pre-canned return values.
    """
    pool = AsyncMock()
    pool.fetch = AsyncMock(return_value=[])
    pool.fetchrow = AsyncMock(return_value=None)
    pool.fetchval = AsyncMock(return_value=True)  # table-exists check default True
    return pool


def sql_dispatch(mapping):
    """Return a function suitable as `AsyncMock.side_effect` that inspects the
    SQL string and returns the first matching mapped value.

    Use this instead of list-based `side_effect` when call ordering depends
    on asyncio scheduling (e.g. when the endpoint uses `asyncio.gather`).

    mapping: dict of {SQL-substring: return_value}. First match wins.
    """
    async def dispatcher(sql, *args, **kwargs):
        for keyword, value in mapping.items():
            if keyword in sql:
                return value
        return []

    return dispatcher


@pytest.fixture
def client(mock_pool):
    """FastAPI TestClient with a mocked DB pool.

    `backend.db.get_pool` is patched to return our `mock_pool` for the
    duration of the test.
    """
    # Import here so pool-lifecycle patches above are already active.
    from fastapi.testclient import TestClient

    from backend import db
    from backend.main import app

    async def _get_pool():
        return mock_pool

    original = db.get_pool
    db.get_pool = _get_pool
    try:
        with TestClient(app) as c:
            yield c
    finally:
        db.get_pool = original
