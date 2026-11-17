select l.complaint_id
from {{ ref('mart_llm_samples') }} l
left join {{ ref('mart_router_samples') }} r
    on l.complaint_id = r.complaint_id
   and r.split = 'test'
where l.role = 'test'
  and r.complaint_id is null
