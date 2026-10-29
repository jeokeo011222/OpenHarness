/**
 * Locale dictionaries for the ontology workbench.
 *
 * All product copy lives here; components receive `t` from the locale service.
 */

/** Every user-visible string the workbench renders. */
export interface LocaleDict {
  readonly title: string
  readonly subtitle: string
  readonly domains: string
  readonly noDomains: string
  readonly newDomain: string
  readonly domainId: string
  readonly domainLabel: string
  readonly create: string
  readonly creating: string
  readonly cancel: string
  readonly activeVersion: string
  readonly versionPrefix: string
  readonly versionCount: string
  readonly nodeCount: string
  readonly edgeCount: string
  readonly sourceCount: string
  readonly upload: string
  readonly uploadHint: string
  readonly chooseFile: string
  readonly generate: string
  readonly generating: string
  readonly generateHint: string
  readonly steps: string
  readonly warnings: string
  readonly graph: string
  readonly graphEmpty: string
  readonly graphHint: string
  readonly inspector: string
  readonly inspectorEmpty: string
  readonly nodeKind: string
  readonly nodeId: string
  readonly nodeLabel: string
  readonly nodeComment: string
  readonly nodeDomain: string
  readonly nodeRange: string
  readonly nodeParents: string
  readonly nodeSource: string
  readonly save: string
  readonly saving: string
  readonly remove: string
  readonly addClass: string
  readonly addProperty: string
  readonly propertyKind: string
  readonly objectProperty: string
  readonly datatypeProperty: string
  readonly classKind: string
  readonly subclass: string
  readonly versions: string
  readonly noVersions: string
  readonly activate: string
  readonly activateBusy: string
  readonly active: string
  readonly compare: string
  readonly compareHint: string
  readonly addedNodes: string
  readonly removedNodes: string
  readonly addedEdges: string
  readonly removedEdges: string
  readonly noDiff: string
  readonly reload: string
  readonly errorPrefix: string
  readonly dismiss: string
  readonly selectDomain: string
}

/** Chinese copy. */
export const zh: LocaleDict = {
  title: '本体中心',
  subtitle: '上传制度文档一键生成本体，查看并微调知识图谱，按版本管理多个本体。',
  domains: '本体域',
  noDomains: '还没有本体域，先新建一个再上传文档。',
  newDomain: '新建本体域',
  domainId: '域标识（小写英文，如 contract）',
  domainLabel: '显示名称（如 合同管理）',
  create: '创建',
  creating: '创建中…',
  cancel: '取消',
  activeVersion: '当前版本',
  versionPrefix: 'v',
  versionCount: '个版本',
  nodeCount: '个节点',
  edgeCount: '条关系',
  sourceCount: '份源文档',
  upload: '上传文档',
  uploadHint: '支持 DOCX、PDF、Markdown、纯文本，单个文件不超过 20 MB。',
  chooseFile: '选择文件',
  generate: '一键生成本体',
  generating: '正在生成…',
  generateHint: '生成过程会按条款切分文档，逐段抽取类与属性，并写入新版本。',
  steps: '生成过程',
  warnings: '提示',
  graph: '知识图谱',
  graphEmpty: '该本体还没有节点，上传文档生成或手动添加。',
  graphHint: '拖动节点调整布局，点击节点或关系进行微调。',
  inspector: '属性面板',
  inspectorEmpty: '在左侧图谱中选择一个节点或关系。',
  nodeKind: '类型',
  nodeId: '标识',
  nodeLabel: '名称',
  nodeComment: '说明',
  nodeDomain: '定义域（所属类）',
  nodeRange: '值域（目标类或 xsd 类型）',
  nodeParents: '父类（逗号分隔）',
  nodeSource: '来源条款',
  save: '保存',
  saving: '保存中…',
  remove: '删除',
  addClass: '新增类',
  addProperty: '新增属性',
  propertyKind: '属性类型',
  objectProperty: '对象属性',
  datatypeProperty: '数据属性',
  classKind: '类',
  subclass: '子类关系',
  versions: '版本',
  noVersions: '还没有版本快照。',
  activate: '激活',
  activateBusy: '切换中…',
  active: '当前',
  compare: '比较版本',
  compareHint: '选择两个版本查看差异。',
  addedNodes: '新增节点',
  removedNodes: '删除节点',
  addedEdges: '新增关系',
  removedEdges: '删除关系',
  noDiff: '两个版本没有差异。',
  reload: '刷新',
  errorPrefix: '操作失败：',
  dismiss: '知道了',
  selectDomain: '选择一个本体域',
}

/** English copy. */
export const en: LocaleDict = {
  title: 'Ontology center',
  subtitle: 'Upload a policy document to generate an ontology in one click, inspect and edit its graph, and manage versions of many domains.',
  domains: 'Domains',
  noDomains: 'No domains yet — create one, then upload a document.',
  newDomain: 'New domain',
  domainId: 'Domain id (lowercase, e.g. contract)',
  domainLabel: 'Display name (e.g. Contract management)',
  create: 'Create',
  creating: 'Creating…',
  cancel: 'Cancel',
  activeVersion: 'Active version',
  versionPrefix: 'v',
  versionCount: 'versions',
  nodeCount: 'nodes',
  edgeCount: 'relations',
  sourceCount: 'sources',
  upload: 'Upload document',
  uploadHint: 'DOCX, PDF, Markdown, or plain text; one file up to 20 MB.',
  chooseFile: 'Choose file',
  generate: 'Generate ontology',
  generating: 'Generating…',
  generateHint: 'The run splits the document by clause, extracts classes and properties per clause, and writes a new version.',
  steps: 'Generation log',
  warnings: 'Notices',
  graph: 'Knowledge graph',
  graphEmpty: 'This ontology has no nodes yet — generate from a document or add nodes manually.',
  graphHint: 'Drag nodes to arrange them; click a node or relation to edit it.',
  inspector: 'Properties',
  inspectorEmpty: 'Select a node or relation in the graph.',
  nodeKind: 'Kind',
  nodeId: 'Identifier',
  nodeLabel: 'Label',
  nodeComment: 'Comment',
  nodeDomain: 'Domain (owning class)',
  nodeRange: 'Range (target class or xsd type)',
  nodeParents: 'Parent classes (comma separated)',
  nodeSource: 'Source clause',
  save: 'Save',
  saving: 'Saving…',
  remove: 'Delete',
  addClass: 'New class',
  addProperty: 'New property',
  propertyKind: 'Property kind',
  objectProperty: 'Object property',
  datatypeProperty: 'Datatype property',
  classKind: 'Class',
  subclass: 'Subclass relation',
  versions: 'Versions',
  noVersions: 'No version snapshots yet.',
  activate: 'Activate',
  activateBusy: 'Switching…',
  active: 'Active',
  compare: 'Compare versions',
  compareHint: 'Pick two versions to see the difference.',
  addedNodes: 'Added nodes',
  removedNodes: 'Removed nodes',
  addedEdges: 'Added relations',
  removedEdges: 'Removed relations',
  noDiff: 'The two versions are identical.',
  reload: 'Refresh',
  errorPrefix: 'Request failed: ',
  dismiss: 'Dismiss',
  selectDomain: 'Select a domain',
}
