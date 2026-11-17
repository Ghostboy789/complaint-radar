{# Write the built mart table to <CR_MARTS_DIR>/<model>.parquet. #}
{% macro write_mart_parquet() %}
  {%- set marts_dir = env_var('CR_MARTS_DIR', '../marts_out') -%}
  copy {{ this }} to '{{ marts_dir }}/{{ this.identifier }}.parquet' (format parquet)
{%- endmacro %}
