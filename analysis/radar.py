"""Weekly complaint radar: level, season, scale, alarms, episodes and event scoring.

Run with ``python -m analysis.radar``. The rule constants are fixed in ANALYSIS_PLAN.md
section 7. The pure functions at the top take plain numpy arrays so the novelty variant can
reuse them.
"""
from __future__ import annotations

import csv
import json
from datetime import date, timedelta

import duckdb
import numpy as np

import config
from analysis.stats_util import num, poisson_rate_num, rate_num

PRODUCT_GROUPS_PATH = config.REPO_ROOT / "dbt" / "seeds" / "product_groups.csv"
RADAR_WEEKLY_PATH = config.ARTEFACTS_DIR / "radar_weekly.csv"
NOVELTY_WEEKLY_PATH = config.ARTEFACTS_DIR / "novelty_weekly.csv"
RADAR_JSON_PATH = config.ARTEFACTS_DIR / "radar.json"

LEVEL_WEEKS = 26
SCALE_WEEKS = 52
LIMIT = 3.0
CONSECUTIVE = 2
MONITOR_FROM_WEEK = 131
MONITOR_INDEX = MONITOR_FROM_WEEK - 1
EPISODE_GAP_WEEKS = 4
EVENT_WINDOW_WEEKS = 8
NAIVE_RATIO = 1.5
Z_FLOOR = 0.05

WEEK_ORIGIN = date(1970, 1, 5)  # a Monday, so date differences in weeks are exact


def _sql_path(path) -> str:
    return str(path).replace("'", "''")


def read_radar_groups() -> list[str]:
    """Product groups with in_radar true, in the order of product_groups.csv."""
    with PRODUCT_GROUPS_PATH.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return [
        row["product_group"]
        for row in rows
        if row["in_radar"].strip().lower() == "true"
    ]


def first_nonzero_index(values) -> int | None:
    """Index of the first non-zero value, or None when every value is zero."""
    array = np.asarray(values)
    found = np.flatnonzero(array != 0)
    return None if len(found) == 0 else int(found[0])


def trim_series(values) -> tuple[np.ndarray, int]:
    """Drop the weeks before the first non-zero count; return the series and its start."""
    array = np.asarray(values, dtype=float)
    start = first_nonzero_index(array)
    if start is None:
        return array[:0], 0
    return array[start:], start


def z_scores(values, log: bool = True, floor: float = Z_FLOOR) -> np.ndarray:
    """Robust z for each week, NaN before index 78.

    With ``log`` the series is ln(1 + value); otherwise the values are used directly.
    """
    values = np.asarray(values, dtype=float)
    n = len(values)
    z = np.full(n, np.nan)
    if n == 0:
        return z

    x = np.log1p(values) if log else values.copy()
    d = np.full(n, np.nan)
    for t in range(LEVEL_WEEKS, n):
        d[t] = x[t] - np.median(x[t - LEVEL_WEEKS:t])

    r = np.full(n, np.nan)
    for t in range(LEVEL_WEEKS, n):
        samples = []
        k = 1
        while t - SCALE_WEEKS * k >= LEVEL_WEEKS:
            samples.append(d[t - SCALE_WEEKS * k])
            k += 1
        season = float(np.median(samples)) if len(samples) >= 2 else 0.0
        r[t] = d[t] - season

    for t in range(LEVEL_WEEKS + SCALE_WEEKS, n):
        window = r[t - SCALE_WEEKS:t]
        centre = float(np.median(window))
        mad = float(np.median(np.abs(window - centre)))
        scale = max(floor, 1.4826 * mad)
        z[t] = (r[t] - centre) / scale
    return z


def alarm_weeks(z) -> list[int]:
    """Weeks where the rule fires: from index 130, z above the limit twice in a row."""
    z = np.asarray(z, dtype=float)
    return [
        t
        for t in range(MONITOR_INDEX, len(z))
        if z[t] > LIMIT and z[t - 1] > LIMIT
    ]


def naive_alarm_weeks(counts) -> list[int]:
    """Weeks where counts beat 1.5 times their own previous-52-week mean twice in a row."""
    counts = np.asarray(counts, dtype=float)
    n = len(counts)
    means = np.full(n, np.nan)
    for t in range(SCALE_WEEKS, n):
        means[t] = float(np.mean(counts[t - SCALE_WEEKS:t]))
    return [
        t
        for t in range(MONITOR_INDEX, n)
        if counts[t] > NAIVE_RATIO * means[t]
        and counts[t - 1] > NAIVE_RATIO * means[t - 1]
    ]


def episode_indices(weeks, z=None, gap: int = EPISODE_GAP_WEEKS) -> list[dict]:
    """Group sorted alarm weeks into episodes.

    The gap is the number of weeks with no alarm between two alarm weeks, so alarms five
    calendar weeks apart (four empty weeks) stay in the same episode.
    """
    ordered = sorted(int(week) for week in weeks)
    if not ordered:
        return []

    groups = [[ordered[0]]]
    for week in ordered[1:]:
        if week - groups[-1][-1] - 1 > gap:
            groups.append([week])
        else:
            groups[-1].append(week)

    z_array = None if z is None else np.asarray(z, dtype=float)
    episodes = []
    for group in groups:
        peak = None
        if z_array is not None:
            values = [z_array[week] for week in group if np.isfinite(z_array[week])]
            peak = round(float(max(values)), 4) if values else None
        episodes.append(
            {
                "start": group[0],
                "end": group[-1],
                "alarm_weeks": len(group),
                "peak_z": peak,
                "event_id": None,
            }
        )
    return episodes


def score_event(
    episodes,
    event_week: int,
    window: int = EVENT_WINDOW_WEEKS,
    start_key: str = "start",
    end_key: str = "end",
) -> dict:
    """Detected, delay and already-open status for one event week."""
    starts = [episode[start_key] for episode in episodes]
    in_window = [
        start for start in starts if event_week <= start <= event_week + window
    ]
    already_open = any(
        episode[start_key] < event_week <= episode[end_key] for episode in episodes
    )
    return {
        "detected": bool(in_window),
        "delay_weeks": min(in_window) - event_week if in_window else None,
        "already_open": already_open,
    }


def assign_event_ids(
    episodes,
    events,
    window: int = EVENT_WINDOW_WEEKS,
    start_key: str = "start",
) -> list[dict]:
    """Set each episode's event_id to the first event window that contains its start."""
    for episode in episodes:
        episode["event_id"] = None
        for event in events:
            if event["week"] <= episode[start_key] <= event["week"] + window:
                episode["event_id"] = event["event_id"]
                break
    return episodes


def week_number(day: date) -> int:
    """Integer week index for a Monday date."""
    return (day - WEEK_ORIGIN).days // 7


def load_weekly(groups: list[str]):
    """Full weekly grid for the radar groups: sorted weeks and one count array per group."""
    path = _sql_path(config.MARTS_DIR / "mart_weekly_product.parquet")
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"SELECT week_start, product_group, complaints "
            f"FROM read_parquet('{path}') ORDER BY week_start, product_group"
        ).fetchall()
    finally:
        con.close()

    wanted = set(groups)
    rows = [row for row in rows if row[1] in wanted]
    weeks = sorted({row[0] for row in rows})
    by_group = {group: {} for group in groups}
    for week, group, complaints in rows:
        by_group[group][week] = int(complaints)
    counts = {
        group: np.array([by_group[group].get(week, 0) for week in weeks], dtype=float)
        for group in groups
    }
    return weeks, counts


def read_events() -> list[dict]:
    path = _sql_path(config.MARTS_DIR / "dim_events.parquet")
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"SELECT event_id, event_date, week_start, product_group, title "
            f"FROM read_parquet('{path}') ORDER BY event_date, event_id"
        ).fetchall()
    finally:
        con.close()
    return [
        {
            "event_id": row[0],
            "event_date": row[1],
            "week_start": row[2],
            "product_group": row[3],
            "title": row[4],
        }
        for row in rows
    ]


def build_series(groups, weeks, counts, events) -> list[dict]:
    """Apply the rule and the naive rule to every radar group."""
    series = []
    for group in groups:
        values = counts[group]
        start = first_nonzero_index(values)
        if start is None:
            series.append(
                {
                    "product_group": group,
                    "start_index": None,
                    "series_start": None,
                    "values": values[:0],
                    "z": np.array([]),
                    "alarms": [],
                    "naive_alarms": [],
                    "episodes": [],
                    "naive_episodes": [],
                    "monitored_from": None,
                    "series_years": 0.0,
                    "group_events": [],
                }
            )
            continue

        series_values = values[start:]
        series_start = weeks[start]
        z = z_scores(series_values)
        alarms = alarm_weeks(z)
        rule_episodes = episode_indices(alarms, z)
        naive_alarms = naive_alarm_weeks(series_values)
        naive_episodes = episode_indices(naive_alarms)

        group_events = [
            {
                "event_id": event["event_id"],
                "week": (event["week_start"] - series_start).days // 7,
            }
            for event in events
            if event["product_group"] == group
        ]
        assign_event_ids(rule_episodes, group_events)
        assign_event_ids(naive_episodes, group_events)

        series.append(
            {
                "product_group": group,
                "start_index": start,
                "series_start": series_start,
                "values": series_values,
                "z": z,
                "alarms": alarms,
                "naive_alarms": naive_alarms,
                "episodes": rule_episodes,
                "naive_episodes": naive_episodes,
                "monitored_from": series_start + timedelta(weeks=MONITOR_INDEX),
                "series_years": round(max(0, len(series_values) - MONITOR_INDEX) / 52, 4),
                "group_events": group_events,
            }
        )
    return series


def _episode_json(series_entry: dict, episode: dict) -> dict:
    start = series_entry["series_start"] + timedelta(weeks=episode["start"])
    end = series_entry["series_start"] + timedelta(weeks=episode["end"])
    return {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "alarm_weeks": episode["alarm_weeks"],
        "peak_z": episode["peak_z"],
        "event_id": episode["event_id"],
    }


def _events_json(events, series) -> list[dict]:
    by_group = {entry["product_group"]: entry for entry in series}
    output = []
    for event in events:
        entry = by_group[event["product_group"]]
        if entry["series_start"] is None:
            rule = {"detected": False, "delay_weeks": None, "already_open": False}
            naive = {"detected": False, "delay_weeks": None, "already_open": False}
        else:
            event_week = (event["week_start"] - entry["series_start"]).days // 7
            rule = score_event(entry["episodes"], event_week)
            naive = score_event(entry["naive_episodes"], event_week)
        lead = None
        if (
            rule["detected"]
            and naive["detected"]
            and rule["delay_weeks"] is not None
            and naive["delay_weeks"] is not None
        ):
            lead = naive["delay_weeks"] - rule["delay_weeks"]
        output.append(
            {
                "event_id": event["event_id"],
                "title": event["title"],
                "event_date": event["event_date"].isoformat(),
                "week_start": event["week_start"].isoformat(),
                "product_group": event["product_group"],
                "detected": rule["detected"],
                "already_open": rule["already_open"],
                "delay_weeks": rule["delay_weeks"],
                "naive_detected": naive["detected"],
                "naive_delay_weeks": naive["delay_weeks"],
                "lead_weeks_vs_naive": lead,
            }
        )
    return output


def _summary(events_json, series) -> dict:
    detected = sum(1 for event in events_json if event["detected"])
    naive_detected = sum(1 for event in events_json if event["naive_detected"])
    unexplained = sum(
        1 for entry in series for episode in entry["episodes"]
        if episode["event_id"] is None
    )
    naive_unexplained = sum(
        1 for entry in series for episode in entry["naive_episodes"]
        if episode["event_id"] is None
    )
    total_years = round(sum(entry["series_years"] for entry in series), 4)
    if total_years > 0:
        unexplained_rate = poisson_rate_num(unexplained, total_years)
        naive_unexplained_rate = poisson_rate_num(naive_unexplained, total_years)
    else:
        unexplained_rate = num(None)
        naive_unexplained_rate = num(None)
    return {
        "events": len(events_json),
        "detected": detected,
        "detection_rate": rate_num(detected, len(events_json)),
        "unexplained_episodes": unexplained,
        "series_years": total_years,
        "unexplained_per_series_year": unexplained_rate,
        "naive_detected": naive_detected,
        "naive_unexplained_episodes": naive_unexplained,
        "naive_unexplained_per_series_year": naive_unexplained_rate,
    }


def _novelty_block() -> dict | None:
    """Read novelty_weekly.csv, when it exists, and rebuild its series and scoring."""
    if not NOVELTY_WEEKLY_PATH.exists():
        return None

    rows_by_group: dict[str, list[dict]] = {}
    with NOVELTY_WEEKLY_PATH.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            rows_by_group.setdefault(row["product_group"], []).append(row)

    groups = [group for group in read_radar_groups() if group in rows_by_group]
    events = read_events()
    series = []
    episodes_by_group = {}
    for group in groups:
        rows = sorted(rows_by_group[group], key=lambda row: row["week_start"])
        days = [date.fromisoformat(row["week_start"]) for row in rows]
        z = np.array(
            [float(row["z"]) if row["z"].strip() else np.nan for row in rows],
            dtype=float,
        )
        alarms = [index for index, row in enumerate(rows) if int(row["alarm"]) == 1]
        episodes = episode_indices(alarms, z)
        for episode in episodes:
            episode["start_week"] = week_number(days[episode["start"]])
            episode["end_week"] = week_number(days[episode["end"]])

        group_events = [
            {"event_id": event["event_id"], "week": week_number(event["week_start"])}
            for event in events
            if event["product_group"] == group
        ]
        assign_event_ids(episodes, group_events, start_key="start_week")
        episodes_by_group[group] = episodes

        series.append(
            {
                "product_group": group,
                "monitored_from": (
                    days[MONITOR_INDEX].isoformat() if len(days) > MONITOR_INDEX else None
                ),
                "series_years": round(max(0, len(rows) - MONITOR_INDEX) / 52, 4),
                "episodes": [
                    {
                        "start": days[episode["start"]].isoformat(),
                        "end": days[episode["end"]].isoformat(),
                        "alarm_weeks": episode["alarm_weeks"],
                        "peak_z": episode["peak_z"],
                        "event_id": episode["event_id"],
                    }
                    for episode in episodes
                ],
            }
        )

    novelty_events = []
    for event in events:
        episodes = episodes_by_group.get(event["product_group"], [])
        result = score_event(
            episodes,
            week_number(event["week_start"]),
            start_key="start_week",
            end_key="end_week",
        )
        novelty_events.append(
            {
                "event_id": event["event_id"],
                "detected": result["detected"],
                "already_open": result["already_open"],
                "delay_weeks": result["delay_weeks"],
            }
        )

    unexplained = sum(
        1 for entry in series for episode in entry["episodes"]
        if episode["event_id"] is None
    )
    total_years = round(sum(entry["series_years"] for entry in series), 4)
    rate = poisson_rate_num(unexplained, total_years) if total_years > 0 else num(None)
    return {
        "series": series,
        "events": novelty_events,
        "unexplained_episodes": unexplained,
        "unexplained_per_series_year": rate,
    }


def build_radar_payload(groups=None, weeks=None, counts=None, events=None, series=None) -> dict:
    """Everything in radar.json, including the novelty block when its CSV exists."""
    if groups is None:
        groups = read_radar_groups()
    if weeks is None or counts is None:
        weeks, counts = load_weekly(groups)
    if events is None:
        events = read_events()
    if series is None:
        series = build_series(groups, weeks, counts, events)

    events_json = _events_json(events, series)
    summary = _summary(events_json, series)
    passed = (
        summary["detected"] >= 4
        and summary["unexplained_per_series_year"]["value"] is not None
        and summary["unexplained_per_series_year"]["value"] <= 1.0
    )
    return {
        "rule": {
            "level_weeks": LEVEL_WEEKS,
            "scale_weeks": SCALE_WEEKS,
            "limit": LIMIT,
            "consecutive": CONSECUTIVE,
            "monitor_from_week": MONITOR_FROM_WEEK,
            "episode_gap_weeks": EPISODE_GAP_WEEKS,
            "event_window_weeks": EVENT_WINDOW_WEEKS,
            "naive_ratio": NAIVE_RATIO,
        },
        "weeks": {
            "first": weeks[0].isoformat(),
            "last": weeks[-1].isoformat(),
            "n": len(weeks),
        },
        "series": [
            {
                "product_group": entry["product_group"],
                "monitored_from": (
                    entry["monitored_from"].isoformat()
                    if entry["monitored_from"] is not None
                    else None
                ),
                "series_years": entry["series_years"],
                "episodes": [
                    _episode_json(entry, episode) for episode in entry["episodes"]
                ],
                "naive_episodes": [
                    _episode_json(entry, episode) for episode in entry["naive_episodes"]
                ],
            }
            for entry in series
        ],
        "events": events_json,
        "summary": summary,
        "h3": {"pass": bool(passed)},
        "novelty": _novelty_block(),
    }


def write_radar_json() -> dict:
    """Rebuild radar.json from the marts and, if present, novelty_weekly.csv."""
    payload = build_radar_payload()
    RADAR_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    RADAR_JSON_PATH.write_text(
        json.dumps(payload, indent=1) + "\n", encoding="utf-8"
    )
    return payload


def write_radar_weekly(groups, weeks, counts, series) -> None:
    """Write every full week for the ten groups, with z blank before monitoring starts."""
    RADAR_WEEKLY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with RADAR_WEEKLY_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["week_start", "product_group", "complaints", "z", "alarm", "naive_alarm"]
        )
        for group, entry in zip(groups, series, strict=True):
            start = entry["start_index"]
            alarms = set(entry["alarms"])
            naive = set(entry["naive_alarms"])
            z = entry["z"]
            for index, week in enumerate(weeks):
                local = index - start if start is not None and index >= start else None
                if local is None:
                    z_text = ""
                    alarm = 0
                    naive_alarm = 0
                else:
                    z_text = (
                        f"{z[local]:.4f}"
                        if local >= MONITOR_INDEX and np.isfinite(z[local])
                        else ""
                    )
                    alarm = 1 if local in alarms else 0
                    naive_alarm = 1 if local in naive else 0
                writer.writerow(
                    [
                        week.isoformat(),
                        group,
                        int(counts[group][index]),
                        z_text,
                        alarm,
                        naive_alarm,
                    ]
                )


def run() -> dict:
    """Write radar_weekly.csv and radar.json."""
    groups = read_radar_groups()
    weeks, counts = load_weekly(groups)
    events = read_events()
    series = build_series(groups, weeks, counts, events)
    write_radar_weekly(groups, weeks, counts, series)
    payload = build_radar_payload(groups, weeks, counts, events, series)
    RADAR_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    RADAR_JSON_PATH.write_text(
        json.dumps(payload, indent=1) + "\n", encoding="utf-8"
    )
    return payload


def main() -> int:
    run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
