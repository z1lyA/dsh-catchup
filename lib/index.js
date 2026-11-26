/**
 * Host half — intentionally empty.
 *
 * Everything this plugin shows is already on the browser side:
 * a session's `session/control` baseline carries the full projection values
 * (turnOutline, todos, sessionStats, tokenUsage) for the attached session, and
 * `session/list` carries the summary block plus `userQuestions` for every listed
 * session. No Host service, no RPC, no model call.
 */
export function apply() {}
