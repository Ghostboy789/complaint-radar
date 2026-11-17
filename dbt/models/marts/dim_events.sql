-- depends_on: {{ ref('ensure_marts_dir') }}

select
    cast(event_id as varchar) as event_id,
    cast(event_date as date) as event_date,
    cast(date_trunc('week', event_date) as date) as week_start,
    cast(product_group as varchar) as product_group,
    cast(title as varchar) as title
from {{ ref('events') }}
order by event_date
