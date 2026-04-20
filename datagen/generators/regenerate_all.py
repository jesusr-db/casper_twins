#!/usr/bin/env python3
# Ported from caspers-kitchens at commit 8c756ac on 2026-04-20.
# Caspers is retired — this is now the authoritative copy.
# Modifying this file is a twins-internal decision.

"""
One-shot script to regenerate all Domino's Digital Twin parquet files.
Run from the data/canonical/ directory.

Usage:
    cd data/canonical
    python3 regenerate_all.py
"""

import subprocess
import sys
import time

scripts = [
    ("generate_dimensions.py", "Generating dimension tables (~88 locations)..."),
    ("generate_canonical_dataset.py", "Generating event dataset (~200K orders, ~2.5M events)..."),
]

for script, msg in scripts:
    print(f"\n{'='*60}")
    print(f"  {msg}")
    print(f"{'='*60}\n")
    t0 = time.time()
    result = subprocess.run([sys.executable, script], cwd=".")
    elapsed = time.time() - t0
    if result.returncode != 0:
        print(f"\nFAILED: {script} (exit code {result.returncode})")
        sys.exit(1)
    print(f"\n  Completed in {elapsed:.1f}s")

print(f"\n{'='*60}")
print("  All datasets regenerated successfully!")
print(f"{'='*60}")
