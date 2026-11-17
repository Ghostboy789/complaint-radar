with mart as (
    select sum(complaints) as mart_rows
    from {{ ref('mart_volume_cube') }}
),

fct as (
    select count(*) as fct_rows
    from {{ ref('fct_complaints') }}
)

select mart.mart_rows, fct.fct_rows
from mart, fct
where mart.mart_rows <> fct.fct_rows
