-- depends_on: {{ ref('ensure_marts_dir') }}

select
    cast(year as integer) as year,
    cast(product_group as varchar) as product_group,
    cast(company_response as varchar) as company_response,
    cast(count(*) as bigint) as complaints
from {{ ref('int_complaints') }}
group by year, product_group, company_response
order by year, product_group, company_response
