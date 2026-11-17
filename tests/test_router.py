"""End-to-end check of the router on a small synthetic corpus."""
from __future__ import annotations

import csv
import hashlib
import json
import os
import random
import shutil
import subprocess
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pytest

import analysis.router as router

PRODUCTS = ["Alpha", "Bravo", "Charlie", "Delta"]
PRODUCT_TOKENS = ["alphatoken", "bravotoken", "charlitoken", "deltatoken"]
NOISE = [
    "account",
    "bank",
    "card",
    "charge",
    "company",
    "credit",
    "error",
    "help",
    "issue",
    "loan",
    "money",
    "online",
    "payment",
    "phone",
    "please",
    "problem",
    "quickly",
    "report",
    "service",
    "today",
]
ISSUE_TOKENS = {
    "Payment problem": "payissue",
    "Account problem": "acctissue",
    "Rare problem": "rareissue",
    "Unseen problem": "unseenissue",
}
SPLIT_DATES = {
    "train": (date(2023, 9, 1), 480),
    "validation": (date(2025, 1, 1), 360),
    "test": (date(2026, 1, 1), 180),
}
TRAIN_PER_PRODUCT = 300
VALIDATION_PER_PRODUCT = 100
TEST_PER_PRODUCT = [130, 120, 110, 40]


def _issue_for(split: str, product_index: int, row_index: int, seen_index: int) -> str:
    if split == "train" and product_index == 0 and seen_index < 12:
        return "Rare problem"
    if split == "test" and product_index == 1 and seen_index < 6:
        return "Unseen problem"
    if split == "test" and product_index == 0 and seen_index < 3:
        return "Rare problem"
    return "Payment problem" if row_index % 5 < 3 else "Account problem"


def _make_rows() -> list[tuple]:
    rng = random.Random(0)
    rows = []
    complaint_id = 1
    for split, counts in (
        ("train", [TRAIN_PER_PRODUCT] * len(PRODUCTS)),
        ("validation", [VALIDATION_PER_PRODUCT] * len(PRODUCTS)),
        ("test", TEST_PER_PRODUCT),
    ):
        start, span = SPLIT_DATES[split]
        block = []
        for product_index, product in enumerate(PRODUCTS):
            for row_index in range(counts[product_index]):
                issue = _issue_for(split, product_index, row_index, row_index)
                noise = " ".join(rng.choices(NOISE, k=10))
                text = f"{PRODUCT_TOKENS[product_index]} {ISSUE_TOKENS[issue]} {noise}"
                block.append(
                    {
                        "complaint_id": 0,
                        "split": split,
                        "date_received": start + timedelta(days=row_index % span),
                        "product": product,
                        "issue": issue,
                        "text_hash": hashlib.md5(text.encode()).hexdigest(),
                        "is_new_text": split == "test" and row_index % 2 == 0,
                        "narrative": text,
                    }
                )
        rng.shuffle(block)
        for row in block:
            row["complaint_id"] = complaint_id
            complaint_id += 1
            rows.append(
                (
                    row["complaint_id"],
                    row["split"],
                    row["date_received"],
                    row["product"],
                    row["issue"],
                    row["text_hash"],
                    row["is_new_text"],
                    row["narrative"],
                )
            )
    return rows


def _write_mart(path: Path, rows: list[tuple]) -> None:
    con = duckdb.connect()
    try:
        con.execute(
            """
            CREATE TABLE samples (
                complaint_id BIGINT,
                split VARCHAR,
                date_received DATE,
                product VARCHAR,
                issue VARCHAR,
                text_hash VARCHAR,
                is_new_text BOOLEAN,
                narrative VARCHAR
            )
            """
        )
        con.executemany("INSERT INTO samples VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
        target = str(path).replace("'", "''")
        con.execute(f"COPY samples TO '{target}' (FORMAT parquet)")
    finally:
        con.close()


def _fake_embed(texts, cache_name, ids):
    """Deterministic stand-in for sentence embeddings, with the product words as signal."""
    out = np.zeros((len(texts), 8), dtype=np.float32)
    for i, text in enumerate(texts):
        for j, token in enumerate(PRODUCT_TOKENS):
            out[i, j] = 1.0 if token in text else 0.0
        out[i, 4] = min(len(text), 1000) / 1000
        out[i, 5] = 1.0
        out[i, 6] = float(text.count("pay"))
        out[i, 7] = float(text.count("account"))
    return out


@pytest.fixture()
def corpus(tmp_path, monkeypatch):
    marts = tmp_path / "marts_out"
    models = tmp_path / "models_out"
    artefacts = tmp_path / "artefacts"
    site_model = tmp_path / "site" / "data" / "model.json"
    marts.mkdir()
    models.mkdir(parents=True)
    artefacts.mkdir()

    products_csv = tmp_path / "product_groups.csv"
    with products_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["product_group", "label", "current_product", "letter", "in_radar"])
        for index, product in enumerate(PRODUCTS):
            writer.writerow([f"group_{index}", product, product, chr(65 + index), "true"])

    rows = _make_rows()
    _write_mart(marts / "mart_router_samples.parquet", rows)

    monkeypatch.setattr(router.config, "MARTS_DIR", marts)
    monkeypatch.setattr(router.config, "MODELS_DIR", models)
    monkeypatch.setattr(router.config, "ARTEFACTS_DIR", artefacts)
    monkeypatch.setattr(router, "PRODUCT_GROUPS_PATH", products_csv)
    monkeypatch.setattr(router, "SITE_MODEL_PATH", site_model)
    monkeypatch.setattr(router, "embed", _fake_embed)
    monkeypatch.delenv("CR_ROUTER_LIMIT", raising=False)

    return {
        "root": tmp_path,
        "artefacts": artefacts,
        "models": models,
        "site_model": site_model,
        "test_texts": [row[7] for row in rows if row[1] == "test"],
    }


def _assert_num(value: dict) -> None:
    assert set(value) == {"value", "ci_low", "ci_high", "n"}


def _assert_metrics(metrics: dict, n_products: int) -> None:
    assert set(metrics) == {
        "macro_f1",
        "accuracy",
        "ece",
        "per_product",
        "reliability",
        "confusion",
    }
    _assert_num(metrics["macro_f1"])
    _assert_num(metrics["accuracy"])
    assert isinstance(metrics["ece"], float)
    assert len(metrics["per_product"]) == n_products
    for entry in metrics["per_product"]:
        assert set(entry) == {"product", "precision", "recall", "f1", "n"}
    for entry in metrics["reliability"]:
        assert set(entry) == {"bin_low", "bin_high", "n", "mean_confidence", "accuracy"}
    assert len(metrics["confusion"]) == n_products
    assert all(len(row) == n_products for row in metrics["confusion"])


def test_router_contract_determinism_and_browser_parity(corpus):
    context = router.run()
    router_path = corpus["artefacts"] / "router.json"
    data = json.loads(router_path.read_text(encoding="utf-8"))

    assert list(data) == [
        "products",
        "split",
        "class_counts",
        "models",
        "h2",
        "issue_within_product",
    ]
    assert data["products"] == PRODUCTS
    assert set(data["split"]) == {"train", "validation", "test"}
    for name, dates in router.SPLIT_DATES.items():
        assert data["split"][name]["from"] == dates[0]
        assert data["split"][name]["to"] == dates[1]
        assert isinstance(data["split"][name]["rows"], int)
    assert "new_text_rows" in data["split"]["test"]

    assert [entry["product"] for entry in data["class_counts"]] == PRODUCTS
    for entry in data["class_counts"]:
        assert set(entry) == {
            "product",
            "train",
            "validation",
            "test",
            "test_new_text",
            "in_macro_f1",
        }
        assert isinstance(entry["in_macro_f1"], bool)
    assert sum(entry["test"] for entry in data["class_counts"]) == data["split"]["test"]["rows"]
    assert sum(entry["train"] for entry in data["class_counts"]) == data["split"]["train"]["rows"]
    assert sum(entry["validation"] for entry in data["class_counts"]) == (
        data["split"]["validation"]["rows"]
    )

    low_product = next(entry for entry in data["class_counts"] if entry["test"] < 100)
    assert low_product["product"] == "Delta"
    assert low_product["in_macro_f1"] is False
    assert any(entry["in_macro_f1"] for entry in data["class_counts"])

    assert list(data["models"]) == ["majority", "words", "embeddings"]
    for name, model in data["models"].items():
        assert set(model) == {
            "c",
            "validation_macro_f1",
            "test",
            "test_new_text",
            "auto_route",
        }
        if name == "majority":
            assert model["c"] is None
        else:
            assert model["c"] in router.C_GRID
        assert isinstance(model["validation_macro_f1"], float)
        _assert_metrics(model["test"], len(PRODUCTS))
        _assert_metrics(model["test_new_text"], len(PRODUCTS))
        route = model["auto_route"]
        assert set(route) == {
            "threshold",
            "validation_precision",
            "test",
            "test_new_text",
            "by_product",
        }
        assert route["threshold"] is None or isinstance(route["threshold"], float)
        assert route["validation_precision"] is None or isinstance(
            route["validation_precision"], float
        )
        for part in ("test", "test_new_text"):
            assert set(route[part]) == {"coverage", "precision"}
            _assert_num(route[part]["coverage"])
            _assert_num(route[part]["precision"])
        assert [entry["product"] for entry in route["by_product"]] == PRODUCTS
        for entry in route["by_product"]:
            assert set(entry) == {"product", "coverage", "precision"}
            _assert_num(entry["coverage"])
            _assert_num(entry["precision"])

    new_rows = data["split"]["test"]["new_text_rows"]
    words_metrics = data["models"]["words"]["test_new_text"]
    assert sum(sum(row) for row in words_metrics["confusion"]) == new_rows

    assert data["h2"]["model"] == "words"
    assert set(data["h2"]) == {"model", "coverage", "precision", "pass"}
    assert isinstance(data["h2"]["pass"], bool)

    assert data["issue_within_product"]
    for entry in data["issue_within_product"]:
        assert set(entry) == {
            "product",
            "issues",
            "train_rows",
            "test_rows",
            "majority_accuracy",
            "words_accuracy",
            "words_macro_f1",
        }
        _assert_num(entry["majority_accuracy"])
        _assert_num(entry["words_accuracy"])
        _assert_num(entry["words_macro_f1"])

    majority_accuracy = data["models"]["majority"]["test"]["accuracy"]["value"]
    words_accuracy = data["models"]["words"]["test"]["accuracy"]["value"]
    assert words_accuracy > 0.9
    assert majority_accuracy < words_accuracy

    assert corpus["models"].joinpath("predictions.parquet").exists()
    assert corpus["site_model"].exists()
    assert not (corpus["artefacts"] / "timings.json").exists()

    first_bytes = router_path.read_bytes()
    router.run()
    assert router_path.read_bytes() == first_bytes
    assert not (corpus["artefacts"] / "timings.json").exists()

    if shutil.which("node") is None:
        pytest.skip("node is not installed")

    model = json.loads(corpus["site_model"].read_text(encoding="utf-8"))
    texts = corpus["test_texts"][:18] + ["", "zzzz qqqq"]
    vectorizer = context["words"]["vectorizer"]
    classifier = context["words"]["classifier"]
    proba = router._expand_proba(classifier, vectorizer.transform(texts), len(PRODUCTS))
    sklearn_products = [PRODUCTS[index] for index in proba.argmax(axis=1)]
    sklearn_top = proba.max(axis=1)

    script = """
const { classify } = require(process.env.CLASSIFY_JS);
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  const output = payload.texts.map((text) => {
    const result = classify(text, payload.model);
    return { product: result.product, confidence: result.confidence };
  });
  process.stdout.write(JSON.stringify(output));
});
"""
    env = dict(os.environ, CLASSIFY_JS=str(Path(__file__).resolve().parents[1] / "site" / "js"
                                             / "classify.js"))
    completed = subprocess.run(
        ["node", "-e", script],
        input=json.dumps({"model": model, "texts": texts}),
        text=True,
        capture_output=True,
        check=True,
        env=env,
    )
    browser = json.loads(completed.stdout)
    assert len(browser) == len(texts)
    for index, result in enumerate(browser):
        assert result["product"] == sklearn_products[index]
        assert abs(result["confidence"] - sklearn_top[index]) < 0.01
