{{ config(materialized='table') }}

with base as (
    select
        complaint_id,
        date_received,
        product,
        sub_product,
        coalesce(issue, 'Unknown') as issue,
        company,
        state,
        submitted_via,
        coalesce(company_response, 'Unknown') as company_response,
        timely_response,
        has_narrative,
        text_hash
    from {{ ref('stg_complaints') }}
),

pm as (
    select * from {{ ref('product_map') }}
),

pm_exact as (
    select product, sub_product, product_group
    from pm
    where sub_product is not null and sub_product <> '*'
),

pm_star as (
    select product, product_group
    from pm
    where sub_product = '*'
),

joined as (
    select
        b.complaint_id,
        b.date_received,
        date_trunc('week', b.date_received)::date as week_start,
        date_trunc('month', b.date_received)::date as month_start,
        extract(year from b.date_received)::int as year,
        b.product,
        b.sub_product,
        coalesce(pe.product_group, ps.product_group) as product_group,
        b.issue,
        b.company,
        b.state,
        b.submitted_via,
        b.company_response,
        (b.company_response <> 'In progress') as is_responded,
        (b.timely_response = 'Yes') as is_timely,
        (b.company_response = 'Closed with monetary relief') as is_monetary_relief,
        (
            b.company_response in (
                'Closed with monetary relief',
                'Closed with non-monetary relief',
                'Closed with relief'
            )
        ) as is_any_relief,
        b.has_narrative,
        b.text_hash
    from base b
    left join pm_exact pe
        on b.product = pe.product and b.sub_product = pe.sub_product
    left join pm_star ps
        on pe.product_group is null and b.product = ps.product
)

select
    complaint_id,
    date_received,
    week_start,
    month_start,
    year,
    product,
    sub_product,
    product_group,
    issue,
    company,
    state,
    submitted_via,
    company_response,
    is_responded,
    is_timely,
    is_monetary_relief,
    is_any_relief,
    has_narrative,
    text_hash
from joined
