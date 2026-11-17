-- depends_on: {{ ref('ensure_marts_dir') }}

select
    cast(coalesce(state, 'Unknown') as varchar) as state,
    cast(year as integer) as year,
    cast(count(*) as bigint) as complaints
from {{ ref('int_complaints') }}
group by 1, 2
order by 1, 2
