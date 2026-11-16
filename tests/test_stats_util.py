import numpy as np
from sklearn.metrics import accuracy_score, f1_score
from statsmodels.stats.proportion import proportion_confint

from analysis import stats_util as su


def test_wilson_matches_statsmodels():
    low, high = su.wilson(50, 1000)
    ref = proportion_confint(50, 1000, method="wilson")
    assert abs(low - ref[0]) < 1e-9 and abs(high - ref[1]) < 1e-9
    assert su.wilson(0, 0) == (None, None)
    assert su.rate_num(0, 0)["value"] is None


def test_poisson_interval_known_values():
    r = su.poisson_rate_num(0, 10.0)
    assert r["value"] == 0 and r["ci_low"] == 0 and abs(r["ci_high"] - 0.368888) < 1e-5
    r = su.poisson_rate_num(10, 5.0)  # exact interval for 10 events is 4.7954 to 18.3904
    assert abs(r["ci_low"] - 0.959078) < 1e-5 and abs(r["ci_high"] - 3.678078) < 1e-5


def test_metrics_match_sklearn():
    rng = np.random.default_rng(1)
    y, p = rng.integers(0, 5, 2000), rng.integers(0, 5, 2000)
    cm = su.confusion(y, p, 5)
    assert abs(su.macro_f1(cm) - f1_score(y, p, average="macro")) < 1e-12
    assert abs(su.accuracy(cm) - accuracy_score(y, p)) < 1e-12
    out = su.bootstrap_metrics(y, p, 5, n_boot=200)
    assert out["macro_f1"]["ci_low"] <= out["macro_f1"]["value"] <= out["macro_f1"]["ci_high"]
    assert out == su.bootstrap_metrics(y, p, 5, n_boot=200)


def test_macro_f1_skips_absent_and_excluded_classes():
    cm = su.confusion(np.array([0, 0, 1, 1]), np.array([0, 0, 1, 2]), 3)
    assert abs(su.macro_f1(cm) - (1 + 2 / 3) / 2) < 1e-12
    assert su.macro_f1(cm, classes=[0]) == 1.0


def test_paired_difference_sign_and_zero():
    rng = np.random.default_rng(2)
    y = rng.integers(0, 4, 800)
    good = np.where(rng.random(800) < 0.9, y, (y + 1) % 4)
    bad = np.where(rng.random(800) < 0.5, y, (y + 1) % 4)
    d = su.paired_macro_f1_difference(y, good, bad, 4, strata=y, n_boot=300)
    assert d["ci_low"] > 0
    same = su.paired_macro_f1_difference(y, good, good, 4, strata=y, n_boot=50)
    assert same["value"] == 0 and same["ci_low"] == 0 and same["ci_high"] == 0


def test_reliability_perfect_and_overconfident():
    table, ece = su.reliability([0.95] * 100, [1] * 95 + [0] * 5)
    assert ece == 0 and table[0]["n"] == 100 and table[0]["bin_low"] == 0.9
    assert su.reliability([1.0] * 10, [0] * 10)[1] == 1.0


def test_route_threshold_known_answer():
    conf = np.array([0.99, 0.98, 0.97, 0.9, 0.9, 0.5])
    correct = np.array([1, 1, 1, 1, 0, 0])
    # at 0.9 precision is 4/5 = 0.8; at 0.97 it is 3/3
    assert su.route_threshold(conf, correct, 0.95) == 0.97
    assert su.route_threshold(conf, correct, 0.8) == 0.9
    assert su.route_threshold(np.array([0.9, 0.8]), np.array([0, 0]), 0.95) is None
    r = su.route_result(conf, correct, 0.97)
    assert r["coverage"]["value"] == 0.5 and r["precision"]["value"] == 1.0
    assert su.route_result(conf, correct, None)["coverage"]["value"] == 0
