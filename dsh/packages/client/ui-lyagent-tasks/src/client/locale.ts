/** Task panel copy owned by this plugin. */
export const NS = 'lyagent.tasks'
/** English task controls. */
export const en = {
  title: 'Tasks', objective: 'Task objective', register: 'Register task', refresh: 'Refresh', load: 'Load tasks',
  additional: 'Additional requirements', artifactPath: 'Required artifact path (relative to workspace)', requiredText: 'Required text',
  run: 'Run', cancel: 'Cancel', next: 'Next page', first: 'First page', empty: 'No registered tasks',
  criteria: 'Acceptance requirements', tests: 'Minimum tests', repairs: 'Correction limit',
  registered: 'Task registered, not started', settled: 'Execution ended; check the task status', cancelledAction: 'Cancellation recorded',
  failed: 'Operation failed. Refresh and review the current state before trying again.', unavailable: 'Task service unavailable',
  queued: 'Not started', running: 'Running', checking: 'Checking', needs_attention: 'Needs attention', cancelled: 'Cancelled', completed: 'Completed',
}
/** Simplified Chinese task controls. */
export const zh = {
  title: '任务', objective: '任务目标', register: '登记任务', refresh: '刷新', load: '加载任务',
  additional: '附加交付要求', artifactPath: '必需产物路径（相对于工作区）', requiredText: '必含内容',
  run: '运行', cancel: '取消', next: '下一页', first: '首页', empty: '暂无已登记任务',
  criteria: '验收要求', tests: '最少测试数', repairs: '修正次数上限',
  registered: '任务已登记，尚未运行', settled: '执行已结束，请核对任务状态', cancelledAction: '已记录取消',
  failed: '操作失败，请刷新并核对当前状态后再尝试', unavailable: '任务服务不可用',
  queued: '未开始', running: '运行中', checking: '检查中', needs_attention: '需处理', cancelled: '已取消', completed: '已完成',
} satisfies Record<keyof typeof en, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Explicit task management controls. */
    'lyagent.tasks': keyof typeof en
  }
}
