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
    /** Host route this plugin's workbench API answers on. */
    const API_BASE = '/plugins/data-analysis/api'
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
      'err.network': '无法连接数据分析服务，请确认 Host 仍在运行。',
      'err.unauthorized': '登录状态已失效，请重新登录后再试。',
      'err.badResponse': '数据分析服务返回了无法解析的内容。',
      'err.refused': '数据分析服务拒绝了该请求。',
      'err.noWorkspace': '无法确定这次分析的存放位置：重新打开这个对话后再试。',
      'action.refresh': '刷新',
      'action.import': '导入文件',
      'action.importSheets': '导入 {count} 个工作表',
      'action.database': '数据库',
      'action.api': 'REST API',
      'action.ai': '用 AI 分析',
      'action.close': '关闭',
      'action.cancel': '取消',
      'action.test': '测试连接',
      'action.importTable': '导入这张表',
      'action.preview': '预览数据',
      'action.upload': '选择文件…',
      'action.saveChart': '保存图表',
      'action.save': '保存',
      'app.tagline': '数据集 · 图表 · AI 分析',
      'label.dataset': '数据集',
      'nav.datasets': '数据集',
      'nav.charts': '图表库',
      'nav.sources': '数据源',
      'nav.searchDatasets': '搜索数据集',
      'nav.newConnection': '新建连接',
      'rail.emptyCharts': '保存的图表会出现在这里。',
      'rail.emptySources': '还没有数据库连接或接口。',
      'rail.detached': '此对话没有文件夹，数据集保存在它的会话空间里。',
      'view.rows': '数据预览',
      'view.fields': '字段结构',
      'view.derived': '派生字段',
      'stat.rows': '行数',
      'stat.columns': '列数',
      'stat.measures': '数值字段',
      'stat.nullRate': '平均缺失',
      'config.title': '图表配置',
      'config.encoding': '数据映射',
      'config.style': '展示选项',
      'config.reset': '重置',
      'config.pickField': '点击下方字段可快速替换维度或指标。',
      'config.noDataset': '先选择一个数据集。',
      'chart.saveCreated': '已保存到图表库：{name}',
      'empty.title': '从一个数据集开始',
      'empty.body': '导入 CSV / Excel、连接数据库，或对接 REST API；数据会落在当前工作区的 .analysis 目录。',
      'empty.bodyDetached': '导入 CSV / Excel、连接数据库，或对接 REST API；这个对话没有文件夹，数据会保存在它自己的会话空间。',
      'empty.pick': '选择一个数据集',
      'empty.pickBody': '左侧已有 {count} 个数据集，选中一个就能看到图表、字段与样本；也可以继续导入新数据。',
      'empty.aiHint': '选好数据集后，可以让 AI 读取同一份数据并给出结论。',
      'state.noDataset': '未选择数据集',
      'dialog.file.title': '导入 CSV / Excel',
      'dialog.file.hint': '文件需在会话工作区内（填相对路径），或直接选择本地文件上传。',
      'dialog.file.path': '工作区相对路径',
      'dialog.file.name': '数据集名称（可选）',
      'dialog.file.sheets': '工作表',
      'dialog.file.sheetsHint': 'Excel 工作簿可以一次选多个工作表，每个工作表生成一个独立的数据集。',
      'dialog.file.sheetsCount': '共 {total} 个工作表 · 已选 {picked} 个',
      'dialog.file.sheetAll': '全选',
      'dialog.file.sheetNone': '清空',
      'dialog.file.sheetRows': '{rows} 行 · {columns} 列',
      'dialog.file.sheetHeader': '首行：{header}',
      'dialog.file.sheetEmpty': '空工作表',
      'dialog.file.loadSheets': '读取工作表',
      'dialog.file.reading': '正在读取工作表…',
      'dialog.file.sheetRequired': '至少选择一个工作表。',
      'dialog.file.noSheets': '这个文件没有工作表，直接导入即可。',
      'dialog.file.partial': '已导入 {done} 个，{failed} 个失败：{sheets}',
      'dialog.file.uploaded': '已上传：{path}',
      'dialog.db.title': '数据库连接',
      'dialog.db.kind': '类型',
      'dialog.db.host': '主机地址',
      'dialog.db.port': '端口',
      'dialog.db.user': '用户名',
      'dialog.db.password': '密码',
      'dialog.db.database': '数据库名称',
      'dialog.db.ssl': '加密连接',
      'dialog.db.sslOff': '不加密',
      'dialog.db.sslOn': '要求 TLS',
      'dialog.db.namePlaceholder': '例如：生产订单库',
      'dialog.db.keepSecret': '已保存，留空不修改',
      'dialog.db.secretHint': '密码只写入当前工作区的 .analysis/config.json，不会回传到浏览器。',
      'dialog.db.show': '显示',
      'dialog.db.hide': '隐藏',
      'dialog.db.showPassword': '显示密码',
      'dialog.db.hidePassword': '隐藏密码',
      'dialog.db.advanced': '高级：使用连接串或环境变量',
      'dialog.db.pathHint': '路径相对会话工作区，文件需已存在。',
      'dialog.db.path': 'SQLite 文件路径（相对工作区）',
      'dialog.db.url': '连接串',
      'dialog.db.urlEnv': '或填写保存连接串的环境变量名',
      'dialog.db.urlHint': '留空则按上面的主机、端口、用户名和数据库名拼接。',
      'dialog.db.envHint': '环境变量优先于表单字段，适合不把密码写进配置文件。',
      'dialog.db.label': '显示名（可选）',
      'dialog.db.saved': '连接已保存：{id}',
      'dialog.db.testOk': '连接成功 · {kind} · {ms} ms',
      'dialog.db.testing': '正在连接…',
      'dialog.db.saveAndList': '保存并读取表结构',
      'dialog.db.tables': '选择要导入的表',
      'dialog.db.empty': '这个连接没有可导入的表或视图。',
      'dialog.db.savedList': '已保存的连接',
      'dialog.db.pickTable': '点一张表查看字段，再导入为数据集。',
      'dialog.db.tableName': '数据集名称',
      'dialog.db.columns': '字段（{count}）',
      'dialog.db.columnsEmpty': '正在读取字段…',
      'dialog.db.columnsFailed': '字段读取失败，仍可以直接导入。',
      'dialog.db.importAs': '导入为数据集',
      'menu.newDataset': '新建数据集',
      'menu.fromFile': '从文件导入',
      'menu.fromDatabase': '从数据库读取',
      'menu.fromApi': '从接口读取',
      'dialog.api.title': 'REST API 数据源',
      'dialog.api.name': '名称',
      'dialog.api.baseUrl': '基础地址，如 https://api.example.com',
      'dialog.api.allowed': '允许的主机（逗号分隔，默认取基础地址）',
      'dialog.api.path': '接口路径，如 /v1/orders',
      'dialog.api.recordsPath': '记录数组所在路径，如 data.items',
      'dialog.api.saved': '数据源已保存：{id}',
      'chart.save': '保存这张图',
      'chart.savedOk': '已保存为 {name}',
      'ai.needDataset': '请先选择一个数据集。',
      'ai.noBridge': '已切换到对话页，正在把分析指令放进输入框。',
      'ai.title': '用 AI 分析',
      'ai.subtitle': '把选中的数据集交给对话，按下面的提示词给出结论。',
      'ai.dataset': '数据集',
      'ai.datasetHint': '已选 {picked} / 共 {total} 个，可多选',
      'ai.datasetNone': '至少选一个数据集。',
      'ai.datasetMultiHint': '多选时提示词会先要求 AI 说明表间关联键，再做合并口径分析。',
      'ai.loadFailed': '字段信息读取失败',
      'ai.ready': '已就绪',
      'ai.fieldCount': '{count} 个字段',
      'ai.focus': '分析重点',
      'ai.focusHint': '可多选，决定提示词里追问的方向。',
      'ai.focus.overview': '整体概览',
      'ai.focus.overview.hint': '规模、缺失、主要构成',
      'ai.focus.trend': '趋势变化',
      'ai.focus.trend.hint': '随时间走高走低、环比',
      'ai.focus.anomaly': '异常离群',
      'ai.focus.anomaly.hint': '离群点、突变、可疑记录',
      'ai.focus.compare': '分组对比',
      'ai.focus.compare.hint': '不同维度之间的差距',
      'ai.focus.correlation': '相关与驱动',
      'ai.focus.correlation.hint': '哪些字段影响指标',
      'ai.focus.forecast': '预测与建议',
      'ai.focus.forecast.hint': '后续走向与可执行动作',
      'ai.note': '补充说明',
      'ai.notePlaceholder': '例如：只看华东区近 30 天，并与上月对比',
      'ai.brief': '将要发送的提示词',
      'ai.briefShow': '展开',
      'ai.briefHide': '收起',
      'ai.cancel': '取消',
      'ai.send': '交给 AI 分析',
      'ai.sendMulti': '交给 AI 分析（{count} 个数据集）',
      'ai.footNote': '分析在对话里完成，数据集仍留在本工作区。',
      'ai.footNoteMulti': '{count} 个数据集会一起进入对话，数据仍留在本工作区。',
      'ai.focusNone': '至少选一个分析重点。',
      'state.working': '处理中…',
      'list.title': '数据集',
      'list.empty': '还没有数据集，先导入一个。',
      'list.rows': '{count} 行',
      'list.columns': '{count} 列',
      'state.loading': '正在载入…',
      'state.loadError': '加载失败：{message}',
      'state.select': '从左侧选择一个数据集查看图表与字段。',
      'section.overview': '概览',
      'section.fields': '字段',
      'section.derived': '计算字段',
      'section.preview': '数据预览',
      'section.saved': '已保存图表',
      'section.chart': '图表',
      'label.source': '来源 {kind}',
      'sourceKind.file': '文件',
      'sourceKind.database': '数据库',
      'sourceKind.api': '接口',
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
      'err.network': 'Cannot reach the analysis service. Check that the Host is still running.',
      'err.unauthorized': 'Your session expired. Sign in again to continue.',
      'err.badResponse': 'The analysis service returned a reply this page cannot read.',
      'err.refused': 'The analysis service refused the request.',
      'err.noWorkspace': 'This page cannot tell where to keep the analysis: reopen the conversation and try again.',
      'action.refresh': 'Refresh',
      'action.import': 'Import file',
      'action.importSheets': 'Import {count} worksheets',
      'action.database': 'Database',
      'action.api': 'REST source',
      'action.ai': 'Analyze with AI',
      'action.close': 'Close',
      'action.cancel': 'Cancel',
      'action.test': 'Test connection',
      'action.importTable': 'Import this table',
      'action.preview': 'Preview data',
      'action.upload': 'Choose file…',
      'action.saveChart': 'Save chart',
      'action.save': 'Save',
      'app.tagline': 'Datasets · charts · AI analysis',
      'label.dataset': 'Dataset',
      'nav.datasets': 'Datasets',
      'nav.charts': 'Chart library',
      'nav.sources': 'Data sources',
      'nav.searchDatasets': 'Search datasets',
      'nav.newConnection': 'New connection',
      'rail.emptyCharts': 'Saved charts show up here.',
      'rail.emptySources': 'No connections or sources yet.',
      'rail.detached': 'This conversation has no folder, so its datasets live in its own session space.',
      'view.rows': 'Preview',
      'view.fields': 'Fields',
      'view.derived': 'Derived',
      'stat.rows': 'Rows',
      'stat.columns': 'Columns',
      'stat.measures': 'Numeric fields',
      'stat.nullRate': 'Null rate',
      'config.title': 'Chart settings',
      'config.encoding': 'Encoding',
      'config.style': 'Display',
      'config.reset': 'Reset',
      'config.pickField': 'Click a field below to swap the dimension or measure.',
      'config.noDataset': 'Select a dataset first.',
      'chart.saveCreated': 'Saved to the library: {name}',
      'empty.title': 'Start from a dataset',
      'empty.body': 'Import a CSV or Excel file, connect a database, or point at a REST API. Data lands in .analysis inside this workspace.',
      'empty.bodyDetached': 'Import a CSV or Excel file, connect a database, or point at a REST API. This conversation has no folder, so data is kept in its own session space.',
      'empty.pick': 'Pick a dataset',
      'empty.pickBody': 'The rail already holds {count} dataset(s). Pick one to see its chart, fields, and sample rows, or import more.',
      'empty.aiHint': 'Once a dataset is selected, the model can read the same rows and summarize them.',
      'state.noDataset': 'No dataset selected',
      'dialog.file.title': 'Import CSV / Excel',
      'dialog.file.hint': 'The file must sit inside the session workspace (relative path), or upload a local file instead.',
      'dialog.file.path': 'Workspace-relative path',
      'dialog.file.name': 'Dataset name (optional)',
      'dialog.file.sheets': 'Worksheets',
      'dialog.file.sheetsHint': 'An Excel workbook can bring several worksheets at once; each one becomes its own dataset.',
      'dialog.file.sheetsCount': '{total} worksheets · {picked} picked',
      'dialog.file.sheetAll': 'Select all',
      'dialog.file.sheetNone': 'Clear',
      'dialog.file.sheetRows': '{rows} rows · {columns} cols',
      'dialog.file.sheetHeader': 'First row: {header}',
      'dialog.file.sheetEmpty': 'No rows',
      'dialog.file.loadSheets': 'Read worksheets',
      'dialog.file.reading': 'Reading worksheets…',
      'dialog.file.sheetRequired': 'Pick at least one worksheet.',
      'dialog.file.noSheets': 'This file has no worksheets — import it directly.',
      'dialog.file.partial': 'Imported {done}; {failed} failed: {sheets}',
      'dialog.file.uploaded': 'Uploaded: {path}',
      'dialog.db.title': 'Database connection',
      'dialog.db.kind': 'Kind',
      'dialog.db.host': 'Host',
      'dialog.db.port': 'Port',
      'dialog.db.user': 'User name',
      'dialog.db.password': 'Password',
      'dialog.db.database': 'Database name',
      'dialog.db.ssl': 'Encryption',
      'dialog.db.sslOff': 'No TLS',
      'dialog.db.sslOn': 'Require TLS',
      'dialog.db.namePlaceholder': 'e.g. Production orders',
      'dialog.db.keepSecret': 'Stored — leave blank to keep',
      'dialog.db.secretHint': 'The password is written only to .analysis/config.json in this workspace and is never sent back to the browser.',
      'dialog.db.show': 'Show',
      'dialog.db.hide': 'Hide',
      'dialog.db.showPassword': 'Show password',
      'dialog.db.hidePassword': 'Hide password',
      'dialog.db.advanced': 'Advanced: connection string or environment variable',
      'dialog.db.pathHint': 'Relative to the session workspace; the file must already exist.',
      'dialog.db.path': 'SQLite file path (relative to the workspace)',
      'dialog.db.url': 'Connection string',
      'dialog.db.urlEnv': 'Or the environment variable holding that URL',
      'dialog.db.urlHint': 'Leave blank to build it from the host, port, user, and database above.',
      'dialog.db.envHint': 'The variable wins over the form fields, which keeps secrets out of the config file.',
      'dialog.db.label': 'Display name (optional)',
      'dialog.db.saved': 'Saved connection: {id}',
      'dialog.db.testOk': 'Connected · {kind} · {ms} ms',
      'dialog.db.testing': 'Connecting…',
      'dialog.db.saveAndList': 'Save and list tables',
      'dialog.db.tables': 'Pick a table to import',
      'dialog.db.empty': 'This connection exposes no tables or views to import.',
      'dialog.db.savedList': 'Saved connections',
      'dialog.db.pickTable': 'Pick a table to see its columns, then import it as a dataset.',
      'dialog.db.tableName': 'Dataset name',
      'dialog.db.columns': 'Columns ({count})',
      'dialog.db.columnsEmpty': 'Reading columns…',
      'dialog.db.columnsFailed': 'Reading columns failed; the table can still be imported.',
      'dialog.db.importAs': 'Import as dataset',
      'menu.newDataset': 'New dataset',
      'menu.fromFile': 'From a file',
      'menu.fromDatabase': 'From a database',
      'menu.fromApi': 'From an API',
      'dialog.api.title': 'REST API source',
      'dialog.api.name': 'Name',
      'dialog.api.baseUrl': 'Base URL, e.g. https://api.example.com',
      'dialog.api.allowed': 'Allowed hosts (comma separated; defaults to the base host)',
      'dialog.api.path': 'Path, e.g. /v1/orders',
      'dialog.api.recordsPath': 'Path of the record array, e.g. data.items',
      'dialog.api.saved': 'Saved source: {id}',
      'chart.save': 'Save this chart',
      'chart.savedOk': 'Saved as {name}',
      'ai.needDataset': 'Pick a dataset first.',
      'ai.noBridge': 'Switched to the conversation; the analysis brief is going into the composer.',
      'ai.title': 'Analyze with AI',
      'ai.subtitle': 'Hand the picked datasets to the conversation with a prepared brief.',
      'ai.dataset': 'Datasets',
      'ai.datasetHint': '{picked} of {total} picked; pick any number',
      'ai.datasetNone': 'Pick at least one dataset.',
      'ai.datasetMultiHint': 'With more than one, the brief asks the model to state the join keys before combining figures.',
      'ai.loadFailed': 'Could not read the fields',
      'ai.ready': 'Ready',
      'ai.fieldCount': '{count} fields',
      'ai.focus': 'Focus areas',
      'ai.focusHint': 'Pick any number; each one shapes the brief.',
      'ai.focus.overview': 'Overview',
      'ai.focus.overview.hint': 'Shape, gaps, composition',
      'ai.focus.trend': 'Trend',
      'ai.focus.trend.hint': 'Movement over time, period over period',
      'ai.focus.anomaly': 'Anomalies',
      'ai.focus.anomaly.hint': 'Outliers, spikes, suspect rows',
      'ai.focus.compare': 'Comparison',
      'ai.focus.compare.hint': 'Gaps between segments',
      'ai.focus.correlation': 'Drivers',
      'ai.focus.correlation.hint': 'Which fields move the metric',
      'ai.focus.forecast': 'Outlook',
      'ai.focus.forecast.hint': 'Where it goes next, what to do',
      'ai.note': 'Extra context',
      'ai.notePlaceholder': 'e.g. East region only, last 30 days, versus last month',
      'ai.brief': 'Brief to be sent',
      'ai.briefShow': 'Expand',
      'ai.briefHide': 'Collapse',
      'ai.cancel': 'Cancel',
      'ai.send': 'Send to AI',
      'ai.sendMulti': 'Send {count} datasets to AI',
      'ai.footNote': 'The analysis runs in the conversation; the dataset stays in this workspace.',
      'ai.footNoteMulti': 'All {count} datasets go to the conversation; the data stays in this workspace.',
      'ai.focusNone': 'Pick at least one focus area.',
      'state.working': 'Working…',
      'list.title': 'Datasets',
      'list.empty': 'No datasets yet. Import one to start.',
      'list.rows': '{count} rows',
      'list.columns': '{count} columns',
      'state.loading': 'Loading…',
      'state.loadError': 'Could not load: {message}',
      'state.select': 'Pick a dataset on the left to chart it.',
      'section.overview': 'Overview',
      'section.fields': 'Fields',
      'section.derived': 'Computed fields',
      'section.preview': 'Preview',
      'section.saved': 'Saved charts',
      'section.chart': 'Chart',
      'label.source': 'Source {kind}',
      'sourceKind.file': 'File',
      'sourceKind.database': 'Database',
      'sourceKind.api': 'API',
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
.da-app { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--dsw-alias-label-primary); font-size: 12px; background: var(--dsw-alias-bg-base); }
.da-appbar { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; padding: 7px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.da-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.da-brand-mark { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 24px; height: 24px; border-radius: 7px; color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); }
.da-brand-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; line-height: 1.2; }
.da-brand-title { font-size: 13px; font-weight: 600; white-space: nowrap; }
.da-brand-sub { font-size: 10px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.da-crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.da-crumb-sep { color: var(--dsw-alias-border-l3); }
.da-crumb { white-space: nowrap; }
.da-crumb-current { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.da-appbar-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.da-busy { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.da-main { display: grid; grid-template-columns: 236px minmax(0, 1fr) 264px; flex: 1 1 auto; min-height: 0; background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, var(--dsw-alias-bg-base)); }
.da-app[data-compact="true"] .da-main { grid-template-columns: minmax(0, 1fr); }
.da-rail { display: flex; flex-direction: column; gap: 14px; min-height: 0; padding: 10px; overflow-y: auto; background: var(--dsw-alias-bg-base); border-right: 1px solid var(--dsw-alias-border-l1); }
.da-rail-right { border-right: none; border-left: 1px solid var(--dsw-alias-border-l1); }
.da-rail-group { display: flex; flex-direction: column; gap: 5px; }
.da-rail-head { display: flex; align-items: center; gap: 6px; }
.da-rail-head > button { margin-left: auto; }
.da-rail-title { font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.da-rail-count { min-width: 16px; padding: 0 5px; border-radius: 999px; font-size: 10px; line-height: 16px; text-align: center; color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.da-rail-empty { margin: 0; padding: 4px 2px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.da-scope-note { margin: 0; padding: 6px 8px; border-radius: 6px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
.da-rail-error { margin: 0; padding: 4px 2px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.da-nav { display: flex; flex-direction: column; gap: 1px; }
.da-nav-item { display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 7px; font: inherit; text-align: left; color: var(--dsw-alias-label-secondary); background: transparent; border: none; border-radius: 6px; cursor: pointer; }
.da-nav-item:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.da-nav-item[data-active="true"] { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); }
.da-nav-item:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: -1px; }
.da-nav-icon { display: inline-flex; flex: 0 0 auto; opacity: 0.9; }
.da-nav-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.da-nav-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.da-nav-meta { font-size: 10px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.da-search { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; }
.da-search:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.da-search-sm { height: 26px; }
.da-search-input { flex: 1 1 auto; min-width: 0; padding: 0; font: inherit; font-size: 11px; color: var(--dsw-alias-label-primary); background: transparent; border: none; outline: none; }
.da-canvas { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; padding: 14px 16px 18px; overflow-y: auto; }
.da-canvas-head { display: flex; align-items: flex-start; gap: 10px; }
.da-canvas-title { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.da-h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.da-badges { display: flex; flex-wrap: wrap; gap: 5px; }
.da-badge { padding: 1px 7px; font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; }
.da-canvas-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.da-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; }
.da-stat { display: flex; flex-direction: column; gap: 2px; padding: 9px 12px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.da-stat-label { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.da-stat-value { font-size: 19px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; }
.da-stat-hint { font-size: 10px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.da-card { display: flex; flex-direction: column; min-height: 0; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.da-card-grow { flex: 1 1 auto; min-height: 180px; }
.da-card-chart { min-height: 220px; }
.da-chart-body { overflow: auto; }
.da-card-head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.da-card-title { max-width: 40%; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.da-card-body { min-height: 0; padding: 10px; }
.da-card-body-flush { padding: 0; overflow: auto; }
.da-card-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.da-toolbar-spacer { flex: 1 1 auto; }
.da-tabs { display: flex; align-items: center; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.da-tab { all: unset; margin-bottom: -1px; padding: 7px 10px; font-size: 12px; color: var(--dsw-alias-label-tertiary); border-bottom: 2px solid transparent; cursor: pointer; }
.da-tab:hover { color: var(--dsw-alias-label-primary); }
.da-tab[data-active="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-state-business-primary); }
.da-tab:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
.da-tabs-note { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.da-seg { display: inline-flex; align-items: center; gap: 1px; padding: 2px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; }
.da-seg button { all: unset; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 22px; border-radius: 5px; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.da-seg button:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.da-seg button[aria-pressed="true"] { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-base); box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent); }
.da-seg button[disabled] { opacity: 0.4; cursor: default; }
.da-panel { display: flex; flex-direction: column; gap: 7px; }
.da-panel + .da-panel { padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.da-panel-fields { flex: 1 1 auto; min-height: 0; }
.da-panel-head { display: flex; align-items: center; gap: 6px; }
.da-panel-title { margin: 0; font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.da-panel-head .da-rail-count { margin-left: auto; }
.da-panel-head .da-link-button { margin-left: auto; }
.da-link-button { all: unset; font-size: 11px; color: var(--dsw-alias-state-business-primary); cursor: pointer; }
.da-link-button[disabled] { opacity: 0.45; cursor: default; }
.da-config-body { display: flex; flex-direction: column; gap: 10px; }
.da-config-group { display: flex; flex-direction: column; gap: 6px; }
.da-config-label { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.da-config-fields { display: flex; flex-direction: column; gap: 6px; }
.da-config-tip { margin: 0; font-size: 10px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.da-field-list { display: flex; flex-direction: column; gap: 1px; max-height: 40vh; overflow-y: auto; }
.da-field-row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 3px 6px; font: inherit; text-align: left; color: var(--dsw-alias-label-secondary); background: transparent; border: none; border-radius: 5px; cursor: pointer; }
.da-field-row:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.da-field-name { flex: 1 1 auto; min-width: 0; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.da-type { flex: 0 0 auto; padding: 0 5px; font-size: 9px; line-height: 15px; border-radius: 4px; color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.da-type[data-type="number"] { color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent); }
.da-type[data-type="date"], .da-type[data-type="datetime"] { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.da-field-null { flex: 0 0 auto; font-size: 10px; color: var(--dsw-alias-state-warn-primary); }
.da-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.da-field-label { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.da-field-row-inline { display: flex; gap: 8px; }
.da-field-row-inline > .da-field { flex: 1 1 0; }
.da-drivers { display: flex; gap: 2px; padding: 2px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); border-radius: 7px; }
.da-driver { flex: 1 1 0; height: 26px; padding: 0 8px; font: inherit; font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); background: transparent; border: none; border-radius: 5px; cursor: pointer; }
.da-driver:hover { color: var(--dsw-alias-label-primary); }
.da-driver[data-active='true'] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent); }
.da-field-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.da-span2 { grid-column: span 2; }
.da-span3 { grid-column: span 3; }
.da-secret { display: flex; align-items: center; gap: 4px; min-width: 0; }
.da-secret .da-input { flex: 1 1 auto; }
.da-secret-toggle { flex: 0 0 auto; height: 26px; padding: 0 6px; font: inherit; font-size: 10px; color: var(--dsw-alias-label-tertiary); background: transparent; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; cursor: pointer; }
.da-secret-toggle:hover { color: var(--dsw-alias-label-primary); }
.da-advanced { padding: 0 8px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.da-advanced > .da-field, .da-advanced > .da-hint { margin-top: 6px; }
.da-advanced-summary { padding: 6px 0; font-size: 10px; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.da-advanced[open] .da-advanced-summary { color: var(--dsw-alias-label-secondary); }
.da-hint { margin: 0; font-size: 10px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.da-tables { display: flex; flex-direction: column; gap: 6px; }
.da-tables-head { display: flex; align-items: center; justify-content: space-between; }
.da-input, .da-select { min-width: 0; height: 26px; padding: 0 7px; font: inherit; font-size: 11px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; }
.da-select { cursor: pointer; }
.da-input:focus-visible, .da-select:focus-visible { border-color: var(--dsw-alias-state-business-primary); outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: 0; }
.da-switch { display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 0; font: inherit; color: var(--dsw-alias-label-secondary); background: transparent; border: none; cursor: pointer; }
.da-switch-label { font-size: 11px; }
.da-switch-track { position: relative; flex: 0 0 auto; margin-left: auto; width: 26px; height: 15px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); transition: background 120ms ease; }
.da-switch-thumb { position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--dsw-alias-bg-base); transition: transform 120ms ease; }
.da-switch[data-on="true"] .da-switch-track { background: var(--dsw-alias-state-business-primary); }
.da-switch[data-on="true"] .da-switch-thumb { transform: translateX(11px); }
.da-switch:focus-visible { border-radius: 4px; outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.da-button { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; font: inherit; font-size: 11px; color: var(--dsw-alias-label-primary); white-space: nowrap; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; cursor: pointer; }
.da-button:hover { border-color: var(--dsw-alias-state-business-primary); }
.da-button[aria-pressed="true"] { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }
.da-button:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.da-button-primary { color: var(--dsw-alias-label-inverse, var(--dsw-alias-bg-base)); background: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }
.da-button-primary:hover { border-color: var(--dsw-alias-state-business-primary); filter: brightness(1.08); }
.da-button-primary[disabled] { opacity: 0.5; cursor: default; filter: none; }
.da-button-accent { color: var(--dsw-alias-state-business-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); }
.da-button-accent:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
.da-button-accent[disabled] { opacity: 0.5; cursor: default; background: transparent; }
.da-button[disabled] { opacity: 0.5; cursor: default; }
.da-icon-button { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 26px; height: 26px; padding: 0; color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.da-icon-button:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.da-icon-button:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.da-icon-button[disabled] { opacity: 0.45; cursor: default; background: transparent; }
.da-icon-button-sm { width: 19px; height: 19px; border-radius: 5px; }
.da-empty-state { display: flex; flex: 1 1 auto; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 48px 24px; text-align: center; }
.da-empty-mark { display: inline-flex; align-items: center; justify-content: center; width: 52px; height: 52px; color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); border-radius: 14px; }
.da-empty-title { margin: 0; font-size: 15px; font-weight: 600; }
.da-empty-body { max-width: 430px; margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.da-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.da-empty-hint { margin: 4px 0 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.da-dropzone { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 16px; text-align: center; color: var(--dsw-alias-label-secondary); border: 1px dashed var(--dsw-alias-border-l3); border-radius: 8px; cursor: pointer; }
.da-dropzone:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-state-business-primary); }
.da-dropzone-title { font-size: 12px; font-weight: 600; }
.da-dropzone-hint { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.da-filepick-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.da-inline-action { flex: 0 0 auto; align-self: flex-end; }
.da-sheets { display: flex; flex-direction: column; gap: 6px; padding: 8px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.da-sheets-head { display: flex; align-items: center; gap: 6px; }
.da-sheets-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.da-sheets-count { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.da-sheets-actions { display: flex; gap: 2px; margin-left: auto; }
.da-sheet-all { height: 20px; padding: 0 6px; font: inherit; font-size: 10px; color: var(--dsw-alias-label-tertiary); background: transparent; border: none; border-radius: 4px; cursor: pointer; }
.da-sheet-all:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.da-sheet-all[disabled] { opacity: 0.45; cursor: default; background: transparent; }
.da-sheet-list { display: flex; flex-direction: column; gap: 1px; max-height: 208px; overflow-y: auto; }
.da-sheet { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 5px; cursor: pointer; }
.da-sheet:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.da-sheet[data-empty='true'] { opacity: 0.55; cursor: default; }
.da-sheet[data-empty='true']:hover { background: transparent; }
.da-sheet-check { margin: 0; accent-color: var(--dsw-alias-state-business-primary); cursor: inherit; }
.da-sheet-name { min-width: 0; font-size: 11px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.da-sheet[data-picked='true'] .da-sheet-name { font-weight: 600; }
.da-picks { display: flex; flex-direction: column; gap: 2px; max-height: 190px; overflow-y: auto; padding: 4px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.da-pick { display: flex; align-items: center; gap: 7px; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
.da-pick:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.da-pick[data-on='true'] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent); }
.da-pick-text { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; gap: 1px; }
.da-pick-name { overflow: hidden; font-size: 11.5px; color: var(--dsw-alias-label-primary); text-overflow: ellipsis; white-space: nowrap; }
.da-pick[data-on='true'] .da-pick-name { font-weight: 600; }
.da-pick-meta { overflow: hidden; font-size: 10px; color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap; }
.da-pick .da-drawer-badge { flex: 0 0 auto; }
.da-sheet-meta { flex: 0 0 auto; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.da-sheet-head { grid-column: 2 / -1; font-size: 9px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.da-pick-list { display: flex; flex-direction: column; max-height: 220px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.da-pick-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.da-pick-row:last-child { border-bottom: none; }
.da-pick-name { flex: 1 1 auto; min-width: 0; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.da-table-wrap { overflow: auto; }
.da-derivations { display: flex; flex-direction: column; gap: 6px; padding: 10px; }
.da-derivation { display: flex; flex-direction: column; gap: 2px; }
.da-derivation-name { font-size: 11px; font-weight: 600; }
.da-derivation-expr { font-family: var(--dsw-font-family-mono, monospace); font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.da-toast { padding: 3px 9px; font-size: 11px; color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); border-radius: 999px; }
.da-compact-picker { display: flex; align-items: center; gap: 8px; }
.da-compact-picker .da-select { flex: 1 1 auto; }
.da-meta { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.da-note { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }
.da-note-ok { color: var(--dsw-alias-state-success-primary); }
.da-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 1.5; }
.da-empty { margin: 0; padding: 10px 4px; color: var(--dsw-alias-label-secondary); text-align: center; line-height: 1.6; }
.da-scroll { overflow: auto; max-height: 230px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); }
.da-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.da-table th, .da-table td { padding: 4px 8px; text-align: left; vertical-align: top; white-space: nowrap; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.da-table th { position: sticky; top: 0; color: var(--dsw-alias-label-secondary); font-weight: 600; background: var(--dsw-alias-bg-base); }
.da-table th button { all: unset; cursor: pointer; color: inherit; font: inherit; }
.da-table tbody tr:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.da-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l3); border-radius: 999px; }
.da-chip-button { font: inherit; cursor: pointer; background: transparent; }
.da-chip-button:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-state-business-primary); }
.da-chip-button[data-active='true'] { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
.da-chip-row { display: flex; flex-wrap: wrap; gap: 4px; }
.da-saved-conns { display: flex; flex-direction: column; gap: 4px; }
.da-add { position: relative; display: inline-flex; margin-left: auto; }
.da-menu { position: absolute; top: 21px; right: 0; z-index: 40; display: flex; flex-direction: column; min-width: 138px; padding: 3px; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; box-shadow: 0 6px 20px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent); }
.da-menu-item { display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 8px; font: inherit; font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: left; background: transparent; border: none; border-radius: 5px; cursor: pointer; }
.da-menu-item:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.da-menu-backdrop { position: fixed; inset: 0; z-index: 39; background: transparent; }
.da-pick-row-button { width: 100%; font: inherit; text-align: left; color: inherit; background: transparent; border: none; border-bottom: 1px solid var(--dsw-alias-border-l1); cursor: pointer; }
.da-pick-row-button:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
.da-pick-row-button[data-active='true'] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
.da-pick-row-button[data-active='true'] .da-pick-name { color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.da-pick-tag { flex: 0 0 auto; font-size: 9px; color: var(--dsw-alias-label-tertiary); }
.da-table-picked { display: flex; flex-direction: column; gap: 6px; padding: 8px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
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
.da-kpi { display: flex; flex-direction: column; gap: 2px; padding: 14px 4px; }
.da-kpi-value { font-size: 30px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.da-kpi-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.da-c1 { --da-color: var(--dsw-alias-state-business-primary); }
.da-c2 { --da-color: var(--dsw-alias-state-success-primary); }
.da-c3 { --da-color: var(--dsw-alias-state-warn-primary); }
.da-c4 { --da-color: var(--dsw-alias-state-error-primary); }
.da-c5 { --da-color: var(--dsw-alias-state-done-primary); }
.da-c6 { --da-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, var(--dsw-alias-bg-base)); }
.da-fill { fill: var(--da-color); }
.da-stroke { stroke: var(--da-color); }
.da-page { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 12px; }
.da-page > .da-app { flex: 1 1 auto; min-height: 0; }
.da-dialog-backdrop { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; padding: 24px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 34%, transparent); }
.da-dialog { display: flex; flex-direction: column; gap: 10px; width: min(600px, 100%); max-height: 100%; padding: 14px; overflow-y: auto; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1)); border-radius: 10px; box-shadow: 0 16px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent); }
.da-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.da-dialog-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.da-dialog-x { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; color: var(--dsw-alias-label-tertiary); background: transparent; border: none; border-radius: 5px; cursor: pointer; }
.da-dialog-x:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.da-dialog-body { display: flex; flex-direction: column; gap: 8px; }
.da-dialog-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
.da-pre { margin: 0; padding: 6px; max-height: 160px; overflow: auto; font-family: var(--dsw-font-family-mono, monospace); font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.da-pre-brief { max-height: 240px; white-space: pre-wrap; word-break: break-word; }
.da-drawer-backdrop { position: fixed; inset: 0; z-index: 45; display: flex; justify-content: flex-end; background: color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent); animation: da-fade-in 140ms ease-out; }
.da-drawer { display: flex; flex-direction: column; width: min(420px, 100%); height: 100%; background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1)); box-shadow: -18px 0 48px color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent); animation: da-slide-in 180ms cubic-bezier(0.22, 1, 0.36, 1); }
.da-drawer-head { display: flex; flex: 0 0 auto; align-items: flex-start; gap: 10px; padding: 14px 16px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.da-drawer-mark { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 28px; height: 28px; color: var(--dsw-alias-state-business-primary); background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); border-radius: 8px; }
.da-drawer-heading { flex: 1 1 auto; min-width: 0; }
.da-drawer-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.da-drawer-sub { margin: 3px 0 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.da-drawer-body { display: flex; flex: 1 1 auto; flex-direction: column; gap: 16px; padding: 14px 16px; overflow-y: auto; }
.da-drawer-section { display: flex; flex-direction: column; gap: 8px; }
.da-drawer-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.da-drawer-label { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; color: var(--dsw-alias-label-secondary); }
.da-drawer-hint { font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.da-drawer-card { display: flex; align-items: center; gap: 9px; padding: 9px 10px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.da-drawer-card-mark { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.da-drawer-card-text { flex: 1 1 auto; min-width: 0; }
.da-drawer-card-name { margin: 0; overflow: hidden; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); text-overflow: ellipsis; white-space: nowrap; }
.da-drawer-card-meta { margin: 2px 0 0; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.da-drawer-badge { flex: 0 0 auto; padding: 1px 7px; font-size: 10px; color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); border-radius: 999px; }
.da-focus-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.da-focus { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 8px 9px; font: inherit; text-align: left; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1)); border-radius: 8px; cursor: pointer; }
.da-focus:hover { border-color: var(--dsw-alias-border-l3); }
.da-focus[data-on='true'] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent); }
.da-focus-title { padding-right: 12px; font-size: 11.5px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.da-focus-hint { font-size: 10px; line-height: 1.4; color: var(--dsw-alias-label-tertiary); }
.da-focus-check { position: absolute; top: 7px; right: 8px; font-size: 10px; color: var(--dsw-alias-state-business-primary); opacity: 0; }
.da-focus[data-on='true'] .da-focus-check { opacity: 1; }
.da-focus-note { margin: 0; font-size: 10.5px; color: var(--dsw-alias-state-error-primary); }
.da-textarea { width: 100%; min-height: 62px; padding: 8px 9px; font: inherit; font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l3); border-radius: 7px; resize: vertical; }
.da-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
.da-drawer-toggle { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px; font: inherit; font-size: 11px; color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; cursor: pointer; }
.da-drawer-toggle-state { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.da-drawer-foot { display: flex; flex: 0 0 auto; flex-direction: column; gap: 8px; padding: 12px 16px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); border-top: 1px solid var(--dsw-alias-border-l1); }
.da-drawer-foot-note { margin: 0; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.da-drawer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.da-drawer-actions .da-button { height: 28px; padding: 0 12px; }
.da-drawer-actions .da-button-primary[disabled] { color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); border-color: transparent; opacity: 1; }
@keyframes da-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes da-slide-in { from { transform: translateX(24px); opacity: 0.5; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .da-drawer, .da-drawer-backdrop { animation: none; } }
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
    function createFace(ctx, sessionId, t) {
      // Without a Session there is no workspace to resolve, so every request
      // would come back as the generic "needs a sessionId" failure. Answer with
      // the real reason once and let the caller show its empty state instead of
      // firing a round trip that cannot succeed.
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        const refused = async () => ({ ok: false, error: { code: 'no_session', message: t('page.noSession') } })
        return {
          sessionMissing: true,
          loadIndex: refused,
          loadCharts: refused,
          loadMeta: refused,
          loadRows: refused,
          state: refused,
          importFile: refused,
          loadSheets: refused,
          importSheets: refused,
          upload: refused,
          saveChart: refused,
          runQuery: refused,
          saveConnection: refused,
          dropConnection: refused,
          testConnection: refused,
          listTables: refused,
          importTable: refused,
          saveSource: refused,
          dropSource: refused,
          discoverSource: refused,
          previewSource: refused,
          importApi: refused,
        }
      }
      const scope = 'sessionId=' + encodeURIComponent(sessionId)

      /**
       * Call the workbench API and unwrap the shared envelope.
       * @param path - Path below the plugin API prefix.
       * @param init - Fetch init.
       * @param signal - Tab lifetime signal.
       * @returns `{ ok: true, value }` or the service's own error.
       */
      const request = async (path, init, signal) => {
        let response
        try {
          response = await fetch(API_BASE + path, {
            ...init,
            ...(signal === undefined ? {} : { signal }),
            headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
          })
        } catch (cause) {
          if (cause && cause.name === 'AbortError') throw cause
          return { ok: false, error: { code: 'network', message: t('err.network') } }
        }
        if (response.status === 401) {
          return { ok: false, error: { code: 'unauthorized', message: t('err.unauthorized') } }
        }
        let payload
        try {
          payload = await response.json()
        } catch {
          return { ok: false, error: { code: 'bad_response', message: t('err.badResponse') } }
        }
        if (payload && payload.ok === true) return { ok: true, value: payload.value }
        const error = (payload && payload.error) || { code: 'unknown', message: t('err.refused') }
        // The Host phrases this one for a log line; the workbench needs to say
        // what the reader can actually do about it.
        if (error.code === 'missing_workspace') {
          return { ok: false, error: { code: error.code, message: t('err.noWorkspace') } }
        }
        return { ok: false, error }
      }

      /**
       * POST a JSON body.
       * @param path - Path below the plugin API prefix.
       * @param body - JSON body; the session is added here.
       * @param signal - Tab lifetime signal.
       * @returns The unwrapped result.
       */
      const post = (path, body, signal) => request(path, {
        method: 'POST',
        body: JSON.stringify({ ...(body || {}), sessionId }),
      }, signal)

      /**
       * GET with the session in the query string.
       * @param path - Path below the plugin API prefix.
       * @param signal - Tab lifetime signal.
       * @returns The unwrapped result.
       */
      const get = (path, signal) => request(path + (path.includes('?') ? '&' : '?') + scope, {}, signal)

      return {
        loadIndex: signal => get('/state', signal),
        loadCharts: async signal => {
          const result = await get('/state', signal)
          return result.ok ? { ok: true, value: { charts: result.value.charts } } : result
        },
        loadMeta: async (id, signal) => {
          const result = await get('/dataset?id=' + encodeURIComponent(id), signal)
          return result.ok ? { ok: true, value: result.value.meta } : result
        },
        loadRows: (id, signal) => get('/rows?id=' + encodeURIComponent(id), signal),
        /** Whole workbench state: datasets, charts, connections, sources. */
        state: signal => get('/state', signal),
        /** Import a workspace file by path. */
        importFile: (body, signal) => post('/import', body, signal),
        /** List the worksheets of an Excel workbook without importing it. */
        loadSheets: (body, signal) => request('/sheets?path=' + encodeURIComponent(String((body || {}).path ?? '')), {}, signal),
        /** Import the ticked worksheets of one workbook, each as its own dataset. */
        importSheets: (body, signal) => post('/import/sheets', body, signal),
        /** Import bytes the user picked in the browser. */
        upload: (body, signal) => post('/upload', body, signal),
        /** Compose and save one chart. */
        saveChart: (body, signal) => post('/chart', body, signal),
        /** Run the shared query DSL. */
        runQuery: (body, signal) => post('/query', body, signal),
        /** Create or update a connection. */
        saveConnection: (body, signal) => post('/connections', body, signal),
        /** Remove a connection. */
        dropConnection: (id, signal) => request('/connections?sessionId=' + encodeURIComponent(sessionId) + '&id=' + encodeURIComponent(id), { method: 'DELETE' }, signal),
        /** Open a connection once and report the round trip. */
        testConnection: (body, signal) => post('/connections/test', body, signal),
        /** List tables and views on a connection. */
        listTables: (body, signal) => post('/connections/tables', body, signal),
        /** Read one table's columns before importing it. */
        describeTable: (body, signal) => post('/connections/describe', body, signal),
        /** Import a table. */
        importTable: (body, signal) => post('/connections/import', body, signal),
        /** Create or update a REST source. */
        saveSource: (body, signal) => post('/sources', body, signal),
        /** Remove a REST source. */
        dropSource: (id, signal) => request('/sources?sessionId=' + encodeURIComponent(sessionId) + '&id=' + encodeURIComponent(id), { method: 'DELETE' }, signal),
        /** Ask one page where its record array lives. */
        discoverSource: (body, signal) => post('/sources/discover', body, signal),
        /** Fetch one page of records without importing. */
        previewSource: (body, signal) => post('/sources/preview', body, signal),
        /** Import records into a dataset. */
        importApi: (body, signal) => post('/sources/import', body, signal),
      }
    }

    /** Composer draft actions captured from the dock; the workbench needs them for "Analyze with AI". */
    let dockInput = null
    /** Analysis brief waiting for the dock to mount, used when the workbench page hid the composer. */
    let pendingBrief = null

    /**
     * Invisible dock seat: hands the composer's draft actions to the workbench.
     *
     * The workbench page lives in the main column, which the dock cannot see.
     * A module-level reference is enough because the dock's share is stable for
     * the session and the workbench only ever writes into the draft.
     * @param props - Dock owner share carrying the input actions.
     * @returns Nothing; this seat renders no element.
     */
    function AiDockBridge(props) {
      const { inputActions } = props
      React.useEffect(() => {
        dockInput = inputActions
        if (pendingBrief !== null) {
          const text = pendingBrief
          pendingBrief = null
          inputActions.setDraft(text)
        }
        return () => {
          if (dockInput === inputActions) dockInput = null
        }
      }, [inputActions])
      return null
    }

    /** Chart types offered by the type switcher, in display order. */
    const CHART_TYPE_ORDER = ['bar', 'line', 'area', 'pie', 'scatter', 'kpi', 'table']

    /** Aggregate functions offered by the measure config, in display order. */
    const AGGREGATE_ORDER = ['sum', 'avg', 'min', 'max', 'count', 'countDistinct', 'p50', 'p95']

    /**
     * Analysis angles the AI drawer offers.
     *
     * `line` is what the brief asks the model to do; it is prompt text, so it
     * stays in Chinese like the rest of the brief rather than going through the
     * dictionary.
     */
    const AI_FOCUS = [
      { key: 'overview', line: '整体概览：数据规模、缺失与重复、主要维度构成，先给出一个总体判断。' },
      { key: 'trend', line: '趋势变化：按时间维度看走势与环比，指出拐点出现的时点。' },
      { key: 'anomaly', line: '异常离群：找出离群点、突变和可疑记录，并说明可能的原因。' },
      { key: 'compare', line: '分组对比：比较不同维度组合之间的差距，指出差距最大的分组。' },
      { key: 'correlation', line: '相关与驱动：判断哪些字段与目标指标同向变化，并说明证据强弱。' },
      { key: 'forecast', line: '预测与建议：基于现有走势给出后续区间，并列出可执行的下一步动作。' },
    ]

    /** Angles preselected when the drawer opens: enough to get a useful answer in one send. */
    const AI_FOCUS_DEFAULT = ['overview', 'trend', 'anomaly']

    /** How many fields each dataset spells out before saying "the rest is omitted". */
    const BRIEF_FIELDS_SINGLE = 24
    const BRIEF_FIELDS_MULTI = 16

    /**
     * Compose the brief the model reads for one or more datasets.
     *
     * One dataset keeps the shape the panel always sent. Several add a per-dataset
     * block, a join-key rule and a per-call `datasetId` reminder — a financial
     * analysis hands over the balance sheet, income statement, and cash-flow
     * statement at once, and without those rules the model tends to add figures
     * from different scopes together.
     * @param datasets - Dataset metadata objects, in the order they should appear.
     * @param focusKeys - Picked analysis angles.
     * @param note - Extra context typed by the reader.
     * @returns Prompt text for the composer.
     */
    function composeBrief(datasets, focusKeys, note) {
      const list = Array.isArray(datasets) ? datasets.filter(item => item !== undefined && item !== null) : []
      const nameOf = item => (item.name || item.id ? (item.name || item.id) : '')
      const shapeOf = item => String(item.rowCount ?? 0) + ' 行 × ' + String(item.columnCount ?? 0) + ' 列'
      const lines = []
      if (list.length <= 1) {
        const only = list[0]
        const idBit = only === undefined || only.id === undefined ? '' : '，dataset id 为 ' + String(only.id)
        lines.push('请分析数据集「' + nameOf(only ?? {}) + '」（' + shapeOf(only ?? {}) + '）' + idBit + '。')
      } else {
        lines.push('请一起分析以下 ' + String(list.length) + ' 个数据集。它们需要结合来看，例如财务分析里的资产负债表、利润表、现金流量表。')
      }
      lines.push('')
      const perDataset = list.length > 1 ? BRIEF_FIELDS_MULTI : BRIEF_FIELDS_SINGLE
      for (const [index, item] of list.entries()) {
        if (list.length > 1) {
          lines.push('数据集 ' + String(index + 1) + '：「' + nameOf(item) + '」（' + shapeOf(item) + '，dataset id 为 ' + String(item.id) + '）')
        }
        const fields = Array.isArray(item.schema) ? item.schema : []
        lines.push('字段：')
        for (const entry of fields.slice(0, perDataset)) {
          const stats = (item.stats && item.stats.columns && item.stats.columns[entry.name]) || {}
          const nullRate = item.stats && item.stats.nullRateByColumn ? item.stats.nullRateByColumn[entry.name] : undefined
          const bits = [entry.type, entry.role || 'dimension']
          if (stats.min !== undefined && stats.min !== null) bits.push('min=' + String(stats.min))
          if (stats.max !== undefined && stats.max !== null) bits.push('max=' + String(stats.max))
          if (typeof stats.mean === 'number') bits.push('mean=' + String(Math.round(stats.mean * 100) / 100))
          if (typeof nullRate === 'number') bits.push('null=' + String(Math.round(nullRate * 100)) + '%')
          lines.push('- ' + entry.name + '（' + bits.join(', ') + '）')
        }
        if (fields.length > perDataset) lines.push('- 其余 ' + String(fields.length - perDataset) + ' 个字段略。')
        lines.push('')
      }
      const chosen = AI_FOCUS.filter(item => focusKeys.includes(item.key))
      if (chosen.length > 0) {
        lines.push('分析重点：')
        chosen.forEach((item, index) => lines.push(String(index + 1) + '. ' + item.line))
      }
      if (list.length > 1) {
        lines.push('')
        lines.push('跨数据集要求：')
        lines.push('- 先用 dataset_profile 核对每个数据集的字段、主键与口径，再说明表之间可用的关联键（如主体、期间、科目编码）。')
        lines.push('- 关联键缺失或口径不一致时直接说明缺什么，不要臆造对应关系，也不要把不同口径的数字直接相加。')
        lines.push('- 结论标明来自哪个数据集；跨表推导的部分写清公式与假设。')
      }
      const extra = typeof note === 'string' ? note.trim() : ''
      if (extra !== '') {
        lines.push('')
        lines.push('补充说明：' + extra)
      }
      lines.push('')
      lines.push('输出要求：')
      lines.push('- 先给 3–5 条可验证的结论，每条都带上具体数字与分组。')
      lines.push('- 再指出 1–2 个值得追查的异常或风险，并说明判断依据。')
      lines.push('- 最后建议 1–2 张图（图表类型 + 维度 + 指标），说明它回答什么问题。')
      const scope = list.length > 1 ? '，每次调用都要带自己的 datasetId' : ''
      lines.push('读数用 dataset_query（dimensions / measures / filters' + scope + '），不要重写原始文件；出图用 chart_create，图表会出现在数据分析面板。')
      return lines.join('\n')
    }

    /**
     * Network database drivers the connection dialog offers.
     *
     * `port` is what the form pre-fills when the driver is picked, matching the
     * daemon's own default so an untouched form still connects.
     */
    const CONNECTION_DRIVERS = [
      { kind: 'mysql', port: 3306 },
      { kind: 'postgres', port: 5432 },
      { kind: 'sqlite', port: null },
    ]

    /**
     * Blank connection form for one driver.
     * @param kind - Driver kind.
     * @returns Form values the dialog binds to.
     */
    const blankConnection = kind => {
      const driver = CONNECTION_DRIVERS.find(entry => entry.kind === kind) ?? CONNECTION_DRIVERS[0]
      return {
        id: '',
        kind: driver.kind,
        label: '',
        path: '',
        host: '127.0.0.1',
        port: driver.port === null ? '' : String(driver.port),
        user: driver.kind === 'postgres' ? 'postgres' : (driver.kind === 'mysql' ? 'root' : ''),
        password: '',
        database: '',
        ssl: 'disable',
        url: '',
        urlEnv: '',
        hasPassword: false,
        maskedUrl: '',
      }
    }

    /**
     * Turn a stored connection into form values.
     *
     * The Host never sends the secret back, so `hasPassword` drives the field
     * placeholder and a masked URL is shown as a hint rather than as a value.
     * @param connection - Connection as returned by the workbench state.
     * @returns Form values.
     */
    const formFromConnection = connection => {
      const base = blankConnection(connection.kind)
      return {
        ...base,
        id: connection.id ?? '',
        label: connection.label ?? '',
        path: connection.path ?? '',
        host: connection.host ?? base.host,
        port: connection.port === undefined || connection.port === null ? base.port : String(connection.port),
        user: connection.user ?? base.user,
        database: connection.database ?? '',
        ssl: connection.ssl === 'require' ? 'require' : 'disable',
        urlEnv: connection.urlEnv ?? '',
        hasPassword: connection.hasPassword === true,
        maskedUrl: typeof connection.url === 'string' ? connection.url : '',
      }
    }

    /** Dataset source kinds that have a localized name. */
    const SOURCE_KIND_KEYS = { file: 'sourceKind.file', database: 'sourceKind.database', api: 'sourceKind.api' }

    /**
     * Inline chrome glyph. Every shape is stroked or filled with
     * `currentColor`, so icons follow the theme without extra tokens.
     * @param props - `name`, optional `size` and `className`.
     * @returns An inline SVG element.
     */
    function Glyph(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }
      const shapes = {
        back: [e('path', { key: 'a', d: 'M10 3.5 5.5 8l4.5 4.5', ...stroke })],
        refresh: [
          e('path', { key: 'a', d: 'M13 8a5 5 0 1 1-1.7-3.7', ...stroke }),
          e('path', { key: 'b', d: 'M13.2 2.6v3h-3', ...stroke }),
        ],
        plus: [e('path', { key: 'a', d: 'M8 3.2v9.6M3.2 8h9.6', ...stroke })],
        database: [
          e('ellipse', { key: 'a', cx: 8, cy: 4.2, rx: 5, ry: 2, ...stroke }),
          e('path', { key: 'b', d: 'M3 4.2v7.6c0 1.1 2.2 2 5 2s5-.9 5-2V4.2', ...stroke }),
          e('path', { key: 'c', d: 'M3 8c0 1.1 2.2 2 5 2s5-.9 5-2', ...stroke }),
        ],
        api: [
          e('path', { key: 'a', d: 'M6.2 3.5H4.9A1.4 1.4 0 0 0 3.5 4.9v6.2a1.4 1.4 0 0 0 1.4 1.4h1.3', ...stroke }),
          e('path', { key: 'b', d: 'M9.8 3.5h1.3a1.4 1.4 0 0 1 1.4 1.4v6.2a1.4 1.4 0 0 1-1.4 1.4H9.8', ...stroke }),
          e('path', { key: 'c', d: 'M6.6 6.4 5.3 8l1.3 1.6M9.4 6.4 10.7 8l-1.3 1.6', ...stroke }),
        ],
        ai: [e('path', { key: 'a', d: 'M8 2.2 9.3 6.2 13.4 7.5 9.3 8.8 8 12.8 6.7 8.8 2.6 7.5 6.7 6.2z', fill: 'currentColor' })],
        save: [
          e('path', { key: 'a', d: 'M8 2.6v7.2', ...stroke }),
          e('path', { key: 'b', d: 'M5.2 7.2 8 9.9l2.8-2.7', ...stroke }),
          e('path', { key: 'c', d: 'M2.8 11.4v1.4a.8.8 0 0 0 .8.8h8.8a.8.8 0 0 0 .8-.8v-1.4', ...stroke }),
        ],
        search: [
          e('circle', { key: 'a', cx: 7, cy: 7, r: 3.6, ...stroke }),
          e('path', { key: 'b', d: 'M9.8 9.8 13 13', ...stroke }),
        ],
        field: [e('path', { key: 'a', d: 'M2.8 4.6h10.4M2.8 8h10.4M2.8 11.4h10.4', ...stroke })],
        chart: [
          e('path', { key: 'a', d: 'M2.6 13.2h10.8', ...stroke }),
          e('rect', { key: 'b', x: 3.6, y: 8.2, width: 2.2, height: 4.2, rx: 0.6, fill: 'currentColor' }),
          e('rect', { key: 'c', x: 6.9, y: 5, width: 2.2, height: 7.4, rx: 0.6, fill: 'currentColor' }),
          e('rect', { key: 'd', x: 10.2, y: 2.6, width: 2.2, height: 9.8, rx: 0.6, fill: 'currentColor' }),
        ],
        warning: [
          e('path', { key: 'a', d: 'M8 2.8 14 13H2z', ...stroke }),
          e('path', { key: 'b', d: 'M8 6.6v3.2', ...stroke }),
          e('circle', { key: 'c', cx: 8, cy: 11.6, r: 0.7, fill: 'currentColor' }),
        ],
        close: [e('path', { key: 'a', d: 'M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2', ...stroke })],
      }
      return e('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
        className: props.className,
      }, shapes[props.name] || [])
    }

    /**
     * Chart-type glyph for the type switcher.
     * @param props - `type`, optional `size`.
     * @returns An inline SVG element.
     */
    function ChartGlyph(props) {
      const size = typeof props.size === 'number' ? props.size : 15
      const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }
      const shapes = {
        bar: [
          e('rect', { key: 'a', x: 3, y: 8.4, width: 2.4, height: 4.8, rx: 0.6, fill: 'currentColor' }),
          e('rect', { key: 'b', x: 6.8, y: 5.4, width: 2.4, height: 7.8, rx: 0.6, fill: 'currentColor' }),
          e('rect', { key: 'c', x: 10.6, y: 2.6, width: 2.4, height: 10.6, rx: 0.6, fill: 'currentColor' }),
        ],
        line: [e('path', { key: 'a', d: 'M2.8 11.6 6.4 7.2 9.8 9.2 13.2 3.8', ...stroke })],
        area: [
          e('path', { key: 'a', d: 'M2.8 12 6.4 7.2 9.8 9.2 13.2 4v8z', fill: 'currentColor', opacity: 0.22 }),
          e('path', { key: 'b', d: 'M2.8 12 6.4 7.2 9.8 9.2 13.2 4', ...stroke }),
        ],
        pie: [
          e('circle', { key: 'a', cx: 8, cy: 8, r: 5.1, ...stroke }),
          e('path', { key: 'b', d: 'M8 8V2.9A5.1 5.1 0 0 1 12.5 10.8z', fill: 'currentColor', opacity: 0.55 }),
        ],
        scatter: [
          e('circle', { key: 'a', cx: 4.2, cy: 10.6, r: 1.5, fill: 'currentColor' }),
          e('circle', { key: 'b', cx: 7.6, cy: 6.2, r: 1.5, fill: 'currentColor' }),
          e('circle', { key: 'c', cx: 10.6, cy: 8.8, r: 1.5, fill: 'currentColor' }),
          e('circle', { key: 'd', cx: 12.4, cy: 4.2, r: 1.5, fill: 'currentColor' }),
        ],
        kpi: [
          e('rect', { key: 'a', x: 2.6, y: 3.6, width: 10.8, height: 8.8, rx: 1.4, ...stroke }),
          e('path', { key: 'b', d: 'M5 6.6h4.6M5 9.4h2.8', ...stroke }),
        ],
        table: [
          e('rect', { key: 'a', x: 2.6, y: 3.4, width: 10.8, height: 9.2, rx: 1.2, ...stroke }),
          e('path', { key: 'b', d: 'M2.6 6.6h10.8M6.9 6.6v6', ...stroke }),
        ],
      }
      return e('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        focusable: 'false',
      }, shapes[props.type] || [])
    }

    /**
     * One labelled statistic in the canvas summary strip.
     * @param props - `label`, `value`, optional `hint`.
     * @returns The card element.
     */
    function StatCard(props) {
      return e('div', { className: 'da-stat' },
        e('span', { className: 'da-stat-label' }, props.label),
        e('span', { className: 'da-stat-value' }, props.value),
        props.hint ? e('span', { className: 'da-stat-hint' }, props.hint) : null)
    }

    /**
     * Switch-style toggle used by the display options.
     * @param props - `label`, `checked`, `onChange`, optional `disabled`.
     * @returns The switch element.
     */
    function SwitchRow(props) {
      const { label, checked, onChange, disabled } = props
      return e('button', {
        type: 'button',
        className: 'da-switch',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'data-on': checked ? 'true' : 'false',
        disabled: disabled === true,
        onClick: () => onChange(!checked),
      },
      e('span', { className: 'da-switch-label' }, label),
      e('span', { className: 'da-switch-track' }, e('span', { className: 'da-switch-thumb' })))
    }

    /**
     * Analysis workbench: an application bar, a dataset rail, the chart canvas,
     * and the chart settings rail. Renders full width on the page seat and as a
     * single column on the narrow right-sidebar seat.
     * @param props - Session props, translate function, the read face, and an
     * optional `compact` flag plus `onBack`.
     * @returns The workbench element.
     */
    /**
     * Worksheet checkboxes for a workbook import.
     *
     * Each row is one tab: its name, how many rows and columns it holds, and the
     * header text, so two look-alike tabs stay apart. A tab with a header but no
     * rows stays visible and unpicked — it has nothing to import.
     * @param props - `sheets`, `picked`, `busy`, `t`, and the pick callbacks.
     * @returns The picker element.
     */
    function SheetPicker(props) {
      const { sheets, picked, busy, t, onPick, onPickAll, onPickNone } = props
      const ticked = sheets.filter(sheet => picked[sheet.name] === true).length
      return e('div', { className: 'da-sheets' },
        e('div', { className: 'da-sheets-head' },
          e('span', { className: 'da-sheets-title' }, t('dialog.file.sheets')),
          e('span', { className: 'da-sheets-count' }, t('dialog.file.sheetsCount', { total: sheets.length, picked: ticked })),
          e('span', { className: 'da-sheets-actions' },
            e('button', {
              type: 'button',
              className: 'da-sheet-all',
              disabled: busy === true,
              onClick: onPickAll,
            }, t('dialog.file.sheetAll')),
            e('button', {
              type: 'button',
              className: 'da-sheet-all',
              disabled: busy === true,
              onClick: onPickNone,
            }, t('dialog.file.sheetNone')))),
        e('p', { className: 'da-hint' }, t('dialog.file.sheetsHint')),
        e('div', { className: 'da-sheet-list' }, sheets.map(sheet => e('label', {
          key: sheet.name,
          className: 'da-sheet',
          'data-empty': sheet.empty === true ? 'true' : 'false',
          'data-picked': picked[sheet.name] === true ? 'true' : 'false',
        },
        e('input', {
          type: 'checkbox',
          className: 'da-sheet-check',
          checked: picked[sheet.name] === true,
          disabled: busy === true || sheet.empty === true,
          onChange: event => onPick(sheet.name, event.target.checked),
        }),
        e('span', { className: 'da-sheet-name' }, sheet.name),
        e('span', { className: 'da-sheet-meta' }, sheet.empty === true
          ? t('dialog.file.sheetEmpty')
          : t('dialog.file.sheetRows', { rows: sheet.rows ?? 0, columns: sheet.columns ?? 0 })),
        Array.isArray(sheet.header) && sheet.header.length > 0
          ? e('span', { className: 'da-sheet-head' }, t('dialog.file.sheetHeader', { header: sheet.header.join(' · ') }))
          : null))))
    }

    function AnalysisPanel(props) {
      const { useTabInfo, t, ctx } = props
      const compact = props.compact === true
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
      const [view, setView] = React.useState('rows')
      const [datasetQuery, setDatasetQuery] = React.useState('')
      const listGeneration = React.useRef(0)
      const dataGeneration = React.useRef(0)
      const [connections, setConnections] = React.useState([])
      const [sources, setSources] = React.useState([])
      const [dialog, setDialog] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [dialogError, setDialogError] = React.useState(null)
      const [dialogNote, setDialogNote] = React.useState(null)
      const [filePath, setFilePath] = React.useState('')
      const [fileName, setFileName] = React.useState('')
      /** Worksheets found in the picked/typed workbook, or null before a probe. */
      const [sheets, setSheets] = React.useState(null)
      /** Where the Host keeps this conversation's artifacts. */
      const [scope, setScope] = React.useState(null)
      /** Worksheet name → ticked. */
      const [pickedSheets, setPickedSheets] = React.useState({})
      /** Bytes staged by the upload route, so sheet picking does not re-send them. */
      const [staged, setStaged] = React.useState(null)
      const [connForm, setConnForm] = React.useState(() => blankConnection('mysql'))
      const [revealPassword, setRevealPassword] = React.useState(false)
      const [noteOk, setNoteOk] = React.useState(false)
      const [apiForm, setApiForm] = React.useState({ name: '', baseUrl: '', allowed: '', path: '', recordsPath: '' })
      const [tables, setTables] = React.useState(null)
      /** Table picked for import, or null before one is chosen. */
      const [tablePick, setTablePick] = React.useState(null)
      /** Columns of the picked table, or null while they are being read. */
      const [tableColumns, setTableColumns] = React.useState(null)
      /** Name the imported dataset will wear; defaults to the table name. */
      const [tableName, setTableName] = React.useState('')
      /** Whether the dataset group's "new dataset" menu is open. */
      const [addMenuOpen, setAddMenuOpen] = React.useState(false)
      const [chartNote, setChartNote] = React.useState(null)
      const [aiOpen, setAiOpen] = React.useState(false)
      const [aiFocus, setAiFocus] = React.useState(AI_FOCUS_DEFAULT)
      const [aiNote, setAiNote] = React.useState('')
      const [aiBriefShown, setAiBriefShown] = React.useState(true)
      /** Dataset ids handed to the model, in the order the reader ticked them. */
      const [aiIds, setAiIds] = React.useState([])
      /** id → `{ status, meta }`, so a multi-sheet brief needs no round trips mid-typing. */
      const [aiDocs, setAiDocs] = React.useState({})
      /** Ids with a metadata request already in flight. */
      const aiFetching = React.useRef(new Set())
      /** Ids whose metadata is already in `aiDocs`. */
      const aiLoaded = React.useRef(new Set())

      const errorText = error => {
        if (!error) return t('value.unknown')
        return error.message || error.code || t('value.unknown')
      }
      const isMissing = error => Boolean(error && (error.code === 'workspace-file/not-found' || error.code === 'file/not-found'))

      // Escape closes the AI drawer, the same way it closes a dialog.
      React.useEffect(() => {
        if (!aiOpen) return undefined
        const onKey = event => {
          if (event.key === 'Escape') setAiOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [aiOpen])

      // Datasets ticked in the AI drawer each need their own schema before the
      // brief can describe them, so the drawer fetches only the missing ones and
      // keeps them once loaded — reticking a dataset must not cost a round trip.
      React.useEffect(() => {
        if (!aiOpen) return undefined
        let live = true
        const wanted = aiIds.filter(id => !aiLoaded.current.has(id) && !aiFetching.current.has(id))
        for (const id of wanted) {
          aiFetching.current.add(id)
          api.current.loadMeta(id, signal).then(result => {
            if (!live) return
            aiLoaded.current.add(id)
            setAiDocs(current => ({
              ...current,
              [id]: result.ok
                ? { status: 'ready', meta: result.value }
                : { status: 'error', message: errorText(result.error) },
            }))
          }).catch(cause => {
            if (!live) return
            aiLoaded.current.add(id)
            setAiDocs(current => ({
              ...current,
              [id]: { status: 'error', message: String(cause && cause.message ? cause.message : cause) },
            }))
          }).finally(() => {
            aiFetching.current.delete(id)
          })
        }
        return () => { live = false }
      }, [aiOpen, aiIds, signal])

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
            setConnections(Array.isArray(indexResult.value.connections) ? indexResult.value.connections : [])
            setSources(Array.isArray(indexResult.value.sources) ? indexResult.value.sources : [])
            setScope(indexResult.value.scope ?? null)
          } else if (isMissing(indexResult.error)) {
            setDatasets([])
            setScope(null)
          } else {
            setDatasets([])
            setScope(null)
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
          setScope(null)
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
            setChartNote(null)
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

      const summary = React.useMemo(() => {
        if (meta === null) return null
        const rates = meta.stats && meta.stats.nullRateByColumn ? Object.values(meta.stats.nullRateByColumn) : []
        const numeric = rates.filter(rate => typeof rate === 'number')
        const average = numeric.length === 0 ? 0 : numeric.reduce((sum, rate) => sum + rate, 0) / numeric.length
        return {
          rows: typeof meta.rowCount === 'number' ? meta.rowCount : rows === null ? 0 : rows.length,
          columns: typeof meta.columnCount === 'number' ? meta.columnCount : schema.length,
          measures: measureFields.length,
          nullRate: average,
        }
      }, [meta, rows, schema, measureFields])

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

      const percent = value => Math.round(value * 1000) / 10 + '%'

      /**
       * Localized name for a dataset source kind.
       * @param kind - Source kind recorded on the dataset, when known.
       * @returns The translated name, or the raw kind.
       */
      const sourceKindLabel = kind => {
        const key = kind === undefined || kind === null ? undefined : SOURCE_KIND_KEYS[kind]
        return key === undefined ? t('value.unknown') : t(key)
      }

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

      /**
       * Run one workbench action, keeping the response value.
       *
       * Importing a workbook needs the value: it carries the staged path and the
       * worksheets, which decide what the dialog shows next.
       * @param task - Async action returning an API result.
       * @returns `{ ok, value }`, with the form messages already set on failure.
       */
      const attempt = async task => {
        setBusy(true)
        setDialogError(null)
        setDialogNote(null)
        setNoteOk(false)
        try {
          const result = await task()
          if (result && result.ok === false) {
            setDialogError(errorText(result.error))
            return { ok: false, error: result.error }
          }
          return { ok: true, value: result ? result.value : undefined }
        } catch (cause) {
          const message = String(cause && cause.message ? cause.message : cause)
          setDialogError(message)
          return { ok: false, error: { code: 'exception', message } }
        } finally {
          setBusy(false)
        }
      }

      /**
       * Run one workbench action with busy and message bookkeeping.
       * @param task - Async action returning an API result.
       * @returns Whether the action succeeded.
       */
      const runAction = async task => (await attempt(task)).ok

      /** Close the dialogs and reload the list after a successful import. */
      const finishImport = () => {
        setDialog(null)
        setDialogNote(null)
        setSheets(null)
        setPickedSheets({})
        setStaged(null)
        setTablePick(null)
        setTableColumns(null)
        setTableName('')
        setRefreshNonce(value => value + 1)
      }

      /**
       * Show the worksheets of a workbook found by a probe or a staged upload.
       * Empty tabs stay visible but unpicked: they are worth explaining rather
       * than hiding, and importing one would only fail.
       * @param found - Worksheet descriptors from the API.
       * @returns Nothing.
       */
      const applySheets = found => {
        const list = found.filter(entry => entry && typeof entry.name === 'string')
        setSheets(list)
        setPickedSheets(Object.fromEntries(list.filter(entry => entry.empty !== true).map(entry => [entry.name, true])))
      }

      /** Read the worksheets of the workspace-relative path in the field. */
      const loadSheets = async () => {
        const target = filePath.trim()
        if (target === '') return
        setSheets(null)
        setPickedSheets({})
        setStaged(null)
        const result = await attempt(() => api.current.loadSheets({ path: target }))
        if (!result.ok) return
        const found = Array.isArray(result.value?.sheets) ? result.value.sheets : []
        if (found.length === 0) {
          setDialogNote(t('dialog.file.noSheets'))
          return
        }
        applySheets(found)
      }

      /** Import what is ticked: worksheets one by one, or the file as a whole. */
      const submitImport = async () => {
        const target = staged !== null ? staged.path : filePath.trim()
        if (target === '') return
        if (sheets !== null && sheets.length > 0) {
          const chosen = sheets.filter(entry => pickedSheets[entry.name] === true).map(entry => entry.name)
          if (chosen.length === 0) {
            setDialogError(t('dialog.file.sheetRequired'))
            return
          }
          const result = await attempt(() => api.current.importSheets({
            path: target,
            sheets: chosen,
            ...(fileName.trim() === '' ? {} : { name: fileName.trim() }),
          }))
          if (!result.ok) return
          setRefreshNonce(value => value + 1)
          const built = Array.isArray(result.value?.datasets) ? result.value.datasets : []
          const failures = Array.isArray(result.value?.failures) ? result.value.failures : []
          if (failures.length === 0) {
            finishImport()
            return
          }
          // Keep the dialog open on a partial run so the failed tabs can be
          // retried; the ones that landed are already in the rail.
          const done = new Set(built.map(entry => entry.sheet))
          setPickedSheets(current => {
            const next = { ...current }
            for (const name of done) delete next[name]
            return next
          })
          setDialogNote(t('dialog.file.partial', {
            done: built.length,
            failed: failures.length,
            sheets: failures.map(entry => entry.sheet).join('、'),
          }))
          return
        }
        const ok = await runAction(() => api.current.importFile({
          path: target,
          ...(fileName.trim() === '' ? {} : { name: fileName.trim() }),
        }))
        if (ok) finishImport()
      }

      /**
       * Upload bytes picked in the browser.
       *
       * A workbook is staged first so the dialog can list its worksheets and
       * send the same bytes only once; a delimited file has nothing to choose
       * from and imports in one step.
       * @param file - Picked file.
       * @returns Nothing.
       */
      const submitUpload = async file => {
        if (!file) return
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000))
        }
        const dataBase64 = btoa(binary)
        if (!/\.(xlsx|xlsm)$/i.test(file.name)) {
          const ok = await runAction(() => api.current.upload({
            filename: file.name,
            dataBase64,
            ...(fileName.trim() === '' ? {} : { name: fileName.trim() }),
          }))
          if (ok) finishImport()
          return
        }
        setSheets(null)
        setPickedSheets({})
        setStaged(null)
        const result = await attempt(() => api.current.upload({ filename: file.name, dataBase64, stage: true }))
        if (!result.ok) return
        const path = String(result.value?.staged ?? '')
        if (path === '') return
        setStaged({ path, name: file.name })
        setDialogNote(t('dialog.file.uploaded', { path }))
        setNoteOk(true)
        const found = Array.isArray(result.value?.sheets) ? result.value.sheets : []
        if (found.length === 0) {
          // An .xlsx with unreadable tabs still imports as a single dataset;
          // the button then falls back to the whole-file route.
          setSheets([])
          return
        }
        applySheets(found)
      }

      /**
       * Compose the connection payload the Host expects from the form.
       *
       * A blank password is left out on purpose: while editing, that means
       * "keep the stored secret", which is the only copy the browser never sees.
       * @returns Connection descriptor for save or test.
       */
      const connectionPayload = () => {
        const id = connForm.id || 'conn_' + Date.now().toString(36)
        const trim = value => String(value ?? '').trim()
        if (connForm.kind === 'sqlite') {
          return { id, kind: 'sqlite', ...(trim(connForm.label) === '' ? {} : { label: trim(connForm.label) }), path: trim(connForm.path) }
        }
        return {
          id,
          kind: connForm.kind,
          ...(trim(connForm.label) === '' ? {} : { label: trim(connForm.label) }),
          ...(trim(connForm.host) === '' ? {} : { host: trim(connForm.host) }),
          ...(trim(connForm.port) === '' ? {} : { port: Number(trim(connForm.port)) }),
          ...(trim(connForm.user) === '' ? {} : { user: trim(connForm.user) }),
          ...(trim(connForm.database) === '' ? {} : { database: trim(connForm.database) }),
          ...(connForm.password === '' ? {} : { password: connForm.password }),
          ssl: connForm.ssl,
          ...(trim(connForm.url) === '' ? {} : { url: trim(connForm.url) }),
          ...(trim(connForm.urlEnv) === '' ? {} : { urlEnv: trim(connForm.urlEnv) }),
        }
      }

      /**
       * Read one connection's tables and views into the dialog.
       *
       * A stored connection is read the moment it is opened, so "from a
       * database" lands on a usable list instead of an empty form that looks
       * like the feature is missing.
       * @param id - Connection id.
       * @returns Fulfillment after the dialog state settles.
       */
      const listTables = async id => {
        if (typeof id !== 'string' || id === '') return
        setTablePick(null)
        setTableColumns(null)
        await runAction(async () => {
          const result = await api.current.listTables({ connectionId: id })
          if (result.ok) setTables(result.value.objects || [])
          return result
        })
      }

      /**
       * Pick one table: remember it, then read its columns.
       * @param name - Table or view name.
       * @returns Fulfillment after the column list settles.
       */
      const pickTable = async name => {
        setTablePick(name)
        setTableColumns(null)
        setTableName(current => (current.trim() === '' ? name : current))
        try {
          const result = await api.current.describeTable({ connectionId: connForm.id, table: name })
          setTableColumns(result.ok ? (result.value.columns || []) : [])
          if (result.ok === false) setDialogNote(t('dialog.db.columnsFailed'))
        } catch {
          // A failed description never blocks the import: the reader already
          // knows which table they want, and the import reports its own errors.
          setTableColumns([])
        }
      }

      /** Persist the connection form, then list its tables. */
      const submitConnection = async () => {
        const connection = connectionPayload()
        const id = connection.id
        const ok = await runAction(() => api.current.saveConnection({ connection }))
        if (!ok) return
        setConnForm(current => ({ ...current, id }))
        setRefreshNonce(value => value + 1)
        const listed = await runAction(async () => {
          const result = await api.current.listTables({ connectionId: id })
          if (result.ok) setTables(result.value.objects || [])
          return result
        })
        if (listed) setDialogNote(t('dialog.db.saved', { id: connection.label || connection.database || connection.host || id }))
      }

      /** Open the connection described by the form and report the round trip. */
      const probeConnection = async () => {
        setBusy(true)
        setDialogError(null)
        setDialogNote(null)
        setNoteOk(false)
        try {
          const result = await api.current.testConnection({ connection: connectionPayload() })
          if (result.ok === false) {
            setDialogError(errorText(result.error))
            return
          }
          setNoteOk(true)
          setDialogNote(t('dialog.db.testOk', {
            ms: result.value?.elapsedMs ?? 0,
            kind: String(result.value?.kind ?? connForm.kind).toUpperCase(),
          }))
        } catch (cause) {
          setDialogError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }

      /** Import the picked table into a dataset under the typed name. */
      const importTable = async () => {
        if (tablePick === null) return
        const name = tableName.trim() === '' ? tablePick : tableName.trim()
        const ok = await runAction(() => api.current.importTable({
          connectionId: connForm.id,
          table: tablePick,
          name,
        }))
        if (ok) finishImport()
      }

      /** Persist the REST source form, then preview one page. */
      const submitSource = async () => {
        const id = apiForm.id || 'src_' + Date.now().toString(36)
        const source = {
          id,
          name: apiForm.name.trim() || apiForm.baseUrl.trim(),
          baseUrl: apiForm.baseUrl.trim(),
          allowedHosts: apiForm.allowed.split(',').map(part => part.trim()).filter(part => part.length > 0),
          ...(apiForm.recordsPath.trim() === '' ? {} : { recordsPath: apiForm.recordsPath.trim() }),
        }
        const ok = await runAction(() => api.current.saveSource({ source }))
        if (!ok) return
        setApiForm(current => ({ ...current, id }))
        setDialogNote(t('dialog.api.saved', { id: source.name }))
        setRefreshNonce(value => value + 1)
      }

      /** Fetch one page so the shape and the record path can be checked. */
      const previewSource = async () => {
        if (!apiForm.id) return
        await runAction(async () => {
          const result = await api.current.previewSource({
            sourceId: apiForm.id,
            path: apiForm.path.trim() || undefined,
            recordsPath: apiForm.recordsPath.trim() || undefined,
          })
          if (result.ok) setTables(result.value)
          return result
        })
      }

      /** Import the previewed records into a dataset. */
      const importApi = async () => {
        const ok = await runAction(() => api.current.importApi({
          sourceId: apiForm.id,
          path: apiForm.path.trim() || undefined,
          recordsPath: apiForm.recordsPath.trim() || undefined,
          name: apiForm.name.trim() || undefined,
        }))
        if (ok) finishImport()
      }

      /** Persist the chart currently on the canvas into the chart library. */
      const saveCurrentChart = async () => {
        if (meta === null || selectedId === null || selectedId === undefined) return
        setBusy(true)
        setChartNote(null)
        try {
          const result = await api.current.saveChart({
            datasetId: selectedId,
            name: chartTitle,
            type: draft.type,
            ...(draft.type === 'table' || draft.dimension === '' ? {} : { x: { field: draft.dimension } }),
            ...(draft.type === 'table' || draft.measure === '' ? {} : { y: [{ field: draft.measure, agg: draft.agg }] }),
            ...(draft.series === '' || draft.type === 'table' || draft.type === 'kpi' ? {} : { series: { field: draft.series } }),
            filters: drill,
            options: {
              horizontal: draft.horizontal,
              stacked: draft.stacked,
              showValues: draft.showValues,
            },
          })
          if (result.ok) {
            setChartNote(t('chart.saveCreated', { name: result.value.spec && result.value.spec.name ? result.value.spec.name : chartTitle }))
            setRefreshNonce(value => value + 1)
          } else {
            setChartNote(t('state.loadError', { message: errorText(result.error) }))
          }
        } catch (cause) {
          setChartNote(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }

      /** `rows × columns` for one dataset meta, shown on each pick row. */
      const shapeOf = item => String(item.rowCount ?? 0) + ' 行 × ' + String(item.columnCount ?? 0) + ' 列'

      /**
       * Metadata for every dataset ticked in the drawer, in tick order.
       *
       * A ticked dataset whose metadata is still in flight is skipped here and
       * picked up on the next render; the open dataset is the fallback so the
       * preview is never an empty prompt.
       * @returns Dataset metadata objects, in tick order.
       */
      const briefDatasets = () => {
        const ready = aiIds
          .map(id => aiDocs[id])
          .filter(doc => doc !== undefined && doc.status === 'ready')
          .map(doc => doc.meta)
        if (ready.length > 0) return ready
        return meta === null ? [] : [meta]
      }

      /** The brief for whatever is ticked right now. */
      const analysisBrief = () => composeBrief(briefDatasets(), aiFocus, aiNote)

      /**
       * Open the AI drawer, seeding the tick list with the dataset on screen.
       *
       * Ticks survive an open/close cycle, so reopening the drawer to add one
       * more worksheet does not drop what was already chosen.
       * @returns Nothing.
       */
      const openAiDrawer = () => {
        const pool = Array.isArray(datasets) ? datasets : []
        if (pool.length === 0) {
          setChartNote(t('ai.needDataset'))
          return
        }
        setChartNote(null)
        setAiIds(current => {
          const kept = current.filter(id => pool.some(item => item.id === id))
          if (kept.length > 0) return kept
          const seed = selectedId !== null && selectedId !== undefined ? selectedId : pool[0].id
          return [seed]
        })
        setAiOpen(true)
      }

      const closeAiDrawer = () => setAiOpen(false)

      /** Tick or untick one dataset in the AI drawer. */
      const toggleAiDataset = id => setAiIds(current => (current.includes(id)
        ? current.filter(item => item !== id)
        : current.concat([id])))

      /** Toggle one analysis angle in the drawer. */
      const toggleFocus = key => setAiFocus(current => (current.includes(key)
        ? current.filter(item => item !== key)
        : current.concat([key])))

      /**
       * Put the brief into the conversation composer and show the conversation.
       *
       * The composer is reachable from the dock seat while the conversation is
       * mounted; on the workbench page it may be unmounted, so the brief is
       * parked and the dock applies it on mount.
       * @returns Nothing.
       */
      const handOffBrief = () => {
        const text = analysisBrief()
        setAiOpen(false)
        if (dockInput !== null) {
          dockInput.setDraft(text)
        } else {
          pendingBrief = text
          setChartNote(t('ai.noBridge'))
        }
        if (ctx !== undefined && ctx.layout !== undefined) ctx.layout.selectPanel('conversation')
      }

      /** Load one saved chart back onto the canvas. */
      const openSavedChart = chart => {
        setSavedSpec(chart)
        setMode('saved')
        if (chart.datasetId !== undefined && chart.datasetId !== null) setSelectedId(chart.datasetId)
        setHidden([])
        setDrill([])
      }

      const backToBuild = () => {
        setMode('build')
        setSavedSpec(null)
      }

      const openDialog = which => {
        setDialog(which)
        setDialogError(null)
        setDialogNote(null)
        setNoteOk(false)
        if (which === 'file') {
          // Worksheets belong to the file that was probed last, never to the
          // next import: reopening the dialog starts from a clean slate.
          setSheets(null)
          setPickedSheets({})
          setStaged(null)
        }
      }

      /**
       * Open the database dialog.
       *
       * A stored connection fills the form and lists its tables immediately, so
       * reading a database is one click after the first time it was saved. No
       * connection given means a blank form for a new one.
       * @param connection - Stored connection to read or edit, or undefined.
       * @returns Nothing.
       */
      const openDatabase = connection => {
        setRevealPassword(false)
        setTablePick(null)
        setTableColumns(null)
        setTableName('')
        setTables(null)
        setConnForm(connection === undefined ? blankConnection('mysql') : formFromConnection(connection))
        openDialog('db')
        if (connection !== undefined) void listTables(connection.id)
      }

      /**
       * Open the database dialog from a general "from a database" entry.
       *
       * Reusing the first saved connection turns the entry into one click when
       * the workspace already knows a database; with none saved it is a blank
       * form, which is the only thing it could be.
       * @returns Nothing.
       */
      const openDatabaseEntry = () => {
        openDatabase((connections || [])[0])
      }

      // --- application bar ---------------------------------------------------

      const appbar = e('header', { className: 'da-appbar' },
        typeof props.onBack === 'function'
          ? e('button', {
            type: 'button',
            className: 'da-icon-button',
            title: t('page.back'),
            'aria-label': t('page.back'),
            onClick: props.onBack,
          }, e(Glyph, { name: 'back' }))
          : null,
        e('div', { className: 'da-brand' },
          e('span', { className: 'da-brand-mark' }, e(Glyph, { name: 'chart' })),
          e('span', { className: 'da-brand-text' },
            e('span', { className: 'da-brand-title' }, t('tab.title')),
            compact ? null : e('span', { className: 'da-brand-sub' }, t('app.tagline')))),
        compact || meta === null
          ? null
          : e('div', { className: 'da-crumbs' },
            e('span', { className: 'da-crumb' }, t('label.dataset')),
            e('span', { className: 'da-crumb-sep' }, '›'),
            e('span', { className: 'da-crumb-current' }, meta.name || meta.id)),
        e('div', { className: 'da-appbar-actions' },
          busy ? e('span', { className: 'da-busy' }, t('state.working')) : null,
          e('button', {
            type: 'button',
            className: 'da-button da-button-primary',
            disabled: busy,
            onClick: () => openDialog('file'),
          }, e(Glyph, { name: 'plus' }), t('action.import')),
          compact
            ? null
            : e('button', {
              type: 'button',
              className: 'da-button',
              disabled: busy,
              onClick: openDatabaseEntry,
            }, e(Glyph, { name: 'database' }), t('action.database')),
          compact
            ? null
            : e('button', {
              type: 'button',
              className: 'da-button',
              disabled: busy,
              onClick: () => openDialog('api'),
            }, e(Glyph, { name: 'api' }), t('action.api')),
          e('button', {
            type: 'button',
            className: 'da-button da-button-accent',
            disabled: busy || (datasets || []).length === 0,
            'aria-haspopup': 'dialog',
            onClick: openAiDrawer,
          }, e(Glyph, { name: 'ai' }), t('action.ai'))))

      // --- left rail ---------------------------------------------------------

      const datasetNeedle = datasetQuery.trim().toLowerCase()
      const visibleDatasets = (datasets || []).filter(item => datasetNeedle === ''
        || String(item.name || item.id).toLowerCase().includes(datasetNeedle))

      const datasetRows = visibleDatasets.map(item => e('button', {
        key: item.id,
        type: 'button',
        className: 'da-nav-item',
        'data-active': item.id === selectedId ? 'true' : 'false',
        onClick: () => {
          setSelectedId(item.id)
          backToBuild()
        },
      },
      e('span', { className: 'da-nav-icon' }, e(Glyph, { name: 'field', size: 14 })),
      e('span', { className: 'da-nav-text' },
        e('span', { className: 'da-nav-name' }, item.name || item.id),
        e('span', { className: 'da-nav-meta' }, datasetHint(item)))))

      const chartRows = savedCharts.map(chart => e('button', {
        key: chart.id,
        type: 'button',
        className: 'da-nav-item',
        'data-active': mode === 'saved' && savedSpec !== null && savedSpec.id === chart.id ? 'true' : 'false',
        onClick: () => openSavedChart(chart),
      },
      e('span', { className: 'da-nav-icon' }, e(ChartGlyph, { type: chart.type, size: 14 })),
      e('span', { className: 'da-nav-text' },
        e('span', { className: 'da-nav-name' }, chart.name || chart.id),
        e('span', { className: 'da-nav-meta' }, t('chartType.' + chart.type) + ' · ' + savedDatasetName(chart.datasetId)))))

      /**
       * One line describing where a connection points, for the sidebar row.
       * @param item - Connection from the workbench state (secrets masked).
       * @returns Text such as `MYSQL · 10.0.0.9:3306 / shop`.
       */
      const connectionMeta = item => {
        if (item.kind === 'sqlite') return 'SQLite · ' + (item.path || '')
        const where = item.host === undefined || item.host === ''
          ? (item.urlEnv ? 'env:' + item.urlEnv : (item.url ? item.url : ''))
          : item.host + (item.port ? ':' + item.port : '') + (item.database ? ' / ' + item.database : '')
        return [String(item.kind || '').toUpperCase(), where].filter(part => part.length > 0).join(' · ')
      }

      const connectionRows = connections.map(item => e('button', {
        key: 'conn-' + item.id,
        type: 'button',
        className: 'da-nav-item',
        onClick: () => { openDatabase(item) },
      },
      e('span', { className: 'da-nav-icon' }, e(Glyph, { name: 'database', size: 14 })),
      e('span', { className: 'da-nav-text' },
        e('span', { className: 'da-nav-name' }, item.label || item.id),
        e('span', { className: 'da-nav-meta' }, connectionMeta(item)))))

      const sourceRows = sources.map(item => e('button', {
        key: 'src-' + item.id,
        type: 'button',
        className: 'da-nav-item',
        onClick: () => {
          setApiForm({
            id: item.id,
            name: item.name || '',
            baseUrl: item.baseUrl || '',
            allowed: Array.isArray(item.allowedHosts) ? item.allowedHosts.join(', ') : '',
            path: '',
            recordsPath: item.recordsPath || '',
          })
          openDialog('api')
        },
      },
      e('span', { className: 'da-nav-icon' }, e(Glyph, { name: 'api', size: 14 })),
      e('span', { className: 'da-nav-text' },
        e('span', { className: 'da-nav-name' }, item.name || item.id),
        e('span', { className: 'da-nav-meta' }, truncate(String(item.baseUrl || ''), 32)))))

      const railGroup = (title, count, action, content) => e('section', { className: 'da-rail-group' },
        e('div', { className: 'da-rail-head' },
          e('span', { className: 'da-rail-title' }, title),
          e('span', { className: 'da-rail-count' }, String(count)),
          action),
        content)

      const addButton = (label, onClick) => e('button', {
        type: 'button',
        className: 'da-icon-button da-icon-button-sm',
        title: label,
        'aria-label': label,
        disabled: busy,
        onClick,
      }, e(Glyph, { name: 'plus', size: 13 }))

      /**
       * The dataset group's add control: one button that opens the three ways to
       * create a dataset. A single "+" that jumped straight to the file picker
       * hid the database and API readers behind the data-source group, which is
       * why "read from a database" looked missing.
       * @returns The button and, while open, its menu.
       */
      const datasetAdd = e('div', { className: 'da-add' },
        e('button', {
          type: 'button',
          className: 'da-icon-button da-icon-button-sm',
          title: t('menu.newDataset'),
          'aria-label': t('menu.newDataset'),
          'aria-haspopup': 'menu',
          'aria-expanded': addMenuOpen ? 'true' : 'false',
          disabled: busy,
          onClick: () => setAddMenuOpen(value => !value),
        }, e(Glyph, { name: 'plus', size: 13 })),
        addMenuOpen
          ? e('div', { className: 'da-menu', role: 'menu' },
            e('button', {
              type: 'button',
              role: 'menuitem',
              className: 'da-menu-item',
              onClick: () => { setAddMenuOpen(false); openDialog('file') },
            }, e(Glyph, { name: 'field', size: 12 }), t('menu.fromFile')),
            e('button', {
              type: 'button',
              role: 'menuitem',
              className: 'da-menu-item',
              onClick: () => { setAddMenuOpen(false); openDatabaseEntry() },
            }, e(Glyph, { name: 'database', size: 12 }), t('menu.fromDatabase')),
            e('button', {
              type: 'button',
              role: 'menuitem',
              className: 'da-menu-item',
              onClick: () => { setAddMenuOpen(false); openDialog('api') },
            }, e(Glyph, { name: 'api', size: 12 }), t('menu.fromApi')))
          : null)

      const leftRail = e('aside', { className: 'da-rail' },
        // The menu floats over the rail, so a full-size backdrop closes it on
        // the first click anywhere else instead of leaving it stuck open.
        addMenuOpen
          ? e('div', { className: 'da-menu-backdrop', onClick: () => setAddMenuOpen(false) })
          : null,
        e('div', { className: 'da-search' },
          e(Glyph, { name: 'search', size: 14 }),
          e('input', {
            className: 'da-search-input',
            type: 'search',
            value: datasetQuery,
            placeholder: t('nav.searchDatasets'),
            'aria-label': t('nav.searchDatasets'),
            onChange: event => setDatasetQuery(event.target.value),
          })),
        railGroup(t('nav.datasets'), (datasets || []).length, datasetAdd,
          loadingList
            ? e('p', { className: 'da-rail-empty' }, t('state.loading'))
            : listError
              ? e('p', { className: 'da-rail-error' }, t('state.loadError', { message: listError }))
              : visibleDatasets.length === 0
                ? e('p', { className: 'da-rail-empty' }, t('list.empty'))
                : e('div', { className: 'da-nav' }, datasetRows)),
        railGroup(t('nav.charts'), savedCharts.length, null,
          // Both lists come from one /state call, so a failure is the same
          // failure; repeating it under the chart group only adds noise.
          chartsError !== null && chartsError === listError
            ? null
            : chartsError
              ? e('p', { className: 'da-rail-error' }, t('state.loadError', { message: chartsError }))
              : savedCharts.length === 0
                ? e('p', { className: 'da-rail-empty' }, t('rail.emptyCharts'))
                : e('div', { className: 'da-nav' }, chartRows)),
        railGroup(t('nav.sources'), connections.length + sources.length, addButton(t('nav.newConnection'), () => { openDatabase() }),
          connections.length === 0 && sources.length === 0
            ? e('p', { className: 'da-rail-empty' }, t('rail.emptySources'))
            : e('div', { className: 'da-nav' }, connectionRows.concat(sourceRows))),
        // A conversation without a folder still gets a working workbench; say
        // where its artifacts went so nobody looks for `.analysis` in a project.
        scope?.detached === true
          ? e('p', { className: 'da-scope-note', title: String(scope.path ?? '') }, t('rail.detached'))
          : null)

      // --- canvas ------------------------------------------------------------

      const datasetName = meta === null ? null : (meta.name || meta.id)

      const badges = meta === null
        ? []
        : [
          t('label.version', { version: meta.version }),
          t('label.source', { kind: sourceKindLabel(meta.source && meta.source.kind) }),
          t('label.updated', { time: formatTime(meta.updatedAt, t('value.unknown')) }),
        ]

      const canvasHead = e('div', { className: 'da-canvas-head' },
        e('div', { className: 'da-canvas-title' },
          e('h1', { className: 'da-h1' }, datasetName || t('state.noDataset')),
          e('div', { className: 'da-badges' }, badges.map(badge => e('span', { key: badge, className: 'da-badge' }, badge)))),
        e('div', { className: 'da-canvas-actions' },
          e('button', {
            type: 'button',
            className: 'da-button',
            disabled: busy,
            onClick: () => setRefreshNonce(value => value + 1),
          }, e(Glyph, { name: 'refresh', size: 14 }), t('action.refresh'))))

      const stats = summary === null
        ? null
        : e('div', { className: 'da-stats' },
          e(StatCard, {
            label: t('stat.rows'),
            value: formatNumber(summary.rows, t('value.unknown')),
          }),
          e(StatCard, { label: t('stat.columns'), value: formatNumber(summary.columns, t('value.unknown')) }),
          e(StatCard, { label: t('stat.measures'), value: formatNumber(summary.measures, t('value.unknown')) }),
          e(StatCard, { label: t('stat.nullRate'), value: percent(summary.nullRate) }))

      const typeSwitcher = e('div', { className: 'da-seg', role: 'group', 'aria-label': t('chart.type') },
        CHART_TYPE_ORDER.map(type => e('button', {
          key: type,
          type: 'button',
          'aria-pressed': mode === 'build' && draft.type === type ? 'true' : 'false',
          title: t('chartType.' + type),
          disabled: meta === null,
          onClick: () => changeType(type),
        }, e(ChartGlyph, { type }))))

      const chartCard = e('section', { className: 'da-card da-card-chart' },
        e('div', { className: 'da-card-head' },
          typeSwitcher,
          e('span', { className: 'da-toolbar-spacer' }),
          e('span', { className: 'da-card-title' }, chartTitle),
          model !== null && model.rows !== undefined
            ? e('span', { className: 'da-tabs-note' }, t('chart.countNote', { count: model.rows }))
            : null,
          mode === 'saved'
            ? e('button', { type: 'button', className: 'da-button', onClick: backToBuild }, t('chart.backToBuild'))
            : null,
          e('button', {
            type: 'button',
            className: 'da-button',
            disabled: busy || meta === null,
            title: t('action.saveChart'),
            onClick: () => { void saveCurrentChart() },
          }, e(Glyph, { name: 'save', size: 14 }), t('action.saveChart'))),
        e('div', { className: 'da-card-body da-chart-body' },
          meta === null
            ? e('p', { className: 'da-empty' }, loadingMeta ? t('state.loading') : rowsError || t('state.select'))
            : model === null
              ? e('p', { className: 'da-empty' }, t('state.loading'))
              : e(ChartBody, {
                model,
                t,
                hidden,
                onToggleSeries: toggleSeries,
                onDrill: addDrill,
                schema,
              })),
        drill.length > 0
          ? e('div', { className: 'da-card-foot' },
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
        chartNote ? e('div', { className: 'da-card-foot' }, e('span', { className: 'da-toast' }, chartNote)) : null,
        rowsNote && rowsNote.eof === false
          ? e('div', { className: 'da-card-foot' }, e('span', { className: 'da-note' }, t('chart.cappedNote', { count: rowsNote.lines })))
          : null,
        metaError ? e('div', { className: 'da-card-foot' }, e('span', { className: 'da-error' }, t('state.loadError', { message: metaError }))) : null)

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
        e('td', null, entry.nullRate === null ? t('value.unknown') : percent(entry.nullRate)),
        e('td', null, entry.distinct === null ? t('value.unknown') : String(entry.distinct))))

      const previewPanel = meta === null
        ? e('p', { className: 'da-empty' }, t('state.select'))
        : rows === null
          ? e('p', { className: 'da-empty' }, loadingMeta ? t('state.loading') : rowsError || '')
          : renderTable(meta.schema.slice(0, 30).map(entry => entry.name), rows.slice(0, 12), schemaByName, t)

      const fieldsPanel = meta === null
        ? e('p', { className: 'da-empty' }, t('state.select'))
        : e('div', { className: 'da-table-wrap' }, e('table', { className: 'da-table' }, fieldHead, e('tbody', null, fieldRows)))

      const derivedPanel = meta === null
        ? e('p', { className: 'da-empty' }, t('state.select'))
        : Array.isArray(meta.derived) && meta.derived.length > 0
          ? e('div', { className: 'da-derivations' }, meta.derived.map(field => e('div', { key: field.name, className: 'da-derivation' },
            e('span', { className: 'da-derivation-name' }, field.name),
            e('code', { className: 'da-derivation-expr' }, field.expression))))
          : e('p', { className: 'da-empty' }, t('derived.empty'))

      const tabs = [
        { id: 'rows', label: t('view.rows'), content: previewPanel },
        { id: 'fields', label: t('view.fields'), content: fieldsPanel },
        { id: 'derived', label: t('view.derived'), content: derivedPanel },
      ]

      const dataCard = e('section', { className: 'da-card da-card-grow' },
        e('div', { className: 'da-tabs', role: 'tablist' },
          tabs.map(entry => e('button', {
            key: entry.id,
            type: 'button',
            role: 'tab',
            className: 'da-tab',
            'data-active': view === entry.id ? 'true' : 'false',
            'aria-selected': view === entry.id ? 'true' : 'false',
            onClick: () => setView(entry.id),
          }, entry.label)),
          e('span', { className: 'da-toolbar-spacer' }),
          rowsNote ? e('span', { className: 'da-tabs-note' }, t('preview.note', { count: rowsNote.lines })) : null),
        e('div', { className: 'da-card-body da-card-body-flush' },
          (tabs.find(entry => entry.id === view) || tabs[0]).content))

      const compactPicker = compact
        ? e('div', { className: 'da-compact-picker' },
          e('span', { className: 'da-field-label' }, t('nav.datasets')),
          e('select', {
            className: 'da-select',
            value: selectedId === null || selectedId === undefined ? '' : selectedId,
            onChange: event => {
              const next = event.target.value
              setSelectedId(next === '' ? null : next)
              backToBuild()
            },
          },
          e('option', { value: '' }, t('state.noDataset')),
          (datasets || []).map(item => e('option', { key: item.id, value: item.id }, item.name || item.id))))
        : null

      // --- right rail: chart settings and fields -----------------------------

      const measureOptions = draft.type === 'scatter' ? measureFields : measureFields
      const dimensionOptions = draft.type === 'scatter' ? measureFields : dimensionFields

      const encodingBlock = e('div', { className: 'da-config-group' },
        e('div', { className: 'da-config-label' }, t('config.encoding')),
        draft.type === 'table'
          ? e('p', { className: 'da-note' }, t('chart.tableNote', { count: model && model.total !== undefined ? model.total : 0, shown: model && model.rows ? model.rows.length : 0 }))
          : e('div', { className: 'da-config-fields' },
            e('label', { className: 'da-field' },
              e('span', { className: 'da-field-label' }, t('chart.dimension')),
              e('select', {
                className: 'da-select',
                value: draft.dimension,
                disabled: draft.type === 'kpi',
                onChange: event => setDraft({ ...draft, dimension: event.target.value }),
              }, dimensionOptions.map(entry => e('option', { key: entry.name, value: entry.name }, entry.name)))),
            e('label', { className: 'da-field' },
              e('span', { className: 'da-field-label' }, t('chart.measure')),
              e('select', {
                className: 'da-select',
                value: draft.measure,
                onChange: event => setDraft({ ...draft, measure: event.target.value }),
              }, measureOptions.map(entry => e('option', { key: entry.name, value: entry.name }, entry.name)))),
            e('label', { className: 'da-field' },
              e('span', { className: 'da-field-label' }, t('chart.aggregate')),
              e('select', {
                className: 'da-select',
                value: draft.agg,
                disabled: draft.type === 'scatter',
                onChange: event => setDraft({ ...draft, agg: event.target.value }),
              }, AGGREGATE_ORDER.map(agg => e('option', { key: agg, value: agg }, t('agg.' + agg))))),
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
              : null))

      const styleBlock = e('div', { className: 'da-config-group' },
        e('div', { className: 'da-config-label' }, t('config.style')),
        draft.type === 'bar'
          ? e(SwitchRow, {
            label: t('chart.horizontal'),
            checked: draft.horizontal,
            onChange: value => setDraft({ ...draft, horizontal: value }),
          })
          : null,
        draft.type === 'bar' || draft.type === 'area' || draft.type === 'line'
          ? e(SwitchRow, {
            label: t('chart.stacked'),
            checked: draft.stacked,
            onChange: value => setDraft({ ...draft, stacked: value }),
          })
          : null,
        draft.type === 'bar' || draft.type === 'line' || draft.type === 'area'
          ? e(SwitchRow, {
            label: t('chart.showValues'),
            checked: draft.showValues,
            onChange: value => setDraft({ ...draft, showValues: value }),
          })
          : null)

      const configPanel = e('section', { className: 'da-panel' },
        e('div', { className: 'da-panel-head' },
          e('h2', { className: 'da-panel-title' }, t('config.title')),
          e('button', {
            type: 'button',
            className: 'da-link-button',
            disabled: meta === null,
            onClick: () => changeType(draft.type),
          }, t('config.reset'))),
        meta === null
          ? e('p', { className: 'da-note' }, t('config.noDataset'))
          : e('div', { className: 'da-config-body' }, encodingBlock, styleBlock,
            e('p', { className: 'da-config-tip' }, t('config.pickField'))))

      const fieldPanel = meta === null
        ? null
        : e('section', { className: 'da-panel da-panel-fields' },
          e('div', { className: 'da-panel-head' },
            e('h2', { className: 'da-panel-title' }, t('section.fields')),
            e('span', { className: 'da-rail-count' }, String(schema.length))),
          e('div', { className: 'da-search da-search-sm' },
            e(Glyph, { name: 'search', size: 13 }),
            e('input', {
              className: 'da-search-input',
              type: 'search',
              value: query,
              placeholder: t('field.search'),
              'aria-label': t('field.search'),
              onChange: event => setQuery(event.target.value),
            })),
          e('div', { className: 'da-field-list' }, fields.map(entry => e('button', {
            key: entry.name,
            type: 'button',
            className: 'da-field-row',
            title: entry.name,
            onClick: () => {
              if (isNumericType(entry.type)) setDraft(current => ({ ...current, measure: entry.name }))
              else setDraft(current => ({ ...current, dimension: entry.name }))
            },
          },
          e('span', { className: 'da-field-name' }, entry.name),
          e('span', { className: 'da-type', 'data-type': entry.type }, t('type.' + entry.type)),
          entry.nullRate === null || entry.nullRate === 0
            ? null
            : e('span', { className: 'da-field-null' }, percent(entry.nullRate))))))

      const rightRail = e('aside', { className: 'da-rail da-rail-right' }, configPanel, fieldPanel)

      // --- empty state -------------------------------------------------------

      const hasDatasets = (datasets || []).length > 0
      const emptyState = loadingList
        ? e('div', { className: 'da-empty-state' }, e('p', { className: 'da-empty' }, t('state.loading')))
        : hasDatasets
          ? e('div', { className: 'da-empty-state' },
            e('span', { className: 'da-empty-mark' }, e(Glyph, { name: 'field', size: 24 })),
            e('h2', { className: 'da-empty-title' }, t('empty.pick')),
            e('p', { className: 'da-empty-body' }, t('empty.pickBody', { count: (datasets || []).length })))
          : e('div', { className: 'da-empty-state' },
            e('span', { className: 'da-empty-mark' }, e(Glyph, { name: 'chart', size: 26 })),
            e('h2', { className: 'da-empty-title' }, t('empty.title')),
            e('p', { className: 'da-empty-body' }, t(scope?.detached === true ? 'empty.bodyDetached' : 'empty.body')),
            e('div', { className: 'da-empty-actions' },
              e('button', { type: 'button', className: 'da-button da-button-primary', disabled: busy, onClick: () => openDialog('file') },
                e(Glyph, { name: 'plus' }), t('action.import')),
              e('button', { type: 'button', className: 'da-button', disabled: busy, onClick: openDatabaseEntry },
                e(Glyph, { name: 'database' }), t('action.database')),
              e('button', { type: 'button', className: 'da-button', disabled: busy, onClick: () => openDialog('api') },
                e(Glyph, { name: 'api' }), t('action.api'))),
            e('p', { className: 'da-empty-hint' }, t('empty.aiHint')))

      const canvasNodes = meta === null
        ? [compactPicker, emptyState]
        : (compact
          ? [compactPicker, canvasHead, stats, chartCard, configPanel, fieldPanel, dataCard]
          : [canvasHead, stats, chartCard, dataCard])

      const canvas = e('div', { className: 'da-canvas' }, canvasNodes)

      // --- dialogs -----------------------------------------------------------

      /**
       * Wrap dialog content in the shared shell.
       * @param title - Dialog heading.
       * @param content - Body nodes.
       * @param actions - Footer buttons.
       * @returns The backdrop element.
       */
      const dialogShell = (title, content, actions) => e('div', {
        className: 'da-dialog-backdrop',
        onClick: () => { setDialog(null); setTables(null) },
      }, e('div', {
        className: 'da-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        onClick: event => event.stopPropagation(),
      },
      e('div', { className: 'da-dialog-head' },
        e('h4', { className: 'da-dialog-title' }, title),
        e('button', {
          type: 'button',
          className: 'da-dialog-x',
          'aria-label': t('action.close'),
          onClick: () => { setDialog(null); setTables(null) },
        }, e(Glyph, { name: 'close', size: 14 }))),
      e('div', { className: 'da-dialog-body' }, content),
      dialogError ? e('p', { className: 'da-error' }, dialogError) : null,
      dialogNote ? e('p', { className: noteOk ? 'da-note da-note-ok' : 'da-note' }, dialogNote) : null,
      e('div', { className: 'da-dialog-actions' }, actions)))

      /** Worksheets currently ticked, used for the footer label and the guard. */
      const pickedCount = sheets === null ? 0 : sheets.filter(sheet => pickedSheets[sheet.name] === true).length

      /** Copy every non-empty worksheet into the tick map. */
      const pickAllSheets = () => {
        setPickedSheets(Object.fromEntries((sheets || []).filter(sheet => sheet.empty !== true).map(sheet => [sheet.name, true])))
      }

      /** Tick which worksheets each dataset is built from. */
      const sheetPicker = sheets === null || sheets.length === 0
        ? null
        : e(SheetPicker, {
          sheets,
          picked: pickedSheets,
          busy,
          t,
          onPick: (name, ticked) => setPickedSheets(current => ({ ...current, [name]: ticked })),
          onPickAll: pickAllSheets,
          onPickNone: () => setPickedSheets({}),
        })

      const fileDialog = dialogShell(t('dialog.file.title'), [
        e('p', { key: 'hint', className: 'da-note' }, t('dialog.file.hint')),
        e('label', { key: 'pick', className: 'da-dropzone' },
          e(Glyph, { name: 'plus', size: 18 }),
          e('span', { className: 'da-dropzone-title' }, t('action.upload')),
          e('span', { className: 'da-dropzone-hint' }, '.csv / .tsv / .xlsx / .xlsm'),
          e('input', {
            type: 'file',
            className: 'da-filepick-input',
            accept: '.csv,.tsv,.txt,.xlsx,.xlsm',
            onChange: event => {
              const picked = event.target.files && event.target.files[0]
              void submitUpload(picked)
              event.target.value = ''
            },
          })),
        e('div', { key: 'path', className: 'da-field-row-inline' },
          e('label', { className: 'da-field' },
            e('span', { className: 'da-field-label' }, t('dialog.file.path')),
            e('input', {
              className: 'da-input',
              value: filePath,
              placeholder: 'data/sales.xlsx',
              onChange: event => {
                setFilePath(event.target.value)
                // The worksheet list belongs to the previous path.
                if (sheets !== null) {
                  setSheets(null)
                  setPickedSheets({})
                  setStaged(null)
                }
              },
            })),
          e('button', {
            type: 'button',
            className: 'da-button da-inline-action',
            disabled: busy || filePath.trim() === '',
            onClick: () => { void loadSheets() },
          }, t('dialog.file.loadSheets'))),
        e('label', { key: 'name', className: 'da-field' },
          e('span', { className: 'da-field-label' }, t('dialog.file.name')),
          e('input', { className: 'da-input', value: fileName, onChange: event => setFileName(event.target.value) })),
        sheetPicker,
      ], [
        e('button', { key: 'cancel', type: 'button', className: 'da-button', onClick: () => setDialog(null) }, t('action.cancel')),
        e('button', {
          key: 'go',
          type: 'button',
          className: 'da-button da-button-primary',
          disabled: busy
            || (sheets !== null && sheets.length > 0 ? pickedCount === 0 : filePath.trim() === '' && staged === null),
          onClick: () => { void submitImport() },
        }, sheets !== null && sheets.length > 0
          ? t('action.importSheets', { count: pickedCount })
          : t('action.import')),
      ])

      const dbDialog = dialogShell(t('dialog.db.title'), [
        // Saved connections first: the common case is reading a database that
        // was configured once, not retyping its credentials.
        connections.length === 0
          ? null
          : e('div', { key: 'saved', className: 'da-saved-conns' },
            e('span', { className: 'da-field-label' }, t('dialog.db.savedList')),
            e('div', { className: 'da-chip-row' }, connections.map(item => e('button', {
              key: item.id,
              type: 'button',
              className: 'da-chip da-chip-button',
              'data-active': item.id === connForm.id ? 'true' : 'false',
              disabled: busy,
              onClick: () => { openDatabase(item) },
            }, item.label || item.database || item.host || item.id)))),
        e('div', { key: 'drivers', className: 'da-drivers', role: 'tablist' },
          CONNECTION_DRIVERS.map(driver => e('button', {
            key: driver.kind,
            type: 'button',
            role: 'tab',
            className: 'da-driver',
            'data-active': connForm.kind === driver.kind ? 'true' : 'false',
            'aria-selected': connForm.kind === driver.kind ? 'true' : 'false',
            disabled: busy,
            onClick: () => {
              if (connForm.kind === driver.kind) return
              setTables(null)
              setRevealPassword(false)
              // Driver-specific fields reset; the label survives so renaming
              // the connection while switching engines is not lost.
              setConnForm(current => ({ ...blankConnection(driver.kind), id: current.id, label: current.label }))
            },
          }, driver.kind === 'postgres' ? 'PostgreSQL' : (driver.kind === 'mysql' ? 'MySQL' : 'SQLite')))),
        e('label', { key: 'label', className: 'da-field' },
          e('span', { className: 'da-field-label' }, t('dialog.db.label')),
          e('input', {
            className: 'da-input',
            value: connForm.label,
            placeholder: t('dialog.db.namePlaceholder'),
            onChange: event => setConnForm({ ...connForm, label: event.target.value }),
          })),
        connForm.kind === 'sqlite'
          ? e('label', { key: 'path', className: 'da-field' },
            e('span', { className: 'da-field-label' }, t('dialog.db.path')),
            e('input', {
              className: 'da-input',
              value: connForm.path,
              placeholder: 'data/app.db',
              onChange: event => setConnForm({ ...connForm, path: event.target.value }),
            }))
          : e('div', { key: 'network', className: 'da-field-grid' },
            e('label', { className: 'da-field da-span3' },
              e('span', { className: 'da-field-label' }, t('dialog.db.host')),
              e('input', {
                className: 'da-input',
                value: connForm.host,
                placeholder: '10.0.0.9 / db.internal',
                autoComplete: 'off',
                spellCheck: false,
                onChange: event => setConnForm({ ...connForm, host: event.target.value }),
              })),
            e('label', { className: 'da-field' },
              e('span', { className: 'da-field-label' }, t('dialog.db.port')),
              e('input', {
                className: 'da-input',
                type: 'number',
                min: 1,
                max: 65535,
                value: connForm.port,
                onChange: event => setConnForm({ ...connForm, port: event.target.value }),
              })),
            e('label', { className: 'da-field da-span2' },
              e('span', { className: 'da-field-label' }, t('dialog.db.user')),
              e('input', {
                className: 'da-input',
                value: connForm.user,
                autoComplete: 'off',
                spellCheck: false,
                onChange: event => setConnForm({ ...connForm, user: event.target.value }),
              })),
            e('label', { className: 'da-field da-span2' },
              e('span', { className: 'da-field-label' }, t('dialog.db.password')),
              e('div', { className: 'da-secret' },
                e('input', {
                  className: 'da-input',
                  type: revealPassword ? 'text' : 'password',
                  value: connForm.password,
                  placeholder: connForm.hasPassword ? t('dialog.db.keepSecret') : '',
                  autoComplete: 'new-password',
                  onChange: event => setConnForm({ ...connForm, password: event.target.value }),
                }),
                e('button', {
                  type: 'button',
                  className: 'da-secret-toggle',
                  'aria-label': revealPassword ? t('dialog.db.hidePassword') : t('dialog.db.showPassword'),
                  title: revealPassword ? t('dialog.db.hidePassword') : t('dialog.db.showPassword'),
                  onClick: () => setRevealPassword(value => !value),
                }, revealPassword ? t('dialog.db.hide') : t('dialog.db.show')))),
            e('label', { className: 'da-field da-span2' },
              e('span', { className: 'da-field-label' }, t('dialog.db.database')),
              e('input', {
                className: 'da-input',
                value: connForm.database,
                placeholder: 'shop',
                onChange: event => setConnForm({ ...connForm, database: event.target.value }),
              })),
            e('label', { className: 'da-field da-span2' },
              e('span', { className: 'da-field-label' }, t('dialog.db.ssl')),
              e('select', {
                className: 'da-select',
                value: connForm.ssl,
                onChange: event => setConnForm({ ...connForm, ssl: event.target.value }),
              },
              e('option', { value: 'disable' }, t('dialog.db.sslOff')),
              e('option', { value: 'require' }, t('dialog.db.sslOn'))))),
        connForm.kind === 'sqlite'
          ? e('p', { key: 'pathHint', className: 'da-hint' }, t('dialog.db.pathHint'))
          : e('p', { key: 'secretHint', className: 'da-hint' }, t('dialog.db.secretHint')),
        connForm.kind === 'sqlite'
          ? null
          : e('details', { key: 'advanced', className: 'da-advanced' },
            e('summary', { className: 'da-advanced-summary' }, t('dialog.db.advanced')),
            e('label', { className: 'da-field' },
              e('span', { className: 'da-field-label' }, t('dialog.db.url')),
              e('input', {
                className: 'da-input',
                value: connForm.url,
                placeholder: connForm.maskedUrl !== ''
                  ? connForm.maskedUrl
                  : (connForm.kind === 'mysql' ? 'mysql://user:password@host:3306/db' : 'postgres://user:password@host:5432/db'),
                onChange: event => setConnForm({ ...connForm, url: event.target.value }),
              })),
            e('p', { className: 'da-hint' }, t('dialog.db.urlHint')),
            e('label', { className: 'da-field' },
              e('span', { className: 'da-field-label' }, t('dialog.db.urlEnv')),
              e('input', {
                className: 'da-input',
                value: connForm.urlEnv,
                placeholder: 'DATABASE_URL',
                onChange: event => setConnForm({ ...connForm, urlEnv: event.target.value }),
              })),
            e('p', { className: 'da-hint' }, t('dialog.db.envHint'))),
        tables === null
          ? null
          : e('div', { key: 'tables', className: 'da-tables' },
            e('div', { className: 'da-tables-head' },
              e('span', { className: 'da-field-label' }, t('dialog.db.tables')),
              e('span', { className: 'da-rail-count' }, String(tables.length))),
            tables.length === 0
              ? e('p', { className: 'da-note' }, t('dialog.db.empty'))
              : e('div', { className: 'da-pick-list' }, tables.map((item, index) => {
                const name = item.name || String(item)
                return e('button', {
                  key: name || index,
                  type: 'button',
                  className: 'da-pick-row da-pick-row-button',
                  'data-active': tablePick === name ? 'true' : 'false',
                  disabled: busy,
                  onClick: () => { void pickTable(name) },
                },
                e('span', { className: 'da-pick-name' }, name),
                item.type === undefined ? null : e('span', { className: 'da-pick-tag' }, String(item.type)))
              })),
            tables.length === 0 ? null : e('p', { className: 'da-hint' }, t('dialog.db.pickTable')),
            tablePick === null
              ? null
              : e('div', { key: 'picked', className: 'da-table-picked' },
                e('div', { className: 'da-tables-head' },
                  e('span', { className: 'da-field-label' }, tableColumns === null
                    ? t('dialog.db.columnsEmpty')
                    : t('dialog.db.columns', { count: tableColumns.length })),
                  e('span', { className: 'da-pick-name' }, tablePick)),
                tableColumns === null || tableColumns.length === 0
                  ? null
                  : e('div', { className: 'da-chip-row' }, tableColumns.map(column => e('span', {
                    key: column.name,
                    className: 'da-chip',
                    title: String(column.type ?? ''),
                  }, column.name))),
                e('label', { className: 'da-field' },
                  e('span', { className: 'da-field-label' }, t('dialog.db.tableName')),
                  e('input', {
                    className: 'da-input',
                    value: tableName,
                    placeholder: tablePick,
                    onChange: event => setTableName(event.target.value),
                  })))),
      ], [
        e('button', { key: 'close', type: 'button', className: 'da-button', onClick: () => setDialog(null) }, t('action.close')),
        e('button', {
          key: 'test',
          type: 'button',
          className: 'da-button',
          disabled: busy,
          onClick: () => { void probeConnection() },
        }, busy ? t('dialog.db.testing') : t('action.test')),
        e('button', {
          key: 'save',
          type: 'button',
          className: 'da-button',
          disabled: busy,
          onClick: () => { void submitConnection() },
        }, connForm.id === '' ? t('dialog.db.saveAndList') : t('action.save')),
        // The import is the dialog's purpose, so it owns the primary slot once a
        // table is picked; saving the connection stays available beside it.
        tablePick === null
          ? null
          : e('button', {
            key: 'import',
            type: 'button',
            className: 'da-button da-button-primary',
            disabled: busy,
            onClick: () => { void importTable() },
          }, t('dialog.db.importAs')),
      ])

      const apiDialog = dialogShell(t('dialog.api.title'), [
        e('div', { key: 'row', className: 'da-field-row-inline' },
          e('label', { className: 'da-field' },
            e('span', { className: 'da-field-label' }, t('dialog.api.name')),
            e('input', { className: 'da-input', value: apiForm.name, onChange: event => setApiForm({ ...apiForm, name: event.target.value }) })),
          e('label', { className: 'da-field' },
            e('span', { className: 'da-field-label' }, t('dialog.api.allowed')),
            e('input', { className: 'da-input', value: apiForm.allowed, onChange: event => setApiForm({ ...apiForm, allowed: event.target.value }) }))),
        e('label', { key: 'base', className: 'da-field' },
          e('span', { className: 'da-field-label' }, t('dialog.api.baseUrl')),
          e('input', {
            className: 'da-input',
            value: apiForm.baseUrl,
            placeholder: 'https://api.example.com',
            onChange: event => setApiForm({ ...apiForm, baseUrl: event.target.value }),
          })),
        e('div', { key: 'row2', className: 'da-field-row-inline' },
          e('label', { className: 'da-field' },
            e('span', { className: 'da-field-label' }, t('dialog.api.path')),
            e('input', { className: 'da-input', value: apiForm.path, onChange: event => setApiForm({ ...apiForm, path: event.target.value }) })),
          e('label', { className: 'da-field' },
            e('span', { className: 'da-field-label' }, t('dialog.api.recordsPath')),
            e('input', { className: 'da-input', value: apiForm.recordsPath, onChange: event => setApiForm({ ...apiForm, recordsPath: event.target.value }) }))),
        tables === null || tables.sample === undefined
          ? null
          : e('div', { key: 'sample', className: 'da-field' },
            e('span', { className: 'da-field-label' }, t('action.preview')),
            e('pre', { className: 'da-pre' }, JSON.stringify(tables.sample.slice(0, 3), null, 2))),
      ], [
        e('button', { key: 'close', type: 'button', className: 'da-button', onClick: () => setDialog(null) }, t('action.close')),
        e('button', { key: 'save', type: 'button', className: 'da-button', onClick: () => { void submitSource() } }, t('action.save')),
        e('button', { key: 'preview', type: 'button', className: 'da-button', disabled: busy, onClick: () => { void previewSource() } }, t('action.preview')),
        e('button', {
          key: 'import',
          type: 'button',
          className: 'da-button da-button-primary',
          disabled: busy,
          onClick: () => { void importApi() },
        }, t('action.import')),
      ])

      const dialogNode = dialog === 'file'
        ? fileDialog
        : dialog === 'db'
          ? dbDialog
          : dialog === 'api'
            ? apiDialog
            : null

      // --- AI drawer ---------------------------------------------------------

      // The hand-off is a review step, not a blind jump: the drawer shows the
      // dataset, the angles going into the prompt, and the prompt itself before
      // anything is written into the composer.
      const aiDrawer = aiOpen
        ? e('div', { className: 'da-drawer-backdrop', onClick: closeAiDrawer },
          e('aside', {
            className: 'da-drawer',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('ai.title'),
            onClick: event => event.stopPropagation(),
          },
          e('header', { className: 'da-drawer-head' },
            e('span', { className: 'da-drawer-mark' }, e(Glyph, { name: 'ai', size: 15 })),
            e('div', { className: 'da-drawer-heading' },
              e('h3', { className: 'da-drawer-title' }, t('ai.title')),
              e('p', { className: 'da-drawer-sub' }, t('ai.subtitle'))),
            e('button', {
              type: 'button',
              className: 'da-dialog-x',
              'aria-label': t('action.close'),
              onClick: closeAiDrawer,
            }, e(Glyph, { name: 'close', size: 14 }))),
          e('div', { className: 'da-drawer-body' },
            e('section', { className: 'da-drawer-section' },
              e('div', { className: 'da-drawer-section-head' },
                e('h4', { className: 'da-drawer-label' }, t('ai.dataset')),
                e('span', { className: 'da-drawer-hint' }, t('ai.datasetHint', {
                  picked: aiIds.length,
                  total: (datasets || []).length,
                }))),
              e('div', { className: 'da-picks' }, (datasets || []).map(item => {
                const on = aiIds.includes(item.id)
                const doc = aiDocs[item.id]
                const detail = doc !== undefined && doc.status === 'ready'
                  ? shapeOf(doc.meta) + ' · ' + t('ai.fieldCount', { count: Array.isArray(doc.meta.schema) ? doc.meta.schema.length : 0 })
                  : doc !== undefined && doc.status === 'error'
                    ? t('ai.loadFailed')
                    : datasetHint(item)
                return e('label', {
                  key: item.id,
                  className: 'da-pick',
                  'data-on': on ? 'true' : 'false',
                },
                e('input', {
                  type: 'checkbox',
                  className: 'da-sheet-check',
                  checked: on,
                  onChange: () => toggleAiDataset(item.id),
                }),
                e('span', { className: 'da-pick-text' },
                  e('span', { className: 'da-pick-name', title: item.name || item.id }, item.name || item.id),
                  e('span', { className: 'da-pick-meta' }, detail)),
                on ? e('span', { className: 'da-drawer-badge' }, t('ai.ready')) : null)
              })),
              aiIds.length === 0 ? e('p', { className: 'da-focus-note' }, t('ai.datasetNone')) : null,
              aiIds.length > 1 ? e('p', { className: 'da-hint' }, t('ai.datasetMultiHint')) : null),
            e('section', { className: 'da-drawer-section' },
              e('div', { className: 'da-drawer-section-head' },
                e('h4', { className: 'da-drawer-label' }, t('ai.focus')),
                e('span', { className: 'da-drawer-hint' }, t('ai.focusHint'))),
              e('div', { className: 'da-focus-grid' }, AI_FOCUS.map(item => {
                const on = aiFocus.includes(item.key)
                return e('button', {
                  key: item.key,
                  type: 'button',
                  className: 'da-focus',
                  'data-on': on ? 'true' : 'false',
                  'aria-pressed': on ? 'true' : 'false',
                  onClick: () => toggleFocus(item.key),
                },
                e('span', { className: 'da-focus-title' }, t('ai.focus.' + item.key)),
                e('span', { className: 'da-focus-hint' }, t('ai.focus.' + item.key + '.hint')),
                e('span', { className: 'da-focus-check' }, '✓'))
              })),
              aiFocus.length === 0 ? e('p', { className: 'da-focus-note' }, t('ai.focusNone')) : null),
            e('section', { className: 'da-drawer-section' },
              e('label', { className: 'da-drawer-label', htmlFor: 'da-ai-note' }, t('ai.note')),
              e('textarea', {
                id: 'da-ai-note',
                className: 'da-textarea',
                rows: 3,
                value: aiNote,
                placeholder: t('ai.notePlaceholder'),
                onChange: event => setAiNote(event.target.value),
              })),
            e('section', { className: 'da-drawer-section' },
              e('button', {
                type: 'button',
                className: 'da-drawer-toggle',
                'aria-expanded': aiBriefShown ? 'true' : 'false',
                onClick: () => setAiBriefShown(value => !value),
              },
              e('span', null, t('ai.brief')),
              e('span', { className: 'da-drawer-toggle-state' }, aiBriefShown ? t('ai.briefHide') : t('ai.briefShow'))),
              aiBriefShown ? e('pre', { className: 'da-pre da-pre-brief' }, analysisBrief()) : null)),
          e('footer', { className: 'da-drawer-foot' },
            e('p', { className: 'da-drawer-foot-note' },
              aiIds.length > 1 ? t('ai.footNoteMulti', { count: aiIds.length }) : t('ai.footNote')),
            e('div', { className: 'da-drawer-actions' },
              e('button', { type: 'button', className: 'da-button', onClick: closeAiDrawer }, t('ai.cancel')),
              e('button', {
                type: 'button',
                className: 'da-button da-button-primary',
                disabled: aiFocus.length === 0 || aiIds.length === 0,
                onClick: handOffBrief,
              }, e(Glyph, { name: 'ai' }), aiIds.length > 1
                ? t('ai.sendMulti', { count: aiIds.length })
                : t('ai.send'))))))
        : null

      return e('div', { className: 'da-app', 'data-compact': compact ? 'true' : 'false' },
        appbar,
        e('div', { className: 'da-main' }, compact ? null : leftRail, canvas, compact ? null : rightRail),
        dialogNode,
        aiDrawer)
    }

    /**
     * Right-sidebar seat: the same workbench stacked into one narrow column.
     * @param props - Standard slot props for the tab body.
     * @returns The compact workbench element.
     */
    function AnalysisPane(props) {
      // The right-sidebar tab can be opened with no Session in view (the start
      // screen, or a Workspace with no conversation yet). Say so instead of
      // mounting a workbench whose every request would be refused.
      if (props.sessionMissing === true) return e('p', { className: 'da-empty' }, props.t('page.noSession'))
      return e(AnalysisPanel, { ...props, compact: true })
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
        () => (sessionId === undefined ? null : createFace(ctx, sessionId, t)),
        [ctx, sessionId, t])
      const useTabInfo = React.useCallback(() => ({ tab: { signal: controller.signal } }), [controller])
      const back = () => { ctx.layout.selectPanel('conversation') }
      return e('div', { className: 'da-page' },
        sessionId === undefined || face === null
          ? e('div', { className: 'da-app' },
            e('header', { className: 'da-appbar' },
              e('button', {
                type: 'button',
                className: 'da-icon-button',
                title: t('page.back'),
                'aria-label': t('page.back'),
                onClick: back,
              }, e(Glyph, { name: 'back' })),
              e('div', { className: 'da-brand' },
                e('span', { className: 'da-brand-mark' }, e(Glyph, { name: 'chart' })),
                e('span', { className: 'da-brand-text' },
                  e('span', { className: 'da-brand-title' }, t('tab.title'))))),
            e('p', { className: 'da-empty' }, t('page.noSession')))
          : e(AnalysisPanel, { ...props, ...face, useTabInfo, onBack: back }))
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
        inject: sessionId => createFace(ctx, sessionId, t),
      }, AnalysisPane)), 'dsh-data-analysis: tab body')

      // The "Analyze with AI" hand-off lives on the workbench page, but the
      // composer's draft actions only reach the dock column. An empty dock seat
      // keeps a reference to them so the page can write the brief itself.
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'data-analysis-ai-bridge',
        order: 90,
        locale: NS,
      }, AiDockBridge)), 'dsh-data-analysis: ai bridge')

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
        SheetPicker,
        composeBrief,
      }
    }
    return plugin
  },
})
