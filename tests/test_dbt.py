from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.contracts import check_mart, load_contracts

REPO_ROOT = Path(__file__).resolve().parents[1]
DBT_DIR = REPO_ROOT / "dbt"
CONTRACTS_PATH = REPO_ROOT / "CONTRACTS.md"


@pytest.fixture(scope="module")
def built_marts(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("dbt_run")
    marts_dir = tmp / "marts_out"
    db_path = tmp / "db.duckdb"
    tmp_dir = tmp / "tmp"
    marts_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["CR_RAW_GLOB"] = str(
        REPO_ROOT / "tests" / "fixtures" / "raw_sample" / "complaints_*.parquet"
    )
    env["CR_MARTS_DIR"] = str(marts_dir)
    env["CR_DUCKDB_PATH"] = str(db_path)
    env["CR_TMP_DIR"] = str(tmp_dir)

    dbt_bin = REPO_ROOT / ".venv" / "bin" / "dbt"
    if not dbt_bin.exists():
        found = shutil.which("dbt")
        if found is None:
            raise AssertionError("dbt executable not found")
        dbt_bin = Path(found)
    cmd = [str(dbt_bin), "build", "--profiles-dir", "."]
    proc = subprocess.run(cmd, cwd=str(DBT_DIR), env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        raise AssertionError(
            f"dbt build failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )

    return marts_dir


def test_dbt_build_succeeds(built_marts):
    assert built_marts.exists()


@pytest.mark.parametrize("mart_name", list(load_contracts(CONTRACTS_PATH).keys()))
def test_mart_contract(built_marts, mart_name):
    parquet = built_marts / f"{mart_name}.parquet"
    if not parquet.exists():
        raise AssertionError(f"Mart Parquet file not produced: {parquet.name}")
    check_mart(mart_name, parquet, contracts_path=CONTRACTS_PATH)
