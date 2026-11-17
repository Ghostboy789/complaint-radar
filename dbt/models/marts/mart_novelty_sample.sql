-- depends_on: {{ ref('ensure_marts_dir') }}

with event_groups as (
    select distinct product_group
    from {{ ref('events') }}
),

base as (
    select complaint_id, week_start, product_group
    from {{ ref('int_complaints') }}
    where has_narrative = true
      and week_start >= cast('2015-03-23' as date)
      and week_start <= cast('2026-08-24' as date)
      and product_group in (select product_group from event_groups)
),

ranked as (
    select
        *,
        row_number() over (
            partition by week_start, product_group
            order by md5(cast(complaint_id as varchar)) asc
        ) as rn
    from base
),

picked as (
    select complaint_id, week_start, product_group
    from ranked
    where rn <= 100
)

select
    cast(p.complaint_id as bigint) as complaint_id,
    cast(p.week_start as date) as week_start,
    cast(p.product_group as varchar) as product_group,
    cast(n.narrative as varchar) as narrative
from picked p
left join {{ ref('stg_narratives') }} n on p.complaint_id = n.complaint_id
order by p.week_start, p.product_group, p.complaint_id
