"""Contract and determinism checks for the descriptive tables on a tiny synthetic corpus."""
from __future__ import annotations

import csv
import json
from datetime import date, timedelta
from pathlib import Path

import duckdb
import pytest

import config
from analysis import descriptive
from analysis.stats_util import wilson

PRODUCT_GROUPS_PATH = config.REPO_ROOT / "dbt" / "seeds" / "product_groups.csv"


def _write_mart(path: Path, create_sql: str, rows: list[tuple]) -> None:
    con = duckdb.connect()
    try:
        con.execute(create_sql)
        if rows:
            placeholders = ", ".join(["?"] * len(rows[0]))
            con.executemany(f"INSERT INTO data VALUES ({placeholders})", rows)
        target = str(path).replace("'", "''")
        con.execute(f"COPY data TO '{target}' (FORMAT parquet)")
    finally:
        con.close()


def _fct_rows() -> list[tuple]:
    rows = []
    for index in range(50):
        if index < 25:
            company = "Alpha Co"
        elif index < 40:
            company = "Beta Co"
        elif index < 45:
            company = "Gamma Co"
        else:
            company = "Delta Co"
        if index < 20:
            received = date(2024, 1, 1) + timedelta(days=index)
        else:
            received = date(2025, 12, 2) + timedelta(days=(index - 20) % 30)
        rows.append(
            (
                index + 1,
                received,
                received - timedelta(days=received.weekday()),
                received.replace(day=1),
                received.year,
                "Credit reporting" if index % 2 == 0 else "Mortgage",
                "credit_reporting" if index % 2 == 0 else "mortgage",
                "Problem",
                company,
                "CA",
                "Web",
                "Closed with explanation",
                True,
                index < 30,
                index < 10,
                index < 17,
                index < 20,
                None if index >= 20 else f"hash-{index}",
            )
        )
    return rows


def _cube_rows() -> list[tuple]:
    return [
        (2024, "credit_reporting", "Alpha Co", 10, 3, 8, 6, 2, 4),
        (2024, "mortgage", "Alpha Co", 5, 2, 4, 3, 1, 2),
        (2024, "credit_reporting", "Beta Co", 3, 1, 3, 2, 2, 1),
        (2024, "mortgage", "All other companies", 2, 2, 1, 1, 0, 0),
        (2025, "credit_reporting", "Alpha Co", 8, 3, 6, 5, 2, 3),
        (2025, "mortgage", "Alpha Co", 2, 1, 2, 1, 0, 1),
        (2025, "credit_reporting", "Beta Co", 8, 2, 7, 5, 1, 2),
        (2025, "mortgage", "Beta Co", 4, 1, 4, 4, 1, 2),
        (2025, "credit_reporting", "Gamma Co", 5, 3, 4, 2, 1, 2),
        (2025, "mortgage", "All other companies", 3, 2, 1, 1, 0, 0),
    ]


@pytest.fixture()
def corpus(tmp_path, monkeypatch):
    marts = tmp_path / "marts_out"
    artefacts = tmp_path / "artefacts"
    marts.mkdir()
    artefacts.mkdir()

    _write_mart(
        marts / "fct_complaints.parquet",
        """
        CREATE TABLE data (
            complaint_id BIGINT,
            date_received DATE,
            week_start DATE,
            month_start DATE,
            year INTEGER,
            product VARCHAR,
            product_group VARCHAR,
            issue VARCHAR,
            company VARCHAR,
            state VARCHAR,
            submitted_via VARCHAR,
            company_response VARCHAR,
            is_responded BOOLEAN,
            is_timely BOOLEAN,
            is_monetary_relief BOOLEAN,
            is_any_relief BOOLEAN,
            has_narrative BOOLEAN,
            text_hash VARCHAR
        )
        """,
        _fct_rows(),
    )
    _write_mart(
        marts / "mart_volume_monthly.parquet",
        """
        CREATE TABLE data (
            month_start DATE,
            product_group VARCHAR,
            complaints BIGINT,
            with_narrative BIGINT,
            responded BIGINT,
            timely BIGINT,
            monetary_relief BIGINT,
            any_relief BIGINT
        )
        """,
        [
            (date(2024, 1, 1), "credit_reporting", 13, 5, 11, 9, 3, 5),
            (date(2024, 1, 1), "mortgage", 7, 3, 5, 3, 2, 2),
            (date(2025, 1, 1), "credit_reporting", 21, 8, 17, 13, 4, 7),
            (date(2025, 1, 1), "mortgage", 9, 4, 7, 5, 1, 3),
        ],
    )
    _write_mart(
        marts / "mart_volume_cube.parquet",
        """
        CREATE TABLE data (
            year INTEGER,
            product_group VARCHAR,
            company_bucket VARCHAR,
            complaints BIGINT,
            with_narrative BIGINT,
            responded BIGINT,
            timely BIGINT,
            monetary_relief BIGINT,
            any_relief BIGINT
        )
        """,
        _cube_rows(),
    )
    _write_mart(
        marts / "mart_response_mix.parquet",
        """
        CREATE TABLE data (
            year INTEGER,
            product_group VARCHAR,
            company_response VARCHAR,
            complaints BIGINT
        )
        """,
        [
            (2024, "credit_reporting", "Closed with explanation", 8),
            (2024, "mortgage", "Closed with explanation", 4),
            (2024, "credit_reporting", "Closed with monetary relief", 4),
            (2025, "credit_reporting", "Closed with monetary relief", 6),
            (2024, "credit_reporting", "Closed with non-monetary relief", 4),
            (2025, "mortgage", "Closed with non-monetary relief", 3),
            (2025, "credit_reporting", "In progress", 10),
            (2025, "mortgage", "Untimely response", 3),
            (2024, "mortgage", "Closed with explanation", 8),
        ],
    )
    _write_mart(
        marts / "mart_text_repeats.parquet",
        """
        CREATE TABLE data (
            year INTEGER,
            product_group VARCHAR,
            with_narrative BIGINT,
            repeated_text BIGINT
        )
        """,
        [
            (2023, "credit_reporting", 0, 0),
            (2024, "credit_reporting", 5, 1),
            (2024, "mortgage", 3, 1),
            (2025, "credit_reporting", 8, 4),
            (2025, "mortgage", 4, 2),
        ],
    )
    _write_mart(
        marts / "mart_label_noise.parquet",
        """
        CREATE TABLE data (
            complaints BIGINT,
            distinct_texts BIGINT,
            in_modal_product BIGINT
        )
        """,
        [(10, 4, 8)],
    )
    _write_mart(
        marts / "dim_product_map.parquet",
        """
        CREATE TABLE data (
            product VARCHAR,
            sub_product VARCHAR,
            product_group VARCHAR,
            first_date DATE,
            last_date DATE,
            complaints BIGINT,
            with_narrative BIGINT
        )
        """,
        [
            ("Mortgage", "Home equity", "mortgage", date(2024, 1, 1), date(2025, 12, 31), 4, 2),
            (
                "Credit reporting",
                None,
                "credit_reporting",
                date(2024, 1, 1),
                date(2025, 12, 31),
                3,
                1,
            ),
            (
                "Credit reporting",
                "Report",
                "credit_reporting",
                date(2024, 2, 1),
                date(2025, 12, 31),
                5,
                2,
            ),
        ],
    )

    monkeypatch.setattr(config, "MARTS_DIR", marts)
    monkeypatch.setattr(config, "ARTEFACTS_DIR", artefacts)
    return {"artefacts": artefacts}


def test_descriptive_contract_and_determinism(corpus):
    assert descriptive.main() == 0
    path = corpus["artefacts"] / "descriptive.json"
    data = json.loads(path.read_text(encoding="utf-8"))

    assert list(data) == [
        "totals",
        "by_year",
        "by_product_group",
        "top_companies",
        "response_mix",
        "repeats",
        "label_noise",
        "taxonomy",
    ]
    assert list(data["totals"]) == [
        "complaints",
        "with_narrative",
        "first_date",
        "last_date",
        "companies",
        "narrative_share",
        "timely_rate",
        "monetary_relief_rate",
        "any_relief_rate",
    ]
    assert data["totals"]["complaints"] == 50
    assert data["totals"]["with_narrative"] == 20
    assert data["totals"]["companies"] == 4
    assert data["totals"]["first_date"] == "2024-01-01"
    assert data["totals"]["last_date"] == "2025-12-31"

    low, high = wilson(30, 40)
    assert data["totals"]["timely_rate"] == {
        "value": 0.75,
        "ci_low": round(low, 6),
        "ci_high": round(high, 6),
        "n": 40,
    }

    assert [entry["year"] for entry in data["by_year"]] == [2024, 2025]
    assert data["by_year"][0]["complaints"] == 20
    assert data["by_year"][1]["complaints"] == 30

    with PRODUCT_GROUPS_PATH.open(newline="", encoding="utf-8") as handle:
        group_order = [row["product_group"] for row in csv.DictReader(handle)]
    assert [entry["product_group"] for entry in data["by_product_group"]] == group_order
    assert data["by_product_group"][0]["label"] == "Credit reporting"
    assert data["by_product_group"][0]["complaints"] == 34
    assert data["by_product_group"][2]["complaints"] == 16

    companies = [entry["company"] for entry in data["top_companies"]]
    assert companies == ["Alpha Co", "Beta Co", "Gamma Co"]
    assert "All other companies" not in companies
    assert data["top_companies"][0]["complaints"] == 25
    assert data["top_companies"][0]["share"] == 0.5
    assert data["top_companies"][1]["share"] == 0.3

    assert [entry["company_response"] for entry in data["response_mix"]] == [
        "Closed with explanation",
        "Closed with monetary relief",
        "In progress",
        "Closed with non-monetary relief",
        "Untimely response",
    ]
    assert data["response_mix"][0]["share"] == 0.4

    assert [entry["year"] for entry in data["repeats"]] == [2024, 2025]
    assert data["repeats"][0]["with_narrative"] == 8
    assert data["repeats"][1]["with_narrative"] == 12

    assert data["label_noise"]["complaints"] == 10
    assert data["label_noise"]["distinct_texts"] == 4
    assert data["label_noise"]["modal_share"]["value"] == 0.8

    assert [entry["product"] for entry in data["taxonomy"]] == [
        "Credit reporting",
        "Credit reporting",
        "Mortgage",
    ]
    assert data["taxonomy"][0]["sub_product"] == "Report"
    assert data["taxonomy"][1]["sub_product"] is None
    assert data["taxonomy"][0]["first_date"] == "2024-02-01"

    first_bytes = path.read_bytes()
    assert descriptive.main() == 0
    assert path.read_bytes() == first_bytes
