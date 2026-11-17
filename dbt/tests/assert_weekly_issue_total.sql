with mart as (
    select sum(complaints) as mart_rows
    from {{ ref('mart_weekly_issue') }}
),

fct as (
    select count(*) as fct_rows
    from {{ ref('fct_complaints') }}
    where week_start >= cast('2011-12-05' as date)
      and week_start <= cast('2026-08-24' as date)
)

select mart.mart_rows, fct.fct_rows
from mart, fct
where mart.mart_rows <> fct.fct_rows
