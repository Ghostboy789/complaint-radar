"""Build the data files used by the static site.

The result files are copied byte for byte. The volume and weekly files are compact
arrays so the browser can filter and draw them without another build step.
"""

from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent

COPIED_FILES = ("descriptive.json", "router.json", "llm_eval.json", "radar.json", "timings.json")
OPTIONAL_FILES = frozenset({"llm_eval.json", "timings.json"})
MART_FILES = ("mart_volume_cube.parquet", "mart_volume_monthly.parquet", "mart_state_year.parquet")


def write_json(path: Path, value: object) -> None:
    """Write deterministic, compact JSON with sorted keys and no absolute paths."""
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def copy_results(artefacts: Path, data: Path) -> None:
    """Copy the result files that exist; clear optional copies that have no source."""
    for name in COPIED_FILES:
        source = artefacts / name
        target = data / name
        if source.is_file():
            shutil.copyfile(source, target)
        elif name in OPTIONAL_FILES and target.exists():
            target.unlink()


def build_volumes(marts: Path, data: Path) -> bool:
    """Return True when the volume cube was rebuilt from local marts."""
    if not all((marts / name).is_file() for name in MART_FILES):
        return False
    con = duckdb.connect()
    try:
        cube = con.execute(
            "SELECT year, product_group, company_bucket, complaints, with_narrative, "
            "responded, timely, monetary_relief, any_relief "
            "FROM read_parquet(?) ORDER BY 1, 2, 3",
            [str(marts / MART_FILES[0])],
        ).fetchall()
        monthly = con.execute(
            "SELECT strftime(month_start, '%Y-%m') AS month, product_group, complaints, "
            "with_narrative, responded, timely, monetary_relief, any_relief "
            "FROM read_parquet(?) ORDER BY 1, 2",
            [str(marts / MART_FILES[1])],
        ).fetchall()
        states = con.execute(
            "SELECT state, year, complaints FROM read_parquet(?) ORDER BY 2, 1",
            [str(marts / MART_FILES[2])],
        ).fetchall()
    finally:
        con.close()

    groups = sorted({row[1] for row in cube} | {row[1] for row in monthly})
    companies = sorted({row[2] for row in cube})
    years = sorted({row[0] for row in cube})
    months = sorted({row[0] for row in monthly})
    group_id = {name: i for i, name in enumerate(groups)}
    company_id = {name: i for i, name in enumerate(companies)}
    year_id = {year: i for i, year in enumerate(years)}
    month_id = {month: i for i, month in enumerate(months)}

    write_json(
        data / "volumes.json",
        {
            "groups": groups,
            "companies": companies,
            "years": years,
            "months": months,
            "cube": [
                [year_id[row[0]], group_id[row[1]], company_id[row[2]], *row[3:]]
                for row in cube
            ],
            "monthly": [[month_id[row[0]], group_id[row[1]], *row[2:]] for row in monthly],
            "states": states,
        },
    )
    return True


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def weekly_arrays(rows: list[dict[str, str]], fields: tuple[str, ...]) -> dict:
    """Turn one long CSV into indexed arrays, one per product group."""
    weeks = sorted({row["week_start"] for row in rows})
    week_id = {week: i for i, week in enumerate(weeks)}
    groups = sorted({row["product_group"] for row in rows})
    series: dict[str, dict[str, list]] = {
        group: {"week": week_id, **{field: [None] * len(weeks) for field in fields}}
        for group in groups
    }
    for row in rows:
        target = series[row["product_group"]]
        index = week_id[row["week_start"]]
        for field in fields:
            raw = row.get(field, "").strip()
            if raw == "":
                continue
            if field in ("alarm", "naive_alarm", "narratives", "complaints"):
                target[field][index] = int(float(raw))
            else:
                target[field][index] = float(raw)
    return {
        "groups": groups,
        "weeks": weeks,
        "series": {
            group: {field: values[field] for field in fields}
            for group, values in sorted(series.items())
        },
    }


def build_weekly(artefacts: Path, data: Path) -> None:
    radar_rows = read_csv(artefacts / "radar_weekly.csv")
    novelty_rows = read_csv(artefacts / "novelty_weekly.csv")
    write_json(
        data / "weekly.json",
        {
            "radar": weekly_arrays(
                radar_rows, ("complaints", "z", "alarm", "naive_alarm")
            ),
            "novelty": weekly_arrays(
                novelty_rows, ("narratives", "mean_novelty", "z", "alarm")
            ),
        },
    )


def build(root: Path = ROOT) -> None:
    """Build every generated file under site/data for the given repository root."""
    artefacts = root / "artefacts"
    data = root / "site" / "data"
    data.mkdir(parents=True, exist_ok=True)
    copy_results(artefacts, data)
    build_volumes(root / "marts_out", data)
    build_weekly(artefacts, data)
    available = [name for name in COPIED_FILES if (data / name).is_file()]
    available.extend(name for name in ("volumes.json", "weekly.json") if (data / name).is_file())
    write_json(data / "manifest.json", {"files": sorted(available)})


if __name__ == "__main__":
    build()
