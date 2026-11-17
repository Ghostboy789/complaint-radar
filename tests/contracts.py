from __future__ import annotations

import re
from pathlib import Path

import duckdb


def load_contracts(path: Path | str = "CONTRACTS.md") -> dict[str, list[tuple[str, str, bool]]]:
    """Parse the mart tables between "## Marts" and "## Result files"."""
    text = Path(path).read_text(encoding="utf-8")
    start = text.find("## Marts")
    if start < 0:
        raise ValueError("Missing '## Marts' heading")
    end = text.find("## Result files", start)
    block = text[start:] if end < 0 else text[start:end]

    marts: dict[str, list[tuple[str, str, bool]]] = {}
    heading_re = re.compile(r"^### `([^`]+)`\s*$", re.MULTILINE)
    headings = list(heading_re.finditer(block))
    for i, match in enumerate(headings):
        name = match.group(1)
        table_start = block.find("\n| column |", match.end())
        if table_start < 0:
            continue
        table_start += 1
        table_end = block.find("\n\n", table_start)
        if table_end < 0:
            table_end = len(block)
        if i + 1 < len(headings):
            table_end = min(table_end, headings[i + 1].start())
        rows: list[tuple[str, str, bool]] = []
        for line in block[table_start:table_end].splitlines():
            line = line.strip()
            if not line.startswith("|"):
                continue
            if re.match(r"^\|\s*column\s*\|", line, re.IGNORECASE):
                continue
            if re.match(r"^\|\s*-+", line):
                continue
            parts = [part.strip() for part in line.strip("|").split("|")]
            if len(parts) < 3:
                continue
            column = parts[0].strip("` ")
            column_type = parts[1].strip().upper()
            notes = parts[2].strip()
            rows.append((column, column_type, notes.lower().startswith("nullable")))
        if rows:
            marts[name] = rows
    return marts


def check_mart(
    name: str,
    parquet_path: Path | str,
    contracts_path: Path | str = "CONTRACTS.md",
) -> None:
    """Assert that a mart Parquet file matches its contract exactly."""
    contracts = load_contracts(contracts_path)
    if name not in contracts:
        raise AssertionError(f"Mart '{name}' not found in contracts")
    expected = contracts[name]
    parquet = Path(parquet_path)
    if not parquet.exists():
        raise AssertionError(f"{name}: Parquet file not found: {parquet.name}")

    con = duckdb.connect()
    try:
        desc = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{parquet}')").fetchall()
        actual = [(row[0], str(row[1]).upper()) for row in desc]
        if len(actual) != len(expected):
            raise AssertionError(
                f"{name}: expected {len(expected)} columns, got {len(actual)}"
            )
        for (expected_name, expected_type, _), (actual_name, actual_type) in zip(
            expected, actual, strict=True
        ):
            if expected_name != actual_name:
                raise AssertionError(
                    f"{name}: expected column '{expected_name}', got '{actual_name}'"
                )
            if expected_type != actual_type:
                raise AssertionError(
                    f"{name}: column '{expected_name}' expected type "
                    f"{expected_type}, got {actual_type}"
                )
        for column, _type, nullable in expected:
            if nullable:
                continue
            nulls = con.execute(
                f"SELECT count(*) FROM read_parquet('{parquet}') WHERE {column} IS NULL"
            ).fetchone()[0]
            if nulls:
                raise AssertionError(
                    f"{name}: column '{column}' has {nulls} NULLs but is non-nullable"
                )
    finally:
        con.close()
