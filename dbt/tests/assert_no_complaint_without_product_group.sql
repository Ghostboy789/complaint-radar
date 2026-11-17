select complaint_id, product, product_group
from {{ ref('fct_complaints') }}
where product_group is null or trim(product_group) = ''
