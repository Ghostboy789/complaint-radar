"""Evaluate the language-model predictions against the small models.

Reads the committed predictions CSV, the fixed samples and the router outputs, and writes
`artefacts/llm_eval.json` in the shape given by CONTRACTS.md.
"""
from __future__ import annotations

import csv
import json

import duckdb
import numpy as np

import config
from analysis import stats_util as su
from analysis.llm_run import LETTERS, MODEL, VARIANTS, load_products

MODELS = ("majority", "words", "embeddings")


def load_sample_products() -> dict[int, dict]:
    """True product and role for every complaint in the fixed samples."""
    path = config.MARTS_DIR / "mart_llm_samples.parquet"
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"SELECT complaint_id, role, product "
            f"FROM read_parquet('{path}') ORDER BY complaint_id"
        ).fetchall()
    finally:
        con.close()
    return {
        int(row[0]): {"role": row[1], "product": row[2]}
        for row in rows
    }


def read_predictions_csv(path) -> list[dict]:
    rows = []
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            rows.append(
                {
                    "complaint_id": int(row["complaint_id"]),
                    "role": row["role"],
                    "variant": row["variant"],
                    "probs": [float(row[f"p_{letter.lower()}"]) for letter in LETTERS],
                    "letter_mass": float(row["letter_mass"]),
                    "seconds": float(row["seconds"]),
                    "prompt_tokens": int(row["prompt_tokens"]),
                    "output_tokens": int(row["output_tokens"]),
                }
            )
    return rows


def choose_prediction(probabilities: list[float]) -> tuple[int, float]:
    """Highest probability, with ties going to the earlier letter."""
    index = max(range(len(probabilities)), key=lambda i: probabilities[i])
    return index, float(probabilities[index])


def load_model_predictions() -> dict[str, dict[int, tuple[int, float]]]:
    """Test rows of `predictions.parquet` keyed by model and complaint id."""
    path = config.MODELS_DIR / "predictions.parquet"
    if not path.exists():
        raise FileNotFoundError(f"missing {path}; run the router before the LLM evaluation")
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"SELECT complaint_id, model, pred, confidence "
            f"FROM read_parquet('{path}') WHERE split = 'test' ORDER BY complaint_id"
        ).fetchall()
    finally:
        con.close()
    predictions: dict[str, dict[int, tuple[int, float]]] = {model: {} for model in MODELS}
    for complaint_id, model, pred, confidence in rows:
        if model in predictions:
            predictions[model][int(complaint_id)] = (int(pred), float(confidence))
    return predictions


def metrics_block(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    confidence: np.ndarray,
    products: list[tuple[str, str]],
) -> dict:
    bootstrap = su.bootstrap_metrics(
        y_true, y_pred, 11, n_boot=1000, seed=0, strata=y_true
    )
    confusion = su.confusion(y_true, y_pred, 11)
    precision, recall, f1 = su.per_class(confusion)
    per_product = []
    for index, (_letter, product) in enumerate(products):
        per_product.append(
            {
                "product": product,
                "precision": round(float(precision[index]), 6),
                "recall": round(float(recall[index]), 6),
                "f1": round(float(f1[index]), 6),
                "n": int(confusion[index].sum()),
            }
        )
    reliability, ece = su.reliability(confidence, y_pred == y_true)
    return {
        "macro_f1": bootstrap["macro_f1"],
        "accuracy": bootstrap["accuracy"],
        "ece": ece,
        "per_product": per_product,
        "reliability": reliability,
        "confusion": confusion.tolist(),
    }


def split_rows(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    validation = sorted(
        (row for row in rows if row["role"] == "validation"),
        key=lambda row: row["complaint_id"],
    )
    test = sorted(
        (row for row in rows if row["role"] == "test"),
        key=lambda row: row["complaint_id"],
    )
    return validation, test


def variant_block(rows: list[dict], products: list[tuple[str, str]]) -> dict:
    validation, test = split_rows(rows)
    if not validation:
        raise RuntimeError("no validation predictions for a variant")
    if not test:
        raise RuntimeError("no test predictions for a variant")

    y_val = np.array([row["y"] for row in validation])
    p_val = np.array([row["pred"] for row in validation])
    c_val = np.array([row["confidence"] for row in validation])
    validation_macro_f1 = round(float(su.macro_f1(su.confusion(y_val, p_val, 11))), 6)

    threshold = su.route_threshold(c_val, p_val == y_val)
    validation_route = su.route_result(c_val, p_val == y_val, threshold)
    validation_precision = validation_route["precision"]["value"]
    if validation_precision is not None:
        validation_precision = round(float(validation_precision), 6)

    y_test = np.array([row["y"] for row in test])
    p_test = np.array([row["pred"] for row in test])
    c_test = np.array([row["confidence"] for row in test])

    return {
        "validation_macro_f1": validation_macro_f1,
        "test": metrics_block(y_test, p_test, c_test, products),
        "auto_route": {
            "threshold": None if threshold is None else round(float(threshold), 6),
            "validation_precision": validation_precision,
            "test": su.route_result(c_test, p_test == y_test, threshold),
        },
        "seconds_per_1000": round(
            float(np.mean([row["seconds"] for row in rows])) * 1000, 6
        ),
        "prompt_tokens_per_1000": round(
            float(np.mean([row["prompt_tokens"] for row in rows])) * 1000, 6
        ),
        "output_tokens_per_1000": round(
            float(np.mean([row["output_tokens"] for row in rows])) * 1000, 6
        ),
        "mean_letter_mass": round(
            float(np.mean([row["letter_mass"] for row in rows])), 6
        ),
    }


def sample_block(rows: list[dict], products: list[tuple[str, str]]) -> dict:
    counts = {product: {"test": 0, "validation": 0} for _letter, product in products}
    for row in rows:
        if row["role"] in counts[row["product"]]:
            counts[row["product"]][row["role"]] += 1
    return {
        "test": sum(count["test"] for count in counts.values()),
        "validation": sum(count["validation"] for count in counts.values()),
        "per_product": [
            {
                "product": product,
                "test": counts[product]["test"],
                "validation": counts[product]["validation"],
            }
            for _letter, product in products
        ],
    }


def same_sample_block(
    test_rows: list[dict],
    sample_products: dict[int, dict],
    product_index: dict[str, int],
    model_predictions: dict[str, dict[int, tuple[int, float]]],
    router: dict,
) -> dict:
    complaint_ids = sorted(row["complaint_id"] for row in test_rows)
    y_true = np.array([product_index[sample_products[cid]["product"]] for cid in complaint_ids])
    output = {}
    for model in MODELS:
        predictions = []
        confidence = []
        for complaint_id in complaint_ids:
            if complaint_id not in model_predictions[model]:
                raise RuntimeError(
                    f"predictions.parquet has no test row for model {model} "
                    f"and complaint {complaint_id}"
                )
            pred, conf = model_predictions[model][complaint_id]
            predictions.append(pred)
            confidence.append(conf)
        y_pred = np.array(predictions)
        confidence_array = np.array(confidence)
        bootstrap = su.bootstrap_metrics(
            y_true, y_pred, 11, n_boot=1000, seed=0, strata=y_true
        )
        _table, ece = su.reliability(confidence_array, y_pred == y_true)
        threshold = router["models"][model]["auto_route"]["threshold"]
        output[model] = {
            "macro_f1": bootstrap["macro_f1"],
            "accuracy": bootstrap["accuracy"],
            "ece": ece,
            "auto_route": su.route_result(confidence_array, y_pred == y_true, threshold),
        }
    return output


def h1_block(
    test_rows: list[dict],
    sample_products: dict[int, dict],
    product_index: dict[str, int],
    model_predictions: dict[str, dict[int, tuple[int, float]]],
) -> dict:
    chosen = {row["complaint_id"]: row["pred"] for row in test_rows}
    words = model_predictions["words"]
    shared = sorted(complaint_id for complaint_id in chosen if complaint_id in words)
    if not shared:
        raise RuntimeError("no complaint has both an LLM and a words prediction")
    y_true = np.array([product_index[sample_products[cid]["product"]] for cid in shared])
    llm_pred = np.array([chosen[complaint_id] for complaint_id in shared])
    words_pred = np.array([words[complaint_id][0] for complaint_id in shared])
    difference = su.paired_macro_f1_difference(
        y_true, llm_pred, words_pred, 11, strata=y_true, n_boot=2000, seed=0
    )
    if difference["ci_low"] is not None and difference["ci_low"] > 0:
        verdict = "llm_better"
    elif difference["ci_high"] is not None and difference["ci_high"] < 0:
        verdict = "small_model_better"
    else:
        verdict = "no_detectable_difference"
    return {
        "difference": difference,
        "verdict": verdict,
        "pass": verdict == "llm_better",
    }


def evaluate() -> dict:
    products = load_products()
    product_index = {product: index for index, (_letter, product) in enumerate(products)}
    sample_products = load_sample_products()

    csv_path = config.ARTEFACTS_DIR / "llm_predictions.csv"
    if not csv_path.exists():
        raise FileNotFoundError(f"missing {csv_path}; run analysis.llm_run first")
    rows = read_predictions_csv(csv_path)
    for row in rows:
        sample = sample_products.get(row["complaint_id"])
        if sample is None:
            raise RuntimeError(
                f"complaint {row['complaint_id']} is in the predictions CSV "
                "but not in mart_llm_samples"
            )
        product = sample["product"]
        if product not in product_index:
            raise RuntimeError(f"unknown product {product!r} for complaint {row['complaint_id']}")
        row["product"] = product
        row["y"] = product_index[product]
        row["pred"], row["confidence"] = choose_prediction(row["probs"])

    variants = {}
    for variant in VARIANTS:
        variant_rows = [row for row in rows if row["variant"] == variant]
        if variant_rows:
            variants[variant] = variant_block(variant_rows, products)
    if not variants:
        raise RuntimeError("the predictions CSV holds no variant rows")

    if "zero_shot" in variants and "few_shot" in variants:
        chosen_variant = (
            "few_shot"
            if variants["few_shot"]["validation_macro_f1"]
            > variants["zero_shot"]["validation_macro_f1"]
            else "zero_shot"
        )
    else:
        chosen_variant = next(iter(variants))

    chosen_rows = [row for row in rows if row["variant"] == chosen_variant]
    chosen_test = [row for row in chosen_rows if row["role"] == "test"]

    router = json.loads((config.ARTEFACTS_DIR / "router.json").read_text(encoding="utf-8"))
    model_predictions = load_model_predictions()

    return {
        "model": MODEL,
        "sample": sample_block(chosen_rows, products),
        "variants": variants,
        "chosen_variant": chosen_variant,
        "same_sample": same_sample_block(
            chosen_test, sample_products, product_index, model_predictions, router
        ),
        "h1": h1_block(chosen_test, sample_products, product_index, model_predictions),
    }


def main() -> None:
    result = evaluate()
    config.ARTEFACTS_DIR.mkdir(parents=True, exist_ok=True)
    text = json.dumps(result, indent=1) + "\n"
    (config.ARTEFACTS_DIR / "llm_eval.json").write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
