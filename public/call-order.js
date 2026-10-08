/*
 * 点名顺序的规则。发言顺序就是按钮按下的先后，界面上不显示顺序。
 *
 * - 去掉一个，其余的顺序不变；重新点名的排到最后。
 */

export function toggleMember(order, member, checked) {
  const rest = order.filter((agent) => agent !== member);
  return checked ? [...rest, member] : rest;
}
