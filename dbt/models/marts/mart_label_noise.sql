-- depends_on: {{ ref('ensure_marts_dir') }}

with test_period as (
    select complaint_id, product, text_hash
    from {{ ref('int_complaints') }}
    where has_narrative = true
      and date_received >= cast('2026-01-01' as date)
      and date_received <= cast('2026-06-30' as date)
),

hash_freq as (
    select text_hash
    from test_period
    group by text_hash
    having count(*) >= 2
),

filtered as (
    select tp.complaint_id, tp.product, tp.text_hash
    from test_period tp
    inner join hash_freq hf on tp.text_hash = hf.text_hash
),

per_hash_product as (
    select text_hash, product, count(*) as product_count
    from filtered
    group by text_hash, product
),

per_hash_modal as (
    select text_hash, max(product_count) as modal_count
    from per_hash_product
    group by text_hash
)

select
    cast((select count(*) from filtered) as bigint) as complaints,
    cast((select count(*) from hash_freq) as bigint) as distinct_texts,
    cast(coalesce((select sum(modal_count) from per_hash_modal), 0) as bigint) as in_modal_product
