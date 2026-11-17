-- depends_on: {{ ref('ensure_marts_dir') }}

select
    cast(month_start as date) as month_start,
    cast(product_group as varchar) as product_group,
    cast(count(*) as bigint) as complaints,
    cast(sum(case when has_narrative then 1 else 0 end) as bigint) as with_narrative,
    cast(sum(case when is_responded then 1 else 0 end) as bigint) as responded,
    cast(sum(case when is_responded and is_timely then 1 else 0 end) as bigint) as timely,
    cast(sum(case when is_monetary_relief then 1 else 0 end) as bigint) as monetary_relief,
    cast(sum(case when is_any_relief then 1 else 0 end) as bigint) as any_relief
from {{ ref('int_complaints') }}
group by month_start, product_group
order by month_start, product_group
