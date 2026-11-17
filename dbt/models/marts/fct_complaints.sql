-- depends_on: {{ ref('ensure_marts_dir') }}

select
    cast(complaint_id as bigint) as complaint_id,
    cast(date_received as date) as date_received,
    cast(week_start as date) as week_start,
    cast(month_start as date) as month_start,
    cast(year as integer) as year,
    cast(product as varchar) as product,
    cast(product_group as varchar) as product_group,
    cast(issue as varchar) as issue,
    cast(company as varchar) as company,
    cast(state as varchar) as state,
    cast(submitted_via as varchar) as submitted_via,
    cast(company_response as varchar) as company_response,
    cast(is_responded as boolean) as is_responded,
    cast(is_timely as boolean) as is_timely,
    cast(is_monetary_relief as boolean) as is_monetary_relief,
    cast(is_any_relief as boolean) as is_any_relief,
    cast(has_narrative as boolean) as has_narrative,
    cast(text_hash as varchar) as text_hash
from {{ ref('int_complaints') }}
