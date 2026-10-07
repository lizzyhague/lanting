/*
 * 点名顺序的规则。发言顺序就是勾选的先后，界面上不显示顺序。
 *
 * - 去掉一个，其余的顺序不变；重新勾上的排到最后。
 * - 点全选：已经勾了的保持原来的顺序，没勾的按界面顺序依次加到后面。
 * - 取消全选：全部清空。
 */

export function toggleMember(order, member, checked) {
  const rest = order.filter((agent) => agent !== member);
  return checked ? [...rest, member] : rest;
}

export function selectAll(order, members) {
  return [...order, ...members.filter((member) => !order.includes(member))];
}

export function clearAll() {
  return [];
}
