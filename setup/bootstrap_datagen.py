"""Task 0 — Generate seed data (events.parquet + dim parquets) into a UC Volume.

Runs ahead of canonical_data.ipynb in the setup-lakebase job. Idempotent
via a `.seed-complete` marker file in the destination volume.

Design note: the caspers generators (`generate_dimensions.py`,
`generate_canonical_dataset.py`) are designed to run from a `data/canonical/`
directory where `canonical_dataset/` is a sibling subdirectory. They read
and write via relative paths (`canonical_dataset/locations.parquet`, etc.)
rather than accepting a `--out-dir` argument. To keep the vendored
generators nearly verbatim, this bootstrap:

  1. Creates a local scratch directory with a `canonical_dataset/` subdir.
  2. Chdir's into the scratch directory.
  3. Invokes `regenerate_all.py`, which in turn runs each generator
     with the scratch directory as its cwd.
  4. Uploads the produced parquets from the scratch `canonical_dataset/`
     to the target UC Volume via the Databricks SDK.
  5. Writes a `.seed-complete` marker to the volume.

Invoked by: setup-lakebase job, `bootstrap_datagen` task.
"""

import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from databricks.sdk import WorkspaceClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("bootstrap_datagen")

CATALOG = "vdm_classic_rikfy0_catalog"
SCHEMA = "simulator"
SEED_VOLUME = "canonical_seed"
SEED_VOLUME_PATH = f"/Volumes/{CATALOG}/{SCHEMA}/{SEED_VOLUME}"
MARKER_PATH = f"{SEED_VOLUME_PATH}/.seed-complete"

# Generator source lives at /Workspace/.../files/datagen/generators/ when the
# bundle is deployed. Resolve relative to this file.
REPO_ROOT = Path(__file__).resolve().parent.parent
GENERATORS_DIR = REPO_ROOT / "datagen" / "generators"

# Parquets we expect the generators to produce (relative to their canonical_dataset/ subdir).
EXPECTED_PARQUETS = [
    "locations.parquet",
    "brands.parquet",
    "brand_locations.parquet",
    "menus.parquet",
    "categories.parquet",
    "items.parquet",
    "events.parquet",
    "orders.parquet",
]


def marker_exists(w: WorkspaceClient) -> bool:
    """Check the idempotency marker via the Files API."""
    try:
        w.files.get_metadata(MARKER_PATH)
        return True
    except Exception:
        return False


def write_marker(w: WorkspaceClient) -> None:
    """Write the idempotency marker to the volume."""
    import io
    w.files.upload(MARKER_PATH, contents=io.BytesIO(b"complete\n"), overwrite=True)
    log.info("Marker written: %s", MARKER_PATH)


def upload_file(w: WorkspaceClient, local_path: Path, volume_path: str) -> None:
    """Upload a single local file to the UC Volume, overwriting if present."""
    with open(local_path, "rb") as f:
        w.files.upload(volume_path, contents=f, overwrite=True)


def main() -> None:
    log.info("=" * 60)
    log.info("bootstrap_datagen — seed data generation")
    log.info("=" * 60)

    w = WorkspaceClient()

    if marker_exists(w):
        log.info("Marker %s present — skipping (idempotent).", MARKER_PATH)
        return

    log.info("No marker found; generating seed data...")

    # Ensure the target volume directory exists. UC Volumes auto-create
    # subdirectories on file upload, so no explicit mkdir is required.

    with tempfile.TemporaryDirectory(prefix="twins-datagen-") as scratch:
        scratch_path = Path(scratch)
        canonical_dir = scratch_path / "canonical_dataset"
        canonical_dir.mkdir()

        log.info("Staging dir: %s", scratch_path)
        log.info("Running generators via %s", GENERATORS_DIR / "regenerate_all.py")

        # Copy generator scripts into the scratch dir so regenerate_all.py's
        # sibling-relative subprocess.run([..., cwd=".")] pattern works.
        for script in ("generate_dimensions.py", "generate_canonical_dataset.py", "regenerate_all.py"):
            import shutil
            shutil.copy(GENERATORS_DIR / script, scratch_path / script)

        result = subprocess.run(
            [sys.executable, str(scratch_path / "regenerate_all.py")],
            cwd=str(scratch_path),
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            log.error("Generator failed (exit %d):", result.returncode)
            log.error("stdout:\n%s", result.stdout)
            log.error("stderr:\n%s", result.stderr)
            raise RuntimeError("regenerate_all.py failed")

        log.info("Generator succeeded. stdout tail:\n%s", result.stdout[-2000:])

        # Upload each expected parquet to the volume.
        for parquet_name in EXPECTED_PARQUETS:
            local_file = canonical_dir / parquet_name
            if not local_file.exists():
                log.warning("Expected parquet missing (skipping): %s", parquet_name)
                continue
            volume_dest = f"{SEED_VOLUME_PATH}/{parquet_name}"
            log.info("Uploading %s (%d bytes) -> %s",
                     parquet_name, local_file.stat().st_size, volume_dest)
            upload_file(w, local_file, volume_dest)

    write_marker(w)
    log.info("bootstrap_datagen complete.")


if __name__ == "__main__":
    main()
