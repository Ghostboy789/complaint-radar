select complaints, distinct_texts, in_modal_product
from {{ ref('mart_label_noise') }}
where in_modal_product > complaints
   or distinct_texts > complaints
