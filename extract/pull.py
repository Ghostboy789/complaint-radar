"""Pull the CFPB Consumer Complaint Database Narratives Archive once and convert it to Parquet.

Source: CFPB FOIA electronic reading room, "Consumer Complaint Database Narratives Archive"
(complaints received 1 Dec 2011 to 14 Aug 2026). The live bulk file no longer carries the
complaint text, so this archive is the only source used.

Run: python -m extract.pull          (download, convert, write data/MANIFEST.json)
"""
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

import duckdb

import config

BASE_URL = "https://files.consumerfinance.gov/f/documents/"
FILES = [
    "CCDB_Export_1_December_2011_through_April_2018.zip",
    "CCDB_Export_2_May_2018_through_April_2021.zip",
    "CCDB_Export_3_May_2021_through_October_2022.zip",
    "CCDB_Export_4_November_2022_through_August_2023.zip",
    "CCDB_Export_5_September_2023_through_March_2024.zip",
    "CCDB_Export_6_April_2024_through_July_2024.zip",
    "CCDB_Export_7_August_2024_through_October_2024.zip",
    "CCDB_Export_8_November_2024_through_December_2024.zip",
    "CCDB_Export_9_January_2025_through_February_2025.zip",
    "CCDB_Export_10_March_2025_through_April_2025.zip",
    "CCDB_Export_11_May_2025_through_June_2025.zip",
    "CCDB_Export_12_July_2025_through_August_2025.zip",
    "CCDB_Export_13_September_2025_through_October_2025.zip",
    "CCDB_Export_14_November_2025_through_December_2025.zip",
    "CCDB_Export_15_January_2026_through_February_2026.zip",
    "CCDB_Export_16_March_2026.zip",
    "CCDB_Export_17_April_2026.zip",
    "CCDB_Export_18_May_2026.zip",
    "CCDB_Export_19_June_2026.zip",
    "CCDB_Export_20_July_2026.zip",
    "CCDB_Export_21_August_2026.zip",
]
# Source header -> Parquet column. Everything stays text here; dbt staging does the typing.
COLUMNS = {
    "Date received": "date_received",
    "Product": "product",
    "Sub-product": "sub_product",
    "Issue": "issue",
    "Sub-issue": "sub_issue",
    "Consumer complaint narrative": "narrative",
    "Company public response": "company_public_response",
    "Company": "company",
    "State": "state",
    "ZIP code": "zip_code",
    "Tags": "tags",
    "Submitted via": "submitted_via",
    "Date sent to company": "date_sent_to_company",
    "Company response to consumer": "company_response",
    "Timely response?": "timely_response",
    "Complaint ID": "complaint_id",
}
MANIFEST = config.REPO_ROOT / "data" / "MANIFEST.json"


def download(name: str, dest: Path) -> None:
    """Fetch one archive file with curl; skip it when a copy is already on disk.

    curl is used because the file host refuses Python's default client.
    """
    if dest.exists():
        return
    tmp = dest.with_suffix(".tmp")
    cmd = ["curl", "-fsSL", "-C", "-", "--retry", "8", "--retry-all-errors", "-o", str(tmp)]
    subprocess.run([*cmd, BASE_URL + name], check=True)
    tmp.rename(dest)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def csv_to_parquet(csv_path: Path, parquet_path: Path, source_file: str) -> dict:
    """Convert one CSV (quoted, multi-line narratives) to Parquet; return row counts."""
    con = duckdb.connect()
    con.execute(f"SET memory_limit='{config.DUCKDB_MEMORY_LIMIT}'")
    con.execute("SET preserve_insertion_order=false")
    select = ", ".join(f'"{src}" AS {dst}' for src, dst in COLUMNS.items())
    # strict_mode=false: a few narratives carry stray quote characters; the row checks
    # below (numeric id, parseable date) are what guard against a misparse.
    con.execute(
        f"""COPY (
            SELECT {select}, ? AS source_file
            FROM read_csv(?, header=true, all_varchar=true, delim=',', quote='"', escape='"',
                          strict_mode=false, parallel=false, max_line_size=20000000)
        ) TO '{parquet_path}' (FORMAT parquet, COMPRESSION zstd)""",
        [source_file, str(csv_path)],
    )
    rows, bad, with_text = con.execute(
        f"""SELECT count(*),
                   count(*) FILTER (WHERE NOT regexp_full_match(complaint_id, '[0-9]+')
                                    OR try_cast(date_received AS DATE) IS NULL),
                   count(*) FILTER (WHERE narrative IS NOT NULL AND trim(narrative) <> '')
            FROM '{parquet_path}'"""
    ).fetchone()
    return {"rows": rows, "bad_rows": bad, "rows_with_narrative": with_text}


def pull_one(name: str) -> dict:
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    config.PARQUET_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = config.RAW_DIR / name
    download(name, zip_path)
    entry = {"file": name, "url": BASE_URL + name, "bytes": zip_path.stat().st_size,
             "sha256": sha256(zip_path)}
    with zipfile.ZipFile(zip_path) as z:
        (member,) = [m for m in z.namelist() if m.lower().endswith(".csv")]
        csv_path = Path(z.extract(member, config.RAW_DIR / "tmp"))
    part = name.split("_")[2].zfill(2)
    entry["parquet"] = f"complaints_{part}.parquet"
    entry.update(csv_to_parquet(csv_path, config.PARQUET_DIR / entry["parquet"], name))
    csv_path.unlink()
    return entry


def main() -> None:
    entries = []
    for name in FILES:
        entry = pull_one(name)
        print(entry["file"], entry["rows"], "rows,", entry["bad_rows"], "bad", flush=True)
        entries.append(entry)
    manifest = {
        "source": "CFPB Consumer Complaint Database Narratives Archive (FOIA reading room)",
        "files": entries,
        "total_bytes": sum(e["bytes"] for e in entries),
        "total_rows": sum(e["rows"] for e in entries),
        "total_rows_with_narrative": sum(e["rows_with_narrative"] for e in entries),
    }
    MANIFEST.write_text(json.dumps(manifest, indent=1) + "\n")
    print("wrote", MANIFEST.relative_to(config.REPO_ROOT), manifest["total_rows"], "rows")


if __name__ == "__main__":
    main()
