"""Profile the raw Parquet pull: writes artefacts/profile.json and docs/DATA_PROFILE.md.

This is the only look at the data taken before ANALYSIS_PLAN.md was written. It holds yearly
and monthly counts only: no weekly series, no model, no text beyond length and repeats.

Run: python -m scripts.profile_data
"""
import json

import duckdb

import config

NORM = r"lower(regexp_replace(trim(narrative), '\s+', ' ', 'g'))"
SECTIONS = {
    "totals": """SELECT count(*) AS complaints, count(DISTINCT complaint_id) AS distinct_ids,
            min(d) AS first_date, max(d) AS last_date,
            count(*) FILTER (WHERE has_text) AS with_text,
            min(d) FILTER (WHERE has_text) AS first_text_date,
            count(*) FILTER (WHERE d IS NULL) AS unparsed_dates FROM c""",
    "by_source_file": """SELECT source_file, count(*) AS complaints, min(d) AS first_date,
            max(d) AS last_date, count(*) FILTER (WHERE has_text) AS with_text
            FROM c GROUP BY 1 ORDER BY min(d), 1""",
    "by_year": """SELECT year(d) AS year, count(*) AS complaints,
            count(*) FILTER (WHERE has_text) AS with_text,
            round(count(*) FILTER (WHERE has_text) / count(*), 4) AS text_share
            FROM c GROUP BY 1 ORDER BY 1""",
    "products": """SELECT product, min(d) AS first_date, max(d) AS last_date,
            count(*) AS complaints,
            count(*) FILTER (WHERE has_text) AS with_text, count(DISTINCT issue) AS issues,
            count(DISTINCT sub_product) AS sub_products
            FROM c GROUP BY 1 ORDER BY complaints DESC""",
    "product_by_year_text": """PIVOT (SELECT product, year(d) AS y FROM c WHERE has_text)
            ON y USING count(*) ORDER BY product""",
    "sub_products": """SELECT product, sub_product, min(d) AS first_date, max(d) AS last_date,
            count(*) AS complaints, count(*) FILTER (WHERE has_text) AS with_text
            FROM c GROUP BY 1, 2 ORDER BY 1, complaints DESC""",
    "monthly_since_2023": """SELECT strftime(date_trunc('month', d), '%Y-%m') AS month,
            count(*) AS complaints, count(*) FILTER (WHERE has_text) AS with_text,
            count(*) FILTER (WHERE has_text AND product LIKE 'Credit reporting%')
            AS with_text_credit_reporting,
            count(*) FILTER (WHERE company_response = 'In progress') AS in_progress
            FROM c WHERE d >= DATE '2023-01-01' GROUP BY 1 ORDER BY 1""",
    "blank_share": """UNPIVOT (SELECT {blank_cols} FROM c) ON COLUMNS(*) INTO NAME col VALUE
            blank_share""",
    "text_length": """SELECT count(*) AS n, quantile_cont(length(narrative), [0.05, 0.25, 0.5, 0.75,
            0.95, 0.99]) AS chars_p5_p25_p50_p75_p95_p99, max(length(narrative)) AS max_chars,
            round(avg((narrative LIKE '%XXXX%')::INT), 4) AS share_with_masking
            FROM c WHERE has_text""",
    "repeats_by_year": """SELECT year, count(*) AS with_text,
            count(*) FILTER (WHERE copies > 1) AS repeated_text,
            round(count(*) FILTER (WHERE copies > 1) / count(*), 4) AS repeated_share,
            max(copies) AS most_copies
            FROM (SELECT year(d) AS year, count(*) OVER (PARTITION BY h) AS copies FROM t)
            GROUP BY 1 ORDER BY 1""",
    "repeats_by_product": """SELECT product, count(*) AS with_text,
            round(count(*) FILTER (WHERE copies > 1) / count(*), 4) AS repeated_share
            FROM (SELECT product, count(*) OVER (PARTITION BY h) AS copies FROM t)
            GROUP BY 1 ORDER BY with_text DESC""",
    "repeat_label_agreement": """SELECT count(*) AS repeated_texts, sum(n) AS complaints,
            round(sum(top) / sum(n), 4) AS share_with_modal_product
            FROM (SELECT h, sum(k) AS n, max(k) AS top FROM
                  (SELECT h, product, count(*) AS k FROM t GROUP BY 1, 2)
                  GROUP BY 1 HAVING sum(k) > 1)""",
    "top_companies": """SELECT company, count(*) AS complaints,
            round(count(*) / sum(count(*)) OVER (), 4) AS share FROM c GROUP BY 1
            ORDER BY complaints DESC LIMIT 15""",
    "top3_company_share_by_year": """SELECT year, round(sum(k) FILTER (WHERE r <= 3) / sum(k), 4)
            AS top3_share, string_agg(company, ' | ' ORDER BY r) FILTER (WHERE r <= 3) AS top3
            FROM (SELECT year(d) AS year, company, count(*) AS k,
                  row_number() OVER (PARTITION BY year(d) ORDER BY count(*) DESC, company) AS r
                  FROM c GROUP BY 1, 2) GROUP BY 1 ORDER BY 1""",
    "submitted_via": """SELECT submitted_via, count(*) AS complaints FROM c GROUP BY 1
            ORDER BY 2 DESC""",
    "company_response": """SELECT company_response, count(*) AS complaints FROM c GROUP BY 1
            ORDER BY 2 DESC""",
    "timely_response": """SELECT timely_response, count(*) AS complaints FROM c GROUP BY 1
            ORDER BY 2 DESC""",
    "tags": "SELECT tags, count(*) AS complaints FROM c GROUP BY 1 ORDER BY 2 DESC",
    "cardinality": """SELECT count(DISTINCT product) AS products, count(DISTINCT sub_product) AS
            sub_products, count(DISTINCT issue) AS issues, count(DISTINCT sub_issue) AS sub_issues,
            count(DISTINCT company) AS companies, count(DISTINCT state) AS states FROM c""",
}


def main() -> None:
    con = duckdb.connect()
    con.execute(f"SET memory_limit='{config.DUCKDB_MEMORY_LIMIT}'")
    con.execute(f"SET temp_directory='{config.PARQUET_DIR / 'tmp'}'")
    glob = str(config.PARQUET_DIR / "complaints_*.parquet")
    con.execute(
        f"""CREATE VIEW c AS SELECT *, try_cast(date_received AS DATE) AS d,
            narrative IS NOT NULL AND trim(narrative) <> '' AS has_text
            FROM read_parquet('{glob}')"""
    )
    # One row per complaint with text: product, date and a hash of the normalised text.
    con.execute(f"CREATE TABLE t AS SELECT product, d, md5({NORM}) AS h FROM c WHERE has_text")
    cols = [r[0] for r in con.execute("DESCRIBE c").fetchall() if r[0] not in ("d", "has_text")]
    blank = ", ".join(
        f"round(avg(({col} IS NULL OR trim({col}) = '')::INT), 4) AS {col}" for col in cols
    )
    out = {}
    for name, sql in SECTIONS.items():
        cur = con.execute(sql.format(blank_cols=blank) if name == "blank_share" else sql)
        names = [d[0] for d in cur.description]
        out[name] = [dict(zip(names, row, strict=True)) for row in cur.fetchall()]
    (config.ARTEFACTS_DIR / "profile.json").write_text(
        json.dumps(out, indent=1, default=str) + "\n"
    )
    lines = ["# Data profile", "", "Generated by `scripts/profile_data.py` from the raw Parquet "
             "pull. Counts only; nothing here is a result.", ""]
    for name, rows in out.items():
        lines += [f"## {name}", "", "| " + " | ".join(rows[0]) + " |",
                  "|" + "---|" * len(rows[0])]
        lines += ["| " + " | ".join(str(v) for v in r.values()) + " |" for r in rows]
        lines.append("")
    (config.REPO_ROOT / "docs" / "DATA_PROFILE.md").write_text("\n".join(lines))
    print("wrote artefacts/profile.json and docs/DATA_PROFILE.md")


if __name__ == "__main__":
    main()
