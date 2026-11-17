select
    'mart_volume_monthly' as model_name,
    cast(month_start as varchar) as row_key,
    complaints,
    with_narrative,
    responded,
    timely,
    monetary_relief,
    any_relief
from {{ ref('mart_volume_monthly') }}
where with_narrative > complaints
   or responded > complaints
   or timely > responded
   or monetary_relief > any_relief
   or any_relief > responded

union all

select
    'mart_volume_cube' as model_name,
    cast(year as varchar) || '|' || product_group || '|' || company_bucket as row_key,
    complaints,
    with_narrative,
    responded,
    timely,
    monetary_relief,
    any_relief
from {{ ref('mart_volume_cube') }}
where with_narrative > complaints
   or responded > complaints
   or timely > responded
   or monetary_relief > any_relief
   or any_relief > responded

union all

select
    'mart_weekly_product' as model_name,
    cast(week_start as varchar) || '|' || product_group as row_key,
    complaints,
    with_narrative,
    cast(null as bigint) as responded,
    cast(null as bigint) as timely,
    cast(null as bigint) as monetary_relief,
    cast(null as bigint) as any_relief
from {{ ref('mart_weekly_product') }}
where with_narrative > complaints
