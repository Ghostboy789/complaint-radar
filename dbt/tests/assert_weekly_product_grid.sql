with weeks as (
    select cast(week_start as date) as week_start
    from range(
        cast('2011-12-05' as date),
        cast('2026-08-31' as date),
        interval '7 day'
    ) as t(week_start)
),

expected as (
    select count(*) as groups
    from {{ ref('product_groups') }}
),

actual as (
    select
        week_start,
        count(*) as row_count,
        count(distinct product_group) as group_count
    from {{ ref('mart_weekly_product') }}
    group by week_start
)

select
    w.week_start,
    coalesce(a.row_count, 0) as row_count,
    coalesce(a.group_count, 0) as group_count,
    (select groups from expected) as expected_groups
from weeks w
left join actual a on w.week_start = a.week_start
where coalesce(a.row_count, 0) <> (select groups from expected)
   or coalesce(a.group_count, 0) <> (select groups from expected)

union all

select
    a.week_start,
    a.row_count,
    a.group_count,
    (select groups from expected) as expected_groups
from actual a
where a.week_start not in (select week_start from weeks)
