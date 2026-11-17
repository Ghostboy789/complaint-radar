-- depends_on: {{ ref('ensure_marts_dir') }}

with base as (
    select year, product_group, text_hash
    from {{ ref('int_complaints') }}
    where has_narrative = true
),

hash_counts as (
    select text_hash, count(*) as c
    from {{ ref('int_complaints') }}
    where has_narrative = true
    group by text_hash
)

select
    cast(b.year as integer) as year,
    cast(b.product_group as varchar) as product_group,
    cast(count(*) as bigint) as with_narrative,
    cast(sum(case when h.c > 1 then 1 else 0 end) as bigint) as repeated_text
from base b
left join hash_counts h on b.text_hash = h.text_hash
group by b.year, b.product_group
order by b.year, b.product_group
