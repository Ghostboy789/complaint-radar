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
        text_hash
    from {{ ref('int_complaints') }}
    where has_narrative = true
      and date_received >= cast('2023-09-01' as date)
      and date_received <= cast('2026-06-30' as date)
      and product in (select current_product from current_products)
),

-- test role: one per text hash, then the first 300 per product in hash order
test_2026 as (
    select *
    from eligible
    where date_received >= cast('2026-01-01' as date)
      and date_received <= cast('2026-06-30' as date)
),

test_one_per_hash as (
    select
        *,
        row_number() over (
            partition by text_hash
            order by md5(cast(complaint_id as varchar)) asc
        ) as rn_hash
    from test_2026
),

test_ranked as (
    select
        *,
        row_number() over (
            partition by product
            order by md5(cast(complaint_id as varchar)) asc
        ) as rn_product
    from test_one_per_hash
    where rn_hash = 1
),

test_final as (
    select complaint_id, 'test' as role, product, text_hash
    from test_ranked
    where rn_product <= 300
),

-- validation role: the same over all eligible 2025 rows, 150 per product
validation_2025 as (
    select *
    from eligible
    where date_received >= cast('2025-01-01' as date)
      and date_received <= cast('2025-12-31' as date)
),

validation_one_per_hash as (
    select
        *,
        row_number() over (
            partition by text_hash
            order by md5(cast(complaint_id as varchar)) asc
        ) as rn_hash
    from validation_2025
),

validation_ranked as (
    select
        *,
        row_number() over (
            partition by product
            order by md5(cast(complaint_id as varchar)) asc
        ) as rn_product
    from validation_one_per_hash
    where rn_hash = 1
),

validation_final as (
    select complaint_id, 'validation' as role, product, text_hash
    from validation_ranked
    where rn_product <= 150
),

-- fewshot role: one train row per product, narrative length 200 to 800 characters
fewshot_candidates as (
    select
        complaint_id,
        product,
        text_hash,
        length(narrative) as narrative_length
    from {{ ref('mart_router_samples') }}
    where split = 'train'
),

fewshot_ranked as (
    select
        *,
        row_number() over (
            partition by product
            order by md5(cast(complaint_id as varchar)) asc
        ) as rn_product
    from fewshot_candidates
    where narrative_length >= 200
      and narrative_length <= 800
),

fewshot_final as (
    select complaint_id, 'fewshot' as role, product, text_hash
    from fewshot_ranked
    where rn_product = 1
),

unioned as (
    select * from test_final
    union all
    select * from validation_final
    union all
    select * from fewshot_final
)

select
    cast(u.complaint_id as bigint) as complaint_id,
    cast(u.role as varchar) as role,
    cast(u.product as varchar) as product,
    cast(u.text_hash as varchar) as text_hash,
    cast(n.narrative as varchar) as narrative
from unioned u
left join {{ ref('stg_narratives') }} n on u.complaint_id = n.complaint_id
order by u.role, u.product, u.complaint_id
