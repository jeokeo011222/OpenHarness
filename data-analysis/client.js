/**
 * Web half of dsh-data-analysis: a right-sidebar panel that reads the datasets
 * and charts the host tools wrote under `<workspace>/.analysis`, aggregates a
 * bounded sample in the browser, and draws charts as hand-built SVG.
 *
 * The panel is read-only: imports, queries, and saved charts are produced by
 * the host tools; this half only lists, previews, and visualizes them.
 */
window.__ModuleLoader__.load({
  id: 'dsh-data-analysis',
  factory(require) {
    const React = require('react')
    const e = React.createElement

    const NS = 'dataAnalysis'
    const PANEL_ID = 'data-analysis'
    const TAB_ID = 'dsh-data-analysis'
    const TAB_KIND = 'data-analysis'
    const ROW_LIMIT = 5000
    const FALLBACK_ROW_LIMIT = 1000
    const PALETTE_SIZE = 6
    const SVG_WIDTH = 640
    const SVG_HEIGHT = 360

    const zh = {
      'tab.title': '数据分析',
      'guide.title': '数据分析',
      'guide.description': '查看 Agent 导入的数据集：字段、样本、图表与已保存的可视化。',
      'page.back': '返回对话',
      'page.noSession': '请先打开一个对话，再查看它的数据分析。',
      'action.refresh': '刷新',
      'list.title': '数据集',
      'list.empty': '还没有数据集。让 Agent 用 dataset_import_file、db_import_table 或 api_import 导入后再回来查看。',
      'list.rows': '{count} 行',
      'list.columns': '{count} 列',
      'state.loading': '正在载入…',
      'state.loadError': '加载失败：{message}',
      'state.select': '选择上方的一个数据集查看字段、样本与图表。',
      'section.overview': '概览',
      'section.fields': '字段',
      'section.derived': '计算字段',
      'section.preview': '数据预览',
      'section.saved': '已保存图表',
      'section.chart': '图表',
      'label.source': '来源 {kind}',
      'label.version': '版本 {version}',
      'label.updated': '更新于 {time}',
      'field.search': '搜索字段',
      'field.name': '名称',
      'field.type': '类型',
      'field.role': '角色',
      'field.nullRate': '空值率',
      'field.distinct': '去重值',
      'role.measure': '指标',
      'role.dimension': '维度',
      'type.string': '文本',
      'type.integer': '整数',
      'type.number': '数值',
      'type.boolean': '布尔',
      'type.date': '日期',
      'type.datetime': '日期时间',
      'derived.empty': '没有计算字段。Agent 可以用 dataset_add_field 追加。',
      'derived.expression': '表达式',
      'preview.note': '前 {count} 行',
      'value.null': '空',
      'value.true': '是',
      'value.false': '否',
      'value.unknown': '未知',
      'chart.type': '图表类型',
      'chart.dimension': '维度',
      'chart.measure': '指标',
      'chart.aggregate': '聚合',
      'chart.series': '系列',
      'chart.seriesNone': '无',
      'chart.horizontal': '横向',
      'chart.stacked': '堆叠',
      'chart.showValues': '显示数值',
      'chart.needDimension': '请选择维度。',
      'chart.needMeasure': '请选择指标。',
      'chart.needTwoMeasures': '散点图需要两个数值字段。',
      'chart.noRows': '当前筛选没有数据行。',
      'chart.noVisibleSeries': '所有系列都已隐藏。',
      'chart.countNote': '基于 {count} 行样本',
      'chart.cappedNote': '仅载入前 {count} 行，图表按此样本计算。',
      'chart.savedNote': '图表由 Agent 的 chart_create 保存；这里用当前数据集样本做只读预览。',
      'chart.savedPreview': '预览',
      'chart.savedEmpty': 'Agent 还没有保存图表。',
      'chart.created': '创建于 {time}',
      'chart.chip': '{field} = {value}',
      'chart.removeChip': '移除筛选 {field} = {value}',
      'chart.drillNote': '筛选仅作用于本地面板图表。',
      'chart.tooltip': '{category} · {series}：{value}',
      'chart.legendToggle': '显示或隐藏系列 {name}',
      'chart.aria': '图表：{title}',
      'chart.measureLabel': '{agg}({field})',
      'chart.share': '{value}%',
      'chart.tableNote': '共 {count} 行，显示前 {shown} 行。',
      'chart.backToBuild': '返回图表构建',
      'chart.invalid': '无法渲染该图表。',
      'agg.count': '计数',
      'agg.countDistinct': '去重计数',
      'agg.sum': '求和',
      'agg.avg': '平均',
      'agg.min': '最小',
      'agg.max': '最大',
      'agg.p50': '中位数',
      'agg.p95': '95 分位',
      'chartType.bar': '柱状图',
      'chartType.line': '折线图',
      'chartType.area': '面积图',
      'chartType.pie': '饼图',
      'chartType.scatter': '散点图',
      'chartType.kpi': '指标卡',
      'chartType.table': '表格',
    }

    const en = {
      'tab.title': 'Data analysis',
      'guide.title': 'Data analysis',
      'guide.description': 'Inspect datasets the agent imported: fields, sample rows, charts, and saved visualizations.',
      'page.back': 'Back to conversation',
      'page.noSession': 'Open a conversation first, then inspect its datasets here.',
      'action.refresh': 'Refresh',
      'list.title': 'Datasets',
      'list.empty': 'No datasets yet. Let the agent import with dataset_import_file, db_import_table, or api_import, then come back.',
      'list.rows': '{count} rows',
      'list.columns': '{count} columns',
      'state.loading': 'Loading…',
      'state.loadError': 'Could not load: {message}',
      'state.select': 'Pick a dataset above to see its fields, sample rows, and charts.',
      'section.overview': 'Overview',
      'section.fields': 'Fields',
      'section.derived': 'Computed fields',
      'section.preview': 'Preview',
      'section.saved': 'Saved charts',
      'section.chart': 'Chart',
      'label.source': 'Source {kind}',
      'label.version': 'Version {version}',
      'label.updated': 'Updated {time}',
      'field.search': 'Search fields',
      'field.name': 'Name',
      'field.type': 'Type',
      'field.role': 'Role',
      'field.nullRate': 'Null rate',
      'field.distinct': 'Distinct',
      'role.measure': 'Measure',
      'role.dimension': 'Dimension',
      'type.string': 'Text',
      'type.integer': 'Integer',
      'type.number': 'Number',
      'type.boolean': 'Boolean',
      'type.date': 'Date',
      'type.datetime': 'Datetime',
      'derived.empty': 'No computed fields. The agent can add one with dataset_add_field.',
      'derived.expression': 'Expression',
      'preview.note': 'First {count} rows',
      'value.null': 'Empty',
      'value.true': 'Yes',
      'value.false': 'No',
      'value.unknown': 'Unknown',
      'chart.type': 'Chart type',
      'chart.dimension': 'Dimension',
      'chart.measure': 'Measure',
      'chart.aggregate': 'Aggregate',
      'chart.series': 'Series',
      'chart.seriesNone': 'None',
      'chart.horizontal': 'Horizontal',
      'chart.stacked': 'Stacked',
      'chart.showValues': 'Values',
      'chart.needDimension': 'Pick a dimension.',
      'chart.needMeasure': 'Pick a measure.',
      'chart.needTwoMeasures': 'A scatter plot needs two numeric fields.',
      'chart.noRows': 'No rows match the current filters.',
      'chart.noVisibleSeries': 'All series are hidden.',
      'chart.countNote': 'From a {count}-row sample',
      'chart.cappedNote': 'Only the first {count} rows were loaded; the chart uses this sample.',
      'chart.savedNote': 'Saved by the agent with chart_create; this is a read-only preview over the loaded sample.',
      'chart.savedPreview': 'Preview',
      'chart.savedEmpty': 'The agent has not saved any chart yet.',
      'chart.created': 'Created {time}',
      'chart.chip': '{field} = {value}',
      'chart.removeChip': 'Remove filter {field} = {value}',
      'chart.drillNote': 'Filters apply to this local chart only.',
      'chart.tooltip': '{category} · {series}: {value}',
      'chart.legendToggle': 'Show or hide series {name}',
      'chart.aria': 'Chart: {title}',
      'chart.measureLabel': '{agg}({field})',
      'chart.share': '{value}%',
      'chart.tableNote': '{count} rows total; showing the first {shown}.',
      'chart.backToBuild': 'Back to chart builder',
      'chart.invalid': 'This chart cannot be rendered.',
      'agg.count': 'Count',
      'agg.countDistinct': 'Distinct count',
      'agg.sum': 'Sum',
      'agg.avg': 'Average',
      'agg.min': 'Minimum',
      'agg.max': 'Maximum',
      'agg.p50': 'Median',
      'agg.p95': '95th percentile',
      'chartType.bar': 'Bar',
      'chartType.line': 'Line',
      'chartType.area': 'Area',
      'chartType.pie': 'Pie',
      'chartType.scatter': 'Scatter',
      'chartType.kpi': 'Metric',
      'chartType.table': 'Table',
    }

    const CSS = `
.da-root { display: flex; flex-direction: column; gap: 10px; padding: 10px; box-sizing: border-box; height: 100%; overflow-y: auto; color: var(--dsw-alias-label-primary); font-size: 12px; }
.da-section { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); }
.da-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.da-title { margin: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.da-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.da-note { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }
.da-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 1.5; }
.da-empty { margin: 0; padding: 10px 4px; color: var(--dsw-alias-label-secondary); text-align: center; line-height: 1.6; }
.da-button { font: inherit; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); padding: 2px 8px; cursor: pointer; }
.da-button:hover { border-color: var(--dsw-alias-state-business-primary); }
.da-button[aria-pressed="true"] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.da-button:focus-visible, .da-input:focus-visible, .da-select:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.da-list { display: flex; flex-direction: column; gap: 2px; max-height: 200px; overflow-y: auto; }
.da-list-item { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; padding: 4px 6px; font: inherit; text-align: left; color: var(--dsw-alias-label-primary); background: transparent; border: 1px solid transparent; border-left: 2px solid transparent; border-radius: var(--dsw-radius-sm); cursor: pointer; }
.da-list-item:hover { border-color: var(--dsw-alias-border-l1); }
.da-list-item[data-selected="true"] { border-left-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-base)); }
.da-item-name { font-weight: 600; overflow-wrap: anywhere; }
.da-scroll { overflow: auto; max-height: 230px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); }
.da-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.da-table th, .da-table td { padding: 3px 5px; text-align: left; vertical-align: top; white-space: nowrap; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.da-table th { position: sticky; top: 0; color: var(--dsw-alias-label-secondary); font-weight: 600; background: var(--dsw-alias-bg-base); }
.da-table th button { all: unset; cursor: pointer; color: inherit; font: inherit; }
.da-input, .da-select { min-width: 0; padding: 2px 6px; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); }
.da-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.da-field { display: flex; flex-direction: column; gap: 2px; flex: 1 1 120px; min-width: 0; }
.da-field-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.da-check { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }
.da-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l3); border-radius: 999px; }
.da-chip button { all: unset; cursor: pointer; color: var(--dsw-alias-label-secondary); }
.da-chart { display: flex; flex-direction: column; gap: 4px; }
.da-svg { display: block; width: 100%; height: auto; }
.da-axis { stroke: var(--dsw-alias-border-l3); stroke-width: 1; }
.da-grid { stroke: var(--dsw-alias-border-l1); stroke-width: 1; }
.da-label { fill: var(--dsw-alias-label-secondary); font-size: 10px; }
.da-value-label { fill: var(--dsw-alias-label-primary); font-size: 10px; }
.da-line { stroke-width: 2; fill: none; }
.da-area { fill-opacity: 0.24; stroke-width: 1.5; }
.da-point { stroke-width: 1; }
.da-legend { display: flex; flex-wrap: wrap; gap: 2px 10px; }
.da-legend button { all: unset; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.da-legend button[aria-pressed="false"] { opacity: 0.45; }
.da-swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: var(--da-color); }
.da-kpi { display: flex; flex-direction: column; gap: 2px; padding: 10px 4px; }
.da-kpi-value { font-size: 28px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.da-kpi-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.da-c1 { --da-color: var(--dsw-alias-state-business-primary); }
.da-c2 { --da-color: var(--dsw-alias-state-success-primary); }
.da-c3 { --da-color: var(--dsw-alias-state-warn-primary); }
.da-c4 { --da-color: var(--dsw-alias-state-error-primary); }
.da-c5 { --da-color: var(--dsw-alias-state-done-primary); }
.da-c6 { --da-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-bg-base)); }
.da-fill { fill: var(--da-color); }
.da-stroke { stroke: var(--da-color); }
.da-page { display: flex; flex-direction: column; gap: 10px; padding: 14px 18px; box-sizing: border-box; height: 100%; overflow-y: auto; color: var(--dsw-alias-label-primary); font-size: 12px; }
.da-page-head { display: flex; align-items: center; gap: 10px; }
.da-page-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.da-page-back { font: inherit; font-size: 12px; padding: 3px 10px; border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.da-page-back:hover { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); }
.da-page-back:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.da-page-body { flex: 1; min-height: 0; }
`

    /**
     * Draw the sidebar guide glyph: three ascending bars over a baseline.
     * @param props - Icon props supplied by the host (`size`, `className`).
     * @returns An inline SVG element.
     */
    function GuideArtwork(props) {
      const size = props && props.size ? props.size : 16
      return e('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        className: props ? props.className : undefined,
      },
      e('path', { d: 'M2 13.5h12', stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
      e('rect', { x: 3, y: 8, width: 2.2, height: 5.5, rx: 0.6, fill: 'currentColor' }),
      e('rect', { x: 6.9, y: 5, width: 2.2, height: 8.5, rx: 0.6, fill: 'currentColor' }),
      e('rect', { x: 10.8, y: 2, width: 2.2, height: 11.5, rx: 0.6, fill: 'currentColor' }))
    }

    /**
     * Install the panel stylesheet once, and remove it when the plugin unloads.
     * @param ctx - Client plugin context.
     */
    function injectStyles(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-data-analysis'
        style.textContent = CSS
        document.head.append(style)
        return () => { style.remove() }
      }, 'dsh-data-analysis: styles')
    }

    /**
     * Locale used for number and date formatting.
     * @returns A BCP 47 language tag, or undefined for the browser default.
     */
    function numberLocale() {
      const lang = typeof document !== 'undefined' && document.documentElement
        ? document.documentElement.lang
        : ''
      return lang === '' ? undefined : lang
    }

    /**
     * Shorten a label to fit a chart axis.
     * @param text - Source text.
     * @param max - Maximum characters before an ellipsis is appended.
     * @returns The possibly shortened text.
     */
    function truncate(text, max) {
      const value = String(text)
      return value.length <= max ? value : value.slice(0, Math.max(1, max - 1)) + '…'
    }

    /**
     * Format a number for a chart value or table cell.
     * @param value - Number, or null when the aggregate is undefined.
     * @param nullLabel - Text used for null.
     * @returns Display text.
     */
    function formatNumber(value, nullLabel) {
      if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
        return nullLabel
      }
      const abs = Math.abs(value)
      const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4
      return new Intl.NumberFormat(numberLocale(), { maximumFractionDigits: digits }).format(value)
    }

    /**
     * Compact axis tick text.
     * @param value - Tick value.
     * @returns Display text.
     */
    function formatAxis(value) {
      if (!Number.isFinite(value)) return ''
      const abs = Math.abs(value)
      if (abs >= 100000) {
        return new Intl.NumberFormat(numberLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value)
      }
      const digits = abs >= 10 ? 0 : abs >= 1 ? 1 : 3
      return new Intl.NumberFormat(numberLocale(), { maximumFractionDigits: digits }).format(value)
    }

    /**
     * Format an ISO timestamp for the metadata line.
     * @param value - ISO timestamp.
     * @param unknown - Text used for a missing or invalid timestamp.
     * @returns Localized short date and time.
     */
    function formatTime(value, unknown) {
      if (value === null || value === undefined || value === '') return unknown
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return new Intl.DateTimeFormat(numberLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(date)
      } catch {
        return date.toISOString()
      }
    }

    /**
     * Choose a stable tick step for a numeric axis.
     * @param min - Domain minimum.
     * @param max - Domain maximum.
     * @param target - Rough number of desired intervals.
     * @returns Ascending tick values including both domain ends.
     */
    function niceTicks(min, max, target) {
      let low = min
      let high = max
      if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1]
      if (low > high) {
        const swap = low
        low = high
        high = swap
      }
      if (low === high) {
        const pad = Math.abs(low) * 0.1 || 1
        low -= pad
        high += pad
      }
      const raw = (high - low) / Math.max(1, target)
      const power = Math.pow(10, Math.floor(Math.log10(raw)))
      const norm = raw / power
      const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * power
      const start = Math.floor(low / step) * step
      const end = Math.ceil(high / step) * step
      const ticks = []
      for (let value = start; value <= end + step / 2; value += step) {
        ticks.push(Math.round(value * 1e10) / 1e10)
      }
      return ticks.length > 12 ? ticks.filter((tick, index) => index % 2 === 0) : ticks
    }

    /**
     * Whether a column holds numeric measures.
     * @param type - Declared column type.
     * @returns True for integer and number columns.
     */
    function isNumericType(type) {
      return type === 'integer' || type === 'number'
    }

    /**
     * Whether a column name looks like a surrogate key rather than a measure or
     * a reporting dimension.
     * @param name - Column name.
     * @returns True when the name resembles an identifier.
     */
    function isIdentifierLike(name) {
      return /(^|_)(id|uuid|guid|code|no|num|index|key)($|_)/i.test(name) || /编号|序号|代码|主键/i.test(name)
    }

    /**
     * Re-create the host's filter semantics for a locally aggregated chart.
     * @param value - Row cell value.
     * @param filter - Filter descriptor with `field`, `op`, and optional `value`.
     * @param entry - Column schema entry used to choose numeric comparisons.
     * @returns True when the row passes.
     */
    function passesFilter(value, filter, entry) {
      if (filter.op === 'isNull') return value === null || value === undefined
      if (filter.op === 'notNull') return value !== null && value !== undefined
      if (filter.op === 'in' || filter.op === 'notIn') {
        const list = Array.isArray(filter.value) ? filter.value.map(item => String(item)) : []
        const found = list.includes(String(value))
        return filter.op === 'in' ? found : !found
      }
      if (filter.op === 'between') {
        if (!Array.isArray(filter.value) || filter.value.length !== 2) return false
        if (typeof value === 'number') {
          return value >= Number(filter.value[0]) && value <= Number(filter.value[1])
        }
        return String(value) >= String(filter.value[0]) && String(value) <= String(filter.value[1])
      }
      if (filter.op === 'contains' || filter.op === 'startsWith') {
        const text = String(value === null || value === undefined ? '' : value)
        const needle = String(filter.value === null || filter.value === undefined ? '' : filter.value)
        return filter.op === 'contains' ? text.includes(needle) : text.startsWith(needle)
      }
      const numeric = entry && isNumericType(entry.type)
      const left = numeric ? Number(value) : String(value === null || value === undefined ? '' : value)
      const right = numeric ? Number(filter.value) : String(filter.value === null || filter.value === undefined ? '' : filter.value)
      if (numeric && (Number.isNaN(left) || Number.isNaN(right))) return false
      if (filter.op === '=') return left === right
      if (filter.op === '!=') return left !== right
      if (filter.op === '>') return left > right
      if (filter.op === '>=') return left >= right
      if (filter.op === '<') return left < right
      return left <= right
    }

    /**
     * Apply every filter of a chart spec.
     * @param row - Dataset row.
     * @param filters - Filter descriptors.
     * @param schemaByName - Column type lookup.
     * @returns True when every filter passes.
     */
    function passesFilters(row, filters, schemaByName) {
      for (const filter of filters) {
        if (!filter || filter.field === undefined) continue
        const entry = schemaByName.get(filter.field)
        if (!passesFilter(row[filter.field], filter, entry)) return false
      }
      return true
    }

    /**
     * Linear-interpolated quantile on ascending values.
     * @param sorted - Ascending values.
     * @param ratio - Position in `[0, 1]`.
     * @returns The interpolated value.
     */
    function quantile(sorted, ratio) {
      const position = (sorted.length - 1) * ratio
      const lower = Math.floor(position)
      const upper = Math.ceil(position)
      if (lower === upper) return sorted[lower]
      return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
    }

    /**
     * One aggregate accumulator.
     * @returns A mutable accumulator.
     */
    function newAccumulator() {
      return { count: 0, sum: 0, used: 0, min: null, max: null, values: [], distinct: new Set() }
    }

    /**
     * Absorb a row value into an accumulator, mirroring host aggregation rules:
     * `count` counts rows, `countDistinct` and numeric bodies skip nulls.
     * @param acc - Accumulator.
     * @param value - Row cell value.
     * @param agg - Aggregate name.
     */
    function addAccumulated(acc, value, agg) {
      acc.count += 1
      if (agg === 'count') return
      if (value === null || value === undefined) return
      if (agg === 'countDistinct') {
        acc.distinct.add(String(value))
        return
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      acc.used += 1
      if (agg === 'sum' || agg === 'avg') acc.sum += value
      if (agg === 'min') acc.min = acc.min === null ? value : Math.min(acc.min, value)
      if (agg === 'max') acc.max = acc.max === null ? value : Math.max(acc.max, value)
      if (agg === 'p50' || agg === 'p95') acc.values.push(value)
    }

    /**
     * Finish an accumulator.
     * @param acc - Accumulator.
     * @param agg - Aggregate name.
     * @returns The aggregate, or null when no value contributed.
     */
    function finishAccumulated(acc, agg) {
      if (agg === 'count') return acc.count
      if (agg === 'countDistinct') return acc.distinct.size
      if (agg === 'sum') return acc.used === 0 ? null : acc.sum
      if (agg === 'avg') return acc.used === 0 ? null : acc.sum / acc.used
      if (agg === 'min') return acc.min
      if (agg === 'max') return acc.max
      if (acc.values.length === 0) return null
      const sorted = acc.values.slice().sort((left, right) => left - right)
      return quantile(sorted, agg === 'p50' ? 0.5 : 0.95)
    }

    /**
     * Human label of a measure encoding.
     * @param measure - Encoding measure with `field`, `agg`, and optional `alias`.
     * @param t - Translate function.
     * @returns Series label.
     */
    function measureLabel(measure, t) {
      if (!measure) return ''
      if (measure.alias) return measure.alias
      if (measure.agg === 'count') return t('agg.count')
      return t('chart.measureLabel', { agg: t('agg.' + measure.agg), field: measure.field })
    }

    /**
     * Label a category cell for a chart axis.
     * @param value - Raw cell value.
     * @param type - Column type.
     * @param nullLabel - Text used for null.
     * @returns Display label.
     */
    function categoryLabel(value, type, nullLabel) {
      if (value === null || value === undefined) return nullLabel
      const text = String(value)
      return type === 'date' || type === 'datetime' ? text.slice(0, 10) : text
    }

    /**
     * Build a chart model from a chart spec and a bounded row sample.
     * @param spec - Chart spec with `type`, `encoding`, `options`, and `filters`.
     * @param rows - Dataset rows loaded into the panel.
     * @param schema - Dataset column descriptors.
     * @param t - Translate function.
     * @returns A renderable model, or an empty/error model explaining why not.
     */
    function computeChart(spec, rows, schema, t) {
      const schemaByName = new Map(schema.map(entry => [entry.name, entry]))
      const filters = Array.isArray(spec.filters) ? spec.filters : []
      const filtered = rows.filter(row => passesFilters(row, filters, schemaByName))
      const encoding = spec.encoding || {}
      const x = encoding.x
      const ys = Array.isArray(encoding.y) ? encoding.y : []
      const seriesField = encoding.series ? encoding.series.field : null
      const options = spec.options || {}
      const nullLabel = t('value.null')

      if (spec.type === 'table') {
        return {
          kind: 'table',
          columns: schema.map(entry => entry.name),
          rows: filtered.slice(0, 40),
          total: filtered.length,
        }
      }
      if (filtered.length === 0) return { kind: 'empty', reason: 'noRows' }

      if (spec.type === 'kpi') {
        const measure = ys[0]
        if (!measure) return { kind: 'empty', reason: 'needMeasure' }
        const acc = newAccumulator()
        for (const row of filtered) addAccumulated(acc, measure.agg === 'count' ? 1 : row[measure.field], measure.agg)
        return { kind: 'kpi', value: finishAccumulated(acc, measure.agg), label: measureLabel(measure, t), rows: filtered.length }
      }

      if (spec.type === 'scatter') {
        const xField = ys.length >= 2 ? ys[0].field : x ? x.field : null
        const yField = ys.length >= 2 ? ys[1].field : ys[0] ? ys[0].field : null
        const xEntry = schemaByName.get(xField)
        const yEntry = schemaByName.get(yField)
        if (!xEntry || !yEntry || !isNumericType(xEntry.type) || !isNumericType(yEntry.type)) {
          return { kind: 'empty', reason: 'needTwoMeasures' }
        }
        const points = []
        for (const row of filtered) {
          const xv = row[xField]
          const yv = row[yField]
          if (typeof xv !== 'number' || typeof yv !== 'number' || !Number.isFinite(xv) || !Number.isFinite(yv)) continue
          points.push({ x: xv, y: yv, label: String(xv) + ', ' + String(yv) })
        }
        if (points.length === 0) return { kind: 'empty', reason: 'noRows' }
        return { kind: 'scatter', points, xLabel: xField, yLabel: yField, rows: filtered.length, xField, xType: xEntry.type }
      }

      if (!x || !x.field) return { kind: 'empty', reason: 'needDimension' }
      if (ys.length === 0) return { kind: 'empty', reason: 'needMeasure' }
      const xEntry = schemaByName.get(x.field)
      const xType = xEntry ? xEntry.type : 'string'

      if (spec.type === 'pie') {
        const measure = ys[0]
        const accs = new Map()
        const rawByLabel = new Map()
        for (const row of filtered) {
          const label = categoryLabel(row[x.field], xType, nullLabel)
          if (!rawByLabel.has(label)) rawByLabel.set(label, row[x.field])
          let acc = accs.get(label)
          if (!acc) {
            acc = newAccumulator()
            accs.set(label, acc)
          }
          addAccumulated(acc, measure.agg === 'count' ? 1 : row[measure.field], measure.agg)
        }
        const slices = [...accs.entries()]
          .map(([label, acc]) => ({ label, raw: rawByLabel.get(label), value: finishAccumulated(acc, measure.agg) }))
          .filter(slice => typeof slice.value === 'number' && slice.value > 0)
          .sort((left, right) => right.value - left.value)
        const total = slices.reduce((sum, slice) => sum + slice.value, 0)
        if (slices.length === 0 || total <= 0) return { kind: 'empty', reason: 'noRows' }
        return {
          kind: 'pie',
          slices,
          total,
          measureLabel: measureLabel(measure, t),
          rows: filtered.length,
          xField: x.field,
          xType,
        }
      }

      if (spec.type !== 'bar' && spec.type !== 'line' && spec.type !== 'area') {
        return { kind: 'empty', reason: 'invalid' }
      }

      const measures = seriesField ? ys.slice(0, 1) : ys
      const categoryRaw = new Map()
      const seriesNames = []
      const seriesSeen = new Map()
      const buckets = []
      for (const row of filtered) {
        const label = categoryLabel(row[x.field], xType, nullLabel)
        if (!categoryRaw.has(label)) categoryRaw.set(label, row[x.field])
        const name = seriesField
          ? categoryLabel(row[seriesField], schemaByName.get(seriesField) ? schemaByName.get(seriesField).type : 'string', nullLabel)
          : ''
        if (!seriesSeen.has(name)) {
          seriesSeen.set(name, seriesNames.length)
          seriesNames.push(name)
          buckets.push(new Map())
        }
        const seriesIndex = seriesSeen.get(name)
        let bucket = buckets[seriesIndex].get(label)
        if (!bucket) {
          bucket = measures.map(() => newAccumulator())
          buckets[seriesIndex].set(label, bucket)
        }
        measures.forEach((measure, measureIndex) => {
          addAccumulated(bucket[measureIndex], measure.agg === 'count' ? 1 : row[measure.field], measure.agg)
        })
      }

      let labels = [...categoryRaw.keys()]
      if (xType === 'date' || xType === 'datetime') labels = labels.slice().sort()
      const categories = labels.map(label => ({ label, raw: categoryRaw.get(label) }))

      const series = seriesField
        ? seriesNames.map((name, seriesIndex) => ({
          name,
          values: categories.map(category => {
            const bucket = buckets[seriesIndex].get(category.label)
            return bucket ? finishAccumulated(bucket[0], measures[0].agg) : null
          }),
        }))
        : measures.map((measure, measureIndex) => ({
          name: measureLabel(measure, t),
          values: categories.map(category => {
            const bucket = buckets[0].get(category.label)
            return bucket ? finishAccumulated(bucket[measureIndex], measure.agg) : null
          }),
        }))

      return {
        kind: 'series',
        chartType: spec.type,
        categories,
        series,
        stacked: spec.type === 'bar' && Boolean(options.stacked),
        horizontal: spec.type === 'bar' && Boolean(options.horizontal),
        showValues: Boolean(options.showValues),
        xLabel: x.field,
        xType,
        xField: x.field,
        rows: filtered.length,
      }
    }

    /**
     * Build the spec implied by the panel's builder controls.
     * @param draft - Builder control values.
     * @returns A chart spec that `computeChart` accepts.
     */
    function draftSpec(draft) {
      const base = {
        type: draft.type,
        encoding: { y: [] },
        options: {
          horizontal: Boolean(draft.horizontal),
          stacked: Boolean(draft.stacked),
          showValues: Boolean(draft.showValues),
        },
        filters: [],
      }
      if (draft.type === 'table') return base
      if (draft.type === 'kpi') {
        base.encoding.y = [{ field: draft.agg === 'count' ? '*' : draft.measure, agg: draft.agg }]
        return base
      }
      if (draft.type === 'scatter') {
        base.encoding.x = { field: draft.dimension, type: 'measure' }
        base.encoding.y = [
          { field: draft.dimension, agg: 'none' },
          { field: draft.measure, agg: 'none' },
        ]
        return base
      }
      base.encoding.x = { field: draft.dimension, type: 'dimension' }
      base.encoding.y = [{ field: draft.agg === 'count' ? '*' : draft.measure, agg: draft.agg }]
      if (draft.series) base.encoding.series = { field: draft.series }
      return base
    }

    /**
     * Palette class for the nth series or slice.
     * @param index - Zero-based color index.
     * @returns A CSS class that sets `--da-color`.
     */
    function paletteClass(index) {
      return 'da-c' + ((index % PALETTE_SIZE) + 1)
    }

    /**
     * Empty-state text for a chart model reason.
     * @param reason - Model reason code.
     * @param t - Translate function.
     * @returns Localized explanation.
     */
    function emptyText(reason, t) {
      if (reason === 'noRows') return t('chart.noRows')
      if (reason === 'needMeasure') return t('chart.needMeasure')
      if (reason === 'needTwoMeasures') return t('chart.needTwoMeasures')
      if (reason === 'invalid') return t('chart.invalid')
      return t('chart.needDimension')
    }

    /**
     * Draw the legend for a multi-series chart.
     * @param model - Series model.
     * @param options - Translate function, hidden names, and the toggle handler.
     * @returns The legend element, or null when nothing to toggle.
     */
    function renderLegend(model, options) {
      if (model.kind !== 'series' || model.series.length <= 1) return null
      const { t, hidden, onToggleSeries } = options
      return e('div', { className: 'da-legend' },
        model.series.map((series, index) => e('button', {
          key: series.name,
          type: 'button',
          'aria-pressed': hidden.indexOf(series.name) < 0 ? 'true' : 'false',
          title: t('chart.legendToggle', { name: series.name }),
          onClick: () => onToggleSeries(series.name),
        },
        e('span', { className: 'da-swatch ' + paletteClass(index) }),
        series.name)))
    }

    /**
     * Draw a bar, line, or area chart as SVG.
     * @param model - Series model from `computeChart`.
     * @param options - Translate function, hidden names, drill handler.
     * @returns SVG element, or an explanatory paragraph when nothing is visible.
     */
    function renderSeriesChart(model, options) {
      const { t, hidden, onDrill } = options
      const visible = model.series.filter(series => hidden.indexOf(series.name) < 0)
      if (visible.length === 0) return e('p', { className: 'da-empty' }, t('chart.noVisibleSeries'))
      const categories = model.categories
      const values = []
      for (const series of visible) {
        for (const value of series.values) {
          if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
        }
      }
      if (values.length === 0) return e('p', { className: 'da-empty' }, t('chart.noRows'))

      const horizontal = model.chartType === 'bar' && model.horizontal
      const stacked = model.chartType === 'bar' && model.stacked
      const nullLabel = t('value.null')
      const pad = horizontal
        ? { left: 98, right: 18, top: 12, bottom: 38 }
        : { left: 54, right: 16, top: 14, bottom: 44 }
      const plotWidth = SVG_WIDTH - pad.left - pad.right
      const plotHeight = SVG_HEIGHT - pad.top - pad.bottom
      const count = categories.length
      const elements = []

      if (horizontal) {
        let low = Math.min(0, ...values)
        let high = Math.max(0, ...values)
        if (low === high) high = low + 1
        const ticks = niceTicks(low, high, 4)
        const xMin = ticks[0]
        const xMax = ticks[ticks.length - 1]
        const xScale = value => pad.left + ((value - xMin) / (xMax - xMin)) * plotWidth
        const band = plotHeight / Math.max(1, count)
        const groupHeight = band * 0.76
        const barHeight = Math.min(18, groupHeight / visible.length)
        const groupOffset = (band - barHeight * visible.length) / 2

        for (const tick of ticks) {
          const x = xScale(tick)
          elements.push(e('line', { key: 'grid-' + tick, x1: x, x2: x, y1: pad.top, y2: pad.top + plotHeight, className: 'da-grid' }))
          elements.push(e('text', { key: 'tick-' + tick, x, y: SVG_HEIGHT - pad.bottom + 14, textAnchor: 'middle', className: 'da-label' }, formatAxis(tick)))
        }
        elements.push(e('line', { key: 'axis-y', x1: xScale(0), x2: xScale(0), y1: pad.top, y2: pad.top + plotHeight, className: 'da-axis' }))
        elements.push(e('line', { key: 'axis-x', x1: pad.left, x2: pad.left + plotWidth, y1: pad.top + plotHeight, y2: pad.top + plotHeight, className: 'da-axis' }))

        categories.forEach((category, categoryIndex) => {
          const centerY = pad.top + band * (categoryIndex + 0.5)
          elements.push(e('text', {
            key: 'cat-' + categoryIndex,
            x: pad.left - 8,
            y: centerY + 3,
            textAnchor: 'end',
            className: 'da-label',
          }, truncate(category.label, 12)))
          visible.forEach((series, seriesIndex) => {
            const value = series.values[categoryIndex]
            if (typeof value !== 'number' || !Number.isFinite(value)) return
            const zero = xScale(0)
            const end = xScale(value)
            const x = Math.min(zero, end)
            const width = Math.max(1, Math.abs(end - zero))
            const y = pad.top + band * categoryIndex + groupOffset + seriesIndex * barHeight
            elements.push(e('rect', {
              key: 'bar-' + categoryIndex + '-' + seriesIndex,
              x,
              y,
              width,
              height: Math.max(2, barHeight - 2),
              rx: 2,
              className: 'da-fill ' + paletteClass(seriesIndex),
              onClick: () => onDrill(category, model),
              style: { cursor: 'pointer' },
            }, e('title', null, t('chart.tooltip', {
              category: category.label,
              series: series.name,
              value: formatNumber(value, nullLabel),
            }))))
            if (model.showValues && width > 30) {
              elements.push(e('text', {
                key: 'val-' + categoryIndex + '-' + seriesIndex,
                x: x + width - 4,
                y: y + barHeight / 2 + 3,
                textAnchor: 'end',
                className: 'da-value-label',
              }, formatNumber(value, nullLabel)))
            }
          })
        })
      } else if (model.chartType === 'line' || model.chartType === 'area') {
        let low = Math.min(...values)
        let high = Math.max(...values)
        if (low === high) {
          const padValue = Math.abs(low) * 0.1 || 1
          low -= padValue
          high += padValue
        }
        const ticks = niceTicks(low, high, 4)
        const yMin = ticks[0]
        const yMax = ticks[ticks.length - 1]
        const yScale = value => pad.top + plotHeight - ((value - yMin) / (yMax - yMin)) * plotHeight
        const xAt = index => pad.left + (index + 0.5) * (plotWidth / Math.max(1, count))

        for (const tick of ticks) {
          const y = yScale(tick)
          elements.push(e('line', { key: 'grid-' + tick, x1: pad.left, x2: pad.left + plotWidth, y1: y, y2: y, className: 'da-grid' }))
          elements.push(e('text', { key: 'tick-' + tick, x: pad.left - 6, y: y + 3, textAnchor: 'end', className: 'da-label' }, formatAxis(tick)))
        }
        elements.push(e('line', { key: 'axis-x', x1: pad.left, x2: pad.left + plotWidth, y1: pad.top + plotHeight, y2: pad.top + plotHeight, className: 'da-axis' }))
        elements.push(e('line', { key: 'axis-y', x1: pad.left, x2: pad.left, y1: pad.top, y2: pad.top + plotHeight, className: 'da-axis' }))

        visible.forEach((series, seriesIndex) => {
          const points = []
          series.values.forEach((value, index) => {
            if (typeof value !== 'number' || !Number.isFinite(value)) return
            points.push({ x: xAt(index), y: yScale(value), value, category: categories[index] })
          })
          if (points.length === 0) return
          const path = points.map(point => point.x + ',' + point.y).join(' ')
          if (model.chartType === 'area') {
            const bottom = pad.top + plotHeight
            elements.push(e('polygon', {
              key: 'area-' + seriesIndex,
              points: path + ' ' + points[points.length - 1].x + ',' + bottom + ' ' + points[0].x + ',' + bottom,
              className: 'da-stroke da-fill ' + paletteClass(seriesIndex) + ' da-area',
            }))
          }
          elements.push(e('polyline', {
            key: 'line-' + seriesIndex,
            points: path,
            className: 'da-stroke ' + paletteClass(seriesIndex) + ' da-line',
          }))
          points.forEach((point, pointIndex) => {
            elements.push(e('circle', {
              key: 'point-' + seriesIndex + '-' + pointIndex,
              cx: point.x,
              cy: point.y,
              r: 3,
              className: 'da-stroke da-fill ' + paletteClass(seriesIndex) + ' da-point',
            }, e('title', null, t('chart.tooltip', {
              category: point.category.label,
              series: series.name,
              value: formatNumber(point.value, nullLabel),
            }))))
            if (model.showValues && count <= 12) {
              elements.push(e('text', {
                key: 'val-' + seriesIndex + '-' + pointIndex,
                x: point.x,
                y: point.y - 7,
                textAnchor: 'middle',
                className: 'da-value-label',
              }, formatNumber(point.value, nullLabel)))
            }
          })
        })
        const labelStep = Math.ceil(count / Math.max(1, Math.floor(plotWidth / 46)))
        categories.forEach((category, index) => {
          if (index % labelStep !== 0) return
          elements.push(e('text', {
            key: 'cat-' + index,
            x: xAt(index),
            y: SVG_HEIGHT - pad.bottom + 16,
            textAnchor: 'middle',
            className: 'da-label',
          }, truncate(category.label, 10)))
        })
      } else {
        const totalByCategory = categories.map((_, categoryIndex) => visible.reduce((sum, series) => {
          const value = series.values[categoryIndex]
          return sum + (typeof value === 'number' && value > 0 ? value : 0)
        }, 0))
        let low = stacked ? 0 : Math.min(0, ...values)
        let high = stacked ? Math.max(0, ...totalByCategory) : Math.max(0, ...values)
        if (low === high) high = low + 1
        const ticks = niceTicks(low, high, 4)
        const yMin = ticks[0]
        const yMax = ticks[ticks.length - 1]
        const yScale = value => pad.top + plotHeight - ((value - yMin) / (yMax - yMin)) * plotHeight
        const band = plotWidth / Math.max(1, count)
        const groupWidth = band * 0.76
        const barWidth = Math.min(22, groupWidth / visible.length)
        const groupOffset = (band - barWidth * visible.length) / 2
        const stackTop = categories.map(() => 0)

        for (const tick of ticks) {
          const y = yScale(tick)
          elements.push(e('line', { key: 'grid-' + tick, x1: pad.left, x2: pad.left + plotWidth, y1: y, y2: y, className: 'da-grid' }))
          elements.push(e('text', { key: 'tick-' + tick, x: pad.left - 6, y: y + 3, textAnchor: 'end', className: 'da-label' }, formatAxis(tick)))
        }
        elements.push(e('line', { key: 'axis-x', x1: pad.left, x2: pad.left + plotWidth, y1: pad.top + plotHeight, y2: pad.top + plotHeight, className: 'da-axis' }))
        elements.push(e('line', { key: 'axis-y', x1: pad.left, x2: pad.left, y1: pad.top, y2: pad.top + plotHeight, className: 'da-axis' }))

        categories.forEach((category, categoryIndex) => {
          const bandStart = pad.left + categoryIndex * band
          visible.forEach((series, seriesIndex) => {
            const value = series.values[categoryIndex]
            if (typeof value !== 'number' || !Number.isFinite(value)) return
            const zeroY = yScale(0)
            let y = 0
            let height = 0
            if (stacked) {
              const from = stackTop[categoryIndex]
              const amount = value > 0 ? value : 0
              const top = yScale(from + amount)
              const bottom = yScale(from)
              y = Math.min(top, bottom)
              height = Math.abs(bottom - top)
              stackTop[categoryIndex] += amount
            } else {
              const end = yScale(value)
              y = Math.min(zeroY, end)
              height = Math.abs(end - zeroY)
            }
            elements.push(e('rect', {
              key: 'bar-' + categoryIndex + '-' + seriesIndex,
              x: bandStart + groupOffset + seriesIndex * barWidth,
              y,
              width: Math.max(2, barWidth - 2),
              height: Math.max(2, height),
              rx: 2,
              className: 'da-fill ' + paletteClass(seriesIndex),
              onClick: () => onDrill(category, model),
              style: { cursor: 'pointer' },
            }, e('title', null, t('chart.tooltip', {
              category: category.label,
              series: series.name,
              value: formatNumber(value, nullLabel),
            }))))
            if (model.showValues && barWidth >= 18 && height >= 14) {
              elements.push(e('text', {
                key: 'val-' + categoryIndex + '-' + seriesIndex,
                x: bandStart + groupOffset + seriesIndex * barWidth + barWidth / 2,
                y: y - 3,
                textAnchor: 'middle',
                className: 'da-value-label',
              }, formatNumber(value, nullLabel)))
            }
          })
        })
        const labelStep = Math.ceil(count / Math.max(1, Math.floor(plotWidth / 52)))
        categories.forEach((category, index) => {
          if (index % labelStep !== 0) return
          elements.push(e('text', {
            key: 'cat-' + index,
            x: pad.left + band * (index + 0.5),
            y: SVG_HEIGHT - pad.bottom + 16,
            textAnchor: 'middle',
            className: 'da-label',
          }, truncate(category.label, 10)))
        })
      }

      return e('svg', {
        className: 'da-svg',
        viewBox: '0 0 ' + SVG_WIDTH + ' ' + SVG_HEIGHT,
        role: 'img',
        'aria-label': t('chart.aria', { title: model.xLabel }),
        preserveAspectRatio: 'xMidYMid meet',
      }, elements)
    }

    /**
     * Draw a pie chart plus its category legend.
     * @param model - Pie model from `computeChart`.
     * @param options - Translate function and drill handler.
     * @returns Chart element.
     */
    function renderPieChart(model, options) {
      const { t, onDrill } = options
      const centerX = SVG_WIDTH / 2
      const centerY = SVG_HEIGHT / 2 - 4
      const radius = Math.min(SVG_WIDTH, SVG_HEIGHT) / 2 - 34
      const elements = []
      let angle = -Math.PI / 2
      model.slices.forEach((slice, index) => {
        const share = slice.value / model.total
        const next = angle + share * Math.PI * 2
        const className = 'da-fill ' + paletteClass(index)
        const tooltip = t('chart.tooltip', {
          category: slice.label,
          series: model.measureLabel,
          value: formatNumber(slice.value, t('value.null')),
        })
        if (model.slices.length === 1) {
          elements.push(e('circle', {
            key: 'slice-0',
            cx: centerX,
            cy: centerY,
            r: radius,
            className,
            onClick: () => onDrill(slice, model),
            style: { cursor: 'pointer' },
          }, e('title', null, tooltip)))
        } else {
          const x1 = centerX + radius * Math.cos(angle)
          const y1 = centerY + radius * Math.sin(angle)
          const x2 = centerX + radius * Math.cos(next)
          const y2 = centerY + radius * Math.sin(next)
          elements.push(e('path', {
            key: 'slice-' + index,
            d: 'M ' + centerX + ' ' + centerY + ' L ' + x1 + ' ' + y1 + ' A ' + radius + ' ' + radius + ' 0 0 1 ' + x2 + ' ' + y2 + ' Z',
            className,
            onClick: () => onDrill(slice, model),
            style: { cursor: 'pointer' },
          }, e('title', null, tooltip)))
        }
        angle = next
      })
      const legend = e('div', { className: 'da-legend' },
        model.slices.map((slice, index) => e('span', {
          key: slice.label,
          className: 'da-meta',
          style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
        },
        e('span', { className: 'da-swatch ' + paletteClass(index) }),
        slice.label + ' · ' + t('chart.share', { value: Math.round((slice.value / model.total) * 1000) / 10 }))))
      return e('div', { className: 'da-chart' },
        e('svg', {
          className: 'da-svg',
          viewBox: '0 0 ' + SVG_WIDTH + ' ' + SVG_HEIGHT,
          role: 'img',
          'aria-label': t('chart.aria', { title: model.measureLabel }),
          preserveAspectRatio: 'xMidYMid meet',
        }, elements),
        legend)
    }

    /**
     * Draw a scatter plot as SVG.
     * @param model - Scatter model from `computeChart`.
     * @param options - Translate function and drill handler.
     * @returns Chart element.
     */
    function renderScatter(model, options) {
      const { t, onDrill } = options
      const pad = { left: 58, right: 18, top: 14, bottom: 44 }
      const plotWidth = SVG_WIDTH - pad.left - pad.right
      const plotHeight = SVG_HEIGHT - pad.top - pad.bottom
      const xs = model.points.map(point => point.x)
      const ys = model.points.map(point => point.y)
      const xTicks = niceTicks(Math.min(...xs), Math.max(...xs), 4)
      const yTicks = niceTicks(Math.min(...ys), Math.max(...ys), 4)
      const xMin = xTicks[0]
      const xMax = xTicks[xTicks.length - 1]
      const yMin = yTicks[0]
      const yMax = yTicks[yTicks.length - 1]
      const xScale = value => pad.left + ((value - xMin) / (xMax - xMin)) * plotWidth
      const yScale = value => pad.top + plotHeight - ((value - yMin) / (yMax - yMin)) * plotHeight
      const elements = []
      for (const tick of yTicks) {
        const y = yScale(tick)
        elements.push(e('line', { key: 'gridy-' + tick, x1: pad.left, x2: pad.left + plotWidth, y1: y, y2: y, className: 'da-grid' }))
        elements.push(e('text', { key: 'ticky-' + tick, x: pad.left - 6, y: y + 3, textAnchor: 'end', className: 'da-label' }, formatAxis(tick)))
      }
      for (const tick of xTicks) {
        const x = xScale(tick)
        elements.push(e('line', { key: 'gridx-' + tick, x1: x, x2: x, y1: pad.top, y2: pad.top + plotHeight, className: 'da-grid' }))
        elements.push(e('text', { key: 'tickx-' + tick, x, y: SVG_HEIGHT - pad.bottom + 16, textAnchor: 'middle', className: 'da-label' }, formatAxis(tick)))
      }
      elements.push(e('line', { key: 'axis-x', x1: pad.left, x2: pad.left + plotWidth, y1: pad.top + plotHeight, y2: pad.top + plotHeight, className: 'da-axis' }))
      elements.push(e('line', { key: 'axis-y', x1: pad.left, x2: pad.left, y1: pad.top, y2: pad.top + plotHeight, className: 'da-axis' }))
      elements.push(e('text', { key: 'x-label', x: pad.left + plotWidth / 2, y: SVG_HEIGHT - 6, textAnchor: 'middle', className: 'da-label' }, model.xLabel))
      elements.push(e('text', { key: 'y-label', x: 10, y: pad.top + plotHeight / 2, textAnchor: 'middle', className: 'da-label', transform: 'rotate(-90 10 ' + (pad.top + plotHeight / 2) + ')' }, model.yLabel))
      model.points.forEach((point, index) => {
        elements.push(e('circle', {
          key: 'point-' + index,
          cx: xScale(point.x),
          cy: yScale(point.y),
          r: 3.5,
          className: 'da-fill da-c1',
          onClick: () => onDrill({ label: point.label, raw: point.x }, model),
          style: { cursor: 'pointer' },
        }, e('title', null, t('chart.tooltip', {
          category: point.label,
          series: model.yLabel,
          value: formatNumber(point.y, t('value.null')),
        }))))
      })
      return e('svg', {
        className: 'da-svg',
        viewBox: '0 0 ' + SVG_WIDTH + ' ' + SVG_HEIGHT,
        role: 'img',
        'aria-label': t('chart.aria', { title: model.xLabel + ' / ' + model.yLabel }),
        preserveAspectRatio: 'xMidYMid meet',
      }, elements)
    }

    /**
     * Render a dataset table.
     * @param columns - Column names in display order.
     * @param rows - Row objects.
     * @param schemaByName - Column type lookup for boolean and number formatting.
     * @param t - Translate function.
     * @returns A scrollable table element.
     */
    function renderTable(columns, rows, schemaByName, t) {
      const head = e('thead', null, e('tr', null, columns.map(column => e('th', { key: column }, column))))
      const body = e('tbody', null, rows.map((row, rowIndex) => e('tr', { key: rowIndex },
        columns.map(column => {
          const entry = schemaByName.get(column)
          const value = row[column]
          let text
          if (value === null || value === undefined) text = t('value.null')
          else if (entry && entry.type === 'boolean') text = value ? t('value.true') : t('value.false')
          else if (typeof value === 'number') text = formatNumber(value, t('value.null'))
          else if (typeof value === 'object') text = JSON.stringify(value)
          else text = String(value)
          return e('td', { key: column }, text)
        }))))
      return e('div', { className: 'da-scroll' }, e('table', { className: 'da-table' }, head, body))
    }

    /**
     * Render a chart model, including its empty and error states.
     * @param props - Model, translate function, hidden series, drill and toggle handlers.
     * @returns Chart content.
     */
    function ChartBody(props) {
      const { model, t, hidden, onToggleSeries, onDrill, schema } = props
      if (model.kind === 'empty') return e('p', { className: 'da-empty' }, emptyText(model.reason, t))
      if (model.kind === 'error') return e('p', { className: 'da-error' }, model.message)
      if (model.kind === 'kpi') {
        return e('div', { className: 'da-kpi' },
          e('span', { className: 'da-kpi-value' }, formatNumber(model.value, t('value.null'))),
          e('span', { className: 'da-kpi-label' }, model.label),
          e('span', { className: 'da-note' }, t('chart.countNote', { count: model.rows })))
      }
      if (model.kind === 'table') {
        const schemaByName = new Map(schema.map(entry => [entry.name, entry]))
        return e('div', null,
          renderTable(model.columns, model.rows, schemaByName, t),
          e('p', { className: 'da-note' }, t('chart.tableNote', { count: model.total, shown: model.rows.length })))
      }
      if (model.kind === 'pie') {
        return e('div', null, renderPieChart(model, { t, onDrill }))
      }
      if (model.kind === 'scatter') {
        return e('div', null, renderScatter(model, { t, onDrill }))
      }
      return e('div', null,
        renderSeriesChart(model, { t, hidden, onDrill }),
        renderLegend(model, { t, hidden, onToggleSeries }))
    }

    /**
     * Build the read face for one tab occurrence. Reads resolve against the
     * session workspace, so only session-relative `.analysis` paths are used.
     * @param ctx - Client plugin context.
     * @param sessionId - Session that owns the workspace.
     * @returns Loaders used by the panel.
     */
    function createFace(ctx, sessionId) {
      /**
       * Read one file range through the workspace-files remote.
       * @param path - Workspace-relative path.
       * @param range - Line range.
       * @param signal - Tab lifetime signal.
       * @returns Remote result.
       */
      const readText = (path, range, signal) => ctx.remote.workspaceFiles.read(sessionId, path, range, signal)

      /**
       * Parse a JSON document from the workspace.
       * @param path - Workspace-relative path.
       * @param signal - Tab lifetime signal.
       * @returns `{ ok: true, value }` or a failure result.
       */
      const readJson = async (path, signal) => {
        const result = await readText(path, { offset: 1, limit: ROW_LIMIT }, signal)
        if (result.ok === false) return result
        try {
          return { ok: true, value: JSON.parse(result.value.text) }
        } catch {
          return { ok: false, error: { code: 'client-parse', message: '"' + path + '" is not valid JSON' } }
        }
      }

      return {
        loadIndex: signal => readJson('.analysis/datasets/_index.json', signal),
        loadCharts: signal => readJson('.analysis/charts/_index.json', signal),
        loadMeta: (datasetId, signal) => readJson('.analysis/datasets/' + datasetId + '/meta.json', signal),
        /**
         * Load the leading rows of one dataset for local aggregation.
         * @param datasetId - Dataset id from the index.
         * @param signal - Tab lifetime signal.
         * @returns `{ ok: true, value: { rows, lines, eof } }` or a failure result.
         */
        loadRows: async (datasetId, signal) => {
          const path = '.analysis/datasets/' + datasetId + '/data.ndjson'
          let result = await readText(path, { offset: 1, limit: ROW_LIMIT }, signal)
          if (result.ok === false && result.error && result.error.code === 'gateway/bad-request') {
            result = await readText(path, { offset: 1, limit: FALLBACK_ROW_LIMIT }, signal)
          }
          if (result.ok === false) return result
          const rows = []
          for (const line of result.value.text.split('\n')) {
            if (line.length === 0) continue
            try {
              rows.push(JSON.parse(line))
            } catch {
              return { ok: false, error: { code: 'client-parse', message: '"' + path + '" has a corrupt row' } }
            }
          }
          return { ok: true, value: { rows, lines: result.value.lines, eof: result.value.eof } }
        },
      }
    }

    /**
     * Right-sidebar panel listing datasets, their fields and sample rows, and a
     * local chart builder over the loaded sample.
     * @param props - Session props, translate function, and the read face.
     * @returns Panel element.
     */
    function AnalysisPanel(props) {
      const { useTabInfo, t } = props
      const { tab } = useTabInfo()
      const signal = tab.signal
      const api = React.useRef(props)
      api.current = props

      const [refreshNonce, setRefreshNonce] = React.useState(0)
      const [datasets, setDatasets] = React.useState(null)
      const [loadingList, setLoadingList] = React.useState(true)
      const [listError, setListError] = React.useState(null)
      const [selectedId, setSelectedId] = React.useState(null)
      const [meta, setMeta] = React.useState(null)
      const [loadingMeta, setLoadingMeta] = React.useState(false)
      const [metaError, setMetaError] = React.useState(null)
      const [rows, setRows] = React.useState(null)
      const [rowsNote, setRowsNote] = React.useState(null)
      const [rowsError, setRowsError] = React.useState(null)
      const [savedCharts, setSavedCharts] = React.useState([])
      const [chartsError, setChartsError] = React.useState(null)
      const [draft, setDraft] = React.useState({
        type: 'bar', dimension: '', measure: '', agg: 'sum', series: '', horizontal: false, stacked: false, showValues: false,
      })
      const [hidden, setHidden] = React.useState([])
      const [drill, setDrill] = React.useState([])
      const [mode, setMode] = React.useState('build')
      const [savedSpec, setSavedSpec] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [sort, setSort] = React.useState({ key: 'name', dir: 1 })
      const listGeneration = React.useRef(0)
      const dataGeneration = React.useRef(0)

      const errorText = error => {
        if (!error) return t('value.unknown')
        return error.message || error.code || t('value.unknown')
      }
      const isMissing = error => Boolean(error && (error.code === 'workspace-file/not-found' || error.code === 'file/not-found'))

      React.useEffect(() => {
        if (signal.aborted) return undefined
        const generation = ++listGeneration.current
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal.addEventListener('abort', abort, { once: true })
        setLoadingList(true)
        setListError(null)
        setChartsError(null)
        Promise.all([
          api.current.loadIndex(controller.signal),
          api.current.loadCharts(controller.signal),
        ]).then(([indexResult, chartsResult]) => {
          if (generation !== listGeneration.current) return
          if (indexResult.ok) {
            setDatasets(Array.isArray(indexResult.value.datasets) ? indexResult.value.datasets : [])
          } else if (isMissing(indexResult.error)) {
            setDatasets([])
          } else {
            setDatasets([])
            setListError(errorText(indexResult.error))
          }
          if (chartsResult.ok) {
            setSavedCharts(Array.isArray(chartsResult.value.charts) ? chartsResult.value.charts : [])
          } else if (isMissing(chartsResult.error)) {
            setSavedCharts([])
          } else {
            setSavedCharts([])
            setChartsError(errorText(chartsResult.error))
          }
        }).catch(cause => {
          if (generation !== listGeneration.current) return
          setDatasets([])
          setListError(String(cause && cause.message ? cause.message : cause))
        }).finally(() => {
          if (generation === listGeneration.current) setLoadingList(false)
        })
        return () => {
          controller.abort()
          signal.removeEventListener('abort', abort)
        }
      }, [refreshNonce, signal])

      React.useEffect(() => {
        if (selectedId === null || selectedId === undefined || signal.aborted) return undefined
        const generation = ++dataGeneration.current
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal.addEventListener('abort', abort, { once: true })
        setLoadingMeta(true)
        setMeta(null)
        setMetaError(null)
        setRows(null)
        setRowsNote(null)
        setRowsError(null)
        Promise.all([
          api.current.loadMeta(selectedId, controller.signal),
          api.current.loadRows(selectedId, controller.signal),
        ]).then(([metaResult, rowsResult]) => {
          if (generation !== dataGeneration.current) return
          if (metaResult.ok) {
            const value = metaResult.value
            setMeta(value)
            const schema = Array.isArray(value.schema) ? value.schema : []
            const dimensions = schema.filter(entry => !isNumericType(entry.type)).filter(entry => !isIdentifierLike(entry.name))
            const measures = schema.filter(entry => isNumericType(entry.type)).filter(entry => !isIdentifierLike(entry.name))
            const dimension = (dimensions[0] || schema.find(entry => !isNumericType(entry.type)) || { name: '' }).name
            const measure = (measures[0] || schema.find(entry => isNumericType(entry.type)) || { name: '' }).name
            const firstDimension = dimensions[0] || schema.find(entry => !isNumericType(entry.type))
            const isTime = firstDimension && (firstDimension.type === 'date' || firstDimension.type === 'datetime')
            setDraft({
              type: isTime ? 'line' : 'bar',
              dimension,
              measure,
              agg: 'sum',
              series: '',
              horizontal: false,
              stacked: false,
              showValues: false,
            })
            setHidden([])
            setDrill([])
            setQuery('')
          } else {
            setMetaError(errorText(metaResult.error))
          }
          if (rowsResult.ok) {
            setRows(rowsResult.value.rows)
            setRowsNote({ lines: rowsResult.value.lines, eof: rowsResult.value.eof })
          } else {
            setRowsError(errorText(rowsResult.error))
          }
        }).catch(cause => {
          if (generation !== dataGeneration.current) return
          setMetaError(String(cause && cause.message ? cause.message : cause))
        }).finally(() => {
          if (generation === dataGeneration.current) setLoadingMeta(false)
        })
        return () => {
          controller.abort()
          signal.removeEventListener('abort', abort)
        }
      }, [selectedId, refreshNonce, signal])

      const schema = meta && Array.isArray(meta.schema) ? meta.schema : []
      const schemaByName = new Map(schema.map(entry => [entry.name, entry]))
      const measureFields = schema.filter(entry => isNumericType(entry.type))
      const dimensionFields = schema.filter(entry => !isNumericType(entry.type))

      const fields = React.useMemo(() => {
        const nullRates = meta && meta.stats && meta.stats.nullRateByColumn ? meta.stats.nullRateByColumn : {}
        const distinctCounts = meta && meta.stats && meta.stats.distinctByColumn ? meta.stats.distinctByColumn : {}
        const entries = schema.map(entry => ({
          ...entry,
          nullRate: typeof nullRates[entry.name] === 'number' ? nullRates[entry.name] : null,
          distinct: typeof distinctCounts[entry.name] === 'number' ? distinctCounts[entry.name] : null,
        }))
        const needle = query.trim().toLowerCase()
        const filtered = needle === '' ? entries : entries.filter(entry => entry.name.toLowerCase().includes(needle))
        const direction = sort.dir
        filtered.sort((left, right) => {
          const key = sort.key
          const a = left[key]
          const b = right[key]
          if (a === null || a === undefined) return 1
          if (b === null || b === undefined) return -1
          if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction
          return String(a).localeCompare(String(b), numberLocale()) * direction
        })
        return filtered
      }, [meta, query, sort, schema])

      const spec = mode === 'saved' && savedSpec ? savedSpec : draftSpec(draft)
      const specKey = JSON.stringify(spec)
      const model = React.useMemo(() => {
        if (meta === null || rows === null) return null
        try {
          return computeChart(spec, rows, schema, t)
        } catch (cause) {
          return { kind: 'error', message: String(cause && cause.message ? cause.message : cause) }
        }
      }, [specKey, rows, meta, schema, t])

      const toggleSeries = name => {
        setHidden(current => current.indexOf(name) < 0
          ? current.concat([name])
          : current.filter(item => item !== name))
      }

      const addDrill = (category, chartModel) => {
        const isTime = chartModel.xType === 'date' || chartModel.xType === 'datetime'
        const filter = category.raw === null || category.raw === undefined
          ? { field: chartModel.xField, op: 'isNull' }
          : isTime
            ? { field: chartModel.xField, op: 'startsWith', value: category.label }
            : { field: chartModel.xField, op: 'in', value: [category.raw] }
        setDrill(current => current.some(item => JSON.stringify(item) === JSON.stringify(filter))
          ? current
          : current.concat([filter]))
      }

      const chartTitle = mode === 'saved' && savedSpec
        ? savedSpec.name || t('chartType.' + savedSpec.type)
        : t('chartType.' + draft.type) + (draft.dimension ? ' · ' + draft.dimension : '')

      const savedDatasetName = datasetId => {
        const found = (datasets || []).find(dataset => dataset.id === datasetId)
        return found ? found.name : datasetId
      }

      const datasetHint = item => t('list.rows', { count: item.rowCount }) + ' · ' + t('list.columns', { count: item.columnCount })

      const chartTypeOptions = ['bar', 'line', 'area', 'pie', 'scatter', 'kpi', 'table']
      const aggregateOptions = ['sum', 'avg', 'min', 'max', 'count', 'countDistinct', 'p50', 'p95']
      const changeType = type => {
        setMode('build')
        setDraft(previous => {
          if (type === 'scatter') {
            return {
              ...previous,
              type,
              dimension: measureFields[0] ? measureFields[0].name : '',
              measure: measureFields[1] ? measureFields[1].name : measureFields[0] ? measureFields[0].name : '',
              series: '',
            }
          }
          if (type === 'kpi' || type === 'table') return { ...previous, type, series: '' }
          const keep = dimensionFields.some(entry => entry.name === previous.dimension)
          return {
            ...previous,
            type,
            dimension: keep ? previous.dimension : dimensionFields[0] ? dimensionFields[0].name : '',
          }
        })
      }

      const header = e('div', { className: 'da-head' },
        e('h3', { className: 'da-title' }, t('list.title')),
        e('button', {
          type: 'button',
          className: 'da-button',
          onClick: () => setRefreshNonce(value => value + 1),
        }, t('action.refresh')))

      const datasetList = e('div', { className: 'da-list' },
        (datasets || []).map(item => e('button', {
          key: item.id,
          type: 'button',
          className: 'da-list-item',
          'data-selected': item.id === selectedId ? 'true' : 'false',
          onClick: () => {
            setSelectedId(item.id)
            setMode('build')
            setSavedSpec(null)
          },
        },
        e('span', { className: 'da-item-name' }, item.name || item.id),
        e('span', { className: 'da-meta' }, datasetHint(item)))))

      const overview = meta
        ? e('div', { className: 'da-section' },
          e('div', { className: 'da-head' },
            e('h4', { className: 'da-title' }, t('section.overview')),
            e('span', { className: 'da-meta' }, t('label.version', { version: meta.version }))),
          e('span', { className: 'da-meta' }, datasetHint(meta)),
          e('span', { className: 'da-meta' }, t('label.source', { kind: meta.source && meta.source.kind ? meta.source.kind : 'unknown' })),
          e('span', { className: 'da-meta' }, t('label.updated', { time: formatTime(meta.updatedAt, t('value.unknown')) })))
        : null

      const fieldColumns = [
        { key: 'name', label: t('field.name') },
        { key: 'type', label: t('field.type') },
        { key: 'role', label: t('field.role') },
        { key: 'nullRate', label: t('field.nullRate') },
        { key: 'distinct', label: t('field.distinct') },
      ]
      const fieldHead = e('thead', null, e('tr', null, fieldColumns.map(column => e('th', { key: column.key },
        e('button', {
          type: 'button',
          onClick: () => setSort(current => current.key === column.key
            ? { key: column.key, dir: current.dir * -1 }
            : { key: column.key, dir: 1 }),
        }, column.label + (sort.key === column.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''))))))
      const fieldRows = fields.map(entry => e('tr', { key: entry.name },
        e('td', null, entry.name),
        e('td', null, t('type.' + entry.type)),
        e('td', null, t('role.' + entry.role)),
        e('td', null, entry.nullRate === null ? t('value.unknown') : Math.round(entry.nullRate * 1000) / 10 + '%'),
        e('td', null, entry.distinct === null ? t('value.unknown') : String(entry.distinct))))

      const fieldSection = meta
        ? e('div', { className: 'da-section' },
          e('div', { className: 'da-head' },
            e('h4', { className: 'da-title' }, t('section.fields')),
            e('span', { className: 'da-meta' }, t('list.columns', { count: schema.length }))),
          e('input', {
            className: 'da-input',
            type: 'search',
            value: query,
            placeholder: t('field.search'),
            'aria-label': t('field.search'),
            onChange: event => setQuery(event.target.value),
          }),
          e('div', { className: 'da-scroll', style: { maxHeight: '180px' } },
            e('table', { className: 'da-table' }, fieldHead, e('tbody', null, fieldRows))))
        : null

      const derivedSection = meta
        ? e('div', { className: 'da-section' },
          e('div', { className: 'da-head' }, e('h4', { className: 'da-title' }, t('section.derived'))),
          Array.isArray(meta.derived) && meta.derived.length > 0
            ? e('div', { className: 'da-list' }, meta.derived.map(field => e('div', { key: field.name, className: 'da-meta' },
              e('div', { className: 'da-item-name' }, field.name),
              e('div', null, t('derived.expression') + ': ' + field.expression))))
            : e('p', { className: 'da-note' }, t('derived.empty')))
        : null

      const previewSection = meta
        ? e('div', { className: 'da-section' },
          e('div', { className: 'da-head' },
            e('h4', { className: 'da-title' }, t('section.preview')),
            rowsNote ? e('span', { className: 'da-meta' }, t('preview.note', { count: rowsNote.lines })) : null),
          rows === null
            ? e('p', { className: 'da-note' }, loadingMeta ? t('state.loading') : rowsError || '')
            : renderTable(meta.schema.slice(0, 30).map(entry => entry.name), rows.slice(0, 8), schemaByName, t))
        : null

      const builderSection = meta
        ? e('div', { className: 'da-section' },
          e('div', { className: 'da-head' },
            e('h4', { className: 'da-title' }, t('section.chart')),
            mode === 'saved'
              ? e('button', { type: 'button', className: 'da-button', onClick: () => setMode('build') }, t('chart.backToBuild'))
              : null),
          mode === 'saved'
            ? e('p', { className: 'da-note' }, t('chart.savedNote'))
            : e('div', null,
              e('div', { className: 'da-row' },
                e('label', { className: 'da-field' },
                  e('span', { className: 'da-field-label' }, t('chart.type')),
                  e('select', {
                    className: 'da-select',
                    value: draft.type,
                    onChange: event => changeType(event.target.value),
                  }, chartTypeOptions.map(type => e('option', { key: type, value: type }, t('chartType.' + type))))),
                draft.type === 'table'
                  ? null
                  : e('label', { className: 'da-field' },
                    e('span', { className: 'da-field-label' }, t('chart.dimension')),
                    e('select', {
                      className: 'da-select',
                      value: draft.dimension,
                      disabled: draft.type === 'kpi',
                      onChange: event => setDraft({ ...draft, dimension: event.target.value }),
                    }, (draft.type === 'scatter' ? measureFields : dimensionFields).map(entry =>
                      e('option', { key: entry.name, value: entry.name }, entry.name)))),
                draft.type === 'table'
                  ? null
                  : e('label', { className: 'da-field' },
                    e('span', { className: 'da-field-label' }, t('chart.measure')),
                    e('select', {
                      className: 'da-select',
                      value: draft.measure,
                      onChange: event => setDraft({ ...draft, measure: event.target.value }),
                    }, measureFields.map(entry => e('option', { key: entry.name, value: entry.name }, entry.name))))),
              draft.type === 'table'
                ? null
                : e('div', { className: 'da-row' },
                  e('label', { className: 'da-field' },
                    e('span', { className: 'da-field-label' }, t('chart.aggregate')),
                    e('select', {
                      className: 'da-select',
                      value: draft.agg,
                      disabled: draft.type === 'scatter',
                      onChange: event => setDraft({ ...draft, agg: event.target.value }),
                    }, aggregateOptions.map(agg => e('option', { key: agg, value: agg }, t('agg.' + agg))))),
                  draft.type === 'bar' || draft.type === 'line' || draft.type === 'area'
                    ? e('label', { className: 'da-field' },
                      e('span', { className: 'da-field-label' }, t('chart.series')),
                      e('select', {
                        className: 'da-select',
                        value: draft.series,
                        onChange: event => setDraft({ ...draft, series: event.target.value }),
                      }, e('option', { value: '' }, t('chart.seriesNone')),
                      dimensionFields.filter(entry => entry.name !== draft.dimension).map(entry =>
                        e('option', { key: entry.name, value: entry.name }, entry.name))))
                    : null),
              draft.type === 'bar'
                ? e('div', { className: 'da-row' },
                  e('label', { className: 'da-check' },
                    e('input', {
                      type: 'checkbox',
                      checked: draft.horizontal,
                      onChange: event => setDraft({ ...draft, horizontal: event.target.checked }),
                    }),
                    t('chart.horizontal')),
                  e('label', { className: 'da-check' },
                    e('input', {
                      type: 'checkbox',
                      checked: draft.stacked,
                      onChange: event => setDraft({ ...draft, stacked: event.target.checked }),
                    }),
                    t('chart.stacked')))
                : null,
              ['bar', 'line', 'area'].indexOf(draft.type) >= 0
                ? e('label', { className: 'da-check' },
                  e('input', {
                    type: 'checkbox',
                    checked: draft.showValues,
                    onChange: event => setDraft({ ...draft, showValues: event.target.checked }),
                  }),
                  t('chart.showValues'))
                : null),
          model === null
            ? e('p', { className: 'da-empty' }, rowsError || t('state.loading'))
            : e('div', null,
              e('div', { className: 'da-head' },
                e('h5', { className: 'da-title' }, chartTitle),
                mode === 'build'
                  ? e('span', { className: 'da-meta' }, t('chart.countNote', { count: model.rows !== undefined ? model.rows : model.total || 0 }))
                  : null),
              e(ChartBody, {
                model,
                t,
                hidden,
                onToggleSeries: toggleSeries,
                onDrill: addDrill,
                schema,
              }),
              drill.length > 0
                ? e('div', { className: 'da-row' },
                  drill.map((filter, index) => {
                    const chipValue = filter.op === 'isNull'
                      ? t('value.null')
                      : truncate(String(Array.isArray(filter.value) ? filter.value[0] : filter.value), 20)
                    return e('span', { key: index, className: 'da-chip' },
                      t('chart.chip', { field: filter.field, value: chipValue }),
                      e('button', {
                        type: 'button',
                        'aria-label': t('chart.removeChip', { field: filter.field, value: chipValue }),
                        onClick: () => setDrill(current => current.filter((_, position) => position !== index)),
                      }, '×'))
                  }),
                  e('span', { className: 'da-note' }, t('chart.drillNote')))
                : null,
              rowsNote && rowsNote.eof === false
                ? e('p', { className: 'da-note' }, t('chart.cappedNote', { count: rowsNote.lines }))
                : null))
        : null

      const savedSection = e('div', { className: 'da-section' },
        e('div', { className: 'da-head' }, e('h4', { className: 'da-title' }, t('section.saved'))),
        chartsError ? e('p', { className: 'da-error' }, t('state.loadError', { message: chartsError })) : null,
        savedCharts.length === 0
          ? e('p', { className: 'da-note' }, t('chart.savedEmpty'))
          : e('div', { className: 'da-list' }, savedCharts.map(chart => e('div', {
            key: chart.id,
            className: 'da-row',
            style: { justifyContent: 'space-between' },
          },
          e('div', null,
            e('div', { className: 'da-item-name' }, chart.name || chart.id),
            e('div', { className: 'da-meta' }, t('chartType.' + chart.type) + ' · ' + savedDatasetName(chart.datasetId) + ' · ' + t('chart.created', { time: formatTime(chart.createdAt, t('value.unknown')) }))),
          e('button', {
            type: 'button',
            className: 'da-button',
            onClick: () => {
              setSavedSpec(chart)
              setMode('saved')
              if (chart.datasetId !== undefined && chart.datasetId !== null) setSelectedId(chart.datasetId)
              setHidden([])
              setDrill([])
            },
          }, t('chart.savedPreview'))))))

      const body = e('div', { className: 'da-root' },
        e('div', { className: 'da-section' }, header,
          loadingList
            ? e('p', { className: 'da-note' }, t('state.loading'))
            : listError
              ? e('p', { className: 'da-error' }, t('state.loadError', { message: listError }))
              : (datasets || []).length === 0
                ? e('p', { className: 'da-note' }, t('list.empty'))
                : datasetList),
        selectedId === null || selectedId === undefined
          ? (loadingList ? null : e('p', { className: 'da-empty' }, t('state.select')))
          : null,
        metaError ? e('div', { className: 'da-section' }, e('p', { className: 'da-error' }, t('state.loadError', { message: metaError }))) : null,
        overview,
        fieldSection,
        derivedSection,
        previewSection,
        builderSection,
        savedSection)

      return body
    }

    /**
     * Read the Session shown in the main column and rerender when it changes.
     * @param ctx - Client plugin context.
     * @returns Current Session id, or undefined when the column shows no Session.
     */
    function useCurrentSessionId(ctx) {
      const source = ctx.uiSession.adapter.current
      const subscribe = React.useCallback(listener => source.subscribe(listener), [source])
      const getSnapshot = React.useCallback(() => source.getSnapshot().key, [source])
      return React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /**
     * Left-sidebar workbench page: the analysis panel over the Session on
     * screen, so the feature is reachable without opening the right sidebar.
     * @param props - Standard props plus the Client plugin context.
     * @returns Page element.
     */
    function AnalysisPage(props) {
      const { ctx, t } = props
      const sessionId = useCurrentSessionId(ctx)
      const controller = React.useMemo(() => new AbortController(), [sessionId])
      React.useEffect(() => () => controller.abort(), [controller])
      const face = React.useMemo(
        () => (sessionId === undefined ? null : createFace(ctx, sessionId)),
        [ctx, sessionId])
      const useTabInfo = React.useCallback(() => ({ tab: { signal: controller.signal } }), [controller])
      return e('div', { className: 'da-page' },
        e('div', { className: 'da-page-head' },
          e('button', {
            type: 'button',
            className: 'da-page-back',
            onClick: () => { ctx.layout.selectPanel('conversation') },
          }, t('page.back')),
          e('h1', { className: 'da-page-title' }, t('tab.title'))),
        sessionId === undefined || face === null
          ? e('p', { className: 'da-empty' }, t('page.noSession'))
          : e('div', { className: 'da-page-body' },
            e(AnalysisPanel, { ...props, ...face, useTabInfo })))
    }

    const inject = ['slots', 'locale', 'layout', 'uiSession', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.workspaceFiles']

    /**
     * Register the dictionaries, the left-sidebar page, the right-sidebar tab
     * type, and its body.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-data-analysis: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, props => e(AnalysisPage, { ...props, ctx }))), 'dsh-data-analysis: workbench page')

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        locale: NS,
        label: () => t('tab.title'),
      }, GuideArtwork)), 'dsh-data-analysis: sidebar row')

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: () => t('tab.title'),
        guide: [{
          id: 'open',
          order: 30,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
          icon: GuideArtwork,
        }],
      }), 'dsh-data-analysis: tab type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
        inject: sessionId => createFace(ctx, sessionId),
      }, AnalysisPanel)), 'dsh-data-analysis: tab body')

      injectStyles(ctx)
    }

    const plugin = { inject, apply }
    if (typeof window !== 'undefined' && window.__DSH_DATA_ANALYSIS_TEST__ === true) {
      plugin.__test = {
        dictionaries: { zh, en },
        computeChart,
        draftSpec,
        niceTicks,
        passesFilter,
        passesFilters,
        measureLabel,
        categoryLabel,
        formatNumber,
        ChartBody,
      }
    }
    return plugin
  },
})
