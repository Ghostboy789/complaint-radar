-- depends_on: {{ ref('ensure_marts_dir') }}

with current_products as (
    select current_product
    from {{ ref('product_groups') }}
),

eligible as (
    select
        complaint_id,
        date_received,
        product,
        issue,
        text_hash
    from {{ ref('int_complaints') }}
    where has_narrative = true
      and date_received >= cast('2023-09-01' as date)
      and date_received <= cast('2026-06-30' as date)
      and product in (select current_product from current_products)
),

-- train: one row per text hash (earliest date, lowest complaint id), then 100,000 per product
train_base as (
    select
        *,
        row_number() over (
            partition by text_hash
            order by date_received asc, complaint_id asc
        ) as rn_hash
    from eligible
    where date_received <= cast('2024-12-31' as date)
),

train_dedup as (
    select complaint_id, date_received, product, issue, text_hash
    from train_base
    where rn_hash = 1
),

train_ranked as (
    select
        *,
        row_number() over (
            partition by product
            order by md5(cast(complaint_id as varchar)) asc
        ) as rn_product
    from train_dedup
),

train_final as (
    select
        complaint_id,
        'train' as split,
        date_received,
        product,
        issue,
        text_hash,
        false as is_new_text
    from train_ranked
    where rn_product <= 100000
),

-- validation: first 100,000 in hash order over all products
validation_ranked as (
    select
        *
    from (
        select
            *,
            row_number() over (
                order by md5(cast(complaint_id as varchar)) asc
            ) as rn_all
        from eligible
        where date_received >= cast('2025-01-01' as date)
          and date_received <= cast('2025-12-31' as date)
    )
    where rn_all <= 100000
),

validation_final as (
    select
        complaint_id,
        'validation' as split,
        date_received,
        product,
        issue,
        text_hash,
        false as is_new_text
    from validation_ranked
),

-- test: every eligible row in 2026 H1
test_base as (
    select complaint_id, date_received, product, issue, text_hash
    from eligible
    where date_received >= cast('2026-01-01' as date)
      and date_received <= cast('2026-06-30' as date)
),

hash_before as (
    select distinct text_hash
    from {{ ref('int_complaints') }}
    where has_narrative = true
      and date_received < cast('2026-01-01' as date)
),

test_final as (
    select
        tb.complaint_id,
        'test' as split,
        tb.date_received,
        tb.product,
        tb.issue,
        tb.text_hash,
        (hb.text_hash is null) as is_new_text
    from test_base tb
    left join hash_before hb on tb.text_hash = hb.text_hash
),

unioned as (
    select * from train_final
    union all
    select * from validation_final
    union all
    select * from test_final
)

select
    cast(u.complaint_id as bigint) as complaint_id,
    cast(u.split as varchar) as split,
    cast(u.date_received as date) as date_received,
    cast(u.product as varchar) as product,
    cast(u.issue as varchar) as issue,
    cast(u.text_hash as varchar) as text_hash,
    cast(u.is_new_text as boolean) as is_new_text,
    cast(n.narrative as varchar) as narrative
from unioned u
left join {{ ref('stg_narratives') }} n on u.complaint_id = n.complaint_id
order by u.split, u.complaint_id
