"""Exploratory text novelty for the five event product groups.

Each narrative is scored against the first 500 narratives of the previous 26 weeks by hash
order; the weekly mean novelty is then run through the same alarm rule as the counts.
Run with ``python -m analysis.novelty``.
"""
from __future__ import annotations

import csv
import hashlib
from collections import defaultdict
from datetime import timedelta

import duckdb
import numpy as np

import config
from analysis import radar
from analysis.embed import embed

SAMPLE_PATH = config.MARTS_DIR / "mart_novelty_sample.parquet"
NOVELTY_PATH = config.ARTEFACTS_DIR / "novelty_weekly.csv"

MIN_WEEK_NARRATIVES = 20
MIN_REFERENCE = 500
REFERENCE_WEEKS = 26
SIMILARITY_CHUNK = 100


def load_sample() -> list[tuple]:
    """The novelty sample in product_group, week_start, complaint_id order."""
    path = str(SAMPLE_PATH).replace("'", "''")
    con = duckdb.connect()
    try:
        return con.execute(
            f"SELECT complaint_id, week_start, product_group, narrative "
            f"FROM read_parquet('{path}') "
            f"ORDER BY product_group, week_start, complaint_id"
        ).fetchall()
    finally:
        con.close()


def weekly_novelty(rows: list[tuple], group: str) -> list[dict]:
    """Mean novelty for every week that has enough narratives and reference rows."""
    complaint_ids = [row[0] for row in rows]
    texts = [row[3] for row in rows]
    weeks = [row[1] for row in rows]
    embeddings = embed(texts, "novelty_" + group, complaint_ids)

    week_positions: dict = defaultdict(list)
    for index, week in enumerate(weeks):
        week_positions[week].append(index)
    hash_order = [
        (hashlib.md5(str(complaint_id).encode()).hexdigest(), complaint_id, index)
        for index, complaint_id in enumerate(complaint_ids)
    ]
    hash_key = {index: (key, complaint_id) for key, complaint_id, index in hash_order}

    results = []
    for week in sorted(week_positions):
        positions = week_positions[week]
        if len(positions) < MIN_WEEK_NARRATIVES:
            continue

        reference_positions = []
        for back in range(1, REFERENCE_WEEKS + 1):
            reference_positions.extend(week_positions.get(week - timedelta(weeks=back), ()))
        if len(reference_positions) < MIN_REFERENCE:
            continue
        reference_positions.sort(key=lambda index: hash_key[index])
        reference = reference_positions[:MIN_REFERENCE]

        week_vectors = embeddings[positions]
        reference_vectors = embeddings[reference]
        best = np.empty(len(positions), dtype=np.float32)
        for start in range(0, len(positions), SIMILARITY_CHUNK):
            chunk = week_vectors[start:start + SIMILARITY_CHUNK]
            similarities = chunk @ reference_vectors.T
            best[start:start + len(chunk)] = similarities.max(axis=1)
        novelty = 1.0 - best.astype(np.float64)
        results.append(
            {
                "week": week,
                "narratives": len(positions),
                "mean_novelty": float(novelty.mean()),
            }
        )
    return results


def write_novelty(groups: list[str], results: dict[str, list[dict]]) -> None:
    NOVELTY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with NOVELTY_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["week_start", "product_group", "narratives", "mean_novelty", "z", "alarm"]
        )
        for group in groups:
            rows = results[group]
            values = np.array([row["mean_novelty"] for row in rows], dtype=float)
            z = radar.z_scores(values, log=False, floor=1e-9)
            alarms = set(radar.alarm_weeks(z))
            for index, row in enumerate(rows):
                z_text = (
                    f"{z[index]:.4f}"
                    if index >= radar.MONITOR_INDEX and np.isfinite(z[index])
                    else ""
                )
                writer.writerow(
                    [
                        row["week"].isoformat(),
                        group,
                        row["narratives"],
                        f"{row['mean_novelty']:.6f}",
                        z_text,
                        1 if index in alarms else 0,
                    ]
                )


def run() -> None:
    groups = radar.read_radar_groups()
    sample = load_sample()
    present = {row[2] for row in sample}
    groups = [group for group in groups if group in present]

    results = {}
    for group in groups:
        rows = [row for row in sample if row[2] == group]
        results[group] = weekly_novelty(rows, group)
        print(
            f"{group}: {len(rows)} narratives, "
            f"{len(results[group])} weeks with a value",
            flush=True,
        )

    write_novelty(groups, results)
    radar.write_radar_json()


def main() -> int:
    run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
