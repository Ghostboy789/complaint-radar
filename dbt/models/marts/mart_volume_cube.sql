-- depends_on: {{ ref('ensure_marts_dir') }}

with top_companies as (
    select company
    from {{ ref('int_complaints') }}
    group by company
    order by count(*) desc, company asc
    limit 20
),

bucketed as (
    select
        year,
        product_group,
        case
            when company in (select company from top_companies) then company
            else 'All other companies'
        end as company_bucket,
        has_narrative,
        is_responded,
        is_timely,
        is_monetary_relief,
        is_any_relief
    from {{ ref('int_complaints') }}
)

select
    cast(year as integer) as year,
    cast(product_group as varchar) as product_group,
    cast(company_bucket as varchar) as company_bucket,
    cast(count(*) as bigint) as complaints,
    cast(sum(case when has_narrative then 1 else 0 end) as bigint) as with_narrative,
    cast(sum(case when is_responded then 1 else 0 end) as bigint) as responded,
    cast(sum(case when is_responded and is_timely then 1 else 0 end) as bigint) as timely,
    cast(sum(case when is_monetary_relief then 1 else 0 end) as bigint) as monetary_relief,
    cast(sum(case when is_any_relief then 1 else 0 end) as bigint) as any_relief
from bucketed
group by year, product_group, company_bucket
order by year, product_group, company_bucket
