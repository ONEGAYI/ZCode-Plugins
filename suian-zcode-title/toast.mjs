const FIX_PROMPT_TEMPLATE=`请帮我检查并修复 ZCode 自动命名插件的公共网关 RPC。先读取插件与公共层的 Skill 和 README，再运行公共 Status 与插件 status/probe/doctor，区分配置、运行版本、后台任务、Desktop、上游和工作区问题。旧网关缺少 RPC 时，先提醒我保存工作并完整退出 ZCode，再安全重载；不要自动退出宿主，不回退官方直连，不索取手机远控链接。配置中的本地令牌不得回显或写入日志。保持已选 GLM-5.3-Flash / low，核对 Stop Hook 是否安装、启用、受信任及实际触发。只处理命名插件与依赖网关的配置诊断，按当前授权验证结果。
插件目录：{{plugin_root}}
数据目录：{{data_dir}}`;

export function buildFixPrompt({pluginRoot,dataDir}) {
  return FIX_PROMPT_TEMPLATE
    .replace(/\{\{plugin_root\}\}/g,()=>pluginRoot)
    .replace(/\{\{data_dir\}\}/g,()=>dataDir);
}

export const reasonMessages={
  gateway_not_configured:"公共网关尚未配置",
  gateway_invalid_config:"公共网关配置无效",
  gateway_upgrade_required:"运行中的网关需要重载才能支持 RPC",
  gateway_unreachable:"公共网关健康接口不可达",
  gateway_desktop_offline:"Desktop 或官方上游未连接网关",
  gateway_connection_failed:"公共网关 RPC 连接失败",
  gateway_connection_closed:"公共网关连接中断，先检查操作结果",
  gateway_timeout:"原 Host 调用超时，先检查操作结果",
  gateway_bridge_timeout:"原 Host 桥初始化超时",
  gateway_rpc_protocol_error:"原 Host RPC 协议错误",
  gateway_rpc_failed:"公共网关 RPC 不可用",
  remote_workspace_busy:"手机当前使用远端工作区，本地命名暂让位",
  network_timeout:"远控网络超时",
  network_error:"远控连接中断",
  auth_failed:"远控授权被拒绝",
  device_offline:"原窗口远控未开启或已离线",
  kicked:"连接被新设备取代",
  pair_waiting:"远控配对未就绪",
  host_unreachable:"原 ZCode 窗口不可达",
  workspace_missing:"原窗口未打开目标工作区",
  session_missing:"原窗口没有目标会话",
  invalid_url:"远控链接格式无效",
  missing_authorization:"未提供远控授权链接",
  auth_link_rejected:"远控授权链接已失效",
  relay_rejected:"远控服务拒绝了连接"
};

export function toastBodyFor(reasonCode) {
  return `${reasonMessages[reasonCode]??"远控不可用"}（${reasonCode}），本轮跳过命名。点击按钮复制排障提示词并打开 ZCode（需确认打开工作区）。`;
}
