import csv
import json
import math

import duckdb
import pytest

import config
from analysis import llm_eval, llm_run


def test_prompt_messages():
    products = llm_run.load_products()
    examples = [
        {"complaint_id": 10, "product": products[0][1], "narrative": "x" * 600},
        {"complaint_id": 2, "product": products[1][1], "narrative": "y" * 600},
        {"complaint_id": 7, "product": products[2][1], "narrative": "z" * 600},
    ]
    ordered = llm_run.order_fewshot(examples)

    messages = llm_run.build_messages(products, "q" * 3000, ordered)
    assert len(messages) == 2 + 2 * len(examples)

    system = messages[0]
    assert system["role"] == "system"
    lines = system["content"].splitlines()
    assert lines[0] == (
        "You route consumer complaints to the right desk. Read the complaint and choose "
        "the one product it is about:"
    )
    assert lines[1:12] == [f"{letter}. {product}" for letter, product in products]
    assert lines[-1] == "Answer with the letter only."

    letter_by_product = {product: letter for letter, product in products}
    for index, example in enumerate(ordered):
        user = messages[1 + 2 * index]
        assistant = messages[2 + 2 * index]
        assert user["role"] == "user"
        assert user["content"] == (
            "Complaint:\n" + example["narrative"][:500] + "\n\nLetter:"
        )
        assert assistant == {
            "role": "assistant",
            "content": letter_by_product[example["product"]],
        }

    assert messages[-1] == {
        "role": "user",
        "content": "Complaint:\n" + "q" * 2000 + "\n\nLetter:",
    }

    zero_shot = llm_run.build_messages(products, "short", [])
    assert len(zero_shot) == 2
    assert zero_shot[-1]["content"] == "Complaint:\nshort\n\nLetter:"


def test_parse_logprobs_letters_and_no_letters():
    logprobs = [
        {
            "top_logprobs": [
                {"token": " A", "logprob": math.log(0.6)},
                {"token": "B", "logprob": math.log(0.2)},
                {"token": "The", "logprob": math.log(0.2)},
            ]
        }
    ]
    probabilities, mass = llm_run.parse_logprobs(logprobs)
    assert mass == pytest.approx(0.8)
    assert probabilities["A"] == pytest.approx(0.75)
    assert probabilities["B"] == pytest.approx(0.25)
    assert sum(probabilities.values()) == pytest.approx(1.0)

    no_letters = [{"top_logprobs": [{"token": "The", "logprob": 0.0}]}]
    probabilities, mass = llm_run.parse_logprobs(no_letters)
    assert mass == 0
    assert len(probabilities) == 11
    assert all(value == pytest.approx(1 / 11) for value in probabilities.values())


def _write_parquet(path, ddl, rows):
    con = duckdb.connect()
    try:
        con.execute(ddl)
        if rows:
            placeholders = ", ".join("?" for _ in rows[0])
            con.executemany(f"INSERT INTO t VALUES ({placeholders})", rows)
        con.execute(f"COPY t TO '{path.as_posix()}' (FORMAT PARQUET)")
    finally:
        con.close()


def _write_predictions_csv(path, test_rows, validation_rows):
    def one_hot(index):
        return [1.0 if position == index else 0.0 for position in range(11)]

    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(llm_run.CSV_COLUMNS)
        for variant in ("zero_shot", "few_shot"):
            for role, rows in (
                ("validation", validation_rows),
                ("test", test_rows),
            ):
                for complaint_id, product_index in rows:
                    index = product_index if variant == "zero_shot" else 0
                    writer.writerow(
                        [complaint_id, role, variant]
                        + [f"{value:.6f}" for value in one_hot(index)]
                        + ["1.000000", "0.500", "100", "1"]
                    )


def _synthetic_inputs(root):
    products = llm_run.load_products()
    marts = root / "marts"
    models = root / "models"
    artefacts = root / "artefacts"
    marts.mkdir()
    models.mkdir()
    artefacts.mkdir()

    sample_rows = []
    test_rows = []
    validation_rows = []
    for product_index in range(4):
        product = products[product_index][1]
        for number in range(20):
            complaint_id = 1000 + product_index * 100 + number
            sample_rows.append(
                (complaint_id, "test", product, f"hash{complaint_id}", "narrative")
            )
            test_rows.append((complaint_id, product_index))
        for number in range(5):
            complaint_id = 5000 + product_index * 100 + number
            sample_rows.append(
                (complaint_id, "validation", product, f"hash{complaint_id}", "narrative")
            )
            validation_rows.append((complaint_id, product_index))

    _write_parquet(
        marts / "mart_llm_samples.parquet",
        "CREATE TABLE t (complaint_id BIGINT, role VARCHAR, product VARCHAR, "
        "text_hash VARCHAR, narrative VARCHAR)",
        sample_rows,
    )
    _write_predictions_csv(
        artefacts / "llm_predictions.csv", test_rows, validation_rows
    )

    prediction_rows = []
    for complaint_id, product_index in test_rows:
        prediction_rows.append((complaint_id, "test", "majority", 0, 0.6))
        words_correct = (complaint_id - 1000) % 100 < 10
        words_pred = product_index if words_correct else (product_index + 1) % 4
        prediction_rows.append(
            (complaint_id, "test", "words", words_pred, 0.9 if words_correct else 0.1)
        )
        embeddings_correct = (complaint_id - 1000) % 100 < 5
        embeddings_pred = product_index if embeddings_correct else (product_index + 1) % 4
        prediction_rows.append(
            (
                complaint_id,
                "test",
                "embeddings",
                embeddings_pred,
                0.5,
            )
        )
    _write_parquet(
        models / "predictions.parquet",
        "CREATE TABLE t (complaint_id BIGINT, split VARCHAR, model VARCHAR, "
        "pred INTEGER, confidence DOUBLE)",
        prediction_rows,
    )

    router = {
        "products": [product for _letter, product in products],
        "models": {
            "majority": {"auto_route": {"threshold": 0.5}},
            "words": {"auto_route": {"threshold": 0.55}},
            "embeddings": {"auto_route": {"threshold": 0.4}},
        },
    }
    (artefacts / "router.json").write_text(json.dumps(router), encoding="utf-8")
    return marts, models, artefacts


def test_eval_contract_and_byte_identical(monkeypatch, tmp_path):
    marts, models, artefacts = _synthetic_inputs(tmp_path)
    monkeypatch.setattr(config, "MARTS_DIR", marts)
    monkeypatch.setattr(config, "MODELS_DIR", models)
    monkeypatch.setattr(config, "ARTEFACTS_DIR", artefacts)

    llm_eval.main()
    first = (artefacts / "llm_eval.json").read_bytes()
    result = json.loads(first)

    assert set(result) == {
        "model",
        "sample",
        "variants",
        "chosen_variant",
        "same_sample",
        "h1",
    }
    assert set(result["sample"]) == {"test", "validation", "per_product"}
    assert set(result["variants"]) == {"zero_shot", "few_shot"}
    assert set(result["variants"]["zero_shot"]) == {
        "validation_macro_f1",
        "test",
        "auto_route",
        "seconds_per_1000",
        "prompt_tokens_per_1000",
        "output_tokens_per_1000",
        "mean_letter_mass",
    }
    assert set(result["variants"]["zero_shot"]["test"]) == {
        "macro_f1",
        "accuracy",
        "ece",
        "per_product",
        "reliability",
        "confusion",
    }
    assert set(result["same_sample"]) == {"majority", "words", "embeddings"}
    assert set(result["h1"]) == {"difference", "verdict", "pass"}

    assert result["chosen_variant"] == "zero_shot"
    assert result["variants"]["zero_shot"]["test"]["macro_f1"]["value"] == 1.0
    assert result["variants"]["zero_shot"]["test"]["accuracy"]["value"] == 1.0
    assert result["h1"]["verdict"] == "llm_better"
    assert result["h1"]["pass"] is True

    llm_eval.main()
    assert (artefacts / "llm_eval.json").read_bytes() == first
