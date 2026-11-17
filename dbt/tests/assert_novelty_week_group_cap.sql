select week_start, product_group, count(*) as row_count
from {{ ref('mart_novelty_sample') }}
group by week_start, product_group
having count(*) > 100
