"""Project paths. Every script reads data through DATA_ROOT, never a relative path."""
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
DATA_ROOT = Path(os.environ.get("COMPLAINT_RADAR_DATA_ROOT", REPO_ROOT))
RAW_DIR = DATA_ROOT / "data" / "raw"
PARQUET_DIR = DATA_ROOT / "data" / "parquet"
MARTS_DIR = DATA_ROOT / "marts_out"
MODELS_DIR = DATA_ROOT / "models_out"
ARTEFACTS_DIR = REPO_ROOT / "artefacts"
DUCKDB_MEMORY_LIMIT = os.environ.get("COMPLAINT_RADAR_MEMORY_LIMIT", "4GB")
