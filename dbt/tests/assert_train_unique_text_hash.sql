select text_hash, count(*) as row_count
from {{ ref('mart_router_samples') }}
where split = 'train'
group by text_hash
having count(*) > 1
