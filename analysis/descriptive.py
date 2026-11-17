"""Descriptive tables for the complaint data, built from the mart Parquet files.

Every count comes from SQL over a mart. Python only arranges rows in the order set by
``CONTRACTS.md`` and adds Wilson intervals with ``analysis.stats_util.rate_num``. Run with
``python -m analysis.descriptive`` to write ``artefacts/descriptive.json``.
"""
from __future__ import annotations

import csv
import json
import os
from pathlib import Path

import duckdb

import config
from analysis.stats_util import rate_num

PRODUCT_GROUPS_PATH = config.REPO_ROOT / "dbt" / "seeds" / "product_groups.csv"
OUTPUT_NAME = "descriptive.json"


def _parquet(name: str) -> str:
    path = config.MARTS_DIR / f"{name}.parquet"
    return str(path).replace("'", "''")


def _connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    limit = str(config.DUCKDB_MEMORY_LIMIT).replace("'", "''")
    con.execute(f"SET memory_limit = '{limit}'")
    return con


def _read_product_groups() -> list[dict]:
    with PRODUCT_GROUPS_PATH.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _rates(complaints: int, with_narrative: int, responded: int, timely: int,
           monetary_relief: int, any_relief: int | None = None) -> dict:
    """The rate entries shared by the year, product-group and total blocks."""
    rates = {
        "narrative_share": rate_num(with_narrative, complaints),
        "timely_rate": rate_num(timely, responded),
        "monetary_relief_rate": rate_num(monetary_relief, responded),
    }
    if any_relief is not None:
        rates["any_relief_rate"] = rate_num(any_relief, responded)
    return rates


def _totals(con: duckdb.DuckDBPyConnection) -> dict:
    complaints, companies, with_narrative, first_date, last_date = con.execute(
        f"""
        SELECT count(*) AS complaints,
               count(DISTINCT company) AS companies,
               sum(CASE WHEN has_narrative THEN 1 ELSE 0 END) AS with_narrative,
               min(date_received) AS first_date,
               max(date_received) AS last_date
        FROM read_parquet('{_parquet("fct_complaints")}')
        ORDER BY complaints
        """
    ).fetchall()[0]

    monthly = con.execute(
        f"""
        SELECT sum(complaints) AS complaints,
               sum(with_narrative) AS with_narrative,
               sum(responded) AS responded,
               sum(timely) AS timely,
               sum(monetary_relief) AS monetary_relief,
               sum(any_relief) AS any_relief
        FROM read_parquet('{_parquet("mart_volume_monthly")}')
        ORDER BY complaints
        """
    ).fetchall()[0]
    m_complaints, m_narrative, responded, timely, monetary_relief, any_relief = monthly

    return {
        "complaints": int(complaints),
        "with_narrative": int(with_narrative),
        "first_date": first_date.isoformat(),
        "last_date": last_date.isoformat(),
        "companies": int(companies),
        **_rates(
            int(m_complaints),
            int(m_narrative),
            int(responded),
            int(timely),
            int(monetary_relief),
            int(any_relief),
        ),
    }


def _by_year(con: duckdb.DuckDBPyConnection) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT year,
               sum(complaints) AS complaints,
               sum(with_narrative) AS with_narrative,
               sum(responded) AS responded,
               sum(timely) AS timely,
               sum(monetary_relief) AS monetary_relief
        FROM read_parquet('{_parquet("mart_volume_cube")}')
        GROUP BY year
        ORDER BY year
        """
    ).fetchall()

    return [
        {
            "year": int(year),
            "complaints": int(complaints),
            "with_narrative": int(with_narrative),
            **_rates(
                int(complaints),
                int(with_narrative),
                int(responded),
                int(timely),
                int(monetary_relief),
            ),
        }
        for year, complaints, with_narrative, responded, timely, monetary_relief in rows
    ]


def _by_product_group(con: duckdb.DuckDBPyConnection) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT product_group,
               sum(complaints) AS complaints,
               sum(with_narrative) AS with_narrative,
               sum(responded) AS responded,
               sum(timely) AS timely,
               sum(monetary_relief) AS monetary_relief,
               sum(any_relief) AS any_relief
        FROM read_parquet('{_parquet("mart_volume_cube")}')
        GROUP BY product_group
        ORDER BY product_group
        """
    ).fetchall()
    by_group = {row[0]: row[1:] for row in rows}

    output = []
    for group in _read_product_groups():
        name = group["product_group"]
        complaints, with_narrative, responded, timely, monetary_relief, any_relief = (
            by_group.get(name, (0, 0, 0, 0, 0, 0))
        )
        output.append(
            {
                "product_group": name,
                "label": group["label"],
                "complaints": int(complaints),
                "with_narrative": int(with_narrative),
                **_rates(
                    int(complaints),
                    int(with_narrative),
                    int(responded),
                    int(timely),
                    int(monetary_relief),
                    int(any_relief),
                ),
            }
        )
    return output


def _top_companies(con: duckdb.DuckDBPyConnection, total_complaints: int) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT company_bucket AS company,
               sum(complaints) AS complaints,
               sum(responded) AS responded,
               sum(timely) AS timely,
               sum(monetary_relief) AS monetary_relief
        FROM read_parquet('{_parquet("mart_volume_cube")}')
        WHERE company_bucket <> 'All other companies'
        GROUP BY company_bucket
        ORDER BY complaints DESC, company ASC
        """
    ).fetchall()

    return [
        {
            "company": company,
            "complaints": int(complaints),
            "share": round(int(complaints) / total_complaints, 6),
            "timely_rate": rate_num(int(timely), int(responded)),
            "monetary_relief_rate": rate_num(int(monetary_relief), int(responded)),
        }
        for company, complaints, responded, timely, monetary_relief in rows
    ]


def _response_mix(con: duckdb.DuckDBPyConnection) -> list[dict]:
    rows = con.execute(
        f"""
        WITH grouped AS (
            SELECT company_response,
                   sum(complaints) AS complaints
            FROM read_parquet('{_parquet("mart_response_mix")}')
            GROUP BY company_response
        )
        SELECT company_response,
               complaints,
               sum(complaints) OVER () AS total
        FROM grouped
        ORDER BY complaints DESC, company_response ASC
        """
    ).fetchall()

    return [
        {
            "company_response": company_response,
            "complaints": int(complaints),
            "share": round(int(complaints) / int(total), 6),
        }
        for company_response, complaints, total in rows
    ]


def _repeats(con: duckdb.DuckDBPyConnection) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT year,
               sum(with_narrative) AS with_narrative,
               sum(repeated_text) AS repeated_text
        FROM read_parquet('{_parquet("mart_text_repeats")}')
        GROUP BY year
        HAVING sum(with_narrative) > 0
        ORDER BY year
        """
    ).fetchall()

    return [
        {
            "year": int(year),
            "with_narrative": int(with_narrative),
            "repeated_share": rate_num(int(repeated_text), int(with_narrative)),
        }
        for year, with_narrative, repeated_text in rows
    ]


def _label_noise(con: duckdb.DuckDBPyConnection) -> dict:
    rows = con.execute(
        f"""
        SELECT complaints, distinct_texts, in_modal_product
        FROM read_parquet('{_parquet("mart_label_noise")}')
        ORDER BY complaints
        """
    ).fetchall()
    complaints, distinct_texts, in_modal_product = rows[0] if rows else (0, 0, 0)

    return {
        "complaints": int(complaints),
        "distinct_texts": int(distinct_texts),
        "modal_share": rate_num(int(in_modal_product), int(complaints)),
    }


def _taxonomy(con: duckdb.DuckDBPyConnection) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT product,
               sub_product,
               product_group,
               strftime(first_date, '%Y-%m-%d') AS first_date,
               strftime(last_date, '%Y-%m-%d') AS last_date,
               complaints
        FROM read_parquet('{_parquet("dim_product_map")}')
        ORDER BY product, complaints DESC, sub_product ASC NULLS LAST
        """
    ).fetchall()

    return [
        {
            "product": product,
            "sub_product": sub_product,
            "product_group": product_group,
            "first_date": first_date,
            "last_date": last_date,
            "complaints": int(complaints),
        }
        for product, sub_product, product_group, first_date, last_date, complaints in rows
    ]


def build() -> dict:
    """Read every mart and return the ``descriptive.json`` payload."""
    con = _connect()
    try:
        totals = _totals(con)
        return {
            "totals": totals,
            "by_year": _by_year(con),
            "by_product_group": _by_product_group(con),
            "top_companies": _top_companies(con, totals["complaints"]),
            "response_mix": _response_mix(con),
            "repeats": _repeats(con),
            "label_noise": _label_noise(con),
            "taxonomy": _taxonomy(con),
        }
    finally:
        con.close()


def write(payload: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")
    return path


def main() -> int:
    path = write(build(), config.ARTEFACTS_DIR / OUTPUT_NAME)
    print(os.path.relpath(path, config.REPO_ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
