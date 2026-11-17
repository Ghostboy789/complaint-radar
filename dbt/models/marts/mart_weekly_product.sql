-- depends_on: {{ ref('ensure_marts_dir') }}

with weeks as (
    select cast(week_start as date) as week_start
    from range(
        cast('2011-12-05' as date),
        cast('2026-08-31' as date),
        interval '7 day'
    ) as t(week_start)
),

groups as (
    select cast(product_group as varchar) as product_group
    from {{ ref('product_groups') }}
),

grid as (
    select w.week_start, g.product_group
    from weeks w
    cross join groups g
),

agg as (
    select
        cast(week_start as date) as week_start,
        cast(product_group as varchar) as product_group,
        count(*) as complaints,
        sum(case when has_narrative then 1 else 0 end) as with_narrative
    from {{ ref('int_complaints') }}
    where week_start >= cast('2011-12-05' as date)
      and week_start <= cast('2026-08-24' as date)
    group by week_start, product_group
)

select
    cast(g.week_start as date) as week_start,
    cast(g.product_group as varchar) as product_group,
    cast(coalesce(a.complaints, 0) as bigint) as complaints,
    cast(coalesce(a.with_narrative, 0) as bigint) as with_narrative
from grid g
left join agg a
    on g.week_start = a.week_start and g.product_group = a.product_group
order by g.week_start, g.product_group
