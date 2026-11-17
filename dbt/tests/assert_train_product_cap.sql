select product, count(*) as train_rows
from {{ ref('mart_router_samples') }}
where split = 'train'
group by product
having count(*) > 100000
