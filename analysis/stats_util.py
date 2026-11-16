"""Shared statistics: intervals, classification metrics, calibration, routing threshold.

Bootstraps take arrays the caller has already sorted by complaint id, so a result never
depends on the row order of a Parquet file.
"""
import math

import numpy as np
from scipy import stats


def num(value, ci_low=None, ci_high=None, n=None) -> dict:
    """The NUM shape used in every artefact: plain floats rounded to 6 places."""
    def clean(v):
        return None if v is None else round(float(v), 6)
    return {"value": clean(value), "ci_low": clean(ci_low), "ci_high": clean(ci_high),
            "n": None if n is None else int(n)}


def wilson(k: int, n: int, z: float = 1.959963984540054):
    if n == 0:
        return None, None
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return max(0.0, centre - half), min(1.0, centre + half)


def rate_num(k: int, n: int) -> dict:
    low, high = wilson(k, n)
    return num(k / n if n else None, low, high, n)


def poisson_rate_num(events: int, exposure: float) -> dict:
    """Events per unit of exposure with the exact (Garwood) 95% interval."""
    low = stats.chi2.ppf(0.025, 2 * events) / 2 if events > 0 else 0.0
    high = stats.chi2.ppf(0.975, 2 * events + 2) / 2
    return num(events / exposure, low / exposure, high / exposure, events)


def confusion(y_true, y_pred, k: int) -> np.ndarray:
    """k x k counts, rows = true class, columns = predicted class."""
    return np.bincount(np.asarray(y_true) * k + np.asarray(y_pred), minlength=k * k).reshape(k, k)


def per_class(cm: np.ndarray):
    tp = np.diag(cm).astype(float)
    pred, true = cm.sum(axis=0), cm.sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        precision = np.where(pred > 0, tp / pred, 0.0)
        recall = np.where(true > 0, tp / true, 0.0)
        f1 = np.where(2 * tp + (pred - tp) + (true - tp) > 0, 2 * tp / (pred + true), 0.0)
    return precision, recall, f1


def macro_f1(cm: np.ndarray, classes=None) -> float:
    """Mean F1 over `classes` (default: every class with at least one true row)."""
    f1 = per_class(cm)[2]
    keep = np.flatnonzero(cm.sum(axis=1) > 0) if classes is None else np.asarray(classes)
    return float(f1[keep].mean())


def accuracy(cm: np.ndarray) -> float:
    return float(np.diag(cm).sum() / cm.sum())


def _draws(n: int, n_boot: int, seed: int, strata=None):
    rng = np.random.default_rng(seed)
    groups = None if strata is None else [np.flatnonzero(strata == s) for s in np.unique(strata)]
    for _ in range(n_boot):
        if groups is None:
            yield rng.integers(0, n, n)
        else:
            yield np.concatenate([rng.choice(g, len(g)) for g in groups])


def bootstrap_metrics(y_true, y_pred, k: int, n_boot=1000, seed=0, classes=None, strata=None):
    """NUMs for macro-F1 and accuracy with percentile intervals over resampled rows."""
    y_true, y_pred = np.asarray(y_true), np.asarray(y_pred)
    cm = confusion(y_true, y_pred, k)
    f1s, accs = [], []
    for idx in _draws(len(y_true), n_boot, seed, strata):
        b = confusion(y_true[idx], y_pred[idx], k)
        f1s.append(macro_f1(b, classes))
        accs.append(accuracy(b))
    n = len(y_true)
    return {
        "macro_f1": num(macro_f1(cm, classes), *np.percentile(f1s, [2.5, 97.5]), n),
        "accuracy": num(accuracy(cm), *np.percentile(accs, [2.5, 97.5]), n),
    }


def paired_macro_f1_difference(y_true, pred_a, pred_b, k: int, strata, n_boot=2000, seed=0,
                               classes=None) -> dict:
    """NUM for macro-F1(a) - macro-F1(b) on the same rows, resampled within strata."""
    y_true, pred_a, pred_b = np.asarray(y_true), np.asarray(pred_a), np.asarray(pred_b)

    def diff(idx):
        return (macro_f1(confusion(y_true[idx], pred_a[idx], k), classes)
                - macro_f1(confusion(y_true[idx], pred_b[idx], k), classes))

    draws = [diff(idx) for idx in _draws(len(y_true), n_boot, seed, np.asarray(strata))]
    return num(diff(np.arange(len(y_true))), *np.percentile(draws, [2.5, 97.5]), len(y_true))


def reliability(confidence, correct, bins: int = 10):
    """Equal-width bins of the top probability: the table and the expected calibration error."""
    confidence, correct = np.asarray(confidence, float), np.asarray(correct, float)
    which = np.minimum((confidence * bins).astype(int), bins - 1)
    table, ece = [], 0.0
    for b in range(bins):
        m = which == b
        if not m.any():
            continue
        mean_conf, acc = float(confidence[m].mean()), float(correct[m].mean())
        ece += m.sum() / len(confidence) * abs(mean_conf - acc)
        table.append({"bin_low": b / bins, "bin_high": (b + 1) / bins, "n": int(m.sum()),
                      "mean_confidence": round(mean_conf, 6), "accuracy": round(acc, 6)})
    return table, round(float(ece), 6)


def route_threshold(confidence, correct, target: float = 0.95):
    """Smallest threshold whose rows at or above it are at least `target` correct, or None."""
    confidence, correct = np.asarray(confidence, float), np.asarray(correct, float)
    order = np.argsort(-confidence, kind="stable")
    conf, precision = confidence[order], np.cumsum(correct[order]) / np.arange(1, len(order) + 1)
    last_of_tie = np.append(conf[1:] != conf[:-1], True)
    ok = np.flatnonzero(last_of_tie & (precision >= target))
    return None if len(ok) == 0 else float(conf[ok[-1]])


def route_result(confidence, correct, threshold) -> dict:
    """Coverage and precision of automatic routing at a threshold, with Wilson intervals."""
    confidence, correct = np.asarray(confidence, float), np.asarray(correct, float)
    routed = np.zeros(len(confidence), bool) if threshold is None else confidence >= threshold
    return {"coverage": rate_num(int(routed.sum()), len(routed)),
            "precision": rate_num(int(correct[routed].sum()), int(routed.sum()))}
