select complaint_id, date_received, product
from {{ ref('fct_complaints') }}
where has_narrative = true
  and date_received >= cast('2023-09-01' as date)
  and (
      product is null
      or product not in (select current_product from {{ ref('product_groups') }})
  )
