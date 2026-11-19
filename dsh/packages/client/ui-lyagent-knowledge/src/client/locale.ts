/** Native knowledge panel dictionaries. */
export const NS = 'lyagent.knowledge'
/** English fallback copy. */
export const en = {
  title: 'Knowledge', grantedVersion: ' · authorized v{version}', refresh: 'Refresh', collection: 'Collection ID', name: 'Collection name', files: 'Text files',
  edition: 'Import new version', newCollection: 'New collection',
  editionName: 'New version of collection',
  import: 'Import files', grant: 'Use in this conversation', revoke: 'Revoke all access', archive: 'Archive',
  version: 'Version', archived: 'Archived', granted: 'Authorized', empty: 'No collections', load: 'Load collections',
  next: 'Next page', back: 'First page', busy: 'Processing', failed: 'Operation failed. Refresh and review the current state before trying again.',
  unavailable: 'Knowledge service unavailable', invalid: 'Enter a collection ID, a name and select text files.',
  changed: 'Saved',
}
/** Simplified Chinese copy. */
export const zh = {
  title: '知识库', grantedVersion: ' · 已授权 v{version}', refresh: '刷新', collection: '集合标识', name: '集合名称', files: '文本文件',
  edition: '导入新版本', newCollection: '新建集合',
  editionName: '导入新版本到',
  import: '导入文件', grant: '用于当前对话', revoke: '撤销全部授权', archive: '归档',
  version: '版本', archived: '已归档', granted: '已授权', empty: '暂无知识集合', load: '加载集合',
  next: '下一页', back: '首页', busy: '处理中', failed: '操作失败，请刷新并核对当前状态后再尝试',
  unavailable: '知识服务不可用', invalid: '请填写集合标识、名称并选择文本文件', changed: '已保存',
} satisfies Record<keyof typeof en, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Knowledge import and grant controls. */
    'lyagent.knowledge': keyof typeof en
  }
}
