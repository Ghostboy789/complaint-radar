import json

import duckdb
import pytest

import config
from extract import pull


def test_csv_to_parquet_keeps_multiline_narratives(tmp_path):
    header = ",".join(f'"{c}"' if "," in c else c for c in pull.COLUMNS)
    rows = [
        '2020-01-02,Mortgage,,Issue A,,"line one\nline two, with a ""quote""",,'
        "BANK A,CA,90001,,Web,2020-01-02,Closed,Yes,101",
        "2020-01-03,Debt collection,,Issue B,,,,BANK B,NY,10001,,Web,2020-01-03,Closed,Yes,102",
    ]
    src = tmp_path / "in.csv"
    src.write_text(header + "\n" + "\n".join(rows) + "\n")
    out = tmp_path / "out.parquet"
    counts = pull.csv_to_parquet(src, out, "in.zip")
    assert counts == {"rows": 2, "bad_rows": 0, "rows_with_narrative": 1}
    got = duckdb.execute(f"SELECT narrative, source_file FROM '{out}' WHERE complaint_id = '101'")
    assert got.fetchone() == ('line one\nline two, with a "quote"', "in.zip")
    cols = [r[0] for r in duckdb.execute(f"DESCRIBE SELECT * FROM '{out}'").fetchall()]
    assert cols == [*pull.COLUMNS.values(), "source_file"]


@pytest.mark.fulldata
def test_parquet_matches_manifest():
    manifest = json.loads(pull.MANIFEST.read_text())
    assert [e["file"] for e in manifest["files"]] == pull.FILES
    for e in manifest["files"]:
        path = config.PARQUET_DIR / e["parquet"]
        n = duckdb.execute(f"SELECT count(*) FROM '{path}'").fetchone()[0]
        assert n == e["rows"], e["file"]
        assert e["bad_rows"] == 0, e["file"]
