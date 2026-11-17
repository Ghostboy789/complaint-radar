select role, product, count(*) as role_rows
from {{ ref('mart_llm_samples') }}
where role in ('test', 'validation')
group by role, product
having (role = 'test' and count(*) > 300)
    or (role = 'validation' and count(*) > 150)
