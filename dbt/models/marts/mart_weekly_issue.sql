-- depends_on: {{ ref('ensure_marts_dir') }}

select
    cast(week_start as date) as week_start,
    cast(product_group as varchar) as product_group,
    cast(issue as varchar) as issue,
    cast(count(*) as bigint) as complaints
from {{ ref('int_complaints') }}
where week_start >= cast('2011-12-05' as date)
  and week_start <= cast('2026-08-24' as date)
group by week_start, product_group, issue
order by week_start, product_group, issue
