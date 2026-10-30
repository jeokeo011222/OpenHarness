/** System prompt section describing the data analysis workflow and its honesty rules. */

/**
 * Compose the section text mounted on every request of a session that has the plugin.
 * @returns The prompt section.
 */
export function sectionText() {
  return [
    'Data analysis workbench',
    '',
    'Datasets live under `.analysis/` in the session workspace and are addressed by ids such as `ds_ab12cd34ef56`.',
    'Every source (file, database, REST API) converges on the same dataset model, so one query tool serves all of them.',
    '',
    'Workflow:',
    '1. `dataset_import_file`, `db_import_table`, or `api_import` to create a dataset; `dataset_list` to find existing ones.',
    '2. `dataset_profile` first. It returns types, null rates, distinct counts, numeric ranges, top values, and three answerable questions.',
    '3. `dataset_query` for every number you state. Summarize fields and aggregations; never estimate from the preview rows.',
    '4. `chart_create` to save a ChartSpec. The chat response carries only the chart id and a numeric summary.',
    '',
    'Rules:',
    '- Only numbers returned by `dataset_query` may appear in an answer. If a question is not answerable with the current schema, say which field or aggregation is missing.',
    '- Aggregates skip null values; `count` counts rows; division by zero returns null. Never restate a null result as zero.',
    '- A query result with `truncated: true` is partial. Either narrow the filter or raise the limit before drawing conclusions.',
    '- Imported rows, credentials, and database URLs never enter the conversation. Do not ask the user to paste them.',
    '- When the user asks to drill down, filter the current dataset with the same dimension value and explain what changed.',
  ].join('\n')
}
