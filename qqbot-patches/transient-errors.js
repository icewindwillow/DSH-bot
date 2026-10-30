/* >>> dsh-qqbot-patch:transient-errors >>> */
/**
 * 瞬时限流/过载不往群里甩「本轮异常结束」——这类错误重试几次通常就好，
 * 甩给用户只会让他们以为机器人坏了。
 */
const TRANSIENT_TURN_ERROR_CODES = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'OVERLOADED']);
/* <<< dsh-qqbot-patch:transient-errors <<< */
