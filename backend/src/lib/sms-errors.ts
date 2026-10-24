/**
 * Classification of Android SmsManager sentIntent result codes and
 * delivery-report TP-Status values (3GPP TS 23.040 §9.2.3.15).
 *
 * TRANSIENT failures may be retried automatically with backoff.
 * PERMANENT failures are never retried automatically.
 * GATEWAY failures point at the phone (permission, SIM, OS limit), so the
 * gateway is paused rather than burning retries on every queued message.
 */
export type ErrorCategory =
  | 'INVALID_DESTINATION'
  | 'MISSING_PERMISSION'
  | 'SIM_UNAVAILABLE'
  | 'NETWORK_FAILURE'
  | 'SERVICE_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'SUBMISSION_FAILURE'
  | 'DELIVERY_FAILURE'
  | 'DELIVERY_UNKNOWN'
  | 'SUPPRESSED'
  | 'CANCELLED'
  | 'INTERNAL';

export type Retry = 'TRANSIENT' | 'PERMANENT' | 'GATEWAY';

export interface Classified {
  code: string;
  category: ErrorCategory;
  retry: Retry;
  description: string;
}

// Values of android.telephony.SmsManager.RESULT_* (API 30+ adds the 10..32 range).
const SENT_CODES: Record<number, [string, ErrorCategory, Retry, string]> = {
  1: ['GENERIC_FAILURE', 'SUBMISSION_FAILURE', 'TRANSIENT', 'Generic failure reported by the radio'],
  2: ['RADIO_OFF', 'SERVICE_UNAVAILABLE', 'GATEWAY', 'Radio is off (airplane mode?)'],
  3: ['NULL_PDU', 'INTERNAL', 'PERMANENT', 'Android could not build the SMS PDU'],
  4: ['NO_SERVICE', 'NETWORK_FAILURE', 'TRANSIENT', 'No mobile network service'],
  5: ['LIMIT_EXCEEDED', 'RATE_LIMITED', 'GATEWAY', "Android's outgoing SMS limit was reached"],
  6: ['FDN_CHECK_FAILURE', 'INVALID_DESTINATION', 'PERMANENT', 'Blocked by Fixed Dialling Numbers on the SIM'],
  7: ['SHORT_CODE_NOT_ALLOWED', 'INVALID_DESTINATION', 'PERMANENT', 'Short code not allowed'],
  8: ['SHORT_CODE_NEVER_ALLOWED', 'INVALID_DESTINATION', 'PERMANENT', 'Short code never allowed'],
  9: ['RADIO_NOT_AVAILABLE', 'SERVICE_UNAVAILABLE', 'TRANSIENT', 'Radio not available'],
  10: ['NETWORK_REJECT', 'SUBMISSION_FAILURE', 'PERMANENT', 'The network rejected the message'],
  11: ['INVALID_ARGUMENTS', 'INTERNAL', 'PERMANENT', 'Invalid arguments'],
  12: ['INVALID_STATE', 'SERVICE_UNAVAILABLE', 'TRANSIENT', 'Telephony in an invalid state'],
  13: ['NO_MEMORY', 'SERVICE_UNAVAILABLE', 'TRANSIENT', 'Phone out of memory'],
  14: ['INVALID_SMS_FORMAT', 'INTERNAL', 'PERMANENT', 'Invalid SMS format'],
  15: ['SYSTEM_ERROR', 'SERVICE_UNAVAILABLE', 'TRANSIENT', 'System error'],
  16: ['MODEM_ERROR', 'SERVICE_UNAVAILABLE', 'TRANSIENT', 'Modem error'],
  17: ['NETWORK_ERROR', 'NETWORK_FAILURE', 'TRANSIENT', 'Network error'],
  18: ['ENCODING_ERROR', 'INTERNAL', 'PERMANENT', 'Encoding error'],
  19: ['INVALID_SMSC_ADDRESS', 'SIM_UNAVAILABLE', 'GATEWAY', 'Invalid SMS centre address on the SIM'],
  20: ['OPERATION_NOT_ALLOWED', 'SUBMISSION_FAILURE', 'PERMANENT', 'Operation not allowed'],
  21: ['INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'TRANSIENT', 'Internal telephony error'],
  22: ['NO_RESOURCES', 'SERVICE_UNAVAILABLE', 'TRANSIENT', 'No resources'],
  23: ['CANCELLED', 'CANCELLED', 'TRANSIENT', 'Cancelled by the system'],
  24: ['REQUEST_NOT_SUPPORTED', 'SUBMISSION_FAILURE', 'PERMANENT', 'Request not supported'],
  28: ['UNEXPECTED_EVENT_STOP_SENDING', 'SERVICE_UNAVAILABLE', 'TRANSIENT', 'Unexpected event stopped sending'],
  29: ['SMS_BLOCKED_DURING_EMERGENCY', 'SERVICE_UNAVAILABLE', 'TRANSIENT', 'SMS blocked during an emergency call'],
  30: ['SMS_SEND_RETRY_FAILED', 'SUBMISSION_FAILURE', 'TRANSIENT', 'The radio retried and failed'],
  31: ['REMOTE_EXCEPTION', 'SERVICE_UNAVAILABLE', 'TRANSIENT', 'Telephony service crashed'],
  32: ['NO_DEFAULT_SMS_APP', 'SERVICE_UNAVAILABLE', 'GATEWAY', 'No default SMS app'],
};

/** Codes the app itself reports when no sentIntent result exists. */
const APP_CODES: Record<string, [ErrorCategory, Retry, string]> = {
  PERMISSION_DENIED: ['MISSING_PERMISSION', 'GATEWAY', 'SEND_SMS permission is not granted'],
  SIM_NOT_READY: ['SIM_UNAVAILABLE', 'GATEWAY', 'The selected SIM is missing or not ready'],
  SIM_CHANGED: ['SIM_UNAVAILABLE', 'GATEWAY', 'The selected SIM was removed or changed'],
  SEND_EXCEPTION: ['SUBMISSION_FAILURE', 'TRANSIENT', 'SmsManager threw an exception'],
  INVALID_NUMBER_LOCAL: ['INVALID_DESTINATION', 'PERMANENT', 'Phone rejected the destination number'],
  SENT_TIMEOUT: ['DELIVERY_UNKNOWN', 'PERMANENT', 'No sent result from Android within the timeout'],
  PROCESS_KILLED: ['DELIVERY_UNKNOWN', 'PERMANENT', 'The app stopped after handing the SMS to Android'],
};

export function classifySentResult(resultCode: number | null | undefined, appCode?: string | null): Classified {
  if (appCode && APP_CODES[appCode]) {
    const [category, retry, description] = APP_CODES[appCode];
    return { code: appCode, category, retry, description };
  }
  if (resultCode != null) {
    const known = SENT_CODES[resultCode];
    if (known) return { code: known[0], category: known[1], retry: known[2], description: known[3] };
    if (resultCode >= 100) {
      // RIL_* codes (radio interface layer), mostly modem/network trouble.
      return { code: `RIL_${resultCode}`, category: 'SERVICE_UNAVAILABLE', retry: 'TRANSIENT', description: `Radio interface error ${resultCode}` };
    }
  }
  return { code: `UNRECOGNISED_${resultCode ?? appCode ?? 'NONE'}`, category: 'SUBMISSION_FAILURE', retry: 'TRANSIENT', description: 'Unrecognised failure' };
}

export type DeliveryStatus = 'DELIVERED' | 'PENDING' | 'FAILED';

/** TP-Status: 0x00–0x1F completed, 0x20–0x3F still trying, 0x40+ permanent/abandoned. */
export function classifyTpStatus(tp: number): DeliveryStatus {
  if (tp < 0 || tp > 255) return 'FAILED';
  if (tp <= 0x1f) return 'DELIVERED';
  if (tp <= 0x3f) return 'PENDING';
  return 'FAILED';
}

/** Backoff for automatic retries: base * 2^(n-1), capped, with ±25% jitter. */
export function retryDelaySeconds(attempt: number, base: number, max: number, rand = Math.random): number {
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jitter = raw * 0.25 * (rand() * 2 - 1);
  return Math.max(1, Math.round(raw + jitter));
}
