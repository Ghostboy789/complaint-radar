{{ config(materialized='table') }}

with src as (
    select
        complaint_id,
        date_received,
        product,
        sub_product,
        issue,
        company,
        state,
        submitted_via,
        company_response,
        timely_response,
        narrative
    from read_parquet('{{ env_var("CR_RAW_GLOB", "../data/parquet/complaints_*.parquet") }}')
),

typed as (
    select
        cast(complaint_id as bigint) as complaint_id,
        cast(nullif(trim(date_received), '') as date) as date_received,
        cast(product as varchar) as product,
        cast(sub_product as varchar) as sub_product,
        cast(issue as varchar) as issue,
        cast(company as varchar) as company,
        cast(nullif(trim(state), '') as varchar) as state,
        cast(submitted_via as varchar) as submitted_via,
        cast(company_response as varchar) as company_response,
        cast(timely_response as varchar) as timely_response,
        case when narrative is null or trim(cast(narrative as varchar)) = '' then false else true end as has_narrative,
        case
            when narrative is null or trim(cast(narrative as varchar)) = '' then null
            else md5(lower(regexp_replace(trim(cast(narrative as varchar)), '\s+', ' ', 'g')))
        end as text_hash
    from src
)

select
    complaint_id,
    date_received,
    product,
    sub_product,
    issue,
    company,
    state,
    submitted_via,
    company_response,
    timely_response,
    has_narrative,
    text_hash
from typed
