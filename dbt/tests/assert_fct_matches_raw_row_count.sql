with raw as (
    select count(*) as raw_rows
    from read_parquet('{{ env_var("CR_RAW_GLOB", "../data/parquet/complaints_*.parquet") }}')
),

fct as (
    select count(*) as fct_rows
    from {{ ref('fct_complaints') }}
)

select raw.raw_rows, fct.fct_rows
from raw, fct
where raw.raw_rows <> fct.fct_rows
