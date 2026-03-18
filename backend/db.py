"""
Lakebase Postgres connection pool with Databricks OAuth token rotation.

Uses the Provisioned tier Lakebase API. When running as a Databricks App,
WorkspaceClient authenticates as the app's service principal. The setup job
GRANTs the SP SELECT access on all synced tables.

Token rotation runs every 30 minutes via a background task.
"""

import asyncio
import logging
import os

import asyncpg
from databricks.sdk import WorkspaceClient

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None
_rotation_task: asyncio.Task | None = None

INSTANCE_NAME = os.environ.get("LAKEBASE_INSTANCE", "twins")
PG_DATABASE = os.environ.get("LAKEBASE_DATABASE", "databricks_postgres")

TOKEN_ROTATION_INTERVAL = 30 * 60


def _get_workspace_client() -> WorkspaceClient:
    return WorkspaceClient()


def _get_connection_params(w: WorkspaceClient) -> tuple[str, str, str]:
    """Get host, user, password from the Provisioned Lakebase instance."""
    instance = w.database.get_database_instance(INSTANCE_NAME)
    host = instance.read_write_dns
    if not host:
        raise RuntimeError(f"Instance '{INSTANCE_NAME}' has no read_write_dns — is it running?")

    cred = w.database.generate_database_credential(instance_names=[INSTANCE_NAME])
    user = w.config.client_id or w.current_user.me().user_name

    logger.info("Lakebase connection: host=%s user=%s", host, user)
    return host, user, cred.token


async def init_pool() -> asyncpg.Pool:
    global _pool, _rotation_task

    if _pool is not None:
        return _pool

    w = _get_workspace_client()
    host, user, password = _get_connection_params(w)

    _pool = await asyncpg.create_pool(
        host=host, port=5432, database=PG_DATABASE,
        user=user, password=password, ssl="require",
        min_size=2, max_size=10, command_timeout=120,
    )

    _rotation_task = asyncio.create_task(_rotate_token_loop(w, host, user))
    logger.info("Lakebase pool initialized (min=2, max=10)")
    return _pool


async def _rotate_token_loop(w: WorkspaceClient, host: str, user: str) -> None:
    global _pool

    while True:
        await asyncio.sleep(TOKEN_ROTATION_INTERVAL)
        try:
            logger.info("Rotating Lakebase OAuth token...")
            cred = w.database.generate_database_credential(instance_names=[INSTANCE_NAME])

            old_pool = _pool
            _pool = await asyncpg.create_pool(
                host=host, port=5432, database=PG_DATABASE,
                user=user, password=cred.token, ssl="require",
                min_size=2, max_size=10, command_timeout=120,
            )
            if old_pool:
                await old_pool.close()
            logger.info("OAuth token rotated successfully")
        except Exception:
            logger.exception("Failed to rotate OAuth token — will retry next cycle")


async def get_pool() -> asyncpg.Pool:
    if _pool is None:
        return await init_pool()
    return _pool


async def close_pool() -> None:
    global _pool, _rotation_task
    if _rotation_task:
        _rotation_task.cancel()
        _rotation_task = None
    if _pool:
        await _pool.close()
        _pool = None
        logger.info("Lakebase connection pool closed")
