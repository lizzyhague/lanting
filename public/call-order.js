/*
 * Call order rules. Speaking order is the order the buttons were pressed; the UI doesn't show the order.
 *
 * - Removing one keeps the others' order; a member called again goes to the end.
 */

export function toggleMember(order, member, checked) {
  const rest = order.filter((agent) => agent !== member);
  return checked ? [...rest, member] : rest;
}
