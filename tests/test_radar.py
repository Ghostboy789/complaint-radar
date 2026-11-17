"""Synthetic checks for the radar rule; no files are read."""
from __future__ import annotations

import numpy as np

from analysis import radar


def test_constant_series_has_zero_z_and_no_alarm():
    values = np.full(300, 100.0)
    z = radar.z_scores(values)
    assert np.isnan(z[:78]).all()
    assert np.allclose(z[78:], 0.0)
    assert radar.alarm_weeks(z) == []


def test_spike_run_alarms_on_the_second_week():
    values = np.full(300, 100.0)
    values[200:206] = 300.0
    z = radar.z_scores(values)
    alarms = radar.alarm_weeks(z)
    assert alarms == [201, 202, 203, 204, 205]

    episodes = radar.episode_indices(alarms, z)
    assert len(episodes) == 1
    assert episodes[0]["start"] == 201

    assert radar.score_event(episodes, 200) == {
        "detected": True,
        "delay_weeks": 1,
        "already_open": False,
    }
    assert radar.score_event(episodes, 190)["detected"] is False


def test_season_removes_repeating_spikes_after_three_years():
    values = np.full(400, 100.0)
    for week in range(len(values)):
        if week % 52 in (10, 11):
            values[week] = 300.0
    z = radar.z_scores(values)
    alarms = radar.alarm_weeks(z)
    assert all(week < 182 for week in alarms)


def test_series_starts_at_the_first_nonzero_week():
    values = np.concatenate([np.zeros(50), np.full(200, 100.0)])
    trimmed, start = radar.trim_series(values)
    assert start == 50
    assert len(trimmed) == 200
    assert radar.first_nonzero_index(values) == 50
    assert radar.alarm_weeks(radar.z_scores(trimmed)) == []


def test_naive_rule_needs_two_weeks_above_the_mean():
    values = np.full(300, 100.0)
    values[200:202] = 152.0
    assert radar.naive_alarm_weeks(values) == [201]

    # The second week's 52-week mean includes the first 151, so 151 sits just under
    # 1.5 times that mean; 152 is the smallest whole number that clears it.
    values[200:202] = 151.0
    assert radar.naive_alarm_weeks(values) == []
    values[200:202] = 149.0
    assert radar.naive_alarm_weeks(values) == []


def test_episode_gap_groups_alarms():
    # 11 -> 15 is 4 weeks apart (same episode); 15 -> 20 is 5 weeks apart (new episode)
    episodes = radar.episode_indices([10, 11, 15, 20, 24, 30])
    assert [(episode["start"], episode["end"]) for episode in episodes] == [
        (10, 15),
        (20, 24),
        (30, 30),
    ]


def test_episode_already_open_does_not_count():
    episodes = radar.episode_indices(range(195, 203))
    result = radar.score_event(episodes, 200)
    assert result["detected"] is False
    assert result["already_open"] is True


def test_no_z_or_alarm_before_the_warmup():
    values = np.full(300, 100.0)
    values[100] = 1_000_000.0
    z = radar.z_scores(values)
    assert np.isnan(z[:78]).all()
    assert radar.alarm_weeks(z) == []
