"""Run the local language model over the fixed complaint samples.

Calls are appended to a JSON-lines file so an interrupted run can be resumed, then
exported to the predictions CSV used by the evaluation.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import time
import urllib.request

import duckdb

import config

MODEL = "llama3.1:8b"
LETTERS = tuple("ABCDEFGHIJK")
DEFAULT_URL = "http://127.0.0.1:11434"
ROLES = ("validation", "test")
VARIANTS = ("zero_shot", "few_shot")
CSV_COLUMNS = (
    ["complaint_id", "role", "variant"]
    + [f"p_{letter.lower()}" for letter in LETTERS]
    + ["letter_mass", "seconds", "prompt_tokens", "output_tokens"]
)


def load_products() -> list[tuple[str, str]]:
    """The eleven products as (letter, current_product), in letter order."""
    path = config.REPO_ROOT / "dbt" / "seeds" / "product_groups.csv"
    with open(path, newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    rows.sort(key=lambda row: row["letter"])
    return [(row["letter"], row["current_product"]) for row in rows]


def load_samples() -> list[dict]:
    """Every sample row, ordered by complaint id as the contract requires."""
    path = config.MARTS_DIR / "mart_llm_samples.parquet"
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"SELECT complaint_id, role, product, text_hash, narrative "
            f"FROM read_parquet('{path}') ORDER BY complaint_id"
        ).fetchall()
    finally:
        con.close()
    return [
        {
            "complaint_id": int(row[0]),
            "role": row[1],
            "product": row[2],
            "text_hash": row[3],
            "narrative": row[4],
        }
        for row in rows
    ]


def order_fewshot(rows: list[dict]) -> list[dict]:
    """Few-shot examples ordered by md5 of the complaint id as text."""
    return sorted(
        rows,
        key=lambda row: hashlib.md5(str(int(row["complaint_id"])).encode()).hexdigest(),
    )


def system_prompt(products: list[tuple[str, str]]) -> str:
    listing = "\n".join(f"{letter}. {product}" for letter, product in products)
    return (
        "You route consumer complaints to the right desk. Read the complaint and choose "
        "the one product it is about:\n"
        + listing
        + "\nAnswer with the letter only."
    )


def complaint_message(narrative: str, limit: int) -> str:
    return "Complaint:\n" + narrative[:limit] + "\n\nLetter:"


def build_messages(
    products: list[tuple[str, str]], narrative: str, examples: list[dict]
) -> list[dict]:
    """The exact chat messages for one complaint, zero-shot when examples is empty."""
    messages = [{"role": "system", "content": system_prompt(products)}]
    letter_by_product = {product: letter for letter, product in products}
    for example in examples:
        messages.append(
            {"role": "user", "content": complaint_message(example["narrative"], 500)}
        )
        messages.append(
            {"role": "assistant", "content": letter_by_product[example["product"]]}
        )
    messages.append({"role": "user", "content": complaint_message(narrative, 2000)})
    return messages


def parse_logprobs(logprobs, letters: tuple[str, ...] = LETTERS) -> tuple[dict, float]:
    """Probabilities over the letters from the first output token's top logprobs.

    A token counts for a letter only when its stripped text is exactly that letter.
    """
    sums = {letter: 0.0 for letter in letters}
    if logprobs:
        for entry in logprobs[0].get("top_logprobs") or []:
            token = str(entry.get("token", "")).strip()
            if token in sums:
                sums[token] += math.exp(float(entry["logprob"]))
    letter_mass = sum(sums.values())
    if letter_mass == 0:
        probabilities = {letter: 1.0 / len(letters) for letter in letters}
    else:
        probabilities = {
            letter: sums[letter] / letter_mass for letter in letters
        }
    return probabilities, letter_mass


def request_prediction(messages: list[dict], url: str) -> tuple[dict, float]:
    """POST one chat request and return the response JSON and its wall-clock seconds."""
    payload = {
        "model": MODEL,
        "stream": False,
        "logprobs": True,
        "top_logprobs": 20,
        "options": {"temperature": 0, "seed": 0, "num_ctx": 4096, "num_predict": 1},
        "messages": messages,
    }
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url.rstrip("/") + "/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    start = time.perf_counter()
    with urllib.request.urlopen(request, timeout=180) as response:
        raw = response.read()
    seconds = time.perf_counter() - start
    result = json.loads(raw.decode("utf-8"))
    if "error" in result:
        raise RuntimeError(str(result["error"]))
    return result, seconds


def call_model(
    messages: list[dict], url: str, complaint_id: int, variant: str
) -> tuple[dict, float]:
    """Request with three attempts and a short pause between them."""
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            return request_prediction(messages, url)
        except Exception as error:  # noqa: BLE001 - any transport or JSON failure is retried
            last_error = error
            if attempt < 2:
                time.sleep(1.0)
    raise RuntimeError(
        f"Ollama call failed after 3 attempts for complaint {complaint_id} "
        f"({variant}): {last_error}"
    ) from last_error


def build_record(
    complaint_id: int,
    role: str,
    variant: str,
    result: dict,
    seconds: float,
) -> dict:
    probabilities, letter_mass = parse_logprobs(result.get("logprobs"))
    record = {"complaint_id": int(complaint_id), "role": role, "variant": variant}
    for letter in LETTERS:
        record[f"p_{letter.lower()}"] = probabilities[letter]
    record["letter_mass"] = letter_mass
    record["seconds"] = seconds
    record["prompt_tokens"] = int(result.get("prompt_eval_count") or 0)
    record["output_tokens"] = int(result.get("eval_count") or 0)
    return record


def read_jsonl(path) -> list[dict]:
    if not path.exists():
        return []
    records = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def write_predictions(records: list[dict], path) -> None:
    """Write the contract CSV, one row per (complaint id, variant)."""
    unique = {}
    for record in records:
        unique[(int(record["complaint_id"]), record["variant"])] = record
    rows = sorted(
        unique.values(),
        key=lambda record: (record["variant"], record["role"], int(record["complaint_id"])),
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(CSV_COLUMNS)
        for record in rows:
            writer.writerow(
                [int(record["complaint_id"]), record["role"], record["variant"]]
                + [f"{float(record[f'p_{letter.lower()}']):.6f}" for letter in LETTERS]
                + [
                    f"{float(record['letter_mass']):.6f}",
                    f"{float(record['seconds']):.3f}",
                    int(record["prompt_tokens"]),
                    int(record["output_tokens"]),
                ]
            )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run llama3.1:8b over the LLM samples.")
    parser.add_argument("--limit", type=int, default=None, help="first N per role and variant")
    parser.add_argument("--variant", choices=VARIANTS, default=None)
    parser.add_argument("--export", action="store_true", help="write the predictions CSV")
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit must be positive")

    smoke = args.limit is not None
    if args.export and not smoke:
        records = read_jsonl(config.MODELS_DIR / "llm_calls.jsonl")
        write_predictions(records, config.ARTEFACTS_DIR / "llm_predictions.csv")
        return

    url = os.environ.get("CR_OLLAMA_URL", DEFAULT_URL)
    products = load_products()
    samples = load_samples()
    examples = order_fewshot([row for row in samples if row["role"] == "fewshot"])

    variants = [args.variant] if args.variant else list(VARIANTS)
    tasks = []
    for variant in variants:
        for role in ROLES:
            role_rows = [row for row in samples if row["role"] == role]
            if args.limit is not None:
                role_rows = role_rows[: args.limit]
            tasks.extend((variant, row) for row in role_rows)

    calls_path = config.MODELS_DIR / (
        "llm_calls_smoke.jsonl" if smoke else "llm_calls.jsonl"
    )
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    existing = read_jsonl(calls_path)
    seen = {(int(record["complaint_id"]), record["variant"]) for record in existing}
    todo = [
        (variant, row)
        for variant, row in tasks
        if (int(row["complaint_id"]), variant) not in seen
    ]

    total = len(todo)
    seconds_seen: list[float] = []
    with open(calls_path, "a", encoding="utf-8") as handle:
        for done, (variant, row) in enumerate(todo, start=1):
            active_examples = examples if variant == "few_shot" else []
            messages = build_messages(
                products, row["narrative"] or "", active_examples
            )
            result, seconds = call_model(
                messages, url, int(row["complaint_id"]), variant
            )
            record = build_record(
                int(row["complaint_id"]), row["role"], variant, result, seconds
            )
            handle.write(json.dumps(record, sort_keys=True) + "\n")
            handle.flush()
            seconds_seen.append(seconds)

            if smoke:
                probabilities = [record[f"p_{letter.lower()}"] for letter in LETTERS]
                best = max(range(len(LETTERS)), key=lambda index: probabilities[index])
                print(
                    f"{record['complaint_id']} {variant}: {LETTERS[best]} "
                    f"p={probabilities[best]:.4f} mass={record['letter_mass']:.4f} "
                    f"{seconds:.2f}s"
                )
            if done % 100 == 0:
                mean_seconds = sum(seconds_seen) / len(seconds_seen)
                print(f"{done}/{total} calls, {mean_seconds:.2f}s each")

    if smoke:
        return
    records = read_jsonl(calls_path)
    if records:
        write_predictions(records, config.ARTEFACTS_DIR / "llm_predictions.csv")


if __name__ == "__main__":
    main()
