"""Reconcile the raw Parquet pull against the built marts.

The raw side is computed here from the Parquet files with its own SQL. The mart side is read
from the Parquet files in `marts_out/`. Writes `docs/RECONCILIATION.md`.

Run from the repository root: `python scripts/reconcile.py`.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config  # noqa: E402

RAW_GLOB = str(config.PARQUET_DIR / "complaints_*.parquet")
PRODUCT_MAP = str(config.REPO_ROOT / "dbt" / "seeds" / "product_map.csv")
PRODUCT_GROUPS = str(config.REPO_ROOT / "dbt" / "seeds" / "product_groups.csv")

TRAIN_START = "2023-09-01"
TRAIN_END = "2024-12-31"
VALIDATION_START = "2025-01-01"
VALIDATION_END = "2025-12-31"
TEST_START = "2026-01-01"
TEST_END = "2026-06-30"


def fmt(value: object) -> str:
    if isinstance(value, int):
        return f"{value:,}"
    return str(value)


def status(raw: object, mart: object) -> str:
    return "MATCH" if raw == mart else "MISMATCH"


def main() -> None:
    temp_dir = Path(tempfile.mkdtemp(prefix="complaint_radar_reconcile_"))
    con = duckdb.connect(database=":memory:")
    try:
        con.execute(f"SET memory_limit='{config.DUCKDB_MEMORY_LIMIT}'")
        con.execute(f"SET temp_directory='{temp_dir}'")

        # ---------------------------------------------------------------- raw side

        raw_total, raw_with_narrative, raw_companies = con.execute(
            f"""
            SELECT count(*),
                   count(*) FILTER (
                       WHERE narrative IS NOT NULL AND trim(narrative) <> ''
                   ),
                   count(DISTINCT company)
            FROM read_parquet('{RAW_GLOB}')
            """
        ).fetchone()

        raw_years = {
            int(year): int(count)
            for year, count in con.execute(
                f"""
                SELECT year(cast(date_received AS date)) AS y, count(*)
                FROM read_parquet('{RAW_GLOB}')
                GROUP BY 1
                ORDER BY 1
                """
            ).fetchall()
        }

        raw_product_groups = {
            str(group): int(count)
            for group, count in con.execute(
                f"""
                WITH raw AS (
                    SELECT product, sub_product
                    FROM read_parquet('{RAW_GLOB}')
                ),
                pm AS (
                    SELECT * FROM read_csv_auto('{PRODUCT_MAP}', header = true)
                ),
                exact AS (
                    SELECT product, sub_product, product_group
                    FROM pm
                    WHERE sub_product IS NOT NULL AND sub_product <> '*'
                ),
                star AS (
                    SELECT product, product_group
                    FROM pm
                    WHERE sub_product = '*'
                ),
                mapped AS (
                    SELECT coalesce(e.product_group, s.product_group) AS product_group
                    FROM raw r
                    LEFT JOIN exact e
                        ON r.product = e.product AND r.sub_product = e.sub_product
                    LEFT JOIN star s
                        ON e.product_group IS NULL AND r.product = s.product
                )
                SELECT product_group, count(*)
                FROM mapped
                GROUP BY 1
                ORDER BY 1
                """
            ).fetchall()
        }

        raw_narratives = con.execute(
            f"""
            SELECT
                count(*) FILTER (
                    WHERE cast(date_received AS date) BETWEEN date '{TRAIN_START}'
                                                         AND date '{TRAIN_END}'
                ),
                count(*) FILTER (
                    WHERE cast(date_received AS date) BETWEEN date '{VALIDATION_START}'
                                                         AND date '{VALIDATION_END}'
                ),
                count(*) FILTER (
                    WHERE cast(date_received AS date) BETWEEN date '{TEST_START}'
                                                         AND date '{TEST_END}'
                )
            FROM read_parquet('{RAW_GLOB}')
            WHERE narrative IS NOT NULL AND trim(narrative) <> ''
            """
        ).fetchone()

        # Eligible raw rows, with the same normalised text hash used by the models.
        con.execute(
            f"""
            CREATE OR REPLACE TEMP TABLE raw_eligible AS
            SELECT
                cast(complaint_id AS bigint) AS complaint_id,
                cast(date_received AS date) AS date_received,
                product,
                length(narrative) AS narrative_length,
                md5(lower(regexp_replace(trim(narrative), '\\s+', ' ', 'g'))) AS text_hash
            FROM read_parquet('{RAW_GLOB}')
            WHERE narrative IS NOT NULL
              AND trim(narrative) <> ''
              AND cast(date_received AS date) BETWEEN date '{TRAIN_START}'
                                                  AND date '{TEST_END}'
              AND product IN (
                  SELECT current_product
                  FROM read_csv_auto('{PRODUCT_GROUPS}', header = true)
              )
            """
        )

        # Router train sample, replicated independently of dbt.
        con.execute(
            """
            CREATE OR REPLACE TEMP TABLE raw_train_sample AS
            WITH dedup AS (
                SELECT
                    complaint_id,
                    date_received,
                    product,
                    text_hash,
                    narrative_length,
                    row_number() OVER (
                        PARTITION BY text_hash
                        ORDER BY date_received ASC, complaint_id ASC
                    ) AS rn_hash
                FROM raw_eligible
                WHERE date_received <= date '2024-12-31'
            ),
            one_per_hash AS (
                SELECT * FROM dedup WHERE rn_hash = 1
            ),
            ranked AS (
                SELECT
                    *,
                    row_number() OVER (
                        PARTITION BY product
                        ORDER BY md5(cast(complaint_id AS varchar)) ASC
                    ) AS rn_product
                FROM one_per_hash
            )
            SELECT * FROM ranked WHERE rn_product <= 100000
            """
        )

        raw_router_train = con.execute(
            "SELECT count(*) FROM raw_train_sample"
        ).fetchone()[0]
        raw_router_validation = con.execute(
            f"""
            SELECT least(count(*), 100000)
            FROM raw_eligible
            WHERE date_received BETWEEN date '{VALIDATION_START}'
                                    AND date '{VALIDATION_END}'
            """
        ).fetchone()[0]
        raw_router_test = con.execute(
            f"""
            SELECT count(*)
            FROM raw_eligible
            WHERE date_received BETWEEN date '{TEST_START}' AND date '{TEST_END}'
            """
        ).fetchone()[0]
        raw_llm_fewshot = con.execute(
            """
            SELECT count(DISTINCT product)
            FROM raw_train_sample
            WHERE narrative_length BETWEEN 200 AND 800
            """
        ).fetchone()[0]

        raw_llm_test = con.execute(
            f"""
            WITH test_rows AS (
                SELECT *
                FROM raw_eligible
                WHERE date_received BETWEEN date '{TEST_START}' AND date '{TEST_END}'
            ),
            one_per_hash AS (
                SELECT
                    *,
                    row_number() OVER (
                        PARTITION BY text_hash
                        ORDER BY md5(cast(complaint_id AS varchar)) ASC
                    ) AS rn_hash
                FROM test_rows
            ),
            per_product AS (
                SELECT product, count(*) AS c
                FROM one_per_hash
                WHERE rn_hash = 1
                GROUP BY product
            )
            SELECT coalesce(sum(least(c, 300)), 0) FROM per_product
            """
        ).fetchone()[0]

        raw_llm_validation = con.execute(
            f"""
            WITH validation_rows AS (
                SELECT *
                FROM raw_eligible
                WHERE date_received BETWEEN date '{VALIDATION_START}'
                                        AND date '{VALIDATION_END}'
            ),
            one_per_hash AS (
                SELECT
                    *,
                    row_number() OVER (
                        PARTITION BY text_hash
                        ORDER BY md5(cast(complaint_id AS varchar)) ASC
                    ) AS rn_hash
                FROM validation_rows
            ),
            per_product AS (
                SELECT product, count(*) AS c
                FROM one_per_hash
                WHERE rn_hash = 1
                GROUP BY product
            )
            SELECT coalesce(sum(least(c, 150)), 0) FROM per_product
            """
        ).fetchone()[0]

        # --------------------------------------------------------------- mart side

        fct_path = config.MARTS_DIR / "fct_complaints.parquet"

        mart_total, mart_with_narrative, mart_companies = con.execute(
            f"""
            SELECT count(*),
                   count(*) FILTER (WHERE has_narrative),
                   count(DISTINCT company)
            FROM read_parquet('{fct_path}')
            """
        ).fetchone()

        mart_years = {
            int(year): int(count)
            for year, count in con.execute(
                f"""
                SELECT year, count(*)
                FROM read_parquet('{fct_path}')
                GROUP BY 1
                ORDER BY 1
                """
            ).fetchall()
        }

        mart_product_groups = {
            str(group): int(count)
            for group, count in con.execute(
                f"""
                SELECT product_group, count(*)
                FROM read_parquet('{fct_path}')
                GROUP BY 1
                ORDER BY 1
                """
            ).fetchall()
        }

        mart_narratives = con.execute(
            f"""
            SELECT
                count(*) FILTER (
                    WHERE has_narrative
                      AND date_received BETWEEN date '{TRAIN_START}' AND date '{TRAIN_END}'
                ),
                count(*) FILTER (
                    WHERE has_narrative
                      AND date_received BETWEEN date '{VALIDATION_START}'
                                            AND date '{VALIDATION_END}'
                ),
                count(*) FILTER (
                    WHERE has_narrative
                      AND date_received BETWEEN date '{TEST_START}' AND date '{TEST_END}'
                )
            FROM read_parquet('{fct_path}')
            """
        ).fetchone()

        router_splits = {
            str(split): int(count)
            for split, count in con.execute(
                f"""
                SELECT split, count(*)
                FROM read_parquet('{config.MARTS_DIR / 'mart_router_samples.parquet'}')
                GROUP BY 1
                """
            ).fetchall()
        }

        llm_roles = {
            str(role): int(count)
            for role, count in con.execute(
                f"""
                SELECT role, count(*)
                FROM read_parquet('{config.MARTS_DIR / 'mart_llm_samples.parquet'}')
                GROUP BY 1
                """
            ).fetchall()
        }

        # ---------------------------------------------------------------- document

        matched_years = sum(
            1
            for year, count in raw_years.items()
            if mart_years.get(year) == count
        )
        all_years = len(set(raw_years) | set(mart_years))
        years_match = matched_years == all_years

        lines = [
            "# Reconciliation\n",
            "\n",
            "Raw values are computed from the Parquet pull with their own SQL. Mart values are "
            "read from\n",
            "the built Parquet files. Every row that is compared exactly is marked MATCH or "
            "MISMATCH.\n",
            "\n",
            "| Metric | Raw | Mart | Status |\n",
            "|---|---:|---:|---|\n",
        ]

        def add_row(label: str, raw: object, mart: object) -> None:
            lines.append(f"| {label} | {fmt(raw)} | {fmt(mart)} | {status(raw, mart)} |\n")

        add_row("Complaints", raw_total, mart_total)
        add_row("Complaints with a narrative", raw_with_narrative, mart_with_narrative)
        lines.append(
            "| Complaints per year (years that match) "
            f"| {matched_years} of {len(raw_years)} "
            f"| {matched_years} of {len(mart_years)} "
            f"| {'MATCH' if years_match else 'MISMATCH'} |\n"
        )
        groups_in_order = [
            str(row[0])
            for row in con.execute(
                f"SELECT product_group FROM read_csv_auto('{PRODUCT_GROUPS}', header = true)"
            ).fetchall()
        ]
        for group in groups_in_order:
            add_row(
                f"Complaints, product group {group}",
                raw_product_groups.get(group, 0),
                mart_product_groups.get(group, 0),
            )
        add_row("Distinct companies", raw_companies, mart_companies)
        add_row(
            "Narratives, train period",
            raw_narratives[0],
            mart_narratives[0],
        )
        add_row(
            "Narratives, validation period",
            raw_narratives[1],
            mart_narratives[1],
        )
        add_row(
            "Narratives, test period",
            raw_narratives[2],
            mart_narratives[2],
        )
        add_row(
            "mart_router_samples, train rows",
            raw_router_train,
            router_splits.get("train", 0),
        )
        add_row(
            "mart_router_samples, validation rows",
            raw_router_validation,
            router_splits.get("validation", 0),
        )
        add_row(
            "mart_router_samples, test rows",
            raw_router_test,
            router_splits.get("test", 0),
        )
        add_row(
            "mart_llm_samples, test rows",
            raw_llm_test,
            llm_roles.get("test", 0),
        )
        add_row(
            "mart_llm_samples, validation rows",
            raw_llm_validation,
            llm_roles.get("validation", 0),
        )
        add_row(
            "mart_llm_samples, fewshot rows",
            raw_llm_fewshot,
            llm_roles.get("fewshot", 0),
        )

        lines.extend(
            [
                "\n",
                "## Complaints per year\n",
                "\n",
                "| Year | Raw | Mart | Status |\n",
                "|---|---:|---:|---|\n",
            ]
        )
        for year in sorted(set(raw_years) | set(mart_years)):
            raw_count = raw_years.get(year, 0)
            mart_count = mart_years.get(year, 0)
            lines.append(
                f"| {year} | {fmt(raw_count)} | {fmt(mart_count)} | "
                f"{status(raw_count, mart_count)} |\n"
            )

        out = config.REPO_ROOT / "docs" / "RECONCILIATION.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("".join(lines), encoding="utf-8")
        print(f"Wrote {out.relative_to(config.REPO_ROOT)}")
    finally:
        con.close()
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
