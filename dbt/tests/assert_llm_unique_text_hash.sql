select role, product, text_hash, count(*) as row_count
from {{ ref('mart_llm_samples') }}
group by role, product, text_hash
having count(*) > 1
