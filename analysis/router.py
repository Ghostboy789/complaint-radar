"""Complaint router models: majority, words (TF-IDF + logistic regression) and embeddings.

Everything is read from the router sample mart in complaint_id order and every fitted model is
deterministic. Run with ``python -m analysis.router`` for the result files; add ``--measure`` to
time scoring instead.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import time
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

import config
from analysis import embed as embed_module
from analysis.embed import embed
from analysis.stats_util import (
    bootstrap_metrics,
    confusion,
    macro_f1,
    num,
    per_class,
    rate_num,
    reliability,
    route_result,
    route_threshold,
)

PRODUCT_GROUPS_PATH = config.REPO_ROOT / "dbt" / "seeds" / "product_groups.csv"
SITE_MODEL_PATH = config.REPO_ROOT / "site" / "data" / "model.json"

SPLIT_DATES = {
    "train": ("2023-09-01", "2024-12-31"),
    "validation": ("2025-01-01", "2025-12-31"),
    "test": ("2026-01-01", "2026-06-30"),
}
C_GRID = (0.3, 1.0, 3.0, 10.0)
MIN_IN_MACRO = 100
TFIDF_PARAMS = dict(
    lowercase=True,
    token_pattern=r"[a-z0-9]{2,}",
    ngram_range=(1, 2),
    min_df=5,
    max_features=30000,
    sublinear_tf=True,
    norm="l2",
)


def _clock(start: float, message: str) -> None:
    print(f"[{time.perf_counter() - start:.1f}s] {message}", flush=True)


def _limit() -> int | None:
    value = os.environ.get("CR_ROUTER_LIMIT")
    return None if value in (None, "") else int(value)


def read_products() -> list[str]:
    """Current product names in the fixed order of product_groups.csv."""
    with PRODUCT_GROUPS_PATH.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return [row["current_product"] for row in rows]


def load_samples(limit: int | None = None) -> pd.DataFrame:
    """The router mart, always ordered by complaint_id.

    With a limit, keep the first N rows of each split in md5(complaint_id) order. That is for
    quick smoke runs only.
    """
    path = str(config.MARTS_DIR / "mart_router_samples.parquet").replace("'", "''")
    columns = (
        "complaint_id, split, date_received, product, issue, text_hash, is_new_text, narrative"
    )
    if limit is None:
        sql = f"SELECT {columns} FROM read_parquet('{path}') ORDER BY complaint_id"
    else:
        sql = f"""
            WITH ranked AS (
                SELECT *, row_number() OVER (
                    PARTITION BY split ORDER BY md5(CAST(complaint_id AS VARCHAR))
                ) AS rn
                FROM read_parquet('{path}')
            )
            SELECT {columns}
            FROM ranked
            WHERE rn <= {int(limit)}
            ORDER BY complaint_id
        """
    con = duckdb.connect()
    try:
        return con.execute(sql).fetch_df()
    finally:
        con.close()


def _expand_proba(classifier, features, n_classes: int) -> np.ndarray:
    """Predictions as a dense n_rows x n_classes matrix, even when a class has no train rows."""
    proba = classifier.predict_proba(features)
    full = np.zeros((proba.shape[0], n_classes), dtype=float)
    full[:, np.asarray(classifier.classes_, dtype=int)] = proba
    return full


def fit_majority(y_train: np.ndarray, n_classes: int) -> tuple[int, float]:
    counts = np.bincount(y_train, minlength=n_classes)
    index = int(counts.argmax())
    return index, float(counts[index] / len(y_train))


def fit_words(train_texts: list[str], y_train: np.ndarray, val_texts: list[str],
              y_val: np.ndarray, n_classes: int) -> dict:
    """Fit the TF-IDF pipeline for every C and keep the best validation macro-F1."""
    vectorizer = TfidfVectorizer(**TFIDF_PARAMS)
    x_train = vectorizer.fit_transform(train_texts)
    x_val = vectorizer.transform(val_texts)
    best = None
    for c in C_GRID:
        classifier = LogisticRegression(C=c, max_iter=1000, random_state=0)
        classifier.fit(x_train, y_train)
        proba = _expand_proba(classifier, x_val, n_classes)
        pred = proba.argmax(axis=1)
        score = macro_f1(confusion(y_val, pred, n_classes))
        if best is None or score > best["validation_macro_f1"]:
            best = {
                "c": float(c),
                "vectorizer": vectorizer,
                "classifier": classifier,
                "validation_macro_f1": float(score),
                "validation_proba": proba,
                "validation_pred": pred,
            }
    return best


def fit_embeddings(train_emb: np.ndarray, y_train: np.ndarray, val_emb: np.ndarray,
                   y_val: np.ndarray, n_classes: int) -> dict:
    best = None
    for c in C_GRID:
        classifier = LogisticRegression(C=c, max_iter=2000, random_state=0)
        classifier.fit(train_emb, y_train)
        proba = _expand_proba(classifier, val_emb, n_classes)
        pred = proba.argmax(axis=1)
        score = macro_f1(confusion(y_val, pred, n_classes))
        if best is None or score > best["validation_macro_f1"]:
            best = {
                "c": float(c),
                "classifier": classifier,
                "validation_macro_f1": float(score),
                "validation_proba": proba,
                "validation_pred": pred,
            }
    return best


def _empty_metrics(products: list[str]) -> dict:
    n_classes = len(products)
    return {
        "macro_f1": num(None),
        "accuracy": num(None),
        "ece": 0.0,
        "per_product": [
            {"product": product, "precision": 0.0, "recall": 0.0, "f1": 0.0, "n": 0}
            for product in products
        ],
        "reliability": [],
        "confusion": [[0] * n_classes for _ in range(n_classes)],
    }


def build_metrics(y_true: np.ndarray, y_pred: np.ndarray, confidence: np.ndarray,
                  products: list[str], classes: np.ndarray) -> dict:
    if len(y_true) == 0:
        return _empty_metrics(products)
    n_classes = len(products)
    boot = bootstrap_metrics(y_true, y_pred, n_classes, n_boot=1000, seed=0, classes=classes)
    cm = confusion(y_true, y_pred, n_classes)
    precision, recall, f1 = per_class(cm)
    correct = (y_true == y_pred).astype(int)
    table, ece = reliability(confidence, correct)
    return {
        "macro_f1": boot["macro_f1"],
        "accuracy": boot["accuracy"],
        "ece": ece,
        "per_product": [
            {
                "product": products[i],
                "precision": round(float(precision[i]), 6),
                "recall": round(float(recall[i]), 6),
                "f1": round(float(f1[i]), 6),
                "n": int(cm[i].sum()),
            }
            for i in range(n_classes)
        ],
        "reliability": table,
        "confusion": [[int(value) for value in row] for row in cm],
    }


def build_model_report(products: list[str], c: float | None, validation_macro_f1: float,
                       y_val: np.ndarray, val_pred: np.ndarray, val_conf: np.ndarray,
                       y_test: np.ndarray, test_pred: np.ndarray, test_conf: np.ndarray,
                       new_mask: np.ndarray, macro_classes: np.ndarray) -> dict:
    val_correct = (val_pred == y_val).astype(int)
    threshold = route_threshold(val_conf, val_correct, 0.95)
    if threshold is None:
        validation_precision = None
    else:
        validation_precision = route_result(val_conf, val_correct, threshold)["precision"]["value"]

    test_correct = (test_pred == y_test).astype(int)
    new_y = y_test[new_mask]
    new_pred = test_pred[new_mask]
    new_conf = test_conf[new_mask]
    new_correct = test_correct[new_mask]

    by_product = []
    for i, product in enumerate(products):
        chosen = test_pred == i
        routed = route_result(test_conf[chosen], test_correct[chosen], threshold)
        by_product.append(
            {"product": product, "coverage": routed["coverage"], "precision": routed["precision"]}
        )

    return {
        "c": None if c is None else round(float(c), 6),
        "validation_macro_f1": round(float(validation_macro_f1), 6),
        "test": build_metrics(y_test, test_pred, test_conf, products, macro_classes),
        "test_new_text": build_metrics(new_y, new_pred, new_conf, products, macro_classes),
        "auto_route": {
            "threshold": None if threshold is None else round(float(threshold), 6),
            "validation_precision": (
                None if validation_precision is None else round(float(validation_precision), 6)
            ),
            "test": route_result(test_conf, test_correct, threshold),
            "test_new_text": route_result(new_conf, new_correct, threshold),
            "by_product": by_product,
        },
    }


def _issue_within_product(train: pd.DataFrame, test: pd.DataFrame, products: list[str]) -> list:
    results = []
    for product in products:
        train_rows = train[train["product"] == product]
        test_rows = test[test["product"] == product]
        if len(test_rows) == 0:
            continue

        counts = train_rows["issue"].value_counts()
        kept = set(counts[counts >= 50].index)
        train_issue = train_rows["issue"].where(train_rows["issue"].isin(kept), "Other issue")
        test_issue = test_rows["issue"].where(test_rows["issue"].isin(kept), "Other issue")
        model_classes = sorted(set(train_issue))
        if len(model_classes) < 2:
            continue

        label_classes = sorted(set(train_issue) | set(test_issue))
        label_index = {label: index for index, label in enumerate(label_classes)}
        y_train = np.array([label_index[label] for label in train_issue], dtype=int)
        y_test = np.array([label_index[label] for label in test_issue], dtype=int)

        vectorizer = TfidfVectorizer(**TFIDF_PARAMS)
        classifier = LogisticRegression(C=1.0, max_iter=1000, random_state=0)
        classifier.fit(
            vectorizer.fit_transform(train_rows["narrative"].fillna("").tolist()), y_train
        )
        proba = _expand_proba(
            classifier,
            vectorizer.transform(test_rows["narrative"].fillna("").tolist()),
            len(label_classes),
        )
        pred = proba.argmax(axis=1)
        boot = bootstrap_metrics(
            y_test, pred, len(label_classes), n_boot=1000, seed=0, classes=np.unique(y_test)
        )

        train_counts = np.bincount(y_train, minlength=len(label_classes))
        majority = int(train_counts.argmax())
        majority_accuracy = rate_num(int((y_test == majority).sum()), len(y_test))

        results.append(
            {
                "product": product,
                "issues": len(model_classes),
                "train_rows": len(train_rows),
                "test_rows": len(test_rows),
                "majority_accuracy": majority_accuracy,
                "words_accuracy": boot["accuracy"],
                "words_macro_f1": boot["macro_f1"],
            }
        )
    return results


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")


def write_predictions(rows: list[dict]) -> None:
    frame = pd.DataFrame(
        rows, columns=["complaint_id", "split", "model", "pred", "confidence"]
    )
    target = str(config.MODELS_DIR / "predictions.parquet").replace("'", "''")
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    try:
        con.register("pred_df", frame)
        con.execute(
            f"""
            COPY (
                SELECT CAST(complaint_id AS BIGINT) AS complaint_id,
                       CAST(split AS VARCHAR) AS split,
                       CAST(model AS VARCHAR) AS model,
                       CAST(pred AS INTEGER) AS pred,
                       CAST(confidence AS DOUBLE) AS confidence
                FROM pred_df
                ORDER BY model, split, complaint_id
            ) TO '{target}' (FORMAT parquet)
            """
        )
    finally:
        con.close()


def write_site_model(words: dict, products: list[str], threshold: float | None) -> None:
    vectorizer = words["vectorizer"]
    classifier = words["classifier"]
    terms = [str(term) for term in vectorizer.get_feature_names_out()]
    coefficient = [[0.0] * len(terms) for _ in products]
    intercept = [0.0] * len(products)
    for row, label in enumerate(classifier.classes_):
        index = int(label)
        coefficient[index] = [round(float(value), 4) for value in classifier.coef_[row]]
        intercept[index] = round(float(classifier.intercept_[row]), 6)
    payload = {
        "products": products,
        "terms": terms,
        "idf": [round(float(value), 6) for value in vectorizer.idf_],
        "coef": coefficient,
        "intercept": intercept,
        "threshold": None if threshold is None else round(float(threshold), 6),
    }
    SITE_MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    SITE_MODEL_PATH.write_text(
        json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8"
    )


def load_and_fit(limit: int | None = None) -> dict:
    """Read the mart, fit all models and return everything the result writers need."""
    start = time.perf_counter()
    products = read_products()
    product_index = {product: index for index, product in enumerate(products)}
    n_classes = len(products)

    frame = load_samples(limit)
    _clock(start, f"read {len(frame)} router rows")

    train = frame[frame["split"] == "train"].reset_index(drop=True)
    val = frame[frame["split"] == "validation"].reset_index(drop=True)
    test = frame[frame["split"] == "test"].reset_index(drop=True)

    def labels(split_frame: pd.DataFrame) -> np.ndarray:
        try:
            return np.array(
                [product_index[product] for product in split_frame["product"]], dtype=int
            )
        except KeyError as error:
            raise ValueError(f"product not in product_groups.csv: {error}") from error

    y_train = labels(train)
    y_val = labels(val)
    y_test = labels(test)

    train_texts = train["narrative"].fillna("").tolist()
    val_texts = val["narrative"].fillna("").tolist()
    test_texts = test["narrative"].fillna("").tolist()

    majority_index, majority_share = fit_majority(y_train, n_classes)
    majority = {
        "index": majority_index,
        "confidence": majority_share,
        "validation_pred": np.full(len(val), majority_index, dtype=int),
        "validation_conf": np.full(len(val), majority_share, dtype=float),
        "test_pred": np.full(len(test), majority_index, dtype=int),
        "test_conf": np.full(len(test), majority_share, dtype=float),
    }
    majority["validation_macro_f1"] = macro_f1(
        confusion(y_val, majority["validation_pred"], n_classes)
    )
    _clock(start, "fit majority")

    words = fit_words(train_texts, y_train, val_texts, y_val, n_classes)
    words["test_proba"] = _expand_proba(
        words["classifier"], words["vectorizer"].transform(test_texts), n_classes
    )
    _clock(start, f"fit words (C={words['c']})")

    train_ids = train["complaint_id"].tolist()
    val_ids = val["complaint_id"].tolist()
    test_ids = test["complaint_id"].tolist()
    train_emb = embed(train_texts, "train", train_ids)
    val_emb = embed(val_texts, "validation", val_ids)
    _clock(start, "embed train and validation text")
    embeddings = fit_embeddings(train_emb, y_train, val_emb, y_val, n_classes)
    del train_emb, val_emb
    test_emb = embed(test_texts, "test", test_ids)
    embeddings["test_proba"] = _expand_proba(embeddings["classifier"], test_emb, n_classes)
    del test_emb
    _clock(start, f"fit embeddings (C={embeddings['c']})")

    new_mask = test["is_new_text"].fillna(False).to_numpy(dtype=bool)

    return {
        "products": products,
        "n_classes": n_classes,
        "frame": frame,
        "train": train,
        "val": val,
        "test": test,
        "train_texts": train_texts,
        "test_texts": test_texts,
        "y_train": y_train,
        "y_val": y_val,
        "y_test": y_test,
        "new_mask": new_mask,
        "majority": majority,
        "words": words,
        "embeddings": embeddings,
        "validation_ids": val_ids,
        "test_ids": test_ids,
    }


def run(limit: int | None = None) -> dict:
    """Fit the models and write router.json, predictions.parquet and model.json."""
    start = time.perf_counter()
    context = load_and_fit(_limit() if limit is None else limit)
    products = context["products"]
    n_classes = context["n_classes"]
    y_val = context["y_val"]
    y_test = context["y_test"]
    new_mask = context["new_mask"]

    test_counts = np.bincount(y_test, minlength=n_classes)
    new_counts = np.bincount(y_test[new_mask], minlength=n_classes)
    macro_classes = np.flatnonzero(test_counts >= MIN_IN_MACRO)

    reports = {}
    for name in ("majority", "words", "embeddings"):
        model = context[name]
        if name == "majority":
            val_pred = model["validation_pred"]
            val_conf = model["validation_conf"]
            test_pred = model["test_pred"]
            test_conf = model["test_conf"]
            c = None
        else:
            val_pred = model["validation_pred"]
            val_conf = model["validation_proba"].max(axis=1)
            test_pred = model["test_proba"].argmax(axis=1)
            test_conf = model["test_proba"].max(axis=1)
            c = model["c"]
        reports[name] = build_model_report(
            products=products,
            c=c,
            validation_macro_f1=model["validation_macro_f1"],
            y_val=y_val,
            val_pred=val_pred,
            val_conf=val_conf,
            y_test=y_test,
            test_pred=test_pred,
            test_conf=test_conf,
            new_mask=new_mask,
            macro_classes=macro_classes,
        )
        _clock(start, f"evaluate {name}")

    class_counts = [
        {
            "product": product,
            "train": int(np.bincount(context["y_train"], minlength=n_classes)[i]),
            "validation": int(np.bincount(y_val, minlength=n_classes)[i]),
            "test": int(test_counts[i]),
            "test_new_text": int(new_counts[i]),
            "in_macro_f1": bool(test_counts[i] >= MIN_IN_MACRO),
        }
        for i, product in enumerate(products)
    ]

    split = {}
    for name in ("train", "validation", "test"):
        low, high = SPLIT_DATES[name]
        entry = {"from": low, "to": high, "rows": int((context["frame"]["split"] == name).sum())}
        if name == "test":
            entry["new_text_rows"] = int(new_mask.sum())
        split[name] = entry

    words_test_route = reports["words"]["auto_route"]["test"]
    coverage = words_test_route["coverage"]["value"]
    precision = words_test_route["precision"]["value"]
    h2 = {
        "model": "words",
        "coverage": words_test_route["coverage"],
        "precision": words_test_route["precision"],
        "pass": bool(
            precision is not None
            and coverage is not None
            and precision >= 0.95
            and coverage >= 0.50
        ),
    }

    issues = _issue_within_product(context["train"], context["test"], products)
    _clock(start, "issue within product")

    payload = {
        "products": products,
        "split": split,
        "class_counts": class_counts,
        "models": reports,
        "h2": h2,
        "issue_within_product": issues,
    }
    write_json(config.ARTEFACTS_DIR / "router.json", payload)
    _clock(start, "wrote router.json")

    prediction_rows = []
    for name in ("majority", "words", "embeddings"):
        model = context[name]
        if name == "majority":
            val_pred, val_conf = model["validation_pred"], model["validation_conf"]
            test_pred, test_conf = model["test_pred"], model["test_conf"]
        else:
            val_pred = model["validation_pred"]
            val_conf = model["validation_proba"].max(axis=1)
            test_pred = model["test_proba"].argmax(axis=1)
            test_conf = model["test_proba"].max(axis=1)
        for split_name, ids, predictions, confidence in (
            ("validation", context["validation_ids"], val_pred, val_conf),
            ("test", context["test_ids"], test_pred, test_conf),
        ):
            for complaint_id, pred, conf in zip(ids, predictions, confidence, strict=True):
                prediction_rows.append(
                    {
                        "complaint_id": int(complaint_id),
                        "split": split_name,
                        "model": name,
                        "pred": int(pred),
                        "confidence": float(conf),
                    }
                )
    write_predictions(prediction_rows)
    _clock(start, "wrote predictions.parquet")

    write_site_model(
        context["words"], products, reports["words"]["auto_route"]["threshold"]
    )
    _clock(start, "wrote site model")
    return context


def _load_encoder():
    import torch
    from sentence_transformers import SentenceTransformer

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    encoder = SentenceTransformer(embed_module.MODEL_NAME, device=device)
    encoder.max_seq_length = 256
    return encoder


def _encode_uncached(texts: list[str], encoder) -> np.ndarray:
    return encoder.encode(
        [text[: embed_module.MAX_CHARS] for text in texts],
        batch_size=256,
        normalize_embeddings=True,
        show_progress_bar=False,
        convert_to_numpy=True,
    ).astype(np.float32)


def _median_seconds(action, runs: int = 3) -> float:
    times = []
    for _ in range(runs):
        started = time.perf_counter()
        action()
        times.append(time.perf_counter() - started)
    return sorted(times)[len(times) // 2]


def measure_timings(limit: int | None = None) -> dict:
    """Time scoring the first 1,000 test rows; write only timings.json."""
    start = time.perf_counter()
    context = load_and_fit(_limit() if limit is None else limit)
    texts = context["test_texts"][:1000]
    if not texts:
        raise SystemExit("no test rows to time")

    words = context["words"]

    def score_words() -> None:
        words["classifier"].predict_proba(words["vectorizer"].transform(texts))

    words_seconds = _median_seconds(score_words) * 1000.0 / len(texts)
    _clock(start, "timed words")

    encoder = _load_encoder()
    embeddings = context["embeddings"]

    def score_embeddings() -> None:
        embeddings["classifier"].predict_proba(_encode_uncached(texts, encoder))

    embeddings_seconds = _median_seconds(score_embeddings) * 1000.0 / len(texts)
    _clock(start, "timed embeddings")

    payload = {
        "words_seconds_per_1000": round(words_seconds, 6),
        "embeddings_seconds_per_1000": round(embeddings_seconds, 6),
    }
    write_json(config.ARTEFACTS_DIR / "timings.json", payload)
    _clock(start, "wrote timings.json")
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fit the complaint router models.")
    parser.add_argument(
        "--measure",
        action="store_true",
        help="time scoring 1,000 test rows and write timings.json only",
    )
    args = parser.parse_args(argv)
    if args.measure:
        measure_timings()
    else:
        run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
