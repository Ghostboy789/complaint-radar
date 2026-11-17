-- depends_on: {{ ref('ensure_marts_dir') }}

select
    cast(product as varchar) as product,
    cast(sub_product as varchar) as sub_product,
    cast(product_group as varchar) as product_group,
    cast(min(date_received) as date) as first_date,
    cast(max(date_received) as date) as last_date,
    cast(count(*) as bigint) as complaints,
    cast(sum(case when has_narrative then 1 else 0 end) as bigint) as with_narrative
from {{ ref('int_complaints') }}
group by product, sub_product, product_group
order by product, sub_product
