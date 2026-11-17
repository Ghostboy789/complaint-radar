{{ config(materialized='view') }}

select
    cast(complaint_id as bigint) as complaint_id,
    cast(narrative as varchar) as narrative
from read_parquet('{{ env_var("CR_RAW_GLOB", "../data/parquet/complaints_*.parquet") }}')
where narrative is not null and trim(cast(narrative as varchar)) <> ''
