"""Create the Parquet output folder before the marts write to it."""

import os


def model(dbt, session):
    dbt.config(materialized="table")
    marts_dir = os.environ.get("CR_MARTS_DIR", "../marts_out")
    os.makedirs(marts_dir, exist_ok=True)
    return session.sql("select 1 as ready")
